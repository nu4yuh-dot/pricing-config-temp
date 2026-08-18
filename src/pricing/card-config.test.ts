import { describe, expect, test } from 'vitest';
import {
  chargesFrom,
  fuelBaseFrom,
  isOn,
  settlementDefaults,
  settlementFill,
  taxOverridesFrom,
} from './card-config';
import type { RateCardData } from '../domain/types';

/**
 * The stored representation of the settlement configuration.
 *
 * It has to satisfy two callers at once. The spreadsheet stores flags as the words a
 * person types into a cell — "Yes" and "No" — so that they edit, diff and approve like
 * any other cell. Code and the booking API pass real booleans. Both must resolve to the
 * same settlement, so the reader accepts either.
 */

const bareCharges = {
  docket: 100,
  fuelSurface: 0.25,
  gstSurface: 0.05,
} as unknown as RateCardData['charges'];

const bare = { charges: bareCharges } as unknown as RateCardData;

describe('isOn', () => {
  test('reads the words a person types into a spreadsheet cell', () => {
    expect(isOn('Yes')).toBe(true);
    expect(isOn('yes')).toBe(true);
    expect(isOn('Y')).toBe(true);
    expect(isOn('No')).toBe(false);
    expect(isOn('n')).toBe(false);
  });

  test('reads booleans, which is what the API and tests pass', () => {
    expect(isOn(true)).toBe(true);
    expect(isOn(false)).toBe(false);
  });

  test('treats an unset flag as off, never as on', () => {
    expect(isOn(undefined)).toBe(false);
    expect(isOn(null)).toBe(false);
    expect(isOn('')).toBe(false);
  });

  /** A typo must not silently switch a surcharge on. */
  test('treats anything it does not understand as off', () => {
    expect(isOn('maybe')).toBe(false);
    expect(isOn('YEP')).toBe(false);
  });
});

describe('fuelBaseFrom', () => {
  test('a card that says nothing keeps the workbook base', () => {
    expect(fuelBaseFrom(bare)).toEqual({
      freight: true,
      pickup: true,
      delivery: true,
      oda: true,
      charges: false,
    });
  });

  test('a declared base is read from the cells', () => {
    const data = {
      ...bare,
      fuelBase: { freight: 'Yes', pickup: 'Yes', delivery: 'Yes', oda: 'Yes', charges: 'Yes' },
    } as unknown as RateCardData;
    expect(fuelBaseFrom(data)).toEqual({
      freight: true,
      pickup: true,
      delivery: true,
      oda: true,
      charges: true,
    });
  });

  /**
   * Half a declaration is still a declaration: an omitted component is off, not
   * quietly restored from the workbook default.
   */
  test('a partly declared base leaves the unmentioned components off', () => {
    const data = { ...bare, fuelBase: { freight: 'Yes' } } as unknown as RateCardData;
    expect(fuelBaseFrom(data)).toEqual({
      freight: true,
      pickup: false,
      delivery: false,
      oda: false,
      charges: false,
    });
  });
});

describe('chargesFrom', () => {
  test('a card with no catalog is quoted with its single docket field', () => {
    const charges = chargesFrom(bare);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.id).toBe('docket');
    expect(charges[0]?.amount).toBe(100);
    expect(charges[0]?.active).toBe(true);
  });

  test('a stored catalog becomes charge definitions, keyed by charge id', () => {
    const data = {
      ...bare,
      chargeCatalog: {
        docket: { name: 'Docket', basis: 'per-shipment', amount: 100, gstApplies: 'Yes', fuelApplies: 'No', active: 'Yes' },
        awb: { name: 'AWB', basis: 'per-awb', amount: 35, gstApplies: 'Yes', fuelApplies: 'No', active: 'No', modes: 'air, nfo' },
      },
    } as unknown as RateCardData;
    const charges = chargesFrom(data);
    expect(charges.map((charge) => charge.id)).toEqual(['docket', 'awb']);
    expect(charges[1]?.modes).toEqual(['air', 'nfo']);
    expect(charges[1]?.active).toBe(false);
  });

  test('an empty catalog means no charges, not a fallback to the docket', () => {
    const data = { ...bare, chargeCatalog: {} } as unknown as RateCardData;
    expect(chargesFrom(data)).toEqual([]);
  });

  test('a per-destination charge keeps its amount per zone', () => {
    const data = {
      ...bare,
      chargeCatalog: {
        ess: { name: 'ESS', basis: 'per-destination', amount: 0, gstApplies: 'Yes', fuelApplies: 'No', active: 'Yes', byDestination: { BLR: 3000 } },
      },
    } as unknown as RateCardData;
    expect(chargesFrom(data)[0]?.byDestination).toEqual({ BLR: 3000 });
  });

  test('an unrecognised basis falls back to per-shipment rather than failing a quote', () => {
    const data = {
      ...bare,
      chargeCatalog: { odd: { name: 'Odd', basis: 'per-fortnight', amount: 10, active: 'Yes' } },
    } as unknown as RateCardData;
    expect(chargesFrom(data)[0]?.basis).toBe('per-shipment');
  });

  test('an array catalog is accepted too, which is what the API posts', () => {
    const data = {
      ...bare,
      chargeCatalog: [
        { id: 'docket', name: 'Docket', basis: 'per-shipment', amount: 100, gstApplies: true, fuelApplies: false, active: true },
      ],
    } as unknown as RateCardData;
    expect(chargesFrom(data)[0]?.id).toBe('docket');
    expect(chargesFrom(data)[0]?.gstApplies).toBe(true);
  });
});

describe('taxOverridesFrom', () => {
  test("a card with no tax block is settled at the card's own rate, forward charge", () => {
    const patch = taxOverridesFrom('surface', bare, 0.05)?.surface;
    expect(patch?.gstRate).toBe(0.05);
    expect(patch?.rcm).toBe(false);
  });

  test('a declared reverse charge is honoured', () => {
    const data = { ...bare, modeTax: { surface: { rcm: 'Yes' } } } as unknown as RateCardData;
    expect(taxOverridesFrom('surface', data, 0.05)?.surface?.rcm).toBe(true);
  });

  test('a declared rate replaces the workbook rate', () => {
    const data = { ...bare, modeTax: { surface: { gstRate: 0.12 } } } as unknown as RateCardData;
    expect(taxOverridesFrom('surface', data, 0.05)?.surface?.gstRate).toBe(0.12);
  });

  test('SAC and ITC are only overridden when the card states them', () => {
    const data = { ...bare, modeTax: { air: { sac: '9967', itc: 'No' } } } as unknown as RateCardData;
    const patch = taxOverridesFrom('air', data, 0.18)?.air;
    expect(patch?.sac).toBe('9967');
    expect(patch?.itc).toBe(false);
    expect(taxOverridesFrom('surface', bare, 0.05)?.surface).not.toHaveProperty('sac');
  });

  test('NFO is taxed in its own right, not as air', () => {
    const data = { ...bare, modeTax: { nfo: { gstRate: 0.18 } } } as unknown as RateCardData;
    expect(taxOverridesFrom('nfo', data, 0.18)?.nfo?.gstRate).toBe(0.18);
  });
});

/**
 * A stored charge carries only what differs. The basis of a known charge — ODA by
 * pincode, ESS per destination — is structural, not something a person should have to
 * retype into a cell correctly for the quote to come out right.
 */
describe('a stored charge merges over the known definition for its id', () => {
  const withStored = (id: string, stored: Record<string, unknown>) =>
    chargesFrom({
      ...bare,
      chargeCatalog: { [id]: stored },
    } as unknown as RateCardData)[0];

  test('the basis comes from the known charge, not from the cell', () => {
    expect(withStored('oda', { active: 'Yes' })?.basis).toBe('by-pincode');
    expect(withStored('ess', { active: 'Yes' })?.basis).toBe('per-destination');
  });

  test('the mode restriction comes from the known charge', () => {
    expect(withStored('awb', { active: 'Yes' })?.modes).toEqual(['air', 'nfo', 'courier']);
  });

  test('a stored amount overrides the default amount', () => {
    expect(withStored('docket', { amount: 150, active: 'Yes' })?.amount).toBe(150);
    expect(withStored('docket', { active: 'Yes' })?.amount).toBe(100);
  });

  test('a stored flag overrides the default flag', () => {
    expect(withStored('handling', { active: 'Yes' })?.fuelApplies).toBe(true);
    expect(withStored('handling', { active: 'Yes', fuelApplies: 'No' })?.fuelApplies).toBe(false);
  });

  test('a charge the catalog does not mention is not quoted at all', () => {
    const charges = chargesFrom({
      ...bare,
      chargeCatalog: { awb: { active: 'Yes' } },
    } as unknown as RateCardData);
    expect(charges.map((charge) => charge.id)).toEqual(['awb']);
  });

  test('an unknown id still prices, as a flat per-shipment charge', () => {
    const charge = withStored('bespoke-levy', { name: 'Bespoke levy', amount: 75, active: 'Yes' });
    expect(charge?.basis).toBe('per-shipment');
    expect(charge?.amount).toBe(75);
  });
});

describe('settlementDefaults', () => {
  test('reproduce the behaviour of a card that declares nothing', () => {
    const defaults = settlementDefaults(bare);
    const declared = { ...bare, ...defaults } as unknown as RateCardData;
    expect(fuelBaseFrom(declared)).toEqual(fuelBaseFrom(bare));
    expect(chargesFrom(declared).filter((charge) => charge.active)).toEqual(
      chargesFrom(bare).filter((charge) => charge.active),
    );
  });

  test("carry the card's own GST rate at forward charge, not the statutory default", () => {
    const declared = { ...bare, ...settlementDefaults(bare) } as unknown as RateCardData;
    const patch = taxOverridesFrom('surface', declared, 0.05)?.surface;
    expect(patch?.gstRate).toBe(0.05);
    expect(patch?.rcm).toBe(false);
  });

  test('store flags as the words a person edits, so the sheet reads properly', () => {
    const defaults = settlementDefaults(bare);
    expect(defaults.fuelBase.freight).toBe('Yes');
    expect(defaults.fuelBase.charges).toBe('No');
    expect(defaults.chargeCatalog.docket?.active).toBe('Yes');
    expect(defaults.chargeCatalog.awb?.active).toBe('No');
  });

  test('every billable mode gets a SAC code, so any mode can be invoiced', () => {
    const defaults = settlementDefaults(bare);
    expect(defaults.modeTax.surface?.sac).toBe('9965');
    expect(defaults.modeTax.ftl?.sac).toBe('9965');
    expect(defaults.modeTax.air?.sac).toBe('9968');
  });
});

/**
 * The configuration gains fields over time — ESS amounts per zone were added after the
 * first three cards were seeded. A card already in the database has to pick those up, or
 * the tab shows cells that bind to nothing.
 */
describe('settlementFill', () => {
  test('fills every block on a card that has none', () => {
    const fill = settlementFill(bare);
    expect(Object.keys(fill).sort()).toEqual([
      'chargeCatalog',
      'charges',
      'ftl',
      'fuelBase',
      'modeTax',
    ]);
  });

  test('leaves a fully configured card alone', () => {
    const configured = { ...bare, ...settlementDefaults(bare) } as unknown as RateCardData;
    expect(settlementFill(configured)).toEqual({});
  });

  test('adds a field that was missing without touching an edited one', () => {
    const defaults = settlementDefaults(bare);
    const configured = {
      ...bare,
      ...defaults,
      // As a previously seeded card looks: no ESS amounts, and an edited docket.
      fuelBase: { ...defaults.fuelBase, charges: 'Yes' },
      chargeCatalog: {
        ...defaults.chargeCatalog,
        ess: { ...defaults.chargeCatalog.ess, byDestination: {} },
        docket: { ...defaults.chargeCatalog.docket, amount: 150 },
      },
    } as unknown as RateCardData;

    const fill = settlementFill(configured);
    expect(fill.modeTax).toBeUndefined();
    expect(fill.fuelBase).toBeUndefined();
    const catalog = fill.chargeCatalog as Record<string, { amount?: number; byDestination?: Record<string, number> }>;
    expect(catalog.ess?.byDestination?.['BLR']).toBe(0);
    expect(catalog.docket?.amount).toBe(150);
  });

  test('ESS carries an amount cell for every zone, so each one is editable', () => {
    const catalog = settlementDefaults(bare).chargeCatalog;
    expect(Object.keys(catalog.ess?.byDestination ?? {})).toContain('HSR');
    expect(catalog.ess?.byDestination?.['HSR']).toBe(0);
  });
});

describe('FTL configuration is filled the same way', () => {
  test('a card with no FTL block gets one, with a rate cell per vehicle and lane', () => {
    const fill = settlementFill(bare);
    const ftl = fill.ftl as { rates: Record<string, Record<string, Record<string, number | null>>> };
    expect(Object.keys(ftl.rates)).toContain('32FT_SXL');
    expect(ftl.rates['32FT_SXL']?.['PNQ']?.['BLR']).toBeNull();
  });

  /** Null, not zero: a lane nobody has rated must not quote as free. */
  test('an unrated FTL lane is null rather than zero', () => {
    const fill = settlementFill(bare);
    const ftl = fill.ftl as { rates: Record<string, Record<string, Record<string, number | null>>> };
    const values = Object.values(ftl.rates['22FT'] ?? {}).flatMap((row) => Object.values(row));
    expect(values.every((value) => value === null)).toBe(true);
  });

  test('the FTL fuel rate becomes an editable charge parameter', () => {
    const charges = settlementFill(bare).charges as { fuelFtl?: number };
    expect(charges.fuelFtl).toBe(0);
  });

  test('an FTL rate someone has keyed is never overwritten', () => {
    const configured = {
      ...bare,
      ...settlementFill(bare),
    } as unknown as RateCardData;
    (configured.ftl as { rates: Record<string, Record<string, Record<string, number | null>>> }).rates[
      '32FT_SXL'
    ]!['PNQ']!['BLR'] = 33000;

    const fill = settlementFill(configured);
    expect(fill.ftl).toBeUndefined();
  });
});

/**
 * The workbook GST fields are superseded once a card declares `modeTax`.
 *
 * Every card now carries one, so `charges.gstAir` and `charges.gstSurface` no longer
 * reach a quote. That is the intended direction — GST follows the transport mode, and one
 * rate per air/surface cannot express road being 5% under reverse charge while rail is 5%
 * forward — but it means those two fields must not be offered as editable anywhere, or
 * someone will change a tax rate and watch nothing happen.
 */
describe('charges.gst* is a fallback, not a control', () => {
  const withModeTax = {
    ...bare,
    modeTax: { surface: { gstRate: 0.05 } },
  } as unknown as RateCardData;

  test('the declared per-mode rate wins over the workbook field', () => {
    expect(taxOverridesFrom('surface', withModeTax, 0.12)?.surface?.gstRate).toBe(0.05);
  });

  test('the workbook field is used only when no per-mode rate is declared', () => {
    expect(taxOverridesFrom('surface', bare, 0.12)?.surface?.gstRate).toBe(0.12);
  });

  test('a card seeded with defaults always declares one, for every billable mode', () => {
    const defaults = settlementDefaults(bare);
    for (const mode of ['surface', 'air', 'rail', 'nfo', 'ftl', 'courier']) {
      expect(defaults.modeTax[mode]?.gstRate, `${mode} has no declared rate`).toBeDefined();
    }
  });
});
