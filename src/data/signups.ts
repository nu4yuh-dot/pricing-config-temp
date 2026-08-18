import { ObjectId, type Collection } from 'mongodb';
import { db, COLLECTIONS } from './mongo';
import { recordAudit } from './audit';
import type { Actor } from './workflow';
import { codeFor, type Signup } from '../domain/signups';
import { findCustomer, registerCustomer, setCustomerTags } from './customers';
import { findProduct, applyProductToCustomer } from './products';

/**
 * Signups from the public website.
 *
 * Held in their own collection rather than as inactive customers, because a signup is not
 * yet a customer — it is a request to become one. Keeping them apart means the customer
 * book cannot fill with rows nobody has looked at, and "how many customers do we have"
 * keeps its answer.
 */

export interface SignupDoc extends Signup {
  _id: ObjectId;
}

async function signups(): Promise<Collection<SignupDoc>> {
  return (await db()).collection<SignupDoc>(COLLECTIONS.signups);
}

export async function listSignups(status?: Signup['status']): Promise<SignupDoc[]> {
  return (await signups())
    .find(status ? { status } : {})
    .sort({ signedUpAt: -1 })
    .toArray();
}

export async function findSignup(reference: string): Promise<SignupDoc | null> {
  return (await signups()).findOne({ reference });
}

function reference(): string {
  return `SU-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** Record a signup. Nothing is priced and nobody can book until a person activates it. */
export async function recordSignup(
  input: Omit<Signup, 'reference' | 'status' | 'signedUpAt'>,
): Promise<SignupDoc> {
  const doc: SignupDoc = {
    _id: new ObjectId(),
    ...input,
    reference: reference(),
    status: 'waiting',
    signedUpAt: new Date(),
  };

  await (await signups()).insertOne(doc);
  return doc;
}

export interface ActivationResult {
  reference: string;
  customerCode: string;
  /** Cells the product wrote into their draft contract. */
  applied: number;
  /** Set when the signup could not be activated, and why. */
  skipped?: string;
}

/**
 * Turn a signup into a customer on a product.
 *
 * The product's terms land in the customer's draft, exactly as they would if somebody had
 * assigned it by hand, and go through the same approval. "Ready to book in one click" is
 * about the data entry, not about the review — a self-serve account priced from a
 * standard product still has a person behind the decision to sell it.
 */
export async function activateSignup(input: {
  reference: string;
  productKey: string;
  baseCardKey: string;
  actor: Actor;
}): Promise<ActivationResult> {
  const signup = await findSignup(input.reference);
  if (!signup) throw new Error(`signup ${input.reference} not found`);
  if (signup.status !== 'waiting') {
    return {
      reference: input.reference,
      customerCode: signup.customerCode ?? '',
      applied: 0,
      skipped: `already ${signup.status}`,
    };
  }

  const product = await findProduct(input.productKey);
  if (!product) throw new Error(`product ${input.productKey} not found`);

  // A code derived from the name can collide with a customer already on the book. Numbering
  // beats guessing: it is obvious afterwards which two names were similar.
  const wanted = codeFor(signup.legalName);
  if (wanted === '') throw new Error(`“${signup.legalName}” has no usable customer code in it.`);

  let code = wanted;
  for (let suffix = 2; (await findCustomer(code)) !== null; suffix++) {
    code = `${wanted}${suffix}`;
    if (suffix > 50) throw new Error(`could not find a free code near ${wanted}`);
  }

  const { customer } = await registerCustomer({
    code,
    name: signup.legalName,
    baseCardKey: input.baseCardKey,
    source: 'api',
    actor: input.actor,
  });

  if (signup.gstin || signup.addressLine) {
    const { saveProfile } = await import('./customers');
    const { EMPTY_PROFILE, EMPTY_ADDRESS } = await import('../domain/company');
    await saveProfile(
      customer.code,
      {
        ...EMPTY_PROFILE,
        legalName: signup.legalName,
        ...(signup.gstin ? { gstin: signup.gstin } : {}),
        ...(signup.pan ? { pan: signup.pan } : {}),
        ...(signup.addressLine
          ? { registeredAddress: { ...EMPTY_ADDRESS, line1: signup.addressLine } }
          : {}),
      },
      input.actor,
    );
  }

  // Tagged with the product's segment, so the next thing sold to that segment reaches them
  // too. A customer who arrived through a product but belongs to no segment would be
  // invisible to every later offer.
  if (product.segment) await setCustomerTags(customer.code, [product.segment], input.actor);

  const applied = await applyProductToCustomer({
    productKey: input.productKey,
    customerCode: customer.code,
    mode: 'fill-gaps',
    actor: input.actor,
  });

  await (await signups()).updateOne(
    { reference: input.reference },
    {
      $set: {
        status: 'activated',
        customerCode: customer.code,
        decidedBy: input.actor.name,
        decidedAt: new Date(),
      },
    },
  );
  await recordAudit({
    action: 'signup-activated',
    actor: input.actor,
    at: new Date(),
    detail: {
      signup: input.reference,
      customer: customer.code,
      product: input.productKey,
      applied: applied.applied,
    },
  });

  return { reference: input.reference, customerCode: customer.code, applied: applied.applied };
}

export async function rejectSignup(
  reference: string,
  why: string,
  actor: Actor,
): Promise<void> {
  const signup = await findSignup(reference);
  if (!signup) throw new Error(`signup ${reference} not found`);

  await (await signups()).updateOne(
    { reference },
    {
      $set: {
        status: 'rejected',
        rejectedReason: why.trim(),
        decidedBy: actor.name,
        decidedAt: new Date(),
      },
    },
  );
  await recordAudit({
    action: 'signup-rejected',
    actor,
    at: new Date(),
    detail: { signup: reference, reason: why.trim() },
  });
}
