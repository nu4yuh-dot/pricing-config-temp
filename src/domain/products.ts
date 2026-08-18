import { UNRESTRICTED_SCOPE, type ContractTerms, type Overrides } from './customers';
import type { Mode } from './types';
import type { RateTemplate } from './templates';

/**
 * A product — a named, sellable package.
 *
 * A template is a *shape*: zone-directional surface, flat pan-India. A product is how the
 * business actually sells — "E-commerce parcel", "Retail MSME" — and it bundles a template
 * with the charges that always ride along and the coverage it is sold under. One level up,
 * and aimed at the conversation a salesperson has rather than at how the engine stores
 * things.
 *
 * It invents nothing. Rates come from its template, charges from the library, coverage
 * from the same nullable scope every contract uses. That is deliberate: a product that
 * could hold rates of its own would be a fourth place a price can hide, and there are
 * already three.
 *
 * The word was taken until recently by a card's `source` field. See `CardSource`.
 */
export interface Product {
  key: string;
  name: string;
  description: string;
  /** The rate template this product is priced from. */
  templateKey: string;
  /** Library charge ids attached as standing terms. */
  charges: string[];
  /** Modes it is sold for. Absent means the template's own coverage stands. */
  modes?: Mode[];
  /** The customer tag this product is offered to, for applying it to a whole segment. */
  segment?: string;
}

export const EMPTY_PRODUCT: Product = {
  key: '',
  name: '',
  description: '',
  templateKey: '',
  charges: [],
};

/**
 * The contract terms a product produces, for one customer.
 *
 * Everything lands in the ordinary override map, which is the point — a product is a
 * convenient way to write terms somebody could have written by hand, so it goes through
 * exactly the same diff, approval and pruning as any other negotiation. Nothing about a
 * contract has to know a product existed.
 */
export function productTerms(product: Product, template: RateTemplate): ContractTerms {
  const overrides: Overrides = { ...template.overrides };

  // Attaching a charge switches it on and nothing more. Its amount and treatment come from
  // wherever it is defined, so a product cannot quietly reprice a charge for one segment.
  for (const id of product.charges) {
    overrides[`settlementCharges.${id}.active`] = 'Yes';
  }

  return {
    overrides,
    scope: product.modes
      ? { ...(template.scope ?? UNRESTRICTED_SCOPE), modes: product.modes }
      : (template.scope ?? UNRESTRICTED_SCOPE),
  };
}

/**
 * What a product amounts to, for a catalog that has to be read rather than decoded.
 *
 * Assembled from the things a product only points at — a template key, charge ids — so the
 * catalog shows what is actually being sold rather than the references. `blockers` is the
 * part that earns its keep: a product is edited in pieces and applied much later, and the
 * gap between the two is where a product that names a deleted template or a charge nobody
 * defined sits quietly until somebody puts it on a customer.
 */
export interface ProductSummary {
  /** The template's name, or null when it names one that no longer exists. */
  templateName: string | null;
  baseCardKey: string | null;
  /** Rate cells inherited from the template. A product contributes none of its own. */
  rateCells: number;
  /** Attached charges, resolved against the library. */
  charges: { id: string; name: string }[];
  /** Attached ids the library has never heard of. */
  unknownCharges: string[];
  /** Modes it is sold for: its own, else the template's, else null meaning all. */
  modes: string[] | null;
  /** What stands between this product and a customer. Empty means it is ready to apply. */
  blockers: string[];
}

export function summariseProduct(
  product: Product,
  template: RateTemplate | null,
  library: readonly { id: string; name: string }[],
): ProductSummary {
  const known = new Map(library.map((charge) => [charge.id, charge.name]));

  const charges = product.charges
    .filter((id) => known.has(id))
    .map((id) => ({ id, name: known.get(id) ?? id }));
  const unknownCharges = product.charges.filter((id) => !known.has(id));

  const blockers: string[] = [];
  if (!template) {
    blockers.push(
      `Priced from the template “${product.templateKey}”, which does not exist. Nothing would be applied.`,
    );
  }
  if (unknownCharges.length > 0) {
    // Switching on a charge nothing defines writes an `active` cell with no amount beside
    // it, which prices as zero rather than failing — invisible until an invoice is short.
    const one = unknownCharges.length === 1;
    blockers.push(
      `Attaches ${unknownCharges.join(', ')}, which no card or contract defines — ` +
        `${one ? 'it would switch on' : 'they would switch on'} with no amount.`,
    );
  }
  if (!product.segment) {
    blockers.push('No segment, so it is offered to nobody. A product needs the tag it is sold to.');
  }

  return {
    templateName: template?.name ?? null,
    baseCardKey: template?.baseCardKey ?? null,
    rateCells: Object.keys(template?.overrides ?? {}).length,
    charges,
    unknownCharges,
    modes: product.modes ?? template?.scope.modes ?? null,
    blockers,
  };
}

/**
 * Is this customer in the product's segment?
 *
 * A product with no segment matches nobody. The alternative — no segment meaning everybody
 * — would let an incomplete product be applied across the whole book in one click, which is
 * the sort of default that only shows up once it has.
 */
export function productFitsSegment(product: Product, customer: { tags?: string[] }): boolean {
  if (!product.segment) return false;
  const wanted = product.segment.trim().toLowerCase();
  return (customer.tags ?? []).some((tag) => tag.trim().toLowerCase() === wanted);
}
