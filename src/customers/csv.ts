import type { Overrides, ContractScope, WeightBand, CommercialTerms } from '../domain/customers';
import { laneKey } from '../domain/customers';
import { AIR_ZONES, SURFACE_ZONES } from '../domain/zones';
import { MODES, type Mode, type StoredMode } from '../domain/types';
import { GRID_NAMES } from '../domain/types';
import { bindPathFor } from '../console/lanes';
import { BILLABLE_MODES } from '../domain/tax';
import { zonesInGroup, ZONE_GROUPS_BY_KEY } from '../domain/zone-groups';

/**
 * One CSV that configures a whole customer.
 *
 * The business point: a proposal should be standardised from the moment it
 * originates, not assembled cell by cell afterwards. So the file is a flat list of
 * instructions rather than a matrix — that way rates, surcharges, coverage and
 * commercial terms all live in one document, and a sales person can fill it in
 * without understanding the internal data model.
 *
 * Format — one instruction per row:
 *
 *   TYPE,      A,        B,        C,          D
 *   rate,      surface,  PNQ,      NCR,        minCharge, 450
 *   rate,      surface,  metros,   metros,     tier2,     12
 *   charge,    fuelSurface,        0.20
 *   coverage,  modes,    surface|air
 *   coverage,  lanes,    surface:PNQ>NCR|surface:PNQ>BLR
 *   coverage,  weight,   0-100|300-
 *   terms,     billingType,        RCM
 *
 * `rate` accepts a zone code or a **group name** in the origin and destination
 * columns, so "metros to metros, tier2, 12" is one row rather than fifty-six.
 */

export interface CsvIssue {
  line: number;
  message: string;
  /** The raw row, so a person can find it in their spreadsheet. */
  raw: string;
}

export interface ParsedCsv {
  overrides: Overrides;
  scope: ContractScope;
  commercial: Partial<CommercialTerms>;
  issues: CsvIssue[];
  /** How many lanes each `rate` row expanded to, for the preview. */
  expansions: { line: number; description: string; lanes: number }[];
}

const RATE_NAMES = new Set<string>(GRID_NAMES);

/** Charge fields a CSV may set. Deliberately a whitelist. */
const CHARGE_FIELDS = new Set([
  'fuelAir',
  'fuelSurface',
  'fuelRail',
  'gstAir',
  'gstSurface',
  'docket',
  'pickupAir',
  'deliveryAir',
  'pickupSurface',
  'deliverySurface',
  'minWeightAir',
  'minWeightSurface',
  'volumetricDivisorAir',
  'volumetricDivisorSurface',
]);

/** Fuel-base components a CSV may switch. */
const FUEL_BASE_COMPONENTS = new Set(['freight', 'pickup', 'delivery', 'oda', 'charges']);

/** Per-mode tax fields. `rcm` and `itc` take Yes/No; the rest a value. */
const TAX_FIELDS = new Set(['sac', 'gstRate', 'rcm', 'itc']);

/** Charge-menu fields. The three flags take Yes/No. */
const MENU_FIELDS = new Set(['name', 'amount', 'gstApplies', 'fuelApplies', 'active']);

const YES_NO = (raw: string): 'Yes' | 'No' | null => {
  const word = raw.trim().toLowerCase();
  if (word === 'yes' || word === 'y' || word === 'true') return 'Yes';
  if (word === 'no' || word === 'n' || word === 'false') return 'No';
  return null;
};

function splitRow(line: string): string[] {
  // No quoted-field handling: every field in this format is a code or a number, and
  // silently accepting quotes would invite commas inside values that we then mis-split.
  return line.split(',').map((cell) => cell.trim());
}

/** A zone code, or a group name that expands to many. */
function resolveZones(token: string, mode: StoredMode): string[] | null {
  const upper = token.toUpperCase();
  const available: readonly string[] = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
  if (available.includes(upper)) return [upper];

  const groupKey = token.toLowerCase().replace(/\s+/g, '-');
  if (ZONE_GROUPS_BY_KEY.has(groupKey)) {
    const zones = zonesInGroup(groupKey, mode);
    return zones.length > 0 ? zones : null;
  }
  return null;
}

function parseWeightBand(token: string): WeightBand | null {
  const [fromRaw, toRaw] = token.split('-');
  const from = Number(fromRaw);
  if (!Number.isFinite(from)) return null;
  if (toRaw === undefined || toRaw.trim() === '') return { from, to: null };
  const to = Number(toRaw);
  if (!Number.isFinite(to)) return null;
  return { from, to };
}

/**
 * Parse the file. Never throws: every problem becomes an issue with a line number,
 * so the whole file can be reported at once rather than failing on the first fault.
 */
export function parseCustomerCsv(text: string): ParsedCsv {
  const overrides: Overrides = {};
  const issues: CsvIssue[] = [];
  const expansions: ParsedCsv['expansions'] = [];
  const commercial: Partial<CommercialTerms> = {};
  let modes: Mode[] | null = null;
  let lanes: string[] | null = null;
  let weightBands: WeightBand[] | null = null;

  const lines = text.split(/\r?\n/);

  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    const cells = splitRow(trimmed);
    const kind = (cells[0] ?? '').toLowerCase();

    // A header row is a convenience for whoever fills the file in.
    if (kind === 'type') return;

    switch (kind) {
      case 'rate': {
        const [, modeRaw, originRaw, destRaw, rateRaw, valueRaw] = cells;
        const mode = (modeRaw ?? '').toLowerCase();
        if (mode !== 'surface' && mode !== 'air' && mode !== 'rail') {
          issues.push({ line, raw, message: `"${modeRaw}" is not surface, air or rail.` });
          return;
        }
        if (!RATE_NAMES.has(rateRaw ?? '')) {
          issues.push({
            line,
            raw,
            message: `"${rateRaw}" is not a rate name. Use ${[...RATE_NAMES].join(', ')}.`,
          });
          return;
        }

        const origins = resolveZones(originRaw ?? '', mode);
        const destinations = resolveZones(destRaw ?? '', mode);
        if (!origins) {
          issues.push({ line, raw, message: `"${originRaw}" is not a zone or a group for ${mode}.` });
          return;
        }
        if (!destinations) {
          issues.push({ line, raw, message: `"${destRaw}" is not a zone or a group for ${mode}.` });
          return;
        }

        // An empty value clears the lane, which is how a CSV marks it not carried.
        const isBlank = (valueRaw ?? '').trim() === '';
        const value = isBlank ? null : Number(valueRaw);
        if (!isBlank && !Number.isFinite(value)) {
          issues.push({ line, raw, message: `"${valueRaw}" is not a number.` });
          return;
        }

        let count = 0;
        for (const origin of origins) {
          for (const destination of destinations) {
            if (origin === destination) continue;
            overrides[bindPathFor(mode, rateRaw as never, origin, destination)] = value;
            count++;
          }
        }
        expansions.push({
          line,
          description: `${mode} ${originRaw}→${destRaw} ${rateRaw} = ${isBlank ? 'not carried' : value}`,
          lanes: count,
        });
        return;
      }

      case 'charge': {
        const [, field, valueRaw] = cells;
        if (!CHARGE_FIELDS.has(field ?? '')) {
          issues.push({
            line,
            raw,
            message: `"${field}" is not a charge that can be set here. Allowed: ${[...CHARGE_FIELDS].join(', ')}.`,
          });
          return;
        }
        const value = Number(valueRaw);
        if (!Number.isFinite(value)) {
          issues.push({ line, raw, message: `"${valueRaw}" is not a number.` });
          return;
        }
        overrides[`charges.${field}`] = value;
        return;
      }

      // What the fuel percentage rides on. All five Yes is "fuel on total charges".
      case 'fuel-base': {
        const [, component, valueRaw] = cells;
        if (!FUEL_BASE_COMPONENTS.has(component ?? '')) {
          issues.push({
            line,
            raw,
            message: `"${component}" is not a fuel-base component. Allowed: ${[...FUEL_BASE_COMPONENTS].join(', ')}.`,
          });
          return;
        }
        const flag = YES_NO(valueRaw ?? '');
        if (flag === null) {
          issues.push({ line, raw, message: `"${valueRaw}" is not Yes or No.` });
          return;
        }
        overrides[`fuelBase.${component}`] = flag;
        return;
      }

      // GST follows the transport mode, so it is set per mode rather than once.
      case 'tax': {
        const [, modeRaw, field, valueRaw] = cells;
        const mode = (modeRaw ?? '').toLowerCase();
        if (!(BILLABLE_MODES as readonly string[]).includes(mode)) {
          issues.push({
            line,
            raw,
            message: `"${modeRaw}" is not a mode. Allowed: ${BILLABLE_MODES.join(', ')}.`,
          });
          return;
        }
        if (!TAX_FIELDS.has(field ?? '')) {
          issues.push({
            line,
            raw,
            message: `"${field}" is not a tax field. Allowed: ${[...TAX_FIELDS].join(', ')}.`,
          });
          return;
        }
        if (field === 'rcm' || field === 'itc') {
          const flag = YES_NO(valueRaw ?? '');
          if (flag === null) {
            issues.push({ line, raw, message: `"${valueRaw}" is not Yes or No.` });
            return;
          }
          overrides[`modeTax.${mode}.${field}`] = flag;
          return;
        }
        if (field === 'sac') {
          overrides[`modeTax.${mode}.sac`] = (valueRaw ?? '').trim();
          return;
        }
        const rate = Number(valueRaw);
        if (!Number.isFinite(rate)) {
          issues.push({ line, raw, message: `"${valueRaw}" is not a number.` });
          return;
        }
        overrides[`modeTax.${mode}.gstRate`] = rate;
        return;
      }

      // The ancillary charge menu: switch one on, price it, or move it outside GST.
      case 'menu': {
        const [, chargeId, field, valueRaw] = cells;
        if (!chargeId) {
          issues.push({ line, raw, message: 'Name the charge, e.g. menu,ess,active,Yes.' });
          return;
        }
        if (!MENU_FIELDS.has(field ?? '')) {
          issues.push({
            line,
            raw,
            message: `"${field}" is not a charge field. Allowed: ${[...MENU_FIELDS].join(', ')}.`,
          });
          return;
        }
        if (field === 'gstApplies' || field === 'fuelApplies' || field === 'active') {
          const flag = YES_NO(valueRaw ?? '');
          if (flag === null) {
            issues.push({ line, raw, message: `"${valueRaw}" is not Yes or No.` });
            return;
          }
          overrides[`chargeCatalog.${chargeId}.${field}`] = flag;
          return;
        }
        if (field === 'name') {
          overrides[`chargeCatalog.${chargeId}.name`] = (valueRaw ?? '').trim();
          return;
        }
        const amount = Number(valueRaw);
        if (!Number.isFinite(amount)) {
          issues.push({ line, raw, message: `"${valueRaw}" is not a number.` });
          return;
        }
        overrides[`chargeCatalog.${chargeId}.amount`] = amount;
        return;
      }

      // Express surcharge, per destination zone.
      case 'ess': {
        const [, zoneRaw, valueRaw] = cells;
        const zone = (zoneRaw ?? '').toUpperCase();
        if (!(SURFACE_ZONES as readonly string[]).includes(zone)) {
          issues.push({ line, raw, message: `"${zoneRaw}" is not a zone code.` });
          return;
        }
        const amount = Number(valueRaw);
        if (!Number.isFinite(amount)) {
          issues.push({ line, raw, message: `"${valueRaw}" is not a number.` });
          return;
        }
        overrides[`chargeCatalog.ess.byDestination.${zone}`] = amount;
        return;
      }

      case 'coverage': {
        const [, what, valueRaw] = cells;
        const parts = (valueRaw ?? '').split('|').map((p) => p.trim()).filter(Boolean);

        if ((what ?? '').toLowerCase() === 'modes') {
          const invalid = parts.filter((p) => !MODES.includes(p.toLowerCase() as Mode));
          if (invalid.length > 0) {
            issues.push({ line, raw, message: `Not modes: ${invalid.join(', ')}.` });
            return;
          }
          modes = parts.map((p) => p.toLowerCase() as Mode);
          return;
        }

        if ((what ?? '').toLowerCase() === 'lanes') {
          lanes = [];
          for (const part of parts) {
            // Accept either `surface:PNQ>NCR` or `surface,PNQ,NCR` collapsed form.
            const match = /^([a-z]+):([A-Za-z]+)>([A-Za-z]+)$/.exec(part);
            if (!match) {
              issues.push({ line, raw, message: `"${part}" is not a lane like surface:PNQ>NCR.` });
              continue;
            }
            const [, m, o, d] = match as unknown as [string, string, string, string];
            lanes.push(laneKey(m.toLowerCase() as StoredMode, o.toUpperCase(), d.toUpperCase()));
          }
          return;
        }

        if ((what ?? '').toLowerCase() === 'weight') {
          weightBands = [];
          for (const part of parts) {
            const band = parseWeightBand(part);
            if (!band) {
              issues.push({ line, raw, message: `"${part}" is not a band like 0-100 or 300-.` });
              continue;
            }
            weightBands.push(band);
          }
          return;
        }

        issues.push({ line, raw, message: `"${what}" is not modes, lanes or weight.` });
        return;
      }

      case 'terms': {
        const [, field, valueRaw] = cells;
        const value = (valueRaw ?? '').trim();
        switch ((field ?? '').trim()) {
          case 'billingType':
            if (value !== 'FORWARD' && value !== 'RCM') {
              issues.push({ line, raw, message: 'billingType must be FORWARD or RCM.' });
              return;
            }
            commercial.billingType = value;
            return;
          case 'gstApplicable':
            commercial.gstApplicable = /^(yes|true|y|1)$/i.test(value);
            return;
          case 'paymentTermsDays': {
            const days = Number(value);
            if (!Number.isInteger(days) || days < 0) {
              issues.push({ line, raw, message: 'paymentTermsDays must be a whole number.' });
              return;
            }
            commercial.paymentTermsDays = days;
            return;
          }
          case 'creditLimit': {
            if (value === '') {
              commercial.creditLimit = null;
              return;
            }
            const limit = Number(value);
            if (!Number.isFinite(limit)) {
              issues.push({ line, raw, message: 'creditLimit must be a number, or blank.' });
              return;
            }
            commercial.creditLimit = limit;
            return;
          }
          default:
            issues.push({ line, raw, message: `"${field}" is not a term that can be set here.` });
            return;
        }
      }

      default:
        issues.push({
          line,
          raw,
          message: `"${cells[0]}" is not a row type. Use rate, charge, coverage or terms.`,
        });
    }
  });

  return { overrides, scope: { modes, lanes, weightBands }, commercial, issues, expansions };
}

/** A worked example, offered as a download so nobody has to guess the format. */
export const CSV_TEMPLATE = `# One customer's whole configuration. One instruction per row.
# Lines starting with # are ignored. Blank lines are ignored.
#
# rate,<mode>,<origin>,<destination>,<rate name>,<value>
#   mode        surface | air | rail
#   origin      a zone code (PNQ) or a group (metros, pan-india, north, south, west, east)
#   rate name   minCharge | tier1 | tier2 | tier3
#   value       a number, or blank to mark the lane not carried
#
type,a,b,c,d,e
rate,surface,PNQ,NCR,minCharge,450
rate,surface,PNQ,NCR,tier2,12
rate,surface,metros,metros,tier3,10
rate,air,PNQ,BLR,minCharge,1800

# charge,<field>,<value>   fuel and GST are fractions: 0.20 means 20%
#                         also volumetricDivisorAir / volumetricDivisorSurface
#
# fuel-base,<component>,<Yes|No>
#   component   freight | pickup | delivery | oda | charges
#   All five Yes is "fuel on total charges".
#
# tax,<mode>,<field>,<value>
#   mode        surface | air | rail | nfo | ftl | courier
#   field       sac | gstRate | rcm | itc     rcm and itc take Yes/No
#
# menu,<charge>,<field>,<value>
#   charge      docket | awb | handling | green-tax | oda | ess
#   field       name | amount | gstApplies | fuelApplies | active
#
# ess,<zone>,<amount>      express surcharge for that destination
charge,fuelSurface,0.20
charge,docket,80

# coverage,modes,<mode>|<mode>
coverage,modes,surface|air
# coverage,lanes,<mode>:<origin>><destination>|...   omit the row to cover all lanes
coverage,lanes,surface:PNQ>NCR|surface:PNQ>BLR|air:PNQ>BLR
# coverage,weight,<from>-<to>|<from>-    a trailing dash means no upper limit
coverage,weight,0-100|300-

# terms,<field>,<value>
terms,billingType,FORWARD
terms,gstApplicable,yes
terms,paymentTermsDays,30
terms,creditLimit,500000
`;
