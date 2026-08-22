import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, cleanup, closeDb, MARK, form, expectOk, reasonFrom, PEOPLE } from './harness';
import { rechargeWallet, payInvoice, recordReceiptAction } from '../console-actions';
import { registerCustomer } from '../../data/customers';
import { creditPosition, paise } from '../../billing/ledger';
import { commercialTerms } from '../../domain/customers';
import { findCustomer } from '../../data/customers';

/**
 * Money in: wallet recharges, invoice payments, receipts.
 *
 * Every assertion here reads the **ledger**, not the action's return value. "Recharged Rs
 * 5,000" is a string an action composes before anything is committed, and a message saying
 * money arrived is precisely the evidence that has been wrong here before. The ledger is
 * the record the business is run from, so that is what gets checked.
 *
 * The ledger is append-only and in integer paise, and both of those are load-bearing: a
 * balance is summed from entries rather than stored, so a duplicate entry is not a cosmetic
 * problem — it is money the customer did not send.
 */

const CODE = `${MARK}-MONEY`;

async function ledgerEntries(): Promise<Record<string, unknown>[]> {
  return (await db())
    .collection('ledger')
    .find({ customerCode: CODE })
    .toArray() as unknown as Promise<Record<string, unknown>[]>;
}

async function walletBalance(): Promise<number> {
  const customer = await findCustomer(CODE);
  if (!customer) throw new Error(`${CODE} vanished mid-test`);
  const terms = commercialTerms(customer.commercial);
  const entries = (await ledgerEntries()) as never;
  const position = creditPosition(
    { creditLimit: terms.creditLimit, paymentTermsDays: terms.paymentTermsDays },
    entries,
    new Date(),
  );
  return position.walletBalance;
}

describe('recording money that came in', () => {
  beforeAll(async () => {
    await cleanup();
    await signInAs('admin', 'admin');
    await registerCustomer({
      code: CODE,
      name: `${MARK} Money Co`,
      baseCardKey: 'model-1',
      source: 'manual',
      actor: PEOPLE.admin,
    });
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  test('a recharge lands in the ledger, in paise', async () => {
    const outcome = await rechargeWallet(
      null,
      form({ code: CODE, amount: 5000, reference: `${MARK}-UTR-1`, note: 'first' }),
    );
    expectOk(outcome, 'the recharge');

    const entries = await ledgerEntries();
    expect(entries).toHaveLength(1);
    // Integer paise, not rupees, and not a float.
    expect(entries[0]?.amountPaise).toBe(paise(5000));
    expect(Number.isInteger(entries[0]?.amountPaise)).toBe(true);
    expect(await walletBalance()).toBe(paise(5000));
  });

  /**
   * The same reference twice is one recharge.
   *
   * A retried form post, a double-clicked button and a replayed webhook all look like this,
   * and a second entry would credit money nobody sent. The dedup is on the natural key
   * rather than on a generated id, because the caller does not have one to offer.
   */
  test('the same reference twice does not credit twice', async () => {
    const outcome = await rechargeWallet(
      null,
      form({ code: CODE, amount: 5000, reference: `${MARK}-UTR-1`, note: 'again' }),
    );
    expectOk(outcome, 'the repeated recharge');
    expect(reasonFrom(outcome), 'and it says so rather than pretending to add').toMatch(
      /already recorded/i,
    );

    expect(await ledgerEntries()).toHaveLength(1);
    expect(await walletBalance()).toBe(paise(5000));
  });

  test('a different reference is a genuinely new recharge', async () => {
    expectOk(
      await rechargeWallet(null, form({ code: CODE, amount: 2500, reference: `${MARK}-UTR-2` })),
      'the second recharge',
    );
    expect(await ledgerEntries()).toHaveLength(2);
    expect(await walletBalance()).toBe(paise(7500));
  });

  test('a recharge with no reference is refused, and writes nothing', async () => {
    const before = (await ledgerEntries()).length;
    const outcome = await rechargeWallet(null, form({ code: CODE, amount: 999, reference: '' }));
    expect(reasonFrom(outcome)).toMatch(/reference/i);
    expect(await ledgerEntries()).toHaveLength(before);
  });

  test('zero and negative amounts are refused', async () => {
    const before = (await ledgerEntries()).length;
    for (const amount of [0, -100]) {
      const outcome = await rechargeWallet(
        null,
        form({ code: CODE, amount, reference: `${MARK}-BAD-${amount}` }),
      );
      expect(reasonFrom(outcome), `amount ${amount}`).toMatch(/greater than zero/i);
    }
    expect(await ledgerEntries()).toHaveLength(before);
  });

  test('paying an invoice that does not exist is refused with a reason', async () => {
    const outcome = await payInvoice(
      null,
      form({ code: CODE, invoice: 'DNS/2026-27/999999', amount: 100, reference: `${MARK}-PAY-1` }),
    );
    expect(reasonFrom(outcome), 'it must not silently succeed').not.toBe('');
  });

  test('a receipt is stored against the customer', async () => {
    const outcome = await recordReceiptAction(
      null,
      form({
        customerCode: CODE,
        amount: 1200,
        instrument: 'NEFT',
        note: `${MARK} receipt`,
      }),
    );
    expectOk(outcome, 'the receipt');

    const receipts = await (await db()).collection('receipts').find({ customerCode: CODE }).toArray();
    expect(receipts).toHaveLength(1);
    expect((receipts[0] as unknown as { amountPaise: number }).amountPaise).toBe(paise(1200));
  });

  test('a receipt for an unknown customer is refused', async () => {
    const outcome = await recordReceiptAction(
      null,
      form({ customerCode: `${MARK}-NOBODY`, amount: 500 }),
    );
    expect(reasonFrom(outcome)).toMatch(/no customer/i);
  });

  /**
   * `record-money` is admin-and-manager, deliberately separate from editing rates.
   *
   * A configurator can change what a shipment costs and still not be able to say a customer
   * paid — those are different kinds of authority, and the capability list keeps them apart.
   */
  test('a configurator cannot record money', async () => {
    await signInAs('configurator', 'configurator');
    const before = (await ledgerEntries()).length;

    let refused = false;
    try {
      const outcome = await rechargeWallet(
        null,
        form({ code: CODE, amount: 10_000, reference: `${MARK}-SNEAK` }),
      );
      refused = Boolean(reasonFrom(outcome)) || outcome.ok === false;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(await ledgerEntries(), 'nothing was written').toHaveLength(before);

    await signInAs('admin', 'admin');
  });

  test('a manager can, because they hold the commercial authority', async () => {
    await signInAs('admin2', 'manager');
    expectOk(
      await rechargeWallet(null, form({ code: CODE, amount: 300, reference: `${MARK}-MGR` })),
      'a manager recharge',
    );
    expect(await walletBalance()).toBe(paise(7800));
    await signInAs('admin', 'admin');
  });
});
