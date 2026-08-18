import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  effectiveCard,
  overridesFrom,
  pruneOverrides,
  checkContract,
  overrideCount,
} from './contract';
import { laneKey, UNRESTRICTED_SCOPE, type ContractTerms } from '../domain/customers';
import { setByPath, getByPath } from '../sheets/resolve';
import type { RateCard, RateCardData } from '../domain/types';
import { normaliseCustomerCode } from '../data/customers';

const base: RateCard = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'model-1.json'), 'utf8'),
);

const terms = (partial: Partial<ContractTerms> = {}): ContractTerms => ({
  overrides: {},
  scope: UNRESTRICTED_SCOPE,
  ...partial,
});

describe('effectiveCard', () => {
  test('is the base card when nothing has been negotiated', () => {
    expect(effectiveCard(base, terms()).data).toEqual(base.data);
  });

  test('applies a negotiated rate over the base', () => {
    const card = effectiveCard(
      base,
      terms({ overrides: { 'grids.surface.minCharge.PNQ.NCR': 450 } }),
    );
    expect(getByPath(card.data, 'grids.surface.minCharge.PNQ.NCR')).toBe(450);
  });

  test('leaves every other cell reading through to the base', () => {
    const card = effectiveCard(
      base,
      terms({ overrides: { 'grids.surface.minCharge.PNQ.NCR': 450 } }),
    );
    expect(getByPath(card.data, 'grids.surface.minCharge.PNQ.BOM')).toBe(
      getByPath(base.data, 'grids.surface.minCharge.PNQ.BOM'),
    );
  });

  test('does not mutate the base card', () => {
    effectiveCard(base, terms({ overrides: { 'grids.surface.minCharge.PNQ.NCR': 450 } }));
    expect(getByPath(base.data, 'grids.surface.minCharge.PNQ.NCR')).toBe(530);
  });

  test('a base-card change flows through to cells the customer has not negotiated', () => {
    // The whole point of storing sparsely: the customer follows the base card
    // everywhere they have not agreed something different.
    const movedBase: RateCard = {
      ...base,
      data: setByPath<RateCardData>(base.data, 'grids.surface.minCharge.PNQ.BOM', 999),
    };
    const card = effectiveCard(
      movedBase,
      terms({ overrides: { 'grids.surface.minCharge.PNQ.NCR': 450 } }),
    );
    expect(getByPath(card.data, 'grids.surface.minCharge.PNQ.BOM')).toBe(999);
    expect(getByPath(card.data, 'grids.surface.minCharge.PNQ.NCR')).toBe(450);
  });

  test('can override a global charge parameter', () => {
    const card = effectiveCard(base, terms({ overrides: { 'charges.fuelSurface': 0.2 } }));
    expect(card.data.charges.fuelSurface).toBe(0.2);
    expect(card.data.charges.fuelAir).toBe(base.data.charges.fuelAir);
  });

  test('can override serviceability by withdrawing a lane', () => {
    const card = effectiveCard(
      base,
      terms({ overrides: { 'grids.surface.minCharge.PNQ.GAU': null } }),
    );
    expect(getByPath(card.data, 'grids.surface.minCharge.PNQ.GAU')).toBeNull();
  });
});

describe('overridesFrom', () => {
  test('records only the cells that differ from the base', () => {
    let edited = setByPath<RateCardData>(base.data, 'grids.surface.minCharge.PNQ.NCR', 450);
    edited = setByPath(edited, 'grids.surface.tier1.PNQ.NCR', 13);

    const result = overridesFrom(base.data, edited);
    expect(Object.keys(result).sort()).toEqual([
      'grids.surface.minCharge.PNQ.NCR',
      'grids.surface.tier1.PNQ.NCR',
    ]);
    expect(result['grids.surface.minCharge.PNQ.NCR']).toBe(450);
  });

  test('is empty when nothing differs', () => {
    expect(overridesFrom(base.data, base.data)).toEqual({});
  });
});

describe('pruneOverrides', () => {
  test('drops an override that now equals the base value', () => {
    // The base moved to meet the negotiated price, so the override is dead weight.
    const movedBase = setByPath<RateCardData>(base.data, 'grids.surface.minCharge.PNQ.NCR', 450);
    const { overrides, removed } = pruneOverrides(movedBase, {
      'grids.surface.minCharge.PNQ.NCR': 450,
      'grids.surface.tier1.PNQ.NCR': 13,
    });

    expect(Object.keys(overrides)).toEqual(['grids.surface.tier1.PNQ.NCR']);
    expect(removed).toEqual(['grids.surface.minCharge.PNQ.NCR']);
  });

  test('keeps overrides that still differ', () => {
    const { overrides, removed } = pruneOverrides(base.data, {
      'grids.surface.minCharge.PNQ.NCR': 450,
    });
    expect(Object.keys(overrides)).toEqual(['grids.surface.minCharge.PNQ.NCR']);
    expect(removed).toEqual([]);
  });
});

describe('overrideCount', () => {
  test('summarises how far a contract has drifted from the base', () => {
    const summary = overrideCount({
      'grids.surface.minCharge.PNQ.NCR': 450,
      'grids.surface.tier1.PNQ.NCR': 13,
      'grids.air.minCharge.PNQ.NCR': 1700,
      'charges.fuelSurface': 0.2,
    });
    expect(summary.total).toBe(4);
    expect(summary.byArea).toEqual({ surface: 2, air: 1, charges: 1 });
  });
});

describe('checkContract — unrestricted', () => {
  test('accepts anything when the contract has no restrictions', () => {
    const result = checkContract(UNRESTRICTED_SCOPE, {
      mode: 'surface',
      origin: 'PNQ',
      destination: 'GAU',
      chargeableWeight: 5000,
    });
    expect(result.inContract).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe('checkContract — modes', () => {
  const scope = { ...UNRESTRICTED_SCOPE, modes: ['surface' as const] };

  test('accepts a contracted mode', () => {
    expect(
      checkContract(scope, { mode: 'surface', origin: 'PNQ', destination: 'NCR', chargeableWeight: 100 })
        .inContract,
    ).toBe(true);
  });

  test('rejects a mode outside the contract, and says which', () => {
    const result = checkContract(scope, {
      mode: 'air',
      origin: 'PNQ',
      destination: 'NCR',
      chargeableWeight: 100,
    });
    expect(result.inContract).toBe(false);
    expect(result.reasons).toEqual(['mode-not-in-contract']);
    expect(result.messages[0]).toMatch(/air/i);
  });
});

describe('checkContract — lanes', () => {
  const scope = {
    ...UNRESTRICTED_SCOPE,
    lanes: [laneKey('surface', 'PNQ', 'NCR'), laneKey('surface', 'PNQ', 'BOM')],
  };

  test('accepts a contracted lane', () => {
    expect(
      checkContract(scope, { mode: 'surface', origin: 'PNQ', destination: 'NCR', chargeableWeight: 100 })
        .inContract,
    ).toBe(true);
  });

  test('rejects a lane outside the contract, naming it', () => {
    const result = checkContract(scope, {
      mode: 'surface',
      origin: 'PNQ',
      destination: 'GAU',
      chargeableWeight: 100,
    });
    expect(result.inContract).toBe(false);
    expect(result.reasons).toEqual(['lane-not-in-contract']);
    expect(result.messages[0]).toMatch(/PNQ.*GAU/);
  });

  test('treats direction as significant, since rates are directional', () => {
    const result = checkContract(scope, {
      mode: 'surface',
      origin: 'NCR',
      destination: 'PNQ',
      chargeableWeight: 100,
    });
    expect(result.inContract).toBe(false);
  });

  test('NFO is checked against the air network it flies on', () => {
    const airScope = { ...UNRESTRICTED_SCOPE, lanes: [laneKey('air', 'PNQ', 'NCR')] };
    expect(
      checkContract(airScope, { mode: 'nfo', origin: 'PNQ', destination: 'NCR', chargeableWeight: 100 })
        .inContract,
    ).toBe(true);
  });
});

describe('checkContract — weight bands', () => {
  const scope = {
    ...UNRESTRICTED_SCOPE,
    weightBands: [
      { from: 0, to: 100 },
      { from: 300, to: null },
    ],
  };

  test('accepts a weight inside a contracted band', () => {
    expect(
      checkContract(scope, { mode: 'surface', origin: 'PNQ', destination: 'NCR', chargeableWeight: 50 })
        .inContract,
    ).toBe(true);
  });

  test('accepts a weight in an unbounded band', () => {
    expect(
      checkContract(scope, { mode: 'surface', origin: 'PNQ', destination: 'NCR', chargeableWeight: 5000 })
        .inContract,
    ).toBe(true);
  });

  test('rejects a weight in the gap between contracted bands', () => {
    const result = checkContract(scope, {
      mode: 'surface',
      origin: 'PNQ',
      destination: 'NCR',
      chargeableWeight: 200,
    });
    expect(result.inContract).toBe(false);
    expect(result.reasons).toEqual(['weight-not-in-contract']);
    expect(result.messages[0]).toMatch(/200/);
  });

  test('treats a band as half open, so its upper bound belongs to the next band', () => {
    expect(
      checkContract(scope, { mode: 'surface', origin: 'PNQ', destination: 'NCR', chargeableWeight: 100 })
        .inContract,
    ).toBe(false);
    expect(
      checkContract(scope, { mode: 'surface', origin: 'PNQ', destination: 'NCR', chargeableWeight: 99.9 })
        .inContract,
    ).toBe(true);
  });
});

describe('checkContract — several problems at once', () => {
  test('reports every reason, so the operator sees the whole picture', () => {
    const scope = {
      modes: ['surface' as const],
      lanes: [laneKey('surface', 'PNQ', 'NCR')],
      weightBands: [{ from: 0, to: 100 }],
    };
    const result = checkContract(scope, {
      mode: 'air',
      origin: 'PNQ',
      destination: 'GAU',
      chargeableWeight: 500,
    });
    expect(result.inContract).toBe(false);
    expect(result.reasons.sort()).toEqual([
      'lane-not-in-contract',
      'mode-not-in-contract',
      'weight-not-in-contract',
    ]);
    expect(result.messages).toHaveLength(3);
  });
});

/**
 * Codes travel through URLs, and some contain a space — "SANDVIK PUNE" — which arrives
 * from a route parameter still percent-encoded. Every lookup has to resolve the same
 * customer whichever form it is handed, or the contract page 404s on a customer that
 * plainly exists in the list beside it.
 */
describe('normaliseCustomerCode', () => {
  test('decodes a percent-encoded code', () => {
    expect(normaliseCustomerCode('SANDVIK%20PUNE')).toBe('SANDVIK PUNE');
  });

  test('leaves an already-decoded code alone', () => {
    expect(normaliseCustomerCode('SANDVIK PUNE')).toBe('SANDVIK PUNE');
  });

  test('upper-cases and trims, as codes are stored', () => {
    expect(normaliseCustomerCode('  acme-1 ')).toBe('ACME-1');
  });

  /** A stray percent is not encoding; it must not throw and take the page down with it. */
  test('survives a malformed escape rather than throwing', () => {
    expect(() => normaliseCustomerCode('100%')).not.toThrow();
    expect(normaliseCustomerCode('100%')).toBe('100%');
  });
});
