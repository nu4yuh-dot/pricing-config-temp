import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import type { Actor } from './workflow';
import { applyTemplate, type ApplyMode, type RateTemplate } from '../domain/templates';
import { resolveTemplateParameters } from '../domain/template-fit';
import {
  findCustomer,
  editDraftContract,
  editDraftScope,
  setDraftOverrides,
} from './customers';
import type { ContractScope, Overrides } from '../domain/customers';

export interface RateTemplateDoc extends RateTemplate {
  _id: ObjectId;
}

async function templates(): Promise<Collection<RateTemplateDoc>> {
  return (await db()).collection<RateTemplateDoc>(COLLECTIONS.rateTemplates);
}

export async function listTemplates(): Promise<RateTemplateDoc[]> {
  return (await templates()).find().sort({ name: 1 }).toArray();
}

export async function findTemplate(key: string): Promise<RateTemplateDoc | null> {
  return (await templates()).findOne({ key });
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function createTemplate(input: {
  name: string;
  description: string;
  baseCardKey: string;
  overrides: Overrides;
  scope: ContractScope;
  actor: Actor;
  derivedFromCustomer?: string;
}): Promise<RateTemplateDoc> {
  const key = slug(input.name);
  if (key === '') throw new Error('A template needs a name.');
  if (await findTemplate(key)) {
    throw new Error(`A template called "${input.name}" already exists.`);
  }

  const doc: RateTemplateDoc = {
    _id: new ObjectId(),
    key,
    name: input.name.trim(),
    description: input.description.trim(),
    baseCardKey: input.baseCardKey,
    overrides: input.overrides,
    scope: input.scope,
    createdBy: input.actor.name,
    createdAt: new Date(),
    ...(input.derivedFromCustomer ? { derivedFromCustomer: input.derivedFromCustomer } : {}),
  };

  await (await templates()).insertOne(doc);
  await recordAudit({
    action: 'template-created',
    actor: input.actor,
    at: doc.createdAt,
    detail: {
      template: key,
      cells: Object.keys(input.overrides).length,
      ...(input.derivedFromCustomer ? { from: input.derivedFromCustomer } : {}),
    },
  });
  return doc;
}

/**
 * Save a customer's approved contract as a reusable template.
 *
 * This is the "copy what already works" path: negotiate once, then assign the same
 * shape to the next similar customer rather than rebuilding it.
 */
export async function templateFromCustomer(input: {
  customerCode: string;
  name: string;
  description: string;
  actor: Actor;
}): Promise<RateTemplateDoc> {
  const customer = await findCustomer(input.customerCode);
  if (!customer) throw new Error(`customer ${input.customerCode} not found`);
  if (Object.keys(customer.liveTerms.overrides).length === 0) {
    throw new Error(
      `${customer.code} has no negotiated terms yet, so there is nothing to save as a template.`,
    );
  }

  return createTemplate({
    name: input.name,
    description: input.description,
    baseCardKey: customer.baseCardKey,
    // The approved terms, not the draft: a template should capture what was agreed.
    overrides: customer.liveTerms.overrides,
    scope: customer.liveTerms.scope,
    actor: input.actor,
    derivedFromCustomer: customer.code,
  });
}

/**
 * Update a template's negotiated cells and coverage.
 *
 * A template is the same shape as a contract — a base card plus the cells that differ —
 * so the contract editors work on one unchanged. Kept separate from `createTemplate` so
 * the name and base card, which other templates and customers may already refer to,
 * cannot be changed by an edit to the rates.
 */
export async function updateTemplateTerms(input: {
  key: string;
  overrides: Overrides;
  scope: ContractScope;
  actor: Actor;
}): Promise<RateTemplateDoc> {
  const existing = await findTemplate(input.key);
  if (!existing) throw new Error(`template ${input.key} not found`);

  await (await templates()).updateOne(
    { key: input.key },
    { $set: { overrides: input.overrides, scope: input.scope } },
  );
  await recordAudit({
    action: 'template-created',
    actor: input.actor,
    at: new Date(),
    detail: { template: input.key, cells: Object.keys(input.overrides).length, edited: true },
  });
  return { ...existing, overrides: input.overrides, scope: input.scope };
}

/**
 * Mark which of a template's cells are parameters.
 *
 * Separate from the rates for the same reason the name and base card are: assignments
 * already made are unaffected, and changing what a field *means* is a different act from
 * changing what it says.
 */
export async function updateTemplateParameters(input: {
  key: string;
  parameters: string[];
  actor: Actor;
}): Promise<void> {
  const existing = await findTemplate(input.key);
  if (!existing) throw new Error(`template ${input.key} not found`);

  // Only cells the template actually holds. A parameter naming a path the template does
  // not set would ask a customer for a value and then have nowhere to put it.
  const parameters = input.parameters.filter((bind) => bind in existing.overrides);

  await (await templates()).updateOne({ key: input.key }, { $set: { parameters } });
  await recordAudit({
    action: 'template-created',
    actor: input.actor,
    at: new Date(),
    detail: { template: input.key, parameters: parameters.length, marked: true },
  });
}

export async function deleteTemplate(key: string, actor: Actor): Promise<void> {
  const result = await (await templates()).deleteOne({ key });
  if (result.deletedCount === 0) throw new Error(`template ${key} not found`);
  await recordAudit({ action: 'template-deleted', actor, at: new Date(), detail: { template: key } });
}

/**
 * Put a template onto a customer's draft contract.
 *
 * Lands in the draft like any other edit, so it still needs approval — assigning a
 * template must not be a way to move prices without review.
 */
export async function applyTemplateToCustomer(input: {
  templateKey: string;
  customerCode: string;
  mode: ApplyMode;
  actor: Actor;
  /** Values for the template's parameters, by bind path. Unanswered ones are not written. */
  answers?: Record<string, string | number | null>;
}): Promise<{ applied: number; kept: number; unanswered: number }> {
  const template = await findTemplate(input.templateKey);
  if (!template) throw new Error(`template ${input.templateKey} not found`);

  const customer = await findCustomer(input.customerCode);
  if (!customer) throw new Error(`customer ${input.customerCode} not found`);
  if (customer.baseCardKey !== template.baseCardKey) {
    throw new Error(
      `${customer.code} is priced from ${customer.baseCardKey} but this template is written ` +
        `against ${template.baseCardKey}. The overrides would not mean the same thing.`,
    );
  }

  // Parameters are resolved before anything is compared, so an unanswered one is absent
  // from the assignment entirely rather than landing as the template author's example.
  const overrides = resolveTemplateParameters(template, input.answers ?? {});
  const unanswered = Object.keys(template.overrides).length - Object.keys(overrides).length;

  const result = applyTemplate(
    { ...template, overrides },
    { overrides: customer.draftTerms.overrides, scope: customer.draftTerms.scope },
    input.mode,
  );

  const dropped =
    input.mode === 'replace'
      ? Object.keys(customer.draftTerms.overrides).filter((path) => !(path in result.overrides))
      : [];

  // Provenance: which standard offer this contract was built from. Recorded before the
  // overrides are written so a failure part-way cannot leave a customer claiming a
  // template whose rates never landed.
  await (await db()).collection(COLLECTIONS.customers).updateOne(
    { code: customer.code },
    {
      $set: {
        appliedTemplate: {
          key: template.key,
          name: template.name,
          mode: input.mode,
          appliedAt: new Date(),
          appliedBy: input.actor.name,
        },
      },
    },
  );

  if (input.mode === 'replace') {
    // Wholesale, so overrides the template does not mention are truly removed. A
    // list of edits could not express that: null would mark those lanes not carried.
    await setDraftOverrides(input.customerCode, result.overrides, input.actor);
  } else {
    await editDraftContract(
      input.customerCode,
      Object.entries(result.overrides).map(([bind, value]) => ({ bind, value })),
      input.actor,
    );
  }
  await editDraftScope(input.customerCode, result.scope, input.actor);

  await recordAudit({
    action: 'template-applied',
    actor: input.actor,
    at: new Date(),
    detail: {
      template: template.key,
      customer: customer.code,
      mode: input.mode,
      applied: result.applied.length,
      kept: result.kept.length,
      dropped: dropped.length,
      unanswered,
    },
  });

  return { applied: result.applied.length, kept: result.kept.length, unanswered };
}
