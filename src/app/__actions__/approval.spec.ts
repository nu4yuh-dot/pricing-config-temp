import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, cleanup, closeDb, MARK, form, expectOk, reasonFrom, PEOPLE } from './harness';
import { RedirectError } from './next-stubs';
import { saveContractLaneEdits, submitContractProposal, decideContractProposal } from '../console-actions';
import { registerCustomer, findCustomer, contractedCard } from '../../data/customers';
import { findPincodePair } from '../../data/pincodes';
import { quote } from '../../pricing/quote';

/**
 * The approval gate, through the actions that operate it.
 *
 * The single rule the whole design rests on is that **nothing prices from a draft**. So the
 * assertions here are about a price at three moments: before an edit, while the edit is
 * awaiting review, and after it is decided. A test that only checked the proposal document
 * would prove the paperwork moved, not that the paperwork governs the money.
 *
 * Self-approval is asserted as **permitted and recorded**, which is the live rule. It was
 * refused once and that deadlocked a single-admin setup, since `admin` is the only role
 * that may review. Four places in this repository still described the old behaviour after
 * it changed — two verification scripts, the approval screen and the roles module — which
 * is why it is pinned by a test rather than by a comment.
 */

const CODE = `${MARK}-APPROVE`;
/** PNQ→NCR: a lane the seeded cards price, so a change to it is visible in a quote. */
const LANE = { mode: 'surface' as const, origin: 'PNQ', destination: 'NCR' };
const NEGOTIATED = 300;

async function priceIt(): Promise<number> {
  const customer = await findCustomer(CODE);
  if (!customer) throw new Error(`${CODE} vanished mid-test`);
  const card = await contractedCard(customer);
  const { origin, destination } = await findPincodePair(411001, 110001);
  if (!origin || !destination) throw new Error('the probe lane is not serviceable');
  const priced = quote(
    { mode: 'surface', actualWeight: 200 },
    { origin, destination },
    card,
    undefined,
    customer.liveTerms.overrides,
    customer.liveTerms.laneRules,
  );
  if (!priced.available) throw new Error(`did not price: ${priced.reason}`);
  return priced.breakdown.total;
}

/**
 * Decide a proposal, treating the redirect as the success signal.
 *
 * `decideContractProposal` navigates away when it works, and `redirect()` is implemented by
 * throwing — `attempt()` re-throws that digest deliberately, because swallowing it would
 * break navigation while looking like a caught error. So a thrown `RedirectError` here means
 * the decision was recorded; anything else is a real failure, and a returned object is a
 * refusal carrying its reason.
 */
async function decide(id: string, fields: Record<string, string>): Promise<void> {
  try {
    const outcome = await decideContractProposal(id, form(fields));
    // No redirect means it came back with a reason instead of acting.
    throw new Error(`the decision was refused: ${reasonFrom(outcome) || JSON.stringify(outcome)}`);
  } catch (error) {
    if (error instanceof RedirectError) return;
    throw error;
  }
}

/** Submit, absorbing the same redirect. */
async function submit(): Promise<string> {
  try {
    await submitContractProposal(CODE);
  } catch (error) {
    if (error instanceof RedirectError) return error.url;
    throw error;
  }
  throw new Error('submitting did not navigate, so it did not submit');
}

async function proposalId(): Promise<string> {
  const doc = await (await db())
    .collection('contractProposals')
    .findOne({ customerCode: CODE, status: 'pending' });
  if (!doc) throw new Error('no pending proposal for this customer');
  return String((doc as unknown as { _id: { toHexString(): string } })._id.toHexString());
}

describe('a negotiated rate cannot reach a price without a decision', () => {
  let listPrice = 0;

  beforeAll(async () => {
    await cleanup();
    await signInAs('admin', 'admin');
    await registerCustomer({
      code: CODE,
      name: `${MARK} Approval Co`,
      baseCardKey: 'model-1',
      source: 'manual',
      actor: PEOPLE.admin,
    });
    listPrice = await priceIt();
    expect(listPrice).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  test('editing the draft does not change what the customer is quoted', async () => {
    expectOk(
      await saveContractLaneEdits(CODE, [{ ...LANE, rate: 'minCharge', value: NEGOTIATED }]),
      'saving the contract rate',
    );

    const customer = await findCustomer(CODE);
    const draftKeys = Object.keys(customer?.draftTerms?.overrides ?? {});
    expect(draftKeys.length, 'the edit is in the draft').toBeGreaterThan(0);
    expect(Object.keys(customer?.liveTerms.overrides ?? {}), 'and not in live terms').toHaveLength(
      0,
    );
    expect(await priceIt(), 'the price has not moved').toBe(listPrice);
  });

  test('submitting produces a proposal and still does not change the price', async () => {
    const redirected = await submit();
    expect(redirected, 'the submitter is taken to the proposal').toMatch(/\/approvals\/contract\//);

    const pending = await (await db())
      .collection('contractProposals')
      .countDocuments({ customerCode: CODE, status: 'pending' });
    expect(pending).toBe(1);
    expect(await priceIt(), 'still quoting the list price').toBe(listPrice);
  });

  test('a viewer cannot decide it', async () => {
    const id = await proposalId();
    await signInAs('viewer', 'viewer');

    let refused = false;
    try {
      const outcome = await decideContractProposal(id, form({ intent: 'approve-all' }));
      refused = Boolean(reasonFrom(outcome));
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    const still = await (await db())
      .collection('contractProposals')
      .countDocuments({ customerCode: CODE, status: 'pending' });
    expect(still, 'the proposal is untouched').toBe(1);
    expect(await priceIt()).toBe(listPrice);

    await signInAs('admin', 'admin');
  });

  /** The rule that is actually live, pinned so it cannot drift back into the old one. */
  test('the submitter may approve it, and it is recorded as self-approved', async () => {
    const id = await proposalId();
    await decide(id, { intent: 'approve-all' });

    const decided = await (await db()).collection('contractProposals').findOne({
      customerCode: CODE,
    });
    expect((decided as unknown as { status: string }).status).toBe('approved');
    expect(
      (decided as unknown as { selfApproved?: boolean }).selfApproved,
      'the same person submitted and approved, and the record has to say so',
    ).toBe(true);
  });

  test('and only now does the quote move', async () => {
    const after = await priceIt();
    expect(after).toBeLessThan(listPrice);

    const customer = await findCustomer(CODE);
    expect(
      Object.keys(customer?.liveTerms.overrides ?? {}),
      'the negotiated cell is live now',
    ).toHaveLength(1);
  });

  test('an approval by somebody else is not flagged as self-approved', async () => {
    // A second, smaller negotiation, decided by a different person.
    expectOk(
      await saveContractLaneEdits(CODE, [{ ...LANE, rate: 'minCharge', value: NEGOTIATED - 25 }]),
      'the second edit',
    );
    await submit();

    const id = await proposalId();
    await signInAs('admin2', 'admin');
    await decide(id, { intent: 'approve-all' });
    await signInAs('admin', 'admin');

    const decided = await (await db())
      .collection('contractProposals')
      .find({ customerCode: CODE })
      .sort({ submittedAt: -1 })
      .limit(1)
      .toArray();
    expect((decided[0] as unknown as { selfApproved?: boolean }).selfApproved).not.toBe(true);
  });

  test('a rejected proposal leaves live pricing alone', async () => {
    const before = await priceIt();

    expectOk(
      await saveContractLaneEdits(CODE, [{ ...LANE, rate: 'minCharge', value: 1 }]),
      'the reckless edit',
    );
    await submit();

    const id = await proposalId();
    await decide(id, { intent: 'reject-all', comment: 'Not at that rate.' });

    expect(await priceIt(), 'a rejection must not move the price').toBe(before);
  });
});
