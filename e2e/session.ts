import { SignJWT } from 'jose';
import type { BrowserContext } from '@playwright/test';

/**
 * Sign in without going through the form.
 *
 * The cookie is minted with the same secret and claims `createSession` uses, so it is a real
 * session rather than a mock — the page's own `currentUser` verifies it. Done this way
 * because these tests are about whether pages render, not about the login form, and driving
 * a form for every test would make each one slower and each failure less specific.
 */
const SECRET = process.env.SESSION_SECRET ?? 'e2e-session-secret-at-least-32-chars-long';

export async function signIn(context: BrowserContext, role = 'admin'): Promise<void> {
  const token = await new SignJWT({ email: 'e2e@dnslogistic.com', name: 'E2E', role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('000000000000000000000001')
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(new TextEncoder().encode(SECRET));

  const url = new URL(process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3998');
  await context.addCookies([
    {
      name: 'dns_pricing_session',
      value: token,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
