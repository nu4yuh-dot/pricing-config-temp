'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  editDraftCells,
  resetDraft,
  submitForApproval,
  reviewRequest,
} from '../data/rate-cards';
import {
  currentUser,
  createSession,
  destroySession,
  toActor,
  verifyCredentials,
  createUser,
  setUserRole,
  setUserActive,
  changeOwnPassword,
  changeOwnName,
} from '../auth/session';
import { can, type Capability, type Role } from '../auth/roles';
import { checkThrottle, recordFailure, recordSuccess } from '../auth/throttle';
import { headers } from 'next/headers';
import type { ReviewDecisions } from '../data/workflow';
import { recordAudit } from '../data/audit';

async function authorise(capability: Capability) {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!can(user.role, capability)) {
    throw new Error(`Your role (${user.role}) is not permitted to do that.`);
  }
  return user;
}

export async function signIn(_previous: unknown, form: FormData) {
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');

  /**
   * Throttle per client address. Behind a load balancer the immediate peer is the
   * balancer, so the forwarded chain's first entry is the real client; fall back to
   * the email so a missing header cannot disable throttling entirely.
   */
  const forwarded = (await headers()).get('x-forwarded-for') ?? '';
  const clientKey = forwarded.split(',')[0]?.trim() || `email:${email.toLowerCase()}`;

  const throttle = checkThrottle(clientKey);
  if (!throttle.allowed) {
    const minutes = Math.ceil((throttle.retryAfterSeconds ?? 900) / 60);
    return {
      error: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    };
  }

  const user = await verifyCredentials(email, password);
  if (!user) {
    const after = recordFailure(clientKey);
    // Same message either way: which of the two was wrong is not the caller's business.
    return {
      error:
        after.remaining > 0 && after.remaining <= 3
          ? `That email and password combination is not recognised. ${after.remaining} attempt${after.remaining === 1 ? '' : 's'} left before a temporary lockout.`
          : 'That email and password combination is not recognised.',
    };
  }

  recordSuccess(clientKey);
  await createSession(user);
  await recordAudit({ action: 'signed-in', actor: toActor(user), at: new Date() });
  redirect('/console/model-1/rates');
}

export async function signOut() {
  await destroySession();
  redirect('/login');
}

export async function saveDraftEdits(
  cardKey: string,
  edits: { bind: string; value: string | number | null }[],
) {
  const user = await authorise('edit-draft');
  await editDraftCells(cardKey, edits, toActor(user));
}

export async function discardDraft(cardKey: string) {
  const user = await authorise('edit-draft');
  await resetDraft(cardKey, toActor(user));
}

export async function submitDraftForApproval(cardKey: string) {
  const user = await authorise('submit-for-approval');
  const request = await submitForApproval(cardKey, toActor(user));
  revalidatePath('/approvals');
  redirect(`/approvals/${request._id.toHexString()}`);
}

export async function decideRequest(requestId: string, form: FormData) {
  const user = await authorise('review-change-request');
  const intent = String(form.get('intent') ?? '');
  const comment = String(form.get('comment') ?? '').trim() || undefined;

  let decisions: ReviewDecisions;
  if (intent === 'approve-all') {
    decisions = 'approve-all';
  } else if (intent === 'reject-all') {
    decisions = 'reject-all';
  } else {
    // Line by line: each change carries a select named `decision:<bind>`.
    const perLine: Record<string, { decision: 'approved' | 'rejected'; comment?: string }> = {};
    for (const [key, value] of form.entries()) {
      if (!key.startsWith('decision:')) continue;
      const bind = key.slice('decision:'.length);
      const lineComment = String(form.get(`comment:${bind}`) ?? '').trim();
      perLine[bind] = {
        decision: value === 'approved' ? 'approved' : 'rejected',
        ...(lineComment ? { comment: lineComment } : {}),
      };
    }
    decisions = perLine;
  }

  await reviewRequest(requestId, decisions, toActor(user), comment);
  revalidatePath('/approvals');
  redirect('/approvals');
}

/**
 * Change your own display name.
 *
 * Available to every role: a viewer has as much right to be called by their own name as
 * an admin. The session is re-issued so the masthead updates now rather than at the next
 * sign-in, since a change that appears not to have worked gets made twice.
 */
export async function changeName(_previous: unknown, form: FormData) {
  const user = await currentUser();
  if (!user) return { error: 'Your session has expired. Sign in again.' };

  const name = String(form.get('name') ?? '').trim();
  if (name.length < 2) return { error: 'Names need at least two characters.' };
  if (name.length > 80) return { error: 'That name is too long — 80 characters at most.' };
  if (name === user.name) return { ok: 'That is already your name.' };

  const previousName = user.name;
  const updated = await changeOwnName(user.id, name);
  await createSession(updated);
  await recordAudit({
    action: 'name-changed',
    actor: toActor(updated),
    at: new Date(),
    detail: { from: previousName, to: name },
  });
  return { ok: 'Your name has been updated.' };
}

/**
 * Change your own password.
 *
 * Deliberately not an admin capability: an admin can disable an account or issue a new
 * one, but cannot quietly take over an existing person's login, because setting a
 * password here requires knowing the current one.
 */
export async function changePassword(_previous: unknown, form: FormData) {
  const user = await currentUser();
  if (!user) return { error: 'Your session has expired. Sign in again.' };

  const current = String(form.get('current') ?? '');
  const next = String(form.get('next') ?? '');
  const confirm = String(form.get('confirm') ?? '');

  if (next.length < 12) {
    return { error: 'Choose a password of at least 12 characters.' };
  }
  if (next !== confirm) {
    return { error: 'The two new passwords do not match.' };
  }
  if (next === current) {
    return { error: 'That is your current password. Choose a different one.' };
  }

  try {
    await changeOwnPassword(user.id, current, next);
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not change your password.' };
  }

  await recordAudit({ action: 'password-changed', actor: toActor(user), at: new Date() });
  return { ok: 'Your password has been changed.' };
}

export async function addUser(_previous: unknown, form: FormData) {
  const actor = await authorise('manage-users');
  const email = String(form.get('email') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const role = String(form.get('role') ?? 'viewer') as Role;

  if (!email || !name) return { error: 'Name and email are both required.' };
  if (password.length < 12) return { error: 'Choose a password of at least 12 characters.' };

  await createUser({ email, name, password, role });
  await recordAudit({
    action: 'user-created',
    actor: toActor(actor),
    at: new Date(),
    detail: { email, role },
  });
  revalidatePath('/users');
  return { ok: true as const };
}

export async function changeUserRole(userId: string, role: Role) {
  const user = await authorise('manage-users');
  await setUserRole(userId, role);
  await recordAudit({
    action: 'user-role-changed',
    actor: toActor(user),
    at: new Date(),
    detail: { userId, role },
  });
  revalidatePath('/users');
}

export async function toggleUserActive(userId: string, active: boolean) {
  await authorise('manage-users');
  await setUserActive(userId, active);
  revalidatePath('/users');
}
