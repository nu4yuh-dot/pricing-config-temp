import { defineConfig } from '@playwright/test';

/**
 * Browser tests, against a real build and a real database.
 *
 * The unit suite is 1,477 tests of pure functions and it could not have caught the bug this
 * exists for: `RowAction` was handed a plain closure from a Server Component, which
 * typechecks, builds, and then returns 500 the moment the component renders. Two of the four
 * broken pages even looked healthy, because their tables were empty and the component never
 * mounted.
 *
 * So these tests do the one thing nothing else here does: **render pages with rows in them**
 * and assert the response was not a 500. They are not a UI regression suite and are not
 * trying to be — they are the check that every screen a person can reach actually reaches
 * them.
 *
 * They need a database. `webServer` starts the built app against whatever MONGODB_URI is
 * set, so this runs against a local mongod and never against production.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3998',
    trace: 'retain-on-failure',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npx next start -p 3998',
        url: 'http://127.0.0.1:3998/api/health',
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
          MONGODB_DB: process.env.MONGODB_DB ?? 'dns_pricing',
          SESSION_SECRET: process.env.SESSION_SECRET ?? 'e2e-session-secret-at-least-32-chars-long',
          BOOKING_API_KEY: process.env.BOOKING_API_KEY ?? 'e2e-booking-api-key-long-enough-32ch',
        },
      },
});
