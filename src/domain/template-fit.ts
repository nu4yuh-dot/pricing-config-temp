import type { Overrides } from './customers';
import type { RateTemplate } from './templates';

/**
 * Assigning a template to a customer who is not empty.
 *
 * The gallery's job was always to make the second customer easier than the first. What it
 * could not do was answer the two questions anyone actually asks at the moment of
 * assignment: *which of these fits*, and *what will it tread on*. Both are answerable from
 * data already stored — a template's cells and a customer's — so neither needs a new
 * concept, only saying out loud what the override maps already know.
 */

/** A cell where the template and the customer disagree. */
export interface TemplateConflict {
  bind: string;
  /** What the customer negotiated. */
  theirs: string | number | null;
  /** What the template would set. */
  template: string | number | null;
}

/**
 * Where a template would overwrite something already agreed.
 *
 * Only cells the customer has *negotiated* count. A cell they inherit from the base card
 * is not a conflict — the template setting it is the entire point — and reporting those
 * would bury the four that matter under four hundred that do not.
 */
export function templateConflicts(
  template: Pick<RateTemplate, 'overrides'>,
  negotiated: Overrides,
): TemplateConflict[] {
  const conflicts: TemplateConflict[] = [];

  for (const [bind, value] of Object.entries(template.overrides)) {
    if (!(bind in negotiated)) continue;
    const theirs = negotiated[bind] ?? null;
    if (theirs === value) continue;
    conflicts.push({ bind, theirs, template: value ?? null });
  }

  return conflicts;
}

export interface TemplateFit {
  templateKey: string;
  /** Cells where the customer already sits exactly where the template would put them. */
  agreeing: number;
  /** Cells where they have negotiated something different. */
  conflicting: number;
  /** Cells the template would introduce and the customer has no opinion on. */
  fresh: number;
  /**
   * Share of the overlap that agrees, 0–1, or null when there is no overlap to judge by.
   *
   * Null rather than zero, deliberately. A customer with nothing negotiated is not a bad
   * fit for every template — they are simply not evidence either way, and a zero would
   * sort them below templates that genuinely clash.
   */
  agreement: number | null;
  /** Set when the template cannot be assigned at all, with the reason. */
  blocked?: string;
}

/**
 * How well a template suits one customer.
 *
 * A heuristic, and stated as one: it measures how much of this customer's existing
 * bargain the template already agrees with, which is a decent proxy for "this is the
 * shape they are on" and no proxy at all for whether it is the right commercial offer.
 * The counts are shown alongside the score so a person can disagree with it.
 */
export function scoreTemplateFit(
  template: Pick<RateTemplate, 'key' | 'overrides' | 'baseCardKey'>,
  customer: { baseCardKey: string; overrides: Overrides },
): TemplateFit {
  const empty = { templateKey: template.key, agreeing: 0, conflicting: 0, fresh: 0, agreement: null };

  if (customer.baseCardKey !== template.baseCardKey) {
    // Same bind path, different card, different rate. Not a poor fit — a meaningless one.
    return {
      ...empty,
      blocked: `written against ${template.baseCardKey}, and this customer is priced from ${customer.baseCardKey}`,
    };
  }

  let agreeing = 0;
  let conflicting = 0;
  let fresh = 0;

  for (const [bind, value] of Object.entries(template.overrides)) {
    if (!(bind in customer.overrides)) {
      fresh++;
      continue;
    }
    if (customer.overrides[bind] === value) agreeing++;
    else conflicting++;
  }

  const overlap = agreeing + conflicting;
  return {
    templateKey: template.key,
    agreeing,
    conflicting,
    fresh,
    agreement: overlap === 0 ? null : agreeing / overlap,
  };
}

/** Best fit first; a blocked template never outranks one that could be assigned. */
export function rankTemplates(fits: TemplateFit[]): TemplateFit[] {
  return [...fits].sort((a, b) => {
    if (Boolean(a.blocked) !== Boolean(b.blocked)) return a.blocked ? 1 : -1;
    return (b.agreement ?? -1) - (a.agreement ?? -1) || b.agreeing - a.agreeing;
  });
}

/**
 * The overrides a template produces once its parameters are answered.
 *
 * A parameter is a cell the template deliberately refuses to decide — "West ₹/kg", asked
 * of every customer — as against a fixed cell like a docket charge, copied as it stands.
 * An unanswered parameter is dropped rather than defaulted: a template that quietly
 * assigned its own last value to a field it declared negotiable would be worse than one
 * with no parameters at all, because it would look like a decision somebody made.
 */
export function resolveTemplateParameters(
  template: Pick<RateTemplate, 'overrides' | 'parameters'>,
  answers: Record<string, string | number | null>,
): Overrides {
  const parameters = new Set(template.parameters ?? []);
  const resolved: Overrides = {};

  for (const [bind, value] of Object.entries(template.overrides)) {
    if (!parameters.has(bind)) {
      resolved[bind] = value;
      continue;
    }
    if (!(bind in answers)) continue;
    resolved[bind] = answers[bind] ?? null;
  }

  return resolved;
}
