'use client';

import { useState, useTransition } from 'react';
import { endpointSpecificity } from '../../domain/lane-rules';
import type { Endpoint, EndpointKind } from '../../domain/lane-rules';
import type { GeoResult } from '../../domain/geo-search';
import type { CoverageSummary } from '../../domain/rule-coverage';
import type { PreviewRow } from '../../domain/rule-preview';
import type { RuleRates } from '../../domain/lane-rule-store';
import type { StoredMode } from '../../domain/types';

/**
 * Author one lane rule.
 *
 * The whole idea is that a person configures at the level the negotiation actually
 * happened at — "all of Maharashtra", "Pune to Bangalore only" — rather than translating
 * it into the 21 zone codes the system happens to store. So there is one search box
 * covering every level, and the rule that comes out is one row rather than the hundreds
 * of cells the same agreement used to expand into.
 */

const RATE_FIELDS: { key: keyof RuleRates; label: string; unit: string }[] = [
  { key: 'minCharge', label: 'Minimum', unit: '₹' },
  { key: 'tier1', label: 'Tier 1', unit: '₹/kg' },
  { key: 'tier2', label: 'Tier 2', unit: '₹/kg' },
  { key: 'tier3', label: 'Tier 3', unit: '₹/kg' },
];

const KIND_LABEL: Record<EndpointKind, string> = {
  pincode: 'Pincode',
  city: 'District',
  zone: 'Zone',
  state: 'State',
  group: 'Group',
  any: 'Pan-India',
};

function endpointText(endpoint: Endpoint | null): string {
  if (!endpoint) return 'nothing chosen';
  return endpoint.kind === 'any' ? 'Pan-India' : (endpoint.value ?? 'Pan-India');
}

const same = (a: Endpoint, b: Endpoint): boolean => a.kind === b.kind && a.value === b.value;

export interface ExistingRule {
  origin: Endpoint;
  destination: Endpoint;
  tier1: number | null;
}

// The resolver's own specificity, not a copy of it. A second table here would agree
// until the day somebody changed one of them, and then this screen would quietly
// describe a precedence the engine does not apply.
const pairSpecificity = (origin: Endpoint, destination: Endpoint): number =>
  endpointSpecificity(origin.kind) + endpointSpecificity(destination.kind);

/**
 * What the pair being authored means against the rules already there.
 *
 * Two different things, and only one of them is a problem. A broader rule already
 * covering these lanes is not a conflict — it is how a cascade is supposed to work, and
 * saying so is reassurance rather than a warning. An exact duplicate genuinely is a
 * problem, because two rules nothing can tell apart resolve by edit time.
 */
function overlapping(
  existing: ExistingRule[],
  origin: Endpoint,
  destination: Endpoint,
): { kind: 'duplicate' | 'narrower'; label: string; tier1: number | null } | null {
  const duplicate = existing.find(
    (rule) => same(rule.origin, origin) && same(rule.destination, destination),
  );
  if (duplicate) {
    return {
      kind: 'duplicate',
      label: `${endpointText(duplicate.origin)} → ${endpointText(duplicate.destination)}`,
      tier1: duplicate.tier1,
    };
  }

  const mine = pairSpecificity(origin, destination);
  // The sharpest rule this one would sit above, which is the one somebody is most likely
  // to be thinking of when they wonder what they are about to change.
  const broader = existing
    .filter((rule) => pairSpecificity(rule.origin, rule.destination) < mine)
    .sort(
      (a, b) =>
        pairSpecificity(b.origin, b.destination) - pairSpecificity(a.origin, a.destination),
    )[0];

  if (!broader) return null;
  return {
    kind: 'narrower',
    label: `${endpointText(broader.origin)} → ${endpointText(broader.destination)}`,
    tier1: broader.tier1,
  };
}

export default function GeographyRuleEditor({
  mode,
  canEdit,
  onSearch,
  onCoverage,
  onPreview,
  onSave,
  existing,
}: {
  mode: StoredMode;
  canEdit: boolean;
  onSearch: (query: string, mode: StoredMode) => Promise<GeoResult[]>;
  onCoverage: (endpoint: Endpoint, mode: StoredMode) => Promise<CoverageSummary>;
  onPreview: (
    mode: StoredMode,
    origin: Endpoint,
    destination: Endpoint,
    rates: RuleRates,
  ) => Promise<PreviewRow[]>;
  onSave: (rule: {
    mode: StoredMode;
    origin: Endpoint;
    destination: Endpoint;
    rates: RuleRates;
  }) => Promise<void>;
  /**
   * The rules already on the card for this mode.
   *
   * Passed as data rather than as a "does this conflict" callback: a function cannot
   * cross from a server component to a client one, and the comparison is cheap enough
   * that there is no reason to make it a round trip.
   */
  existing: ExistingRule[];
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [picking, setPicking] = useState<'origin' | 'destination'>('origin');
  const [origin, setOrigin] = useState<Endpoint | null>(null);
  const [destination, setDestination] = useState<Endpoint | null>(null);
  const [coverage, setCoverage] = useState<Record<'origin' | 'destination', CoverageSummary | null>>(
    { origin: null, destination: null },
  );
  const [rates, setRates] = useState<Record<keyof RuleRates, string>>({
    minCharge: '',
    tier1: '',
    tier2: '',
    tier3: '',
  });
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [pending, startTransition] = useTransition();

  const search = (value: string) => {
    setQuery(value);
    startTransition(async () => setResults(await onSearch(value, mode)));
  };

  const choose = (result: GeoResult) => {
    const endpoint: Endpoint =
      result.kind === 'any' ? { kind: 'any' } : { kind: result.kind, value: result.value };

    if (picking === 'origin') setOrigin(endpoint);
    else setDestination(endpoint);
    setQuery('');
    setResults([]);
    setPreview(null);

    startTransition(async () => {
      const summary = await onCoverage(endpoint, mode);
      setCoverage((current) => ({ ...current, [picking]: summary }));
    });
  };

  // A blank field is "not carried", which is a real value here — a rule can close a lane
  // for one customer just as a blank grid cell does.
  const numeric = (value: string): number | null => (value.trim() === '' ? null : Number(value));

  const conflict = origin && destination ? overlapping(existing, origin, destination) : null;
  const ready = origin !== null && destination !== null && canEdit;

  const save = () => {
    if (!origin || !destination) return;
    startTransition(async () => {
      await onSave({
        mode,
        origin,
        destination,
        rates: {
          minCharge: numeric(rates.minCharge),
          tier1: numeric(rates.tier1),
          tier2: numeric(rates.tier2),
          tier3: numeric(rates.tier3),
        },
      });
      setOrigin(null);
      setDestination(null);
      setCoverage({ origin: null, destination: null });
      setRates({ minCharge: '', tier1: '', tier2: '', tier3: '' });
      setPreview(null);
    });
  };

  return (
    <div className="panel geo-editor">
      <div className="geo-picking">
        <button
          type="button"
          className={`chip${picking === 'origin' ? ' active' : ''}`}
          onClick={() => setPicking('origin')}
        >
          Origin · {endpointText(origin)}
        </button>
        <span className="arrow">→</span>
        <button
          type="button"
          className={`chip${picking === 'destination' ? ' active' : ''}`}
          onClick={() => setPicking('destination')}
        >
          Destination · {endpointText(destination)}
        </button>
      </div>

      <div className="field">
        <label htmlFor="geo-search">
          Search a pincode, city, state, zone, or a group like &ldquo;metros&rdquo;
        </label>
        <input
          id="geo-search"
          value={query}
          placeholder="Try “pune”, “maharashtra”, “metros”, or “411001”…"
          onChange={(event) => search(event.target.value)}
          autoComplete="off"
        />
      </div>

      {results.length > 0 && (
        <ul className="geo-results">
          {results.map((result) => (
            <li key={`${result.kind}:${result.value}`}>
              <button type="button" className="geo-item" onClick={() => choose(result)}>
                <span className={`lvl lvl-${result.kind}`}>{KIND_LABEL[result.kind]}</span>
                <span className="lbl">{result.label}</span>
                <span className="meta">{result.meta}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {query.trim() !== '' && results.length === 0 && !pending && (
        <p className="empty">
          No match at any level. Try a pincode, a city, a state, a zone code, or
          &ldquo;metros&rdquo;.
        </p>
      )}

      <div className="rate-fields">
        {RATE_FIELDS.map((field) => (
          <div className="rate-field" key={field.key}>
            <label htmlFor={`rule-${field.key}`}>
              {field.label} <span className="unit">{field.unit}</span>
            </label>
            <input
              id={`rule-${field.key}`}
              inputMode="decimal"
              value={rates[field.key]}
              disabled={!canEdit}
              placeholder="not carried"
              onChange={(event) =>
                setRates((current) => ({ ...current, [field.key]: event.target.value }))
              }
            />
          </div>
        ))}
      </div>

      {conflict?.kind === 'duplicate' && (
        <div className="callout warn">
          <strong>{conflict.label}</strong> is already a rule on this card. Adding it again
          leaves two rules nothing can tell apart, so the winner would come down to which
          was edited last — edit the existing one instead.
        </div>
      )}

      {conflict?.kind === 'narrower' && origin && destination && (
        <div className="callout">
          This is <strong>more specific</strong> than the existing{' '}
          <strong>{conflict.label}</strong> rule
          {conflict.tier1 === null ? '' : ` (₹${conflict.tier1}/kg)`}. It will apply only to{' '}
          {endpointText(origin)} → {endpointText(destination)} shipments — every other lane
          that rule covers keeps it, untouched.
        </div>
      )}

      {(coverage.origin || coverage.destination) && (
        <div className="geo-coverage">
          {(['origin', 'destination'] as const).map((end) => {
            const summary = coverage[end];
            if (!summary) return null;
            return (
              <details key={end}>
                <summary>
                  {end === 'origin' ? 'Origin' : 'Destination'} covers{' '}
                  <strong>
                    {summary.pincodes.toLocaleString('en-IN')} pincode
                    {summary.pincodes === 1 ? '' : 's'}
                  </strong>
                  , stored as part of <strong>one rule</strong>
                </summary>
                <ul>
                  {summary.cities.slice(0, 12).map((city) => (
                    <li key={city.city}>
                      {city.city} <span className="meta">{city.pincodes.length}</span>
                    </li>
                  ))}
                  {summary.cities.length > 12 && (
                    <li className="meta">+ {summary.cities.length - 12} more cities</li>
                  )}
                </ul>
              </details>
            );
          })}
        </div>
      )}

      {preview !== null && preview.length > 0 && (
        <div className="rule-preview">
          <p className="lede">
            This rule touches <strong>{preview.length}</strong>{' '}
            {preview.length === 1 ? 'lane' : 'lanes'}, and is stored as{' '}
            <strong>one rule</strong> — the old model would have written{' '}
            {preview.length * 4} cells.
          </p>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Lane</th>
                  <th>Today</th>
                  <th>Proposed</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row) => (
                  <tr key={`${row.origin}>${row.destination}`}>
                    <td>
                      {row.origin} → {row.destination}
                    </td>
                    <td>{row.standard === null ? 'not carried' : `₹${row.standard}/kg`}</td>
                    <td>{row.proposed === null ? 'not carried' : `₹${row.proposed}/kg`}</td>
                    <td>
                      {row.opensLane && <span className="chip">opens lane</span>}
                      {row.closesLane && <span className="chip rejected">closes lane</span>}
                      {row.pctChange !== null && (
                        <span className={`delta ${row.pctChange > 0 ? 'up' : 'down'}`}>
                          {row.pctChange > 0 ? '+' : ''}
                          {row.pctChange.toFixed(1)}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview !== null && preview.length === 0 && (
        <p className="empty">
          Nothing to preview against the zone grid — this rule prices by city, state or
          pincode, which is exactly what the grid cannot express. The coverage above is its
          blast radius.
        </p>
      )}

      <div className="actionbar">
        <button
          type="button"
          className="btn"
          disabled={!origin || !destination || pending}
          onClick={() => {
            if (!origin || !destination) return;
            startTransition(async () =>
              setPreview(
                await onPreview(mode, origin, destination, {
                  minCharge: numeric(rates.minCharge),
                  tier1: numeric(rates.tier1),
                  tier2: numeric(rates.tier2),
                  tier3: numeric(rates.tier3),
                }),
              ),
            );
          }}
        >
          Preview lane by lane
        </button>
        <button type="button" className="btn primary" disabled={!ready || pending} onClick={save}>
          {pending ? 'Working…' : 'Add rule to draft'}
        </button>
        {!canEdit && <span className="meta">This draft is awaiting approval.</span>}
      </div>
    </div>
  );
}
