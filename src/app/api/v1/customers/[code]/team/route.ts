import { NextResponse } from 'next/server';
import { TeamMemberUpsert } from '../../../../../../api/contracts';
import { authenticatedJson, authenticatedRequest, badRequest } from '../../../../_auth';
import { saveTeamMember, removeTeamMember } from '../../../../../../data/enterprise';
import { portalActor, customerOr404 } from '../../../../../../customers/portal-actor';
import type { TeamRole } from '../../../../../../domain/enterprise';

/**
 * The customer's team roster.
 *
 * **No password is accepted here, and the schema refuses one.** The body is strict, so a
 * portal that sends `password` gets a 400 rather than having it quietly ignored — a field
 * silently dropped is a field somebody believes was stored.
 *
 * The core issues and checks the credential. This says who should have one, and as what.
 *
 * `actorRole` is who is asking, as the portal knows them. Only the account owner — shown
 * there as "Supply Chain Head" — may change the team.
 */
/**
 * The customer's team roster.
 *
 * Serves the `team` and `team-emails` calls their portal makes — the second is this list
 * with only the addresses taken off it, and returning the whole member means a picker can
 * show a name beside the address rather than an email on its own.
 *
 * No credential appears here, because none is held. `?activeOnly=true` for the common case
 * of offering people to assign work to.
 */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { code } = await params;
  const customer = await customerOr404(code, auth.caller);
  if ('response' in customer) return customer.response;

  const { accountOf } = await import('../../../../../../data/enterprise');
  const activeOnly = new URL(request.url).searchParams.get('activeOnly') === 'true';
  const team = accountOf(customer.customer).team;

  return NextResponse.json({
    success: true,
    data: activeOnly ? team.filter((member) => member.status === 'active') : team,
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;

  const parsed = TeamMemberUpsert.safeParse(auth.body);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    // Named explicitly, because a portal sending a password deserves to be told why rather
    // than reading "unrecognised key" and wondering.
    const sentSecret = Object.keys((auth.body ?? {}) as object).some((key) =>
      /password|secret|credential/i.test(key),
    );
    return badRequest(
      sentSecret
        ? 'Do not send a password. This service never stores one — set the credential with the core, and send only who may sign in and as what.'
        : 'Invalid team member.',
      flat,
    );
  }
  const input = parsed.data;

  const { code } = await params;
  const customer = await customerOr404(code, auth.caller);
  if ('response' in customer) return customer.response;

  try {
    const saved = await saveTeamMember(
      customer.customer.code,
      input.actorRole as TeamRole,
      {
        email: input.email,
        name: input.name,
        role: input.role,
        status: input.status ?? 'active',
      },
      portalActor(auth.caller),
    );
    return NextResponse.json({ success: true, data: saved }, { status: 201 });
  } catch (cause) {
    // A rule refusal — not the owner, or the last owner being removed — is the caller's
    // problem to fix, so 403 rather than 400.
    return NextResponse.json(
      { error: 'refused', message: cause instanceof Error ? cause.message : 'Could not save.' },
      { status: 403 },
    );
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const email = url.searchParams.get('email');
  const actorRole = url.searchParams.get('actorRole');
  if (!email || !actorRole) return badRequest('email and actorRole are both required.');

  const { code } = await params;
  const customer = await customerOr404(code, auth.caller);
  if ('response' in customer) return customer.response;

  try {
    // Disabled, never deleted: they are named on shipments they booked.
    await removeTeamMember(customer.customer.code, actorRole as TeamRole, email, portalActor(auth.caller));
    return NextResponse.json({ success: true });
  } catch (cause) {
    return NextResponse.json(
      { error: 'refused', message: cause instanceof Error ? cause.message : 'Could not remove.' },
      { status: 403 },
    );
  }
}
