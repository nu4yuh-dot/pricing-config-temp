import { min, percentOf, toPaise, ZERO, type Paise } from '../pricing/money';
/**
 * Offers — a rate that changes for a fortnight and then puts itself back.
 *
 * The one genuinely new piece of pricing logic in the redesign. Everything else in this
 * system is a stored value that somebody negotiated; an offer is a time-boxed adjustment
 * evaluated at quote time and never written down as a rate. That is the whole point: a
 * festival discount hand-edited in has to be hand-edited out, and the edit that gets
 * forgotten is always the second one.
 *
 * Because it is applied and not stored, an offer cannot be found later by reading a
 * contract — so it has to be visible in the quote it changed. Every quote it touches says
 * which offer, by name, and what the price would have been.
 */

export type OfferKind = 'percent-off-freight' | 'amount-off-freight' | 'waive-charge';

/** Who an offer reaches. Deliberately the three groupings the rest of the system has. */
export type OfferAudience =
  | { kind: 'product'; value: string }
  | { kind: 'segment'; value: string }
  | { kind: 'customer'; value: string };

export interface Offer {
  key: string;
  name: string;
  kind: OfferKind;
  /** Percent for `percent-off-freight`, rupees for `amount-off-freight`, unused for a waiver. */
  value: number;
  /** The charge a waiver removes. */
  chargeId?: string;
  startsAt: Date;
  /** Inclusive: an offer ending on the 15th is live all day on the 15th. */
  endsAt: Date;
  audience: OfferAudience;
  /** Off means scheduled but suspended — kept, so the dates are not lost to switch it off. */
  enabled: boolean;
  createdBy?: string;
  createdAt?: Date;
}

export interface OfferContext {
  at: Date;
  customerCode?: string;
  /** The customer's segment tags. */
  tags?: readonly string[];
  /** The product they were put on, if any. */
  productKey?: string;
}

export type OfferWindow = 'scheduled' | 'active' | 'expired';

export function offerWindow(offer: Pick<Offer, 'startsAt' | 'endsAt'>, at: Date): OfferWindow {
  if (at < offer.startsAt) return 'scheduled';
  if (at > offer.endsAt) return 'expired';
  return 'active';
}

/** Does this offer reach this customer, on this date? */
export function offerApplies(offer: Offer, context: OfferContext): boolean {
  if (!offer.enabled) return false;
  if (offerWindow(offer, context.at) !== 'active') return false;

  switch (offer.audience.kind) {
    case 'customer':
      return (
        context.customerCode !== undefined &&
        context.customerCode.trim().toUpperCase() === offer.audience.value.trim().toUpperCase()
      );
    case 'product':
      return context.productKey === offer.audience.value;
    case 'segment': {
      const wanted = offer.audience.value.trim().toLowerCase();
      return (context.tags ?? []).some((tag) => tag.trim().toLowerCase() === wanted);
    }
  }
}

export function applicableOffers(offers: readonly Offer[], context: OfferContext): Offer[] {
  return offers.filter((offer) => offerApplies(offer, context));
}

/**
 * What an offer takes off a given freight, in paise. Never more than the freight itself.
 *
 * A percentage of an amount, in exact integer arithmetic — so a 10% offer on ₹637.55 takes
 * exactly 63.76 off and not 63.755000000000004, and the discounted freight is still a
 * whole number of paise that the invoice can carry.
 */
export function freightDiscount(offer: Offer, freight: Paise): Paise {
  if (offer.kind === 'percent-off-freight') {
    return min(freight, percentOf(freight, offer.value));
  }
  if (offer.kind === 'amount-off-freight') return min(freight, toPaise(offer.value));
  return ZERO;
}

export interface ResolvedOffers {
  /** The one freight offer that applied, if any. */
  freightOffer: Offer | null;
  /** In paise, like everything else the engine adds up. */
  discount: Paise;
  /** Charge ids waived, with the offer that waived each. */
  waivers: { chargeId: string; offer: Offer }[];
  /** Offers that matched but were not used, and why. For the quote to explain itself. */
  passedOver: { offer: Offer; because: string }[];
}

/**
 * Which of the matching offers actually applies.
 *
 * Freight offers do not stack. Two 10% campaigns overlapping by a week is an ordinary
 * scheduling accident, and stacking them would quietly sell at 19% off — the sort of
 * number nobody decided. The best single one for the customer wins, and the rest are
 * reported as considered so the discount that did not happen is still visible.
 *
 * Waivers are different: waiving COD and waiving a docket are two separate things, and
 * both can hold at once. Two offers waiving the *same* charge is not a stack, it is a
 * duplicate — the charge comes off once.
 */
export function resolveOffers(offers: readonly Offer[], freight: Paise): ResolvedOffers {
  const passedOver: { offer: Offer; because: string }[] = [];

  const freightOffers = offers.filter((offer) => offer.kind !== 'waive-charge');
  let best: Offer | null = null;
  let discount = ZERO;
  for (const offer of freightOffers) {
    const amount = freightDiscount(offer, freight);
    if (best === null || amount > discount) {
      if (best !== null) passedOver.push({ offer: best, because: 'a larger discount applied' });
      best = offer;
      discount = amount;
    } else {
      passedOver.push({ offer, because: 'a larger discount applied' });
    }
  }

  const waivers: { chargeId: string; offer: Offer }[] = [];
  for (const offer of offers) {
    if (offer.kind !== 'waive-charge' || !offer.chargeId) continue;
    if (waivers.some((waiver) => waiver.chargeId === offer.chargeId)) {
      passedOver.push({ offer, because: 'that charge was already waived' });
      continue;
    }
    waivers.push({ chargeId: offer.chargeId, offer });
  }

  return { freightOffer: best, discount, waivers, passedOver };
}
