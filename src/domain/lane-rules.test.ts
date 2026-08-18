import { describe, test, expect } from 'vitest';
import {
  endpointSpecificity,
  gridBindPath,
  gridLaneProvenance,
  matchesEndpoint,
  resolveLaneRule,
  orderRules,
  explainResolution,
} from './lane-rules';
import type { Endpoint, LaneRule } from './lane-rules';
import { withCity } from './city';
import type { Pincode } from './types';

/**
 * A pincode is 30 lines of mode blocks and a rule cares about four fields, so the
 * fixture takes those four and fills the rest with something plausible.
 */
function pincodeAt(fields: {
  pincode: number;
  state: string;
  airZone?: string;
  surfaceZone?: string;
  city?: string;
  district?: string;
}): Pincode {
  const mode = (zone: string) => ({
    serviceable: true,
    hub: zone,
    zone,
    edlKm: 0,
    oda: false,
    odaCategory: 'Non-ODA',
  });
  const surface = fields.surfaceZone ?? 'PNQ';
  return {
    pincode: fields.pincode,
    area: 'Test PO',
    state: fields.state,
    ...(fields.city === undefined ? {} : { city: fields.city }),
    ...(fields.district === undefined
      ? {}
      : { bluedart: { zone: 'A', odaStatus: 'Non-ODA', edlKm: 0, district: fields.district } }),
    air: mode(fields.airZone ?? surface),
    surface: mode(surface),
    rail: { ...mode(surface), station: `${surface} station` },
  } as Pincode;
}

const PUNE = pincodeAt({ pincode: 411001, state: 'Maharashtra', surfaceZone: 'PNQ' });

describe('endpoint specificity', () => {
  test('ranks the six kinds as the spec states', () => {
    expect(endpointSpecificity('pincode')).toBe(5);
    expect(endpointSpecificity('city')).toBe(4);
    expect(endpointSpecificity('zone')).toBe(3);
    expect(endpointSpecificity('state')).toBe(2);
    expect(endpointSpecificity('group')).toBe(1);
    expect(endpointSpecificity('any')).toBe(0);
  });
});

describe('matching one endpoint', () => {
  test('any matches every pincode', () => {
    expect(matchesEndpoint({ kind: 'any' }, PUNE, 'surface')).toBe(true);
  });

  test('pincode matches only its own number', () => {
    expect(matchesEndpoint({ kind: 'pincode', value: '411001' }, PUNE, 'surface')).toBe(true);
    expect(matchesEndpoint({ kind: 'pincode', value: '411002' }, PUNE, 'surface')).toBe(false);
  });

  test('zone is read per mode, so air and surface can disagree', () => {
    const split = pincodeAt({
      pincode: 421302,
      state: 'Maharashtra',
      surfaceZone: 'BOM',
      airZone: 'PNQ',
    });

    expect(matchesEndpoint({ kind: 'zone', value: 'BOM' }, split, 'surface')).toBe(true);
    expect(matchesEndpoint({ kind: 'zone', value: 'BOM' }, split, 'air')).toBe(false);
    expect(matchesEndpoint({ kind: 'zone', value: 'PNQ' }, split, 'air')).toBe(true);
  });

  test('state matches whatever case the rule was typed in', () => {
    expect(matchesEndpoint({ kind: 'state', value: 'Maharashtra' }, PUNE, 'surface')).toBe(true);
    expect(matchesEndpoint({ kind: 'state', value: 'maharashtra' }, PUNE, 'surface')).toBe(true);
    expect(matchesEndpoint({ kind: 'state', value: 'Gujarat' }, PUNE, 'surface')).toBe(false);
  });

  test('group matches when the pincode zone is in the named group for that mode', () => {
    expect(matchesEndpoint({ kind: 'group', value: 'metros' }, PUNE, 'surface')).toBe(true);

    const hosur = pincodeAt({ pincode: 635109, state: 'Tamil Nadu', surfaceZone: 'HSR' });
    expect(matchesEndpoint({ kind: 'group', value: 'metros' }, hosur, 'surface')).toBe(false);
    expect(matchesEndpoint({ kind: 'group', value: 'south' }, hosur, 'surface')).toBe(true);
  });

  test('an unknown group name matches nothing rather than everything', () => {
    expect(matchesEndpoint({ kind: 'group', value: 'no-such-group' }, PUNE, 'surface')).toBe(false);
  });

  test('city cannot match until the pincode master carries a city', () => {
    expect(matchesEndpoint({ kind: 'city', value: 'Pune' }, PUNE, 'surface')).toBe(false);
  });

  test('city matches once a pincode carries one', () => {
    const carrying = pincodeAt({ pincode: 411001, state: 'Maharashtra', city: 'Pune' });
    expect(matchesEndpoint({ kind: 'city', value: 'Pune' }, carrying, 'surface')).toBe(true);
    expect(matchesEndpoint({ kind: 'city', value: 'Mumbai' }, carrying, 'surface')).toBe(false);
  });
});

const NCR = pincodeAt({ pincode: 110001, state: 'Delhi', surfaceZone: 'NCR' });

/** A rule carrying a label instead of rates, so a test can name which one won. */
function rule(
  name: string,
  origin: Endpoint,
  destination: Endpoint,
  extra: Partial<LaneRule<string>> = {},
): LaneRule<string> {
  return { mode: 'surface', origin, destination, rates: name, layer: 'base', ...extra };
}

const shipment = { mode: 'surface' as const, origin: PUNE, destination: NCR };

describe('resolving a lane against rules', () => {
  test('no rules means no resolution, so a card without any prices exactly as today', () => {
    expect(resolveLaneRule([], shipment)).toBeNull();
  });

  test('a rule for another mode never applies', () => {
    const airOnly = rule('air', { kind: 'any' }, { kind: 'any' }, { mode: 'air' });
    expect(resolveLaneRule([airOnly], shipment)).toBeNull();
  });

  test('the more specific rule wins', () => {
    const broad = rule('broad', { kind: 'any' }, { kind: 'any' });
    const exact = rule(
      'exact',
      { kind: 'pincode', value: '411001' },
      { kind: 'pincode', value: '110001' },
    );

    expect(resolveLaneRule([broad, exact], shipment)?.rule.rates).toBe('exact');
    expect(resolveLaneRule([exact, broad], shipment)?.rule.rates).toBe('exact');
  });

  test('specificity is the sum of both ends, not the sharper one', () => {
    // pincode → any is 5 + 0; zone → zone is 3 + 3, so the pair wins despite the
    // weaker origin.
    const oneSharpEnd = rule('pincode-any', { kind: 'pincode', value: '411001' }, { kind: 'any' });
    const bothMiddling = rule(
      'zone-zone',
      { kind: 'zone', value: 'PNQ' },
      { kind: 'zone', value: 'NCR' },
    );

    expect(resolveLaneRule([oneSharpEnd, bothMiddling], shipment)?.rule.rates).toBe('zone-zone');
  });

  test('tie rule 1 — on an equal sum, the sharper origin wins', () => {
    const originSharper = rule(
      'zone-state',
      { kind: 'zone', value: 'PNQ' },
      { kind: 'state', value: 'Delhi' },
    );
    const destinationSharper = rule(
      'state-zone',
      { kind: 'state', value: 'Maharashtra' },
      { kind: 'zone', value: 'NCR' },
    );

    expect(resolveLaneRule([destinationSharper, originSharper], shipment)?.rule.rates).toBe(
      'zone-state',
    );
  });

  test('tie rule 3 — genuinely equivalent rules resolve by recency and say so', () => {
    const older = rule('older', { kind: 'zone', value: 'PNQ' }, { kind: 'zone', value: 'NCR' }, {
      updatedAt: 1_000,
    });
    const newer = rule('newer', { kind: 'zone', value: 'PNQ' }, { kind: 'zone', value: 'NCR' }, {
      updatedAt: 2_000,
    });

    const resolved = resolveLaneRule([older, newer], shipment);
    expect(resolved?.rule.rates).toBe('newer');
    expect(resolved?.ambiguous).toBe(true);
  });

  test('a single winning rule is not flagged ambiguous', () => {
    const only = rule('only', { kind: 'zone', value: 'PNQ' }, { kind: 'any' });
    expect(resolveLaneRule([only], shipment)?.ambiguous).toBe(false);
  });
});

describe('layers — a negotiated price is never displaced by a standard edit', () => {
  const negotiated = rule(
    'contract-broad',
    { kind: 'zone', value: 'PNQ' },
    { kind: 'zone', value: 'NCR' },
    { layer: 'contract' },
  );
  const standardExact = rule(
    'base-exact',
    { kind: 'pincode', value: '411001' },
    { kind: 'pincode', value: '110001' },
  );

  test('a contract rule beats a more specific base rule', () => {
    expect(resolveLaneRule([standardExact, negotiated], shipment)?.rule.rates).toBe(
      'contract-broad',
    );
  });

  test('the base card is consulted when no contract rule matches', () => {
    const elsewhere = rule(
      'contract-elsewhere',
      { kind: 'zone', value: 'BLR' },
      { kind: 'any' },
      { layer: 'contract' },
    );

    expect(resolveLaneRule([standardExact, elsewhere], shipment)?.rule.rates).toBe('base-exact');
  });

  test('specificity still orders rules within the contract layer', () => {
    const sharper = rule(
      'contract-exact',
      { kind: 'pincode', value: '411001' },
      { kind: 'zone', value: 'NCR' },
      { layer: 'contract' },
    );

    expect(resolveLaneRule([negotiated, sharper], shipment)?.rule.rates).toBe('contract-exact');
  });
});

describe('the trace a quote shows', () => {
  test('names the endpoints, the kinds and the layer', () => {
    const resolved = resolveLaneRule(
      [
        rule(
          'r',
          { kind: 'zone', value: 'PNQ' },
          { kind: 'state', value: 'Delhi' },
          { layer: 'contract' },
        ),
      ],
      shipment,
    );

    expect(resolved?.trace).toBe('PNQ → Delhi · zone → state · contract');
  });

  test('an unnamed endpoint reads as "any"', () => {
    const resolved = resolveLaneRule([rule('r', { kind: 'any' }, { kind: 'any' })], shipment);
    expect(resolved?.trace).toBe('any → any · any → any · base');
  });
});

describe('grid lane provenance — which layer supplied this lane', () => {
  const lane = { mode: 'surface' as const, originZone: 'PNQ', destinationZone: 'NCR' };

  test('builds the bind path the diff and the override map already use', () => {
    expect(gridBindPath('surface', 'minCharge', 'PNQ', 'NCR')).toBe(
      'grids.surface.minCharge.PNQ.NCR',
    );
  });

  test('a quote with no contract reads as the base card, at zone to zone', () => {
    const provenance = gridLaneProvenance(lane);

    expect(provenance.layer).toBe('base');
    expect(provenance.negotiated).toEqual([]);
    expect(provenance.trace).toBe('PNQ → NCR · zone → zone · base');
  });

  test('an override on this lane makes it a contract price and names the fields', () => {
    const provenance = gridLaneProvenance({
      ...lane,
      overrides: {
        'grids.surface.minCharge.PNQ.NCR': 450,
        'grids.surface.tier2.PNQ.NCR': 11,
      },
    });

    expect(provenance.layer).toBe('contract');
    expect(provenance.negotiated).toEqual(['minCharge', 'tier2']);
    expect(provenance.trace).toBe('PNQ → NCR · zone → zone · contract');
  });

  test('an override on a different lane leaves this one on the base card', () => {
    const provenance = gridLaneProvenance({
      ...lane,
      overrides: { 'grids.surface.minCharge.BOM.NCR': 450 },
    });

    expect(provenance.layer).toBe('base');
    expect(provenance.negotiated).toEqual([]);
  });

  test('an override on another mode does not claim this lane', () => {
    const provenance = gridLaneProvenance({
      ...lane,
      overrides: { 'grids.air.minCharge.PNQ.NCR': 450 },
    });

    expect(provenance.layer).toBe('base');
  });

  test('a negotiated null is still a negotiation — the lane was deliberately closed', () => {
    const provenance = gridLaneProvenance({
      ...lane,
      overrides: { 'grids.surface.minCharge.PNQ.NCR': null },
    });

    expect(provenance.layer).toBe('contract');
    expect(provenance.negotiated).toEqual(['minCharge']);
  });
});

describe('city, once the master derives one', () => {
  test('a city endpoint matches a pincode whose district resolved to that city', () => {
    const pune = withCity(pincodeAt({ pincode: 411001, state: 'Maharashtra', district: 'Pune' }));
    expect(matchesEndpoint({ kind: 'city', value: 'Pune' }, pune, 'surface')).toBe(true);
  });

  test('the alias is applied, so a rule says Bangalore and the district says Bengaluru Urban', () => {
    const blr = withCity(
      pincodeAt({
        pincode: 560001,
        state: 'Karnataka',
        surfaceZone: 'BLR',
        district: 'Bengaluru Urban',
      }),
    );
    expect(matchesEndpoint({ kind: 'city', value: 'Bangalore' }, blr, 'surface')).toBe(true);
  });

  test('Pimpri-Chinchwad resolves to Pune, which is the known cost of using district', () => {
    const pimpri = withCity(pincodeAt({ pincode: 411017, state: 'Maharashtra', district: 'Pune' }));
    expect(matchesEndpoint({ kind: 'city', value: 'Pune' }, pimpri, 'surface')).toBe(true);
    expect(matchesEndpoint({ kind: 'city', value: 'Pimpri-Chinchwad' }, pimpri, 'surface')).toBe(
      false,
    );
  });
});

describe('the precedence cascade', () => {
  test('orders rules the way the resolver checks them', () => {
    const broad = rule('broad', { kind: 'any' }, { kind: 'any' });
    const exact = rule(
      'exact',
      { kind: 'pincode', value: '411001' },
      { kind: 'pincode', value: '110001' },
    );
    const city = rule('city', { kind: 'city', value: 'Pune' }, { kind: 'city', value: 'Delhi' });

    expect(orderRules([broad, city, exact]).map((r) => r.rates)).toEqual([
      'exact',
      'city',
      'broad',
    ]);
  });

  test('does not reorder the caller’s array in place', () => {
    const broad = rule('broad', { kind: 'any' }, { kind: 'any' });
    const exact = rule('exact', { kind: 'pincode', value: '411001' }, { kind: 'any' });
    const given = [broad, exact];

    orderRules(given);
    expect(given.map((r) => r.rates)).toEqual(['broad', 'exact']);
  });
});

describe('explaining a resolution', () => {
  test('walks the cascade and marks the one that won', () => {
    const exact = rule(
      'exact',
      { kind: 'pincode', value: '411001' },
      { kind: 'pincode', value: '110001' },
    );
    const zone = rule('zone', { kind: 'zone', value: 'PNQ' }, { kind: 'zone', value: 'NCR' });

    const { steps, winner } = explainResolution([zone, exact], shipment);

    expect(winner?.rule.rates).toBe('exact');
    expect(steps.map((s) => s.rates)).toEqual(['exact', 'zone']);
    expect(steps[0]).toMatchObject({ matched: true });
  });

  test('a rule that does not match is listed as not matching, not hidden', () => {
    const elsewhere = rule('elsewhere', { kind: 'city', value: 'Chennai' }, { kind: 'any' });
    const { steps, winner } = explainResolution([elsewhere], shipment);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.matched).toBe(false);
    expect(winner).toBeNull();
  });

  test('a rule for another mode is not in the cascade at all', () => {
    const airOnly = rule('air', { kind: 'any' }, { kind: 'any' }, { mode: 'air' });
    expect(explainResolution([airOnly], shipment).steps).toEqual([]);
  });

  test('no rules at all explains nothing rather than throwing', () => {
    expect(explainResolution([], shipment)).toEqual({ steps: [], winner: null });
  });

  test('the winner it names is the one resolveLaneRule would have picked', () => {
    const rules = [
      rule('zone', { kind: 'zone', value: 'PNQ' }, { kind: 'zone', value: 'NCR' }),
      rule('state', { kind: 'state', value: 'Maharashtra' }, { kind: 'any' }),
      rule('contract', { kind: 'any' }, { kind: 'any' }, { layer: 'contract' }),
    ];

    expect(explainResolution(rules, shipment).winner?.rule.rates).toBe(
      resolveLaneRule(rules, shipment)?.rule.rates,
    );
  });
});
