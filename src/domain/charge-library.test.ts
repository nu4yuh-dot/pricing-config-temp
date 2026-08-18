import { describe, test, expect } from 'vitest';
import { chargeLibrary, isBookableOneOff } from './charge-library';
import type { RateCardData } from './types';

const card = (charges: Record<string, unknown>) =>
  ({ charges: { docket: 100 }, settlementCharges: charges }) as unknown as RateCardData;

describe('the charge library', () => {
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
    const library = chargeLibrary([], [{ 'settlementCharges.site-levy.name': 'Site levy' }]);

    expect(library.find((entry) => entry.id === 'site-levy')?.name).toBe('Site levy');
  });

  test('usage is counted, so a heavily used charge is visibly worth keeping', () => {
    const library = chargeLibrary(
      [card({ 'green-tax': { active: 'Yes' } })],
      [
        { 'settlementCharges.green-tax.amount': 90 },
        { 'settlementCharges.green-tax.amount': 75 },
        { 'settlementCharges.handling.amount': 60 },
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
      { 'settlementCharges.handling.amount': 60 },
      { 'settlementCharges.handling.amount': 60 },
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
