import { describe, expect, test } from 'vitest';
import { widenScope, widenedBy } from './widen';
import { UNRESTRICTED_SCOPE, type ContractScope } from '../domain/customers';

describe('widening a contract that already covers everything', () => {
  test('stays covering everything — this is the one that would silently take rights away', () => {
    // null means "every mode". Writing ['air'] here would remove surface and rail from a
    // customer who has been booking them, while the audit log said we granted a request.
    const after = widenScope(UNRESTRICTED_SCOPE, { modes: ['air'] });
    expect(after.modes).toBeNull();
    expect(after.lanes).toBeNull();
    expect(after.weightBands).toBeNull();
  });

  test('the same holds for each dimension independently', () => {
    const partly: ContractScope = { modes: ['surface'], lanes: null, weightBands: null };
    const after = widenScope(partly, { modes: ['air'], lanes: ['air:NCR>BOM'] });
    expect(after.modes).toEqual(['surface', 'air']);
    // Lanes were unrestricted and must stay that way.
    expect(after.lanes).toBeNull();
  });
});

describe('widening a restricted contract', () => {
  const scope: ContractScope = {
    modes: ['surface'],
    lanes: ['surface:NCR>BOM'],
    weightBands: [{ from: 0, to: 100 }],
  };

  test('adds what was asked for and keeps what was there', () => {
    const after = widenScope(scope, {
      modes: ['air'],
      lanes: ['air:NCR>MAA'],
      weightBands: [{ from: 100, to: null }],
    });
    expect(after.modes).toEqual(['surface', 'air']);
    expect(after.lanes).toEqual(['surface:NCR>BOM', 'air:NCR>MAA']);
    expect(after.weightBands).toEqual([{ from: 0, to: 100 }, { from: 100, to: null }]);
  });

  test('asking for something already covered changes nothing', () => {
    const after = widenScope(scope, { modes: ['surface'], weightBands: [{ from: 0, to: 100 }] });
    expect(after.modes).toEqual(['surface']);
    expect(after.weightBands).toEqual([{ from: 0, to: 100 }]);
  });

  test('an empty ask is a no-op rather than a wipe', () => {
    expect(widenScope(scope, {})).toEqual(scope);
  });

  test('a band that differs only in its open end is kept, not merged', () => {
    // 100–null and 100–500 are different promises; silently treating them as one would
    // decide a commercial question in code.
    const after = widenScope(scope, { weightBands: [{ from: 100, to: null }, { from: 100, to: 500 }] });
    expect(after.weightBands).toHaveLength(3);
  });

  test('the original scope is not mutated', () => {
    const before = JSON.parse(JSON.stringify(scope));
    widenScope(scope, { modes: ['rail'] });
    expect(scope).toEqual(before);
  });
});

describe('reporting what changed', () => {
  test('names each dimension that grew', () => {
    const before: ContractScope = { modes: ['surface'], lanes: ['a'], weightBands: null };
    const after = widenScope(before, { modes: ['air', 'rail'], lanes: ['b'] });
    expect(widenedBy(before, after)).toEqual(['2 modes', '1 lane']);
  });

  test('a request that changed nothing says so, rather than reading as granted', () => {
    const before: ContractScope = { modes: ['surface'], lanes: null, weightBands: null };
    expect(widenedBy(before, widenScope(before, { modes: ['surface'] }))).toEqual([]);
  });

  test('an already-unrestricted contract reports no growth', () => {
    expect(widenedBy(UNRESTRICTED_SCOPE, widenScope(UNRESTRICTED_SCOPE, { modes: ['air'] }))).toEqual([]);
  });
});
