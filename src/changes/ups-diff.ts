import type { RateCardData } from '../domain/types';
import type { UpsCardData } from '../domain/ups';
import type { Change, CellValue } from './diff';

/**
 * The UPS card in the approval diff.
 *
 * `diffCardData` finds changes by walking the sheet specs, and this tariff has none — no
 * A1 address, no grid, nothing for that walk to see. Without this file an edit to the fuel
 * percentage or a zone's per-kilogram rate would reprice every international shipment and
 * produce not one line for an approver to read. That is the same failure the lane rules
 * had, and it is the reason this exists before the editor does.
 *
 * Paths address the card the way it is stored, including array indices, because that is
 * what `setByPath` writes. Nobody reads an index, so the *label* carries the meaning:
 * "Package · 10 kg · Zone 1", not "rates.package.19.rates.Z1".
 */

const SHEET = 'UPS international';

const PARAM_LABELS: Record<string, string> = {
  origin: 'origin',
  margin: 'margin on basic freight',
  fuelRate: 'fuel surcharge',
  surgeDiscount: 'surge discount',
  gstRate: 'GST',
  volumetricDivisor: 'volumetric divisor',
  minChargeableWeight: 'minimum chargeable weight',
};

function percentChange(oldValue: CellValue, newValue: CellValue): number | null {
  if (typeof oldValue !== 'number' || typeof newValue !== 'number') return null;
  if (oldValue === 0) return null;
  return ((newValue - oldValue) / Math.abs(oldValue)) * 100;
}

function line(bind: string, cellRef: string, label: string, before: CellValue, after: CellValue): Change {
  return {
    bind,
    sheet: SHEET,
    // No A1 reference exists, so this is what a review groups by: the part of the card
    // that moved.
    cellRef,
    label: `${SHEET} · ${label}`,
    oldValue: before,
    newValue: after,
    pctChange: percentChange(before, after),
  };
}

/** Every zone column either card knows about, so a column added or dropped is still seen. */
function zonesOf(a: Record<string, number> | undefined, b: Record<string, number> | undefined) {
  return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
}

function diffRateRows(
  kind: 'document' | 'package',
  before: UpsCardData | undefined,
  after: UpsCardData | undefined,
  changes: Change[],
): void {
  const was = before?.rates?.[kind] ?? [];
  const now = after?.rates?.[kind] ?? [];
  const label = kind === 'document' ? 'Document' : 'Package';

  for (let index = 0; index < Math.max(was.length, now.length); index++) {
    const previous = was[index];
    const current = now[index];
    const step = current?.toKg ?? previous?.toKg;

    // A step appearing or disappearing changes which rate a weight lands on, so it is a
    // change in its own right rather than something inferred from the rates.
    if (!previous || !current) {
      changes.push(
        line(
          `ups.rates.${kind}.${index}.toKg`,
          `${kind}:${step}`,
          `${label} · ${step} kg step`,
          previous?.toKg ?? null,
          current?.toKg ?? null,
        ),
      );
      continue;
    }
    if (previous.toKg !== current.toKg) {
      changes.push(
        line(
          `ups.rates.${kind}.${index}.toKg`,
          `${kind}:${step}`,
          `${label} · step boundary`,
          previous.toKg,
          current.toKg,
        ),
      );
    }
    for (const zone of zonesOf(previous.rates, current.rates)) {
      const a = previous.rates[zone] ?? null;
      const b = current.rates[zone] ?? null;
      if (a === b) continue;
      changes.push(
        line(
          `ups.rates.${kind}.${index}.rates.${zone}`,
          `${kind}:${step}`,
          `${label} · ${current.toKg} kg · ${zone}`,
          a,
          b,
        ),
      );
    }
  }
}

export function diffUpsCard(before: RateCardData, after: RateCardData): Change[] {
  const was = before.ups;
  const now = after.ups;
  if (!was && !now) return [];

  const changes: Change[] = [];

  // Parameters. A fuel percentage is one number that moves every quote on the card, which
  // makes it the single most important line in this diff.
  for (const key of Object.keys(PARAM_LABELS)) {
    const a = (was?.params as Record<string, CellValue> | undefined)?.[key] ?? null;
    const b = (now?.params as Record<string, CellValue> | undefined)?.[key] ?? null;
    if (a === b) continue;
    changes.push(line(`ups.params.${key}`, 'params', PARAM_LABELS[key] ?? key, a, b));
  }

  // Surge fees, by region.
  for (const region of [...new Set([...Object.keys(was?.surge ?? {}), ...Object.keys(now?.surge ?? {})])].sort()) {
    const a = was?.surge?.[region] ?? null;
    const b = now?.surge?.[region] ?? null;
    if (a === b) continue;
    changes.push(line(`ups.surge.${region}`, 'surge', `surge · ${region} ₹/kg`, a, b));
  }

  // Envelope is one rate per zone.
  for (const zone of zonesOf(was?.rates?.envelope, now?.rates?.envelope)) {
    const a = was?.rates?.envelope?.[zone] ?? null;
    const b = now?.rates?.envelope?.[zone] ?? null;
    if (a === b) continue;
    changes.push(line(`ups.rates.envelope.${zone}`, 'envelope', `Envelope · ${zone}`, a, b));
  }

  diffRateRows('document', was, now, changes);
  diffRateRows('package', was, now, changes);

  // The per-kilogram bands.
  const wasBulk = was?.rates?.bulk ?? [];
  const nowBulk = now?.rates?.bulk ?? [];
  for (let index = 0; index < Math.max(wasBulk.length, nowBulk.length); index++) {
    const previous = wasBulk[index];
    const current = nowBulk[index];
    const label = current?.label ?? previous?.label ?? `band ${index}`;
    if (!previous || !current) {
      changes.push(
        line(`ups.rates.bulk.${index}.fromKg`, `bulk:${label}`, `Bulk · ${label}`,
          previous?.fromKg ?? null, current?.fromKg ?? null),
      );
      continue;
    }
    if (previous.fromKg !== current.fromKg) {
      changes.push(
        line(`ups.rates.bulk.${index}.fromKg`, `bulk:${label}`, `Bulk · ${label} · from kg`,
          previous.fromKg, current.fromKg),
      );
    }
    for (const zone of zonesOf(previous.rates, current.rates)) {
      const a = previous.rates[zone] ?? null;
      const b = current.rates[zone] ?? null;
      if (a === b) continue;
      changes.push(
        line(`ups.rates.bulk.${index}.rates.${zone}`, `bulk:${label}`,
          `Bulk · ${label} · ${zone} (per kg)`, a, b),
      );
    }
  }

  // Accessorials: the minimum, the per-kg rate and the negotiated waiver all bill money.
  const wasCharges = was?.accessorials ?? [];
  const nowCharges = now?.accessorials ?? [];
  for (let index = 0; index < Math.max(wasCharges.length, nowCharges.length); index++) {
    const previous = wasCharges[index];
    const current = nowCharges[index];
    const name = current?.name ?? previous?.name ?? `charge ${index}`;
    const id = current?.id ?? previous?.id ?? `charge-${index}`;

    for (const field of ['minimum', 'perKg', 'waiver'] as const) {
      const a = previous?.[field] ?? null;
      const b = current?.[field] ?? null;
      if (a === b) continue;
      changes.push(
        line(`ups.accessorials.${index}.${field}`, `accessorial:${id}`, `${name} · ${field}`, a, b),
      );
    }
  }

  // A destination moving between zones reprices every shipment to it without a rate
  // changing, so the mapping is diffed too.
  for (const code of [...new Set([...Object.keys(was?.zones ?? {}), ...Object.keys(now?.zones ?? {})])].sort()) {
    const a = was?.zones?.[code] ?? null;
    const b = now?.zones?.[code] ?? null;
    if (a === b) continue;
    const name = now?.destinationNames?.[code] ?? was?.destinationNames?.[code] ?? code;
    changes.push(line(`ups.zones.${code}`, 'zones', `${name} (${code}) · rate zone`, a, b));
  }

  for (const code of [
    ...new Set([...Object.keys(was?.surgeRegions ?? {}), ...Object.keys(now?.surgeRegions ?? {})]),
  ].sort()) {
    const a = was?.surgeRegions?.[code] ?? null;
    const b = now?.surgeRegions?.[code] ?? null;
    if (a === b) continue;
    const name = now?.destinationNames?.[code] ?? code;
    changes.push(line(`ups.surgeRegions.${code}`, 'zones', `${name} (${code}) · surge region`, a, b));
  }

  return changes;
}
