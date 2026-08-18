'use client';

import { useState, useTransition } from 'react';
import { SURFACE_ZONES } from '../../domain/zones';
import type { RateCardData } from '../../domain/types';

/**
 * Everything on a contract that is not a lane rate.
 *
 * The storage model always supported overriding any bind path; this exposes the ones
 * that get negotiated in practice — fuel, cartage, ODA and the docket fee — so a
 * contract is not limited to lane rates.
 *
 * Green means the customer already has a negotiated value. Leaving a field at the
 * standard value stores nothing, which is what keeps contracts sparse.
 */

type Section = 'surcharges' | 'weight' | 'cartage' | 'oda';

interface ChargeField {
  bind: string;
  label: string;
  unit: 'currency' | 'percent' | 'number';
  note: string;
}

/**
 * The fuel percentage, per mode.
 *
 * One row per mode the engine actually prices. NFO is not a row of its own because it is
 * quoted on the air card and takes the air percentage with it — a separate field would
 * imply a control that does not exist.
 *
 * GST is deliberately absent. `charges.gstAir` and `charges.gstSurface` are the workbook's
 * two rates, and every card now declares `modeTax`, which supersedes them — editing them
 * changes no quote. GST is set per mode, with its own SAC and reverse-charge position, in
 * the panel below. Leaving inert money fields on screen invites someone to change a tax
 * rate and watch nothing happen.
 */
const SURCHARGES: ChargeField[] = [
  { bind: 'charges.fuelSurface', label: 'Fuel, surface', unit: 'percent', note: 'on freight + cartage + ODA' },
  { bind: 'charges.fuelAir', label: 'Fuel, air', unit: 'percent', note: 'also used for NFO' },
  { bind: 'charges.fuelRail', label: 'Fuel, rail', unit: 'percent', note: 'normally zero' },
  { bind: 'charges.fuelFtl', label: 'Fuel, FTL', unit: 'percent', note: 'on the trip price; often nil' },
  { bind: 'charges.docket', label: 'Docket / AWB', unit: 'currency', note: 'per shipment' },
];

/**
 * Weight rules, per customer.
 *
 * These decide the weight a shipment is billed at before any rate is applied, so a
 * contracted divisor or minimum moves every quote on the account. Left at the standard
 * values they cost nothing; overridden, they are stored like any other negotiated cell.
 */
const WEIGHT_RULES: ChargeField[] = [
  {
    bind: 'charges.volumetricDivisorAir',
    label: 'Volumetric divisor, air',
    unit: 'number',
    note: 'L×B×H cm ÷ this; also NFO',
  },
  {
    bind: 'charges.volumetricDivisorSurface',
    label: 'Volumetric divisor, surface',
    unit: 'number',
    note: 'L×B×H cm ÷ this',
  },
  {
    bind: 'charges.volumetricDivisorRail',
    label: 'Volumetric divisor, rail',
    unit: 'number',
    note: 'nil follows surface',
  },
  {
    bind: 'charges.minWeightAir',
    label: 'Minimum weight, air',
    unit: 'number',
    note: 'kg; also used for NFO',
  },
  {
    bind: 'charges.minWeightSurface',
    label: 'Minimum weight, surface',
    unit: 'number',
    note: 'kg; nothing bills below this',
  },
  {
    bind: 'charges.minWeightRail',
    label: 'Minimum weight, rail',
    unit: 'number',
    note: 'kg; nil follows surface',
  },
  // Rail's own norm: a single heavy package is billed at twice its weight, which
  // supersedes both the volumetric rule and the minimum.
  {
    bind: 'charges.railHeavyPackageThreshold',
    label: 'Rail heavy package, from',
    unit: 'number',
    note: 'kg; a single package at or above this',
  },
  {
    bind: 'charges.railHeavyPackageMultiplier',
    label: 'Rail heavy package, ×',
    unit: 'number',
    note: '× its actual weight',
  },
  // FTL has no weight rules at all: a truck is hired whole, so there is nothing to
  // convert or floor. Stated here rather than left as a silent gap.
];

const format = (value: number, unit: ChargeField['unit']) =>
  unit === 'percent' ? String(Number((value * 100).toFixed(4))) : String(value);

const parse = (raw: string, unit: ChargeField['unit']): number | null => {
  const trimmed = raw.trim().replace('%', '');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return unit === 'percent' ? n / 100 : n;
};

const read = (data: RateCardData, bind: string): number => {
  const value = bind
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), data);
  return typeof value === 'number' ? value : 0;
};

export default function ContractChargesEditor(props: {
  /** The customer's effective data (base + their overrides). */
  contract: RateCardData;
  /** Standard data, for the "standard X" comparison. */
  base: RateCardData;
  canEdit: boolean;
  onSave: (edits: { bind: string; value: number | null }[]) => Promise<void>;
}) {
  const [section, setSection] = useState<Section>('surcharges');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const shown = (bind: string, unit: ChargeField['unit']) =>
    bind in drafts ? (drafts[bind] as string) : format(read(props.contract, bind), unit);

  const cartageFields: ChargeField[] = SURFACE_ZONES.flatMap((zone) => [
    { bind: `pickupDelivery.${zone}.pickupSurface`, label: `${zone} pickup, surface`, unit: 'currency' as const, note: 'origin zone' },
    { bind: `pickupDelivery.${zone}.deliverySurface`, label: `${zone} delivery, surface`, unit: 'currency' as const, note: 'destination zone' },
    { bind: `pickupDelivery.${zone}.pickupAir`, label: `${zone} pickup, air`, unit: 'currency' as const, note: 'origin zone' },
    { bind: `pickupDelivery.${zone}.deliveryAir`, label: `${zone} delivery, air`, unit: 'currency' as const, note: 'destination zone' },
  ]);

  const odaFields: ChargeField[] = [
    { bind: 'edlMatrix.perKmThreshold', label: 'Per-km beyond (km)', unit: 'number', note: 'banded rates stop here' },
    { bind: 'edlMatrix.perKmBeyondLastBand', label: 'Rate per km', unit: 'currency', note: 'distance x this' },
    ...(props.contract.edlMatrix.kmBands ?? []).flatMap((km, r) =>
      (props.contract.edlMatrix.weightBands ?? []).map((wt, c) => ({
        bind: `edlMatrix.rates.${r}.${c}`,
        label: `From ${km} km, from ${wt} kg`,
        unit: 'currency' as const,
        note: 'per shipment',
      })),
    ),
  ];

  const fields =
    section === 'surcharges'
      ? SURCHARGES
      : section === 'weight'
        ? WEIGHT_RULES
        : section === 'cartage'
          ? cartageFields
          : odaFields;

  const changed = fields.filter((f) => {
    const next = parse(shown(f.bind, f.unit), f.unit);
    return next !== null && next !== read(props.contract, f.bind);
  });

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        await props.onSave(
          changed.map((f) => ({ bind: f.bind, value: parse(shown(f.bind, f.unit), f.unit) })),
        );
        setDrafts({});
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save those charges.');
      }
    });
  };

  return (
    <div className="panel">
      <header>
        <h3>Negotiated charges</h3>
        <span className="hint">Anything beyond lane rates — surcharges, cartage, ODA</span>
      </header>

      <div className="body">
        <div className="pill-list" style={{ marginTop: 0, marginBottom: 14 }}>
          {(
            [
              ['surcharges', 'Fuel & docket'],
              ['weight', 'Weight rules'],
              ['cartage', 'Pickup & delivery'],
              ['oda', 'ODA / EDL'],
            ] as [Section, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`pill${section === key ? ' on' : ''}`}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="rate-fields" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
          {fields.map((f) => {
            const contractValue = read(props.contract, f.bind);
            const baseValue = read(props.base, f.bind);
            const next = parse(shown(f.bind, f.unit), f.unit);
            const isChanged = next !== null && next !== contractValue;
            const isNegotiated = contractValue !== baseValue;
            return (
              <div
                key={f.bind}
                className={`rate-field${isChanged ? ' changed' : isNegotiated ? ' overridden' : ''}`}
              >
                <label htmlFor={f.bind}>
                  {f.label}{' '}
                  <span className="unit">{f.unit === 'percent' ? '%' : f.unit === 'currency' ? '₹' : ''}</span>
                </label>
                <input
                  id={f.bind}
                  inputMode="decimal"
                  value={shown(f.bind, f.unit)}
                  disabled={!props.canEdit}
                  onChange={(e) => {
                    setSaved(false);
                    setDrafts((cur) => ({ ...cur, [f.bind]: e.target.value }));
                  }}
                />
                <div className="baseline">
                  {isChanged ? (
                    <>was <strong>{format(contractValue, f.unit)}</strong></>
                  ) : isNegotiated ? (
                    <>standard {format(baseValue, f.unit)}</>
                  ) : (
                    f.note
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      {props.canEdit && (
        <div className="actionbar">
          {changed.length > 0 ? (
            <span className="chip draft count">{changed.length} changed</span>
          ) : saved ? (
            <span className="chip live">Saved to draft</span>
          ) : (
            <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>No changes</span>
          )}
          <span className="spacer" />
          {changed.length > 0 && (
            <button onClick={() => setDrafts({})} disabled={pending}>
              Revert
            </button>
          )}
          <button className="primary" onClick={save} disabled={changed.length === 0 || pending}>
            {pending ? 'Saving…' : 'Save to draft'}
          </button>
        </div>
      )}
    </div>
  );
}
