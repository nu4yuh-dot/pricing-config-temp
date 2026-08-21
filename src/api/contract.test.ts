import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractSurface } from './contract-surface';
import { openApiDocument } from './openapi';

const RECORDED = join(__dirname, '__contract__', 'published-surface.txt');

/**
 * The robot.
 *
 * The platform's rule is that an API is added to and never changed, and the core enforces
 * it in CI rather than in review because "the rename rule is enforced by a robot, not by
 * review". This service publishes a contract of its own, so it needs the same guard in
 * this direction.
 *
 * The asymmetry is the whole point: adding a path, a field or a status is fine and this
 * test says so. Removing or renaming one fails, because a caller is already deployed
 * against it and cannot be made to redeploy.
 *
 * If a failure here is genuinely intended — and it almost never is — regenerate
 * `__contract__/published-surface.txt`. Doing that is a decision to break somebody, so it
 * belongs in a commit message.
 */
describe('the published contract', () => {
  const recorded = readFileSync(RECORDED, 'utf8').trim().split('\n');
  const current = contractSurface();

  test('nothing that was published has been removed or renamed', () => {
    // `requires …` entries are excluded here and checked by the promotion test below:
    // dropping one means a field became optional, which breaks no caller.
    const missing = recorded
      .filter((entry) => !entry.startsWith('requires '))
      .filter((entry) => !current.includes(entry));
    expect(missing).toEqual([]);
  });

  test('everything published is recorded, so nothing is left unprotected', () => {
    /**
     * Additions are fine. **Unrecorded** additions are not.
     *
     * This used to report additions and pass, which let the file fall behind — and the guard
     * only protects what the file knows about, so every entry added since the last refresh
     * was quietly unguarded. It had drifted 52 entries that way: a whole endpoint, both
     * paging parameters and a 403 could each have been deleted later without this noticing.
     *
     * So a new entry has to be written down. `npm run contract:record` does it, and the diff
     * in review is the point: it is the list of what callers may now depend on.
     */
    const added = current.filter((entry) => !recorded.includes(entry));
    expect(
      added,
      `The published surface grew and was not recorded. Run \`npm run contract:record\` ` +
        `and commit the diff.\n  ${added.join('\n  ')}`,
    ).toEqual([]);
  });

  test('the deprecated field names are still accepted, because callers still send them', () => {
    // These two were superseded by destinationPincode and customerCode. Both must outlive
    // the rename; dropping either is the exact breakage the append-only rule prevents.
    expect(current).toContain('POST /api/v1/quotes body.destPincode');
    expect(current).toContain('POST /api/v1/quotes body.customerId');
    expect(current).toContain('POST /api/v1/quotes body.destinationPincode');
    expect(current).toContain('POST /api/v1/quotes body.customerCode');
  });

  test('both authentication schemes are published, the deprecated one included', () => {
    expect(current).toContain('auth signedServiceKey');
    expect(current).toContain('auth staticKey');
  });

  test('a field is not quietly promoted to required', () => {
    // The breaking direction: a caller that has always omitted a field starts failing,
    // while nothing was removed and every other check stays green.
    const promoted = current
      .filter((entry) => entry.startsWith('requires '))
      .filter((entry) => !recorded.includes(entry))
      // New endpoints may of course have required fields; only a field that was already
      // published and optional counts as a promotion.
      .filter((entry) => recorded.includes(entry.slice('requires '.length)));
    expect(promoted).toEqual([]);
  });

  test('every path in the document is reachable as a route file', () => {
    // A published path with no route is a 404 the spec promises works, which is worse than
    // an undocumented endpoint: a caller writes against it and finds out in production.
    const paths = Object.keys((openApiDocument() as { paths: Record<string, unknown> }).paths);
    const missing = paths.filter((path) => {
      const asFile = path.replace(/\{(\w+)\}/g, '[$1]').replace(/^\//, '');
      return !existsSync(join(__dirname, '..', 'app', asFile, 'route.ts'));
    });
    expect(missing).toEqual([]);
  });
});
