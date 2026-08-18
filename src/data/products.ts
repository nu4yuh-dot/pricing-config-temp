import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import type { Actor } from './workflow';
import { productTerms, productFitsSegment, type Product } from '../domain/products';
import { applyTemplate, type ApplyMode } from '../domain/templates';
import { findTemplate } from './templates';
import {
  findCustomer,
  listCustomers,
  editDraftContract,
  editDraftScope,
  setDraftOverrides,
} from './customers';
import type { Mode } from '../domain/types';

/**
 * Products are stored, unlike the charge library, which is derived.
 *
 * The library could be derived because every charge it lists is already written on a card
 * or a contract — deriving it meant it could not disagree with what is billed. A product
 * has no such shadow: "these three charges and that template are sold together as
 * E-commerce parcel" exists nowhere else, and nothing downstream records that a product
 * was involved. It is a stored decision about how to sell, not a reading of prices.
 *
 * Which is also why it needs no approval workflow of its own. A product prices nobody
 * until it is applied, and applying it writes ordinary draft overrides that go to an
 * approver like any other negotiation.
 */

export interface ProductDoc extends Product {
  _id: ObjectId;
  createdBy: string;
  createdAt: Date;
}

async function products(): Promise<Collection<ProductDoc>> {
  return (await db()).collection<ProductDoc>(COLLECTIONS.products);
}

export async function listProducts(): Promise<ProductDoc[]> {
  return (await products()).find().sort({ name: 1 }).toArray();
}

export async function findProduct(key: string): Promise<ProductDoc | null> {
  return (await products()).findOne({ key });
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function createProduct(input: {
  name: string;
  description: string;
  templateKey: string;
  charges: string[];
  modes?: Mode[];
  segment?: string;
  actor: Actor;
}): Promise<ProductDoc> {
  const key = slug(input.name);
  if (key === '') throw new Error('A product needs a name.');
  if (input.templateKey === '') {
    throw new Error('A product is priced from a template, so it needs one.');
  }
  if (await findProduct(key)) {
    throw new Error(`A product called “${input.name}” already exists.`);
  }

  const segment = input.segment?.trim();

  const doc: ProductDoc = {
    _id: new ObjectId(),
    key,
    name: input.name.trim(),
    description: input.description.trim(),
    templateKey: input.templateKey,
    // Deduplicated: the same charge attached twice would write the same `active` cell
    // twice and read as two terms in the catalog.
    charges: [...new Set(input.charges)],
    ...(input.modes && input.modes.length > 0 ? { modes: input.modes } : {}),
    ...(segment ? { segment } : {}),
    createdBy: input.actor.name,
    createdAt: new Date(),
  };

  await (await products()).insertOne(doc);
  await recordAudit({
    action: 'product-created',
    actor: input.actor,
    at: doc.createdAt,
    detail: {
      product: key,
      template: input.templateKey,
      charges: doc.charges.length,
      ...(segment ? { segment } : {}),
    },
  });
  return doc;
}

/** What happened to one customer when a product was applied. */
export interface ProductApplication {
  customerCode: string;
  customerName: string;
  /** Cells taken from the product. */
  applied: number;
  /** Cells left as the customer had already negotiated them. Only for `fill-gaps`. */
  kept: number;
  /** Set when nothing was written, and why. */
  skipped?: string;
}

/**
 * Put a product onto one customer's draft contract.
 *
 * The same landing as a template, deliberately: the product is turned into ordinary
 * override cells first, and from there nothing can tell it apart from terms typed by
 * hand. It lands in the draft, so applying a product is never a way to move a price
 * without review.
 */
export async function applyProductToCustomer(input: {
  productKey: string;
  customerCode: string;
  mode: ApplyMode;
  actor: Actor;
}): Promise<ProductApplication> {
  const product = await findProduct(input.productKey);
  if (!product) throw new Error(`product ${input.productKey} not found`);

  const template = await findTemplate(product.templateKey);
  if (!template) {
    throw new Error(
      `${product.name} is priced from the template “${product.templateKey}”, which does not ` +
        `exist. Applying it would write nothing.`,
    );
  }

  const customer = await findCustomer(input.customerCode);
  if (!customer) throw new Error(`customer ${input.customerCode} not found`);

  const identity = { customerCode: customer.code, customerName: customer.name };

  if (customer.baseCardKey !== template.baseCardKey) {
    // The same reason a template refuses: an override path means a cell on a particular
    // card, and the same path on another card is a different rate.
    return {
      ...identity,
      applied: 0,
      kept: 0,
      skipped: `priced from ${customer.baseCardKey}, but this product is written against ${template.baseCardKey}`,
    };
  }
  if (customer.pendingProposalId) {
    return { ...identity, applied: 0, kept: 0, skipped: 'a proposal is already with an approver' };
  }

  const terms = productTerms(product, template);
  const result = applyTemplate(
    { ...template, overrides: terms.overrides, scope: terms.scope },
    { overrides: customer.draftTerms.overrides, scope: customer.draftTerms.scope },
    input.mode,
  );

  // Provenance before the write, so a failure part-way cannot leave a customer claiming a
  // product whose rates never landed.
  await (await db()).collection(COLLECTIONS.customers).updateOne(
    { code: customer.code },
    {
      $set: {
        appliedProduct: {
          key: product.key,
          name: product.name,
          mode: input.mode,
          appliedAt: new Date(),
          appliedBy: input.actor.name,
        },
      },
    },
  );

  if (input.mode === 'replace') {
    await setDraftOverrides(customer.code, result.overrides, input.actor);
  } else {
    await editDraftContract(
      customer.code,
      Object.entries(result.overrides).map(([bind, value]) => ({ bind, value })),
      input.actor,
    );
  }
  await editDraftScope(customer.code, result.scope, input.actor);

  await recordAudit({
    action: 'product-applied',
    actor: input.actor,
    at: new Date(),
    detail: {
      product: product.key,
      customer: customer.code,
      mode: input.mode,
      applied: result.applied.length,
      kept: result.kept.length,
    },
  });

  return { ...identity, applied: result.applied.length, kept: result.kept.length };
}

/**
 * Put a product onto every customer in its segment.
 *
 * One draft per customer, each reviewed on its own — a segment is a way to start the same
 * conversation with twelve people, not a way to approve twelve contracts at once.
 *
 * A customer who cannot take it is skipped and reported rather than aborting the run. The
 * alternative — stopping at the first mismatch — would leave a segment half applied with
 * no record of where it stopped, which is worse than either outcome.
 */
export async function applyProductToSegment(input: {
  productKey: string;
  mode: ApplyMode;
  actor: Actor;
}): Promise<ProductApplication[]> {
  const product = await findProduct(input.productKey);
  if (!product) throw new Error(`product ${input.productKey} not found`);

  const customers = (await listCustomers()).filter((customer) =>
    productFitsSegment(product, customer),
  );

  const results: ProductApplication[] = [];
  for (const customer of customers) {
    try {
      results.push(
        await applyProductToCustomer({
          productKey: input.productKey,
          customerCode: customer.code,
          mode: input.mode,
          actor: input.actor,
        }),
      );
    } catch (problem) {
      results.push({
        customerCode: customer.code,
        customerName: customer.name,
        applied: 0,
        kept: 0,
        skipped: problem instanceof Error ? problem.message : 'could not be applied',
      });
    }
  }
  return results;
}

/** Who a product would reach, for showing a count before anything is written. */
export async function segmentMembers(product: Product): Promise<{ code: string; name: string }[]> {
  return (await listCustomers())
    .filter((customer) => productFitsSegment(product, customer))
    .map((customer) => ({ code: customer.code, name: customer.name }));
}
