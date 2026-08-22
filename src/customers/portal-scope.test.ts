import { describe, expect, test } from 'vitest';
import { outOfScope } from './portal-actor';

/**
 * The tenant check, on the endpoints that take a customer outside the path.
 *
 * `customerOr404` covers the path-based endpoints and needs a database, so it is exercised
 * by the HTTP verification script. This covers the decision itself, which is the part that
 * must not drift: unscoped means unrestricted, and scoped means exactly one code.
 */
describe('outOfScope', () => {
  test('an unscoped caller may act for anybody', () => {
    expect(outOfScope({ customerScope: null }, 'ACME')).toBeNull();
    expect(outOfScope({ customerScope: null }, 'MAHLE')).toBeNull();
  });

  test('a scoped caller may act for its own customer', () => {
    expect(outOfScope({ customerScope: 'ACME' }, 'ACME')).toBeNull();
  });

  test('a scoped caller is refused another customer', () => {
    const refused = outOfScope({ customerScope: 'ACME' }, 'MAHLE');
    expect(refused).not.toBeNull();
    expect(refused?.status).toBe(403);
  });

  test('the refusal names the scope rather than the customer asked for', async () => {
    // Naming the requested code back would confirm to a caller which codes it guessed at.
    const refused = outOfScope({ customerScope: 'ACME' }, 'MAHLE');
    const body = (await refused?.json()) as { error: string; message: string };
    expect(body.error).toBe('out-of-scope');
    expect(body.message).toContain('ACME');
    expect(body.message).not.toContain('MAHLE');
  });

  test('the comparison is exact, not a prefix', () => {
    // 'ACME' must not open 'ACME-SUBSIDIARY'.
    expect(outOfScope({ customerScope: 'ACME' }, 'ACME-SUBSIDIARY')?.status).toBe(403);
    expect(outOfScope({ customerScope: 'ACME' }, 'acme')?.status).toBe(403);
  });
});
