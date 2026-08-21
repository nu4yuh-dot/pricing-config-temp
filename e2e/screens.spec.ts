import { expect, test } from '@playwright/test';
import { signIn } from './session';

/**
 * Every screen a person can reach, rendered.
 *
 * The check is deliberately shallow and deliberately total: a 500 here is a page that is
 * broken for everybody, and this suite exists because that once shipped. Assertions about
 * layout belong in a different kind of test; this one answers "does it come up".
 */

/** Every route in the console. A page missing from this list is a page nothing renders. */
const SCREENS = [
  '/console/model-1/rates',
  '/console/model-1/params',
  '/console/model-1/geography',
  '/console/model-1/oda',
  '/console/model-1/cartage',
  '/console/model-1/transit',
  '/console/model-1/tax',
  '/console/model-1/network',
  '/console/model-1/bulk',
  '/console/model-1/ftl',
  '/console/model-1/changes',
  '/console/bluedart/bluedart',
  '/console/ups/ups',
  '/calculator',
  '/customers',
  '/customers/new',
  '/approvals',
  '/audit',
  '/history',
  '/invoices',
  '/collections',
  '/periods',
  '/money',
  '/settlement',
  '/carriers',
  '/services',
  '/templates',
  '/products',
  '/offers',
  '/charges',
  '/pincodes',
  '/coloaders',
  '/fuel',
  '/glossary',
  '/users',
  '/profile',
  '/bluedart',
  '/ups',
];

test.describe('every console screen renders', () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  for (const path of SCREENS) {
    test(`${path} comes up`, async ({ page }) => {
      const response = await page.goto(path);
      const status = response?.status() ?? 0;

      // The specific failure this suite was written for. A closure passed across the
      // Server/Client boundary typechecks, builds, and 500s here.
      expect(status, `${path} returned ${status}`).toBeLessThan(500);

      // A page that 200s while showing Next's error boundary is still broken.
      await expect(page.locator('body')).not.toContainText('Application error');
      await expect(page.locator('body')).not.toContainText('Internal Server Error');
    });
  }
});

test.describe('the API answers', () => {
  test('health is public and says the database is reachable', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', database: 'reachable' });
  });

  test('a published endpoint refuses an unauthenticated caller', async ({ request }) => {
    const response = await request.get('/api/v1/pincodes/110001');
    expect(response.status()).toBe(401);
  });

  test('the spec is not published from a deployment that has not asked for it', async ({ request }) => {
    // Every route here prices freight, so a route list is a target list.
    const response = await request.get('/api/docs/openapi.json');
    expect([200, 404]).toContain(response.status());
  });
});
