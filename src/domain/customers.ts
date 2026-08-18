import type { Mode, StoredMode } from './types';
import type { StoredLaneRule } from './lane-rule-store';
import type { BindPath } from '../sheets/types';

/**
 * Customer contracts.
 *
 * A contract customer is priced from a base rate card plus a sparse set of
 * overrides. Only the cells that genuinely differ are stored — a customer who has
 * negotiated four lanes carries four overrides, not a 4,104-cell copy of the card.
 * That keeps every customer automatically in step with base-card changes on the
 * cells they have not negotiated.
 */

/** A sparse map of bind path to agreed value. Anything absent falls back to base. */
export type Overrides = Record<BindPath, string | number | null>;

/** `surface:PNQ>NCR`. Stable, sortable, and cheap to hold in a Set. */
export type LaneKey = string;

export function laneKey(mode: StoredMode, origin: string, destination: string): LaneKey {
  return `${mode}:${origin}>${destination}`;
}

export function parseLaneKey(key: LaneKey): {
  mode: StoredMode;
  origin: string;
  destination: string;
} {
  const [mode, lane] = key.split(':');
  const [origin, destination] = (lane ?? '').split('>');
  return {
    mode: mode as StoredMode,
    origin: origin ?? '',
    destination: destination ?? '',
  };
}

/**
 * A weight band the customer has contracted, as a half-open interval `[from, to)`.
 * `to: null` means unbounded.
 */
export interface WeightBand {
  from: number;
  to: number | null;
}

/**
 * What a customer's contract actually covers.
 *
 * Every field is nullable, and `null` means "no restriction" rather than "nothing".
 * A fresh customer starts entirely unrestricted, matching the base card, and the
 * team narrows it as the contract is agreed.
 */
export interface ContractScope {
  modes: Mode[] | null;
  lanes: LaneKey[] | null;
  weightBands: WeightBand[] | null;
}

export const UNRESTRICTED_SCOPE: ContractScope = {
  modes: null,
  lanes: null,
  weightBands: null,
};

export type CustomerStatus = 'active' | 'suspended';

/**
 * How the customer is billed for GST.
 *
 * FORWARD: we charge GST on the invoice and remit it.
 * RCM: reverse charge — the customer accounts for the GST themselves, so it is not
 * added to the quote. This changes the total a customer sees, which is why it lives
 * on the contract rather than in an accounting system.
 */
export type BillingType = 'FORWARD' | 'RCM';

/**
 * Commercial terms that affect what a quote shows.
 *
 * Deliberately narrow. Wallets, recharges and invoice generation belong to the
 * booking platform; what belongs here is only what changes a price.
 */
export interface CommercialTerms {
  billingType: BillingType;
  /** False for an exempt customer (SEZ, export). GST is then not added at all. */
  gstApplicable: boolean;
  /** Days from invoice to payment. Reference for the sales team, not enforced here. */
  paymentTermsDays: number;
  /** Reference only; enforcement belongs to the booking platform. */
  creditLimit: number | null;
}

export const DEFAULT_COMMERCIAL_TERMS: CommercialTerms = {
  billingType: 'FORWARD',
  gstApplicable: true,
  paymentTermsDays: 30,
  creditLimit: null,
};

export interface Customer {
  /** The identifier the booking website knows this customer by. */
  code: string;
  name: string;
  /** Which base rate card the contract is written against. */
  baseCardKey: string;
  status: CustomerStatus;
  /** How the customer arrived, for the audit trail. */
  source: 'api' | 'manual';
  createdAt: Date;
  /** Commercial terms. Optional so existing customers keep working. */
  commercial?: CommercialTerms;
  /**
   * The template a configurator last applied, if any.
   *
   * Recorded because "which standard offer is this customer on" is the first question
   * anyone asks of a contract, and a pile of override cells does not answer it. It is a
   * record of provenance, not a live link — the contract is free to diverge afterwards,
   * and usually does.
   */
  appliedTemplate?: {
    key: string;
    name: string;
    /** replace | fill-gaps — how it was applied over what was already there. */
    mode: string;
    appliedAt: Date;
    appliedBy: string;
  };
  /**
   * Segment tags — "Ecom", "MSME" — the handle a product is sold to.
   *
   * Deliberately free text rather than an enumeration. A segment is a commercial idea
   * that changes faster than a deployment, and a fixed list would mean a code change
   * every time sales invented one. Matching is case-insensitive for the same reason:
   * nobody types a tag twice the same way.
   *
   * Nothing about pricing reads a tag. It decides who a product is *offered* to, and
   * applying one still writes an ordinary draft that goes to an approver.
   */
  tags?: string[];
  /** The product a configurator last applied. Provenance, like `appliedTemplate`. */
  appliedProduct?: {
    key: string;
    name: string;
    mode: string;
    appliedAt: Date;
    appliedBy: string;
  };
}

/** The negotiated part of a contract: what differs, and what is covered. */
export interface ContractTerms {
  overrides: Overrides;
  scope: ContractScope;
  /**
   * Lane rules this customer negotiated, keyed by id.
   *
   * Held beside the override map rather than inside it because a rule is not a cell on
   * the base card — there is nothing for it to override. A customer with none is priced
   * from their overrides and the base card exactly as before.
   */
  laneRules?: Record<string, StoredLaneRule>;
  /**
   * Prices frozen as of a date, on lanes this customer never negotiated.
   *
   * Held apart from `overrides` for a reason that is not cosmetic: a locked price equals
   * the base price by definition, and pruning exists to delete exactly that. Put the two
   * in one map and the next ordinary edit would quietly discard the lock. Kept separate,
   * it survives pruning, and the layering says what it means — base, then the lock, then
   * what was actually negotiated, which always wins.
   */
  priceLock?: PriceLock;
}

/** A snapshot of what the card charged on the day somebody promised it would not move. */
export interface PriceLock {
  at: Date;
  by: string;
  rates: Overrides;
}

export const EMPTY_TERMS: ContractTerms = {
  overrides: {},
  scope: UNRESTRICTED_SCOPE,
};

/**
 * Why a quote fell outside a customer's contract. The booking site shows this to
 * the operator, so each reason has to be specific enough to act on.
 */
export type OutOfContractReason =
  | 'mode-not-in-contract'
  | 'lane-not-in-contract'
  | 'weight-not-in-contract';

export interface ContractCheck {
  inContract: boolean;
  reasons: OutOfContractReason[];
  /** Human-readable, safe to show to a booking operator. */
  messages: string[];
}

/**
 * A booking the customer wants to place outside their contract, at base prices.
 * Held until an admin decides.
 */
export type BookingExceptionStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface BookingExceptionRequest {
  reference: string;
  customerCode: string;
  mode: Mode;
  fromPincode: number;
  toPincode: number;
  weight: number;
  reasons: OutOfContractReason[];
  /** The base-card total the operator was shown when they asked. */
  quotedTotal: number;
  status: BookingExceptionStatus;
  requestedBy: string;
  requestedAt: Date;
  decidedBy?: string;
  decidedAt?: Date;
  decisionComment?: string;
  /** Set when an admin also wants the lane folded into the contract permanently. */
  addToContract?: boolean;
}
