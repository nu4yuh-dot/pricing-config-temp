import type { CardSource } from '../../domain/types';
import type { SheetSpec } from '../types';
import { airRatesSpec, surfaceRatesSpec, railRatesSpec } from './rates';
import { tatAirSpec, tatSurfaceSpec, etaRailSpec } from './transit';
import {
  pickupDeliverySpec,
  edlMatrixSpec,
  chargesSpec,
  clusterGuideSpec,
  coverSpec,
} from './reference';
import { settlementSpec } from './settlement';
import { ftlSpec } from './ftl';
import { bluedartSpec } from './bluedart';

/**
 * The four tabs the engine computes rather than stores. They carry no editable
 * cells; the page renders each from a live quote instead.
 */
const rateCalculatorSpec: SheetSpec = {
  id: 'rate-calculator',
  name: 'Rate Calculator',
  columns: 10,
  derived: true,
  blocks: [
    {
      type: 'derived',
      at: 'A1',
      title: 'RATE CALCULATOR — from and to pincode',
      view: 'rateCalculator',
      note:
        'Enter mode, both pincodes and weight. Zones, ODA distance, chargeable weight, ' +
        'freight, cartage, fuel, GST and the landed total are computed — and all three ' +
        'rate cards are priced side by side.',
    },
  ],
};

const exOriginSpec: SheetSpec = {
  id: 'ex-origin',
  name: 'Ex-Origin Rate Card',
  columns: 7,
  derived: true,
  blocks: [
    {
      type: 'derived',
      at: 'A1',
      title: 'EX-ORIGIN RATE CARD — base freight to every destination',
      view: 'exOriginRateCard',
      note: 'Base freight only, ex-fuel and ex-GST. Pick a mode and an origin zone.',
    },
  ],
};

const allInQuoteSpec: SheetSpec = {
  id: 'all-in-quote',
  name: 'All-In Quote',
  columns: 17,
  derived: true,
  blocks: [
    {
      type: 'derived',
      at: 'A1',
      title: 'ALL-IN QUOTE — full landed price to every destination',
      view: 'allInQuote',
      note:
        'Pick mode, origin and weight. In the source workbook this tab always used ' +
        'Model 1’s formula regardless of which file it sat in; here it uses the card ' +
        'you have selected.',
    },
  ],
};

const nfoRatesSpec: SheetSpec = {
  id: 'nfo-rates',
  name: 'NFO Rates',
  columns: 13,
  derived: true,
  blocks: [
    {
      type: 'derived',
      at: 'A1',
      title: 'AIR NFO / JIT — Next-Flight-Out, 10–14 hours',
      view: 'nfoRates',
      note:
        'Every Air Rates cell multiplied by the NFO multiplier. Computed, not stored, ' +
        'so it can never drift away from the air card.',
    },
  ],
};

const pincodeMasterSpec: SheetSpec = {
  id: 'pincode-master',
  name: 'Pincode Master',
  columns: 21,
  blocks: [
    {
      type: 'derived',
      at: 'A1',
      title: 'PINCODE MASTER — 19,494 pincodes, zone and ODA per mode',
      view: 'rateCalculator',
      note:
        'Searchable rather than scrollable: filter by pincode, state, zone or ODA status. ' +
        'Bulk changes go through CSV import with a diff preview before approval.',
    },
  ],
};

/**
 * Every tab, in the order the source workbooks present them, plus two additions the workbooks
 * had nowhere to hold: `Tax & Charges` (GST per mode, the fuel base, the charge menu) and
 * `FTL Rates` (a price per vehicle per lane). Both sit next to `Charges & Terms`, whose values
 * they extend.
 */
export const SHEET_SPECS: SheetSpec[] = [
  coverSpec,
  rateCalculatorSpec,
  exOriginSpec,
  allInQuoteSpec,
  airRatesSpec,
  surfaceRatesSpec,
  railRatesSpec,
  pickupDeliverySpec,
  tatAirSpec,
  tatSurfaceSpec,
  etaRailSpec,
  clusterGuideSpec,
  edlMatrixSpec,
  chargesSpec,
  settlementSpec,
  ftlSpec,
  bluedartSpec,
  nfoRatesSpec,
  pincodeMasterSpec,
];

export const SHEET_SPECS_BY_ID = new Map(SHEET_SPECS.map((spec) => [spec.id, spec]));

/** Tabs with editable data, i.e. everything the approval workflow covers. */
export const EDITABLE_SHEET_SPECS = SHEET_SPECS.filter(
  (spec) => !spec.derived && spec.id !== 'pincode-master' && spec.id !== 'cover',
);

/** The tabs a card of this source actually has. */
/**
 * The tabs a card of this source has.
 *
 * A source with no spreadsheet representation gets an empty list rather than an error —
 * the UPS card is edited on its own console page and has no A1 grid to render.
 */
export function sheetSpecsForSource(source: CardSource): SheetSpec[] {
  return SHEET_SPECS.filter((spec) => (spec.source ?? 'dns') === source);
}

export function editableSpecsForSource(source: CardSource): SheetSpec[] {
  return EDITABLE_SHEET_SPECS.filter((spec) => (spec.source ?? 'dns') === source);
}

export {
  airRatesSpec,
  surfaceRatesSpec,
  railRatesSpec,
  tatAirSpec,
  tatSurfaceSpec,
  etaRailSpec,
  pickupDeliverySpec,
  edlMatrixSpec,
  chargesSpec,
  settlementSpec,
  ftlSpec,
  bluedartSpec,
  clusterGuideSpec,
  coverSpec,
};
