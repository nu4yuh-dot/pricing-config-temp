import { NextResponse } from 'next/server';
import { ContractRequestIntake } from '../../../../api/contracts';
import { authenticatedJson, authenticatedRequest, badRequest } from '../../_auth';
import { findCustomer } from '../../../../data/customers';
import {
  raiseContractRequest,
  contractRequestByReference,
} from '../../../../data/contract-requests';
import { recordAudit } from '../../../../data/audit';
import { resolveHubs, unknownHubMessage } from '../../../../customers/hub-zone';
import { knownZones } from '../../../../data/pincodes';
import { laneKey } from '../../../../domain/customers';
import type { Mode } from '../../../../domain/types';

/**
 * Contract requests from the enterprise customer portal.
 *
 * The portal is part of the core, and this service is not on the public internet, so a
 * customer's request reaches us the same way everything else does: the core calls, signed.
 *
 * What happens next is the part worth being clear about with the customer. Accepting a
 * request does not set a price and does not change what they are charged — it puts the ask
 * into their draft contract for our team to rate, and the existing contract approval is
 * what makes anything live. So the portal should say "received", never "granted", and
 * certainly never quote a number back.
 */
export async function POST(request: Request) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;

  const parsed = ContractRequestIntake.safeParse(auth.body);
  if (!parsed.success) return badRequest('Invalid contract request.', parsed.error.flatten());
  const input = parsed.data;

  const customer = await findCustomer(input.customer);
  if (!customer) {
    // 409 rather than 404: the request itself is well formed, but it names a customer we
    // do not price for, and inventing one would attach a negotiation to nobody.
    return NextResponse.json(
      { success: false, message: `Unknown customer ${input.customer}.` },
      { status: 409 },
    );
  }

  /**
   * Hub-to-hub routes become lanes we can actually price.
   *
   * A hub we cannot place is refused with its name, rather than mapped to something
   * plausible. A wrongly mapped hub prices a real consignment at another lane's rate and
   * nothing about the answer looks wrong — which is exactly the kind of mistake that is
   * only found on an invoice.
   */
  /**
   * The core names these `origHub`/`origCity`/`estimatedMonthlyVolume`; we shipped
   * `originHub`/`originCity`/`volumeKgPerMonth` first. Both are accepted, and everything
   * past this line uses the core's names, so there is one shape in the record.
   */
  const routes = (input.routes ?? []).map((route) => ({
    origHub: (route.origHub ?? route.originHub)!,
    ...(route.origCity ?? route.originCity
      ? { origCity: (route.origCity ?? route.originCity)! }
      : {}),
    destHub: route.destHub,
    ...(route.destCity === undefined ? {} : { destCity: route.destCity }),
    ...(route.estimatedMonthlyVolume ?? route.volumeKgPerMonth
      ? { estimatedMonthlyVolume: (route.estimatedMonthlyVolume ?? route.volumeKgPerMonth)! }
      : {}),
  }));

  let routeLanes: string[] = [];
  if (routes.length) {
    const zones = await knownZones();
    const hubs = routes.flatMap((route) => [route.origHub, route.destHub]);
    const resolved = resolveHubs(hubs, zones);

    if (resolved.unknown.length > 0) {
      return NextResponse.json(
        { success: false, message: unknownHubMessage([...new Set(resolved.unknown)]) },
        { status: 422 },
      );
    }

    // A route names a corridor, not a mode. Surface is the mode a lane is agreed on unless
    // the customer also asked for others, which they do through `modes`.
    routeLanes = routes.map((_, at) =>
      laneKey('surface', resolved.zones[at * 2]!, resolved.zones[at * 2 + 1]!),
    );
  }

  const created = await raiseContractRequest({
    customerCode: customer.code,
    raisedBy: input.raisedBy,
    ...(input.note ? { note: input.note } : {}),
    ask: {
      ...(input.modes?.length ? { modes: input.modes as Mode[] } : {}),
      ...(input.lanes?.length || routeLanes.length
        ? { lanes: [...new Set([...(input.lanes ?? []), ...routeLanes])] }
        : {}),
      ...(input.weightBands?.length ? { weightBands: input.weightBands } : {}),
    },
    ...(input.proposedRates?.length ? { proposedRates: input.proposedRates } : {}),
    ...(routes.length ? { routes } : {}),
    ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.effectiveTo ? { effectiveTo: input.effectiveTo } : {}),
  });

  await recordAudit({
    action: 'contract-request-raised',
    actor: { id: 'portal', email: input.raisedBy, name: input.raisedBy },
    at: created.raisedAt,
    detail: { customer: customer.code, reference: created.reference },
  });

  return NextResponse.json(
    {
      success: true,
      data: {
        reference: created.reference,
        status: created.status,
        // Said plainly so the portal has no excuse to imply otherwise.
        message:
          'Received. Our team will review it. Nothing about your current rates changes ' +
          'unless and until a new contract is agreed.',
      },
    },
    { status: 201 },
  );
}

/** Poll one request. The customer is told the state, never the pricing behind it. */
export async function GET(request: Request) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const reference = new URL(request.url).searchParams.get('reference');
  if (!reference) return badRequest('reference is required.');

  const found = await contractRequestByReference(reference);
  if (!found) {
    return NextResponse.json({ success: false, message: 'No such request.' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    data: {
      reference: found.reference,
      customer: found.customerCode,
      status: found.status,
      raisedAt: found.raisedAt.toISOString(),
      ...(found.decidedAt ? { decidedAt: found.decidedAt.toISOString() } : {}),
      // The reviewer's comment is written to be read by the customer.
      ...(found.comment ? { comment: found.comment } : {}),
      // Deliberately absent: which cells landed in the draft, and any rate. An accepted
      // request is a promise to price something, not a promise about a price.
    },
  });
}
