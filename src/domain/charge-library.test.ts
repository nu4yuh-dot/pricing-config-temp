import { describe, test, expect } from 'vitest';
import { chargesFrom } from '../pricing/card-config';
import { chargeLibrary, isBookableOneOff } from './charge-library';
import type { RateCardData } from './types';

const card = (charges: Record<string, unknown>) =>
  ({ charges: { docket: 100 }, chargeCatalog: charges }) as unknown as RateCardData;

describe('the charge library', () => {

  test('the library reads the same field the engine prices from', () => {
    // These were two names for one thing: the library read `settlementCharges` while
    // `chargesFrom` in pricing/card-config.ts reads `chargeCatalog`. Nothing was stored
    // under the first, so every charge reported "not used" while being configured on
    // every card, and a charge defined through the library could never be priced or
    // switched on. The old tests asserted the wrong name too, which is why it survived.
    const data = card({ 'site-levy': { name: 'Site levy', basis: 'per-shipment' } });
    expect(chargesFrom(data).some((entry) => entry.id === 'site-levy')).toBe(true);
    expect(chargeLibrary([data], []).some((entry) => entry.id === 'site-levy')).toBe(true);
  });
  test('the standard charges are always in it, even when nobody has used one', () => {
    const names = chargeLibrary([], []).map((entry) => entry.id);

    expect(names).toContain('docket');
    expect(names).toContain('green-tax');
  });

  test('a charge a card invented of its own is in the library too', () => {
    const library = chargeLibrary([card({ demurrage: { name: 'Demurrage', amount: 500 } })], []);
    const found = library.find((entry) => entry.id === 'demurrage');

    expect(found?.name).toBe('Demurrage');
  });

  test('a charge a contract invented is in the library, so the next contract can reuse it', () => {
    const library = chargeLibrary([], [{ 'chargeCatalog.site-levy.name': 'Site levy' }]);

    expect(library.find((entry) => entry.id === 'site-levy')?.name).toBe('Site levy');
  });

  test('usage is counted, so a heavily used charge is visibly worth keeping', () => {
    const library = chargeLibrary(
      [card({ 'green-tax': { active: 'Yes' } })],
      [
        { 'chargeCatalog.green-tax.amount': 90 },
        { 'chargeCatalog.green-tax.amount': 75 },
        { 'chargeCatalog.handling.amount': 60 },
      ],
    );

    expect(library.find((entry) => entry.id === 'green-tax')?.usedBy).toBe(3);
    expect(library.find((entry) => entry.id === 'handling')?.usedBy).toBe(1);
  });

  test('a standard charge nobody uses is listed with no users rather than hidden', () => {
    expect(chargeLibrary([], []).find((entry) => entry.id === 'handling')?.usedBy).toBe(0);
  });

  test('the most used charges come first, because that is the reuse the library is for', () => {
    const library = chargeLibrary([], [
      { 'chargeCatalog.handling.amount': 60 },
      { 'chargeCatalog.handling.amount': 60 },
    ]);

    expect(library[0]?.id).toBe('handling');
  });

  test('a definition carries the treatment a charge is billed under', () => {
    const green = chargeLibrary([], []).find((entry) => entry.id === 'green-tax');

    expect(green).toMatchObject({ basis: 'per-shipment', gstApplies: true });
  });
});

describe('which charges an operator may add to one booking', () => {
  test('a charge is bookable one-off only when it says so', () => {
    expect(isBookableOneOff({ basis: 'per-shipment', bookableOneOff: true })).toBe(true);
    expect(isBookableOneOff({ basis: 'per-shipment' })).toBe(false);
  });

  test('a per-destination charge is never bookable one-off — it has no single amount', () => {
    expect(isBookableOneOff({ basis: 'per-destination', bookableOneOff: true })).toBe(false);
  });

  test('a by-pincode charge is never bookable one-off — the distance decides it', () => {
    expect(isBookableOneOff({ basis: 'by-pincode', bookableOneOff: true })).toBe(false);
  });

  test('a whole library entry can be asked directly, which is how callers will use it', () => {
    const green = chargeLibrary([], []).find((entry) => entry.id === 'green-tax');
    if (!green) throw new Error('expected green-tax in the library');
    expect(isBookableOneOff(green)).toBe(false);
  });

});

/**
 * The one-off flag, read out of what is actually stored.
 *
 * A cell holds the word — `'Yes'` — because that is what the grid editors and the source
 * workbooks write. `chargeLibrary` never read the field at all, and `isBookableOneOff`
 * compared it against `true`, so the library reported **every** charge as "standing term
 * only" no matter what had been configured. A charge created as bookable at a booking had
 * never once been offered at one.
 */
describe('bookableOneOff, as it is really stored', () => {
  const card = (charge: Record<string, unknown>) => ({
    chargeCatalog: { levy: { name: 'Site levy', basis: 'per-shipment', ...charge } },
  }) as never;

  test('the stored word Yes makes a charge bookable', () => {
    const [levy] = chargeLibrary([card({ bookableOneOff: 'Yes' })], []).filter((c) => c.id === 'levy');
    expect(levy?.bookableOneOff).toBe(true);
    expect(isBookableOneOff(levy!)).toBe(true);
  });

  test('No, and an absent flag, both mean standing term only', () => {
    const [no] = chargeLibrary([card({ bookableOneOff: 'No' })], []).filter((c) => c.id === 'levy');
    expect(isBookableOneOff(no!)).toBe(false);
    const [absent] = chargeLibrary([card({})], []).filter((c) => c.id === 'levy');
    expect(isBookableOneOff(absent!)).toBe(false);
  });

  test('a real boolean still works, since the API posts one', () => {
    const [levy] = chargeLibrary([card({ bookableOneOff: true })], []).filter((c) => c.id === 'levy');
    expect(isBookableOneOff(levy!)).toBe(true);
  });

  /** Bookable on any card is bookable: an operator can reach it. */
  test('one card offering it is enough, whatever order the cards arrive in', () => {
    const off = card({ bookableOneOff: 'No' });
    const on = card({ bookableOneOff: 'Yes' });
    for (const cards of [[off, on], [on, off]]) {
      const [levy] = chargeLibrary(cards, []).filter((c) => c.id === 'levy');
      expect(isBookableOneOff(levy!), 'order must not decide it').toBe(true);
    }
  });

  test('a contract that declares it bookable counts too', () => {
    const [levy] = chargeLibrary([], [
      { 'chargeCatalog.levy.name': 'Site levy', 'chargeCatalog.levy.bookableOneOff': 'Yes' },
    ]).filter((c) => c.id === 'levy');
    expect(isBookableOneOff({ ...levy!, basis: 'per-shipment' })).toBe(true);
  });

  /** The basis still overrules the flag — that rule was already right. */
  test('a per-destination charge is never bookable, however it is flagged', () => {
    const [ess] = chargeLibrary([
      { chargeCatalog: { ess: { name: 'ESS', basis: 'per-destination', bookableOneOff: 'Yes' } } } as never,
    ], []).filter((c) => c.id === 'ess');
    expect(ess?.bookableOneOff).toBe(true);
    expect(isBookableOneOff(ess!), 'no single amount to ask for at a counter').toBe(false);
  });
});
