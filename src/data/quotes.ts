import { ObjectId } from 'mongodb';
import { createHash, randomBytes } from 'node:crypto';
import { db, COLLECTIONS } from './mongo';

/**
 * Every quote we answer, kept so the number can be explained again later.
 *
 * The platform handbook asks for this outright: return an identifier for the quote, not
 * just a number, because "six weeks later someone will ask why a consignment was charged
 * what it was, and 'the rate card said so at the time' needs to be provable".
 *
 * Provable is the operative word, and it is why this stores more than the answer:
 *
 *   The card and its version. A rate card is edited and approved over time. Knowing
 *   a quote came from model-1 is nearly useless; knowing it came from model-1 version 7
 *   means the exact numbers can be read back even after version 8 replaced them.
 *
 *   A fingerprint of the contract terms applied. A contracted quote is the base card
 *   plus that customer's negotiated cells, and those get renegotiated. The hash says
 *   whether the terms in force today are the terms that produced this price — which is
 *   the actual question in a billing dispute, and one that a customer code alone cannot
 *   answer.
 *
 *   Every tier we returned, not only the one booked. The core asks for all services
 *   and picks one; if we kept only the picked one we could not answer "why was express
 *   cheaper than economy that day".
 *
 * Nothing here is deleted on a timer. A TTL index would be the tidy choice and the wrong
 * one: the whole purpose of the record is to survive until somebody disputes an invoice,
 * and that is exactly when a quiet expiry would have removed it.
 */

export interface QuoteRequestRecord {
  originPincode: number;
  destinationPincode: number;
  actualWeight: number;
  dimensionsCm?: { length?: number; breadth?: number; height?: number };
  /**
   * A chargeable weight the caller supplied rather than one we derived.
   *
   * Recorded separately from the weight we computed so the two are never confused. If the
   * core starts sending its own, a disagreement is visible in the record instead of
   * showing up as an invoice that does not match a quote.
   */
  chargeableWeightSupplied?: number;
  customerCode?: string;
  declaredValue?: number;
  codValue?: number;
  transportMode?: string;
}

export interface QuoteTierRecord {
  service: string;
  mode: string;
  total: number;
  chargeableWeight: number;
  /** The full breakdown as it went over the wire, so the answer can be reproduced exactly. */
  breakdown: Record<string, unknown>;
}

export interface PricedAgainst {
  cardKey: string;
  cardName: string;
  /** The live version at the moment of quoting. Absent only for a card with no version. */
  cardVersion?: number;
  customerCode?: string;
  /** Short hash of the contract terms applied. Absent when no contract was involved. */
  contractFingerprint?: string;
  /** How many negotiated cells were in force. Cheap to read, unlike the hash. */
  contractOverrides?: number;
}

/**
 * How long a quote may be relied on.
 *
 * Rates and fuel move, so a price quoted three weeks ago is not a price today. The core's
 * own draft carries `validUntil` for exactly this reason. Seven days is the default
 * because a booking desk works within a week; anything longer would be a commitment
 * nobody made.
 */
export const QUOTE_VALID_DAYS = 7;

export interface QuoteDoc {
  _id: ObjectId;
  quoteId: string;
  createdAt: Date;
  /** After this the quote must be asked for again. */
  validUntil: Date;
  /** Which caller asked. Useful when two integrations disagree about the same lane. */
  caller?: string;
  request: QuoteRequestRecord;
  pricedAgainst: PricedAgainst;
  tiers: QuoteTierRecord[];
}

async function quotes() {
  return (await db()).collection<QuoteDoc>(COLLECTIONS.quotes);
}

/**
 * Crockford base32, minus the letters that get misread aloud or in a scan (I, L, O, U).
 * These identifiers end up on invoices and in support emails, so a person will read one
 * out and another will type it back.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * `QT-20260820-7F3KQ92M`.
 *
 * The date is for the human reading it; the eight random characters are what make it
 * unique and unguessable. Crypto-random rather than `Math.random`, because this
 * identifies a commercial commitment: a predictable reference is one an outsider can walk
 * to read other customers' prices.
 */
export function newQuoteId(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const bytes = randomBytes(8);
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte % ALPHABET.length];
  return `QT-${day}-${suffix}`;
}

/**
 * A stable short hash of whatever priced this quote beyond the card itself.
 *
 * Keys are sorted so the same terms always hash the same regardless of the order Mongo
 * happened to return them in — without that, the fingerprint would change for reasons
 * that have nothing to do with the terms.
 */
export function fingerprint(terms: unknown): string {
  const canonical = JSON.stringify(terms, (_key, value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
  return createHash('sha256').update(canonical ?? 'null').digest('hex').slice(0, 12);
}

/** Store one answered quote and return the identifier to hand back to the caller. */
export async function recordQuote(input: {
  request: QuoteRequestRecord;
  pricedAgainst: PricedAgainst;
  tiers: QuoteTierRecord[];
  caller?: string;
}): Promise<{ quoteId: string; validUntil: Date }> {
  const now = new Date();
  const doc: QuoteDoc = {
    _id: new ObjectId(),
    quoteId: newQuoteId(),
    createdAt: now,
    validUntil: new Date(now.getTime() + QUOTE_VALID_DAYS * 24 * 60 * 60 * 1000),
    ...(input.caller === undefined ? {} : { caller: input.caller }),
    request: input.request,
    pricedAgainst: input.pricedAgainst,
    tiers: input.tiers,
  };
  await (await quotes()).insertOne(doc);
  return { quoteId: doc.quoteId, validUntil: doc.validUntil };
}

/** One quote by its identifier, for re-explaining a charge. */
export async function quoteById(quoteId: string): Promise<QuoteDoc | null> {
  return (await quotes()).findOne({ quoteId });
}

/** The most recent quotes, for the rate audit. Newest first. */
export async function recentQuotes(limit = 100): Promise<QuoteDoc[]> {
  return (await quotes()).find().sort({ createdAt: -1 }).limit(limit).toArray();
}
