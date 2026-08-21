import { AIR_ZONES, SURFACE_ZONES } from '../../domain/zones';
import type { SheetSpec } from '../types';

/** Belt descriptions and spread category, as the source Pickup & Delivery sheet shows them. */
const BELTS: Record<string, string> = {
  PNQ: 'Pune City (PMC)',
  PCMC: 'Pimpri-Chinchwad',
  KSK: 'Kolhapur-Sangli-Satara',
  CSN: 'Aurangabad-Nashik',
  BOM: 'Mumbai-MMR',
  NAG: 'Nagpur-Vidarbha',
  AMD: 'Gujarat (Ahmedabad-Sanand)',
  IDR: 'MP (Indore-Pithampur)',
  NCR: 'Delhi-NCR',
  BWR: 'Bhiwadi-Jaipur',
  UTR: 'Uttarakhand-Baddi',
  LDH: 'Punjab-Chandigarh',
  UPX: 'Rest UP',
  BLR: 'Bengaluru',
  HSR: 'Hosur',
  MAA: 'Chennai',
  CJB: 'Coimbatore-Kerala',
  HYD: 'Hyderabad-AP',
  CCU: 'Kolkata-East',
  JSR: 'Jamshedpur-Ranchi-Bokaro',
  GAU: 'Guwahati-NE',
};

const CATEGORIES: Record<string, string> = {
  PNQ: 'Compact metro',
  PCMC: 'Compact metro',
  KSK: 'Regional',
  CSN: 'Spread / far',
  BOM: 'Compact metro',
  NAG: 'Regional',
  AMD: 'Compact metro',
  IDR: 'Regional',
  NCR: 'Compact metro',
  BWR: 'Spread / far',
  UTR: 'Spread / far',
  LDH: 'Regional',
  UPX: 'Spread / far',
  BLR: 'Compact metro',
  HSR: 'Regional',
  MAA: 'Compact metro',
  CJB: 'Regional',
  HYD: 'Compact metro',
  CCU: 'Regional',
  JSR: 'Spread / far',
  GAU: 'Spread / far',
};

export const pickupDeliverySpec: SheetSpec = {
  id: 'pickup-delivery',
  name: 'Pickup & Delivery',
  columns: 7,
  blocks: [
    {
      type: 'title',
      at: 'A1',
      text:
        'PICKUP & DELIVERY — per-zone cartage (Rs/shipment). Pickup uses the ORIGIN zone, ' +
        'delivery uses the DESTINATION zone. Both are zero within a single zone.',
    },
    {
      type: 'note',
      at: 'A2',
      text:
        'Asymmetric by design, taken from actual billed cartage. ODA/EDL is added on top for ' +
        'individual out-of-area pincodes — see the EDL Matrix.',
    },
    {
      type: 'table',
      at: 'A3',
      rowHeader: 'Zone',
      rowKeys: SURFACE_ZONES,
      bind: 'pickupDelivery',
      columns: [
        { header: 'Industrial belt', values: BELTS, readOnly: true },
        { header: 'Category', values: CATEGORIES, readOnly: true },
        { header: 'Pickup Surface', field: 'pickupSurface', format: 'currency' },
        { header: 'Delivery Surface', field: 'deliverySurface', format: 'currency' },
        { header: 'Pickup Air', field: 'pickupAir', format: 'currency' },
        { header: 'Delivery Air', field: 'deliveryAir', format: 'currency' },
      ],
    },
    {
      type: 'terms',
      at: 'A26',
      title: 'HANDLING FAR-OFF / SPREAD CLUSTERS',
      lines: [
        'Compact metros (Pune, Mumbai, NCR, Bengaluru) carry low cartage — the hub and the industrial areas sit close together.',
        'Spread or far clusters (Aurangabad-Nashik, Kolhapur-Sangli-Satara, Jamshedpur-Ranchi-Bokaro, Bhiwadi-Jaipur, Uttarakhand, rest-UP, the North East) span 150–300 km, so first and last mile cost more.',
        'On top of the zone rate, any individual pincode that is genuinely out-of-area also attracts the ODA/EDL surcharge by distance.',
        'A spread cluster can be split into sub-zones later; that is a zone change rather than a rate edit.',
      ],
    },
  ],
};

export const edlMatrixSpec: SheetSpec = {
  id: 'edl-matrix',
  name: 'EDL Matrix',
  columns: 14,
  blocks: [
    { type: 'title', at: 'A1', text: 'ODA / EDL SURCHARGE (Rs per shipment)' },
    {
      type: 'bandMatrix',
      at: 'A3',
      shortName: 'ODA surcharge',
      rowHeader: 'Min km',
      rowBandsBind: 'edlMatrix.kmBands',
      colBandsBind: 'edlMatrix.weightBands',
      ratesBind: 'edlMatrix.rates',
    },
    {
      type: 'params',
      at: 'A14',
      title: 'PER-KM TAIL — applied beyond the last distance band',
      rows: [
        {
          label: 'Charged beyond (km)',
          bind: 'edlMatrix.perKmThreshold',
          note: 'above this distance the banded rates stop applying',
          format: 'number',
        },
        {
          label: 'Rate per km (Rs)',
          bind: 'edlMatrix.perKmBeyondLastBand',
          note: 'distance × this rate, regardless of weight',
          format: 'currency',
        },
      ],
    },
    {
      type: 'notePanel',
      at: 'H3',
      title: 'WHAT IS ODA / EDL & HOW TO APPLY',
      lines: [
        'ODA = Out-of-Delivery-Area: a destination beyond the standard service town, which costs extra to reach.',
        '1. Take the pincode’s EDL km from the Pincode Master, for the mode being quoted.',
        '2. Read the row for that distance band and the column for the chargeable-weight band.',
        '3. That cell is the surcharge in Rs per shipment, added on top of freight.',
        'Applied to BOTH ends: the origin pincode drives a pickup ODA, the destination a delivery ODA.',
        'Beyond the per-km threshold the surcharge becomes distance × the per-km rate and ignores weight.',
        'A pincode inside its service town has zero EDL km and therefore no surcharge.',
      ],
    },
    {
      type: 'terms',
      at: 'A19',
      title: 'ODA CLASSIFICATION',
      lines: [
        'The source workbook also carried a second table restating these same surcharges as bands "ODA 1" to "ODA 10".',
        'It is not reproduced: it was a duplicate view of the matrix above and could drift out of step with it.',
        'A pincode’s ODA category is still recorded in the Pincode Master; the charge always comes from the matrix above.',
      ],
    },
  ],
};

export const chargesSpec: SheetSpec = {
  id: 'charges',
  name: 'Charges & Terms',
  columns: 11,
  blocks: [
    { type: 'title', at: 'A1', text: 'CHARGES & TERMS' },
    {
      type: 'params',
      at: 'A3',
      rows: [
        { label: 'Pickup Air', bind: 'charges.pickupAir', note: 'per shipment (+ODA on top)', format: 'currency' },
        { label: 'Delivery Air', bind: 'charges.deliveryAir', note: 'per shipment (+ODA)', format: 'currency' },
        { label: 'Pickup Surface', bind: 'charges.pickupSurface', note: 'per shipment (+ODA)', format: 'currency' },
        { label: 'Delivery Surface', bind: 'charges.deliverySurface', note: 'per shipment (+ODA)', format: 'currency' },
        { label: 'Docket / AWB', bind: 'charges.docket', note: 'superseded — the charge library sets what is billed', format: 'currency' },
        { label: 'GST Air', bind: 'charges.gstAir', note: 'superseded — see Tax & Charges', format: 'percent' },
        { label: 'GST Surface', bind: 'charges.gstSurface', note: 'superseded — see Tax & Charges', format: 'percent' },
        { label: 'Fuel Air', bind: 'charges.fuelAir', note: 'freight + cartage + ODA; also used for NFO', format: 'percent' },
        { label: 'Fuel Surface', bind: 'charges.fuelSurface', note: 'on freight + pickup + delivery + both ODA', format: 'percent' },
        { label: 'Fuel Rail', bind: 'charges.fuelRail', note: 'rail carries no fuel surcharge', format: 'percent' },
        { label: 'Fuel FTL', bind: 'charges.fuelFtl', note: 'on the trip price; often nil, as FTL is quoted all-in', format: 'percent' },
        { label: 'Min weight Air', bind: 'charges.minWeightAir', note: 'kg; also used for NFO', format: 'number' },
        { label: 'Min weight Surface', bind: 'charges.minWeightSurface', note: 'kg', format: 'number' },
        { label: 'Min weight Rail', bind: 'charges.minWeightRail', note: 'kg; blank follows surface', format: 'number' },
        { label: 'Volumetric divisor Air', bind: 'charges.volumetricDivisorAir', note: 'L×B×H cm ÷ this; also NFO', format: 'number' },
        { label: 'Volumetric divisor Surface', bind: 'charges.volumetricDivisorSurface', note: 'L×B×H cm ÷ this', format: 'number' },
        { label: 'Volumetric divisor Rail', bind: 'charges.volumetricDivisorRail', note: 'blank follows surface', format: 'number' },
        { label: 'Rail heavy-package threshold', bind: 'charges.railHeavyPackageThreshold', note: 'kg; a single package at or above this doubles', format: 'number' },
        { label: 'Rail heavy-package multiplier', bind: 'charges.railHeavyPackageMultiplier', note: '× actual weight', format: 'number' },
        { label: 'NFO multiplier', bind: 'charges.nfoMultiplier', note: '× the Air card, applied to all four grids', format: 'number' },
      ],
    },
    {
      type: 'notePanel',
      at: 'G3',
      title: 'HOW TO USE',
      lines: [
        'Every value here drives all three rate cards’ quotes. Change one and every quote for this card moves.',
        'These are the highest-blast-radius edits in the system, so expect close scrutiny on approval.',
        'The source workbook showed each of these twice — a display copy and an editable copy — which had drifted apart. There is now one value only.',
      ],
    },
    {
      type: 'terms',
      at: 'A23',
      title: 'TERMS',
      lines: [
        '1. Rates are ex-GST. GST is set per mode on the Tax & Charges tab — road freight is GTA at 5% and under reverse charge is not billed at all, while air is 18% forward on a different SAC. The two rates above are the workbook originals and no longer price anything.',
        '2. Freight comes from the rate matrices, combined by this card’s pricing method.',
        '3. Freight excludes fuel. The fuel surcharge is levied on freight plus pickup, delivery and both ODA legs — not on freight alone, and not on the docket charge.',
        '4. Chargeable weight is the greater of actual and volumetric weight, and never below the mode minimum.',
        '5. Rail: any single package of 100 kg or more is charged at twice its weight, which supersedes both the volumetric rule and the minimum. Rail carries no fuel surcharge and needs a lane over roughly 800 km.',
        '6. ODA/EDL applies at both ends of the lane for out-of-area pincodes. Transit times are indicative.',
        '7. Partload only, up to 1000 kg. FTL and heavier consignments are quoted separately.',
        '8. Pune jurisdiction.',
      ],
    },
  ],
};

export const clusterGuideSpec: SheetSpec = {
  id: 'cluster-guide',
  name: 'Cluster Guide',
  columns: 11,
  blocks: [
    {
      type: 'title',
      at: 'A1',
      text: `SURFACE & RAIL CLUSTERS (${SURFACE_ZONES.length}) — codes and the belts they cover`,
    },
    {
      type: 'table',
      at: 'A3',
      rowHeader: 'Code',
      rowKeys: SURFACE_ZONES,
      bind: 'zones.surface',
      columns: [{ header: 'Industrial belt', field: 'belt', format: 'text' }],
    },
    {
      type: 'title',
      at: 'D1',
      text: `AIR HUBS (${AIR_ZONES.length})`,
    },
    {
      type: 'table',
      at: 'D3',
      rowHeader: 'Code',
      rowKeys: AIR_ZONES,
      bind: 'zones.air',
      columns: [{ header: 'City', field: 'city', format: 'text' }],
    },
    {
      type: 'notePanel',
      at: 'G3',
      title: 'ABOUT ZONES',
      lines: [
        `Surface and rail are quoted over ${SURFACE_ZONES.length} industrial clusters; air over ${AIR_ZONES.length} airport hubs.`,
        'Every pincode is tagged to its zone, per mode, in the Pincode Master.',
        'Rates are quoted zone to zone in the rate tabs.',
        'Renaming a zone is a normal edit. Adding or removing one reshapes every matrix, so it is handled as an explicit migration rather than a cell edit.',
      ],
    },
  ],
};

export const coverSpec: SheetSpec = {
  id: 'cover',
  name: 'DNS Logistics',
  columns: 5,
  blocks: [
    { type: 'title', at: 'B8', text: 'DNS LOGISTICS — PAN-INDIA RATE CARD', level: 1 },
    {
      type: 'note',
      at: 'B9',
      text: `Air (${AIR_ZONES.length} hubs) · Surface & Rail (${SURFACE_ZONES.length} industrial clusters) · Door-to-Door`,
    },
    {
      type: 'terms',
      at: 'B11',
      title: 'HOW THIS RATE CARD WORKS',
      lines: [
        'Each lane carries a fixed/minimum charge plus three per-kg tiers that step down by weight, held as four separate matrices per mode.',
        'How those four numbers combine into freight depends on the card’s pricing method — the three cards differ precisely here.',
        'Freight is ex-fuel and ex-GST. Fuel, pickup, delivery, ODA, docket and GST are added on top, in that order.',
        'Open the Rate Calculator, enter origin and destination pincodes, mode and weight, and all three cards are priced side by side.',
      ],
    },
    {
      type: 'terms',
      at: 'B17',
      title: 'HOW TO USE THIS DASHBOARD',
      lines: [
        '1. Pick a rate card at the top. All three are live at once.',
        '2. Edit the yellow cells on any data tab. Your edits stay in a private draft.',
        '3. When the set of changes is complete, submit it for approval.',
        '4. An admin reviews every changed cell, then approves or rejects.',
        '5. Only approved values are used to price quotes.',
      ],
    },
    { type: 'note', at: 'B25', text: 'DNS Logistics · Pune, Maharashtra · www.dnslogistic.com' },
  ],
};
