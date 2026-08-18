import type { SheetSpec } from '../types';
import { BILLABLE_MODES, DEFAULT_CHARGES } from '../../domain/tax';
import { SURFACE_ZONES } from '../../domain/zones';

/**
 * The `Tax & Charges` tab.
 *
 * Not in the source workbooks: they hardcoded one GST rate, levied fuel on a fixed set
 * of components, and had a single docket field. Real contracts differ on all three —
 * road freight is 5% under reverse charge while air is 18% forward, one customer's fuel
 * surcharge rides on total charges rather than on freight, and the ancillary charges are
 * a menu rather than one line.
 *
 * It is a tab rather than a settings screen for a specific reason: every value in this
 * system is edited, diffed and approved as a cell. A GST rate that lived outside that
 * machinery could go live without anyone reviewing it.
 */

const MODE_LABELS: Record<string, string> = {
  surface: 'Road / GTA — surface',
  air: 'Domestic air cargo',
  rail: 'Rail parcel',
  nfo: 'NFO / JIT (air)',
  ftl: 'Full truck load',
  courier: 'Courier / express',
};

const BASIS_LABELS: Record<string, string> = {
  'per-shipment': 'per shipment',
  'per-awb': 'per AWB',
  'per-kg': 'per kg of chargeable weight',
  'by-pincode': 'from the pincode distance',
  'per-destination': 'per destination zone',
};

const CHARGE_IDS = DEFAULT_CHARGES.map((charge) => charge.id);

export const settlementSpec: SheetSpec = {
  id: 'tax-charges',
  name: 'Tax & Charges',
  columns: 12,
  blocks: [
    { type: 'title', at: 'A1', text: 'TAX & CHARGES — GST by mode, the fuel base, and the charge menu' },

    {
      type: 'table',
      at: 'A3',
      rowHeader: 'Mode',
      rowKeys: BILLABLE_MODES,
      bind: 'modeTax',
      columns: [
        { header: 'Transport', values: MODE_LABELS },
        { header: 'SAC', field: 'sac', format: 'text' },
        { header: 'GST', field: 'gstRate', format: 'percent' },
        { header: 'Reverse charge', field: 'rcm', format: 'text' },
        { header: 'ITC', field: 'itc', format: 'text' },
      ],
    },

    {
      type: 'notePanel',
      at: 'H3',
      title: 'GST FOLLOWS THE MODE',
      lines: [
        'GST is a property of the transport, not of the customer: a road leg is taxed as GTA whatever the customer would prefer.',
        'Reverse charge = Yes means the consignee accounts for the GST. The quote then shows zero GST and states the rate, because the invoice still has to.',
        'A customer outside GST altogether is handled on the contract, on top of whatever this tab says.',
        'Type Yes or No in the reverse-charge and ITC cells.',
      ],
    },

    { type: 'title', at: 'A11', text: 'FUEL SURCHARGE — what the percentage is charged on' },
    {
      type: 'params',
      at: 'A12',
      rows: [
        { label: 'Freight', bind: 'fuelBase.freight', note: 'Yes / No', format: 'text' },
        { label: 'Pickup', bind: 'fuelBase.pickup', note: 'Yes / No', format: 'text' },
        { label: 'Delivery', bind: 'fuelBase.delivery', note: 'Yes / No', format: 'text' },
        { label: 'ODA / EDL', bind: 'fuelBase.oda', note: 'Yes / No', format: 'text' },
        {
          label: 'Other charges',
          bind: 'fuelBase.charges',
          note: 'Yes turns this into “fuel on total”',
          format: 'text',
        },
      ],
    },

    {
      type: 'notePanel',
      at: 'H11',
      title: 'FUEL ON WHAT',
      lines: [
        'The percentage itself is on Charges & Terms. This is the base it is applied to.',
        'The workbooks charged fuel on freight plus both cartage legs and both ODA legs, but never on the docket.',
        'Setting every row to Yes gives “fuel on total charges”, which is how some contracts are written.',
        'A charge can also carry fuel on its own line below. It is never charged both ways — that would levy fuel twice on the same rupee.',
      ],
    },

    { type: 'title', at: 'A19', text: 'CHARGE MENU — one row per ancillary charge' },
    {
      type: 'table',
      at: 'A20',
      rowHeader: 'Charge',
      rowKeys: CHARGE_IDS,
      bind: 'chargeCatalog',
      columns: [
        { header: 'Name on invoice', field: 'name', format: 'text' },
        { header: 'Charged', field: 'basis', format: 'text', readOnly: true },
        { header: 'How', values: BASIS_LABELS },
        { header: 'Amount', field: 'amount', format: 'currency' },
        { header: 'In GST', field: 'gstApplies', format: 'text' },
        { header: 'Fuel on it', field: 'fuelApplies', format: 'text' },
        { header: 'Active', field: 'active', format: 'text' },
        { header: 'Modes', field: 'modes', format: 'text' },
      ],
    },

    { type: 'title', at: 'A28', text: 'ESS — express surcharge per destination zone' },
    {
      type: 'params',
      at: 'A29',
      // One cell per zone. Zero means no express surcharge to that destination; a charge
      // of zero never reaches a quote. Customers set theirs as a contract override.
      rows: SURFACE_ZONES.map((zone) => ({
        label: zone,
        bind: `chargeCatalog.ess.byDestination.${zone}`,
        format: 'currency' as const,
      })),
    },
    {
      type: 'notePanel',
      at: 'D29',
      title: 'ABOUT ESS',
      lines: [
        'An express surcharge that depends on where the shipment is going, not on the shipment.',
        'A Raymond has nine of them — Bangalore-Mysore ₹3,000, Hosur ₹2,000, and so on.',
        'Set them to zero on the base card and negotiate them per customer, the same way lane rates work.',
        'ESS only reaches a quote when the charge is Active in the menu above.',
      ],
    },
    {
      type: 'terms',
      at: 'A52',
      title: 'HOW A CHARGE IS SETTLED',
      lines: [
        '1. Active = No leaves the charge off every quote. It stays on the tab so it can be switched back on without being rebuilt.',
        '2. Amount is read according to the basis: a flat figure per shipment or AWB, a rate per kg, or — for ODA — the figure the pincode distance produces.',
        '3. ESS is charged per destination zone; its amounts are held per zone rather than as one number here.',
        '4. In GST = Yes puts the charge inside the taxable value. No adds it after tax, which is right for a deposit or a reimbursement.',
        '5. Fuel on it = Yes levies the fuel percentage on that charge alone. Use the fuel base above for “fuel on total” instead — the engine will not charge both.',
        '6. Modes limits a charge to certain transport, e.g. an AWB charge on air only. Leave it blank for every mode.',
      ],
    },
  ],
};
