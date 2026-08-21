'use server';

import { revalidatePath } from 'next/cache';
import type {
  SettlementMode,
  BillingCycle,
  BreachAction,
  CancelPolicy,
  SettlementOverrides,
} from '../billing/settlement';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { editDraftCells, saveDraftRule, deleteDraftRule } from '../data/rate-cards';
import {
  editDraftContract,
  editDraftScope,
  discardDraftContract,
  proposeContract,
  registerCustomer,
  reviewProposal,
  decideBookingException,
  widenScopeForException,
  findCustomer,
} from '../data/customers';
import { currentUser, toActor } from '../auth/session';
import { can, type Capability } from '../auth/roles';
import { bindPathFor } from '../console/lanes';
import type { RateKey } from '../components/console/LaneEditor';
import type { StoredMode } from '../domain/types';
import type { StoredLaneRule } from '../domain/lane-rule-store';
import { searchGeography, type GeoResult } from '../domain/geo-search';
import { explainResolution, type Endpoint } from '../domain/lane-rules';
import { coverageOf, type CoverageSummary } from '../domain/rule-coverage';
import { previewRule, type PreviewRow } from '../domain/rule-preview';
import type { RuleRates } from '../domain/lane-rule-store';
import { rulesFrom } from '../domain/lane-rule-store';
import { draftVersion } from '../data/rate-cards';
import { findPincode, allPincodes } from '../data/pincodes';
import { UNRESTRICTED_SCOPE, type ContractScope, type CommercialTerms } from '../domain/customers';
import type { ProposalDecisions } from '../customers/proposal';
import { recordAudit } from '../data/audit';
import { recordEntry, recordPayment } from '../data/billing';
import { createProduct } from '../data/products';
import type { Mode } from '../domain/types';

/**
 * Server actions for the console.
 *
 * The console is a different way to reach the same machinery: every edit here lands
 * in exactly the same draft, produces the same diff and needs the same approval as
 * an edit made on the spreadsheet.
 */

async function authorise(capability: Capability) {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!can(user.role, capability)) {
    throw new Error(`Your role (${user.role}) is not permitted to do that.`);
  }
  return user;
}

export interface LaneEdit {
  mode: StoredMode;
  origin: string;
  destination: string;
  rate: RateKey;
  value: number | null;
}

const toBinds = (edits: LaneEdit[]) =>
  edits.map((edit) => ({
    bind: bindPathFor(edit.mode, edit.rate, edit.origin, edit.destination),
    value: edit.value,
  }));

/* ------------------------------------------------------------- base rate cards */

export async function saveLaneEdits(cardKey: string, edits: LaneEdit[]) {
  const user = await authorise('edit-draft');
  await editDraftCells(cardKey, toBinds(edits), toActor(user));
  revalidatePath('/console/[card]', 'layout');
}

export async function saveParamEdits(
  cardKey: string,
  // Text as well as numbers: a SAC code, a charge name and a Yes/No flag are all cells.
  edits: { bind: string; value: string | number | null }[],
) {
  const user = await authorise('edit-draft');
  await editDraftCells(cardKey, edits, toActor(user));
  revalidatePath('/console/[card]', 'layout');
}

/* ---------------------------------------------------------- customer contracts */

export async function saveContractLaneEdits(customerCode: string, edits: LaneEdit[]) {
  const user = await authorise('edit-draft');
  await editDraftContract(customerCode, toBinds(edits), toActor(user));
  revalidatePath('/customers/[code]', 'page');
}

/**
 * Negotiate anything that is not a lane rate — fuel, GST, docket, cartage, ODA.
 *
 * Uses the same override storage as rates, so a charge override is pruned if it
 * ever equals the base value again, and it appears in the proposal diff identically.
 */
export async function saveContractCharges(
  customerCode: string,
  // Text as well as numbers: a SAC code, a charge name and a Yes/No flag are all
  // negotiable, and all of them are stored as ordinary override cells.
  edits: { bind: string; value: string | number | null }[],
) {
  const user = await authorise('edit-draft');
  await editDraftContract(customerCode, edits, toActor(user));
  revalidatePath('/customers/[code]', 'page');
}

export async function saveContractScope(customerCode: string, scope: ContractScope) {
  const user = await authorise('edit-draft');
  await editDraftScope(customerCode, scope, toActor(user));
  revalidatePath('/customers/[code]', 'page');
}

export async function discardContractDraft(customerCode: string) {
  const user = await authorise('edit-draft');
  await discardDraftContract(customerCode, toActor(user));
  revalidatePath('/customers/[code]', 'page');
}

export async function submitContractProposal(customerCode: string) {
  const user = await authorise('submit-for-approval');
  const proposal = await proposeContract(customerCode, toActor(user));
  revalidatePath('/approvals');
  redirect(`/approvals/contract/${proposal._id.toHexString()}`);
}

export async function addCustomerManually(_previous: unknown, form: FormData) {
  const user = await authorise('edit-draft');
  const code = String(form.get('code') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();
  const baseCardKey = String(form.get('baseCardKey') ?? 'model-1');

  if (!code || !name) return { error: 'A code and a name are both required.' };

  const { created } = await registerCustomer({
    code,
    name,
    baseCardKey,
    source: 'manual',
    actor: toActor(user),
  });
  revalidatePath('/customers');
  return created
    ? { ok: true as const }
    : { error: `A customer with code ${code.toUpperCase()} already exists.` };
}

export async function decideContractProposal(proposalId: string, form: FormData) {
  const user = await authorise('review-change-request');
  const intent = String(form.get('intent') ?? '');
  const comment = String(form.get('comment') ?? '').trim() || undefined;

  let decisions: ProposalDecisions;
  if (intent === 'approve-all') decisions = 'approve-all';
  else if (intent === 'reject-all') decisions = 'reject-all';
  else {
    const perLine: Record<string, { decision: 'approved' | 'rejected'; comment?: string }> = {};
    for (const [key, value] of form.entries()) {
      if (!key.startsWith('decision:')) continue;
      const bind = key.slice('decision:'.length);
      const lineComment = String(form.get(`comment:${bind}`) ?? '').trim();
      perLine[bind] = {
        decision: value === 'approved' ? 'approved' : 'rejected',
        ...(lineComment ? { comment: lineComment } : {}),
      };
    }
    decisions = perLine;
  }

  await reviewProposal(proposalId, decisions, toActor(user), comment);
  revalidatePath('/approvals');
  revalidatePath('/customers', 'layout');
  redirect('/approvals');
}

/* --------------------------------------------------------- booking exceptions */

export async function decideException(reference: string, form: FormData) {
  const user = await authorise('review-change-request');
  const approve = String(form.get('intent')) === 'approve';
  const comment = String(form.get('comment') ?? '').trim() || undefined;
  const addToContract = form.get('addToContract') === 'on';

  const request = await decideBookingException(reference, approve, toActor(user), {
    ...(comment === undefined ? {} : { comment }),
    addToContract,
  });

  // Folding the lane in permanently needs the resolved zones, which the request
  // does not store — so re-resolve them here from the pincodes.
  if (approve && addToContract) {
    const customer = await findCustomer(request.customerCode);
    if (customer && customer.liveTerms.scope.lanes !== null) {
      const { findPincodePair } = await import('../data/pincodes');
      const { baseCardFor } = await import('../data/customers');
      const { quote } = await import('../pricing/quote');
      const { withLane, withMode } = await import('../customers/contract');

      const { origin, destination } = await findPincodePair(
        request.fromPincode,
        request.toPincode,
      );
      const base = await baseCardFor(customer);
      const priced = quote(
        { mode: request.mode, actualWeight: request.weight },
        { origin, destination },
        base,
      );
      if (priced.available) {
        let scope = withLane(
          customer.liveTerms.scope,
          request.mode,
          priced.breakdown.originZone,
          priced.breakdown.destinationZone,
        );
        scope = withMode(scope, request.mode);
        await widenScopeForException(customer.code, scope, toActor(user));
      }
    }
  }

  revalidatePath('/approvals');
  redirect('/approvals');
}

/* ------------------------------------------------------------------ ui switch */

/** Remember which of the two interfaces this person prefers. */
/* ------------------------------------------------------------------------ money */

export interface MoneyResult {
  ok: boolean;
  message: string;
}

/**
 * Pay money into a customer's account.
 *
 * The reference is the payment's own id — a UTR, a gateway reference — and is what makes
 * this safe to retry: recording the same reference twice records one recharge, not two.
 */
export async function rechargeWallet(
  _previous: MoneyResult | null,
  form: FormData,
): Promise<MoneyResult> {
  const user = await authorise('record-money');
  const code = String(form.get('code') ?? '').trim();
  const amount = Number(form.get('amount'));
  const reference = String(form.get('reference') ?? '').trim();
  const note = String(form.get('note') ?? '').trim();

  if (!code) return { ok: false, message: 'No customer.' };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: 'Enter an amount greater than zero.' };
  }
  if (!reference) {
    return { ok: false, message: 'A payment reference is required, so this can be reconciled.' };
  }

  try {
    const { duplicate } = await recordEntry(
      {
        customerCode: code,
        kind: 'recharge',
        amount,
        reference,
        ...(note === '' ? {} : { note }),
      },
      toActor(user),
    );
    revalidatePath('/customers/[code]', 'page');
    return {
      ok: true,
      message: duplicate
        ? `Reference ${reference} was already recorded — nothing was added a second time.`
        : `Recharged Rs ${amount.toLocaleString('en-IN')}.`,
    };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : 'Could not record that.' };
  }
}

/** Record a payment against an invoice. Part payments are expected and supported. */
export async function payInvoice(
  _previous: MoneyResult | null,
  form: FormData,
): Promise<MoneyResult> {
  const user = await authorise('record-money');
  const code = String(form.get('code') ?? '').trim();
  const invoice = String(form.get('invoice') ?? '').trim();
  const amount = Number(form.get('amount'));
  const reference = String(form.get('reference') ?? '').trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: 'Enter an amount greater than zero.' };
  }
  if (!reference) return { ok: false, message: 'A payment reference is required.' };

  try {
    const updated = await recordPayment(code, invoice, amount, reference, toActor(user));
    revalidatePath('/customers/[code]', 'page');
    return { ok: true, message: `${invoice} is now ${updated.status}.` };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : 'Could not record that.' };
  }
}


/* ------------------------------------------------------------------ templates */

/**
 * Explicit result shapes. `useActionState` infers the state type from the action's
 * return, and an inferred union of literal object shapes will not accept the initial
 * `null` plus later variants — so each action states what it returns.
 */
export interface ActionResult {
  ok?: true;
  error?: string;
}

export interface AssignTemplateResult extends ActionResult {
  applied?: number;
  kept?: number;
  /** Parameters the assigner left blank, which were not written at all. */
  unanswered?: number;
}

export interface CsvImportResult extends ActionResult {
  preview?: true;
  cells?: number;
  issues?: { line: number; message: string; raw: string }[];
  expansions?: { line: number; description: string; lanes: number }[];
  /** Parsed coverage and terms, so the preview can show what they would become. */
  scope?: ContractScope;
  commercial?: Partial<CommercialTerms>;
}

export interface ProfileResult extends ActionResult {
  warnings?: string[];
  /** Set when the edit went to the approvals queue rather than taking effect. */
  submitted?: boolean;
  /** Named so the form can say what a reviewer will be looking at. */
  changed?: string[];
}

/**
 * Templates and CSV both land in the customer's DRAFT, so assigning a standard
 * configuration still goes through approval. Neither is a way to move a price
 * without review.
 */
export async function createTemplateFromCustomer(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const user = await authorise('edit-draft');
  const customerCode = String(form.get('customerCode') ?? '');
  const name = String(form.get('name') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();

  if (!name) return { error: 'Give the template a name.' };

  try {
    const { templateFromCustomer } = await import('../data/templates');
    await templateFromCustomer({ customerCode, name, description, actor: toActor(user) });
    revalidatePath('/templates');
    return { ok: true as const };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not save the template.' };
  }
}

/**
 * Start a template from a base card rather than from a customer.
 *
 * The copy-from-a-customer path only works once somebody has negotiated the shape you
 * want. A standard offer — "e-commerce", "auto components" — usually has to be written
 * before any customer is on it, so it starts empty on a chosen card and its rates are
 * edited afterwards.
 */
export async function createBlankTemplate(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const user = await authorise('edit-draft');
  const name = String(form.get('name') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();
  const baseCardKey = String(form.get('baseCardKey') ?? '').trim();

  if (!name) return { error: 'Give the template a name.' };
  if (!baseCardKey) return { error: 'Pick the rate card it is written against.' };

  try {
    const { createTemplate } = await import('../data/templates');
    const { UNRESTRICTED_SCOPE } = await import('../domain/customers');
    await createTemplate({
      name,
      description,
      baseCardKey,
      // Empty: nothing is negotiated until somebody edits it, so a template assigned in
      // this state changes no price. That is the right starting point.
      overrides: {},
      scope: UNRESTRICTED_SCOPE,
      actor: toActor(user),
    });
    revalidatePath('/templates');
    return { ok: true as const };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not create the template.' };
  }
}

/** Save edited rates and coverage onto a template. */
export async function saveTemplateTerms(
  key: string,
  edits: { bind: string; value: string | number | null }[],
  scope?: ContractScope,
) {
  const user = await authorise('edit-draft');
  const { findTemplate, updateTemplateTerms } = await import('../data/templates');
  const template = await findTemplate(key);
  if (!template) throw new Error(`template ${key} not found`);

  // A template is the same shape as a contract, so it is edited by the same rules —
  // including that `null` is a VALUE meaning "this lane is not carried", not an
  // instruction to remove the override. Treating a blank as a deletion here would
  // silently reopen lanes a template deliberately closes.
  const overrides = { ...template.overrides };
  for (const edit of edits) overrides[edit.bind] = edit.value;

  // Anything that now equals the base card is not a negotiated term, so it is dropped —
  // otherwise the template would freeze that cell and stop tracking base changes.
  const { liveCard } = await import('../data/rate-cards');
  const { pruneOverrides } = await import('../customers/contract');
  const base = await liveCard(template.baseCardKey);
  const pruned = base ? pruneOverrides(base.data, overrides).overrides : overrides;

  await updateTemplateTerms({
    key,
    overrides: pruned,
    scope: scope ?? template.scope,
    actor: toActor(user),
  });
  revalidatePath('/templates');
  revalidatePath(`/templates/${key}`);
}

export async function assignTemplate(
  _previous: AssignTemplateResult | null,
  form: FormData,
): Promise<AssignTemplateResult> {
  const user = await authorise('edit-draft');
  const templateKey = String(form.get('templateKey') ?? '');
  const customerCode = String(form.get('customerCode') ?? '');
  const mode = String(form.get('mode') ?? 'fill-gaps') === 'replace' ? 'replace' : 'fill-gaps';

  // `answer:<bind path>` fields, one per parameter the template declares. A blank is left
  // blank rather than read as zero — nobody agreed to zero.
  const answers: Record<string, string | number | null> = {};
  for (const [field, value] of form.entries()) {
    if (!field.startsWith('answer:')) continue;
    const raw = String(value).trim();
    if (raw === '') continue;
    const numeric = Number(raw);
    answers[field.slice('answer:'.length)] = Number.isFinite(numeric) ? numeric : raw;
  }

  try {
    const { applyTemplateToCustomer } = await import('../data/templates');
    const result = await applyTemplateToCustomer({
      templateKey,
      customerCode,
      mode,
      actor: toActor(user),
      answers,
    });
    revalidatePath('/customers/[code]', 'page');
    return { ok: true as const, ...result };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not apply the template.' };
  }
}

/** Mark which of a template's cells ask the next customer for a value. */
export async function markTemplateParameters(key: string, parameters: string[]) {
  const user = await authorise('edit-draft');
  const { updateTemplateParameters } = await import('../data/templates');
  await updateTemplateParameters({ key, parameters, actor: toActor(user) });
  revalidatePath(`/templates/${key}`);
  revalidatePath('/customers/[code]', 'page');
}

/**
 * Withdraw a template.
 *
 * Admin-only, on the existing `manage-users` capability rather than `edit-draft`. That is
 * the authorisation this already carried and it is not widened here: a configurator may
 * write templates and assign them, and removing one that fifty contracts cite as their
 * provenance is a different kind of act.
 *
 * Returns how many contracts were built from it, so the screen can report what the deletion
 * actually cost. The number is in the audit entry too, because after this call nothing else
 * knows it.
 */
export async function removeTemplate(key: string): Promise<{ builtFrom: number }> {
  const user = await authorise('manage-users');
  const { deleteTemplate } = await import('../data/templates');
  const result = await deleteTemplate(key, toActor(user));
  revalidatePath('/templates');
  revalidatePath('/customers/[code]', 'page');
  return result;
}

/* ---------------------------------------------------------------- csv import */

export async function importCustomerCsv(
  _previous: CsvImportResult | null,
  form: FormData,
): Promise<CsvImportResult> {
  const user = await authorise('edit-draft');
  const customerCode = String(form.get('customerCode') ?? '');
  const text = String(form.get('csv') ?? '');
  const confirmed = form.get('confirm') === 'on';

  if (text.trim() === '') return { error: 'Paste the CSV, or choose a file.' };

  const { parseCustomerCsv } = await import('../customers/csv');
  const parsed = parseCustomerCsv(text);

  // Always report before writing: a preview pass returns the parse result and
  // touches nothing, so nobody imports a file they have not seen interpreted.
  if (!confirmed) {
    return {
      preview: true as const,
      issues: parsed.issues,
      expansions: parsed.expansions,
      cells: Object.keys(parsed.overrides).length,
      scope: parsed.scope,
      commercial: parsed.commercial,
    };
  }

  if (parsed.issues.length > 0) {
    return { error: `Fix the ${parsed.issues.length} problem(s) first.`, issues: parsed.issues };
  }

  try {
    const { editDraftContract, editDraftScope, saveCommercialTerms, findCustomer } = await import(
      '../data/customers'
    );
    const { DEFAULT_COMMERCIAL_TERMS } = await import('../domain/customers');

    await editDraftContract(
      customerCode,
      Object.entries(parsed.overrides).map(([bind, value]) => ({ bind, value })),
      toActor(user),
    );

    // Coverage rows are optional; an absent row must not silently open everything.
    const anyCoverage =
      parsed.scope.modes !== null ||
      parsed.scope.lanes !== null ||
      parsed.scope.weightBands !== null;
    if (anyCoverage) await editDraftScope(customerCode, parsed.scope, toActor(user));

    if (Object.keys(parsed.commercial).length > 0) {
      const customer = await findCustomer(customerCode);
      await saveCommercialTerms(
        customerCode,
        { ...DEFAULT_COMMERCIAL_TERMS, ...customer?.commercial, ...parsed.commercial },
        toActor(user),
      );
    }

    await recordAudit({
      action: 'customer-csv-imported',
      actor: toActor(user),
      at: new Date(),
      detail: { customer: customerCode, cells: Object.keys(parsed.overrides).length },
    });

    revalidatePath('/customers/[code]', 'page');
    return { ok: true as const, cells: Object.keys(parsed.overrides).length };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not import that file.' };
  }
}

/* ------------------------------------------------------- company master data */

export async function saveCustomerProfile(
  _previous: ProfileResult | null,
  form: FormData,
): Promise<ProfileResult> {
  const user = await authorise('edit-draft');
  const code = String(form.get('code') ?? '');
  const profileJson = String(form.get('profile') ?? '');

  try {
    const profile = JSON.parse(profileJson);
    const { crossCheckIdentifiers } = await import('../domain/company');

    const problems = crossCheckIdentifiers({
      gstin: profile.gstin,
      pan: profile.pan,
      stateName: profile.registeredAddress?.state,
    });
    // Warnings, not a block: a customer may legitimately be mid-registration.

    // This no longer saves. Company details now decide who can sign in to the enterprise
    // portal and what prints on a tax invoice, because an approved change is pushed into
    // the core — so it goes through review like every other change that leaves this
    // service. See `data/customer-profile-changes.ts`.
    const { proposeProfileChange } = await import('../data/customer-profile-changes');
    const { change, unchanged } = await proposeProfileChange(code, profile, toActor(user));

    revalidatePath('/customers/[code]', 'page');
    revalidatePath('/approvals', 'page');

    if (unchanged) {
      return { ok: true as const, warnings: problems, submitted: false, changed: [] };
    }
    return {
      ok: true as const,
      warnings: problems,
      submitted: true,
      changed: change?.changed ?? [],
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not save the profile.' };
  }
}

export async function saveCommercial(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const user = await authorise('edit-draft');
  const code = String(form.get('code') ?? '');
  const creditRaw = String(form.get('creditLimit') ?? '').trim();

  const { saveCommercialTerms } = await import('../data/customers');
  await saveCommercialTerms(
    code,
    {
      billingType: String(form.get('billingType')) === 'RCM' ? 'RCM' : 'FORWARD',
      gstApplicable: form.get('gstApplicable') === 'on',
      paymentTermsDays: Number(form.get('paymentTermsDays') ?? 30) || 0,
      creditLimit: creditRaw === '' ? null : Number(creditRaw),
    },
    toActor(user),
  );
  revalidatePath('/customers/[code]', 'page');
  return { ok: true as const };
}

/* --------------------------------------------------------------- lane rules */

/**
 * Add or replace a lane rule on a card's draft.
 *
 * Adding a rule is structural, so it does not go through the cell editor — but once it
 * exists each of its rates is an ordinary cell and is edited, diffed and approved like
 * any other.
 */
export async function saveLaneRule(cardKey: string, rule: StoredLaneRule) {
  const user = await authorise('edit-draft');
  await saveDraftRule(cardKey, rule, toActor(user));
  revalidatePath('/console/[card]', 'layout');
}

export async function removeLaneRule(cardKey: string, id: string) {
  const user = await authorise('edit-draft');
  await deleteDraftRule(cardKey, id, toActor(user));
  revalidatePath('/console/[card]', 'layout');
}

/** Search every level of geography, for the rule editor's one search box. */
export async function searchGeographyAction(
  query: string,
  mode: StoredMode,
): Promise<GeoResult[]> {
  await authorise('view-sheets');
  return searchGeography(query, await allPincodes(), mode);
}

/**
 * Resolve one real shipment against a card's draft rules, and say which rule won.
 *
 * The point of this is trust, so it runs the same resolver the engine runs rather than
 * describing what it thinks the engine would do.
 */
export async function testShipmentAction(
  cardKey: string,
  mode: StoredMode,
  originPincode: number,
  destinationPincode: number,
): Promise<
  | { ok: false; message: string }
  | { ok: true; steps: { trace: string; matched: boolean }[]; winner: string | null; rate: number | null }
> {
  await authorise('view-sheets');

  const [origin, destination] = await Promise.all([
    findPincode(originPincode),
    findPincode(destinationPincode),
  ]);
  if (!origin) return { ok: false, message: `${originPincode} is not in the pincode master.` };
  if (!destination) {
    return { ok: false, message: `${destinationPincode} is not in the pincode master.` };
  }

  const draft = await draftVersion(cardKey);
  const { steps, winner } = explainResolution(rulesFrom(draft.data.laneRules, 'base'), {
    mode,
    origin,
    destination,
  });

  return {
    ok: true,
    steps: steps.map(({ trace, matched }) => ({ trace, matched })),
    winner: winner?.trace ?? null,
    rate: winner?.rule.rates.tier1 ?? null,
  };
}

/** How many pincodes an endpoint reaches, and which cities they fall in. */
export async function coverageAction(
  endpoint: Endpoint,
  mode: StoredMode,
): Promise<CoverageSummary> {
  await authorise('view-sheets');
  return coverageOf(endpoint, await allPincodes(), mode);
}

/**
 * Lane by lane, what a zone-shaped rule would do to today's prices.
 *
 * Returns nothing for a city or state rule: those do not map onto the zone grid, which
 * is the whole reason they exist, and inventing a comparison would be a lie in a place
 * people are about to trust.
 */
export async function previewRuleAction(
  cardKey: string,
  mode: StoredMode,
  origin: Endpoint,
  destination: Endpoint,
  rates: RuleRates,
): Promise<PreviewRow[]> {
  await authorise('view-sheets');
  const draft = await draftVersion(cardKey);
  return previewRule(origin, destination, rates, draft.data.grids[mode], mode);
}

/* ---------------------------------------------------------- the charge library */

/**
 * Define a charge and put it in the library.
 *
 * A definition has to be written somewhere, because the library is derived rather than
 * stored. It lands on a base card's draft, inactive, so it exists to be reused and reaches
 * an approver before it can bill anyone. Switching it on, and setting its amount, is an
 * ordinary cell edit on the Tax & charges tab afterwards.
 */
export async function createLibraryCharge(
  cardKey: string,
  definition: {
    id: string;
    name: string;
    basis: string;
    gstApplies: boolean;
    fuelApplies: boolean;
    bookableOneOff: boolean;
  },
) {
  const user = await authorise('edit-draft');
  const path = `chargeCatalog.${definition.id}`;

  await editDraftCells(
    cardKey,
    [
      { bind: `${path}.name`, value: definition.name },
      { bind: `${path}.basis`, value: definition.basis },
      { bind: `${path}.amount`, value: 0 },
      { bind: `${path}.gstApplies`, value: definition.gstApplies ? 'Yes' : 'No' },
      { bind: `${path}.fuelApplies`, value: definition.fuelApplies ? 'Yes' : 'No' },
      { bind: `${path}.bookableOneOff`, value: definition.bookableOneOff ? 'Yes' : 'No' },
      // Inactive on purpose: a new definition should not start billing the moment it is
      // named. It is switched on deliberately, at an amount somebody chose.
      { bind: `${path}.active`, value: 'No' },
    ],
    toActor(user),
  );
  revalidatePath('/charges', 'page');
}

/* -------------------------------------------------------------- the catalog */

/**
 * Put a product in the catalog.
 *
 * Naming a product moves no price and needs no approval: it records that a template and
 * some charges are sold together under one name. The prices move when it is applied to a
 * customer, and that lands in a draft like every other edit.
 */
export async function createCatalogProduct(input: {
  name: string;
  description: string;
  templateKey: string;
  charges: string[];
  modes: Mode[];
  segment: string;
}) {
  const user = await authorise('edit-draft');
  await createProduct({ ...input, actor: toActor(user) });
  revalidatePath('/products', 'page');
}

export type ApplyProductResult =
  | { error: string }
  | { ok: true; results: import('../data/products').ProductApplication[] };

/**
 * Apply a product to one customer or to its whole segment.
 *
 * A segment run reports per customer rather than as a total, because "applied to 6" hides
 * the one that was skipped for being on a different base card — and that one is the whole
 * reason to look at the result.
 */
export async function applyProduct(
  _previous: ApplyProductResult | null,
  form: FormData,
): Promise<ApplyProductResult> {
  const user = await authorise('edit-draft');
  const productKey = String(form.get('productKey') ?? '');
  const customerCode = String(form.get('customerCode') ?? '');
  const mode = String(form.get('mode') ?? 'fill-gaps') === 'replace' ? 'replace' : 'fill-gaps';
  const actor = toActor(user);

  try {
    const { applyProductToCustomer, applyProductToSegment } = await import('../data/products');
    const results =
      customerCode === ''
        ? await applyProductToSegment({ productKey, mode, actor })
        : [await applyProductToCustomer({ productKey, customerCode, mode, actor })];

    revalidatePath('/customers', 'layout');
    revalidatePath('/products/[key]', 'page');
    return { ok: true as const, results };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not apply the product.' };
  }
}

/** Segment tags for a customer. Reference data: it decides what is offered, not what is charged. */
export async function saveCustomerTags(customerCode: string, tags: string[]) {
  const user = await authorise('edit-draft');
  const { setCustomerTags } = await import('../data/customers');
  await setCustomerTags(customerCode, tags, toActor(user));
  revalidatePath('/customers/[code]', 'page');
  revalidatePath('/products/[key]', 'page');
}

/**
 * Freeze — or release — today's prices on every lane this customer has not negotiated.
 *
 * The deliberate version of what the mockup found happening by accident. It lands in the
 * draft like any other edit and is reported to an approver as one line, because that is
 * what it is: one decision, to stop this customer tracking the base card.
 */
export async function lockTodaysPrices(
  customerCode: string,
  lock: boolean,
): Promise<{ locked: number }> {
  const user = await authorise('edit-draft');
  const { findCustomer, baseCardFor, setDraftPriceLock } = await import('../data/customers');
  const { priceLockOverrides } = await import('../domain/price-lock');

  const customer = await findCustomer(customerCode);
  if (!customer) throw new Error(`customer ${customerCode} not found`);

  if (!lock) {
    await setDraftPriceLock(customerCode, null, toActor(user));
    revalidatePath('/customers/[code]', 'page');
    return { locked: 0 };
  }

  const base = await baseCardFor(customer);
  const rates = priceLockOverrides(base.data, customer.draftTerms.overrides);
  const locked = await setDraftPriceLock(
    customerCode,
    { at: new Date(), by: user.name, rates },
    toActor(user),
  );

  revalidatePath('/customers/[code]', 'page');
  return { locked };
}

/* ------------------------------------------------------- the customer wizard */

/** Is this code free? Checked as it is typed, so a clash is never a silent overwrite. */
export async function checkCustomerCode(
  code: string,
): Promise<{ available: boolean; reason?: string }> {
  await authorise('edit-draft');
  const trimmed = code.trim().toUpperCase();
  if (trimmed === '') return { available: false, reason: 'A code is required.' };

  const { findCustomer } = await import('../data/customers');
  const existing = await findCustomer(trimmed);
  return existing
    ? { available: false, reason: `${existing.name} already uses ${trimmed}.` }
    : { available: true };
}

export interface WizardInput {
  code: string;
  name: string;
  baseCardKey: string;
  profile: { gstin?: string; pan?: string; msmeNumber?: string; addressLine?: string; state?: string };
  /** Where the rates come from: a template, another customer's contract, or nothing. */
  start:
    | { kind: 'blank' }
    | { kind: 'template'; templateKey: string; answers: Record<string, string | number | null> }
    | { kind: 'clone'; customerCode: string };
  scope: ContractScope;
  propose: boolean;
}

/**
 * Create a customer with a working contract, rather than an empty one.
 *
 * Every step lands through the ordinary machinery — `registerCustomer`, the template
 * assignment, `editDraftScope` — so a customer built by the wizard is indistinguishable
 * afterwards from one built by hand. The wizard is a better first five minutes, not a
 * second way for a contract to exist.
 */
export async function createCustomerFromWizard(
  input: WizardInput,
): Promise<{ code: string; cells: number; proposalId?: string }> {
  const user = await authorise('edit-draft');
  const actor = toActor(user);

  const {
    registerCustomer,
    findCustomer,
    editDraftScope,
    editDraftContract,
    saveProfile,
    proposeContract,
  } = await import('../data/customers');

  const { created, customer } = await registerCustomer({
    code: input.code,
    name: input.name,
    baseCardKey: input.baseCardKey,
    source: 'manual',
    actor,
  });
  if (!created) {
    throw new Error(`${customer.code} already exists. Pick another code.`);
  }

  if (input.profile.gstin || input.profile.pan || input.profile.msmeNumber || input.profile.addressLine) {
    const { EMPTY_PROFILE, EMPTY_ADDRESS } = await import('../domain/company');
    await saveProfile(
      customer.code,
      {
        ...EMPTY_PROFILE,
        legalName: input.name,
        ...(input.profile.gstin ? { gstin: input.profile.gstin.trim().toUpperCase() } : {}),
        ...(input.profile.pan ? { pan: input.profile.pan.trim().toUpperCase() } : {}),
        ...(input.profile.msmeNumber ? { msmeNumber: input.profile.msmeNumber.trim() } : {}),
        ...(input.profile.addressLine
          ? {
              registeredAddress: {
                ...EMPTY_ADDRESS,
                line1: input.profile.addressLine,
                state: input.profile.state ?? '',
              },
            }
          : {}),
      },
      actor,
    );
  }

  if (input.start.kind === 'template') {
    const { applyTemplateToCustomer } = await import('../data/templates');
    await applyTemplateToCustomer({
      templateKey: input.start.templateKey,
      customerCode: customer.code,
      mode: 'fill-gaps',
      actor,
      answers: input.start.answers,
    });
  } else if (input.start.kind === 'clone') {
    const source = await findCustomer(input.start.customerCode);
    if (!source) throw new Error(`customer ${input.start.customerCode} not found`);
    if (source.baseCardKey !== input.baseCardKey) {
      throw new Error(
        `${source.code} is priced from ${source.baseCardKey}; the same cells would mean ` +
          `something else on ${input.baseCardKey}.`,
      );
    }
    // The approved contract, not their draft: cloning someone's half-finished negotiation
    // would copy a position nobody has agreed to.
    await editDraftContract(
      customer.code,
      Object.entries(source.liveTerms.overrides).map(([bind, value]) => ({ bind, value })),
      actor,
    );
  }

  await editDraftScope(customer.code, input.scope, actor);

  const after = await findCustomer(customer.code);
  const cells = Object.keys(after?.draftTerms.overrides ?? {}).length;

  let proposalId: string | undefined;
  if (input.propose) {
    if (cells === 0 && JSON.stringify(input.scope) === JSON.stringify(UNRESTRICTED_SCOPE)) {
      // Nothing to review. Saying so beats an error from the proposal builder that reads
      // like the save failed.
      throw new Error(
        'There is nothing to propose: this contract matches the standard card exactly. ' +
          'Save it as a draft instead.',
      );
    }
    const proposal = await proposeContract(customer.code, actor);
    proposalId = proposal._id.toHexString();
  }

  revalidatePath('/customers', 'layout');
  return { code: customer.code, cells, ...(proposalId ? { proposalId } : {}) };
}

/**
 * The escape hatch: change a customer's code or base card before anything is negotiated.
 *
 * Locked the moment a rate is stored or a proposal has ever been raised, because an
 * override path means a cell on a particular card and moving the card underneath a
 * negotiated contract would silently reinterpret every one of them. Before that, it is
 * a typo, and punishing an early wrong click with a permanent record helps nobody.
 */
export async function changeCustomerSetup(
  currentCode: string,
  next: { code: string; baseCardKey: string },
): Promise<{ code: string }> {
  const user = await authorise('edit-draft');
  const { changeSetup } = await import('../data/customers');
  const result = await changeSetup(currentCode, next, toActor(user));
  revalidatePath('/customers', 'layout');
  return result;
}


/* --------------------------------------------------------------- payment terms */

/**
 * Define a settlement arrangement.
 *
 * Saved as configuration, not applied to anybody: naming an arrangement and putting a
 * customer on it are two decisions, and rolling them together is how fifty accounts end
 * up on terms somebody was drafting.
 */
export async function createSettlementProfile(input: {
  key: string;
  name: string;
  mode: SettlementMode;
  cycle: BillingCycle;
  onBreach: BreachAction;
  cancelPolicy: CancelPolicy;
  overrideRole?: string;
  prepaid?: { negativeAllowance: number; lowBalanceAlertAt: number | null; minRecharge: number | null };
  credit?: { limit: number; periodDays: number; graceDays: number };
}) {
  const user = await authorise('record-money');
  const { createProfile } = await import('../data/settlement');
  await createProfile(input, toActor(user));
  revalidatePath('/settlement');
}

/** Put a customer on an arrangement, or move them to another one. */
export async function assignSettlementProfile(
  customerCode: string,
  profileKey: string,
  overrides?: SettlementOverrides,
) {
  const user = await authorise('record-money');
  const { assignSettlement } = await import('../data/customers');
  await assignSettlement(
    customerCode,
    { profileKey, ...(overrides === undefined ? {} : { overrides }) },
    toActor(user),
  );
  revalidatePath('/settlement');
  revalidatePath('/customers', 'layout');
}

/* -------------------------------------------------------------------- offers */

/**
 * Schedule a time-boxed adjustment.
 *
 * No approval step, deliberately, and the reason is the shape of the thing: an offer
 * cannot alter a stored rate, it expires by arithmetic, and it is bounded by dates
 * somebody typed. What it does need is to be visible, which is why every quote it touches
 * names it and shows the price without it.
 */
export async function scheduleOffer(input: {
  name: string;
  kind: 'percent-off-freight' | 'amount-off-freight' | 'waive-charge';
  value: number;
  chargeId?: string;
  startsAt: string;
  endsAt: string;
  audience: { kind: 'product' | 'segment' | 'customer'; value: string };
}) {
  const user = await authorise('edit-draft');
  const { createOffer } = await import('../data/offers');

  await createOffer({
    name: input.name,
    kind: input.kind,
    value: input.value,
    ...(input.chargeId ? { chargeId: input.chargeId } : {}),
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    audience: input.audience,
    actor: toActor(user),
  });
  revalidatePath('/offers');
}

export async function suspendOffer(key: string, enabled: boolean) {
  const user = await authorise('edit-draft');
  const { setOfferEnabled } = await import('../data/offers');
  await setOfferEnabled(key, enabled, toActor(user));
  revalidatePath('/offers');
}

/* ----------------------------------------------------------------- UPS export */

/**
 * Price an international export shipment on the UPS card.
 *
 * Read-only, like the Bluedart calculator: it resolves the destination, prices it and
 * hands back the breakdown. Nothing is stored, so this needs only the capability to see
 * rates rather than to change them.
 */
export async function quoteUpsAction(input: {
  product: import('../domain/ups').UpsProduct;
  countryCode: string;
  postalCode?: string;
  actualWeight: number;
  length?: number;
  breadth?: number;
  height?: number;
  accessorials?: string[];
}): Promise<import('../pricing/ups').UpsQuoteResult> {
  await authorise('run-calculator');
  const { liveCardsFromSource } = await import('../data/rate-cards');
  const { quoteUps } = await import('../pricing/ups');

  const [card] = await liveCardsFromSource('ups');
  const data = card?.data.ups;
  if (!data) {
    return {
      available: false,
      reason: 'unknown-country',
      message: 'The UPS rate card is not configured on this environment.',
    };
  }
  return quoteUps(input, data);
}

/* --------------------------------------------- customer master data review */

/**
 * Decide a proposed change to a customer's company details.
 *
 * Approving does two things that cannot be undone by editing a record back: it changes what
 * prints on a tax invoice, and it queues the customer for the core, where it decides who may
 * sign in to the enterprise portal. That is the whole reason this is a review rather than a
 * save.
 */
export async function decideProfileChange(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const user = await authorise('review-change-request');
  const id = String(form.get('id') ?? '');
  const verdict = String(form.get('verdict') ?? '');
  const comment = String(form.get('comment') ?? '').trim();

  try {
    const { approveProfileChange, rejectProfileChange } = await import(
      '../data/customer-profile-changes'
    );

    if (verdict === 'approve') {
      await approveProfileChange(id, toActor(user), comment || undefined);
    } else if (verdict === 'reject') {
      // A rejection without a reason is a dead end for whoever submitted it.
      if (!comment) return { error: 'Say why, so the person who submitted it can fix it.' };
      await rejectProfileChange(id, toActor(user), comment);
    } else {
      return { error: 'Choose approve or reject.' };
    }

    revalidatePath('/approvals', 'page');
    revalidatePath('/customers/[code]', 'page');
    return { ok: true as const };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not record that decision.' };
  }
}

/**
 * Send whatever is waiting for the core.
 *
 * Manual because there is no background worker here. Approving already queues the change;
 * this is the button for when the core was down at that moment and somebody wants to know
 * it has caught up.
 */
export async function sendQueuedToCore(): Promise<
  ActionResult & { sent?: number; failed?: number; configured?: boolean }
> {
  await authorise('review-change-request');
  try {
    const { drainToCore } = await import('../core/client');
    const report = await drainToCore();
    revalidatePath('/approvals', 'page');

    if (!report.configured) {
      return {
        error:
          'The core connection is not configured yet, so changes are queued. They will send once CORE_API_URL and its key are set.',
      };
    }
    return { ok: true as const, sent: report.sent, failed: report.failed, configured: true };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not reach the core.' };
  }
}

/* ------------------------------------------- customer contract negotiations */

/**
 * Decide a request a customer raised from the enterprise portal.
 *
 * Accepting widens their **draft** contract and drops any rates they proposed into it. It
 * does not change a price and does not go live — the existing contract approval does that.
 * Two gates on purpose: the customer's ask and the rate we set for it are different
 * decisions, made by different people, and rolling them together would let a customer's
 * request write a price.
 */
export async function decideContractRequest(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult & { widened?: string[] }> {
  const user = await authorise('review-change-request');
  const reference = String(form.get('reference') ?? '');
  const verdict = String(form.get('verdict') ?? '');
  const comment = String(form.get('comment') ?? '').trim();

  try {
    const { acceptContractRequest, declineContractRequest } = await import(
      '../data/contract-requests'
    );

    if (verdict === 'accept') {
      const decided = await acceptContractRequest(reference, toActor(user), comment || undefined);
      revalidatePath('/approvals', 'page');
      revalidatePath('/customers/[code]', 'page');
      return { ok: true as const, widened: decided.applied?.widened ?? [] };
    }

    if (verdict === 'decline') {
      // The customer reads this. "No" without a reason is how a request gets raised again
      // next week, identically.
      if (!comment) return { error: 'Say why — the customer sees this.' };
      await declineContractRequest(reference, toActor(user), comment);
      revalidatePath('/approvals', 'page');
      return { ok: true as const };
    }

    return { error: 'Choose accept or decline.' };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not record that decision.' };
  }
}

/* --------------------------------------------------------------- carriers */

/**
 * Save a carrier.
 *
 * A carrier is data now rather than a union in the code, so adding one is a row and not a
 * release. What still needs an engine is only a tariff we cannot already read — which is
 * what `rateStructure` records, and why it is a field rather than a guess.
 */
export async function saveCarrierRecord(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const user = await authorise('edit-draft');
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const carrierId = text('carrierId').toLowerCase();
  const name = text('name');

  if (!carrierId || !name) return { error: 'A code and a name are both required.' };
  if (!/^[a-z0-9-]+$/.test(carrierId)) {
    return { error: 'A carrier code is lower-case letters, numbers and hyphens.' };
  }

  const multiplier = text('rateMultiplier');
  const maxWeight = text('maxWeightKg');

  try {
    const { saveCarrier, findCarrier } = await import('../data/carriers');
    const existing = await findCarrier(carrierId);

    await saveCarrier(
      {
        carrierId,
        name,
        active: form.get('active') !== null,
        rateStructure: (text('rateStructure') || 'zoneWeight') as never,
        // Cards are attached by loading a rate card for the carrier, not typed in here.
        cardKeys: existing?.cardKeys ?? [],
        ...(text('contactEmail') ? { contactEmail: text('contactEmail') } : {}),
        ...(text('contactPhone') ? { contactPhone: text('contactPhone') } : {}),
        ...(text('cutoffTime') ? { cutoffTime: text('cutoffTime') } : {}),
        ...(maxWeight ? { maxWeightKg: Number(maxWeight) } : {}),
        dgCertified: form.get('dgCertified') !== null,
        ...(text('trackingUrlTemplate') ? { trackingUrlTemplate: text('trackingUrlTemplate') } : {}),
        ...(multiplier ? { rateMultiplier: Number(multiplier) } : {}),
        ...(text('notes') ? { notes: text('notes') } : {}),
      },
      toActor(user),
    );

    revalidatePath('/carriers', 'page');
    return { ok: true as const };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not save that carrier.' };
  }
}

export async function toggleCarrier(carrierId: string, active: boolean) {
  const user = await authorise('edit-draft');
  const { setCarrierActive } = await import('../data/carriers');
  await setCarrierActive(carrierId, active, toActor(user));
  revalidatePath('/carriers', 'page');
}

/* --------------------------------------------------------------- services */

/**
 * Save a service.
 *
 * A service is a network plus a multiplier plus a promise about transit. Adding one is
 * arithmetic on a tariff that already exists, which is why this is editable while the four
 * networks underneath it are not.
 */
export async function saveServiceRecord(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const user = await authorise('edit-draft');
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const key = text('key').toLowerCase();

  if (!key || !text('name')) return { error: 'A key and a name are both required.' };
  if (!/^[a-z0-9-]+$/.test(key)) {
    return { error: 'A service key is lower-case letters, numbers and hyphens.' };
  }

  const transit = text('transitAdjustmentDays');
  const gstRate = text('gstRate');

  try {
    const { saveService } = await import('../data/services');
    await saveService(
      {
        key,
        name: text('name'),
        mode: (text('mode') || 'surface') as never,
        active: form.get('active') !== null,
        multiplier: Number(text('multiplier') || '1'),
        ...(transit ? { transitAdjustmentDays: Number(transit) } : {}),
        ...(text('sacCode') ? { sacCode: text('sacCode') } : {}),
        ...(gstRate ? { gstRate: Number(gstRate) } : {}),
        ...(text('description') ? { description: text('description') } : {}),
      },
      toActor(user),
    );

    revalidatePath('/services', 'page');
    return { ok: true as const };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not save that service.' };
  }
}

export async function removeService(key: string) {
  const user = await authorise('edit-draft');
  const { deleteService } = await import('../data/services');
  await deleteService(key, toActor(user));
  revalidatePath('/services', 'page');
}

/* ------------------------------------------------------------- collections */

/**
 * Record money arriving.
 *
 * Typed by our staff, because nothing tells us. The core's only payment path is a demo
 * button — Razorpay is an enum value there with nothing behind it — so a real bank
 * transfer reaches this system when somebody enters it.
 *
 * Recorded as a draft, allocated oldest-first if asked, and changeable until it is posted.
 */
export async function recordReceiptAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const user = await authorise('record-money');
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const customerCode = text('customerCode');
  const amount = Number(text('amount'));

  if (!customerCode) return { error: 'Which customer sent it?' };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'An amount is required, and it has to be more than nothing.' };
  }

  try {
    const { recordReceipt } = await import('../data/collections');
    const { findCustomer } = await import('../data/customers');
    const { DEFAULT_COMMERCIAL_TERMS } = await import('../domain/customers');

    const customer = await findCustomer(customerCode);
    if (!customer) return { error: `No customer ${customerCode}.` };
    const terms = customer.commercial ?? DEFAULT_COMMERCIAL_TERMS;

    const received = text('receivedAt');
    await recordReceipt({
      customerCode: customer.code,
      amountPaise: Math.round(amount * 100),
      receivedAt: received ? new Date(received) : new Date(),
      ...(text('instrument') ? { instrument: text('instrument') } : {}),
      ...(text('note') ? { note: text('note') } : {}),
      autoAllocate: form.get('autoAllocate') !== null,
      paymentTermsDays: terms.paymentTermsDays,
      actor: toActor(user),
    });

    revalidatePath('/collections', 'page');
    return { ok: true as const };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not record that receipt.' };
  }
}


/* -------------------------------------------------------- billing periods */

/**
 * Reopen a billed period, with a reason.
 *
 * The reason is required and is the point: a period that drifted back to open because a
 * late shipment arrived would defeat what freezing is for. Somebody decides, and says why,
 * and that sentence is what is read when the restatement is questioned later.
 */
export async function reopenPeriodAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const user = await authorise('record-money');
  const customerCode = String(form.get('customerCode') ?? '').trim();
  const from = String(form.get('from') ?? '').trim();
  const reason = String(form.get('reason') ?? '').trim();

  if (!reason) return { error: 'Say why this period is being reopened.' };

  try {
    const { reopenPeriod } = await import('../data/billing-periods');
    await reopenPeriod(customerCode, new Date(from), reason, toActor(user));
    revalidatePath('/periods', 'page');
    return { ok: true as const };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not reopen that period.' };
  }
}

/** Close a reopened period, recording what the correction did to the total. */
export async function relockPeriodAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const user = await authorise('record-money');
  const customerCode = String(form.get('customerCode') ?? '').trim();
  const from = String(form.get('from') ?? '').trim();
  const corrected = Number(String(form.get('asCorrected') ?? '').trim());

  if (!Number.isFinite(corrected) || corrected < 0) {
    return { error: 'What does the period total now? That is the figure being compared.' };
  }

  try {
    const { relockPeriod } = await import('../data/billing-periods');
    await relockPeriod(customerCode, new Date(from), Math.round(corrected * 100), toActor(user));
    revalidatePath('/periods', 'page');
    return { ok: true as const };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not close that period.' };
  }
}

/* ---------------------------------------------------------------- bill run */

/**
 * What the bill run would do, without doing it.
 *
 * Separate from running it because raising an invoice allocates a number from a series
 * that can never reuse it. Seeing the shape of the bill first is the difference between a
 * decision and a discovery.
 */
export async function previewBill(customerCode: string, from: string, to: string) {
  await authorise('record-money');
  const { previewBillRun } = await import('../data/bill-run');
  return previewBillRun(customerCode, new Date(from), new Date(to));
}

export async function runBillingAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult & { invoices?: string[]; total?: number; held?: number }> {
  const user = await authorise('record-money');
  const customerCode = String(form.get('customerCode') ?? '').trim();
  const from = String(form.get('from') ?? '').trim();
  const to = String(form.get('to') ?? '').trim();

  if (!customerCode || !from || !to) {
    return { error: 'Choose a customer and a period.' };
  }

  try {
    const { runBilling, previewBillRun } = await import('../data/bill-run');
    const preview = await previewBillRun(customerCode, new Date(from), new Date(to));
    const result = await runBilling(customerCode, new Date(from), new Date(to), toActor(user));

    revalidatePath('/invoices', 'page');
    revalidatePath('/periods', 'page');
    revalidatePath('/collections', 'page');

    return {
      ok: true as const,
      invoices: result.invoiceNumbers,
      total: result.totalPaise / 100,
      held: preview.held.length,
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'The bill run did not complete.' };
  }
}

/**
 * What corrections are open on an invoice, for the screen to show before anybody commits.
 *
 * Separate from issuing because the route is decided rather than chosen: somebody typing an
 * amount needs to see that withdrawing a part-paid invoice will produce a full-value credit
 * note, not a cancellation, while they can still change their mind.
 */
export async function correctionOptions(invoiceNumber: string) {
  await authorise('record-money');
  const { correctionOptionsFor } = await import('../data/notes');
  return correctionOptionsFor(invoiceNumber);
}

/**
 * Correct an issued invoice.
 *
 * The route is decided from the amount and the invoice's state, not chosen here — see
 * `billing/corrections.ts`. The result says which route was taken, because asking to
 * withdraw an invoice that cannot be cancelled produces a full-value credit note instead,
 * and that should be visible rather than surprising.
 */
export async function correctInvoice(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult & { route?: string; noteNumber?: string }> {
  const user = await authorise('record-money');
  const invoiceNumber = String(form.get('invoiceNumber') ?? '').trim();
  const reason = String(form.get('reason') ?? '').trim();
  const delta = Number(String(form.get('delta') ?? '0'));
  const withdraw = form.get('withdraw') !== null;

  if (!reason) return { error: 'Say why this invoice is being corrected.' };
  if (!withdraw && (!Number.isFinite(delta) || delta === 0)) {
    return { error: 'By how much? A correction of nothing is not a correction.' };
  }

  try {
    const { issueCorrection } = await import('../data/notes');
    const result = await issueCorrection({
      invoiceNumber,
      deltaRupees: withdraw ? 0 : delta,
      reason,
      withdrawEntirely: withdraw,
      actor: toActor(user),
    });

    revalidatePath('/invoices', 'page');
    return {
      ok: true as const,
      route: result.route,
      ...(result.note ? { noteNumber: result.note.number } : {}),
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Could not correct that invoice.' };
  }
}
