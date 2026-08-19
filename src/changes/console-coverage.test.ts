import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffCardData } from './diff';
import { setByPath } from '../sheets/resolve';
import type { RateCard, RateCardData } from '../domain/types';

/**
 * The console can now edit transit times, per-zone cartage, the ODA matrix and the
 * zone names. Until it could, those four were reachable only from the sheet UI.
 *
 * The lesson recorded in the redesign roadmap is that anything able to change a price
 * must be *proved* to reach `diffCardData`, because the diff walks the sheet specs
 * rather than the data — a value with no spec entry produces no review line, reaches
 * live pricing unreviewed, and does so silently.
 *
 * These tests pin exactly that for each of the four. They also guard the specs
 * themselves: the sheet UI is being retired, and deleting `sheets/specs` along with it
 * would take the approval trail for these fields with it. If one of these fails, the
 * spec it depends on has gone.
 */

const card: RateCard = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'data', 'extracted', 'model-1.json'), 'utf8'),
);
const base = card.data;

const changeAt = (bind: string, value: string | number | null) =>
  diffCardData(base, setByPath<RateCardData>(base, bind, value));

describe('every console editor reaches the reviewer', () => {
  test('a transit time produces a review line', () => {
    const changes = changeAt('transitTimes.surface.PNQ.NCR', 9);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      bind: 'transitTimes.surface.PNQ.NCR',
      newValue: 9,
    });
    expect(changes[0]?.sheet).toBeTruthy();
  });

  test('a per-zone cartage value produces a review line', () => {
    const changes = changeAt('pickupDelivery.PNQ.pickupSurface', 450);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      bind: 'pickupDelivery.PNQ.pickupSurface',
      newValue: 450,
    });
  });

  test('an ODA matrix cell produces a review line', () => {
    const changes = changeAt('edlMatrix.rates.0.0', 600);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ bind: 'edlMatrix.rates.0.0', newValue: 600 });
  });

  test('the per-km rate beyond the last band produces a review line', () => {
    const changes = changeAt('edlMatrix.perKmBeyondLastBand', 16);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ bind: 'edlMatrix.perKmBeyondLastBand', newValue: 16 });
  });

  test('a zone name produces a review line', () => {
    const changes = changeAt('zones.surface.PNQ.belt', 'Pune belt');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      bind: 'zones.surface.PNQ.belt',
      newValue: 'Pune belt',
    });
  });

  test('clearing a transit time is reviewed, not silently dropped', () => {
    // Blank means the mode does not serve the lane, which is a serviceability change
    // and the most consequential edit these screens allow.
    const changes = changeAt('transitTimes.surface.PNQ.NCR', null);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.newValue).toBeNull();
  });
});
