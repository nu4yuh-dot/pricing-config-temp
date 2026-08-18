import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCard, validateChanges, DEFAULT_VALIDATION_OPTIONS } from './validate';
import { diffCardData } from './diff';
import { setByPath } from '../sheets/resolve';
import type { RateCard, RateCardData } from '../domain/types';

const card: RateCard = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'model-1.json'), 'utf8'),
);
const base = card.data;

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe('validateCard — decremental tiers', () => {
  /**
   * The source data is not clean. Every rate sheet header promises rates that
   * "step down by weight", but two rail lanes to Guwahati price the 300+ kg tier
   * ABOVE the 100-300 kg tier. Asserted explicitly so the defect is recorded and a
   * regression would be caught.
   */
  test('finds the two inverted rail tiers that the source data actually contains', () => {
    const findings = validateCard(base, 'CUMULATIVE_SLABS').filter(
      (f) => f.code === 'tiers-not-decremental',
    );
    expect(findings.map((f) => f.bind).sort()).toEqual([
      'grids.rail.tier3.UPX.GAU',
      'grids.rail.tier3.UTR.GAU',
    ]);
    expect(findings[0]?.message).toMatch(/higher than/);
  });

  test('finds no other inverted tiers anywhere in the card', () => {
    const findings = validateCard(base, 'CUMULATIVE_SLABS').filter(
      (f) => f.code === 'tiers-not-decremental',
    );
    expect(findings).toHaveLength(2);
  });

  test('flags a lane where tier 2 exceeds tier 1', () => {
    // Surface PNQ→NCR is 15 / 14 / 12; push tier 2 above tier 1.
    const broken = setByPath<RateCardData>(base, 'grids.surface.tier2.PNQ.NCR', 20);
    const findings = validateCard(broken, 'CUMULATIVE_SLABS');
    const finding = findings.find((f) => f.code === 'tiers-not-decremental');

    expect(finding).toBeDefined();
    expect(finding?.bind).toBe('grids.surface.tier2.PNQ.NCR');
    expect(finding?.message).toMatch(/PNQ→NCR/);
  });

  test('flags a lane where tier 3 exceeds tier 2', () => {
    const broken = setByPath<RateCardData>(base, 'grids.surface.tier3.PNQ.NCR', 20);
    expect(codes(validateCard(broken, 'CUMULATIVE_SLABS'))).toContain('tiers-not-decremental');
  });

  test('accepts equal adjacent tiers, which are flat rather than inverted', () => {
    let flat = setByPath<RateCardData>(base, 'grids.surface.tier2.PNQ.NCR', 15);
    flat = setByPath(flat, 'grids.surface.tier3.PNQ.NCR', 15);
    const findings = validateCard(flat, 'CUMULATIVE_SLABS').filter(
      (f) => f.code === 'tiers-not-decremental' && f.bind?.includes('PNQ.NCR'),
    );
    expect(findings).toEqual([]);
  });
});

describe('validateCard — non-positive values', () => {
  test('flags a zero minimum charge', () => {
    const broken = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', 0);
    const finding = validateCard(broken, 'CUMULATIVE_SLABS').find(
      (f) => f.code === 'non-positive-rate',
    );
    expect(finding?.bind).toBe('grids.surface.minCharge.PNQ.NCR');
  });

  test('flags a negative per-kg rate', () => {
    const broken = setByPath<RateCardData>(base, 'grids.surface.tier1.PNQ.NCR', -5);
    expect(codes(validateCard(broken, 'CUMULATIVE_SLABS'))).toContain('non-positive-rate');
  });

  test('does not flag an unserved lane, which is null rather than zero', () => {
    const findings = validateCard(base, 'CUMULATIVE_SLABS').filter(
      (f) => f.code === 'non-positive-rate',
    );
    expect(findings).toEqual([]);
  });
});

describe('validateCard — pricing that falls as weight rises', () => {
  /**
   * Applying a single decremental tier rate to the whole shipment means crossing a
   * tier boundary can reprice everything lower. Model 1's progressive slabs cannot
   * do this; Models 2 and 3 do it on most lanes in the source data.
   */
  test('finds none in Model 1', () => {
    const findings = validateCard(base, 'CUMULATIVE_SLABS').filter(
      (f) => f.code === 'price-falls-as-weight-rises',
    );
    expect(findings).toEqual([]);
  });

  test('finds them in Model 2 on the source data', () => {
    const model2: RateCard = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'model-2.json'), 'utf8'),
    );
    const findings = validateCard(model2.data, 'MIN_PLUS_EXCESS').filter(
      (f) => f.code === 'price-falls-as-weight-rises',
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toMatch(/cheaper/i);
  });

  test('finds them in Model 3 on the source data', () => {
    const model3: RateCard = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'model-3.json'), 'utf8'),
    );
    const findings = validateCard(model3.data, 'MAX_MIN_OR_FULL').filter(
      (f) => f.code === 'price-falls-as-weight-rises',
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  test('can be switched off for teams that treat it as a volume incentive', () => {
    const model2: RateCard = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'model-2.json'), 'utf8'),
    );
    const findings = validateCard(model2.data, 'MIN_PLUS_EXCESS', {
      ...DEFAULT_VALIDATION_OPTIONS,
      checkMonotonicPricing: false,
    });
    expect(codes(findings)).not.toContain('price-falls-as-weight-rises');
  });
});

describe('validateChanges — movement', () => {
  test('flags a change beyond the movement threshold', () => {
    const after = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', 700);
    const findings = validateChanges(diffCardData(base, after));
    const finding = findings.find((f) => f.code === 'large-movement');

    expect(finding).toBeDefined();
    expect(finding?.message).toMatch(/32\.1%/);
  });

  test('stays quiet for a change inside the threshold', () => {
    const after = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', 545);
    expect(codes(validateChanges(diffCardData(base, after)))).not.toContain('large-movement');
  });

  test('honours a custom threshold', () => {
    const after = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', 545);
    const findings = validateChanges(diffCardData(base, after), {
      ...DEFAULT_VALIDATION_OPTIONS,
      movementThresholdPct: 1,
    });
    expect(codes(findings)).toContain('large-movement');
  });
});

describe('validateChanges — availability', () => {
  test('flags a lane being withdrawn', () => {
    const after = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', null);
    const finding = validateChanges(diffCardData(base, after)).find(
      (f) => f.code === 'lane-withdrawn',
    );
    expect(finding?.message).toMatch(/no longer/i);
  });

  test('flags a lane being opened', () => {
    const after = setByPath<RateCardData>(base, 'grids.air.minCharge.PNQ.BOM', 2000);
    expect(codes(validateChanges(diffCardData(base, after)))).toContain('lane-opened');
  });
});

describe('validateChanges — high blast radius', () => {
  test('flags an edit to a global charge parameter', () => {
    const after = setByPath<RateCardData>(base, 'charges.fuelSurface', 0.3);
    const finding = validateChanges(diffCardData(base, after)).find(
      (f) => f.code === 'global-parameter',
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
  });

  test('does not flag an ordinary lane rate as global', () => {
    const after = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', 545);
    expect(codes(validateChanges(diffCardData(base, after)))).not.toContain('global-parameter');
  });
});

describe('validateCard — lane symmetry', () => {
  test('flags a lane that diverges sharply from its reverse', () => {
    // PNQ→NCR and NCR→PNQ are both 530 in the source.
    const broken = setByPath<RateCardData>(base, 'grids.surface.minCharge.PNQ.NCR', 1200);
    const finding = validateCard(broken, 'CUMULATIVE_SLABS').find(
      (f) => f.code === 'asymmetric-lane',
    );
    expect(finding).toBeDefined();
  });

  /**
   * The source data is near-symmetric apart from two surface lanes into Guwahati,
   * which cost Rs 860 outbound against Rs 410 inbound. That may well be deliberate —
   * North East inbound is famously cheaper to fill than outbound — so it is reported
   * as info rather than a warning.
   */
  test('finds the two Guwahati lanes that the source data actually contains', () => {
    const findings = validateCard(base, 'CUMULATIVE_SLABS').filter(
      (f) => f.code === 'asymmetric-lane',
    );
    expect(findings.map((f) => f.bind).sort()).toEqual([
      'grids.surface.minCharge.AMD.GAU',
      'grids.surface.minCharge.CSN.GAU',
    ]);
  });

  test('reports asymmetry as info, since a directional rate can be intentional', () => {
    const finding = validateCard(base, 'CUMULATIVE_SLABS').find(
      (f) => f.code === 'asymmetric-lane',
    );
    expect(finding?.severity).toBe('info');
  });
});
