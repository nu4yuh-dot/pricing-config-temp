import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, cleanup, closeDb, MARK, expectOk, figure } from './harness';
import { scheduleOffer, suspendOffer } from '../console-actions';
import { POST as quotesPost } from '../api/v1/quotes/route';
import { GET as networkQuotesGet } from '../api/v1/network/quotes/route';

/**
 * The seam the offers bug actually lived in.
 *
 * `offers.spec.ts` proves the action stores an offer and the engine applies one. Neither
 * fact was ever in doubt — both had passing tests while the bug was live. What was broken
 * was the *call*: `quote()` takes offers as its seventh argument and these two routes
 * passed six, so a live, matching offer changed nothing about what the core was told.
 *
 * So this calls the real exported route handlers with a real `Request`, and reads the JSON
 * the SameX core would read. No server, no mocks of anything inside — the handler, the
 * authentication, the database and the engine are all the real ones.
 *
 * It also asserts the *reported* discount, not only the reduced price. Those went wrong
 * separately: freight came down while `discountAmt` stayed hardcoded at zero, which tells a
 * caller that the lower number was the list price and leaves nobody able to explain the
 * cheaper shipment later.
 */

const CUSTOMER = 'MAHLE';
const OFFER = `${MARK} route ten percent`;
const KEY = () => process.env.BOOKING_API_KEY ?? '';

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY() },
    body: JSON.stringify(body),
  });
}

const SHIPMENT = { originPincode: '110001', destinationPincode: '400001', actualWeight: 500 };

async function quoteViaCore(): Promise<Record<string, never>> {
  const response = await quotesPost(
    jsonRequest('http://localhost/api/v1/quotes', { ...SHIPMENT, customerCode: CUSTOMER }),
  );
  const body = (await response.json()) as Record<string, never>;
  if (response.status !== 200) {
    throw new Error(`the core quote endpoint answered ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * The ECONOMY tier's breakdown — the surface network, which is what the offer discounts.
 *
 * Named `service` rather than `name`, and the figures sit in `breakdown` rather than
 * `charges`. Read off the deployed response rather than assumed, because guessing the
 * envelope is how a test ends up asserting `undefined === undefined` and passing.
 */
type Tier = { service: string; breakdown?: Record<string, number | undefined> };

function economy(body: Record<string, never>): Record<string, number | undefined> {
  const tiers = (body as unknown as { data?: { tiers?: Tier[] } }).data?.tiers;
  const tier = tiers?.find((t) => t.service === 'ECONOMY');
  if (!tier?.breakdown) throw new Error(`no ECONOMY tier in ${JSON.stringify(tiers)}`);
  return tier.breakdown;
}

describe('an offer reaches the price the core is quoted', () => {
  let before: Record<string, number | undefined>;

  beforeAll(async () => {
    if (!KEY()) throw new Error('BOOKING_API_KEY must be set to exercise the published routes');
    await cleanup();
    await signInAs('admin', 'admin');
    before = economy(await quoteViaCore());
    expect(figure(before, 'adjustedFreight')).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  test('with no offer, freight and the reported subtotal agree and nothing is discounted', () => {
    expect(figure(before, 'freightSubtotal')).toBeCloseTo(figure(before, 'adjustedFreight'), 2);
    expect(figure(before, 'discountAmt')).toBe(0);
    expect(figure(before, 'discountPct')).toBe(0);
  });

  test('POST /api/v1/quotes applies a live offer', async () => {
    expectOk(
      await scheduleOffer({
        name: OFFER,
        kind: 'percent-off-freight',
        value: 10,
        startsAt: new Date(Date.now() - 3600_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        audience: { kind: 'customer', value: CUSTOMER },
      }),
      'scheduling the offer',
    );

    const after = economy(await quoteViaCore());
    expect(figure(after, 'adjustedFreight')).toBeCloseTo(figure(before, 'adjustedFreight') * 0.9, 2);
  });

  test('and reports the discount truthfully rather than as list price', async () => {
    const after = economy(await quoteViaCore());
    // The subtotal must be what it cost *before* the offer, or the core cannot tell that a
    // discount happened at all.
    expect(figure(after, 'freightSubtotal')).toBeCloseTo(figure(before, 'adjustedFreight'), 2);
    expect(figure(after, 'discountAmt')).toBeCloseTo(figure(before, 'adjustedFreight') * 0.1, 2);
    expect(figure(after, 'discountPct')).toBeCloseTo(10, 1);
    expect(figure(after, 'freightSubtotal') - figure(after, 'discountAmt')).toBeCloseTo(
      figure(after, 'adjustedFreight'),
      2,
    );
  });

  test('and names which offer did it, so it can be explained later', async () => {
    const body = await quoteViaCore();
    const tiers = (body as unknown as {
      data: { tiers: { service: string; breakdown?: { offer?: { name: string } } }[] };
    }).data.tiers;
    const tier = tiers.find((t) => t.service === 'ECONOMY');
    expect(tier?.breakdown?.offer?.name).toBe(OFFER);
  });

  /**
   * The other caller of the same engine, on a lane that customer actually has.
   *
   * PNQ→NCR rather than the NCR→BOM used above, because this route enforces contract scope
   * and MAHLE's contract covers `surface:PNQ>NCR`. Quoting the uncovered lane answers 409
   * with an undiscounted base-price fallback, which is correct and would have made this
   * assertion look like a missing offer.
   *
   * Self-contained: it measures with the offer live, suspends it, measures again, and
   * compares the two. Reusing the baseline from the other lane would compare two different
   * prices and pass or fail for the wrong reason.
   */
  test('GET /api/v1/network/quotes applies it too', async () => {
    const url =
      `http://localhost/api/v1/network/quotes?customer=${CUSTOMER}` +
      `&mode=surface&from=411001&to=110001&weight=500`;
    const ask = async () => {
      const response = await networkQuotesGet(new Request(url, { headers: { 'x-api-key': KEY() } }));
      // 200 or 402 — the funds gate is a separate question from whether the offer applied,
      // and the price is in the body either way.
      expect([200, 402], `unexpected status for an in-contract lane`).toContain(response.status);
      const body = (await response.json()) as { breakdown?: { freight: number } };
      const freight = body.breakdown?.freight;
      expect(freight, 'the in-contract lane must price').toBeGreaterThan(0);
      return freight as number;
    };

    const discounted = await ask();

    const stored = await (await db()).collection('offers').findOne({ name: OFFER });
    const key = (stored as unknown as { key: string }).key;
    expectOk(await suspendOffer(key, false), 'suspending the offer');
    const undiscounted = await ask();
    expectOk(await suspendOffer(key, true), 'reinstating the offer');

    expect(discounted).toBeCloseTo(undiscounted * 0.9, 2);
  });
});
