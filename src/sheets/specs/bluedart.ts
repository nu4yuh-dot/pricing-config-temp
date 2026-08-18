import type { SheetSpec } from '../types';
import { BLUEDART_ZONES, ZONE_DISTANCE_TIER, ZONE_STATES } from '../../domain/bluedart';

/**
 * The `Bluedart Rates` tab.
 *
 * The franchise card as its own workbook renders it: five directional zones down the side,
 * one block per service. There are no origin × destination matrices here — everything ships
 * ex-Pune, so the price depends only on where it is going.
 *
 * Every cell binds into `bluedart.*`, so a rate change here goes through exactly the same
 * draft, diff and approval as a DNS lane rate.
 */

const ZONES = BLUEDART_ZONES;

export const bluedartSpec: SheetSpec = {
  id: 'bluedart-rates',
  name: 'Bluedart Rates',
  source: 'bluedart',
  columns: 12,
  blocks: [
    {
      type: 'title',
      at: 'A1',
      text: 'BLUEDART FRANCHISE RATE CARD — directional zones, ex-Pune',
    },
    {
      type: 'note',
      at: 'A2',
      text:
        'All rates ex-GST. Zones by distance from Pune: WEST (nearest) < NORTH = SOUTH < EAST < ' +
        'NE & REMOTE. Documents and non-documents are billed per 500 g; APEX and SURFACE by ' +
        'incremental weight slabs.',
    },

    { type: 'title', at: 'A4', text: '1. DOCUMENTS (DOX) & NON-DOCUMENTS (DUTS) — Rs per 500 g' },
    {
      type: 'table',
      at: 'A5',
      rowHeader: 'Zone',
      rowKeys: ZONES,
      bind: 'bluedart.zones',
      columns: [
        { header: 'Distance tier', values: ZONE_DISTANCE_TIER },
        { header: 'DOCs / 500 g', field: 'docs', format: 'currency' },
        { header: 'DUTS / 500 g', field: 'duts', format: 'currency' },
      ],
    },

    { type: 'title', at: 'A12', text: '2. APEX (air, premium) — fixed first 5 kg, then per-kg slabs' },
    {
      type: 'table',
      at: 'A13',
      rowHeader: 'Zone',
      rowKeys: ZONES,
      bind: 'bluedart.zones',
      columns: [
        { header: 'First 5 kg', field: 'apex.firstBlock', format: 'currency' },
        { header: '5–25 /kg', field: 'apex.to25', format: 'currency' },
        { header: '25–50 /kg', field: 'apex.to50', format: 'currency' },
        { header: '50–100 /kg', field: 'apex.to100', format: 'currency' },
        { header: '100+ /kg', field: 'apex.above100', format: 'currency' },
      ],
    },

    { type: 'title', at: 'A20', text: '3. SURFACE (economy) — fixed first 10 kg, then per-kg slabs' },
    {
      type: 'table',
      at: 'A21',
      rowHeader: 'Zone',
      rowKeys: ZONES,
      bind: 'bluedart.zones',
      columns: [
        { header: 'First 10 kg', field: 'surface.firstBlock', format: 'currency' },
        { header: '10–25 /kg', field: 'surface.to25', format: 'currency' },
        { header: '25–50 /kg', field: 'surface.to50', format: 'currency' },
        { header: '50–100 /kg', field: 'surface.to100', format: 'currency' },
        { header: '100+ /kg', field: 'surface.above100', format: 'currency' },
      ],
    },

    { type: 'title', at: 'A28', text: '4. CHARGES & RULES' },
    {
      type: 'params',
      at: 'A29',
      rows: [
        { label: 'Fuel — air', bind: 'bluedart.charges.fuelAir', note: 'on freight + ODA; revised monthly', format: 'percent' },
        { label: 'Fuel — surface', bind: 'bluedart.charges.fuelSurface', note: 'on freight + ODA; revised monthly', format: 'percent' },
        { label: 'AWB / docket', bind: 'bluedart.charges.awb', note: 'per consignment; APEX & SURFACE only', format: 'currency' },
        { label: 'FOV / risk', bind: 'bluedart.charges.fovRate', note: 'of declared value', format: 'percent' },
        { label: 'FOV minimum', bind: 'bluedart.charges.fovMinimum', note: 'charged even at nil declared value', format: 'currency' },
        { label: 'GST', bind: 'bluedart.charges.gstRate', note: 'on the pre-GST sub-total', format: 'percent' },
        { label: 'SAC', bind: 'bluedart.charges.sac', note: 'courier & express', format: 'text' },
        { label: 'Volumetric divisor — air', bind: 'bluedart.charges.volumetricDivisorAir', note: 'L×B×H cm ÷ this; also DUTS', format: 'number' },
        { label: 'Volumetric divisor — surface', bind: 'bluedart.charges.volumetricDivisorSurface', note: 'L×B×H cm ÷ this, then ×', format: 'number' },
        { label: 'Volumetric multiplier — surface', bind: 'bluedart.charges.volumetricMultiplierSurface', note: '× the divided volume', format: 'number' },
      ],
    },

    {
      type: 'notePanel',
      at: 'F29',
      title: 'HOW FREIGHT IS BUILT',
      lines: [
        'The first block covers everything up to the minimum weight: 5 kg on APEX, 10 kg on SURFACE.',
        'Above it each slab has its own per-kg rate applied only to the kilograms inside that slab, and the slabs are added.',
        'So a heavier shipment always costs more — unlike the DNS cards, where one more kilogram can cross a boundary and cost less.',
        'Worked example — 30 kg SURFACE to WEST: 160 + 15 × 13.00 + 5 × 12.50 = Rs 417.50 freight, then fuel, AWB, FOV, ODA and GST.',
      ],
    },

    { type: 'title', at: 'A41', text: '5. ODA / EDL SURCHARGE — Rs per consignment, ex-GST' },
    {
      type: 'note',
      at: 'A42',
      text:
        'Row = EDL distance in km from the nearest service centre; column = chargeable weight. ' +
        'APEX and SURFACE only — documents never carry ODA.',
    },
    {
      type: 'bandMatrix',
      at: 'A43',
      rowBandsBind: 'bluedart.oda.kmBands',
      colBandsBind: 'bluedart.oda.weightBands',
      ratesBind: 'bluedart.oda.rates',
      rowHeader: 'Min km (≥)',
      colHeaderSuffix: ' kg+',
      shortName: 'Bluedart ODA',
    },
    {
      type: 'params',
      at: 'A53',
      rows: [
        { label: 'Beyond the last band', bind: 'bluedart.oda.perKmBeyond', note: 'Rs per km', format: 'currency' },
        { label: 'Distance it applies past', bind: 'bluedart.oda.perKmThreshold', note: 'km', format: 'number' },
      ],
    },

    {
      type: 'table',
      at: 'A57',
      title: '6. WHAT EACH ZONE COVERS',
      rowHeader: 'Zone',
      rowKeys: ZONES,
      columns: [
        { header: 'Distance tier', values: ZONE_DISTANCE_TIER },
        { header: 'States / UTs', values: ZONE_STATES },
      ],
    },

    {
      type: 'terms',
      at: 'A65',
      title: 'TERMS',
      lines: [
        '1. Minimum chargeable weight: DOCs 0.5 kg | DUTS 1 kg | APEX 5 kg | SURFACE 10 kg.',
        '2. Minimum charge: DOCs Rs 50 | DUTS Rs 200. Both are billed per 500 g, rounded up.',
        '3. DOCs and DUTS carry fuel only — no AWB, no FOV and no ODA, whatever the destination.',
        '4. Fuel is levied on freight plus ODA for APEX and SURFACE, and on freight alone for the document services. Documents and DUTS take the air percentage.',
        '5. FOV is a percentage of declared value against a floor, so it is charged even when nothing is declared.',
        '6. Volumetric weight applies: air and DUTS at L×B×H/5000, surface at (L×B×H/27000)×8. The greater of actual and volumetric is billed.',
        '7. The rate card moves DOCs and DUTS above 5 kg to APEX or SURFACE. A quote past that weight is flagged rather than blocked.',
        '8. Pincodes marked "Not in APEX" cannot be flown; SURFACE is offered instead.',
        '9. NE, J&K, Ladakh and the islands: high-value heavy consignments over Rs 1 lakh are quoted on request.',
      ],
    },
  ],
};
