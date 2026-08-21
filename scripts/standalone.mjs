/**
 * Run the server the way production runs it.
 *
 * `next start` is the wrong command for this app: `output: 'standalone'` is set, Next warns
 * that the two do not go together, and production runs `node server.js` out of the
 * standalone tree. Verifying against `next start` means verifying something the Docker image
 * never runs.
 *
 * It also **rebuilds first, every time**. A running Next server holds its modules in memory
 * and keeps serving the previous build after a rebuild — no warning, no stale marker, just
 * yesterday's answer. That cost this project four wrong conclusions in one day, so the
 * freshness is not left to whoever is typing: this builds, assembles, and starts, and the
 * BUILD_ID it prints is the one it just produced.
 *
 *   npm run start:standalone -- --port 3998
 *   SKIP_BUILD=1 npm run start:standalone     when the build is known current
 */

import { spawnSync, spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const portIndex = process.argv.indexOf('--port');
const port = portIndex === -1 ? (process.env.PORT ?? '3000') : process.argv[portIndex + 1];

if (process.env.SKIP_BUILD !== '1') {
  // Removed rather than built over: a stale route file from a deleted page would otherwise
  // survive in the standalone tree and be served by a build that no longer contains it.
  rmSync(join(root, '.next'), { recursive: true, force: true });
  const build = spawnSync('npx', ['next', 'build'], { stdio: 'inherit', cwd: root });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const standalone = join(root, '.next', 'standalone');
if (!existsSync(join(standalone, 'server.js'))) {
  console.error('No standalone build. Run without SKIP_BUILD=1.');
  process.exit(1);
}

// Exactly what the Dockerfile's runner stage copies. Without these the server starts and
// then serves a page with no CSS, which looks like a styling bug rather than a missing step.
cpSync(join(root, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });
if (existsSync(join(root, 'public'))) {
  cpSync(join(root, 'public'), join(standalone, 'public'), { recursive: true });
}

const buildId = readFileSync(join(root, '.next', 'BUILD_ID'), 'utf8').trim();
console.log(`standalone server · BUILD_ID ${buildId} · port ${port}`);

const server = spawn('node', ['server.js'], {
  cwd: standalone,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', NEXT_BUILD_ID: buildId },
});
server.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}
