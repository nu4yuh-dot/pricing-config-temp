import { NextResponse } from 'next/server';
import { PlantUpsert } from '../../../../../../api/contracts';
import { authenticatedJson, authenticatedRequest, badRequest } from '../../../../_auth';
import { savePlant, deletePlant } from '../../../../../../data/enterprise';
import { portalActor, customerOr404 } from '../../../../../../customers/portal-actor';
import { EMPTY_ADDRESS } from '../../../../../../domain/company';

/**
 * Plants — the sites a customer ships from.
 *
 * The portal collects "Location" as one line, `Mumbai, Maharashtra`. We hold a structured
 * address because a pincode has to resolve to a zone, so the line is split on the last
 * comma: everything before it is the city, everything after is the state. A line with no
 * comma is taken as a city with no state rather than refused — a plant with a pincode
 * still prices correctly, and refusing the save would lose the rest of what they typed.
 */
function splitLocation(location: string): { city: string; state: string } {
  const at = location.lastIndexOf(',');
  if (at === -1) return { city: location.trim(), state: '' };
  return { city: location.slice(0, at).trim(), state: location.slice(at + 1).trim() };
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;

  const parsed = PlantUpsert.safeParse(auth.body);
  if (!parsed.success) return badRequest('Invalid plant.', parsed.error.flatten());
  const input = parsed.data;

  const { code } = await params;
  const customer = await customerOr404(code);
  if ('response' in customer) return customer.response;

  const { city, state } = splitLocation(input.location);

  try {
    const saved = await savePlant(
      customer.customer.code,
      {
        ...(input.code === undefined ? {} : { code: input.code }),
        name: input.name,
        address: {
          ...EMPTY_ADDRESS,
          line1: input.location,
          city,
          state,
          ...(input.pincode === undefined ? {} : { pincode: input.pincode }),
        },
        ...(input.gstNumber ?? input.gstin
          ? { gstin: (input.gstNumber ?? input.gstin)! }
          : {}),
        ...((input.contactName ?? input.contactPerson) === undefined
          ? {}
          : {
              contact: {
                name: (input.contactName ?? input.contactPerson)!,
                role: 'Site contact',
                ...(input.contactPhone === undefined ? {} : { phone: input.contactPhone }),
              },
            }),
        active: input.isActive ?? input.active ?? true,
      },
      portalActor(auth.caller),
    );
    return NextResponse.json({ success: true, data: saved }, { status: input.code ? 200 : 201 });
  } catch (cause) {
    return badRequest(cause instanceof Error ? cause.message : 'Could not save that plant.');
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const plantCode = new URL(request.url).searchParams.get('plantCode');
  if (!plantCode) return badRequest('plantCode is required.');

  const { code } = await params;
  const customer = await customerOr404(code);
  if ('response' in customer) return customer.response;

  try {
    // Departments at this plant go with it — a department with no plant is an orphan the
    // portal cannot render and nobody can delete.
    await deletePlant(customer.customer.code, plantCode, portalActor(auth.caller));
    return NextResponse.json({ success: true });
  } catch (cause) {
    return badRequest(cause instanceof Error ? cause.message : 'Could not delete that plant.');
  }
}
