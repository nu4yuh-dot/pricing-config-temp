import type { UpsAccessorial, UpsAccessorialOverride } from '../domain/ups';
import type { RateCardData } from '../domain/types';
import type { Change, CellValue } from './diff';

/**
 * Per-zone accessorial rates in the approval diff.
 *
 * `diffCardData` finds changes by walking the sheet specs, which is right for every cell
 * that lives at an A1 address. A zone override lives at none: it is a sparse entry under
 * `accessorials[n].byZone`, created the moment somebody types into one, and the sheet spec
 * cannot enumerate 37 charges × 18 zones × 3 rates without becoming two thousand cells
 * nobody renders.
 *
 * So it is diffed here, for the same reason lane rules are — without it a zone rate would
 * price a shipment and reach production without appearing in a single review line. That is
 * the one failure mode this system exists to prevent, and a tariff is exactly where it
 * would hurt: the card would still read as approved while a destination quietly charged
 * something nobody signed off.
 *
 * Reported per zone per rate, at the bind path the editor writes, so an approver reads
 * "Additional Handling Charge · Z5 · minimum · 1350 → 1850" rather than a diff of JSON.
 */

const SHEET = 'Accessorial charges';

const RATE_LABELS: Record<keyof UpsAccessorialOverride, string> = {
  minimum: 'minimum',
  perKg: 'per kg',
  waiver: 'waiver',
};

const RATES = ['minimum', 'perKg', 'waiver'] as const;

function percentChange(oldValue: CellValue, newValue: CellValue): number | null {
  if (typeof oldValue !== 'number' || typeof newValue !== 'number') return null;
  if (oldValue === 0) return null;
  return ((newValue - oldValue) / Math.abs(oldValue)) * 100;
}

/**
 * What the zone charged, as a number or null for "followed the card".
 *
 * Null and NaN both mean the same thing here — a cleared input — and both must read as
 * following the card rather than as a rate of zero. A waiver stored as 0 is not the same
 * as a waiver that was never set: the first is "nothing is waived", the second is "use
 * whatever the card says", and billing them the same way would give away a charge.
 */
function rateOf(override: UpsAccessorialOverride | undefined, rate: keyof UpsAccessorialOverride) {
  const value = override?.[rate];
  if (value === undefined || value === null || Number.isNaN(value)) return null;
  return value;
}

export function diffUpsZoneAccessorials(
  before: RateCardData,
  after: RateCardData,
): Change[] {
  const was = (before as { ups?: { accessorials?: UpsAccessorial[] } }).ups?.accessorials ?? [];
  const now = (after as { ups?: { accessorials?: UpsAccessorial[] } }).ups?.accessorials ?? [];
  if (was.length === 0 && now.length === 0) return [];

  const changes: Change[] = [];

  // Indexed by id rather than position: the accessorial list is rebuilt from the workbook,
  // and comparing index 5 to index 5 across a rebuild would attribute one charge's rate to
  // another.
  const wasById = new Map(was.map((charge) => [charge.id, charge]));

  now.forEach((charge, index) => {
    const previous = wasById.get(charge.id);
    const zones = new Set([
      ...Object.keys(previous?.byZone ?? {}),
      ...Object.keys(charge.byZone ?? {}),
    ]);

    for (const zone of [...zones].sort()) {
      const oldOverride = previous?.byZone?.[zone];
      const newOverride = charge.byZone?.[zone];

      for (const rate of RATES) {
        const oldValue = rateOf(oldOverride, rate);
        const newValue = rateOf(newOverride, rate);
        if (oldValue === newValue) continue;

        changes.push({
          bind: `ups.accessorials.${index}.byZone.${zone}.${rate}`,
          sheet: SHEET,
          // No A1 reference, so the charge and zone go here — what a review groups by.
          cellRef: `${charge.id}/${zone}`,
          label: `${charge.name} · ${zone} · ${RATE_LABELS[rate]}`,
          oldValue,
          newValue,
          pctChange: percentChange(oldValue, newValue),
        });
      }
    }
  });

  return changes;
}
