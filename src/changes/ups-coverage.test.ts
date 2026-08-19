import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffCardData } from './diff';
import { setByPath } from '../sheets/resolve';
import type { RateCard, RateCardData } from '../domain/types';

/**
 * Proof that a UPS edit reaches an approver.
 *
 * The rule this system runs on: if it can change a price, prove it reaches `diffCardData`
 * with a test. The UPS tariff used to have no sheet specs, so the ordinary walk was blind
 * to it, and `ups-diff.ts` existed to produce its lines separately. The card has tabs now,
 * built from its own data in `sheets/specs/ups.ts`, so the walk covers it like any other
 * card — and these tests are what proved that before `ups-diff.ts` was removed. Running
 * both produced two lines for one edit, which an approver could decide differently on.
 *
 * Originally written against `ups-diff.ts` —
 * these are the tests that would fail if somebody made the card editable and forgot to
 * say so to the approval queue.
 *
 * Every case edits through `setByPath`, which is what the console actually writes with, so
 * a path that the editor can produce but the diff cannot see would fail here.
 */

const card: RateCard = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'ups.json'), 'utf8'),
);
const base: RateCardData = card.data;

const edit = (path: string, value: unknown) => setByPath(base, path, value);
const diff = (path: string, value: unknown) => diffCardData(base, edit(path, value));

describe('a UPS edit reaches the approval diff', () => {
  test('the fuel percentage — one number that moves every quote on the card', () => {
    const changes = diff('ups.params.fuelRate', 0.5);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      bind: 'ups.params.fuelRate',
      // The tab it is actually on. `ups-diff` used a synthetic name because the card had
      // no tabs; it has them now, so the change names the sheet like every other card.
      sheet: 'Params',
      oldValue: 0.4675,
      newValue: 0.5,
    });
    expect(changes[0]?.label.toLowerCase()).toContain('fuel surcharge');
  });

  test('the margin, the surge discount and GST', () => {
    expect(diff('ups.params.margin', 0.2)).toHaveLength(1);
    expect(diff('ups.params.surgeDiscount', 0.4)).toHaveLength(1);
    expect(diff('ups.params.gstRate', 0.12)).toHaveLength(1);
  });

  test('the volumetric divisor and the chargeable minimum', () => {
    expect(diff('ups.params.volumetricDivisor', 6000)).toHaveLength(1);
    expect(diff('ups.params.minChargeableWeight', 1)).toHaveLength(1);
  });

  test('a surge fee for one region', () => {
    const changes = diff('ups.surge.Europe', 120);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.label).toContain('Europe');
  });

  test('an envelope rate for one zone', () => {
    const changes = diff('ups.rates.envelope.Z1', 999);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.label).toContain('Envelope');
    expect(changes[0]?.label).toContain('Z1');
  });

  test('a package rate at one weight step, labelled by the step rather than its index', () => {
    // Row 19 is the 10 kg step. An approver reads "10 kg", never "19".
    const changes = diff('ups.rates.package.19.rates.Z1', 4000);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.label).toContain('10 kg');
    expect(changes[0]?.label).toContain('Z1');
    expect(changes[0]?.bind).toBe('ups.rates.package.19.rates.Z1');
  });

  test('a document rate', () => {
    const changes = diff('ups.rates.document.0.rates.Z3', 1500);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.label).toContain('Document');
  });

  test('a per-kilogram band rate', () => {
    const changes = diff('ups.rates.bulk.0.rates.Z1', 300);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.label).toContain('21-44 kgs');
    expect(changes[0]?.label).toContain('per kg');
  });

  test('a weight step boundary moving', () => {
    const changes = diff('ups.rates.package.19.toKg', 10.5);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.label).toContain('step boundary');
  });

  test('an accessorial minimum, its per-kg rate and its waiver', () => {
    expect(diff('ups.accessorials.0.minimum', 1500)).toHaveLength(1);
    expect(diff('ups.accessorials.16.perKg', 50)).toHaveLength(1);
    const waiver = diff('ups.accessorials.0.waiver', 0.5);
    expect(waiver).toHaveLength(1);
    expect(waiver[0]?.label).toContain('waiver');
  });

  test('a destination moving to another rate zone, which reprices it with no rate changing', () => {
    const changes = diff('ups.zones.AE', 'Z3');
    expect(changes).toHaveLength(1);
    expect(changes[0]?.label).toContain('rate zone');
    expect(changes[0]).toMatchObject({ oldValue: 'Z1', newValue: 'Z3' });
  });

  test('a destination moving to another surge region', () => {
    const changes = diff('ups.surgeRegions.AE', 'Europe');
    expect(changes).toHaveLength(1);
    expect(changes[0]?.label).toContain('surge region');
  });
});

describe('the diff is honest about what did not change', () => {
  test('an untouched card produces no lines at all', () => {
    expect(diffCardData(base, base)).toEqual([]);
  });

  test('writing the same value back is not a change', () => {
    expect(diff('ups.params.fuelRate', 0.4675)).toEqual([]);
    expect(diff('ups.rates.envelope.Z1', base.ups!.rates.envelope['Z1']!)).toEqual([]);
  });

  test('a percentage move is reported, so an approver sees the size of it', () => {
    const changes = diff('ups.params.fuelRate', 0.935);
    expect(changes[0]?.pctChange).toBeCloseTo(100, 6);
  });
});

describe('the edit itself is well formed', () => {
  test('a rate array is still an array after an edit', () => {
    // Otherwise the weight steps stop being a list and the engine cannot walk them.
    const after = edit('ups.rates.package.19.rates.Z1', 4000);
    expect(Array.isArray(after.ups?.rates.package)).toBe(true);
    expect(after.ups?.rates.package).toHaveLength(40);
    expect(after.ups?.rates.package[19]?.rates['Z1']).toBe(4000);
  });

  test('and every other step is untouched', () => {
    const after = edit('ups.rates.package.19.rates.Z1', 4000);
    expect(after.ups?.rates.package[18]).toBe(base.ups?.rates.package[18]);
  });
});
