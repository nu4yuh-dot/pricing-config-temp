import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  signInAs, signOutCompletely, db, cleanup, closeDb, MARK, expectOk, reasonFrom,
  snapshotCard, restoreCard, type CardSnapshot,
} from './harness';
import { RedirectError } from './next-stubs';
import {
  searchGeographyAction,
  coverageAction,
  previewRuleAction,
  testShipmentAction,
  quoteUpsAction,
  createLibraryCharge,
  saveLaneRule,
  removeLaneRule,
} from '../console-actions';
import { signOut, saveDraftEdits } from '../actions';
import { draftVersion } from '../../data/rate-cards';

/**
 * The read-only actions, and the two writes left over.
 *
 * These answer questions rather than change anything, which makes them easy to leave
 * untested and easy to break quietly: a lane-rule preview that returned an empty list would
 * look like "this rule affects nothing" rather than like a fault, and somebody would save the
 * rule believing it was harmless. So each one is asserted to return **substance** — a
 * non-empty result for an input that must match something — rather than merely to not throw.
 *
 * They are gated on `view-sheets`, the weakest capability, which every role including a
 * viewer holds. That is correct and worth pinning: a viewer is meant to be able to look.
 */

const CARD = 'model-2';
const RULE_ID = `r_${MARK.toLowerCase()}q`;

describe('geography and coverage queries', () => {
  beforeAll(async () => {
    await signInAs('admin', 'admin');
  });

  afterAll(async () => {
    await closeDb();
  });

  test('searching geography finds a real city', async () => {
    const results = await searchGeographyAction('Pune', 'surface');
    expect(results.length, 'Pune must match something').toBeGreaterThan(0);
    expect(
      results.some((r) => JSON.stringify(r).toLowerCase().includes('pune')),
      'and the matches must mention it',
    ).toBe(true);
  });

  test('a query that matches nothing returns an empty list rather than throwing', async () => {
    const results = await searchGeographyAction(`${MARK}-nowhere-at-all`, 'surface');
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  test('coverage for a zone reports pincodes behind it', async () => {
    const summary = await coverageAction({ kind: 'zone', value: 'NCR' }, 'surface');
    expect(summary, 'a zone that exists must summarise to something').toBeTruthy();
    const counted = JSON.stringify(summary);
    expect(counted, 'and the summary carries numbers').toMatch(/\d/);
  });

  test('a viewer may run both — looking is what the role is for', async () => {
    await signInAs('viewer', 'viewer');
    expect((await searchGeographyAction('Mumbai', 'surface')).length).toBeGreaterThan(0);
    expect(await coverageAction({ kind: 'zone', value: 'BOM' }, 'surface')).toBeTruthy();
    await signInAs('admin', 'admin');
  });

  test('signed out, they do not run', async () => {
    signOutCompletely();
    let redirected = false;
    try {
      await searchGeographyAction('Pune', 'surface');
    } catch (error) {
      redirected = String((error as { digest?: string }).digest ?? '').startsWith('NEXT_REDIRECT');
    }
    expect(redirected).toBe(true);
    await signInAs('admin', 'admin');
  });
});

describe('previewing a lane rule before saving it', () => {
  let card: CardSnapshot | null = null;

  beforeAll(async () => {
    await signInAs('admin', 'admin');
    card = await snapshotCard(CARD);
  });

  afterAll(async () => {
    await removeLaneRule(CARD, RULE_ID).catch(() => {});
    await restoreCard(card);
    await closeDb();
  });

  /**
   * The preview is the whole safety mechanism for a zone-shaped rule.
   *
   * A rule at zone level can move hundreds of lanes at once, and the numbers it would change
   * are not visible anywhere else before it is saved. An empty preview reads as "this is
   * harmless", so returning nothing when something would change is the dangerous failure —
   * which is why this asserts rows come back rather than that the call succeeded.
   */
  test('a zone-level rule previews the lanes it would change', async () => {
    const rows = await previewRuleAction(
      CARD,
      'surface',
      { kind: 'zone', value: 'PNQ' },
      { kind: 'zone', value: 'NCR' },
      { minCharge: 999, tier1: 25, tier2: null, tier3: null },
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length, 'a zone-to-zone rule must affect at least one lane').toBeGreaterThan(0);
  });

  test('resolving a real shipment says which rule won', async () => {
    expectOk(
      await saveLaneRule(CARD, {
        id: RULE_ID,
        mode: 'surface',
        origin: { kind: 'zone', value: 'PNQ' },
        destination: { kind: 'zone', value: 'NCR' },
        rates: { minCharge: 777, tier1: 20, tier2: null, tier3: null },
      }),
      'saving a rule to resolve against',
    );

    const answer = await testShipmentAction(CARD, 'surface', 411001, 110001);
    expect(answer.ok, `resolution failed: ${'message' in answer ? answer.message : ''}`).toBe(true);
    if (answer.ok) {
      expect(answer.steps.length, 'the trace explains itself step by step').toBeGreaterThan(0);
      // `winner` is a description for a person — "PNQ → NCR · zone → zone · base" — rather
      // than the rule id. That is the right choice for a screen whose job is to explain which
      // rule applied and why, and it is asserted as such rather than reshaped to suit a test.
      expect(answer.winner, 'something has to win').not.toBeNull();
      expect(String(answer.winner), 'and it says how the match was made').toMatch(/zone/i);
      expect(answer.rate, 'and the rate it applied').not.toBeNull();
    }
  });

  test('an unserviceable pincode is reported, not thrown', async () => {
    const answer = await testShipmentAction(CARD, 'surface', 999999, 110001);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.message, 'it says which end is the problem').not.toBe('');
  });

  test('the rate follows the rule, and changes when it is removed', async () => {
    const withRule = await testShipmentAction(CARD, 'surface', 411001, 110001);
    expectOk(await removeLaneRule(CARD, RULE_ID), 'removing the rule');
    const without = await testShipmentAction(CARD, 'surface', 411001, 110001);

    expect(withRule.ok && without.ok).toBe(true);
    if (withRule.ok && without.ok) {
      // The rule set minCharge 777 against whatever the base grid says, so removing it has
      // to change the answer. Comparing the rate rather than the winner's wording keeps this
      // assertion about behaviour instead of about a label.
      expect(without.rate, 'the removed rule cannot still be pricing').not.toBe(withRule.rate);
    }
  });
});

describe('the UPS export quote', () => {
  beforeAll(async () => {
    await signInAs('admin', 'admin');
  });

  afterAll(async () => {
    await closeDb();
  });

  test('a served country prices', async () => {
    const result = await quoteUpsAction({
      product: 'express' as never,
      countryCode: 'US',
      actualWeight: 10,
    });
    expect(result, 'a served country must return a result').toBeTruthy();
    expect(JSON.stringify(result), 'and it carries figures').toMatch(/\d/);
  });

  /**
   * The card is keyed by **UPS's own country codes**, not ISO 3166.
   *
   * `ZZ` is Tortola, `SW` is Sweden, `B1` and `H1` price from the card's Germany column. I
   * took `ZZ` for an obviously invalid code and expected a refusal; it is a real destination
   * and priced correctly. The ISO codes for the same countries are on the card too, so a
   * caller sending ISO resolves fine — which is what makes this safe rather than a trap.
   */
  test('a UPS-scheme country code prices, because it is a real destination', async () => {
    const result = await quoteUpsAction({
      product: 'express' as never,
      countryCode: 'ZZ',
      actualWeight: 10,
    });
    expect((result as { available?: boolean }).available, 'ZZ is Tortola').toBe(true);
  });

  test('a code on no chart at all is refused with a reason', async () => {
    const result = await quoteUpsAction({
      product: 'express' as never,
      countryCode: 'QQ',
      actualWeight: 10,
    });
    expect((result as { available?: boolean }).available).toBe(false);
    expect((result as { reason?: string }).reason).toBe('unknown-country');
    expect((result as { message?: string }).message, 'and it explains itself').not.toBe('');
  });

  test('the ISO code for a UPS-aliased country resolves too', async () => {
    // SE (Sweden) as well as the card's own SW — a caller sending ISO must not fall through.
    for (const iso of ['SE', 'FI', 'PT', 'ES', 'TR']) {
      const result = await quoteUpsAction({
        product: 'express' as never,
        countryCode: iso,
        actualWeight: 10,
      });
      expect(
        (result as { available?: boolean }).available,
        `${iso} is an ISO code the core would send`,
      ).toBe(true);
    }
  });
});

describe('the two remaining writes', () => {
  /**
   * Both of these write cells into model-2's draft, and a cell in an existing card carries
   * no fixture marker — so `cleanup` cannot find it. The charge library is derived from what
   * every card's draft declares, which means one leftover probe charge appears on a real
   * screen indefinitely. Snapshot and put it back.
   */
  let card: CardSnapshot | null = null;

  beforeAll(async () => {
    await signInAs('admin', 'admin');
    card = await snapshotCard(CARD);
  });

  afterAll(async () => {
    await restoreCard(card);
    await cleanup();
    await closeDb();
  });

  test('a charge added to the library lands in the draft', async () => {
    const id = `${MARK.toLowerCase()}chg`;
    expectOk(
      await createLibraryCharge(CARD, {
        id,
        name: `${MARK} Handling`,
        basis: 'perShipment',
        gstApplies: true,
        fuelApplies: false,
        bookableOneOff: true,
      }),
      'adding the charge',
    );

    const draft = await draftVersion(CARD);
    const catalog = (draft.data as unknown as {
      chargeCatalog?: Record<string, { name?: string }>;
    }).chargeCatalog ?? {};
    expect(catalog[id]?.name, 'the charge is in the draft catalogue').toBe(`${MARK} Handling`);
  });

  test('saveDraftEdits writes cells like the console does', async () => {
    await saveDraftEdits(CARD, [{ bind: 'charges.docketFee', value: 77 }]);
    const draft = await draftVersion(CARD);
    const charges = (draft.data as unknown as { charges: Record<string, unknown> }).charges;
    expect(charges.docketFee).toBe(77);
  });

  test('a viewer cannot use either', async () => {
    await signInAs('viewer', 'viewer');
    for (const attempt of [
      () =>
        createLibraryCharge(CARD, {
          id: 'nope',
          name: 'Nope',
          basis: 'perShipment',
          gstApplies: false,
          fuelApplies: false,
          bookableOneOff: false,
        }),
      () => saveDraftEdits(CARD, [{ bind: 'charges.docketFee', value: 1 }]),
    ]) {
      let refused = false;
      try {
        refused = Boolean(reasonFrom((await attempt()) as { error?: string } ?? {}));
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    }
    await signInAs('admin', 'admin');
  });

  test('signing out destroys the session and sends you to login', async () => {
    let landedOn = '';
    try {
      await signOut();
    } catch (error) {
      if (!(error instanceof RedirectError)) throw error;
      landedOn = error.url;
    }
    expect(landedOn).toBe('/login');
    await signInAs('admin', 'admin');
  });
});
