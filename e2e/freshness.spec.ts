import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Is the server answering the build that was just made?
 *
 * This suite exists because the answer was silently "no" four times in one day. A running
 * Next server holds its modules in memory: rebuild underneath it and it keeps serving the
 * previous build, with no warning, no marker, and a `BUILD_ID` on disk that no longer
 * matches what is being served. Every conclusion drawn against it is then about code that
 * was replaced.
 *
 * Nothing else here can catch that. Unit tests do not run a server; the screen tests would
 * pass happily against yesterday's build. So this compares what is served against what is on
 * disk, and fails when they differ.
 */

test('the running server is serving the build on disk', async ({ request }) => {
  const onDisk = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim();
  expect(onDisk).not.toBe('');

  const body = await (await request.get('/api/health')).json();
  const loaded = body.build.id;

  // Deliberately not read from a served page. A stale process reads BUILD_ID from disk when
  // asked, so a page reflects the files rather than the code — this asks the process what it
  // loaded, which is the code actually answering.
  test.skip(loaded === 'unknown', 'NEXT_BUILD_ID is not set; run through scripts/standalone.mjs');
  expect(
    loaded,
    `the server loaded build ${loaded} but ${onDisk} is on disk — it is serving an older build`,
  ).toBe(onDisk);
});

test('health names the commit it was built from', async ({ request }) => {
  const body = await (await request.get('/api/health')).json();
  expect(body).toMatchObject({ status: 'ok', database: 'reachable' });
  // `unknown` locally is correct: BUILD_COMMIT is set by the deploy, not by a dev run. What
  // matters is that the field exists, so production can be asked the same question.
  expect(body.build).toHaveProperty('commit');
  expect(body.build).toHaveProperty('startedAt');
  expect(Number.isNaN(Date.parse(body.build.startedAt))).toBe(false);
});

test('the process started after the build it is serving was made', async ({ request }) => {
  // A server older than its build is the stale case stated as a time rather than an id.
  const body = await (await request.get('/api/health')).json();
  const started = Date.parse(body.build.startedAt);
  const built = readFileSync(join(process.cwd(), '.next', 'BUILD_ID')) && (await import('node:fs')).statSync(join(process.cwd(), '.next', 'BUILD_ID')).mtimeMs;
  expect(started).toBeGreaterThanOrEqual(built - 5_000);
});
