import { describe, expect, test } from 'vitest';
import {
  mayUseCarrier,
  carrierRefusedMessage,
  carrierName,
  SOURCE_CARRIERS,
} from './carrier-access';
import type { CustomerDoc } from '../data/customers';

const customer = (carrierAccess?: Record<string, boolean>): CustomerDoc =>
  ({ code: 'MAHLE', name: 'Mahle Anand Filter Systems', ...(carrierAccess ? { carrierAccess } : {}) }) as CustomerDoc;

describe('which carriers a customer may be quoted', () => {
  test('our own network is never gated, whatever access says', () => {
    // It is not a partner they opt into; it is the thing they signed up for. A customer
    // locked out of it could not be quoted at all.
    expect(mayUseCarrier(customer({ own: false }), 'own')).toBe(true);
    expect(mayUseCarrier(customer({}), 'own')).toBe(true);
  });

  test('a partner switched on is allowed', () => {
    expect(mayUseCarrier(customer({ bluedart: true }), 'bluedart')).toBe(true);
  });

  test('a partner switched off is refused', () => {
    expect(mayUseCarrier(customer({ bluedart: false }), 'bluedart')).toBe(false);
  });

  test('a partner not mentioned at all is refused, not permitted', () => {
    // Absent access is a refusal. The core grandfathers some accounts, but that is their
    // decision about their data — guessing it here would have two systems disagreeing
    // about who may book what, and ours would be the one guessing.
    expect(mayUseCarrier(customer({ velocity: true }), 'bluedart')).toBe(false);
  });

  test('a customer with no access record at all is allowed, so nothing breaks before the core sets one', () => {
    // The distinction that matters: no record means the core has not told us yet, whereas
    // an empty record means it has and the answer is no.
    expect(mayUseCarrier(customer(), 'bluedart')).toBe(true);
    expect(mayUseCarrier(customer({}), 'bluedart')).toBe(false);
  });

  test('an anonymous quote is allowed, because the book rate is public', () => {
    expect(mayUseCarrier(null, 'bluedart')).toBe(true);
    expect(mayUseCarrier(null, 'ups')).toBe(true);
  });
});

describe('mapping a card to the carrier it prices', () => {
  test('every card source this system holds maps to a carrier', () => {
    expect(SOURCE_CARRIERS.dns).toBe('own');
    expect(SOURCE_CARRIERS.bluedart).toBe('bluedart');
    expect(SOURCE_CARRIERS.ups).toBe('ups');
  });

  test('the DNS source maps to the one name that is never gated', () => {
    // If these two ever disagreed, every customer would be refused their own network.
    expect(mayUseCarrier(customer({}), SOURCE_CARRIERS.dns!)).toBe(true);
  });
});

describe('what the caller is told', () => {
  test('it names the account, the carrier, and who can change it', () => {
    const message = carrierRefusedMessage('Mahle Anand Filter Systems', 'Bluedart');
    expect(message).toContain('Mahle Anand Filter Systems');
    expect(message).toContain('Bluedart');
    // Without this the caller knows they are blocked and not what to do about it.
    expect(message).toContain('SameX admin');
  });
});

describe('what a carrier is called in a refusal', () => {
  test('every source maps to a name fit for a sentence', () => {
    // A card is named for what it is — "Bluedart — franchise, directional zones" — which
    // reads badly in "X is not enabled for …". These are the names for that sentence.
    for (const source of Object.keys(SOURCE_CARRIERS)) {
      const name = carrierName(SOURCE_CARRIERS[source]!);
      expect(name).not.toContain('—');
      expect(name.length).toBeGreaterThan(0);
    }
    expect(carrierName('bluedart')).toBe('Bluedart');
    expect(carrierName('ups')).toBe('UPS / MOVIN');
  });

  test('an unknown carrier is named as itself rather than as blank', () => {
    // A refusal that names nothing is worse than one naming a code somebody can look up.
    expect(carrierName('some-new-partner')).toBe('some-new-partner');
  });
});
