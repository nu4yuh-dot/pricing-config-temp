import { expect, test } from '@playwright/test';
import { signIn } from './session';
import { db, cleanup, closeDb, MARK } from './db';

/**
 * Does the screen actually do the thing?
 *
 * The unit suite tests pure functions and the screens suite proves pages render. Neither
 * touches the layer between them — the server action a button calls — and that glue is where
 * every defect found in this project has lived: an offer never passed to the engine, a
 * closure that cannot cross the Server/Client boundary, actions with no caller at all.
 *
 * So each test here drives the real control and then reads the database. Not the toast, not
 * the re-render: the row.
 */

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => { await signIn(context); });
test.afterAll(async () => { await cleanup(); await closeDb(); });

test('an offer created on the screen is stored, is live, and discounts a price', async ({ page, request }) => {
  await page.goto('/offers');
  const name = `${MARK} Festival`;

  // Every field the form requires before it will let itself be submitted.
  await page.fill('#of-name', name);
  await page.selectOption('#of-kind', 'percent-off-freight');
  await page.fill('#of-value', '10');
  await page.fill('#of-from', new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
  await page.fill('#of-to', new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  await page.selectOption('#of-audience', 'customer');
  await page.selectOption('#of-target', 'MAHLE');

  await page.getByRole('button', { name: /schedule|save|create/i }).first().click();

  await expect
    .poll(async () => (await db()).collection('offers').countDocuments({ name }), { timeout: 10_000 })
    .toBe(1);

  const stored = await (await db()).collection('offers').findOne({ name });
  expect(stored!.enabled, 'a new offer should be live, not created switched off').toBe(true);

  /**
   * The part that was broken. An offer that is stored but never reaches the engine is the
   * exact defect this suite exists for: the screen said a discount was live and every price
   * disagreed.
   */
  const quote = async (customerCode: string) => {
    const r = await request.post('/api/v1/quotes', {
      headers: { 'x-api-key': process.env.BOOKING_API_KEY ?? 'e2e-booking-api-key-long-enough-32ch' },
      data: { originPincode: 110001, destinationPincode: 400001, actualWeight: 500, customerCode },
    });
    return (await r.json()).data.tiers[0].breakdown;
  };

  const discounted = await quote('MAHLE');
  expect(discounted.discountAmt, 'the offer did not reach the price').toBeGreaterThan(0);
  expect(discounted.adjustedFreight).toBeLessThan(discounted.freightSubtotal);
  expect(discounted.offer?.name).toBe(name);

  // And it must not leak to a customer it was not aimed at.
  const other = await quote('ARAYMOND');
  expect(other.discountAmt, 'an offer aimed at one customer reached another').toBe(0);
});

test('a carrier created on the screen is stored, and can be deactivated', async ({ page }) => {
  await page.goto('/carriers');
  const name = `${MARK} Carrier`;
  await page.fill('#c-id', 'e2eprobe-car');
  await page.fill('#c-name', name);
  await page.selectOption('#c-structure', 'zoneWeight');
  await page.getByRole('button', { name: /save|add|create/i }).first().click();

  await expect
    .poll(async () => (await db()).collection('carriers').countDocuments({ name }), { timeout: 10_000 })
    .toBe(1);
  expect((await (await db()).collection('carriers').findOne({ name }))!.active).toBe(true);

  // The row action that was passing a plain closure and 500ing the page not long ago.
  await page.goto('/carriers');
  const row = page.locator('tr', { hasText: name });
  await row.getByRole('button', { name: /deactivate/i }).click();
  await row.getByRole('button', { name: /deactivate/i }).click();

  await expect
    .poll(async () => (await (await db()).collection('carriers').findOne({ name }))?.active, { timeout: 10_000 })
    .toBe(false);
});

test('a service created on the screen becomes a quotable tier', async ({ page, request }) => {
  await page.goto('/services');
  const name = `${MARK} Express`;
  await page.fill('#s-key', 'e2eprobe-exp');
  await page.fill('#s-name', name);
  await page.selectOption('#s-mode', 'surface');
  await page.fill('#s-mult', '1.5');
  await page.getByRole('button', { name: /save|add|create/i }).first().click();

  await expect
    .poll(async () => (await db()).collection('services').countDocuments({ name }), { timeout: 10_000 })
    .toBe(1);

  /**
   * The effect, not the row. A service that exists but is not offered is the same class of
   * defect as an offer that never reaches the engine.
   */
  const r = await request.post('/api/v1/quotes', {
    headers: { 'x-api-key': process.env.BOOKING_API_KEY ?? 'e2e-booking-api-key-long-enough-32ch' },
    data: { originPincode: 110001, destinationPincode: 400001, actualWeight: 500 },
  });
  const tiers = (await r.json()).data.tiers as { service: string; breakdown: { serviceMult: number } }[];
  const mine = tiers.find((t) => t.service === 'E2EPROBE-EXP');
  expect(mine, `configured service missing from tiers: ${tiers.map((t) => t.service).join(', ')}`).toBeTruthy();
  expect(mine!.breakdown.serviceMult, 'the multiplier did not reach the price').toBe(1.5);
});
