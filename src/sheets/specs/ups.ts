import type { SheetSpec, Block } from '../types';
import type { UpsCardData } from '../../domain/ups';

/**
 * The UPS / MOVIN tabs.
 *
 * These mirror the two source workbooks the card is extracted from — `Approved Rates for
 * DNS Express — Ex Mum` (Zoning Guide, Rates) and `DNS_International_RateCard` (Calculator,
 * Params, Surge Fees, Zone Guide, Buy Rates, Destinations) — so somebody who knows the
 * agreement recognises what they are looking at.
 *
 * Built from the card rather than declared, because the grid's shape is data: eighteen rate
 * zones, ten document steps, forty package steps and seven per-kilogram bands today, and a
 * renegotiated agreement changes all four. A hardcoded layout would quietly stop covering
 * the rows it had not been told about — and a row outside the layout is a rate that reaches
 * production without an approval line, which is the whole failure these specs exist to
 * prevent.
 *
 * Rows are addressed by array index because that is what `setByPath` writes, and named by
 * `rowLabels` because an approver needs to read "Package · 10 kg", not "19".
 */

/** A rate table: weight steps down the side, rate zones across the top. */
function rateTable(
  at: string,
  bind: string,
  product: string,
  rows: readonly { label: string }[],
  zoneKeys: readonly string[],
  boundaryField: 'toKg' | 'fromKg',
): Block {
  return {
    type: 'table',
    at,
    rowHeader: boundaryField === 'toKg' ? 'Up to' : 'Band',
    rowKeys: rows.map((_, index) => String(index)),
    // The product is in the row name so an approver reads "Package · 10 kg" rather than
    // a bare weight that could belong to any of the three.
    rowLabels: Object.fromEntries(
      rows.map((row, index) => [String(index), `${product} · ${row.label}`]),
    ),
    bind,
    columns: [
      // The boundary is data, not a heading: moving a step reprices everything inside it
      // without a single rate changing, so it needs a line of its own.
      { header: 'step boundary kg', field: boundaryField },
      ...zoneKeys.map((zone) => ({
        header: zone,
        field: `rates.${zone}`,
        format: 'currency' as const,
      })),
    ],
  };
}

export function upsSpecs(data: UpsCardData): SheetSpec[] {
  const zones = data.zoneKeys;
  const documentRows = data.rates.document.map((row) => ({ label: `${row.toKg} kg` }));
  const packageRows = data.rates.package.map((row) => ({ label: `${row.toKg} kg` }));
  const bulkRows = data.rates.bulk.map((row) => ({ label: row.label }));

  const params: SheetSpec = {
    id: 'ups-params',
    name: 'Params',
    source: 'ups',
    columns: 4,
    blocks: [
      { type: 'title', at: 'A1', text: `UPS / MOVIN — parameters, ex-${data.params.origin}` },
      {
        type: 'note',
        at: 'A2',
        text:
          'One number here moves every quote on the card. Rates are stored as decimals — a ' +
          'fuel surcharge of 46.75% is held as 0.4675.',
      },
      {
        type: 'params',
        at: 'A4',
        rows: [
          { label: 'Margin on basic freight', bind: 'ups.params.margin', format: 'percent' },
          { label: 'Fuel surcharge', bind: 'ups.params.fuelRate', format: 'percent' },
          { label: 'Surge discount', bind: 'ups.params.surgeDiscount', format: 'percent' },
          { label: 'GST', bind: 'ups.params.gstRate', format: 'percent' },
          { label: 'Volumetric divisor', bind: 'ups.params.volumetricDivisor' },
          { label: 'Minimum chargeable weight (kg)', bind: 'ups.params.minChargeableWeight' },
        ],
      },
    ],
  };

  const surge: SheetSpec = {
    id: 'ups-surge',
    name: 'Surge Fees',
    source: 'ups',
    columns: 4,
    blocks: [
      { type: 'title', at: 'A1', text: 'SURGE FEES — published rupees per kg, before the discount' },
      {
        type: 'note',
        at: 'A2',
        text:
          'A surge follows the world region a destination sits in, not its rate zone. The ' +
          'discount on Params applies to every figure here.',
      },
      {
        type: 'params',
        at: 'A4',
        rows: Object.keys(data.surge).map((region) => ({
          label: region,
          bind: `ups.surge.${region}`,
          format: 'currency' as const,
        })),
      },
    ],
  };

  const rates: SheetSpec = {
    id: 'ups-rates',
    name: 'Rates',
    source: 'ups',
    columns: zones.length + 2,
    blocks: [
      { type: 'title', at: 'A1', text: 'RATE CARD — by destination zone and weight' },
      {
        type: 'note',
        at: 'A2',
        text:
          'A step rate applies to anything at or below its weight. Past the last package step ' +
          'the per-kilogram bands take over.',
      },

      { type: 'title', at: 'A4', text: '1. ENVELOPE' },
      {
        type: 'table',
        at: 'A5',
        rowHeader: 'Product',
        rowKeys: ['envelope'],
        rowLabels: { envelope: 'UPS Envelope' },
        bind: 'ups.rates',
        columns: zones.map((zone) => ({ header: zone, field: zone, format: 'currency' as const })),
      },

      { type: 'title', at: `A8` , text: '2. DOCUMENT — by weight step' },
      rateTable('A9', 'ups.rates.document', 'Document', documentRows, zones, 'toKg'),

      {
        type: 'title',
        at: `A${9 + documentRows.length + 3}`,
        text: '3. PACKAGE — by weight step',
      },
      rateTable(
        `A${9 + documentRows.length + 4}`,
        'ups.rates.package',
        'Package',
        packageRows,
        zones,
        'toKg',
      ),

      {
        type: 'title',
        at: `A${9 + documentRows.length + 4 + packageRows.length + 3}`,
        text: '4. PER-KILOGRAM BANDS — beyond the last package step',
      },
      rateTable(
        `A${9 + documentRows.length + 4 + packageRows.length + 4}`,
        'ups.rates.bulk',
        'per kg',
        bulkRows,
        zones,
        'fromKg',
      ),
    ],
  };

  const accessorials: SheetSpec = {
    id: 'ups-accessorials',
    name: 'Accessorials',
    source: 'ups',
    columns: 6,
    blocks: [
      { type: 'title', at: 'A1', text: 'ACCESSORIAL CHARGES' },
      {
        type: 'note',
        at: 'A2',
        text:
          'Charged as the greater of the minimum and the per-kilogram rate. A waiver of 1 is ' +
          'fully waived, 0.5 half, 0 not waived at all.',
      },
      {
        type: 'table',
        at: 'A4',
        rowHeader: 'Charge',
        rowKeys: data.accessorials.map((_, index) => String(index)),
        rowLabels: Object.fromEntries(
          data.accessorials.map((charge, index) => [String(index), charge.name]),
        ),
        bind: 'ups.accessorials',
        columns: [
          { header: 'Basis', values: Object.fromEntries(
            data.accessorials.map((charge, index) => [String(index), charge.unit]),
          ) },
          { header: 'Minimum', field: 'minimum', format: 'currency' },
          { header: 'Per kg', field: 'perKg', format: 'currency' },
          { header: 'waiver', field: 'waiver' },
        ],
      },
    ],
  };

  /**
   * The `Zoning Guide` / `Destinations` tabs.
   *
   * Which rate zone and which surge region a country sits in. No rate changes when one of
   * these moves, and the price does — a destination reassigned from Z1 to Z3 is repriced
   * across every weight step at once — so both belong in the approval trail as much as any
   * figure on the Rates tab.
   */
  const destinations: SheetSpec = {
    id: 'ups-destinations',
    name: 'Destinations',
    source: 'ups',
    columns: 5,
    blocks: [
      { type: 'title', at: 'A1', text: 'DESTINATIONS — rate zone and surge region by country' },
      {
        type: 'note',
        at: 'A2',
        text:
          `A destination with no surge region of its own falls to ${data.defaultSurgeRegion}. ` +
          'Moving a country between zones reprices it everywhere at once, without a rate changing.',
      },
      // Explicit binds rather than a table: the data is `ups.zones.AE`, and a table block
      // addresses `bind.row.field`, which would look for `ups.AE.zones`.
      {
        type: 'params',
        at: 'A4',
        title: 'Rate zone',
        rows: Object.keys(data.zones)
          .sort()
          .map((code) => ({
            label: `${data.destinationNames[code] ?? code} (${code}) — rate zone`,
            bind: `ups.zones.${code}`,
          })),
      },
      {
        type: 'params',
        at: `A${6 + Object.keys(data.zones).length}`,
        title: 'Surge region',
        rows: Object.keys(data.surgeRegions)
          .sort()
          .map((code) => ({
            label: `${data.destinationNames[code] ?? code} (${code}) — surge region`,
            bind: `ups.surgeRegions.${code}`,
          })),
      },
    ],
  };

  return [params, surge, rates, accessorials, destinations];
}
