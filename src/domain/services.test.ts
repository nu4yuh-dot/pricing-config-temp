import { describe, expect, test } from 'vitest';
import {
  BUILT_IN_SERVICES,
  serviceIsValid,
  serviceForMode,
  applyServiceMultiplier,
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
