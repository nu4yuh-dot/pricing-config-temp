/**
 * Rate limiting the published API.
 *
 * There was none. No route returned 429, nothing throttled a caller, and every request
 * reached the database directly — so a runaway loop on a caller's side was a load test
 * nobody scheduled. The login throttle in `auth/throttle.ts` is the only other limiter in
 * the system and it guards a different thing: that one counts *failures* and locks an
 * account out, this one counts *requests* and refuses the excess.
 *
 * Keyed on the caller, not the client address. Every request comes from one integration
 * through whatever proxies sit in front of it, so an address identifies the last hop rather
 * than who is asking; a signed request names itself, and the static key is one caller by
 * definition. That also means one misbehaving integration cannot spend another's budget.
 *
 * In-memory, per instance, and honest about it. A shared limiter belongs in Redis once more
 * than one instance runs; with a single instance this is the whole limiter, and with several
 * it becomes a per-instance budget — which is a weaker guarantee but never a wrong answer,
 * because every instance still refuses its own excess.
 */

/** Requests per window, per caller. Generous: this is machine traffic, not a browser. */
export const DEFAULT_LIMIT = 600;
export const WINDOW_MS = 60_000;

interface Window {
  count: number;
  /** When this window opened. Fixed rather than sliding — cheaper, and precise enough. */
  startedAt: number;
}

const windows = new Map<string, Window>();

function limit(): number {
  const configured = Number(process.env.API_RATE_LIMIT);
  // A zero or negative limit would refuse everything, which is never what somebody meant
  // by setting it; an unparseable value falls back rather than throwing at request time.
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_LIMIT;
}

/** Keep the map bounded on a long-running instance. */
function evictStale(now: number): void {
  if (windows.size < 5000) return;
  for (const [key, window] of windows) {
    if (now - window.startedAt > WINDOW_MS) windows.delete(key);
  }
}

export interface RateDecision {
  allowed: boolean;
  /** The budget in force, so a caller can pace itself rather than guess. */
  limit: number;
  remaining: number;
  /** Seconds until the window resets. Sent as `Retry-After` when refused. */
  retryAfterSeconds: number;
}

/**
 * Count one request against a caller's budget.
 *
 * Called once per request, at the point the caller is known — so an unauthenticated request
 * is never counted against anybody, and a caller cannot spend a budget by failing to
 * authenticate.
 */
export function consume(caller: string, now = Date.now()): RateDecision {
  evictStale(now);
  const max = limit();
  const window = windows.get(caller);

  if (!window || now - window.startedAt >= WINDOW_MS) {
    windows.set(caller, { count: 1, startedAt: now });
    return { allowed: true, limit: max, remaining: max - 1, retryAfterSeconds: 0 };
  }

  window.count += 1;
  const remaining = Math.max(max - window.count, 0);
  const retryAfterSeconds = Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - now) / 1000));

  // Strictly greater than: a caller whose budget is 600 may make its 600th request.
  if (window.count > max) {
    return { allowed: false, limit: max, remaining: 0, retryAfterSeconds };
  }
  return { allowed: true, limit: max, remaining, retryAfterSeconds };
}

/** Only used by tests, to keep them independent of one another. */
export function resetRateLimits(): void {
  windows.clear();
}
