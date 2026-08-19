import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHEET_SPECS, EDITABLE_SHEET_SPECS, SHEET_SPECS_BY_ID } from './index';
import { renderSheet, getByPath } from '../resolve';
import type { RateCard } from '../../domain/types';
import { SURFACE_ZONES, AIR_ZONES } from '../../domain/zones';

const card: RateCard = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'data', 'extracted', 'model-1.json'), 'utf8'),
);

describe('the tabs', () => {
  /**
   * The sixteen source tabs in their original order, plus `Tax & Charges`, `FTL Rates` and
   * `Bluedart Rates` — the last coming from a different source entirely, kept as a tab so its
   * rates edit and approve exactly like the rest.
   * The order is asserted because the team navigates by position and says "the fourth tab".
   */
  test('are all present, in the source workbook order', () => {
    expect(SHEET_SPECS.map((s) => s.name)).toEqual([
      'DNS Logistics',
      'Rate Calculator',
      'Ex-Origin Rate Card',
      'All-In Quote',
      'Air Rates',
      'Surface Rates',
      'Rail Rates',
      'Pickup & Delivery',
      'TAT Air',
      'TAT Surface',
      'ETA Rail',
      'Cluster Guide',
      'EDL Matrix',
      'Charges & Terms',
      'Tax & Charges',
      'FTL Rates',
      'Bluedart Rates',
      'NFO Rates',
      'Pincode Master',
    ]);
  });

  test('have unique ids', () => {
    expect(SHEET_SPECS_BY_ID.size).toBe(SHEET_SPECS.length);
  });
});

describe('rate sheets reproduce the source coordinates', () => {
  /**
   * These addresses were read off the actual workbooks. If a spec drifts, the team
   * loses the ability to say "change J5" and mean the same cell they always have.
   */
  test('Surface Rates puts the minimum charge for PNQ→NCR at J5', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('surface') as never, card.data);
    const cell = sheet.cells.get('J5');
    expect(cell?.bind).toBe('grids.surface.minCharge.PNQ.NCR');
    expect(cell?.value).toBe(530);
  });

  test('Surface Rates stacks its four matrices at rows 3, 27, 51 and 75', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('surface') as never, card.data);
    expect(sheet.cells.get('B5')?.bind).toBe('grids.surface.minCharge.PNQ.PNQ');
    expect(sheet.cells.get('B29')?.bind).toBe('grids.surface.tier1.PNQ.PNQ');
    expect(sheet.cells.get('B53')?.bind).toBe('grids.surface.tier2.PNQ.PNQ');
    expect(sheet.cells.get('B77')?.bind).toBe('grids.surface.tier3.PNQ.PNQ');
  });

  test('Surface Rates ends at row 97, as the source does', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('surface') as never, card.data);
    expect(sheet.cells.get('V97')?.bind).toBe('grids.surface.tier3.GAU.GAU');
    expect(sheet.rows).toBe(97);
  });

  test('Air Rates stacks its four matrices at rows 3, 18, 33 and 48', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('air') as never, card.data);
    expect(sheet.cells.get('B5')?.bind).toBe('grids.air.minCharge.PNQ.PNQ');
    expect(sheet.cells.get('B20')?.bind).toBe('grids.air.tier1.PNQ.PNQ');
    expect(sheet.cells.get('B35')?.bind).toBe('grids.air.tier2.PNQ.PNQ');
    expect(sheet.cells.get('B50')?.bind).toBe('grids.air.tier3.PNQ.PNQ');
    expect(sheet.rows).toBe(61);
  });

  test('Rail Rates matches the surface geometry', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('rail') as never, card.data);
    expect(sheet.cells.get('B5')?.bind).toBe('grids.rail.minCharge.PNQ.PNQ');
    expect(sheet.rows).toBe(97);
  });

  test('an unserved lane renders as null rather than a number', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('air') as never, card.data);
    // Air PNQ→BOM is '-' in the source matrix.
    expect(sheet.cells.get('C5')?.value).toBeNull();
  });

  test('the HOW TO READ panel sits at X3 on surface, O3 on air', () => {
    const surface = renderSheet(SHEET_SPECS_BY_ID.get('surface') as never, card.data);
    const air = renderSheet(SHEET_SPECS_BY_ID.get('air') as never, card.data);
    expect(surface.cells.get('X3')?.value).toBe('HOW TO READ — SURFACE');
    expect(air.cells.get('O3')?.value).toBe('HOW TO READ — AIR');
  });
});

describe('transit sheets bind to the right mode', () => {
  test('TAT Surface edits the surface transit matrix', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('tat-surface') as never, card.data);
    expect(sheet.cells.get('J5')?.bind).toBe('transitTimes.surface.PNQ.NCR');
    expect(sheet.cells.get('J5')?.value).toBe(5);
  });

  test('ETA Rail edits the rail transit matrix', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('eta-rail') as never, card.data);
    expect(sheet.cells.get('J5')?.bind).toBe('transitTimes.rail.PNQ.NCR');
  });

  test('TAT Air edits the air transit matrix', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('tat-air') as never, card.data);
    expect(sheet.cells.get('C5')?.bind).toBe('transitTimes.air.PNQ.BOM');
  });
});

describe('reference sheets', () => {
  test('Pickup & Delivery exposes all four cartage columns per zone', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('pickup-delivery') as never, card.data);
    expect(sheet.cells.get('D4')?.bind).toBe('pickupDelivery.PNQ.pickupSurface');
    expect(sheet.cells.get('D4')?.value).toBe(400);
    expect(sheet.cells.get('G4')?.bind).toBe('pickupDelivery.PNQ.deliveryAir');
    expect(sheet.cells.get('G4')?.value).toBe(2000);
  });

  test('EDL Matrix exposes the surcharge grid and both sets of band edges', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('edl-matrix') as never, card.data);
    expect(sheet.cells.get('A4')?.bind).toBe('edlMatrix.kmBands.0');
    expect(sheet.cells.get('A4')?.value).toBe(20);
    expect(sheet.cells.get('B4')?.bind).toBe('edlMatrix.rates.0.0');
    expect(sheet.cells.get('B4')?.value).toBe(550);
  });

  test('Charges & Terms exposes one value per parameter, not two', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('charges') as never, card.data);
    const binds = [...sheet.cells.values()].filter((c) => c.editable).map((c) => c.bind);
    expect(new Set(binds).size).toBe(binds.length);
    expect(sheet.cells.get('B4')?.bind).toBe('charges.pickupAir');
    expect(sheet.cells.get('B4')?.value).toBe(1000);
  });

  test('Charges & Terms surfaces every charge parameter the engine reads', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('charges') as never, card.data);
    const exposed = new Set(
      [...sheet.cells.values()]
        .filter((c) => c.bind?.startsWith('charges.'))
        .map((c) => (c.bind as string).slice('charges.'.length)),
    );
    for (const key of Object.keys(card.data.charges)) {
      expect(exposed, `charges.${key} must be editable somewhere`).toContain(key);
    }
  });

  test('Cluster Guide reports the real cluster count, not the stale one', () => {
    const sheet = renderSheet(SHEET_SPECS_BY_ID.get('cluster-guide') as never, card.data);
    // The source title claimed 20; there are 21.
    expect(sheet.cells.get('A1')?.value).toContain('(21)');
    expect(SURFACE_ZONES).toHaveLength(21);
    expect(AIR_ZONES).toHaveLength(12);
  });
});

describe('every editable cell points at data that exists', () => {
  const bluedartCard: RateCard = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', 'data', 'extracted', 'bluedart.json'), 'utf8'),
  );
  /** A tab is checked against a card of its own source; that is the card it appears on. */
  const cardFor = (spec: { source?: string }) =>
    (spec.source ?? 'dns') === 'bluedart' ? bluedartCard : card;

  for (const spec of EDITABLE_SHEET_SPECS) {
    test(`${spec.name} has no dangling bind paths`, () => {
      const sheet = renderSheet(spec, cardFor(spec).data);
      const editable = [...sheet.cells.values()].filter((c) => c.editable);
      expect(editable.length).toBeGreaterThan(0);
      for (const cell of editable) {
        expect(
          getByPath(cardFor(spec).data, cell.bind as string),
          `${spec.name}!${cell.ref} binds to ${cell.bind}, which is not in the card data`,
        ).not.toBeUndefined();
      }
    });

    test(`${spec.name} maps every editable cell back to itself`, () => {
      const sheet = renderSheet(spec, cardFor(spec).data);
      for (const cell of sheet.cells.values()) {
        if (!cell.editable) continue;
        expect(sheet.byBind.get(cell.bind as string)).toBe(cell.ref);
      }
    });

    test(`${spec.name} gives every editable cell an approver-readable label`, () => {
      const sheet = renderSheet(spec, card.data);
      for (const cell of sheet.cells.values()) {
        if (!cell.editable) continue;
        expect(cell.label, `${spec.name}!${cell.ref} has no label`).toBeTruthy();
      }
    });
  }
});

describe('coverage of the stored rate card', () => {
  test('every rate in all three modes is reachable from some tab', () => {
    const reachable = new Set<string>();
    for (const spec of EDITABLE_SHEET_SPECS) {
      for (const cell of renderSheet(spec, card.data).cells.values()) {
        if (cell.editable && cell.bind) reachable.add(cell.bind);
      }
    }

    const modes = [
      ['air', AIR_ZONES],
      ['surface', SURFACE_ZONES],
      ['rail', SURFACE_ZONES],
    ] as const;

    // Collected rather than asserted one by one: this covers 4,104 lane rates, and an
    // `expect` per rate spent most of a five-second budget inside the matcher. Gathering
    // the misses also fails with the whole list rather than the first one.
    const missing: string[] = [];
    let checked = 0;
    for (const [mode, zones] of modes) {
      for (const grid of ['minCharge', 'tier1', 'tier2', 'tier3']) {
        for (const origin of zones) {
          for (const dest of zones) {
            const bind = `grids.${mode}.${grid}.${origin}.${dest}`;
            if (!reachable.has(bind)) missing.push(bind);
            checked++;
          }
        }
      }
    }
    expect(missing).toEqual([]);
    // 4 grids x (12x12 air + 21x21 surface + 21x21 rail)
    expect(checked).toBe(4 * (144 + 441 + 441));
  });
});
