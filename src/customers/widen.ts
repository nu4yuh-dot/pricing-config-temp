import type { ContractScope, LaneKey, WeightBand } from '../domain/customers';
import type { Mode } from '../domain/types';

/**
 * Widening a contract's coverage to include something a customer asked for.
 *
 * The whole of this file exists because of one asymmetry that is easy to get backwards:
 * in a `ContractScope`, **null means everything**, and a list means only those.
 *
 * So a customer whose contract covers every mode has `modes: null`. If they ask for air
 * freight and we "add air" by writing `['air']`, we have not widened their contract — we
 * have just taken surface and rail away from them. It would look like granting a request
 * and read like one in an audit log, and the customer would find out when a booking they
 * had been making for a year stopped working.
 *
 * Hence: null stays null. There is nothing to widen when everything is already covered.
 */

export interface ScopeAsk {
  modes?: Mode[];
  lanes?: LaneKey[];
  weightBands?: WeightBand[];
}

const sameBand = (a: WeightBand, b: WeightBand) => a.from === b.from && a.to === b.to;

export function widenScope(scope: ContractScope, ask: ScopeAsk): ContractScope {
  return {
    // Already unrestricted: adding to it could only take something away.
    modes:
      scope.modes === null
        ? null
        : [...new Set([...scope.modes, ...(ask.modes ?? [])])],
    lanes:
      scope.lanes === null
        ? null
        : [...new Set([...scope.lanes, ...(ask.lanes ?? [])])],
    weightBands:
      scope.weightBands === null
        ? null
        : [
            ...scope.weightBands,
            // Bands are objects, so a Set will not deduplicate them.
            ...(ask.weightBands ?? []).filter(
              (band) => !scope.weightBands!.some((existing) => sameBand(existing, band)),
            ),
          ],
  };
}

/**
 * What the widening actually changed, for the audit trail and the reviewer's screen.
 *
 * Reported rather than inferred, because "granted a request that changed nothing" is a
 * real and useful thing to be told: it means the customer was already covered and had
 * probably hit a different problem.
 */
export function widenedBy(before: ContractScope, after: ContractScope): string[] {
  const added: string[] = [];
  const count = (a: unknown[] | null, b: unknown[] | null) =>
    a === null || b === null ? 0 : b.length - a.length;

  const modes = count(before.modes, after.modes);
  if (modes > 0) added.push(`${modes} mode${modes === 1 ? '' : 's'}`);
  const lanes = count(before.lanes, after.lanes);
  if (lanes > 0) added.push(`${lanes} lane${lanes === 1 ? '' : 's'}`);
  const bands = count(before.weightBands, after.weightBands);
  if (bands > 0) added.push(`${bands} weight band${bands === 1 ? '' : 's'}`);

  return added;
}
