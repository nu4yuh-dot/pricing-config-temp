import { createHash, createHmac, randomUUID } from 'node:crypto';
import { CORE_ENDPOINTS, type CoreCustomerPayload, type CoreUpsertResult } from './contract';
import { queuedPushes, markSent, recordAttempt } from '../data/core-push';

/**
 * Calling the SameX core.
 *
 * The only outbound path in this service. It exists because the customer master lives here
 * now, while the core still needs customer records — to attach shipments to, and to let a
 * customer sign in to the enterprise portal.
 *
 * Signed the same way we require inbound calls to be signed. That is not symmetry for its
 * own sake: a shared convention means one implementation to reason about, and if the core
 * team tells us they sign differently, only this file and the verifier change.
 *
 * Unconfigured is a normal state, not an error. Before the core has built its endpoint,
 * `CORE_API_URL` is unset, `drainToCore` reports that it is not configured, and the queue
 * keeps its work. Nothing here ever throws into a user's save.
 */

const TIMEOUT_MS = 10_000;

export function coreIsConfigured(): boolean {
  return Boolean(process.env.CORE_API_URL && process.env.CORE_SERVICE_KEY_ID && process.env.CORE_SERVICE_SECRET);
}

function signedHeaders(method: string, path: string, body: string): Record<string, string> {
  const secret = process.env.CORE_SERVICE_SECRET ?? '';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const toSign = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n');

  return {
    'content-type': 'application/json',
    'x-samex-key-id': process.env.CORE_SERVICE_KEY_ID ?? '',
    'x-samex-timestamp': timestamp,
    'x-samex-nonce': nonce,
    'x-samex-signature': `sha256=${createHmac('sha256', secret).update(toSign, 'utf8').digest('hex')}`,
  };
}

/** One request. Never throws — a transport failure is a result, not an exception. */
async function send(
  method: string,
  path: string,
  payload: unknown,
): Promise<{ ok: true; body: CoreUpsertResult } | { ok: false; error: string }> {
  const base = (process.env.CORE_API_URL ?? '').replace(/\/$/, '');
  const body = JSON.stringify(payload);

  // A hung core must not hold a request open indefinitely; the queue will retry.
  const abort = AbortController ? new AbortController() : null;
  const timer = abort ? setTimeout(() => abort.abort(), TIMEOUT_MS) : null;

  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: signedHeaders(method, path, body),
      body,
      ...(abort ? { signal: abort.signal } : {}),
    });

    const text = await response.text();
    if (!response.ok) {
      // Truncated: an HTML error page from a proxy would otherwise fill the record.
      return { ok: false, error: `${response.status} ${text.slice(0, 200)}` };
    }

    try {
      return { ok: true, body: JSON.parse(text) as CoreUpsertResult };
    } catch {
      // A 200 with an unreadable body still means it was accepted. Refusing here would
      // resend a change the core has already applied.
      return { ok: true, body: { ok: true } };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'network failure' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function pushCustomer(payload: CoreCustomerPayload) {
  return send('PUT', CORE_ENDPOINTS.upsertCustomer(payload.customerCode), payload);
}

export interface DrainReport {
  configured: boolean;
  attempted: number;
  sent: number;
  failed: number;
  /** The first error seen, which is almost always the reason for all of them. */
  error?: string;
}

/**
 * Send what is queued, oldest first.
 *
 * Stops at the first failure rather than working through the rest. If the core is down,
 * the remaining calls will fail identically, and hammering it while it is recovering is
 * both rude and slower. Order is preserved for free.
 */
export async function drainToCore(limit = 25): Promise<DrainReport> {
  if (!coreIsConfigured()) {
    return { configured: false, attempted: 0, sent: 0, failed: 0 };
  }

  const pending = await queuedPushes(limit);
  const report: DrainReport = { configured: true, attempted: 0, sent: 0, failed: 0 };

  for (const push of pending) {
    report.attempted += 1;
    const result = await pushCustomer(push.payload);

    if (result.ok) {
      await markSent(push._id, result.body.coreCustomerId);
      report.sent += 1;
    } else {
      await recordAttempt(push._id, result.error);
      report.failed += 1;
      if (!report.error) report.error = result.error;
      break;
    }
  }

  return report;
}
