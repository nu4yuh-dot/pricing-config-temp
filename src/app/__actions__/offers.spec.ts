import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, signOutCompletely, db, cleanup, closeDb, MARK, expectOk, reasonFrom } from './harness';
import { scheduleOffer, suspendOffer } from '../console-actions';
import { findCustomer, contractedCard } from '../../data/customers';
import { findPincodePair } from '../../data/pincodes';
import { offersFor } from '../../data/offers';
import { quote } from '../../pricing/quote';

/**
 * Offers, from the action that creates one to the price a customer is quoted.
 *
 * This is the flow that was reported broken, and the reason it stayed broken is worth
 * keeping in front of whoever reads this. `createOffer` had tests and they passed.
 * `applicableOffers` had tests and they passed. The `/offers` screen rendered, and saving
 * one said it had saved. But `quote()` takes offers as its **seventh** argument and two of
 * the three callers passed six — so the offer was stored, was live, matched the customer,
 * and changed nothing about what they were charged.
 *
 * No test could see it, because every test was on one side of the seam or the other. These
 * assertions deliberately span it: schedule through the real action, then price through the
 * real engine and compare rupees.
 */

const CUSTOMER = 'MAHLE';
const OFFER_NAME = `${MARK} ten percent`;

/** The same shipment throughout, so a difference in the total can only be the offer. */
async function priceIt(): Promise<{ freight: number; total: number }> {
  const customer = await findCustomer(CUSTOMER);
  if (!customer) throw new Error(`${CUSTOMER} is not seeded — run: npm run seed`);
  const card = await contractedCard(customer);
  const { origin, destination } = await findPincodePair(110001, 400001);
  if (!origin || !destination) throw new Error('the probe lane is not serviceable');

  const offers = await offersFor({
    at: new Date(),
    customerCode: CUSTOMER,
    ...(customer.tags ? { tags: customer.tags } : {}),
    ...(customer.appliedProduct ? { productKey: customer.appliedProduct.key } : {}),
  });

  const priced = quote(
    { mode: 'surface', actualWeight: 500 },
    { origin, destination },
    card,
    undefined,
    customer.liveTerms.overrides,
    customer.liveTerms.laneRules,
    offers,
  );
  if (!priced.available) throw new Error(`the probe lane did not price: ${priced.reason}`);
  return { freight: priced.breakdown.freight, total: priced.breakdown.total };
}

const window = () => {
  const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return { startsAt, endsAt };
};

describe('scheduling an offer reaches the price', () => {
  let baseline = { freight: 0, total: 0 };

  beforeAll(async () => {
    await cleanup();
    await signInAs('admin', 'admin');
    baseline = await priceIt();
    expect(baseline.freight).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  test('the action stores the offer', async () => {
    const outcome = await scheduleOffer({
      name: OFFER_NAME,
      kind: 'percent-off-freight',
      value: 10,
      ...window(),
      audience: { kind: 'customer', value: CUSTOMER },
    });
    expectOk(outcome, 'scheduling the offer');

    const stored = await (await db()).collection('offers').findOne({ name: OFFER_NAME });
    expect(stored, 'the offer is in the collection, not just in a toast').not.toBeNull();
    expect((stored as unknown as { enabled?: boolean }).enabled).toBe(true);
  });

  /** The assertion the original bug would have failed. */
  test('and it takes exactly ten percent off the freight the customer is quoted', async () => {
    const now = await priceIt();
    expect(now.freight).toBeCloseTo(baseline.freight * 0.9, 2);
    expect(now.total, 'a discounted freight must pull the total down too').toBeLessThan(
      baseline.total,
    );
  });

  test('suspending it puts the price back', async () => {
    const stored = await (await db()).collection('offers').findOne({ name: OFFER_NAME });
    const key = (stored as unknown as { key: string }).key;

    expectOk(await suspendOffer(key, false), 'suspending the offer');
    const suspended = await priceIt();
    expect(suspended.freight).toBeCloseTo(baseline.freight, 2);

    expectOk(await suspendOffer(key, true), 'reinstating the offer');
    const reinstated = await priceIt();
    expect(reinstated.freight).toBeCloseTo(baseline.freight * 0.9, 2);
  });

  test('an offer for somebody else does not touch this customer', async () => {
    const outcome = await scheduleOffer({
      name: `${MARK} not for mahle`,
      kind: 'percent-off-freight',
      value: 50,
      ...window(),
      audience: { kind: 'customer', value: 'ARAYMOND' },
    });
    expectOk(outcome, 'scheduling the other offer');

    // Still only the ten percent one, not fifty-five percent off.
    const now = await priceIt();
    expect(now.freight).toBeCloseTo(baseline.freight * 0.9, 2);
  });

  test('an expired offer is inert', async () => {
    const outcome = await scheduleOffer({
      name: `${MARK} expired`,
      kind: 'percent-off-freight',
      value: 90,
      startsAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      endsAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
      audience: { kind: 'customer', value: CUSTOMER },
    });
    expectOk(outcome, 'scheduling the expired offer');

    const now = await priceIt();
    expect(now.freight).toBeCloseTo(baseline.freight * 0.9, 2);
  });

  test('a duplicate name is refused with a reason, not swallowed', async () => {
    const outcome = await scheduleOffer({
      name: OFFER_NAME,
      kind: 'percent-off-freight',
      value: 25,
      ...window(),
      audience: { kind: 'customer', value: CUSTOMER },
    });
    expect(reasonFrom(outcome), 'the refusal has to say why').toMatch(/already exists/i);

    const count = await (await db()).collection('offers').countDocuments({ name: OFFER_NAME });
    expect(count, 'and nothing is written').toBe(1);
  });

  test('a viewer cannot schedule one', async () => {
    await signInAs('viewer', 'viewer');
    let refused = false;
    try {
      const outcome = await scheduleOffer({
        name: `${MARK} by a viewer`,
        kind: 'percent-off-freight',
        value: 5,
        ...window(),
        audience: { kind: 'customer', value: CUSTOMER },
      });
      refused = Boolean(reasonFrom(outcome));
    } catch {
      refused = true;
    }
    expect(refused, 'the capability check is the gate, not the missing button').toBe(true);

    const count = await (await db()).collection('offers').countDocuments({
      name: `${MARK} by a viewer`,
    });
    expect(count).toBe(0);
    await signInAs('admin', 'admin');
  });

  test('signed out, it does not run at all', async () => {
    signOutCompletely();
    let redirected = false;
    try {
      await scheduleOffer({
        name: `${MARK} anonymous`,
        kind: 'percent-off-freight',
        value: 5,
        ...window(),
        audience: { kind: 'customer', value: CUSTOMER },
      });
    } catch (error) {
      redirected = String((error as { digest?: string }).digest ?? '').startsWith('NEXT_REDIRECT');
    }
    expect(redirected, 'an anonymous caller is sent to sign in').toBe(true);

    const count = await (await db()).collection('offers').countDocuments({
      name: `${MARK} anonymous`,
    });
    expect(count).toBe(0);
    await signInAs('admin', 'admin');
  });
});
