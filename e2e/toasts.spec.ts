import { expect, test } from '@playwright/test';
import { signIn } from './session';
import { cleanup, closeDb, MARK } from './db';

/**
 * Does the screen say what happened?
 *
 * Most actions here used to call `revalidatePath` and nothing else, so a save looked exactly
 * like a no-op and silence read as success. These tests assert the confirmation is actually
 * shown — and, for the failure case, that it carries the reason rather than a shrug.
 */

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ context }) => { await signIn(context); });
test.afterAll(async () => { await cleanup(); await closeDb(); });

test('a save is confirmed, top right, below the navbar', async ({ page }) => {
  await page.goto('/offers');
  const name = `${MARK} Toast`;
  await page.fill('#of-name', name);
  await page.selectOption('#of-kind', 'percent-off-freight');
  await page.fill('#of-value', '5');
  await page.fill('#of-from', new Date().toISOString().slice(0, 10));
  await page.fill('#of-to', new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  await page.selectOption('#of-audience', 'customer');
  await page.selectOption('#of-target', 'MAHLE');
  await page.getByRole('button', { name: /schedule|save|create/i }).first().click();

  const toast = page.locator('.toast.success').first();
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toContainText(name);

  // Positioned where it was asked for: right-hand side, clear of the masthead.
  const box = (await page.locator('.toasts').boundingBox())!;
  const header = (await page.locator('header.masthead').boundingBox())!;
  expect(box.y, 'the toast overlaps the navbar').toBeGreaterThanOrEqual(header.y + header.height - 1);
  expect(box.x, 'the toast is not on the right').toBeGreaterThan(page.viewportSize()!.width / 2);
});

test('a failure explains itself and does not disappear', async ({ page }) => {
  await page.goto('/offers');
  // A duplicate name is refused by the action, with a reason worth reading.
  const name = `${MARK} Toast`;
  await page.fill('#of-name', name);
  await page.selectOption('#of-kind', 'percent-off-freight');
  await page.fill('#of-value', '5');
  await page.fill('#of-from', new Date().toISOString().slice(0, 10));
  await page.fill('#of-to', new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  await page.selectOption('#of-audience', 'customer');
  await page.selectOption('#of-target', 'MAHLE');
  await page.getByRole('button', { name: /schedule|save|create/i }).first().click();

  const error = page.locator('.toast.error').first();
  await expect(error).toBeVisible({ timeout: 10_000 });
  await expect(error, 'the failure did not say why').toContainText(/already exists/i);

  // Successes fade; the one you need to read must not.
  await page.waitForTimeout(6_000);
  await expect(error, 'an error toast vanished before it could be read').toBeVisible();

  await error.getByRole('button', { name: /dismiss/i }).click();
  await expect(error).toBeHidden();
});

test('it is announced to a screen reader, not only drawn', async ({ page }) => {
  await page.goto('/offers');
  const region = page.locator('.toasts');
  await expect(region).toHaveAttribute('role', 'status');
  await expect(region).toHaveAttribute('aria-live', 'polite');
});
