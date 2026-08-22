import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, cleanup, closeDb, MARK, form, expectOk, reasonFrom, PEOPLE } from './harness';
import {
  previewBill,
  runBillingAction,
  correctionOptions,
  correctInvoice,
  reopenPeriodAction,
  relockPeriodAction,
} from '../console-actions';
import { POST as shipmentsPost } from '../api/v1/shipments/route';
import { registerCustomer } from '../../data/customers';

/**
 * A bill, from shipments arriving to a numbered invoice and its correction.
 *
 * The shipments are pushed through the **published intake route** rather than inserted, so
 * this also covers the seam the core actually uses. Inserting documents directly would test
 * billing against a shape nothing produces.
 *
 * Two invariants carry the weight here. Invoice numbers are **gapless per financial year**,
 * because a missing number in a statutory series is a question from an auditor that nobody
 * can answer afterwards. And an issued invoice is **never edited** — a correction is a
 * second numbered document against it — so "fix the invoice" has to be impossible.
 */

const CODE = `${MARK}-BILL`;
const KEY = () => process.env.BOOKING_API_KEY ?? '';

/** A period safely in the past, so nothing else is competing for it. */
const FROM = '2026-04-01';
const TO = '2026-04-30';

function shipment(awb: string, total: number) {
  const taxableValue = Math.round((total / 1.18) * 100) / 100;
  return {
    awb,
    coreShipmentId: `core-${awb}`,
    customerCode: CODE,
    bookedAt: '2026-04-15T06:00:00+00:00',
    mode: 'surface' as const,
    originPincode: '411001',
    destinationPincode: '110001',
    chargeableWeight: 100,
    booked: {
      taxableValue,
      gst: Math.round((total - taxableValue) * 100) / 100,
      gstRate: 0.18,
      sac: '996812',
      rcm: false,
      total,
    },
  };
}

async function pushShipments(...items: ReturnType<typeof shipment>[]): Promise<void> {
  const response = await shipmentsPost(
    new Request('http://localhost/api/v1/shipments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY() },
      body: JSON.stringify({ shipments: items }),
    }),
  );
  const body = await response.json();
  if (response.status !== 200) {
    throw new Error(`shipment intake answered ${response.status}: ${JSON.stringify(body)}`);
  }
}

async function invoices(): Promise<Record<string, unknown>[]> {
  return (await db())
    .collection('invoices')
    .find({ customerCode: CODE })
    .sort({ number: 1 })
    .toArray() as unknown as Promise<Record<string, unknown>[]>;
}

describe('raising and correcting a bill', () => {
  beforeAll(async () => {
    if (!KEY()) throw new Error('BOOKING_API_KEY must be set to push shipments');
    await cleanup();
    await signInAs('admin', 'admin');
    await registerCustomer({
      code: CODE,
      name: `${MARK} Billing Co`,
      baseCardKey: 'model-1',
      source: 'manual',
      actor: PEOPLE.admin,
    });
    await pushShipments(
      shipment(`${MARK}-AWB-1`, 11800),
      shipment(`${MARK}-AWB-2`, 5900),
    );
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  test('a preview reports what would be billed without billing it', async () => {
    const outcome = await previewBill(CODE, FROM, TO);
    expectOk(outcome, 'the preview');

    const preview = outcome as unknown as {
      preview?: { billable?: unknown[]; held?: unknown[] };
      billable?: unknown[];
    };
    const billable = preview.preview?.billable ?? preview.billable;
    expect(billable, 'two shipments are billable').toHaveLength(2);

    expect(await invoices(), 'a preview raises nothing').toHaveLength(0);
  });

  test('running it raises invoices with gapless numbers', async () => {
    const outcome = await runBillingAction(null, form({ customerCode: CODE, from: FROM, to: TO }));
    expectOk(outcome, 'the bill run');

    const raised = await invoices();
    expect(raised.length).toBeGreaterThan(0);

    // Every number must parse as the series, and the sequence must not skip.
    const numbers = raised.map((i) => String(i.number));
    for (const number of numbers) {
      expect(number, `${number} is not in the series format`).toMatch(/^[A-Z]+\/\d{4}-\d{2}\/\d{6}$/);
    }
    const sequence = numbers.map((n) => Number(n.split('/')[2]));
    for (let i = 1; i < sequence.length; i += 1) {
      expect(sequence[i], 'the series must not skip').toBe((sequence[i - 1] ?? 0) + 1);
    }
  });

  test('running the same period again does not bill the customer twice', async () => {
    const before = await invoices();
    const outcome = await runBillingAction(null, form({ customerCode: CODE, from: FROM, to: TO }));

    // Either it refuses, or it reports nothing new — never a second set of invoices.
    const after = await invoices();
    expect(after.length, `it billed again: ${reasonFrom(outcome) || 'no reason given'}`).toBe(
      before.length,
    );
  });

  test('an issued invoice cannot be edited — a correction is a second document', async () => {
    const [first] = await invoices();
    const number = String(first?.number);

    const options = await correctionOptions(number);
    expectOk(options, 'reading the correction options');

    const outcome = await correctInvoice(
      null,
      form({ invoiceNumber: number, reason: `${MARK} agreed reduction`, delta: -500 }),
    );
    expectOk(outcome, 'the correction');

    const note = (outcome as unknown as { noteNumber?: string }).noteNumber;
    expect(note, 'a correction produces its own numbered document').toBeTruthy();

    const notes = await (await db()).collection('notes').find({ customerCode: CODE }).toArray();
    expect(notes.length).toBeGreaterThan(0);

    // And the invoice itself is untouched.
    const reread = await (await db()).collection('invoices').findOne({ number });
    expect(
      (reread as unknown as { total: number }).total,
      'the invoice total must be exactly what was issued',
    ).toBe(first?.total);
  });

  test('a correction with no reason is refused', async () => {
    const [first] = await invoices();
    const outcome = await correctInvoice(
      null,
      form({ invoiceNumber: String(first?.number), reason: '', delta: -100 }),
    );
    expect(reasonFrom(outcome)).toMatch(/why/i);
  });

  test('reopening a period needs a reason', async () => {
    const outcome = await reopenPeriodAction(null, form({ customerCode: CODE, from: FROM, reason: '' }));
    expect(reasonFrom(outcome)).toMatch(/why/i);
  });

  let billedFirst: number | undefined;

  test('a period can be reopened and relocked, and keeps what it was first billed at', async () => {
    const original = (await (await db())
      .collection('billingPeriods')
      .findOne({ customerCode: CODE })) as unknown as { asBilledPaise?: number };
    billedFirst = original?.asBilledPaise;
    expect(billedFirst, 'the period records what it was billed at').toBeDefined();

    expectOk(
      await reopenPeriodAction(
        null,
        form({ customerCode: CODE, from: FROM, reason: `${MARK} customer disputed a line` }),
      ),
      'reopening',
    );

    const period = await (await db()).collection('billingPeriods').findOne({ customerCode: CODE });
    expect((period as unknown as { state: string }).state).toBe('reopened');

    expectOk(
      await relockPeriodAction(null, form({ customerCode: CODE, from: FROM, asCorrected: 17000 })),
      'relocking',
    );

    const relocked = (await (await db())
      .collection('billingPeriods')
      .findOne({ customerCode: CODE })) as unknown as {
      state: string;
      asBilledPaise?: number;
      restatements?: unknown[];
    };
    expect(relocked.state).toBe('relocked');
    // `asBilledPaise` is what the customer was first told, and is never overwritten — a
    // restatement is recorded beside it rather than in place of it, or "the bill changed"
    // could be stated but never quantified.
    expect(
      relocked.asBilledPaise,
      'the first billed total is history and must survive a restatement',
    ).toBeDefined();
    expect(relocked.asBilledPaise).toBe(billedFirst);
    expect(relocked.restatements, 'the reopening is recorded as its own entry').toHaveLength(1);
  });

  /**
   * A blank figure is not a figure.
   *
   * `Number('')` is `0`, and zero passed the `< 0` guard — so submitting this form with the
   * amount left empty recorded the period as totalling nothing and restated the whole bill
   * as reversed. Found by this test, which originally expected the refusal and got
   * "Only a reopened period can be closed" instead: the blank had been accepted, the period
   * had already relocked at zero, and the second attempt failed on state rather than on the
   * empty field. Zero is a legitimate correction, so the raw text is checked before it is
   * coerced.
   */
  test('a blank corrected figure is refused rather than read as zero', async () => {
    expectOk(
      await reopenPeriodAction(
        null,
        form({ customerCode: CODE, from: FROM, reason: `${MARK} second look` }),
      ),
      'reopening again',
    );

    const outcome = await relockPeriodAction(
      null,
      form({ customerCode: CODE, from: FROM, asCorrected: '' }),
    );
    expect(reasonFrom(outcome), 'it must ask for the figure').toMatch(/what does the period total/i);

    const period = (await (await db())
      .collection('billingPeriods')
      .findOne({ customerCode: CODE })) as unknown as { state: string };
    expect(period.state, 'and the period stays reopened').toBe('reopened');
  });

  test('a configurator cannot raise a bill', async () => {
    await signInAs('configurator', 'configurator');
    const before = (await invoices()).length;
    let refused = false;
    try {
      const outcome = await runBillingAction(null, form({ customerCode: CODE, from: FROM, to: TO }));
      refused = Boolean(reasonFrom(outcome));
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(await invoices()).toHaveLength(before);
    await signInAs('admin', 'admin');
  });
});
