import { describe, expect, test } from 'vitest';
import { parseCustomerCsv, CSV_TEMPLATE } from './csv';
import { zonesInGroup } from '../domain/zone-groups';

describe('rate rows', () => {
  test('sets a single lane rate', () => {
    const { overrides, issues } = parseCustomerCsv('rate,surface,PNQ,NCR,minCharge,450');
    expect(issues).toEqual([]);
    expect(overrides['grids.surface.minCharge.PNQ.NCR']).toBe(450);
  });

  test('expands a group to every lane inside it', () => {
    const { overrides, expansions } = parseCustomerCsv('rate,surface,metros,metros,tier2,12');
    const metros = zonesInGroup('metros', 'surface');
    const expected = metros.length * metros.length - metros.length;
    expect(expansions[0]?.lanes).toBe(expected);
    expect(Object.keys(overrides)).toHaveLength(expected);
  });

  test('never writes a same-zone lane from a group expansion', () => {
    const { overrides } = parseCustomerCsv('rate,surface,metros,metros,tier2,12');
    for (const path of Object.keys(overrides)) {
      const [, , , origin, destination] = path.split('.');
      expect(origin).not.toBe(destination);
    }
  });

  test('a blank value marks the lane not carried', () => {
    const { overrides } = parseCustomerCsv('rate,surface,PNQ,GAU,minCharge,');
    expect(overrides['grids.surface.minCharge.PNQ.GAU']).toBeNull();
  });

  test('drops surface-only clusters when the mode is air', () => {
    const { overrides } = parseCustomerCsv('rate,air,west,metros,minCharge,1800');
    // PCMC has no air hub, so no air lane may be written from it.
    expect(Object.keys(overrides).some((p) => p.includes('.PCMC.'))).toBe(false);
  });

  test('reports an unknown mode', () => {
    const { issues } = parseCustomerCsv('rate,sea,PNQ,NCR,minCharge,450');
    expect(issues[0]?.message).toMatch(/not surface, air or rail/);
  });

  test('reports an unknown rate name', () => {
    const { issues } = parseCustomerCsv('rate,surface,PNQ,NCR,tier9,450');
    expect(issues[0]?.message).toMatch(/not a rate name/);
  });

  test('reports an unknown zone or group', () => {
    const { issues } = parseCustomerCsv('rate,surface,ATLANTIS,NCR,minCharge,450');
    expect(issues[0]?.message).toMatch(/not a zone or a group/);
  });

  test('reports a non-numeric value', () => {
    const { issues } = parseCustomerCsv('rate,surface,PNQ,NCR,minCharge,cheap');
    expect(issues[0]?.message).toMatch(/not a number/);
  });
});

describe('charge rows', () => {
  test('sets a surcharge', () => {
    const { overrides } = parseCustomerCsv('charge,fuelSurface,0.2');
    expect(overrides['charges.fuelSurface']).toBe(0.2);
  });

  test('refuses a field that is not on the whitelist', () => {
    const { issues } = parseCustomerCsv('charge,nfoMultiplier,3');
    expect(issues[0]?.message).toMatch(/not a charge that can be set/);
  });
});

describe('coverage rows', () => {
  test('sets modes', () => {
    const { scope } = parseCustomerCsv('coverage,modes,surface|air');
    expect(scope.modes).toEqual(['surface', 'air']);
  });

  test('sets lanes', () => {
    const { scope } = parseCustomerCsv('coverage,lanes,surface:PNQ>NCR|air:PNQ>BLR');
    expect(scope.lanes).toEqual(['surface:PNQ>NCR', 'air:PNQ>BLR']);
  });

  test('sets weight bands, with an open top end', () => {
    const { scope } = parseCustomerCsv('coverage,weight,0-100|300-');
    expect(scope.weightBands).toEqual([
      { from: 0, to: 100 },
      { from: 300, to: null },
    ]);
  });

  test('leaves coverage unrestricted when no coverage rows are present', () => {
    const { scope } = parseCustomerCsv('rate,surface,PNQ,NCR,minCharge,450');
    expect(scope).toEqual({ modes: null, lanes: null, weightBands: null });
  });

  test('reports a malformed lane', () => {
    const { issues } = parseCustomerCsv('coverage,lanes,PNQ-NCR');
    expect(issues[0]?.message).toMatch(/not a lane like/);
  });

  test('reports a bad mode in coverage', () => {
    const { issues } = parseCustomerCsv('coverage,modes,surface|hovercraft');
    expect(issues[0]?.message).toMatch(/Not modes: hovercraft/);
  });
});

describe('terms rows', () => {
  test('sets billing type', () => {
    expect(parseCustomerCsv('terms,billingType,RCM').commercial.billingType).toBe('RCM');
  });

  test('reads gstApplicable loosely, because people write yes or true', () => {
    expect(parseCustomerCsv('terms,gstApplicable,yes').commercial.gstApplicable).toBe(true);
    expect(parseCustomerCsv('terms,gstApplicable,TRUE').commercial.gstApplicable).toBe(true);
    expect(parseCustomerCsv('terms,gstApplicable,no').commercial.gstApplicable).toBe(false);
  });

  test('sets payment terms and credit limit', () => {
    const { commercial } = parseCustomerCsv('terms,paymentTermsDays,45\nterms,creditLimit,250000');
    expect(commercial.paymentTermsDays).toBe(45);
    expect(commercial.creditLimit).toBe(250000);
  });

  test('treats a blank credit limit as none', () => {
    expect(parseCustomerCsv('terms,creditLimit,').commercial.creditLimit).toBeNull();
  });

  test('rejects an invalid billing type', () => {
    expect(parseCustomerCsv('terms,billingType,CASH').issues[0]?.message).toMatch(/FORWARD or RCM/);
  });
});

describe('the file as a whole', () => {
  test('ignores comments, blanks and a header row', () => {
    const { overrides, issues } = parseCustomerCsv(
      ['# a comment', '', 'type,a,b,c,d,e', 'rate,surface,PNQ,NCR,minCharge,450'].join('\n'),
    );
    expect(issues).toEqual([]);
    expect(Object.keys(overrides)).toHaveLength(1);
  });

  test('reports every problem rather than stopping at the first', () => {
    const { issues } = parseCustomerCsv(
      ['rate,sea,PNQ,NCR,minCharge,450', 'charge,nope,1', 'wat,1,2'].join('\n'),
    );
    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3]);
  });

  test('keeps the good rows even when others are faulty', () => {
    const { overrides, issues } = parseCustomerCsv(
      ['rate,surface,PNQ,NCR,minCharge,450', 'rate,sea,PNQ,NCR,minCharge,1'].join('\n'),
    );
    expect(issues).toHaveLength(1);
    expect(overrides['grids.surface.minCharge.PNQ.NCR']).toBe(450);
  });

  test('names the row type when it is unrecognised', () => {
    expect(parseCustomerCsv('nonsense,1,2').issues[0]?.message).toMatch(/not a row type/);
  });

  test('the bundled template parses with no issues at all', () => {
    const result = parseCustomerCsv(CSV_TEMPLATE);
    expect(result.issues).toEqual([]);
    expect(Object.keys(result.overrides).length).toBeGreaterThan(10);
    expect(result.scope.modes).toEqual(['surface', 'air']);
    expect(result.commercial.billingType).toBe('FORWARD');
  });
});

/**
 * The settlement rows.
 *
 * These are what let a whole contract arrive in one file — A Raymond's is "35% fuel on
 * total charges plus nine express surcharges", none of which is a lane rate. Without them
 * the CSV could describe half a contract and the rest had to be keyed by hand.
 */
describe('fuel base, tax and the charge menu', () => {
  test('all five components Yes is fuel on total charges', () => {
    const result = parseCustomerCsv(
      [
        'fuel-base,freight,Yes',
        'fuel-base,pickup,Yes',
        'fuel-base,delivery,Yes',
        'fuel-base,oda,Yes',
        'fuel-base,charges,Yes',
      ].join('\n'),
    );
    expect(result.issues).toEqual([]);
    expect(result.overrides['fuelBase.charges']).toBe('Yes');
    expect(Object.keys(result.overrides)).toHaveLength(5);
  });

  test('yes and no are read the way a person writes them', () => {
    const result = parseCustomerCsv('fuel-base,charges,no\nfuel-base,oda,TRUE');
    expect(result.overrides['fuelBase.charges']).toBe('No');
    expect(result.overrides['fuelBase.oda']).toBe('Yes');
  });

  test('an unrecognised flag is refused rather than guessed at', () => {
    const result = parseCustomerCsv('fuel-base,charges,maybe');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/not Yes or No/);
    expect(result.overrides).toEqual({});
  });

  test('an unknown fuel component is named in the error', () => {
    const result = parseCustomerCsv('fuel-base,docket,Yes');
    expect(result.issues[0]?.message).toMatch(/not a fuel-base component/);
  });

  test('GST is set per mode, with its own SAC and reverse-charge position', () => {
    const result = parseCustomerCsv('tax,surface,gstRate,0.05\ntax,surface,rcm,Yes\ntax,air,sac,9968');
    expect(result.overrides['modeTax.surface.gstRate']).toBe(0.05);
    expect(result.overrides['modeTax.surface.rcm']).toBe('Yes');
    expect(result.overrides['modeTax.air.sac']).toBe('9968');
  });

  test('a mode that is not billable is refused', () => {
    expect(parseCustomerCsv('tax,bicycle,gstRate,0.05').issues[0]?.message).toMatch(/not a mode/);
  });

  test('a charge is switched on and priced', () => {
    const result = parseCustomerCsv('menu,handling,active,Yes\nmenu,handling,amount,75');
    expect(result.overrides['chargeCatalog.handling.active']).toBe('Yes');
    expect(result.overrides['chargeCatalog.handling.amount']).toBe(75);
  });

  test('a charge can be put outside GST, which changes when it is added', () => {
    const result = parseCustomerCsv('menu,deposit,gstApplies,No');
    expect(result.overrides['chargeCatalog.deposit.gstApplies']).toBe('No');
  });

  test('express surcharges are set per destination zone', () => {
    const result = parseCustomerCsv('ess,BLR,3000\ness,HSR,2000');
    expect(result.overrides['chargeCatalog.ess.byDestination.BLR']).toBe(3000);
    expect(result.overrides['chargeCatalog.ess.byDestination.HSR']).toBe(2000);
  });

  test('a zone code that does not exist is refused', () => {
    expect(parseCustomerCsv('ess,NOWHERE,3000').issues[0]?.message).toMatch(/not a zone code/);
  });

  test('the volumetric divisor can be negotiated in the file', () => {
    const result = parseCustomerCsv('charge,volumetricDivisorSurface,4000');
    expect(result.overrides['charges.volumetricDivisorSurface']).toBe(4000);
  });

  /** A Raymond's whole settlement, as it would actually arrive. */
  test("A Raymond's contract terms all parse together", () => {
    const result = parseCustomerCsv(
      [
        '# A Raymond, Chakan',
        'charge,fuelAir,0.35',
        'fuel-base,freight,Yes',
        'fuel-base,pickup,Yes',
        'fuel-base,delivery,Yes',
        'fuel-base,oda,Yes',
        'fuel-base,charges,Yes',
        'menu,ess,active,Yes',
        'ess,BLR,3000',
        'ess,HSR,2000',
        'ess,CJB,3000',
      ].join('\n'),
    );
    expect(result.issues).toEqual([]);
    expect(result.overrides['charges.fuelAir']).toBe(0.35);
    expect(result.overrides['fuelBase.charges']).toBe('Yes');
    expect(result.overrides['chargeCatalog.ess.active']).toBe('Yes');
    expect(result.overrides['chargeCatalog.ess.byDestination.BLR']).toBe(3000);
  });
});
