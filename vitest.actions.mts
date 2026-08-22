import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Server actions, against a real database.
 *
 * Deliberately a second config rather than more files in the main one. The unit suite is
 * pure functions with no database, which is what keeps it a few seconds long and runnable
 * anywhere; these need a live mongod and are therefore opt-in.
 *
 * They exist because of a whole class of bug the other suites cannot see. `quote()` was
 * called with six arguments where the seventh was the customer's offers, so every discount
 * silently vanished: the pricing logic was correct and tested, the screen rendered, and the
 * repository functions worked. The defect was in the wiring between them — which is exactly
 * what a server action is. 1,510 unit tests and 50 browser tests both passed through it.
 *
 *   npm run verify:actions
 */
export default defineConfig({
  test: {
    include: ['src/app/__actions__/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['src/app/__actions__/next-stubs.ts'],
    /**
     * One file at a time. These share one database and several of them move the same
     * customer's money or the same card's draft, so running them in parallel would make
     * them fail on each other rather than on the code.
     */
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { '@': resolve(import.meta.dirname, './src') },
  },
});
