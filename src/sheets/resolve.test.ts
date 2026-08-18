import { describe, expect, test } from 'vitest';
import { renderSheet, getByPath, setByPath } from './resolve';
import type { SheetSpec } from './types';

const data = {
  grids: {
    surface: {
      minCharge: {
        PNQ: { PNQ: 300, NCR: 530 },
        NCR: { PNQ: 530, NCR: 300 },
      },
    },
  },
  charges: { fuelSurface: 0.25 },
  pickupDelivery: {
    PNQ: { pickupSurface: 400, deliverySurface: 800 },
    NCR: { pickupSurface: 800, deliverySurface: 800 },
  },
};

describe('getByPath', () => {
  test('reads a nested value', () => {
    expect(getByPath(data, 'grids.surface.minCharge.PNQ.NCR')).toBe(530);
  });

  test('returns undefined for a path that does not exist', () => {
    expect(getByPath(data, 'grids.air.minCharge.PNQ.NCR')).toBeUndefined();
  });
});

describe('setByPath', () => {
  test('writes a nested value without mutating the original', () => {
    const updated = setByPath(data, 'grids.surface.minCharge.PNQ.NCR', 560);
    expect(getByPath(updated, 'grids.surface.minCharge.PNQ.NCR')).toBe(560);
    expect(getByPath(data, 'grids.surface.minCharge.PNQ.NCR')).toBe(530);
  });

  test('leaves sibling values intact', () => {
    const updated = setByPath(data, 'grids.surface.minCharge.PNQ.NCR', 560);
    expect(getByPath(updated, 'grids.surface.minCharge.PNQ.PNQ')).toBe(300);
    expect(getByPath(updated, 'grids.surface.minCharge.NCR.PNQ')).toBe(530);
  });
});

const matrixSpec: SheetSpec = {
  id: 'test-matrix',
  name: 'Surface Rates',
  columns: 4,
  blocks: [
    { type: 'title', at: 'A1', text: 'SURFACE PARTLOAD (PTL)' },
    {
      type: 'matrix',
      at: 'A3',
      title: 'MINIMUM CHARGE (Rs)',
      shortName: 'min charge',
      rowKeys: ['PNQ', 'NCR'],
      colKeys: ['PNQ', 'NCR'],
      bind: 'grids.surface.minCharge',
      corner: 'From\\To',
      format: 'currency',
    },
  ],
};

describe('renderSheet — matrix layout', () => {
  const sheet = renderSheet(matrixSpec, data);

  test('places the title at its anchor', () => {
    expect(sheet.cells.get('A1')?.value).toBe('SURFACE PARTLOAD (PTL)');
    expect(sheet.cells.get('A1')?.kind).toBe('title');
  });

  test('places the section title at the matrix anchor', () => {
    expect(sheet.cells.get('A3')?.value).toBe('MINIMUM CHARGE (Rs)');
  });

  test('puts the corner label and column headers on the row below the anchor', () => {
    expect(sheet.cells.get('A4')?.value).toBe('From\\To');
    expect(sheet.cells.get('B4')?.value).toBe('PNQ');
    expect(sheet.cells.get('C4')?.value).toBe('NCR');
    expect(sheet.cells.get('B4')?.kind).toBe('header');
  });

  test('puts row labels in the anchor column, starting two rows below', () => {
    expect(sheet.cells.get('A5')?.value).toBe('PNQ');
    expect(sheet.cells.get('A6')?.value).toBe('NCR');
    expect(sheet.cells.get('A5')?.kind).toBe('rowLabel');
  });

  test('places values at the intersections, matching the source workbook', () => {
    // The real Surface Rates sheet has the minimum charge matrix at A3 with PNQ->NCR
    // in B5..V25; this 2x2 stand-in preserves the same geometry.
    expect(sheet.cells.get('B5')?.value).toBe(300);
    expect(sheet.cells.get('C5')?.value).toBe(530);
    expect(sheet.cells.get('B6')?.value).toBe(530);
    expect(sheet.cells.get('C6')?.value).toBe(300);
  });

  test('marks value cells editable and binds them to their domain path', () => {
    const cell = sheet.cells.get('C5');
    expect(cell?.editable).toBe(true);
    expect(cell?.bind).toBe('grids.surface.minCharge.PNQ.NCR');
  });

  test('marks headers and labels not editable', () => {
    expect(sheet.cells.get('B4')?.editable).toBe(false);
    expect(sheet.cells.get('A5')?.editable).toBe(false);
    expect(sheet.cells.get('A1')?.editable).toBe(false);
  });

  test('labels a value cell well enough for an approver to judge it', () => {
    expect(sheet.cells.get('C5')?.label).toBe('Surface Rates · min charge · PNQ→NCR');
  });

  test('indexes bind paths back to their cell reference', () => {
    expect(sheet.byBind.get('grids.surface.minCharge.PNQ.NCR')).toBe('C5');
  });

  test('reports the extent of the sheet', () => {
    expect(sheet.columns).toBe(4);
    expect(sheet.rows).toBe(6);
  });
});

describe('renderSheet — round trip', () => {
  test('every editable cell resolves back to the cell that edits it', () => {
    const sheet = renderSheet(matrixSpec, data);
    const editable = [...sheet.cells.values()].filter((c) => c.editable);
    expect(editable).toHaveLength(4);
    for (const cell of editable) {
      expect(cell.bind).toBeDefined();
      expect(sheet.byBind.get(cell.bind as string)).toBe(cell.ref);
    }
  });
});

describe('renderSheet — table layout', () => {
  const tableSpec: SheetSpec = {
    id: 'test-table',
    name: 'Pickup & Delivery',
    columns: 5,
    blocks: [
      {
        type: 'table',
        at: 'A3',
        rowHeader: 'Zone',
        rowKeys: ['PNQ', 'NCR'],
        bind: 'pickupDelivery',
        columns: [
          { header: 'Industrial belt', values: { PNQ: 'Pune City', NCR: 'Delhi-NCR' }, readOnly: true },
          { header: 'Pickup Surface', field: 'pickupSurface', format: 'currency' },
          { header: 'Delivery Surface', field: 'deliverySurface', format: 'currency' },
        ],
      },
    ],
  };
  const sheet = renderSheet(tableSpec, data);

  test('writes the row header and column headers on the anchor row', () => {
    expect(sheet.cells.get('A3')?.value).toBe('Zone');
    expect(sheet.cells.get('B3')?.value).toBe('Industrial belt');
    expect(sheet.cells.get('C3')?.value).toBe('Pickup Surface');
  });

  test('writes row keys down the anchor column', () => {
    expect(sheet.cells.get('A4')?.value).toBe('PNQ');
    expect(sheet.cells.get('A5')?.value).toBe('NCR');
  });

  test('binds a field column to the row record', () => {
    expect(sheet.cells.get('C4')?.value).toBe(400);
    expect(sheet.cells.get('C4')?.bind).toBe('pickupDelivery.PNQ.pickupSurface');
    expect(sheet.cells.get('C4')?.editable).toBe(true);
  });

  test('renders a label-only column without binding it', () => {
    expect(sheet.cells.get('B4')?.value).toBe('Pune City');
    expect(sheet.cells.get('B4')?.editable).toBe(false);
    expect(sheet.cells.get('B4')?.bind).toBeUndefined();
  });
});

describe('renderSheet — params layout', () => {
  const paramsSpec: SheetSpec = {
    id: 'test-params',
    name: 'Charges & Terms',
    columns: 3,
    blocks: [
      {
        type: 'params',
        at: 'A3',
        rows: [
          { label: 'Fuel Surface', bind: 'charges.fuelSurface', note: 'surcharge', format: 'percent' },
        ],
      },
    ],
  };
  const sheet = renderSheet(paramsSpec, data);

  test('lays out label, value and note across three columns', () => {
    expect(sheet.cells.get('A4')?.value).toBe('Fuel Surface');
    expect(sheet.cells.get('B4')?.value).toBe(0.25);
    expect(sheet.cells.get('C4')?.value).toBe('surcharge');
  });

  test('makes only the value editable', () => {
    expect(sheet.cells.get('A4')?.editable).toBe(false);
    expect(sheet.cells.get('B4')?.editable).toBe(true);
    expect(sheet.cells.get('C4')?.editable).toBe(false);
  });

  test('carries the format through so a fraction renders as a percentage', () => {
    expect(sheet.cells.get('B4')?.format).toBe('percent');
  });
});

describe('renderSheet — band matrix', () => {
  /**
   * The EDL matrix carries no section-title row: in the source its header sits
   * directly on `A3` with data from `A4`. Both sets of band edges are editable,
   * because the team can retune the distance and weight breakpoints themselves.
   */
  const edlData = {
    edlMatrix: {
      kmBands: [20, 51],
      weightBands: [0, 101],
      rates: [
        [550, 990],
        [825, 1210],
      ],
    },
  };
  const spec: SheetSpec = {
    id: 'test-band',
    name: 'EDL Matrix',
    columns: 6,
    blocks: [
      {
        type: 'bandMatrix',
        at: 'A3',
        shortName: 'ODA surcharge',
        rowHeader: 'Min km',
        rowBandsBind: 'edlMatrix.kmBands',
        colBandsBind: 'edlMatrix.weightBands',
        ratesBind: 'edlMatrix.rates',
      },
    ],
  };
  const sheet = renderSheet(spec, edlData);

  test('puts the row header on the anchor itself, not a row below', () => {
    expect(sheet.cells.get('A3')?.value).toBe('Min km');
    expect(sheet.cells.get('A3')?.kind).toBe('header');
  });

  test('puts the weight band edges across the anchor row, editable', () => {
    expect(sheet.cells.get('B3')?.value).toBe(0);
    expect(sheet.cells.get('C3')?.value).toBe(101);
    expect(sheet.cells.get('C3')?.editable).toBe(true);
    expect(sheet.cells.get('C3')?.bind).toBe('edlMatrix.weightBands.1');
  });

  test('puts the km band edges down the anchor column, editable', () => {
    expect(sheet.cells.get('A4')?.value).toBe(20);
    expect(sheet.cells.get('A5')?.value).toBe(51);
    expect(sheet.cells.get('A5')?.bind).toBe('edlMatrix.kmBands.1');
  });

  test('places surcharges at the intersections', () => {
    expect(sheet.cells.get('B4')?.value).toBe(550);
    expect(sheet.cells.get('C5')?.value).toBe(1210);
    expect(sheet.cells.get('C5')?.bind).toBe('edlMatrix.rates.1.1');
  });

  test('labels a surcharge by both of its bands', () => {
    expect(sheet.cells.get('C5')?.label).toBe(
      'EDL Matrix · ODA surcharge · from 51 km · from 101 kg',
    );
  });
});

describe('renderSheet — note panels stay in place', () => {
  test('renders a HOW TO READ panel at its own coordinates', () => {
    const spec: SheetSpec = {
      id: 'test-panel',
      name: 'Surface Rates',
      columns: 29,
      blocks: [
        {
          type: 'notePanel',
          at: 'X3',
          title: 'HOW TO READ — SURFACE',
          lines: ['21 industrial clusters.', 'Add fuel 25%.'],
        },
      ],
    };
    const sheet = renderSheet(spec, data);
    expect(sheet.cells.get('X3')?.value).toBe('HOW TO READ — SURFACE');
    expect(sheet.cells.get('X4')?.value).toBe('21 industrial clusters.');
    expect(sheet.cells.get('X5')?.value).toBe('Add fuel 25%.');
    expect(sheet.cells.get('X4')?.editable).toBe(false);
  });
});

describe('setByPath and arrays', () => {
  /**
   * The ODA matrix is a list of lists, and it is walked by `.length`. Spreading an array
   * into an object literal produces `{0: …, 1: …}` — indistinguishable by index, and no
   * longer a list. Editing one band used to do exactly that, after which
   * `approximateBandIndex` found no bands and every out-of-area surcharge quietly became
   * zero. Nothing failed; the money just stopped.
   */
  const matrix = { rates: [[10, 20], [30, 40]], kmBands: [5, 10] };

  test('a nested array stays an array', () => {
    const after = setByPath(matrix, 'rates.0.1', 99) as typeof matrix;
    expect(Array.isArray(after.rates)).toBe(true);
    expect(Array.isArray(after.rates[0])).toBe(true);
    expect(after.rates[0]).toEqual([10, 99]);
    expect(after.rates).toHaveLength(2);
  });

  test('a flat array stays an array', () => {
    const after = setByPath(matrix, 'kmBands.1', 12) as typeof matrix;
    expect(Array.isArray(after.kmBands)).toBe(true);
    expect(after.kmBands).toEqual([5, 12]);
  });

  test('the untouched branch is shared, not copied', () => {
    const after = setByPath(matrix, 'rates.0.1', 99) as typeof matrix;
    expect(after.rates[1]).toBe(matrix.rates[1]);
  });

  test('an object is still an object', () => {
    const after = setByPath({ a: { b: 1 } }, 'a.b', 2);
    expect(after).toEqual({ a: { b: 2 } });
    expect(Array.isArray(after.a)).toBe(false);
  });
});
