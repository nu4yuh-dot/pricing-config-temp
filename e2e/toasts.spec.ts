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

/**
 * The controls that used to say nothing at all.
 *
 * Three surfaces called an action and discarded the result: a role select, an account
 * toggle, and the segment-tag editor. Success and failure looked identical on all three,
 * which for the tag editor meant a customer could appear tagged — and so appear eligible for
 * an offer — on the strength of a save that never happened.
 *
 * These are the assertions that stop that returning. They deliberately act on a *real*
 * control rather than a fixture, because the bug was that the wiring was missing, and a
 * fixture would have been wired correctly by whoever wrote the test.
 */
test('a segment tag says it saved, and the tag is really there', async ({ page }) => {
  await page.goto('/customers/MAHLE');

  const tag = `${MARK}-seg`;

  /**
   * Clear the tag first, rather than assuming it is absent.
   *
   * The editor's `add` returns early when the tag is already present — correctly, it is a
   * set — so a run that left the tag behind made the next run save nothing, show no toast,
   * and fail as though the wiring were broken. A test that depends on the state a previous
   * run left is the same defect I have been fixing elsewhere.
   */
  const existing = page.getByRole('button', { name: `Remove ${tag}` });
  if ((await existing.count()) > 0) {
    await existing.first().click();
    await expect(existing).toHaveCount(0, { timeout: 10_000 });
  }

  await page.fill('#segment-tag', tag);
  await page.getByRole('button', { name: /^Add$/ }).click();

  const toast = page.locator('.toast.success').first();
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toContainText(/tag/i);

  // Reloaded, so this is the stored value rather than the optimistic chip — the chip was set
  // before the save was even asked for. `.pill-list` appears five times on this page, so the
  // assertion is on the tag's own Remove control, which only exists for a tag that is there.
  await page.reload();
  await expect(page.getByRole('button', { name: `Remove ${tag}` })).toBeVisible();

  // Put it back, and check the removal is confirmed too.
  await page.getByRole('button', { name: `Remove ${tag}` }).click();
  await expect(page.locator('.toast.success').first()).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(page.getByRole('button', { name: `Remove ${tag}` })).toHaveCount(0);
});

test('changing a role is confirmed rather than assumed', async ({ page }) => {
  // Three navigations and two round trips through the action; the default 30s is tight.
  test.setTimeout(90_000);
  await page.goto('/users');

  const select = page.locator('select').first();
  await expect(select).toBeVisible();
  const before = await select.inputValue();
  const next = before === 'viewer' ? 'configurator' : 'viewer';

  await select.selectOption(next);
  const toast = page.locator('.toast').first();
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast, 'it has to name what happened').toContainText(/role/i);
  const said = (await toast.textContent()) ?? '';

  await page.reload();
  const after = await page.locator('select').first().inputValue();

  if (said.toLowerCase().includes('could not')) {
    // A refusal has to leave the control where it was, not showing the role it failed to set.
    expect(after, 'a refused change must not stick on screen').toBe(before);
    return;
  }

  expect(after, 'a confirmed change must actually be stored').toBe(next);

  // Leave the account on the role it started with.
  await page.locator('select').first().selectOption(before);
  await expect(page.locator('.toast').first()).toBeVisible({ timeout: 10_000 });
  await page.reload();
  expect(await page.locator('select').first().inputValue()).toBe(before);
});
