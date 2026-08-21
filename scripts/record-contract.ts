/**
 * Record the published API surface.
 *
 * The guard in `src/api/contract.test.ts` compares what the service publishes against
 * `__contract__/published-surface.txt` and fails when something recorded there has gone.
 * That only protects what the file knows about — so a file left behind quietly stops
 * covering everything added since, which is how a guard becomes decoration.
 *
 * Run this after adding an endpoint, a parameter or a status, and commit the diff. It is
 * the record of what callers may now depend on; the diff in review is the point of it.
 *
 *   npm run contract:record
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { contractSurface } from '../src/api/contract-surface';

const file = join(process.cwd(), 'src', 'api', '__contract__', 'published-surface.txt');
const current = contractSurface();
const previous = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];

const added = current.filter((entry) => !previous.includes(entry));
const removed = previous.filter((entry) => !current.includes(entry));

writeFileSync(file, `${current.join('\n')}\n`);

console.log(`Recorded ${current.length} entries (was ${previous.length}).`);
if (added.length > 0) {
  console.log(`\n  ${added.length} added — callers may now depend on these:`);
  for (const entry of added) console.log(`    + ${entry}`);
}
if (removed.length > 0) {
  // Not an error here, because this script only writes down what is true. It is an error
  // in review: something a caller was told about has gone.
  console.log(`\n  ${removed.length} REMOVED — each of these breaks a deployed caller:`);
  for (const entry of removed) console.log(`    - ${entry}`);
  console.log('\n  If that is deliberate, say why in the commit message.');
}
