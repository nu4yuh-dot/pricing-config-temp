import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, cleanup, closeDb, MARK, form, expectOk, reasonFrom, PEOPLE } from './harness';
import {
  checkCustomerCode,
  addCustomerManually,
  saveCommercial,
  saveContractScope,
  saveContractCharges,
  saveContractLaneEdits,
  discardContractDraft,
  saveLaneRule,
  removeLaneRule,
} from '../console-actions';
import { registerCustomer, findCustomer } from '../../data/customers';
import { draftVersion } from '../../data/rate-cards';
import { commercialTerms } from '../../domain/customers';

/**
 * Customer setup, contract scope, and lane rules.
 *
 * Two things here are asserted because they are invisible from the screen. Commercial terms
 * go through the **field-by-field** merge, so saving one field cannot blank the others — a
 * partial block reaching money code is what produced a NaN credit limit and a customer
 * refused with "exceeds the credit limit by ₹NaN". And a lane rule lives at **no grid
 * address**, so it needs its own place in the draft and its own diff; a rule that saved
 * without appearing in a review would be a rate change with no approval line.
 */

const CODE = `${MARK}-SETUP`;
const CARD = 'model-2';
const RULE_ID = `r_${MARK.toLowerCase()}`;

async function draftRuleIds(): Promise<string[]> {
  const draft = await draftVersion(CARD);
  const rules = (draft.data as unknown as { laneRules?: Record<string, unknown> }).laneRules ?? {};
  return Object.keys(rules);
}

describe('adding a customer and checking a code', () => {
  beforeAll(async () => {
    await cleanup();
    await signInAs('admin', 'admin');
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  test('an empty code is not available, and says why', async () => {
    const answer = await checkCustomerCode('   ');
    expect(answer.available).toBe(false);
    expect(answer.reason).toMatch(/required/i);
  });

  test('an unused code is available', async () => {
    expect((await checkCustomerCode(`${MARK}-UNUSED`)).available).toBe(true);
  });

  test('adding a customer needs a code and a name', async () => {
    expect(reasonFrom(await addCustomerManually(null, form({ code: '', name: 'x' })))).toMatch(
      /code and a name/i,
    );
    expect(reasonFrom(await addCustomerManually(null, form({ code: 'X', name: '' })))).toMatch(
      /code and a name/i,
    );
  });

  test('a customer is created, and the code is then taken', async () => {
    expectOk(
      await addCustomerManually(
        null,
        form({ code: CODE, name: `${MARK} Setup Co`, baseCardKey: 'model-1' }),
      ),
      'adding the customer',
    );
    expect(await findCustomer(CODE), 'the customer exists').not.toBeNull();

    const answer = await checkCustomerCode(CODE);
    expect(answer.available, 'the code is no longer free').toBe(false);
  });

  test('adding the same code again is refused, not duplicated', async () => {
    const outcome = await addCustomerManually(
      null,
      form({ code: CODE, name: 'Duplicate', baseCardKey: 'model-1' }),
    );
    expect(reasonFrom(outcome)).toMatch(/already exists/i);
    expect(
      await (await db()).collection('customers').countDocuments({ code: CODE }),
      'still one customer',
    ).toBe(1);
  });
});

describe('commercial terms', () => {
  beforeAll(async () => {
    await signInAs('admin', 'admin');
    await registerCustomer({
      code: CODE,
      name: `${MARK} Setup Co`,
      baseCardKey: 'model-1',
      source: 'manual',
      actor: PEOPLE.admin,
    });
  });

  test('a credit limit is stored as a number', async () => {
    expectOk(
      await saveCommercial(
        null,
        form({ code: CODE, creditLimit: 250000, paymentTermsDays: 45, gstApplicable: 'on', billingType: 'FORWARD' }),
      ),
      'saving commercial terms',
    );

    const customer = await findCustomer(CODE);
    const terms = commercialTerms(customer?.commercial);
    expect(terms.creditLimit).toBe(250000);
    expect(terms.paymentTermsDays).toBe(45);
  });

  /**
   * A blank credit limit means **no facility**, which is not the same as unlimited and not
   * the same as zero. It has to survive as `null` rather than becoming a number.
   */
  test('a blank credit limit becomes no facility, not a number', async () => {
    expectOk(
      await saveCommercial(
        null,
        form({ code: CODE, creditLimit: '', paymentTermsDays: 30, gstApplicable: 'on', billingType: 'FORWARD' }),
      ),
      'saving with no credit limit',
    );

    const customer = await findCustomer(CODE);
    const terms = commercialTerms(customer?.commercial);
    expect(terms.creditLimit, 'no facility is null').toBeNull();
    expect(Number.isNaN(terms.creditLimit as unknown as number), 'and never NaN').toBe(false);
  });

  /** Every field must survive a save, or money code reads undefined behind a type. */
  test('the stored block is complete, whatever was submitted', async () => {
    const customer = await findCustomer(CODE);
    const stored = (customer?.commercial ?? {}) as Record<string, unknown>;
    for (const field of ['billingType', 'gstApplicable', 'paymentTermsDays', 'creditLimit']) {
      expect(field in stored, `${field} is missing from the stored block`).toBe(true);
    }
  });

  test('gstApplicable false survives, rather than defaulting back to true', async () => {
    expectOk(
      await saveCommercial(
        null,
        form({ code: CODE, creditLimit: 1000, paymentTermsDays: 30, billingType: 'FORWARD' }),
      ),
      'saving with GST off',
    );
    const customer = await findCustomer(CODE);
    expect(commercialTerms(customer?.commercial).gstApplicable).toBe(false);
  });
});

describe('contract scope and drafts', () => {
  beforeAll(async () => {
    await signInAs('admin', 'admin');
  });

  test('a scope can be narrowed and read back', async () => {
    expectOk(
      await saveContractScope(CODE, {
        modes: ['surface'],
        lanes: ['surface:PNQ>NCR'],
        weightBands: null,
      }),
      'saving the scope',
    );

    const customer = await findCustomer(CODE);
    const scope = (customer as unknown as {
      draftTerms?: { scope?: { modes?: string[] | null; lanes?: string[] | null } };
    }).draftTerms?.scope;
    expect(scope?.modes, 'the scope is in the draft').toEqual(['surface']);
    expect(scope?.lanes).toEqual(['surface:PNQ>NCR']);
  });

  test('a negotiated charge is stored like any other override', async () => {
    expectOk(
      await saveContractCharges(CODE, [{ bind: 'charges.fuelSurface', value: 0.12 }]),
      'negotiating a charge',
    );
    const customer = (await findCustomer(CODE)) as unknown as {
      draftTerms?: { overrides?: Record<string, unknown> };
    };
    expect(customer.draftTerms?.overrides).toHaveProperty('charges.fuelSurface', 0.12);
  });

  test('discarding the draft contract clears what was not approved', async () => {
    expectOk(
      await saveContractLaneEdits(CODE, [
        { mode: 'surface', origin: 'PNQ', destination: 'NCR', rate: 'minCharge', value: 260 },
      ]),
      'an edit to discard',
    );
    expect(
      Object.keys(
        ((await findCustomer(CODE)) as unknown as { draftTerms?: { overrides?: object } })
          .draftTerms?.overrides ?? {},
      ).length,
    ).toBeGreaterThan(0);

    expectOk(await discardContractDraft(CODE), 'discarding');

    const after = (await findCustomer(CODE)) as unknown as {
      draftTerms?: { overrides?: object };
      liveTerms: { overrides: object };
    };
    expect(
      Object.keys(after.draftTerms?.overrides ?? {}),
      'the draft is back to the live terms',
    ).toHaveLength(Object.keys(after.liveTerms.overrides).length);
  });

  test('a viewer cannot change a scope', async () => {
    await signInAs('viewer', 'viewer');
    let refused = false;
    try {
      refused = Boolean(
        reasonFrom(
          await saveContractScope(CODE, { modes: null, lanes: null, weightBands: null }),
        ),
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    await signInAs('admin', 'admin');
  });
});

describe('lane rules', () => {
  beforeAll(async () => {
    await signInAs('admin', 'admin');
  });

  afterAll(async () => {
    // Leave the card as it was found: the rule lives in the draft, so removing it is enough.
    await signInAs('admin', 'admin');
    await removeLaneRule(CARD, RULE_ID).catch(() => {});
    await cleanup();
    await closeDb();
  });

  /**
   * A rule has no grid address, which is exactly why it needs its own storage and its own
   * diff — a rate that changed without appearing in a review is the failure the whole
   * approval design exists to prevent.
   */
  test('a rule is saved into the draft', async () => {
    expectOk(
      await saveLaneRule(CARD, {
        id: RULE_ID,
        mode: 'surface',
        origin: { kind: 'city', value: 'Pune' },
        destination: { kind: 'zone', value: 'NCR' },
        rates: { minCharge: 500, tier1: 12, tier2: null, tier3: null },
      }),
      'saving the lane rule',
    );

    expect(await draftRuleIds(), 'the rule is in the draft').toContain(RULE_ID);
  });

  test('saving it again edits rather than duplicating', async () => {
    expectOk(
      await saveLaneRule(CARD, {
        id: RULE_ID,
        mode: 'surface',
        origin: { kind: 'city', value: 'Pune' },
        destination: { kind: 'zone', value: 'NCR' },
        rates: { minCharge: 550, tier1: 12, tier2: null, tier3: null },
      }),
      'editing the lane rule',
    );

    const ids = await draftRuleIds();
    expect(ids.filter((id) => id === RULE_ID), 'one rule, not two').toHaveLength(1);

    const draft = await draftVersion(CARD);
    const rules = (draft.data as unknown as {
      laneRules: Record<string, { rates: { minCharge: number } }>;
    }).laneRules;
    expect(rules[RULE_ID]?.rates.minCharge).toBe(550);
  });

  test('a rule can be removed', async () => {
    expectOk(await removeLaneRule(CARD, RULE_ID), 'removing the lane rule');
    expect(await draftRuleIds()).not.toContain(RULE_ID);
  });

  test('a viewer cannot save one', async () => {
    await signInAs('viewer', 'viewer');
    let refused = false;
    try {
      refused = Boolean(
        reasonFrom(
          await saveLaneRule(CARD, {
            id: `${RULE_ID}-v`,
            mode: 'surface',
            origin: { kind: 'any' },
            destination: { kind: 'any' },
            rates: { minCharge: 1, tier1: 1, tier2: null, tier3: null },
          }),
        ),
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(await draftRuleIds()).not.toContain(`${RULE_ID}-v`);
    await signInAs('admin', 'admin');
  });
});
