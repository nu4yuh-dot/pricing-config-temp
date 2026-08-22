import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, cleanup, closeDb, MARK, expectOk, reasonFrom, PEOPLE } from './harness';
import {
  createSettlementProfile,
  assignSettlementProfile,
  saveContractLaneEdits,
} from '../console-actions';
import { registerCustomer, findCustomer } from '../../data/customers';

/**
 * Settlement arrangements, and the thing that makes assigning one dangerous.
 *
 * Moving a customer between profiles **clears their settlement overrides** — the per-customer
 * deviations from the arrangement, such as a different credit limit or cycle. Not their
 * negotiated *rates*, which live in `liveTerms` and are untouched by this; I asserted the
 * wrong one first and the failure was the test's, not the code's.
 *
 * The distinction that has to hold is between a *move* and a *re-save*. Saving the same
 * profile again keeps the deviations; changing profile drops them, because a deviation is
 * measured against the arrangement it was agreed on and means nothing against a different
 * one. Getting that backwards in either direction is expensive, so both are asserted.
 */

const CODE = `${MARK}-SETTLE`;
const PROFILE_A = `${MARK.toLowerCase()}-prepaid`;
const PROFILE_B = `${MARK.toLowerCase()}-credit`;
const LANE = { mode: 'surface' as const, origin: 'PNQ', destination: 'NCR' };

/** The customer's deviations from their arrangement, and their negotiated rates. */
async function state(): Promise<{ deviations: string[]; profile?: string; rates: number }> {
  const customer = (await findCustomer(CODE)) as unknown as {
    settlement?: { profileKey?: string; overrides?: Record<string, unknown> };
    liveTerms?: { overrides?: Record<string, unknown> };
    draftTerms?: { overrides?: Record<string, unknown> };
  } | null;
  return {
    deviations: Object.keys(customer?.settlement?.overrides ?? {}),
    ...(customer?.settlement?.profileKey === undefined
      ? {}
      : { profile: customer.settlement.profileKey }),
    rates: Object.keys(customer?.draftTerms?.overrides ?? {}).length,
  };
}

describe('assigning a settlement arrangement', () => {
  beforeAll(async () => {
    await cleanup();
    await signInAs('admin', 'admin');
    await registerCustomer({
      code: CODE,
      name: `${MARK} Settle Co`,
      baseCardKey: 'model-1',
      source: 'manual',
      actor: PEOPLE.admin,
    });

    expectOk(
      await createSettlementProfile({
        key: PROFILE_A,
        name: `${MARK} Prepaid wallet`,
        mode: 'prepaid',
        cycle: 'monthly',
        onBreach: 'block',
        cancelPolicy: 'requireApproval',
        prepaid: { negativeAllowance: 0, lowBalanceAlertAt: 1000, minRecharge: 500 },
      }),
      'creating the prepaid arrangement',
    );
    expectOk(
      await createSettlementProfile({
        key: PROFILE_B,
        name: `${MARK} Credit 30`,
        mode: 'credit',
        cycle: 'monthly',
        onBreach: 'block',
        cancelPolicy: 'requireApproval',
        credit: { limit: 500000, periodDays: 30, graceDays: 5 },
      }),
      'creating the credit arrangement',
    );
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  test('both arrangements are stored', async () => {
    const profiles = await (await db())
      .collection('settlementProfiles')
      .find({ key: { $in: [PROFILE_A, PROFILE_B] } })
      .toArray();
    expect(profiles).toHaveLength(2);
  });

  test('a duplicate key is refused', async () => {
    const outcome = await createSettlementProfile({
      key: PROFILE_A,
      name: `${MARK} Prepaid again`,
      mode: 'prepaid',
      cycle: 'monthly',
      onBreach: 'block',
      cancelPolicy: 'requireApproval',
      prepaid: { negativeAllowance: 0, lowBalanceAlertAt: null, minRecharge: null },
    });
    expect(reasonFrom(outcome), 'it must say why rather than overwrite').not.toBe('');

    const count = await (await db())
      .collection('settlementProfiles')
      .countDocuments({ key: PROFILE_A });
    expect(count).toBe(1);
  });

  test('assigning one puts the customer on it', async () => {
    expectOk(await assignSettlementProfile(CODE, PROFILE_A), 'assigning the first arrangement');
    expect((await state()).profile).toBe(PROFILE_A);
  });

  test('re-saving the same arrangement keeps the deviations agreed on it', async () => {
    // A customer on the prepaid arrangement, but on a fortnightly cycle rather than monthly.
    expectOk(
      await assignSettlementProfile(CODE, PROFILE_A, { cycle: 'fortnightly' }),
      'assigning with a deviation',
    );
    expect((await state()).deviations, 'the deviation is stored').toContain('cycle');

    expectOk(await assignSettlementProfile(CODE, PROFILE_A), 're-saving the same arrangement');
    expect(
      (await state()).deviations,
      'a re-save is not a move, so the deviation survives',
    ).toContain('cycle');
  });

  test('moving to a different arrangement clears them', async () => {
    expect((await state()).deviations, 'there is something to lose').toContain('cycle');

    // A negotiated rate, to prove the move does not touch pricing.
    expectOk(
      await saveContractLaneEdits(CODE, [{ ...LANE, rate: 'minCharge', value: 275 }]),
      'negotiating a rate',
    );
    const ratesBefore = (await state()).rates;
    expect(ratesBefore).toBeGreaterThan(0);

    expectOk(await assignSettlementProfile(CODE, PROFILE_B), 'moving to the credit arrangement');

    const after = await state();
    expect(after.profile).toBe(PROFILE_B);
    expect(
      after.deviations,
      'a deviation agreed against the old arrangement must not follow the customer',
    ).toHaveLength(0);
    expect(
      after.rates,
      'and negotiated rates are a different thing entirely — the move must not touch them',
    ).toBe(ratesBefore);
  });

  /**
   * A dangling arrangement key is worse than a refusal.
   *
   * Nothing validated the key, so any string was stored. `settlementFor` returns null for a
   * key it cannot resolve and every caller then falls back to the older wallet-plus-limit
   * check — so the customer was enforced against no arrangement while their record, the
   * screen and the audit entry all named one. Silent, and permissive.
   */
  test('assigning an arrangement that does not exist is refused', async () => {
    const outcome = await assignSettlementProfile(CODE, `${MARK}-nosuch`);
    expect(reasonFrom(outcome), 'it must say the arrangement does not exist').toMatch(
      /no settlement arrangement/i,
    );
    expect((await state()).profile, 'the customer stays where they were').toBe(PROFILE_B);
  });

  test('a configurator cannot move a customer between arrangements', async () => {
    await signInAs('configurator', 'configurator');
    let refused = false;
    try {
      const outcome = await assignSettlementProfile(CODE, PROFILE_A);
      refused = Boolean(reasonFrom(outcome));
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect((await state()).profile).toBe(PROFILE_B);
    await signInAs('admin', 'admin');
  });
});
