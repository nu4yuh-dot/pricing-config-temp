/**
 * Exercise the whole customer-contract and booking flow against a running server
 * and a real database.
 *
 *   npx tsx scripts/verify-contracts.ts [--base http://127.0.0.1:3000]
 *
 * Covers: registration from the booking site, quoting a customer with no contract,
 * negotiating rates, the approval gate, sparse storage, contract scope blocking a
 * booking, the base-price fallback, and the exception approval that unblocks it.
 *
 * Cleans up the customer it creates.
 */

import { ObjectId } from 'mongodb';
import { db, COLLECTIONS } from '../src/data/mongo';
import { assertOwnDatabase, describeTarget } from '../src/data/guard';
import {
  registerCustomer,
  findCustomer,
  editDraftContract,
  editDraftScope,
  proposeContract,
  reviewProposal,
  createBookingException,
  decideBookingException,
  contractedCard,
} from '../src/data/customers';
import { laneKey } from '../src/domain/customers';

const base = (() => {
  const i = process.argv.indexOf('--base');
  return i > -1 ? (process.argv[i + 1] as string) : 'http://127.0.0.1:3000';
})();

const apiKey = process.env.BOOKING_API_KEY;
if (!apiKey) throw new Error('BOOKING_API_KEY must be set.');

const CODE = 'VERIFYCO';
const editor = { id: '000000000000000000000021', email: 'e@test', name: 'Test Editor' };
const admin = { id: '000000000000000000000022', email: 'a@test', name: 'Test Admin' };

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

async function cleanup(): Promise<void> {
  const database = await db();
  await database.collection(COLLECTIONS.customers).deleteMany({ code: CODE });
  await database.collection(COLLECTIONS.contractProposals).deleteMany({ customerCode: CODE });
  await database.collection(COLLECTIONS.bookingExceptions).deleteMany({ customerCode: CODE });
}

async function main(): Promise<void> {
  console.log(describeTarget(await assertOwnDatabase('run contract verification')));
  await cleanup();

  /* ------------------------------------------------------------ api security */

  const noKey = await fetch(`${base}/api/customers`, { method: 'GET' });
  check('the API rejects a request with no key', noKey.status === 401, `got ${noKey.status}`);

  const wrongKey = await fetch(`${base}/api/customers`, { headers: { 'x-api-key': 'nope' } });
  check('the API rejects a wrong key', wrongKey.status === 401, `got ${wrongKey.status}`);

  /* ------------------------------------------------ registration from the site */

  const created = await api('/api/customers', {
    method: 'POST',
    body: JSON.stringify({ code: CODE, name: 'Verify Co', baseCardKey: 'model-1' }),
  });
  const createdBody = await created.json();
  check('the booking site can register a customer', created.status === 201, `got ${created.status}`);
  check('a new customer starts with nothing negotiated', createdBody.customer?.negotiatedCells === 0);
  check('a new customer starts unrestricted', createdBody.customer?.contractRestricted === false);

  const again = await api('/api/customers', {
    method: 'POST',
    body: JSON.stringify({ code: CODE, name: 'Verify Co' }),
  });
  const againBody = await again.json();
  check('registering twice is idempotent', again.status === 200 && againBody.created === false);

  /* -------------------------------------------- quoting before any negotiation */

  const q1 = await api(
    `/api/quote?customer=${CODE}&mode=surface&from=411001&to=110001&weight=200`,
  );
  const q1Body = await q1.json();
  /**
   * 200 or 402, and both are a successful quote.
   *
   * A brand-new customer has no wallet and no credit facility, and the funds gate answers
   * 402 — "the price is right but the money is not". The price is in the body either way,
   * which is what this check is about; whether it can be *booked* is asserted separately.
   * Pinning this to 200 asserted the absence of a credit check rather than the presence of
   * a price.
   */
  check(
    'a customer with no contract quotes at standard prices',
    q1.status === 200 || q1.status === 402,
    `HTTP ${q1.status}`,
  );
  check(
    'a customer with no funds is priced but not bookable',
    q1.status !== 402 || q1Body.bookable === false,
  );
  check(
    'and that price is the known base total',
    q1Body.breakdown?.total === 5197.5,
    String(q1Body.breakdown?.total),
  );
  check('the response says it is contract pricing', q1Body.pricing === 'contract');

  /* ------------------------------------------------------- negotiate two rates */

  await editDraftContract(
    CODE,
    [
      { bind: 'grids.surface.minCharge.PNQ.NCR', value: 450 },
      { bind: 'grids.surface.tier2.PNQ.NCR', value: 12 },
    ],
    editor,
  );
  await editDraftScope(
    CODE,
    { modes: ['surface'], lanes: [laneKey('surface', 'PNQ', 'NCR')], weightBands: null },
    editor,
  );

  const q2 = await api(
    `/api/quote?customer=${CODE}&mode=surface&from=411001&to=110001&weight=200`,
  );
  const q2Body = await q2.json();
  check(
    'an unapproved negotiation does NOT change the quote',
    q2Body.breakdown?.total === 5197.5,
    String(q2Body.breakdown?.total),
  );

  /* ------------------------------------------------------------ approval gate */

  const proposal = await proposeContract(CODE, editor);
  check('proposing produces a reviewable proposal', proposal.changes.length === 2);
  check(
    'the proposal is labelled for a human',
    proposal.changes.some((c) => c.label === 'Surface Rates · min charge · PNQ→NCR'),
  );
  check('coverage changes are recorded separately', proposal.scopeChanges.length === 2);

  // The draft is frozen while a proposal is pending, so the thing under review cannot be
  // edited out from under the reviewer. Checked before any decision is taken.
  let frozenEditRefused = false;
  try {
    await editDraftContract(CODE, [{ bind: 'grids.surface.tier1.PNQ.NCR', value: 1 }], editor);
  } catch {
    frozenEditRefused = true;
  }
  check('a contract awaiting approval is frozen', frozenEditRefused);

  const decided = await reviewProposal(proposal._id.toHexString(), 'approve-all', admin);
  check('a proposal reviewed by somebody else is approved', decided.status === 'approved');
  check('and is not marked self-approved', decided.selfApproved !== true);

  /* ---------------------------------------------------- sparse storage & price */

  const approved = await findCustomer(CODE);
  const stored = Object.keys(approved?.liveTerms.overrides ?? {});
  check('only the negotiated cells are stored', stored.length === 2, `stored ${stored.length}`);
  check(
    'a full copy would have been 4,104 cells',
    stored.length < 10,
    `${stored.length} instead of 4104`,
  );

  const card = await contractedCard(approved!);
  check(
    'the contracted rate is applied',
    card.data.grids.surface.minCharge.PNQ?.NCR === 450,
    String(card.data.grids.surface.minCharge.PNQ?.NCR),
  );
  // PNQ→BOM is 430 in the base card; the customer has not negotiated it, so the
  // contracted card must show the base value untouched.
  check(
    'un-negotiated cells still read from the base',
    card.data.grids.surface.minCharge.PNQ?.BOM === 430,
    String(card.data.grids.surface.minCharge.PNQ?.BOM),
  );

  const q3 = await api(
    `/api/quote?customer=${CODE}&mode=surface&from=411001&to=110001&weight=200`,
  );
  const q3Body = await q3.json();
  // min 450 + tier1 15x50 + tier2 12x100 = 2400 freight, then cartage/fuel/GST.
  check(
    'the approved contract changes the quote',
    q3Body.breakdown?.total !== 5197.5 && q3Body.breakdown?.total > 0,
    `now ₹${q3Body.breakdown?.total}`,
  );
  check(
    'the base total is returned alongside for comparison',
    q3Body.baseTotal === 5197.5,
    String(q3Body.baseTotal),
  );
  check('the customer is cheaper than standard', q3Body.breakdown.total < q3Body.baseTotal);

  /* ------------------------------------------------- scope blocks other lanes */

  const q4 = await api(`/api/quote?customer=${CODE}&mode=surface&from=411001&to=400001&weight=200`);
  const q4Body = await q4.json();
  check('a lane outside the contract is not bookable', q4.status === 409 && q4Body.bookable === false);
  check('the reason is specific', q4Body.reasons?.includes('lane-not-in-contract'));
  check('base prices are offered as a fallback', q4Body.fallback?.breakdown?.total > 0);
  check('and are labelled as not contracted', q4Body.fallback?.note?.includes('not this customer'));
  check('approval is flagged as required', q4Body.requiresApproval === true);

  const q5 = await api(`/api/quote?customer=${CODE}&mode=air&from=411001&to=110001&weight=200`);
  const q5Body = await q5.json();
  check('a mode outside the contract is blocked', q5Body.reasons?.includes('mode-not-in-contract'));

  /* --------------------------------------------------------- booking exception */

  const raise = await api('/api/bookings/exceptions', {
    method: 'POST',
    body: JSON.stringify({
      customer: CODE,
      mode: 'surface',
      from: 411001,
      to: 400001,
      weight: 200,
      requestedBy: 'ops@verifyco',
    }),
  });
  const raiseBody = await raise.json();
  check('an exception can be raised', raise.status === 202 && Boolean(raiseBody.reference));

  const poll1 = await api(`/api/bookings/exceptions?reference=${raiseBody.reference}`);
  const poll1Body = await poll1.json();
  check('polling shows it pending and not bookable', poll1Body.bookable === false);

  const dupe = await api('/api/bookings/exceptions', {
    method: 'POST',
    body: JSON.stringify({
      customer: CODE,
      mode: 'surface',
      from: 411001,
      to: 110001,
      weight: 200,
      requestedBy: 'ops@verifyco',
    }),
  });
  check(
    'an exception for a lane already in contract is refused',
    dupe.status === 409,
    `got ${dupe.status}`,
  );

  await decideBookingException(raiseBody.reference, true, admin, { comment: 'One off, agreed.' });

  const poll2 = await api(`/api/bookings/exceptions?reference=${raiseBody.reference}`);
  const poll2Body = await poll2.json();
  check('once approved the booking is allowed', poll2Body.bookable === true);
  check('the decision is attributed', poll2Body.decidedBy === admin.name);

  let redecideRefused = false;
  try {
    await decideBookingException(raiseBody.reference, false, admin);
  } catch {
    redecideRefused = true;
  }
  check('an exception cannot be decided twice', redecideRefused);

  /* ----------------------------------------------------- unknown customer path */

  const unknown = await api('/api/quote?customer=NOPE&mode=surface&from=411001&to=110001&weight=1');
  check('an unknown customer is rejected', unknown.status === 404);

  /* ------------------------------------------------------- self-approval is allowed */

  /**
   * Permitted and recorded, not blocked.
   *
   * This script used to assert a refusal here. The system did refuse it once, and that
   * deadlocked a single-admin setup: `admin` is the only role that may review, so
   * forbidding self-approval left nobody able to approve anything. The rule became
   * "allowed, and visible" instead — `selfApproved` on the proposal, and a callout on the
   * approval screen — so what is worth proving is that the flag is set when it happens.
   *
   * Last, and on its own proposal, because approving a second set of rates would move the
   * prices every assertion above is pinned to.
   */
  await editDraftContract(CODE, [{ bind: 'grids.surface.minCharge.PNQ.NCR', value: 425 }], editor);
  const ownProposal = await proposeContract(CODE, editor);
  const ownReview = await reviewProposal(ownProposal._id.toHexString(), 'approve-all', editor);
  check('a proposer may approve their own contract', ownReview.status === 'approved');
  check('and it is recorded as self-approved', ownReview.selfApproved === true);

  await cleanup();
  const gone = await findCustomer(CODE);
  check('the test customer was cleaned up', gone === null);

  console.log(
    `\n${failures === 0 ? 'contract and booking flow verified end to end' : `${failures} check(s) failed`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('verification failed:', error);
  await cleanup().catch(() => {});
  process.exit(1);
});
