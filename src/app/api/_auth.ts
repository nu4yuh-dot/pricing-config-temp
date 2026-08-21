import { NextResponse } from 'next/server';
import { createHash, createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { db, COLLECTIONS, NONCE_TTL_SECONDS } from '../../data/mongo';

/**
 * Service-to-service authentication.
 *
 * The platform handbook specifies this for calls between services: "a signed key (HMAC)
 * rather than a user token. Each request carries a timestamp and a one-use number, so a
 * captured request can't be replayed." Keys are per service and rotate without downtime.
 *
 * Two schemes are accepted, deliberately:
 *
 *   Signed (preferred). The caller proves it holds the secret without sending it, and
 *   the signature covers the method, the path and the body — so a captured request cannot
 *   be replayed, retargeted at another endpoint, or edited in flight.
 *
 *   A static key in `x-api-key` (deprecated). What the booking site uses today. It
 *   stays because removing it would break a caller that is live, and the append-only rule
 *   applies to us as much as to the core. It is not as good: the secret travels on every
 *   request, and a captured request replays for as long as the key lives.
 *
 * The header names and the exact signed string are ours, not the core's — the handbook
 * requires the scheme but does not state either. They are treated as PROVISIONAL until
 * the core team confirms theirs. That is also why signing is added alongside the static
 * key rather than replacing it: when their answer arrives, matching it is one more
 * accepted scheme, not a rename of a published one.
 */

/**
 * How far a caller's clock may be from ours. Five minutes each way.
 *
 * Asserted against the nonce TTL in the tests: a skew wider than the window a nonce is
 * remembered for would let a captured request replay once the nonce had expired.
 */
export const SKEW_SECONDS = 300;

/** Below this a shared secret is guessable, so it is treated as absent. */
export const MIN_SECRET_LENGTH = 32;

export interface ServiceCaller {
  /** Which key was presented, for the audit trail. Never the secret itself. */
  keyId: string;
  scheme: 'signed' | 'static-key';
}

/**
 * The keys we accept, as `keyId:secret` pairs.
 *
 * A list rather than one value is what makes rotation possible without downtime: publish
 * the new key alongside the old, move the caller across, then drop the old one. With a
 * single value there is always an instant where one side is wrong.
 */
export function parseServiceKeys(raw: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(':');
    if (at <= 0) continue;
    const keyId = trimmed.slice(0, at).trim();
    const secret = trimmed.slice(at + 1).trim();
    // A short secret is a misconfiguration, not a key. Refusing it here means a weak key
    // fails at the door rather than quietly protecting nothing.
    if (keyId && secret.length >= MIN_SECRET_LENGTH) keys.set(keyId, secret);
  }
  return keys;
}

function signingKeys(): Map<string, string> {
  return parseServiceKeys(process.env.SERVICE_KEYS ?? '');
}

/**
 * What gets signed.
 *
 * The method and path are in it so a signature captured against a quote cannot be
 * replayed against an endpoint that writes. The body hash is in it so the payload cannot
 * be edited in flight. The timestamp and nonce make each one usable once.
 */
export function stringToSign(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  const bodyHash = createHash('sha256').update(input.body, 'utf8').digest('hex');
  return [input.method.toUpperCase(), input.path, input.timestamp, input.nonce, bodyHash].join('\n');
}

export function sign(secret: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload, 'utf8').digest('hex')}`;
}

/** Constant-time compare that cannot throw on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return nodeTimingSafeEqual(left, right);
}

/**
 * The unique index that makes a nonce one-use, created on demand.
 *
 * This is deliberately not left to `ensureIndexes`, which only runs from the seed script.
 * Without the index `insertOne` never conflicts, `claimNonce` always reports success, and
 * replay protection silently protects nothing — a security check that passes for the
 * wrong reason, which is the worst failure mode available. It cost a caught replay in
 * testing to find, and the fix is for the guarantee not to depend on anyone having
 * remembered to run a script.
 *
 * Memoised per process, so it is one round trip at startup rather than one per request.
 * On failure the promise is cleared so the next request retries rather than inheriting a
 * permanent rejection.
 */
let nonceIndexReady: Promise<void> | null = null;

function ensureNonceIndex(): Promise<void> {
  if (!nonceIndexReady) {
    nonceIndexReady = (async () => {
      const collection = (await db()).collection(COLLECTIONS.serviceNonces);
      await collection.createIndex({ at: 1 }, { expireAfterSeconds: NONCE_TTL_SECONDS });
      try {
        await collection.createIndex({ keyId: 1, nonce: 1 }, { unique: true });
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        // A unique index cannot be built over rows that already violate it. That is not a
        // hypothetical: any database that served signed requests before this index existed
        // holds the duplicates those requests recorded, and without this the service would
        // answer 500 to every signed call until they aged out.
        //
        // Deleting the extras is safe. A duplicate row means that nonce was already used
        // twice, so keeping one of each preserves exactly the fact the index enforces.
        await removeDuplicateNonces();
        await collection.createIndex({ keyId: 1, nonce: 1 }, { unique: true });
      }
    })().catch((error: unknown) => {
      nonceIndexReady = null;
      throw error;
    });
  }
  return nonceIndexReady;
}

/** Keeps one row per (keyId, nonce) so the unique index can be built. */
async function removeDuplicateNonces(): Promise<void> {
  const collection = (await db()).collection(COLLECTIONS.serviceNonces);
  const groups = await collection
    .aggregate<{ _id: { keyId: string; nonce: string }; ids: unknown[] }>([
      { $group: { _id: { keyId: '$keyId', nonce: '$nonce' }, ids: { $push: '$_id' } } },
      { $match: { 'ids.1': { $exists: true } } },
    ])
    .toArray();

  for (const group of groups) {
    // Drop all but the first, which keeps the earliest claim rather than the replay.
    await collection.deleteMany({ _id: { $in: group.ids.slice(1) } as never });
  }
}

/**
 * Claims a nonce, or reports that it has been used.
 *
 * The uniqueness is enforced by the database, not by a check-then-write: two copies of a
 * captured request arriving at two instances at the same moment would both pass a read,
 * and one-use has to mean one use. A duplicate key error is the answer, not a failure.
 */
async function claimNonce(keyId: string, nonce: string): Promise<boolean> {
  await ensureNonceIndex();
  const collection = (await db()).collection(COLLECTIONS.serviceNonces);
  try {
    await collection.insertOne({ keyId, nonce, at: new Date() });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
}

const unauthorised = (message: string) =>
  NextResponse.json({ error: 'unauthorised', message }, { status: 401 });

/**
 * Authenticates one request against either scheme.
 *
 * `body` must be the raw text exactly as received — re-serialised JSON will not hash to
 * the same value, and a signature check against a re-serialised body is a check that
 * passes for the wrong reason.
 */
export async function authenticateService(
  request: Request,
  body: string,
): Promise<{ ok: true; caller: ServiceCaller } | { ok: false; response: NextResponse }> {
  const keyId = request.headers.get('x-samex-key-id');
  const signature = request.headers.get('x-samex-signature');
  const timestamp = request.headers.get('x-samex-timestamp');
  const nonce = request.headers.get('x-samex-nonce');

  const signedAttempt = keyId !== null || signature !== null;

  if (signedAttempt) {
    // A partial attempt is refused rather than quietly falling back to the static key: a
    // caller that meant to sign and got a header name wrong must hear about it, not be
    // let in by the weaker path.
    if (!keyId || !signature || !timestamp || !nonce) {
      return {
        ok: false,
        response: unauthorised(
          'A signed request needs all of x-samex-key-id, x-samex-timestamp, x-samex-nonce and x-samex-signature.',
        ),
      };
    }

    const secret = signingKeys().get(keyId);
    // Same message whether the key is unknown or the signature is wrong, so the response
    // cannot be used to discover which key ids exist.
    const reject = { ok: false as const, response: unauthorised('Signature does not verify.') };
    if (!secret) return reject;

    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return reject;
    const drift = Math.abs(Math.floor(Date.now() / 1000) - seconds);
    if (drift > SKEW_SECONDS) {
      return {
        ok: false,
        response: unauthorised(
          `Timestamp is ${drift}s from our clock; the window is ${SKEW_SECONDS}s. Check the sending clock, and send seconds rather than milliseconds.`,
        ),
      };
    }

    if (nonce.length < 8 || nonce.length > 200) return reject;

    const expected = sign(
      secret,
      stringToSign({
        method: request.method,
        path: new URL(request.url).pathname,
        timestamp,
        nonce,
        body,
      }),
    );
    if (!safeEqual(signature, expected)) return reject;

    // Signature first, nonce second. Checking the nonce first would let an unauthenticated
    // caller fill the store with garbage, and burn nonces a real caller might pick.
    if (!(await claimNonce(keyId, nonce))) {
      return {
        ok: false,
        response: unauthorised('This request has already been used. Each nonce is valid once.'),
      };
    }

    return { ok: true, caller: { keyId, scheme: 'signed' } };
  }

  /* ------------------------------------------------- the deprecated static key */

  const expected = process.env.BOOKING_API_KEY;
  if (!expected || expected.length < 24) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'api-not-configured',
          message: 'No service credentials are configured on the pricing service.',
        },
        { status: 503 },
      ),
    };
  }

  const presented = request.headers.get('x-api-key') ?? '';
  if (!safeEqual(presented, expected)) {
    return {
      ok: false,
      response: unauthorised(
        'A signed request, or a valid x-api-key header, is required.',
      ),
    };
  }

  return { ok: true, caller: { keyId: 'booking-site', scheme: 'static-key' } };
}

/**
 * Reads and authenticates a JSON request in one step.
 *
 * One helper because the signature covers the raw body, so the body has to be read as
 * text before it is parsed — and a route that read it as JSON first could not verify a
 * signature at all. Doing that per route is how one of them ends up parsing first and
 * silently accepting anything.
 */
export async function authenticatedJson(
  request: Request,
): Promise<{ ok: true; caller: ServiceCaller; body: unknown } | { ok: false; response: NextResponse }> {
  const raw = await request.text();
  const auth = await authenticateService(request, raw);
  if (!auth.ok) return auth;

  if (raw.trim() === '') return { ok: true, caller: auth.caller, body: undefined };

  try {
    return { ok: true, caller: auth.caller, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: badRequest('Body must be JSON.') };
  }
}

/** Authenticates a request with no body — a GET. */
export async function authenticatedRequest(
  request: Request,
): Promise<{ ok: true; caller: ServiceCaller } | { ok: false; response: NextResponse }> {
  return authenticateService(request, '');
}

export function badRequest(message: string, detail?: unknown): NextResponse {
  return NextResponse.json({ error: 'bad-request', message, detail }, { status: 400 });
}
