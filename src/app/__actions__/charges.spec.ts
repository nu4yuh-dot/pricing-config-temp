import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  signInAs, db, closeDb, MARK, expectOk, reasonFrom,
  snapshotCard, restoreCard, type CardSnapshot,
} from './harness';
import { editChargeEverywhere } from '../console-actions';
import { draftVersion } from '../../data/rate-cards';

/**
 * Editing one charge across the cards that carry it.
 *
 * The charge library is derived, so a row in it is five separate per-card cell sets. This
 * asserts the edit lands on exactly the cards asked for and nowhere else — and that it lands
 * in the **draft**, because a charge definition reaching live pricing without a review would
 * defeat the point of the approval gate.
 */
const CARDS = ['model-1', 'model-2', 'model-3'] as const;
const CHARGE = 'handling';

async function stored(cardKey: string): Promise<Record<string, unknown>> {
  const draft = await draftVersion(cardKey);
  const catalog = (draft.data as unknown as {
    chargeCatalog?: Record<string, Record<string, unknown>>;
  }).chargeCatalog ?? {};
  return catalog[CHARGE] ?? {};
}

describe('editing a charge across cards', () => {
  const snaps: Record<string, CardSnapshot | null> = {};

  beforeAll(async () => {
    await signInAs('admin', 'admin');
    for (const key of CARDS) snaps[key] = await snapshotCard(key);
  });

  afterAll(async () => {
    for (const key of CARDS) await restoreCard(snaps[key] ?? null);
    await closeDb();
  });

  test('an edit lands on exactly the cards named', async () => {
    const outcome = await editChargeEverywhere({
      chargeId: CHARGE,
      cardKeys: ['model-1', 'model-2'],
      name: `${MARK} Handling`,
      gstApplies: false,
      fuelApplies: true,
      bookableOneOff: true,
    });
    expectOk(outcome, 'the cross-card edit');
    expect((outcome as unknown as { changed: string[] }).changed).toEqual(['model-1', 'model-2']);

    for (const key of ['model-1', 'model-2']) {
      const charge = await stored(key);
      expect(charge.name, `${key} name`).toBe(`${MARK} Handling`);
      // Flags are stored as the word, which is what every other editor writes.
      expect(charge.gstApplies, `${key} gst`).toBe('No');
      expect(charge.fuelApplies, `${key} fuel`).toBe('Yes');
      expect(charge.bookableOneOff, `${key} one-off`).toBe('Yes');
    }
  });

  test('and not on the card that was left out', async () => {
    expect((await stored('model-3')).name).not.toBe(`${MARK} Handling`);
  });

  test('it lands in the draft, never in live pricing', async () => {
    const d = await db();
    const card = await d.collection('rateCards').findOne({ key: 'model-1' });
    const live = await d.collection('rateCardVersions').findOne({ _id: card!.liveVersionId });
    const catalog = (live as unknown as {
      data: { chargeCatalog?: Record<string, { name?: string }> };
    }).data.chargeCatalog ?? {};
    expect(catalog[CHARGE]?.name, 'live must not have moved').not.toBe(`${MARK} Handling`);
  });

  test('no cards is refused rather than treated as all of them', async () => {
    const outcome = await editChargeEverywhere({ chargeId: CHARGE, cardKeys: [], name: 'X' });
    expect(reasonFrom(outcome)).toMatch(/at least one card/i);
  });

  test('an empty name is refused — it is what appears on the invoice', async () => {
    const outcome = await editChargeEverywhere({
      chargeId: CHARGE,
      cardKeys: ['model-1'],
      name: '   ',
    });
    expect(reasonFrom(outcome)).toMatch(/needs a name/i);
  });

  test('an edit that changes nothing is refused', async () => {
    const outcome = await editChargeEverywhere({ chargeId: CHARGE, cardKeys: ['model-1'] });
    expect(reasonFrom(outcome)).toMatch(/nothing was changed/i);
  });

  test('a viewer cannot do it', async () => {
    await signInAs('viewer', 'viewer');
    let refused = false;
    try {
      refused = Boolean(
        reasonFrom(
          await editChargeEverywhere({ chargeId: CHARGE, cardKeys: ['model-3'], name: 'Nope' }),
        ),
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect((await stored('model-3')).name).not.toBe('Nope');
    await signInAs('admin', 'admin');
  });
});
