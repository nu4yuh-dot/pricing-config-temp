/**
 * Login throttling.
 *
 * Once the dashboard has a public URL, the sign-in form is reachable by anyone, and
 * bcrypt alone is not a rate limit — it slows one guess, not a thousand.
 *
 * Deliberately in-memory: it holds per-instance state, which is correct for a single
 * App Runner or ECS instance and degrades gracefully to "per instance" if scaled out.
 * A shared limiter (Redis, DynamoDB) is the right answer once there is more than one
 * instance; this is honest about being the small version.
 */

interface Attempt {
  count: number;
  /** When the window started, so it can be reset rather than sliding forever. */
  windowStart: number;
  /** Set once locked out; requests are refused until this passes. */
  lockedUntil?: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

const attempts = new Map<string, Attempt>();

/** Keep the map from growing without bound on a long-running instance. */
function evictStale(now: number): void {
  if (attempts.size < 5000) return;
  for (const [key, attempt] of attempts) {
    const expired = now - attempt.windowStart > WINDOW_MS && (attempt.lockedUntil ?? 0) < now;
    if (expired) attempts.delete(key);
  }
}

export interface ThrottleState {
  allowed: boolean;
  /** Seconds until another attempt is permitted. Only set when blocked. */
  retryAfterSeconds?: number;
  remaining: number;
}

/**
 * Check whether an attempt may proceed. Call before verifying credentials, and call
 * `recordFailure` only if they turn out to be wrong.
 */
export function checkThrottle(key: string, now = Date.now()): ThrottleState {
  evictStale(now);
  const attempt = attempts.get(key);
  if (!attempt) return { allowed: true, remaining: MAX_ATTEMPTS };

  if (attempt.lockedUntil && attempt.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((attempt.lockedUntil - now) / 1000),
      remaining: 0,
    };
  }

  // The window has passed, so the slate is clean.
  if (now - attempt.windowStart > WINDOW_MS) {
    attempts.delete(key);
    return { allowed: true, remaining: MAX_ATTEMPTS };
  }

  return { allowed: true, remaining: Math.max(MAX_ATTEMPTS - attempt.count, 0) };
}

export function recordFailure(key: string, now = Date.now()): ThrottleState {
  const existing = attempts.get(key);

  if (!existing || now - existing.windowStart > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 };
  }

  existing.count += 1;
  if (existing.count >= MAX_ATTEMPTS) {
    existing.lockedUntil = now + LOCKOUT_MS;
    return { allowed: false, retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000), remaining: 0 };
  }

  return { allowed: true, remaining: MAX_ATTEMPTS - existing.count };
}

/** A successful sign-in clears the record for that key. */
export function recordSuccess(key: string): void {
  attempts.delete(key);
}

/** Only used by tests, to keep them independent of one another. */
export function resetThrottle(): void {
  attempts.clear();
}
