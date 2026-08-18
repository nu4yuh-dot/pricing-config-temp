# Phase 1 — Smart geography (mockup Part 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-cell-per-lane pricing with rules that price at pincode, city, state, zone, group or pan-India granularity, so a negotiation is stored as the rule that was actually agreed instead of the hundreds of cells it expands to.

**Architecture:** A rule is `{ mode, origin: Endpoint, destination: Endpoint, rates }`. Resolution collects every matching rule, orders by specificity, and returns the winner — already built and committed. This phase adds the city level, rule storage keyed by a stable id so the existing approval machinery can diff a rule, rule consultation at quote time with fallback to the zone grid, and the console screen: one search box across every geography level, a coverage preview, the precedence cascade, and a shipment tester.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Next.js 15 App Router with server components and server actions, MongoDB, Vitest.

## Global Constraints

- **The 150 golden fixtures and 127 Bluedart fixtures must stay green at every commit.** A card with no rules must quote byte-identically to today. Run `npx vitest run src/pricing/golden.test.ts src/pricing/bluedart-golden.test.ts src/customers/real-contracts.test.ts` before every commit.
- **`npx tsc --noEmit` must exit 0 before every commit.** This repo runs `noUncheckedIndexedAccess`; `array[0]` is `T | undefined` and destructuring will not narrow it.
- **`null` is a value, not an absence.** It means "lane not carried". Test presence with `Object.hasOwn`, never truthiness.
- **Sparse storage.** A rule stores only what was negotiated. Never write a rule per lane.
- **Money is rupees as `number` in the pricing engine** (integer paise is the billing ledger only, out of scope here).
- **Existing exports must not change signature.** `resolveLaneRule`, `matchesEndpoint`, `endpointSpecificity`, `gridBindPath`, `gridLaneProvenance` are committed and consumed by `src/pricing/quote.ts` and `src/console/lanes.ts`.

## Already built (do not rebuild)

Committed on branch `lane-granularity`:

```ts
// src/domain/lane-rules.ts
export type EndpointKind = 'pincode' | 'city' | 'zone' | 'state' | 'group' | 'any';
export interface Endpoint { kind: EndpointKind; value?: string }
export function endpointSpecificity(kind: EndpointKind): number   // pincode 5 … any 0
export function matchesEndpoint(e: Endpoint, p: Pincode, mode: StoredMode): boolean
export type RuleLayer = 'base' | 'contract';
export interface LaneRule<R> { mode: StoredMode; origin: Endpoint; destination: Endpoint; rates: R; layer: RuleLayer; updatedAt?: number }
export interface LaneResolution<R> { rule: LaneRule<R>; trace: string; specificity: number; ambiguous: boolean }
export function resolveLaneRule<R>(rules: readonly LaneRule<R>[], shipment: { mode: StoredMode; origin: Pincode; destination: Pincode }): LaneResolution<R> | null
export function gridBindPath(mode: StoredMode, rate: 'minCharge'|'tier1'|'tier2'|'tier3', origin: string, destination: string): string
export interface LaneProvenance { layer: RuleLayer; negotiated: string[]; trace: string }
export function gridLaneProvenance(lane: { mode: StoredMode; originZone: string; destinationZone: string; overrides?: Record<string, unknown> }): LaneProvenance
```

`Pincode` in `src/domain/types.ts` already declares `city?: string` (optional, unpopulated). `matchesEndpoint` with `kind: 'city'` currently matches nothing, by design — Task 1 populates it.

---

### Task 1: City on the pincode master

**Why:** Part 4's search box is city-first. The master holds `area` (a post office) and `state`. Every pincode carries `bluedart.district` (19,494 of 19,494, 747 distinct), which is the spec's own option (a).

**Files:**
- Create: `src/domain/city.ts`
- Test: `src/domain/city.test.ts`
- Modify: `scripts/extract_bluedart.py` is **not** touched — city is derived at load, not baked into the data file.

**Interfaces:**
- Produces: `cityOf(pincode: Pincode): string | undefined`, `CITY_ALIASES: Record<string, string>`, `withCity(pincode: Pincode): Pincode`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/city.test.ts
import { describe, test, expect } from 'vitest';
import { cityOf, withCity } from './city';
import type { Pincode } from './types';

function at(pincode: number, district: string, state = 'Maharashtra'): Pincode {
  const mode = { serviceable: true, hub: 'PNQ', zone: 'PNQ', edlKm: 0, oda: false, odaCategory: 'Non-ODA' };
  return {
    pincode, area: 'Test PO', state,
    air: mode, surface: mode, rail: { ...mode, station: 'PNQ' },
    bluedart: { zone: 'A', odaStatus: 'Non-ODA', edlKm: 0, district },
  } as Pincode;
}

describe('city derived from district', () => {
  test('uses the district the Bluedart import carries', () => {
    expect(cityOf(at(411001, 'Pune'))).toBe('Pune');
  });

  test('renames districts the business calls something else', () => {
    expect(cityOf(at(560001, 'Bengaluru Urban', 'Karnataka'))).toBe('Bangalore');
  });

  test('a pincode with no district has no city rather than a wrong one', () => {
    const noDistrict = at(411001, '');
    delete (noDistrict as { bluedart?: unknown }).bluedart;
    expect(cityOf(noDistrict)).toBeUndefined();
  });

  test('withCity fills the field the matcher reads', () => {
    expect(withCity(at(411001, 'Pune')).city).toBe('Pune');
  });

  test('withCity leaves a pincode without a district untouched', () => {
    const noDistrict = at(411001, '');
    delete (noDistrict as { bluedart?: unknown }).bluedart;
    expect(withCity(noDistrict).city).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/city.test.ts`
Expected: FAIL — `Failed to resolve import "./city"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/city.ts
import type { Pincode } from './types';

/**
 * City, derived from the district the Bluedart import carries.
 *
 * The pincode master's own `area` is a post office — 300 of them in Maharashtra alone —
 * so it cannot serve as a city. District is populated for every pincode on file and is
 * the closest thing to a city the data actually has.
 *
 * Two known imprecisions, recorded rather than hidden. District merges towns that trade
 * as separate cities: Pimpri-Chinchwad pincodes carry district `Pune`. And a few
 * districts are named differently from the city everybody says, which the alias table
 * below fixes for the ones that come up. Both are display concerns — the `city` endpoint
 * matches on a string, so refining this later needs no change to the matcher.
 */

/** District name -> what the business calls it. */
export const CITY_ALIASES: Record<string, string> = {
  'Bengaluru Urban': 'Bangalore',
  'Bengaluru Rural': 'Bangalore',
  Mumbai: 'Mumbai',
  'Mumbai Suburban': 'Mumbai',
  Gurgaon: 'Gurugram',
  Gautam Buddha Nagar: 'Noida',
};

export function cityOf(pincode: Pincode): string | undefined {
  const district = pincode.bluedart?.district?.trim();
  if (!district) return undefined;
  return CITY_ALIASES[district] ?? district;
}

/** The same pincode with `city` filled in, for the matcher to read. */
export function withCity(pincode: Pincode): Pincode {
  const city = cityOf(pincode);
  return city === undefined ? pincode : { ...pincode, city };
}
```

Note: `Gautam Buddha Nagar` is not a valid identifier — write it quoted: `'Gautam Buddha Nagar': 'Noida',`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/city.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Apply `withCity` at the data boundary**

Find where pincodes are loaded: `grep -rn "pincodes.json\|findPincode" src/data/`. In the loader that returns a `Pincode` to callers, map the result through `withCity`. Add a test in the existing pincode data test asserting a loaded `411001` has `city === 'Pune'`.

- [ ] **Step 6: Verify the city endpoint now matches**

Add to `src/domain/lane-rules.test.ts`:

```ts
test('a city endpoint matches a pincode whose district resolved to that city', () => {
  const pune = withCity(pincodeAt({ pincode: 411001, state: 'Maharashtra' }));
  expect(matchesEndpoint({ kind: 'city', value: 'Pune' }, pune, 'surface')).toBe(true);
});
```

The existing test `city cannot match until the pincode master carries a city` stays green — it builds a pincode with no `bluedart` block, so it still has no city. Import `withCity` and extend `pincodeAt` to take an optional `district`.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/domain/city.ts src/domain/city.test.ts src/domain/lane-rules.test.ts src/data/
git commit -m "Derive city from the district already on every pincode"
```

---

### Task 2: Rule storage with a reviewable identity

**Why:** Rules must reach the approval diff. `diffCardData` reports a change only for a cell that renders at a fixed address (`src/changes/diff.ts:82-102`), and `getByPath`/`setByPath` walk dotted paths. A rule list keyed by a stable id gives every rate on every rule a real path — `laneRules.r_7f3a.tier1` — so the existing override, diff, prune and proposal machinery works on rules unchanged.

**Deviation from the design spec, deliberate:** the spec wrote `laneRules[]` as an array. An array index is not a stable identity — inserting a rule renumbers every rule after it, and an override keyed on `laneRules.3.tier1` would silently retarget. A record keyed by id has no order, which is fine: resolution sorts by specificity and breaks ties on `updatedAt`, so storage order is never consulted.

**Files:**
- Modify: `src/domain/types.ts` (add `laneRules` to `RateCardData`)
- Create: `src/domain/lane-rule-store.ts`
- Test: `src/domain/lane-rule-store.test.ts`

**Interfaces:**
- Consumes: `Endpoint`, `LaneRule`, `RuleLayer` from Task 0 (already committed)
- Produces: `StoredLaneRule`, `newRuleId()`, `rulesFrom(data, layer)`, `ruleBindPath(id, rate)`, `upsertRule(data, rule)`, `removeRule(data, id)`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/lane-rule-store.test.ts
import { describe, test, expect } from 'vitest';
import { newRuleId, ruleBindPath, rulesFrom, upsertRule, removeRule } from './lane-rule-store';
import type { StoredLaneRule } from './lane-rule-store';
import type { RateCardData } from './types';

const rule: StoredLaneRule = {
  id: 'r_test',
  mode: 'surface',
  origin: { kind: 'city', value: 'Pune' },
  destination: { kind: 'city', value: 'Bangalore' },
  rates: { minCharge: 0, tier1: 21, tier2: 21, tier3: 21 },
  updatedAt: 1_000,
};

const emptyCard = { grids: { air: {}, surface: {}, rail: {} } } as unknown as RateCardData;

describe('rule identity', () => {
  test('a new id is prefixed and unique', () => {
    const a = newRuleId();
    const b = newRuleId();
    expect(a).toMatch(/^r_[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });

  test('every rate on a rule has its own bind path', () => {
    expect(ruleBindPath('r_test', 'tier1')).toBe('laneRules.r_test.rates.tier1');
  });
});

describe('reading rules off a card', () => {
  test('a card with no rules yields none, so it prices exactly as today', () => {
    expect(rulesFrom(emptyCard, 'base')).toEqual([]);
  });

  test('stored rules are returned stamped with the layer that held them', () => {
    const card = upsertRule(emptyCard, rule);
    const [read] = rulesFrom(card, 'contract');
    expect(read?.layer).toBe('contract');
    expect(read?.rates.tier1).toBe(21);
  });
});

describe('writing rules', () => {
  test('upsert adds a rule without touching the grids', () => {
    const card = upsertRule(emptyCard, rule);
    expect(Object.keys(card.laneRules ?? {})).toEqual(['r_test']);
    expect(card.grids).toEqual(emptyCard.grids);
  });

  test('upsert on an existing id replaces it rather than adding a second', () => {
    const once = upsertRule(emptyCard, rule);
    const twice = upsertRule(once, { ...rule, rates: { ...rule.rates, tier1: 19 } });
    expect(Object.keys(twice.laneRules ?? {})).toHaveLength(1);
    expect(twice.laneRules?.r_test?.rates.tier1).toBe(19);
  });

  test('upsert does not mutate the card it was given', () => {
    upsertRule(emptyCard, rule);
    expect(emptyCard.laneRules).toBeUndefined();
  });

  test('removing a rule leaves the rest alone', () => {
    const card = upsertRule(upsertRule(emptyCard, rule), { ...rule, id: 'r_other' });
    const after = removeRule(card, 'r_test');
    expect(Object.keys(after.laneRules ?? {})).toEqual(['r_other']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/lane-rule-store.test.ts`
Expected: FAIL — `Failed to resolve import "./lane-rule-store"`.

- [ ] **Step 3: Add the field to `RateCardData`**

In `src/domain/types.ts`, inside `RateCardData`, after `grids`:

```ts
  /**
   * Lane rules, keyed by a stable id.
   *
   * Additive: the zone x zone grid above is the case where both endpoints are zones,
   * and a card with no rules quotes exactly as it did before rules existed. Keyed by
   * id rather than held in an array so that every rate has a stable dotted path and
   * the override, diff and approval machinery works on a rule unchanged.
   */
  laneRules?: Record<string, StoredLaneRule>;
```

Import the type: `import type { StoredLaneRule } from './lane-rule-store';`. If that creates a cycle (`lane-rule-store` imports `RateCardData`), declare `StoredLaneRule` in `types.ts` instead and have `lane-rule-store.ts` re-export it.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/domain/lane-rule-store.ts
import type { Endpoint, LaneRule, RuleLayer } from './lane-rules';
import type { LaneRates } from '../pricing/freight';
import type { RateCardData, StoredMode } from './types';

/**
 * A rule as it is stored. Note there is no `layer` field: a rule's layer is where it
 * was found — on the base card, or in a customer's contract — not something it declares.
 * Stamping it at read time makes it impossible for a contract to hold a rule claiming
 * to be a base rule.
 */
export interface StoredLaneRule {
  id: string;
  mode: StoredMode;
  origin: Endpoint;
  destination: Endpoint;
  rates: LaneRates;
  /** Epoch ms, for the resolver's last tie-break. */
  updatedAt?: number;
}

export function newRuleId(): string {
  return `r_${Math.random().toString(36).slice(2, 10)}`;
}

/** `laneRules.r_7f3a.rates.tier1` — a real path, so getByPath and setByPath work. */
export function ruleBindPath(id: string, rate: keyof LaneRates): string {
  return `laneRules.${id}.rates.${rate}`;
}

/** Every rule on this card, stamped with the layer it was read from. */
export function rulesFrom(data: RateCardData, layer: RuleLayer): LaneRule<LaneRates>[] {
  return Object.values(data.laneRules ?? {}).map((rule) => ({
    mode: rule.mode,
    origin: rule.origin,
    destination: rule.destination,
    rates: rule.rates,
    layer,
    ...(rule.updatedAt === undefined ? {} : { updatedAt: rule.updatedAt }),
  }));
}

export function upsertRule(data: RateCardData, rule: StoredLaneRule): RateCardData {
  return { ...data, laneRules: { ...data.laneRules, [rule.id]: rule } };
}

export function removeRule(data: RateCardData, id: string): RateCardData {
  const { [id]: _removed, ...rest } = data.laneRules ?? {};
  return { ...data, laneRules: rest };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/domain/lane-rule-store.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/domain/lane-rule-store.ts src/domain/lane-rule-store.test.ts src/domain/types.ts
git commit -m "Store lane rules under a stable id so a rule can be reviewed"
```

---

### Task 3: Rules priced at quote time, grid as fallback

**Why:** Nothing consults rules yet. This is where the feature becomes real, and where the golden fixtures earn their keep: with no rules defined, every one of the 150 must still match to the rupee.

**Files:**
- Modify: `src/pricing/quote.ts`
- Test: `src/pricing/quote.test.ts`

**Interfaces:**
- Consumes: `rulesFrom`, `resolveLaneRule`, `LaneRates`
- Produces: `quote()` gains a 6th optional parameter `contractRules?: RateCardData` — no; see step 3, rules are read off the cards already passed in.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/pricing/quote.test.ts
import { upsertRule } from '../domain/lane-rule-store';
import { withCity } from '../domain/city';

describe('quote — lane rules override the grid', () => {
  const puneWithCity = { ...PNQ, city: 'Pune' };
  const ncrWithCity = { ...NCR, city: 'Delhi' };

  test('with no rules a quote is identical to the grid quote', () => {
    const withRules = { ...card, data: { ...card.data, laneRules: {} } };
    const a = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, card);
    const b = quote({ mode: 'surface', actualWeight: 200 }, { origin: PNQ, destination: NCR }, withRules);

    if (!a.available || !b.available) throw new Error('expected available quotes');
    expect(b.breakdown.total).toBe(a.breakdown.total);
  });

  test('a city rule prices the lane and names itself in the trace', () => {
    const ruled = {
      ...card,
      data: upsertRule(card.data, {
        id: 'r_city',
        mode: 'surface',
        origin: { kind: 'city', value: 'Pune' },
        destination: { kind: 'city', value: 'Delhi' },
        rates: { minCharge: 0, tier1: 21, tier2: 21, tier3: 21 },
      }),
    };

    const result = quote(
      { mode: 'surface', actualWeight: 200 },
      { origin: puneWithCity, destination: ncrWithCity },
      ruled,
    );

    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.rates.tier1).toBe(21);
    expect(result.breakdown.laneProvenance.trace).toBe('Pune → Delhi · city → city · base');
  });

  test('a rule that does not match leaves the grid in charge', () => {
    const ruled = {
      ...card,
      data: upsertRule(card.data, {
        id: 'r_elsewhere',
        mode: 'surface',
        origin: { kind: 'city', value: 'Chennai' },
        destination: { kind: 'any' },
        rates: { minCharge: 0, tier1: 99, tier2: 99, tier3: 99 },
      }),
    };

    const plain = quote({ mode: 'surface', actualWeight: 200 }, { origin: puneWithCity, destination: ncrWithCity }, card);
    const result = quote({ mode: 'surface', actualWeight: 200 }, { origin: puneWithCity, destination: ncrWithCity }, ruled);

    if (!plain.available || !result.available) throw new Error('expected available quotes');
    expect(result.breakdown.total).toBe(plain.breakdown.total);
    expect(result.breakdown.laneProvenance.trace).toContain('zone → zone');
  });

  test('the NFO multiplier still applies to a rate that came from a rule', () => {
    const ruled = {
      ...card,
      data: upsertRule(card.data, {
        id: 'r_air',
        mode: 'air',
        origin: { kind: 'city', value: 'Pune' },
        destination: { kind: 'any' },
        rates: { minCharge: 0, tier1: 100, tier2: 100, tier3: 100 },
      }),
    };

    const result = quote({ mode: 'nfo', actualWeight: 200 }, { origin: puneWithCity, destination: ncrWithCity }, ruled);
    if (!result.available) throw new Error('expected an available quote');
    expect(result.breakdown.rates.tier1).toBe(100 * card.data.charges.nfoMultiplier);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pricing/quote.test.ts`
Expected: FAIL on the city-rule test — `expected 21, received <grid rate>`.

- [ ] **Step 3: Write minimal implementation**

In `src/pricing/quote.ts`, add imports:

```ts
import { rulesFrom } from '../domain/lane-rule-store';
import { resolveLaneRule } from '../domain/lane-rules';
```

Replace the `const rates = laneRates(...)` block with:

```ts
  // A rule prices the lane when one matches; otherwise the zone x zone grid does, which
  // is what every card did before rules existed. The grid is itself the zone-to-zone
  // case, so this is a fallback in storage only, not in meaning.
  const resolution = resolveLaneRule(rulesFrom(card.data, 'base'), {
    mode: storedMode,
    origin,
    destination,
  });

  const rates: LaneRates = resolution
    ? {
        minCharge: scale(resolution.rule.rates.minCharge, rules.multiplier),
        tier1: scale(resolution.rule.rates.tier1, rules.multiplier),
        tier2: scale(resolution.rule.rates.tier2, rules.multiplier),
        tier3: scale(resolution.rule.rates.tier3, rules.multiplier),
      }
    : laneRates(card.data.grids[storedMode], originInfo.zone, destInfo.zone, rules.multiplier);
```

Add the helper beside `laneRates`:

```ts
/** NFO is the air card multiplied through, and a rule's rates are multiplied the same way. */
function scale(value: number | null, multiplier: number): number | null {
  return value === null ? null : value * multiplier;
}
```

Then make the breakdown prefer the rule's trace:

```ts
      laneProvenance: resolution
        ? { layer: resolution.rule.layer, negotiated: [], trace: resolution.trace }
        : gridLaneProvenance({
            mode: storedMode,
            originZone: originInfo.zone,
            destinationZone: destInfo.zone,
            ...(overrides === undefined ? {} : { overrides }),
          }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/pricing/quote.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the golden fixtures — this is the step that matters**

Run: `npx vitest run src/pricing/golden.test.ts src/pricing/bluedart-golden.test.ts src/customers/real-contracts.test.ts`
Expected: PASS, 301 tests. No fixture card defines `laneRules`, so `resolveLaneRule` returns null everywhere and the grid path is unchanged. **If any fixture moves, stop and find out why — do not update a fixture.**

- [ ] **Step 6: Wire contract rules through the API**

In `src/app/api/quote/route.ts`, the contract quote already receives the effective card. Because `effectiveCard` folds overrides in via `setByPath`, a contract's `laneRules.<id>.rates.tier1` override lands on the merged card automatically and `rulesFrom(card.data, 'base')` will read it — but stamped `base`, which is wrong.

Change `quote()` to take the layer's rules explicitly instead:

```ts
  const resolution = resolveLaneRule(
    [
      ...rulesFrom(card.data, 'base'),
      ...(contractRules ? rulesFrom(contractRules, 'contract') : []),
    ],
    { mode: storedMode, origin, destination },
  );
```

with a 6th parameter `contractRules?: RateCardData`. Pass `{ laneRules: customer.liveTerms.contractRules }` from the route. Add `contractRules?: Record<string, StoredLaneRule>` to `ContractTerms` in `src/domain/customers.ts`.

Add a test proving a contract rule beats a more specific base rule end to end, mirroring the layer tests already in `src/domain/lane-rules.test.ts`.

- [ ] **Step 7: Full suite, typecheck, build, commit**

```bash
npx vitest run && npx tsc --noEmit && npm run build
git add src/pricing/quote.ts src/pricing/quote.test.ts src/app/api/quote/route.ts src/domain/customers.ts
git commit -m "Price a lane from the rule that matches it, grid when none does"
```

---

### Task 4: The geography search index

**Why:** Part 4's single search box. It must return pincode, city, state, zone, group and pan-India matches, grouped by level, most specific first — the mockup's `geoData` list and `order` array.

**Files:**
- Create: `src/domain/geo-search.ts`
- Test: `src/domain/geo-search.test.ts`

**Interfaces:**
- Produces: `GeoResult { kind: EndpointKind; value: string; label: string; meta: string }`, `searchGeography(query, pincodes, mode, limit?): GeoResult[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/geo-search.test.ts
import { describe, test, expect } from 'vitest';
import { searchGeography } from './geo-search';
import type { Pincode } from './types';

function at(pincode: number, district: string, state: string, zone: string): Pincode {
  const mode = { serviceable: true, hub: zone, zone, edlKm: 0, oda: false, odaCategory: 'Non-ODA' };
  return {
    pincode, area: `${district} PO`, state, city: district,
    air: mode, surface: mode, rail: { ...mode, station: zone },
  } as Pincode;
}

const MASTER = [
  at(411001, 'Pune', 'Maharashtra', 'PNQ'),
  at(411045, 'Pune', 'Maharashtra', 'PNQ'),
  at(400001, 'Mumbai', 'Maharashtra', 'BOM'),
  at(560001, 'Bangalore', 'Karnataka', 'BLR'),
];

describe('searching every level of geography at once', () => {
  test('a bare pincode finds that pincode', () => {
    const hits = searchGeography('411001', MASTER, 'surface');
    expect(hits[0]).toMatchObject({ kind: 'pincode', value: '411001' });
  });

  test('a city name finds the city, and says how many pincodes it holds', () => {
    const city = searchGeography('pune', MASTER, 'surface').find((r) => r.kind === 'city');
    expect(city?.value).toBe('Pune');
    expect(city?.meta).toContain('2 pincodes');
  });

  test('a state name finds the state', () => {
    const state = searchGeography('mahar', MASTER, 'surface').find((r) => r.kind === 'state');
    expect(state?.value).toBe('Maharashtra');
  });

  test('a zone code finds the zone', () => {
    const zone = searchGeography('bom', MASTER, 'surface').find((r) => r.kind === 'zone');
    expect(zone?.value).toBe('BOM');
  });

  test('"metro" finds the named zone group', () => {
    const group = searchGeography('metro', MASTER, 'surface').find((r) => r.kind === 'group');
    expect(group?.value).toBe('metros');
  });

  test('results come back most specific first', () => {
    const kinds = searchGeography('pu', MASTER, 'surface').map((r) => r.kind);
    const first = kinds.indexOf('city');
    const later = kinds.indexOf('state');
    if (first !== -1 && later !== -1) expect(first).toBeLessThan(later);
  });

  test('an empty query offers the broad levels rather than nothing', () => {
    const kinds = searchGeography('', MASTER, 'surface').map((r) => r.kind);
    expect(kinds).toContain('any');
  });

  test('a query matching nothing returns nothing', () => {
    expect(searchGeography('zzzz', MASTER, 'surface')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/geo-search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/geo-search.ts
import { AIR_ZONES, SURFACE_ZONES } from './zones';
import { ZONE_GROUPS } from './zone-groups';
import { endpointSpecificity, type EndpointKind } from './lane-rules';
import type { Pincode, StoredMode } from './types';

export interface GeoResult {
  kind: EndpointKind;
  /** What goes into the endpoint. */
  value: string;
  /** What the person reads. */
  label: string;
  /** The grey line to its right — how many pincodes, which state, which zone. */
  meta: string;
}

const matches = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().startsWith(needle);

/**
 * One search across every level of geography.
 *
 * Ordered most specific first, because that is also the order the resolver checks in —
 * somebody scanning these results is reading the cascade they are about to add to.
 */
export function searchGeography(
  query: string,
  master: readonly Pincode[],
  mode: StoredMode,
  limit = 8,
): GeoResult[] {
  const q = query.trim().toLowerCase();
  const results: GeoResult[] = [];

  if (q) {
    for (const p of master) {
      if (results.filter((r) => r.kind === 'pincode').length >= limit) break;
      if (String(p.pincode).startsWith(q)) {
        results.push({
          kind: 'pincode',
          value: String(p.pincode),
          label: String(p.pincode),
          meta: `${p.area} · ${p.state} · ${p[mode].zone}`,
        });
      }
    }

    const cities = new Map<string, { count: number; state: string; zone: string }>();
    for (const p of master) {
      if (!p.city) continue;
      const seen = cities.get(p.city);
      if (seen) seen.count += 1;
      else cities.set(p.city, { count: 1, state: p.state, zone: p[mode].zone });
    }
    for (const [city, info] of cities) {
      if (!matches(city, q)) continue;
      results.push({
        kind: 'city',
        value: city,
        label: city,
        meta: `${info.count} pincode${info.count === 1 ? '' : 's'} · ${info.state} · ${info.zone}`,
      });
    }

    const states = new Map<string, number>();
    for (const p of master) states.set(p.state, (states.get(p.state) ?? 0) + 1);
    for (const [state, count] of states) {
      if (!matches(state, q)) continue;
      results.push({ kind: 'state', value: state, label: state, meta: `${count} pincodes` });
    }

    const zones: readonly string[] = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
    for (const zone of zones) {
      if (!matches(zone, q)) continue;
      results.push({ kind: 'zone', value: zone, label: zone, meta: `Zone · ${mode}` });
    }

    for (const group of ZONE_GROUPS) {
      if (!matches(group.name, q) && !matches(group.key, q)) continue;
      results.push({
        kind: 'group',
        value: group.key,
        label: group.name,
        meta: group.description,
      });
    }
  }

  if (!q || matches('pan-india', q) || matches('any', q)) {
    results.push({ kind: 'any', value: '', label: 'Pan-India', meta: 'Anything not covered above' });
  }

  return results.sort((a, b) => endpointSpecificity(b.kind) - endpointSpecificity(a.kind));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/geo-search.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/domain/geo-search.ts src/domain/geo-search.test.ts
git commit -m "One search across pincode, city, state, zone, group and pan-India"
```

---

### Task 5: Coverage preview — what a rule actually touches

**Why:** The mockup's "1,240 pincodes, stored as 1 rule" tree. Somebody adding a state-level rule must see its blast radius before they add it, and the count is the argument for rules over cells.

**Files:**
- Create: `src/domain/rule-coverage.ts`
- Test: `src/domain/rule-coverage.test.ts`

**Interfaces:**
- Produces: `CoverageSummary { pincodes: number; cities: { city: string; pincodes: number[] }[] }`, `coverageOf(endpoint, master, mode): CoverageSummary`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/rule-coverage.test.ts
import { describe, test, expect } from 'vitest';
import { coverageOf } from './rule-coverage';
import type { Pincode } from './types';

function at(pincode: number, city: string, state: string, zone: string): Pincode {
  const mode = { serviceable: true, hub: zone, zone, edlKm: 0, oda: false, odaCategory: 'Non-ODA' };
  return { pincode, area: 'PO', state, city, air: mode, surface: mode, rail: { ...mode, station: zone } } as Pincode;
}

const MASTER = [
  at(411001, 'Pune', 'Maharashtra', 'PNQ'),
  at(411045, 'Pune', 'Maharashtra', 'PNQ'),
  at(400001, 'Mumbai', 'Maharashtra', 'BOM'),
  at(560001, 'Bangalore', 'Karnataka', 'BLR'),
];

describe('what an endpoint covers', () => {
  test('a state covers every pincode in it, grouped by city', () => {
    const c = coverageOf({ kind: 'state', value: 'Maharashtra' }, MASTER, 'surface');
    expect(c.pincodes).toBe(3);
    expect(c.cities.map((x) => x.city).sort()).toEqual(['Mumbai', 'Pune']);
    expect(c.cities.find((x) => x.city === 'Pune')?.pincodes).toEqual([411001, 411045]);
  });

  test('a single pincode covers exactly itself', () => {
    expect(coverageOf({ kind: 'pincode', value: '411001' }, MASTER, 'surface').pincodes).toBe(1);
  });

  test('pan-India covers the whole master', () => {
    expect(coverageOf({ kind: 'any' }, MASTER, 'surface').pincodes).toBe(4);
  });

  test('an endpoint matching nothing covers nothing rather than everything', () => {
    expect(coverageOf({ kind: 'city', value: 'Nowhere' }, MASTER, 'surface').pincodes).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/rule-coverage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/rule-coverage.ts
import { matchesEndpoint, type Endpoint } from './lane-rules';
import type { Pincode, StoredMode } from './types';

export interface CoverageSummary {
  pincodes: number;
  cities: { city: string; pincodes: number[] }[];
}

/**
 * Every pincode one end of a rule selects, grouped by city.
 *
 * This is the number that makes the case for rules: a state endpoint is one stored rule
 * and four figures of pincodes, where the cell model would have needed a row for each.
 */
export function coverageOf(
  endpoint: Endpoint,
  master: readonly Pincode[],
  mode: StoredMode,
): CoverageSummary {
  const byCity = new Map<string, number[]>();
  let total = 0;

  for (const pincode of master) {
    if (!matchesEndpoint(endpoint, pincode, mode)) continue;
    total += 1;
    const city = pincode.city ?? 'Unknown city';
    const list = byCity.get(city);
    if (list) list.push(pincode.pincode);
    else byCity.set(city, [pincode.pincode]);
  }

  return {
    pincodes: total,
    cities: [...byCity.entries()]
      .map(([city, pincodes]) => ({ city, pincodes }))
      .sort((a, b) => b.pincodes.length - a.pincodes.length),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/rule-coverage.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/domain/rule-coverage.ts src/domain/rule-coverage.test.ts
git commit -m "Show how many pincodes a rule reaches before it is added"
```

---

### Task 6: The precedence cascade and the shipment tester

**Why:** The mockup's two trust devices — "all rules, most specific first, same order the resolver checks" and "test a shipment, which rule actually wins". Both must be computed by the *same* code that prices, or they are decoration.

**Files:**
- Modify: `src/domain/lane-rules.ts` (add `orderRules`, `explainResolution`)
- Test: `src/domain/lane-rules.test.ts`

**Interfaces:**
- Produces: `orderRules<R>(rules): LaneRule<R>[]`, `explainResolution<R>(rules, shipment): { steps: { trace: string; matched: boolean; rates: R }[]; winner: LaneResolution<R> | null }`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/domain/lane-rules.test.ts
describe('the precedence cascade', () => {
  test('orders rules the way the resolver checks them', () => {
    const broad = rule('broad', { kind: 'any' }, { kind: 'any' });
    const exact = rule('exact', { kind: 'pincode', value: '411001' }, { kind: 'pincode', value: '110001' });
    const city = rule('city', { kind: 'city', value: 'Pune' }, { kind: 'city', value: 'Delhi' });

    expect(orderRules([broad, city, exact]).map((r) => r.rates)).toEqual(['exact', 'city', 'broad']);
  });
});

describe('explaining a resolution', () => {
  test('walks the cascade and marks the one that won', () => {
    const exact = rule('exact', { kind: 'pincode', value: '411001' }, { kind: 'pincode', value: '110001' });
    const zone = rule('zone', { kind: 'zone', value: 'PNQ' }, { kind: 'zone', value: 'NCR' });

    const { steps, winner } = explainResolution([zone, exact], shipment);

    expect(winner?.rule.rates).toBe('exact');
    expect(steps[0]).toMatchObject({ rates: 'exact', matched: true });
    expect(steps.map((s) => s.rates)).toEqual(['exact', 'zone']);
  });

  test('a rule that does not match is listed as not matching, not hidden', () => {
    const elsewhere = rule('elsewhere', { kind: 'city', value: 'Chennai' }, { kind: 'any' });
    const { steps } = explainResolution([elsewhere], shipment);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.matched).toBe(false);
  });

  test('no rules at all explains nothing rather than throwing', () => {
    expect(explainResolution([], shipment)).toEqual({ steps: [], winner: null });
  });
});
```

Add `orderRules, explainResolution` to the import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/lane-rules.test.ts`
Expected: FAIL — `orderRules is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/domain/lane-rules.ts`. Extract the existing comparator out of `resolveLaneRule` so ordering is defined once:

```ts
function compareRules<R>(a: LaneRule<R>, b: LaneRule<R>): number {
  const totalA = endpointSpecificity(a.origin.kind) + endpointSpecificity(a.destination.kind);
  const totalB = endpointSpecificity(b.origin.kind) + endpointSpecificity(b.destination.kind);
  return (
    totalB - totalA ||
    endpointSpecificity(b.origin.kind) - endpointSpecificity(a.origin.kind) ||
    (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  );
}

/** Every rule, most specific first — the order the resolver checks in. */
export function orderRules<R>(rules: readonly LaneRule<R>[]): LaneRule<R>[] {
  return [...rules].sort(compareRules);
}

/**
 * The cascade for one shipment, for somebody who wants to see why.
 *
 * Deliberately computed from the same ordering the resolver uses, so this can never
 * drift into telling a reassuring story about a price it did not produce.
 */
export function explainResolution<R>(
  rules: readonly LaneRule<R>[],
  shipment: { mode: StoredMode; origin: Pincode; destination: Pincode },
): { steps: { trace: string; matched: boolean; rates: R }[]; winner: LaneResolution<R> | null } {
  const winner = resolveLaneRule(rules, shipment);
  const steps = orderRules(rules.filter((rule) => rule.mode === shipment.mode)).map((rule) => ({
    trace: traceOf(rule),
    matched:
      matchesEndpoint(rule.origin, shipment.origin, shipment.mode) &&
      matchesEndpoint(rule.destination, shipment.destination, shipment.mode),
    rates: rule.rates,
  }));

  return { steps, winner };
}
```

Refactor `resolveLaneRule`'s inline `layer.sort(...)` to use `compareRules` on the rule, keeping its tests green.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/lane-rules.test.ts`
Expected: PASS — the 27 existing tests plus 4 new.

- [ ] **Step 5: Commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/domain/lane-rules.ts src/domain/lane-rules.test.ts
git commit -m "Explain a resolution using the same order that produced it"
```

---

### Task 7: The Smart geography console page

**Why:** Everything above is invisible until someone can use it. This is the mockup's Part 4 screen: search box, two endpoint chips, four rate fields, the conflict callout, the coverage tree, the precedence list and the shipment tester.

**Files:**
- Create: `src/app/(app)/console/[card]/geography/page.tsx`
- Create: `src/components/console/GeographyRuleEditor.tsx`
- Create: `src/components/console/RuleCascade.tsx`
- Create: `src/components/console/ShipmentTester.tsx`
- Modify: `src/app/(app)/console/[card]/layout.tsx` (add the rail link)
- Modify: `src/app/console-actions.ts` (add `saveLaneRule`, `deleteLaneRule`)
- Modify: `src/app/globals.css` (styles for `.geo-results`, `.geo-item`, `.lvl`, `.precedence-row`, `.geo-chip`)

**Interfaces:**
- Consumes: `searchGeography`, `coverageOf`, `orderRules`, `explainResolution`, `upsertRule`, `removeRule`, `newRuleId`, `rulesFrom`

- [ ] **Step 1: Add the server actions**

In `src/app/console-actions.ts`:

```ts
export async function saveLaneRule(cardKey: string, rule: StoredLaneRule) {
  const user = await authorise('edit-draft');
  const draft = await draftVersion(cardKey);
  const next = upsertRule(draft.data, { ...rule, updatedAt: Date.now() });
  await replaceDraftData(cardKey, next, toActor(user));
  revalidatePath('/console/[card]', 'layout');
}

export async function deleteLaneRule(cardKey: string, id: string) {
  const user = await authorise('edit-draft');
  const draft = await draftVersion(cardKey);
  await replaceDraftData(cardKey, removeRule(draft.data, id), toActor(user));
  revalidatePath('/console/[card]', 'layout');
}
```

`replaceDraftData` does not exist yet. Add it to `src/data/rate-cards.ts` next to `editDraftCells`, following that function's audit-trail pattern exactly — read how `editDraftCells` records the actor and writes the draft, and mirror it. Do not bypass the audit trail.

- [ ] **Step 2: Write the page**

Server component. Load the card draft, the pincode master, and render:

1. **Search box + results** — client component calling `searchGeography` through a server action, results grouped by kind with a coloured level chip (`.lvl-pincode` red, `.lvl-city` blue, `.lvl-state` teal, `.lvl-zone` amber, `.lvl-group` purple, `.lvl-panindia` grey), matching the mockup's palette.
2. **Origin and destination chips** — clicking a result fills the endpoint.
3. **Four rate fields** — minimum, tier 1, tier 2, tier 3, same labels as `LaneEditor`.
4. **Conflict callout** — when the endpoint pair is more specific than an existing rule that also matches, say so in the mockup's words: "This is **more specific** than the existing **X** rate (₹N/kg). It will apply only to … — every other … keeps the … rate untouched." Compute by running `orderRules` over the draft's rules and finding the first that would match a representative pincode of the new endpoint.
5. **Coverage tree** — `coverageOf` for each endpoint, rendered as `<details>` per city with its pincodes, plus the headline "N pincodes, stored as 1 rule".
6. **Add rule to draft** button → `saveLaneRule`.

- [ ] **Step 3: Write the cascade component**

`RuleCascade.tsx` renders `orderRules(rulesFrom(draft.data, 'base'))` as numbered `.precedence-row` entries: rank, `trace`, a sub-line naming the coverage, and the tier-1 rate as a pill. Last row is the pan-India default when one exists, greyed.

- [ ] **Step 4: Write the shipment tester**

`ShipmentTester.tsx` takes two pincodes, calls a server action that loads both from the master and runs `explainResolution`, and renders the mockup's output: a blue callout `<origin> → <dest> resolves to ₹N/kg via <trace>`, then the walked steps with the winner in bold and the rest muted.

- [ ] **Step 5: Add the rail link**

In `src/app/(app)/console/[card]/layout.tsx`, inside the non-Bluedart branch, after `Lane rates`:

```tsx
<Link href={`/console/${cardKey}/geography`}>Smart geography</Link>
```

- [ ] **Step 6: Verify**

```bash
npx vitest run && npx tsc --noEmit && npm run build
```

Then run the app and check by hand: add a `city Pune → city Bangalore` rule, confirm the coverage count is non-zero, confirm it appears in the cascade above the zone rules, and confirm the tester resolves `411001 → 560001` to it. **The repo has no component test harness — this step is manual, and saying so is part of the task.**

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/console/\[card\]/geography src/components/console src/app/console-actions.ts src/app/globals.css src/data/rate-cards.ts
git commit -m "The Smart geography screen — search, coverage, cascade and a tester"
```

---

## Self-review against the mockup's Part 4

| Mockup element | Task |
|---|---|
| One search box, every level, grouped by specificity | 4, 7 |
| Level chips (pincode/city/state/zone/group/pan-India) | 4, 7 |
| Origin and destination chips | 7 |
| Minimum + tier 1–3 fields, unchanged pricing model | 3, 7 |
| "More specific than the existing X rate" conflict callout | 7 |
| Coverage preview tree, "1,240 pincodes, stored as 1 rule" | 5, 7 |
| Precedence list, most specific first | 6, 7 |
| "Same order the resolver checks at quote time" | 6 — computed by the resolver's own comparator |
| Test a shipment → which rule wins | 6, 7 |
| "Walk the hierarchy … before falling back to today's flat zone lookup" | 3 |
| "Model 1/2/3 math and delta-only storage don't change" | 3, Global Constraints |
| Reused in Part 1 pricing/coverage steps and Part 6 products | Phase 3 — the components in Task 7 are built standalone for reuse |

**Not in this phase, by design:** the mockup notes the picker is reused in Part 1's wizard and Part 6's products. Those parts are Phase 3; Task 7 builds the components so they take their data as props rather than loading it, so the reuse costs nothing later.
