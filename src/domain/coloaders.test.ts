import { describe, test, expect } from 'vitest';
import { coloadersFrom, laneMargins } from './coloaders';
import type { CostGrids, RateCardData } from './types';

const emptyMode = { minCharge: {}, tier1: {}, tier2: {}, tier3: {} };

const cost: CostGrids = {
  carrier: 'Surya Cargo',
  method: 'CUMULATIVE_SLABS',
  grids: {
    air: {
      minCharge: { PNQ: { CCU: 400 } },
      tier1: { PNQ: { CCU: 52 } },
      tier2: { PNQ: { CCU: 50 } },
      tier3: { PNQ: { CCU: 48 } },
    },
    surface: emptyMode,
    rail: emptyMode,
  },
} as unknown as CostGrids;

describe('finding the co-loaders', () => {
  test('a card with a cost grid is a co-loader; one without is not', () => {
    const found = coloadersFrom([
      { key: 'model-1', name: 'Model 1', data: { cost } as unknown as RateCardData },
      { key: 'model-2', name: 'Model 2', data: {} as RateCardData },
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ carrier: 'Surya Cargo', cardKey: 'model-1', lanes: 1 });
  });

  test('modes are the ones actually priced, not the ones the card has grids for', () => {
    // Every card has three mode grids. Listing "air, surface, rail" for a tariff that
    // covers one lane by air would be a claim about coverage nobody made.
    const found = coloadersFrom([
      { key: 'model-1', name: 'Model 1', data: { cost } as unknown as RateCardData },
    ]);

    expect(found[0]?.modes).toEqual(['air']);
  });
});

describe('margin across the customers on a lane', () => {
  const base = {
    cardKey: 'model-1',
    cost,
    mode: 'air' as const,
    origin: 'PNQ',
    destination: 'CCU',
    chargeableWeight: 100,
    minWeight: 25,
    sellMethod: 'CUMULATIVE_SLABS' as const,
  };

  test('each customer is compared on freight alone, both sides', () => {
    const rows = laneMargins({
      ...base,
      customers: [
        {
          code: 'MAHLE',
          name: 'MAHLE',
          baseCardKey: 'model-1',
          rates: { minCharge: 600, tier1: 78, tier2: 75, tier3: 70 },
        },
      ],
    });

    expect(rows[0]?.margin?.buy).toBeGreaterThan(0);
    expect(rows[0]?.margin?.profit).toBe((rows[0]?.sell ?? 0) - (rows[0]?.margin?.buy ?? 0));
  });

  test('selling under the buy rate reads as a loss, not as a thin margin', () => {
    const rows = laneMargins({
      ...base,
      customers: [
        {
          code: 'FIBRO',
          name: 'Fibro',
          baseCardKey: 'model-1',
          rates: { minCharge: 200, tier1: 40, tier2: 40, tier3: 40 },
        },
      ],
    });

    expect(rows[0]?.margin?.loss).toBe(true);
  });

  test('a customer on another card is skipped rather than compared', () => {
    // Their rates are real; they are simply not being bought from this co-loader, and a
    // margin computed across the two would be a number nobody earns.
    const rows = laneMargins({
      ...base,
      customers: [
        {
          code: 'OTHER',
          name: 'Other',
          baseCardKey: 'model-3',
          rates: { minCharge: 600, tier1: 78, tier2: 75, tier3: 70 },
        },
      ],
    });

    expect(rows[0]?.margin).toBeNull();
    expect(rows[0]?.skipped).toContain('model-3');
  });

  test('a lane the contract does not carry is skipped, not priced at zero', () => {
    const rows = laneMargins({
      ...base,
      customers: [
        {
          code: 'NOLANE',
          name: 'No lane',
          baseCardKey: 'model-1',
          rates: { minCharge: null, tier1: null, tier2: null, tier3: null },
        },
      ],
    });

    expect(rows[0]?.skipped).toContain('not carried');
  });
});
