import { describe, expect, test } from 'vitest';
import { diffUpsZoneAccessorials } from './ups-zone-diff';
import type { RateCardData } from '../domain/types';
import type { UpsAccessorial } from '../domain/ups';

const charge = (over: Partial<UpsAccessorial> = {}): UpsAccessorial => ({
  id: 'additional-handling-charge',
  name: 'Additional Handling Charge',
  unit: 'Package',
  minimum: 1350,
  perKg: 0,
  waiver: 1,
  appliesByDefault: false,
  ...over,
});

const card = (accessorials: UpsAccessorial[]): RateCardData =>
  ({ ups: { accessorials } }) as unknown as RateCardData;

describe('per-zone accessorial rates reaching the approval queue', () => {
  test('a card with no zone rates produces no lines', () => {
    const same = card([charge()]);
    expect(diffUpsZoneAccessorials(same, same)).toEqual([]);
  });

  test('a new zone rate is reported, with the card value as what it was', () => {
    const changes = diffUpsZoneAccessorials(
      card([charge()]),
      card([charge({ byZone: { Z5: { minimum: 1850 } } })]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.label).toBe('Additional Handling Charge · Z5 · minimum');
    expect(changes[0]!.bind).toBe('ups.accessorials.0.byZone.Z5.minimum');
    expect(changes[0]!.cellRef).toBe('additional-handling-charge/Z5');
    expect(changes[0]!.oldValue).toBeNull();
    expect(changes[0]!.newValue).toBe(1850);
  });

  test('removing a zone rate is reported too, so a reviewer sees it go back to the card', () => {
    const changes = diffUpsZoneAccessorials(
      card([charge({ byZone: { Z5: { minimum: 1850 } } })]),
      card([charge()]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.oldValue).toBe(1850);
    expect(changes[0]!.newValue).toBeNull();
  });

  test('a cleared cell reads as following the card, not as a rate of zero', () => {
    // A waiver of 0 waives nothing; a waiver that was never set follows the card. Reporting
    // the first as the second is how a charge gets given away.
    const changes = diffUpsZoneAccessorials(
      card([charge({ byZone: { Z5: { waiver: 0 } } })]),
      card([charge({ byZone: { Z5: { waiver: null as unknown as number } } })]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.oldValue).toBe(0);
    expect(changes[0]!.newValue).toBeNull();
  });

  test('every zone and every rate that moved gets its own line', () => {
    const changes = diffUpsZoneAccessorials(
      card([charge({ byZone: { Z5: { minimum: 1850 } } })]),
      card([charge({ byZone: { Z5: { minimum: 1900, waiver: 0.5 }, Z9: { perKg: 41 } } })]),
    );
    expect(changes.map((c) => c.label)).toEqual([
      'Additional Handling Charge · Z5 · minimum',
      'Additional Handling Charge · Z5 · waiver',
      'Additional Handling Charge · Z9 · per kg',
    ]);
  });

  test('a percentage is offered where one is meaningful', () => {
    const [line] = diffUpsZoneAccessorials(
      card([charge({ byZone: { Z5: { minimum: 1000 } } })]),
      card([charge({ byZone: { Z5: { minimum: 1250 } } })]),
    );
    expect(line!.pctChange).toBeCloseTo(25, 5);
  });

  test('charges are matched by id, not by position', () => {
    // The accessorial list is rebuilt from the workbook. Comparing index to index across a
    // rebuild would report one charge's rate as another's.
    const other = charge({ id: 'carbon-neutral', name: 'Carbon Neutral', minimum: 50 });
    const changes = diffUpsZoneAccessorials(
      card([charge(), other]),
      card([other, charge({ byZone: { Z5: { minimum: 1850 } } })]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.label).toContain('Additional Handling Charge');
    expect(changes[0]!.bind).toBe('ups.accessorials.1.byZone.Z5.minimum');
  });

  test('a card that is not the UPS card is left alone', () => {
    const plain = {} as RateCardData;
    expect(diffUpsZoneAccessorials(plain, plain)).toEqual([]);
  });
});
