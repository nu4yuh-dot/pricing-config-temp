import { vi } from 'vitest';

/**
 * The three Next.js modules a server action reaches for, stubbed.
 *
 * Only these three. Everything else — the session, the capability check, the repositories,
 * the pricing engine, the database — is the real thing, because those are what the tests
 * are here to exercise. Stubbing the action's own dependencies would leave a test that
 * proves the mock was called.
 *
 * `cookies()` reads a token this file holds, and the token is a **real JWT signed with the
 * real secret** — so `currentUser` verifies it exactly as it does in production, and a test
 * can sign in as a role that is not permitted and watch the action refuse.
 */

/** The session the next action call will see. Set through `signInAs` in the harness. */
export const sessionHolder: { token: string | null } = { token: null };

/**
 * The request headers the next action call will see.
 *
 * `signIn` throttles per client address and reads the forwarded chain to find it, so a stub
 * with only `cookies` made it fail on a missing export rather than on anything real. Set
 * `x-forwarded-for` to give successive tests distinct clients, or leave it empty — the
 * action falls back to the email so that a missing header cannot switch throttling off.
 */
export const headerHolder: { values: Record<string, string> } = { values: {} };

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'dns_pricing_session' && sessionHolder.token !== null
        ? { name, value: sessionHolder.token }
        : undefined,
    set: () => {},
    delete: () => {
      sessionHolder.token = null;
    },
  }),
  headers: async () => ({
    get: (name: string) => headerHolder.values[name.toLowerCase()] ?? null,
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));

/**
 * `redirect` and `notFound` are implemented by throwing, and the digest is how Next tells
 * its own control flow apart from a real failure. The stub reproduces that shape rather
 * than returning, because `attempt()` in `action-result.ts` inspects exactly this digest to
 * decide whether to re-throw — a stub that returned quietly would make navigation look like
 * a caught error and hide the bug that reasoning exists to prevent.
 */
export class RedirectError extends Error {
  digest: string;
  constructor(public url: string) {
    super(`NEXT_REDIRECT to ${url}`);
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

export class NotFoundError extends Error {
  digest = 'NEXT_NOT_FOUND';
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
  notFound: () => {
    throw new NotFoundError();
  },
}));
