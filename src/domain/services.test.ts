import { describe, expect, test } from 'vitest';
import {
  BUILT_IN_SERVICES,
  apiTierName,
  applyServiceMultiplier,
  serviceForMode,
  serviceIsValid,
  serviceRules,
  serviceTiers,
  serviceTransitDays,
  type Service,
} from './services';
import { MODES } from './types';

const service = (over: Partial<Service> = {}): Service => ({
  key: 'surface-express',
  name: 'Surface Express',
  mode: 'surface',
  active: true,
  multiplier: 1.15,
  ...over,
});

describe('the services that exist before anyone configures one', () => {
  test('every mode is a service of the same key, so existing callers keep working', () => {
    for (const mode of MODES) {
      expect(serviceForMode(mode, BUILT_IN_SERVICES)).not.toBeNull();
    }
  });

  test('nfo is air at twice the rate — what the engine already did, now written down', () => {
    const nfo = serviceForMode('nfo', BUILT_IN_SERVICES)!;
    expect(nfo.mode).toBe('air');
    expect(nfo.multiplier).toBe(2);
  });

  test('the plain modes multiply by one, so nothing changes for them', () => {
    for (const key of ['surface', 'air', 'rail'] as const) {
      expect(serviceForMode(key, BUILT_IN_SERVICES)?.multiplier).toBe(1);
    }
  });

  test('every built-in is valid by its own rules', () => {
    for (const built of BUILT_IN_SERVICES) expect(serviceIsValid(built)).toBeNull();
  });
});

describe('what a service may claim', () => {
  test('it must ride a network the engine actually prices', () => {
    // Sea is a real mode in the core's data and not one we hold rates for. A service
    // claiming it would quote from a grid that does not exist.
    expect(serviceIsValid(service({ mode: 'sea' as never }))).toMatch(/not a network/);
  });

  test('a zero or negative multiplier is refused', () => {
    // Zero quotes free freight; negative pays the customer to ship.
    expect(serviceIsValid(service({ multiplier: 0 }))).toMatch(/greater than zero/);
    expect(serviceIsValid(service({ multiplier: -1 }))).toMatch(/greater than zero/);
  });

  test('a GST rate is a fraction, not a percentage', () => {
    expect(serviceIsValid(service({ gstRate: 18 }))).toMatch(/fraction/);
    expect(serviceIsValid(service({ gstRate: 0.18 }))).toBeNull();
  });

  test('an unnamed service is refused', () => {
    expect(serviceIsValid(service({ key: '  ' }))).toMatch(/needs a key/);
  });
});

describe('pricing through a service', () => {
  test('the multiplier applies to freight and rounds to paise', () => {
    expect(applyServiceMultiplier(1000, service({ multiplier: 1.15 }))).toBe(1150);
    expect(applyServiceMultiplier(333.33, service({ multiplier: 1.15 }))).toBe(383.33);
  });

  test('a multiplier of one leaves the number untouched', () => {
    expect(applyServiceMultiplier(2506.9, service({ multiplier: 1 }))).toBe(2506.9);
  });

  test('an express service arrives sooner, not merely dearer', () => {
    expect(serviceTransitDays(5, service({ transitAdjustmentDays: -2 }))).toBe(3);
  });

  test('transit never falls below a day, however express the service', () => {
    // Same-day is a different product with a different operation behind it; quoting zero
    // days on an ordinary lane promises something nobody has agreed to run.
    expect(serviceTransitDays(1, service({ transitAdjustmentDays: -5 }))).toBe(1);
  });

  test('an unserved lane has no transit, and adding to it does not invent one', () => {
    expect(serviceTransitDays(null, service({ transitAdjustmentDays: -1 }))).toBeNull();
  });

  test('a service with no adjustment reports the mode’s own transit', () => {
    expect(serviceTransitDays(4, service())).toBe(4);
  });
});

describe('the tiers a caller is offered', () => {
  const custom = (over: Partial<Service> = {}): Service => ({
    key: 'surface-express',
    name: 'Surface Express',
    mode: 'surface',
    active: true,
    multiplier: 1.3,
    ...over,
  });

  test('with nothing configured, the four networks answer under the names the core sends', () => {
    const tiers = serviceTiers(BUILT_IN_SERVICES);
    expect(tiers.map((t) => t.api)).toEqual(['ECONOMY', 'EXPRESS', 'CRITICAL', 'RAIL']);
  });

  test('the order is the one the core has always received', () => {
    // A caller reading only the first three must keep reading surface, air, next-flight-out.
    const tiers = serviceTiers(BUILT_IN_SERVICES);
    expect(tiers.map((t) => t.mode)).toEqual(['surface', 'air', 'nfo', 'rail']);
  });

  test('a configured service is appended, never inserted among the four', () => {
    const tiers = serviceTiers([...BUILT_IN_SERVICES, custom()]);
    expect(tiers).toHaveLength(5);
    expect(tiers[4]!.api).toBe('SURFACE-EXPRESS');
    expect(tiers.slice(0, 4).map((t) => t.api)).toEqual(['ECONOMY', 'EXPRESS', 'CRITICAL', 'RAIL']);
  });

  test('a configured service rides the mode it names', () => {
    const tiers = serviceTiers([...BUILT_IN_SERVICES, custom({ mode: 'air' })]);
    expect(tiers[4]!.mode).toBe('air');
  });

  test('an inactive service is not offered at all', () => {
    // Not offered as unavailable: an inactive service is one commercial withdrew, and a
    // refused price invites somebody to ask why they cannot book it.
    const tiers = serviceTiers([...BUILT_IN_SERVICES, custom({ active: false })]);
    expect(tiers).toHaveLength(4);
    expect(tiers.some((t) => t.api === 'SURFACE-EXPRESS')).toBe(false);
  });

  test('deactivating a network withdraws that tier, and leaves the rest in order', () => {
    const withoutRail = BUILT_IN_SERVICES.map((s) =>
      s.key === 'rail' ? { ...s, active: false } : s,
    );
    expect(serviceTiers(withoutRail).map((t) => t.api)).toEqual(['ECONOMY', 'EXPRESS', 'CRITICAL']);
  });

  test('a renamed network keeps its API name but carries the new label', () => {
    // The name on the record is what a person reads; the API name is an address and must
    // not move under callers.
    const renamed = BUILT_IN_SERVICES.map((s) =>
      s.key === 'surface' ? { ...s, name: 'Road Standard' } : s,
    );
    const tier = serviceTiers(renamed)[0]!;
    expect(tier.api).toBe('ECONOMY');
    expect(tier.service.name).toBe('Road Standard');
  });

  test('a key that would shadow a network is refused when saved', () => {
    // `express` would derive EXPRESS and take air's name on the API: a caller would ask
    // for the tier it always has and be answered by a different price.
    expect(serviceIsValid(custom({ key: 'express', name: 'Impostor' }))).toContain('EXPRESS');
    expect(serviceIsValid(custom({ key: 'economy' }))).toContain('ECONOMY');
    expect(serviceIsValid(custom({ key: 'critical' }))).toContain('CRITICAL');
  });

  test('a network is still allowed to be itself', () => {
    for (const built of BUILT_IN_SERVICES) expect(serviceIsValid(built)).toBeNull();
  });

  test('a record that predates that check yields one tier, not two', () => {
    // Defence in depth: two tiers under one name is worse than a missing one, because a
    // caller reads the first and never learns the second existed.
    const impostor = custom({ key: 'express', name: 'Impostor' });
    const tiers = serviceTiers([...BUILT_IN_SERVICES, impostor]);
    expect(tiers.filter((t) => t.api === 'EXPRESS')).toHaveLength(1);
    expect(tiers.find((t) => t.api === 'EXPRESS')!.service.key).toBe('air');
  });

  test('nfo keeps its own mode, so the card multiplier still governs it', () => {
    // Handing the engine a service for nfo would override the card's tuned nfoMultiplier
    // with whatever sits on the record — a 1 nobody set deliberately.
    expect(serviceTiers(BUILT_IN_SERVICES).find((t) => t.api === 'CRITICAL')!.mode).toBe('nfo');
  });
});

describe('what the engine is handed for a service', () => {
  test('only the fields that were set are passed on', () => {
    const rules = serviceRules({
      key: 'x', name: 'X', mode: 'surface', active: true, multiplier: 1.4,
    });
    expect(rules).toEqual({ key: 'x', mode: 'surface', multiplier: 1.4 });
    expect('sacCode' in rules).toBe(false);
    expect('gstRate' in rules).toBe(false);
  });

  test('a tax classification travels with the service', () => {
    // Otherwise the SAC and GST fields would be editable on the screen and change nothing.
    const rules = serviceRules({
      key: 'x', name: 'X', mode: 'air', active: true, multiplier: 1,
      sacCode: '996812', gstRate: 0.18, transitAdjustmentDays: -1,
    });
    expect(rules.sacCode).toBe('996812');
    expect(rules.gstRate).toBe(0.18);
    expect(rules.transitAdjustmentDays).toBe(-1);
  });
});
