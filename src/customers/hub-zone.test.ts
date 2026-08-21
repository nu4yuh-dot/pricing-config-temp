import { describe, expect, test } from 'vitest';
import { resolveHubs, unknownHubMessage } from './hub-zone';

const zones = ['BOM', 'NCR', 'BLR', 'MAA'];

describe('resolving the core’s hubs to our zones', () => {
  test('a hub whose code is already a zone resolves to itself', () => {
    expect(resolveHubs(['BOM', 'NCR'], zones)).toEqual({ zones: ['BOM', 'NCR'], unknown: [] });
  });

  test('case and padding do not matter — the portal sends what a person typed', () => {
    expect(resolveHubs([' bom ', 'Ncr'], zones).zones).toEqual(['BOM', 'NCR']);
  });

  test('an unknown hub is reported, never guessed', () => {
    // Guessing prices a real consignment at another lane's rate, and the answer looks fine.
    const resolved = resolveHubs(['BOM', 'GOA'], zones);
    expect(resolved.zones).toEqual(['BOM']);
    expect(resolved.unknown).toEqual(['GOA']);
  });

  test('an override wins over the identity rule', () => {
    const resolved = resolveHubs(['DEL'], zones, [{ hub: 'DEL', zone: 'NCR' }]);
    expect(resolved.zones).toEqual(['NCR']);
  });

  test('an override pointing at a zone we do not have is reported, not trusted', () => {
    const resolved = resolveHubs(['DEL'], zones, [{ hub: 'DEL', zone: 'NOWHERE' }]);
    expect(resolved.zones).toEqual([]);
    expect(resolved.unknown).toEqual(['DEL']);
  });

  test('order is preserved, because a route is origin then destination', () => {
    expect(resolveHubs(['MAA', 'BLR'], zones).zones).toEqual(['MAA', 'BLR']);
  });

  test('an empty ask resolves to nothing rather than throwing', () => {
    expect(resolveHubs([], zones)).toEqual({ zones: [], unknown: [] });
  });
});

describe('what the caller is told', () => {
  test('one hub reads as one, several as several', () => {
    expect(unknownHubMessage(['GOA'])).toContain('hub GOA');
    expect(unknownHubMessage(['GOA', 'IXC'])).toContain('hubs GOA, IXC');
  });

  test('it asks for what we need rather than only refusing', () => {
    expect(unknownHubMessage(['GOA'])).toMatch(/Tell us which zone/);
  });
});
