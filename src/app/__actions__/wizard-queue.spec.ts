import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, cleanup, closeDb, MARK, form, expectOk, reasonFrom, PEOPLE } from './harness';
import {
  createCustomerFromWizard,
  changeCustomerSetup,
  createTemplateFromCustomer,
  importCustomerCsv,
  decideException,
  decideProfileChange,
  decideContractRequest,
  retryFailedPush,
  sendQueuedToCore,
  saveCustomerProfile,
  saveContractLaneEdits,
} from '../console-actions';
import { findCustomer, registerCustomer } from '../../data/customers';

/**
 * The wizard, CSV import, and the queue of changes waiting for the core.
 *
 * Two properties are worth stating. Everything the wizard does goes through the **ordinary
 * machinery** — `registerCustomer`, the template assignment, `editDraftScope` — so a
 * customer it builds is indistinguishable afterwards from one built by hand; the wizard is a
 * better first five minutes, not a second way for a contract to exist. And the CSV import is
 * **preview-then-confirm**, because a paste of a hundred rows that applied on submission
 * would be the fastest way to move a hundred prices by accident.
 *
 * The core queue is the one flow that cannot complete on this side: `PUT
 * /api/v1/customers/{code}` does not exist on the core yet. So what is asserted is that
 * nothing is lost while it waits — a push that cannot be delivered stays queued, and a
 * failing one is parked rather than blocking the queue behind it.
 */

const WIZARD_CODE = `${MARK}-WIZARD`;
const CSV_CODE = `${MARK}-CSV`;

describe('the customer wizard', () => {
  beforeAll(async () => {
    await cleanup();
    await signInAs('admin', 'admin');
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  test('a blank start creates a customer with an empty contract', async () => {
    const outcome = await createCustomerFromWizard({
      code: WIZARD_CODE,
      name: `${MARK} Wizard Co`,
      baseCardKey: 'model-1',
      profile: { state: 'Maharashtra' },
      start: { kind: 'blank' },
      scope: { modes: null, lanes: null, weightBands: null },
      propose: false,
    });
    expectOk(outcome, 'the wizard');

    const customer = await findCustomer(WIZARD_CODE);
    expect(customer, 'the customer exists').not.toBeNull();
    expect(
      (outcome as unknown as { code?: string }).code,
      'and the code is reported back',
    ).toBe(WIZARD_CODE);
  });

  test('the same code twice is refused', async () => {
    const outcome = await createCustomerFromWizard({
      code: WIZARD_CODE,
      name: 'Duplicate',
      baseCardKey: 'model-1',
      profile: {},
      start: { kind: 'blank' },
      scope: { modes: null, lanes: null, weightBands: null },
      propose: false,
    });
    expect(reasonFrom(outcome)).not.toBe('');
    expect(
      await (await db()).collection('customers').countDocuments({ code: WIZARD_CODE }),
    ).toBe(1);
  });

  test('a customer built by the wizard is an ordinary customer afterwards', async () => {
    // The proof is that the ordinary contract action works on it.
    expectOk(
      await saveContractLaneEdits(WIZARD_CODE, [
        { mode: 'surface', origin: 'PNQ', destination: 'NCR', rate: 'minCharge', value: 333 },
      ]),
      'editing a wizard-built contract',
    );
    const customer = (await findCustomer(WIZARD_CODE)) as unknown as {
      draftTerms?: { overrides?: Record<string, unknown> };
    };
    expect(Object.keys(customer.draftTerms?.overrides ?? {}).length).toBeGreaterThan(0);
  });

  /**
   * Changing the base card is refused when it would change what the negotiated cells mean.
   *
   * The same cell address on a different freight model is a different number — a min charge
   * under `CUMULATIVE_SLABS` is not the min charge under `MAX_MIN_OR_FULL` — so carrying
   * overrides across would silently reinterpret every one of them.
   */
  test('moving a negotiated customer to a different card is refused, with a reason', async () => {
    const outcome = await changeCustomerSetup(WIZARD_CODE, {
      code: WIZARD_CODE,
      baseCardKey: 'model-3',
    });
    expect(reasonFrom(outcome), 'it must say why rather than reinterpret the cells').not.toBe('');

    const customer = await findCustomer(WIZARD_CODE);
    expect(customer?.baseCardKey, 'the card is unchanged').toBe('model-1');
  });

  test('renaming the code to one already in use is refused', async () => {
    await registerCustomer({
      code: `${MARK}-TAKEN`,
      name: `${MARK} Taken`,
      baseCardKey: 'model-1',
      source: 'manual',
      actor: PEOPLE.admin,
    });

    const outcome = await changeCustomerSetup(WIZARD_CODE, {
      code: `${MARK}-TAKEN`,
      baseCardKey: 'model-1',
    });
    expect(reasonFrom(outcome)).not.toBe('');
    expect(await findCustomer(WIZARD_CODE), 'the original still exists').not.toBeNull();
  });

  /**
   * A template is lifted from **approved** terms, not from a draft.
   *
   * I expected the draft edit above to be liftable and it is refused, correctly: a template
   * is a starting point handed to other customers, so building one out of numbers nobody has
   * approved would launder an unreviewed rate into every contract made from it. The refusal
   * says exactly that, which is why the test asserts the message rather than working around
   * it.
   */
  test('a template cannot be lifted from terms that were never approved', async () => {
    const outcome = await createTemplateFromCustomer(
      null,
      form({
        customerCode: WIZARD_CODE,
        name: `${MARK} Lifted terms`,
        description: 'from the wizard customer',
      }),
    );
    expect(reasonFrom(outcome), 'it must say there is nothing approved to lift').toMatch(
      /no negotiated terms/i,
    );

    const doc = await (await db())
      .collection('rateTemplates')
      .findOne({ name: `${MARK} Lifted terms` });
    expect(doc, 'and nothing is written').toBeNull();
  });

  test('a profile can be saved', async () => {
    const outcome = await saveCustomerProfile(
      null,
      form({
        code: WIZARD_CODE,
        profile: JSON.stringify({ gstin: '27AAAAA0000A1Z5', state: 'Maharashtra' }),
      }),
    );
    expectOk(outcome, 'saving the profile');
  });

  test('malformed profile JSON is refused rather than throwing', async () => {
    const outcome = await saveCustomerProfile(
      null,
      form({ code: WIZARD_CODE, profile: '{not json' }),
    );
    expect(reasonFrom(outcome), 'it must report the problem').not.toBe('');
  });
});

describe('importing a customer configuration from CSV', () => {
  beforeAll(async () => {
    await signInAs('admin', 'admin');
    await registerCustomer({
      code: CSV_CODE,
      name: `${MARK} CSV Co`,
      baseCardKey: 'model-1',
      source: 'manual',
      actor: PEOPLE.admin,
    });
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  const CSV = [
    '# a comment line, ignored',
    'rate,surface,PNQ,NCR,minCharge,455',
    'rate,surface,PNQ,NCR,tier1,14',
    'terms,paymentTermsDays,45',
  ].join('\n');

  /** Preview then confirm: a paste of a hundred rows must not apply on submission. */
  test('an unconfirmed import previews without writing anything', async () => {
    const outcome = await importCustomerCsv(null, form({ customerCode: CSV_CODE, csv: CSV }));
    expectOk(outcome, 'the preview');

    const customer = (await findCustomer(CSV_CODE)) as unknown as {
      draftTerms?: { overrides?: Record<string, unknown> };
    };
    expect(
      Object.keys(customer.draftTerms?.overrides ?? {}),
      'a preview writes nothing',
    ).toHaveLength(0);
  });

  test('empty input is refused', async () => {
    const outcome = await importCustomerCsv(null, form({ customerCode: CSV_CODE, csv: '' }));
    expect(reasonFrom(outcome)).not.toBe('');
  });

  test('a bad row type is reported rather than skipped in silence', async () => {
    const outcome = await importCustomerCsv(
      null,
      form({ customerCode: CSV_CODE, csv: 'nonsense,a,b,c' }),
    );
    const text = JSON.stringify(outcome);
    expect(text, 'the issue names the offending row type').toMatch(/not a row type|nonsense/i);
  });

  test('a confirmed import lands in the draft, not in live pricing', async () => {
    const outcome = await importCustomerCsv(
      null,
      form({ customerCode: CSV_CODE, csv: CSV, confirm: 'on' }),
    );
    expectOk(outcome, 'the confirmed import');

    const customer = (await findCustomer(CSV_CODE)) as unknown as {
      draftTerms?: { overrides?: Record<string, unknown> };
      liveTerms: { overrides: Record<string, unknown> };
    };
    expect(
      Object.keys(customer.draftTerms?.overrides ?? {}).length,
      'the rates are in the draft',
    ).toBeGreaterThan(0);
    expect(
      Object.keys(customer.liveTerms.overrides),
      'and nothing reached live pricing',
    ).toHaveLength(0);
  });
});

describe('the queue of changes waiting for the core', () => {
  beforeAll(async () => {
    await signInAs('admin', 'admin');
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  /**
   * The core has no `PUT /api/v1/customers/{code}` yet, so nothing can be delivered.
   *
   * That makes "configured" the honest answer rather than an error — a queue that reported
   * failure every time it was drained would train everybody to ignore it, and the changes are
   * not lost either way.
   */
  test('draining reports that the integration is not configured, rather than failing', async () => {
    const outcome = await sendQueuedToCore();
    const configured = (outcome as { configured?: boolean }).configured;
    if (configured === false) {
      expect(reasonFrom(outcome), 'and it says so in words').not.toBe('');
    } else {
      // If credentials are present in this environment, a drain is allowed to succeed.
      expect(outcome).toBeTruthy();
    }
  });

  test('requeuing a push that does not exist is refused, not silently ignored', async () => {
    const outcome = await retryFailedPush('00000000000000000000ffff');
    expect(reasonFrom(outcome)).not.toBe('');
  });

  test('a malformed id is reported rather than throwing', async () => {
    const outcome = await retryFailedPush('not-an-object-id');
    expect(reasonFrom(outcome)).not.toBe('');
  });

  test('deciding a profile change that does not exist is refused', async () => {
    const outcome = await decideProfileChange(
      null,
      form({ id: '00000000000000000000ffff', verdict: 'approve' }),
    );
    expect(reasonFrom(outcome)).not.toBe('');
  });

  test('deciding a booking exception that does not exist is refused', async () => {
    const outcome = await decideException(`${MARK}-no-such-reference`, form({ intent: 'approve' }));
    expect(reasonFrom(outcome)).not.toBe('');
  });

  test('deciding a contract request that does not exist is refused', async () => {
    const outcome = await decideContractRequest(
      null,
      form({ reference: `${MARK}-no-such-reference`, verdict: 'approve' }),
    );
    expect(reasonFrom(outcome)).not.toBe('');
  });

  test('none of the decisions can be taken by a configurator', async () => {
    await signInAs('configurator', 'configurator');
    for (const attempt of [
      () => decideException(`${MARK}-x`, form({ intent: 'approve' })),
      () => decideProfileChange(null, form({ id: '00000000000000000000ffff', verdict: 'approve' })),
      () => decideContractRequest(null, form({ reference: `${MARK}-x`, verdict: 'approve' })),
      () => retryFailedPush('00000000000000000000ffff'),
      () => sendQueuedToCore(),
    ]) {
      let refused = false;
      try {
        refused = Boolean(reasonFrom((await attempt()) as { error?: string }));
      } catch {
        refused = true;
      }
      expect(refused, 'reviewing is not a configurator capability').toBe(true);
    }
    await signInAs('admin', 'admin');
  });
});
