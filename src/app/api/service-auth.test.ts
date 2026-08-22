import { describe, expect, test } from 'vitest';
import {
  parseServiceKeys,
  parseKeyScopes,
  stringToSign,
  sign,
  SKEW_SECONDS,
  MIN_SECRET_LENGTH,
} from './_auth';
import { NONCE_TTL_SECONDS } from '../../data/mongo';

const secret = 'a'.repeat(40);

describe('the keys we accept', () => {
  test('several keys are accepted at once, which is what makes rotation possible', () => {
    // Publish the new key beside the old, move the caller, then drop the old one. With a
    // single value there is always an instant where one side is wrong.
    const keys = parseServiceKeys(`core:${secret},core-next:${'b'.repeat(40)}`);
    expect([...keys.keys()]).toEqual(['core', 'core-next']);
  });

  test('a secret too short to be safe is treated as absent, not as a key', () => {
    expect(parseServiceKeys('core:short').size).toBe(0);
    expect(parseServiceKeys(`core:${'x'.repeat(MIN_SECRET_LENGTH - 1)}`).size).toBe(0);
    expect(parseServiceKeys(`core:${'x'.repeat(MIN_SECRET_LENGTH)}`).size).toBe(1);
  });

  test('a secret containing a colon survives, because base64 and URLs contain them', () => {
    const withColon = `${'z'.repeat(30)}:tail`;
    expect(parseServiceKeys(`core:${withColon}`).get('core')).toBe(withColon);
  });

  test('blank entries and stray whitespace do not become keys', () => {
    expect(parseServiceKeys(`  ,  , core : ${secret} ,`).get('core')).toBe(secret);
    expect(parseServiceKeys('').size).toBe(0);
    expect(parseServiceKeys(':::').size).toBe(0);
  });
});

describe('what a signature covers', () => {
  const base = { method: 'POST', path: '/api/v1/quotes', timestamp: '1700000000', nonce: 'n1', body: '{"a":1}' };

  test('the same request signs the same way every time', () => {
    expect(sign(secret, stringToSign(base))).toBe(sign(secret, stringToSign(base)));
  });

  test('changing the body changes the signature, so a payload cannot be edited in flight', () => {
    const edited = { ...base, body: '{"a":2}' };
    expect(sign(secret, stringToSign(edited))).not.toBe(sign(secret, stringToSign(base)));
  });

  test('changing the path changes it, so a quote signature cannot be replayed at a writing endpoint', () => {
    const moved = { ...base, path: '/api/v1/shipments' };
    expect(sign(secret, stringToSign(moved))).not.toBe(sign(secret, stringToSign(base)));
  });

  test('the method is covered too', () => {
    expect(sign(secret, stringToSign({ ...base, method: 'GET' }))).not.toBe(
      sign(secret, stringToSign(base)),
    );
  });

  test('the timestamp and the nonce each change it, which is what makes one usable once', () => {
    expect(sign(secret, stringToSign({ ...base, timestamp: '1700000001' }))).not.toBe(
      sign(secret, stringToSign(base)),
    );
    expect(sign(secret, stringToSign({ ...base, nonce: 'n2' }))).not.toBe(
      sign(secret, stringToSign(base)),
    );
  });

  test('a different secret does not verify', () => {
    expect(sign('b'.repeat(40), stringToSign(base))).not.toBe(sign(secret, stringToSign(base)));
  });

  test('the signed string is line-separated with the body hashed, not included', () => {
    // The body is hashed so a large payload does not have to be held twice, and so the
    // signed string cannot itself contain a newline that shifts the fields.
    const lines = stringToSign(base).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('POST');
    expect(lines[4]).toMatch(/^[0-9a-f]{64}$/);
    expect(stringToSign(base)).not.toContain('{"a":1}');
  });

  test('an empty body still hashes, so a GET signs like anything else', () => {
    expect(stringToSign({ ...base, method: 'GET', body: '' }).split('\n')[4]).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the signature announces its algorithm, so a second one can be added later', () => {
    expect(sign(secret, stringToSign(base))).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('the replay window', () => {
  test('a nonce is remembered for longer than a request may legitimately be late', () => {
    // If a nonce were forgotten sooner than the clock skew allowed, a captured request
    // would become replayable the moment its nonce expired — which is the whole defence.
    expect(NONCE_TTL_SECONDS).toBeGreaterThan(SKEW_SECONDS * 2);
  });
});

/**
 * Which customer a key may act for.
 *
 * Authentication says a caller is known. It never said which *customers* a known caller
 * may reach, and nothing else did either: any key that got through the door could read
 * any customer's negotiated rates, account position and team roster by changing the code
 * in the path. That is right for the core and the admin console, which act for everybody,
 * and wrong for a per-tenant caller.
 */
describe('per-key customer scope', () => {
  test('a key with no scope entry is unrestricted, so nothing installed today changes', () => {
    const scopes = parseKeyScopes('portal-acme:ACME');
    expect(scopes.get('core')).toBeUndefined();
  });

  test('a scoped key names exactly one customer', () => {
    const scopes = parseKeyScopes('portal-acme:ACME,portal-mahle:MAHLE');
    expect(scopes.get('portal-acme')).toBe('ACME');
    expect(scopes.get('portal-mahle')).toBe('MAHLE');
  });

  test('whitespace around entries is tolerated', () => {
    expect(parseKeyScopes(' portal-acme : ACME , portal-x : XCO ').get('portal-x')).toBe('XCO');
  });

  test('a malformed entry is dropped rather than half-applied', () => {
    // A scope that parsed to an empty code would restrict a key to a customer that cannot
    // exist, locking it out of everything — worse than not being configured.
    const scopes = parseKeyScopes('nocolon,:LEADINGCOLON,portal:,good:GOODCO');
    expect([...scopes.keys()]).toEqual(['good']);
  });

  test('an empty variable scopes nothing', () => {
    expect(parseKeyScopes('').size).toBe(0);
  });
});
