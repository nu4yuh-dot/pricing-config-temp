/**
 * Online signups.
 *
 * Somebody who signed up on the website has already typed their identity in. Walking them
 * through the customer wizard again is re-entry, so a signup lands pre-filled in a queue
 * where the only decision left is which product they are on.
 *
 * The suggestion is a starting point and nothing more. Every signup waits for a person,
 * because the rules below read a dropdown answer about what somebody sells and infer a
 * price list from it — a reasonable guess, and not a thing to let activate itself.
 */

/** What the signup form asks: what do you sell, and where. */
export type SalesChannel = 'own-website' | 'marketplace' | 'local-shop' | 'other';

export const CHANNEL_LABELS: Record<SalesChannel, string> = {
  'own-website': 'I sell on my own website',
  marketplace: 'I sell on Amazon / Flipkart / Meesho',
  'local-shop': 'I run a local shop / small business',
  other: 'Something else',
};

/**
 * The segment each answer points at.
 *
 * Deliberately a segment rather than a product. A rule that named products would need
 * changing every time the catalog did; pointing at the segment means the catalog decides
 * what is currently sold to people who answered that way, which is the catalog's job.
 */
const CHANNEL_SEGMENTS: Record<SalesChannel, string | null> = {
  'own-website': 'Website',
  marketplace: 'Ecom',
  'local-shop': 'MSME',
  other: null,
};

/**
 * Above this, a signup is flagged instead of suggested.
 *
 * Not because the guess gets worse, but because the stake does: four thousand shipments a
 * month is a negotiation, and putting one on rack rates by default would sell it at list
 * price to somebody who was about to ask for a discount.
 */
export const MANUAL_REVIEW_VOLUME = 2000;

export interface Signup {
  reference: string;
  legalName: string;
  channel: SalesChannel;
  /** Shipments a month, as declared by the person signing up. */
  declaredVolume?: number;
  gstin?: string;
  pan?: string;
  addressLine?: string;
  contactEmail?: string;
  contactPhone?: string;
  signedUpAt: Date;
  status: 'waiting' | 'activated' | 'rejected';
  /** Set once activated: the customer code they became. */
  customerCode?: string;
  decidedBy?: string;
  decidedAt?: Date;
  rejectedReason?: string;
}

export interface SignupSuggestion {
  /** The product key to start them on, or null when a person must choose. */
  productKey: string | null;
  /** Why, in the words of the rule that fired. */
  reason: string;
  /** True when the volume declared puts this beyond an automatic answer. */
  flagged: boolean;
}

/**
 * Which product a signup should start on.
 *
 * `products` is the catalog as it stands, so a segment with nothing sold to it comes back
 * without a suggestion rather than with a stale product key.
 */
export function suggestProduct(
  signup: Pick<Signup, 'channel' | 'declaredVolume'>,
  products: readonly { key: string; name: string; segment?: string }[],
): SignupSuggestion {
  if ((signup.declaredVolume ?? 0) > MANUAL_REVIEW_VOLUME) {
    return {
      productKey: null,
      flagged: true,
      reason: `Declared ${signup.declaredVolume?.toLocaleString('en-IN')} shipments a month, which is a negotiation rather than a signup.`,
    };
  }

  const segment = CHANNEL_SEGMENTS[signup.channel];
  if (!segment) {
    return {
      productKey: null,
      flagged: false,
      reason: 'They did not say what they sell, so there is nothing to infer from.',
    };
  }

  const match = products.find(
    (product) => product.segment?.trim().toLowerCase() === segment.toLowerCase(),
  );
  if (!match) {
    return {
      productKey: null,
      flagged: false,
      reason: `Answered “${CHANNEL_LABELS[signup.channel]}”, but nothing in the catalog is sold to ${segment}.`,
    };
  }

  return {
    productKey: match.key,
    flagged: false,
    reason: `Answered “${CHANNEL_LABELS[signup.channel]}”, and ${match.name} is what the catalog sells to ${segment}.`,
  };
}

/**
 * The customer code a signup becomes.
 *
 * Derived from the legal name rather than asked for, because the person signing up has no
 * idea what a customer code is and the ops team would only invent one from the name
 * anyway. Collisions are the caller's problem to resolve — it can see the book.
 */
export function codeFor(legalName: string): string {
  const cleaned = legalName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 12);
  return cleaned === '' ? '' : cleaned;
}
