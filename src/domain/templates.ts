import type { ContractScope, Overrides, CommercialTerms } from './customers';

/**
 * A reusable rate configuration.
 *
 * The point the business made: most proposals are a variation on a handful of
 * standard shapes. Rather than assembling each contract lane by lane, save the shape
 * once and assign it, then adjust only what is genuinely bespoke.
 *
 * Deliberately the *same* sparse override map a contract uses. A template is not a
 * different kind of thing from a contract — it is a contract's terms without a
 * customer attached — so applying one is a copy, not a translation, and everything
 * that already understands overrides understands templates too.
 */

export interface RateTemplate {
  key: string;
  name: string;
  description: string;
  /** Which base card the template's overrides are expressed against. */
  baseCardKey: string;
  overrides: Overrides;
  scope: ContractScope;
  /**
   * Bind paths the template refuses to decide, asked of each customer instead.
   *
   * The mockup's distinction: "West ₹/kg — parameter" against "docket — fixed ₹100". The
   * value stored for a parameter is a worked example rather than an instruction, which is
   * why an unanswered one is dropped instead of copied.
   */
  parameters?: string[];
  /** Optional: a template can also carry standard commercial terms. */
  commercial?: CommercialTerms;
  createdBy: string;
  createdAt: Date;
  /** Templates derived from a customer record the origin, for traceability. */
  derivedFromCustomer?: string;
}

/** How a template is put onto a customer. */
export type ApplyMode =
  /** Replace the customer's draft terms entirely with the template's. */
  | 'replace'
  /**
   * Keep anything the customer has already negotiated and fill in the rest from the
   * template. Used when a customer has bespoke terms you do not want to lose.
   */
  | 'fill-gaps';

export interface ApplyResult {
  overrides: Overrides;
  scope: ContractScope;
  /** Bind paths taken from the template. */
  applied: string[];
  /** Bind paths left as the customer already had them. Only for `fill-gaps`. */
  kept: string[];
}

/**
 * Work out what a customer's terms become when a template is applied.
 *
 * Pure, so the effect can be previewed before anything is written — which matters,
 * because `replace` discards negotiated rates and that should never be a surprise.
 */
export function applyTemplate(
  template: RateTemplate,
  current: { overrides: Overrides; scope: ContractScope },
  mode: ApplyMode,
): ApplyResult {
  if (mode === 'replace') {
    return {
      overrides: { ...template.overrides },
      scope: template.scope,
      applied: Object.keys(template.overrides),
      kept: [],
    };
  }

  const overrides: Overrides = { ...current.overrides };
  const applied: string[] = [];
  const kept: string[] = [];

  for (const [path, value] of Object.entries(template.overrides)) {
    if (path in current.overrides) {
      kept.push(path);
      continue;
    }
    overrides[path] = value;
    applied.push(path);
  }

  // Coverage is not merged: two partial scopes combined would produce a contract
  // covering lanes nobody agreed to. The customer's own scope wins if they have
  // narrowed it, otherwise the template's applies.
  const scope = isRestricted(current.scope) ? current.scope : template.scope;

  return { overrides, scope, applied, kept };
}

function isRestricted(scope: ContractScope): boolean {
  return scope.modes !== null || scope.lanes !== null || scope.weightBands !== null;
}

export interface TemplateSummary {
  negotiatedCells: number;
  byArea: Record<string, number>;
  restricted: boolean;
  lanes: number | null;
  modes: string[] | null;
}

export function summariseTemplate(template: RateTemplate): TemplateSummary {
  const byArea: Record<string, number> = {};
  for (const path of Object.keys(template.overrides)) {
    const segments = path.split('.');
    const area = segments[0] === 'grids' ? (segments[1] ?? 'grids') : (segments[0] ?? 'other');
    byArea[area] = (byArea[area] ?? 0) + 1;
  }

  return {
    negotiatedCells: Object.keys(template.overrides).length,
    byArea,
    restricted: isRestricted(template.scope),
    lanes: template.scope.lanes?.length ?? null,
    modes: template.scope.modes ?? null,
  };
}
