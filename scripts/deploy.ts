/**
 * Deploy, and prove what is running.
 *
 * Every step here exists because something went wrong without it.
 *
 *  - `railway up` uploads the **working tree**, not a commit. A dirty tree ships code that
 *    is in no commit and that nobody can get back to, so this refuses to start.
 *  - Railway has no commit to report, because the deploy is an upload rather than a GitHub
 *    trigger. `BUILD_COMMIT` is set here, immediately before the upload, so it cannot
 *    describe a different build than the one it ships with.
 *  - A passing health check does not mean the new build is live: the old container serves
 *    for the whole rollout, so `/api/health` answers `ok` while the deployment is still
 *    BUILDING. Waiting on the deployment status is the only honest signal.
 *  - And then it checks: the commit production reports must be the commit that was pushed.
 *    That is the difference between believing a deploy worked and knowing it.
 *
 *   npm run deploy
 */

import { execFileSync } from 'node:child_process';

const SERVICE = process.env.RAILWAY_SERVICE ?? 'pricing-config-temp';
const HEALTH = process.env.DEPLOY_HEALTH_URL ?? 'https://pricing-config.samex.delivery/api/health';

const run = (command: string, args: string[]): string =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dirty = run('git', ['status', '--porcelain']);
  if (dirty !== '') {
    console.error('The working tree is not clean. `railway up` uploads the tree, not a commit,');
    console.error('so this would ship code that exists in no commit:\n');
    console.error(dirty);
    process.exit(1);
  }

  const commit = run('git', ['rev-parse', 'HEAD']);
  const short = commit.slice(0, 7);
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);

  const remote = run('git', ['ls-remote', 'origin', '-h', 'refs/heads/main']).split(/\s/)[0] ?? '';
  if (remote !== commit) {
    console.error(`HEAD is ${short} but origin/main is ${remote.slice(0, 7)}.`);
    console.error('Push first, so what is deployed is what is reviewable.');
    process.exit(1);
  }

  console.log(`Deploying ${short} (${branch})`);

  // Set before the upload, never after: a variable set afterwards describes the build that
  // is about to be replaced.
  run('railway', ['variables', '--service', SERVICE, '--set', `BUILD_COMMIT=${commit}`, '--skip-deploys']);
  console.log(`  stamped BUILD_COMMIT=${short}`);

  run('railway', ['up', '--service', SERVICE, '--detach']);
  console.log('  uploaded, building…');

  const deadline = Date.now() + 15 * 60_000;
  let status = '';
  while (Date.now() < deadline) {
    await sleep(15_000);
    const line = run('railway', ['deployment', 'list']).split('\n')[1] ?? '';
    status = /SUCCESS|FAILED|CRASHED|REMOVED/.exec(line)?.[0] ?? '';
    if (status !== '') break;
  }
  if (status !== 'SUCCESS') {
    console.error(`  deployment ended as ${status || 'still building after 15 minutes'}`);
    process.exit(1);
  }
  console.log('  deployment SUCCESS');

  // The rollout can still be finishing, so this asks until the answer is the new build
  // rather than reading once and believing it.
  const until = Date.now() + 3 * 60_000;
  while (Date.now() < until) {
    const response = await fetch(HEALTH, { cache: 'no-store' }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as
      | { status?: string; build?: { commit?: string; startedAt?: string } }
      | null;
    if (body?.build?.commit === commit) {
      console.log(`  live and serving ${short}, up since ${body.build?.startedAt}`);
      console.log(`  status: ${body.status}`);
      process.exit(0);
    }
    console.log(`  serving ${String(body?.build?.commit ?? 'unknown').slice(0, 7)}, waiting…`);
    await sleep(10_000);
  }

  console.error(`Production never reported ${short}. It may still be serving the old build.`);
  process.exit(1);
}

main().catch((error) => {
  console.error('The deploy did not complete:', error);
  process.exit(1);
});
