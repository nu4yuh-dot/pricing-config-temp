import { db, COLLECTIONS } from '../src/data/mongo';
import { assertOwnDatabase, describeTarget } from '../src/data/guard';
import {
  billingFor,
  canBook,
  raiseInvoices,
  recordEntry,
  recordPayment,
  reverseEntry,
} from '../src/data/billing';
import { rupees } from '../src/billing/ledger';
import type { BillableShipment } from '../src/billing/invoice';

/**
 * Exercise the money path against a real database.
 *
 * The unit tests prove the arithmetic in isolation; this proves the repository stores and
 * replays it correctly — that a balance survives a round trip, that a retried recharge is
 * not counted twice, and that raising the same period twice does not bill the customer
 * again.
 *
 * It works against a scratch customer code and removes its entries at the end, so no real
 * customer's ledger is touched. The append-only rule is a production invariant, not a
 * constraint on a test fixture.
 *
 *   npx tsx scripts/verify-billing.ts
 */

const CUSTOMER = 'ZZ-VERIFY';
const TERMS = { creditLimit: 50000, paymentTermsDays: 45 };
const actor = { id: '000000000000000000000012', email: 'verify@test', name: 'Verification' };

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const shipment = (over: Partial<BillableShipment> = {}): BillableShipment => ({
  reference: 'DKT-9001',
  date: new Date(),
  mode: 'air',
  origin: 'PNQ',
  destination: 'NCR',
  chargeableWeight: 200,
  taxableValue: 12200,
  gst: 2196,
  gstRate: 0.18,
  sac: '9968',
  rcm: false,
  total: 14396,
  ...over,
});

async function cleanUp(): Promise<void> {
  const database = await db();
  await database.collection(COLLECTIONS.ledger).deleteMany({ customerCode: CUSTOMER });
  await database.collection(COLLECTIONS.invoices).deleteMany({ customerCode: CUSTOMER });
}

async function main(): Promise<void> {
  console.log(describeTarget(await assertOwnDatabase('verify billing')));
  await cleanUp();

  /* ------------------------------------------------------------------ recharge */

  await recordEntry(
    { customerCode: CUSTOMER, kind: 'recharge', amount: 20000, reference: 'UTR-AAA' },
    actor,
  );
  let summary = await billingFor(CUSTOMER, TERMS);
  check('a recharge survives the round trip', rupees(summary.balancePaise) === 20000,
    `balance ₹${rupees(summary.balancePaise)}`);

  const retry = await recordEntry(
    { customerCode: CUSTOMER, kind: 'recharge', amount: 20000, reference: 'UTR-AAA' },
    actor,
  );
  summary = await billingFor(CUSTOMER, TERMS);
  check('the same reference twice is recorded once', retry.duplicate && rupees(summary.balancePaise) === 20000,
    `balance ₹${rupees(summary.balancePaise)}`);

  /* ------------------------------------------------------------------ invoices */

  const period = { from: new Date(Date.UTC(2026, 7, 1)), to: new Date(Date.UTC(2026, 7, 31)) };
  const first = await raiseInvoices(
    CUSTOMER,
    [shipment(), shipment({ reference: 'DKT-9002', mode: 'surface', sac: '9965', gstRate: 0.05, rcm: true, gst: 0, total: 4950, taxableValue: 4950 })],
    period,
    actor,
  );
  check('one invoice per mode', first.raised.length === 2,
    first.raised.map((invoice) => invoice.number).join(', '));

  const rcmInvoice = first.raised.find((invoice) => invoice.rcm);
  check('the reverse-charge invoice bills no GST', rcmInvoice?.gstPaise === 0);

  const again = await raiseInvoices(CUSTOMER, [shipment()], period, actor);
  check('raising the same period twice bills nothing again',
    again.raised.length === 0 && again.skipped.length === 1, again.skipped.join(', '));

  summary = await billingFor(CUSTOMER, TERMS);
  // 20,000 in, less the air invoice of 14,396 and the surface invoice of 4,950.
  check('invoices post to the ledger', rupees(summary.balancePaise) === 654,
    `balance ₹${rupees(summary.balancePaise)}`);

  /* ------------------------------------------------------------------ payments */

  const airInvoice = first.raised.find((invoice) => invoice.mode === 'air');
  if (airInvoice) {
    await recordPayment(CUSTOMER, airInvoice.number, 5000, 'UTR-BBB', actor);
    await recordPayment(CUSTOMER, airInvoice.number, 5000, 'UTR-CCC', actor);
    summary = await billingFor(CUSTOMER, TERMS);
    const updated = summary.invoices.find((invoice) => invoice.number === airInvoice.number);
    check('two part payments both count', updated?.status === 'part-paid' && rupees(updated.paidPaise) === 10000,
      `${updated?.status}, paid ₹${rupees(updated?.paidPaise ?? 0)}`);

    const repeat = await recordPayment(CUSTOMER, airInvoice.number, 5000, 'UTR-BBB', actor);
    check('a repeated payment reference is not counted twice', rupees(repeat.paidPaise) === 10000,
      `paid ₹${rupees(repeat.paidPaise)}`);
  }

  /* --------------------------------------------------------------- bookability */

  const allowed = await canBook(CUSTOMER, TERMS, 5000);
  check('a shipment inside the credit limit is bookable', allowed.allowed);

  const refused = await canBook(CUSTOMER, TERMS, 500000);
  check('a shipment beyond the limit is refused, with a reason',
    !refused.allowed && refused.reason === 'credit-limit-exceeded', refused.message);

  /* ----------------------------------------------------------------- reversals */

  const entries = await (await db())
    .collection<{ id: string }>(COLLECTIONS.ledger)
    .findOne({ customerCode: CUSTOMER, reference: 'UTR-AAA' });
  if (entries) {
    const before = (await billingFor(CUSTOMER, TERMS)).balancePaise;
    await reverseEntry(entries.id, 'verification', actor);
    const after = (await billingFor(CUSTOMER, TERMS)).balancePaise;
    check('a reversal takes the money back out', rupees(before - after) === 20000,
      `₹${rupees(before)} → ₹${rupees(after)}`);

    let refusedTwice = false;
    try {
      await reverseEntry(entries.id, 'again', actor);
    } catch {
      refusedTwice = true;
    }
    check('an entry cannot be reversed twice', refusedTwice);
  }

  await cleanUp();
  const left = await (await db()).collection(COLLECTIONS.ledger).countDocuments({ customerCode: CUSTOMER });
  check('the scratch customer is cleaned up', left === 0);

  console.log(failures === 0 ? '\nall billing checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
