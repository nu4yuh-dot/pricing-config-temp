import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, cleanup, closeDb, MARK, form, expectOk, reasonFrom } from './harness';
import {
  saveCarrierRecord,
  toggleCarrier,
  saveServiceRecord,
  removeService,
} from '../console-actions';

/**
 * Carriers and services — the two registries that decide what can be quoted at all.
 *
 * Both are data rather than code, which is the point: a new partner or a new service should
 * not need a deploy. The consequence is that a bad row is a live pricing problem, so the
 * validation is the feature and is asserted as such.
 *
 * The distinction that matters for services is between a **network** and a **configured
 * service**. The four networks are what the SameX core has always asked for by name, and its
 * contract is append-only — so a network cannot be deleted, and a request to delete one has
 * to be refused with a reason rather than silently ignored.
 */

const CARRIER = `${MARK.toLowerCase()}-carrier`;
const SERVICE = `${MARK.toLowerCase()}-service`;

async function carrier(): Promise<Record<string, unknown> | null> {
  return (await db()).collection('carriers').findOne({ carrierId: CARRIER }) as never;
}

describe('the carrier registry', () => {
  beforeAll(async () => {
    await cleanup();
    await signInAs('admin', 'admin');
  });

  afterAll(async () => {
    const d = await db();
    await d.collection('carriers').deleteMany({ carrierId: CARRIER });
    await d.collection('services').deleteMany({ key: SERVICE });
    await cleanup();
    await closeDb();
  });

  test('a carrier is stored with the fields it was given', async () => {
    expectOk(
      await saveCarrierRecord(
        null,
        form({
          carrierId: CARRIER,
          name: `${MARK} Test Carrier`,
          active: 'on',
          rateStructure: 'zoneWeight',
          contactEmail: 'ops@example.test',
          maxWeightKg: 1200,
          rateMultiplier: 1.15,
        }),
      ),
      'saving the carrier',
    );

    const stored = (await carrier()) as unknown as {
      name: string;
      active: boolean;
      maxWeightKg?: number;
      rateMultiplier?: number;
    } | null;
    expect(stored, 'the carrier is in the collection').not.toBeNull();
    expect(stored?.name).toBe(`${MARK} Test Carrier`);
    expect(stored?.active).toBe(true);
    expect(stored?.maxWeightKg, 'a numeric field is stored as a number').toBe(1200);
    expect(stored?.rateMultiplier).toBe(1.15);
  });

  test('a code that is not a slug is refused, and nothing is written', async () => {
    const outcome = await saveCarrierRecord(
      null,
      form({ carrierId: 'Not A Slug!', name: 'Rejected', rateStructure: 'zoneWeight' }),
    );
    expect(reasonFrom(outcome)).toMatch(/lower-case letters/i);

    const count = await (await db())
      .collection('carriers')
      .countDocuments({ name: 'Rejected' });
    expect(count).toBe(0);
  });

  test('a missing name is refused', async () => {
    const outcome = await saveCarrierRecord(null, form({ carrierId: `${CARRIER}-2`, name: '' }));
    expect(reasonFrom(outcome)).toMatch(/name/i);
  });

  /**
   * Saving again edits rather than duplicating, and keeps the cards attached.
   *
   * `cardKeys` is deliberately not in the form — a card is attached by loading a rate card
   * for the carrier — so a save that dropped it would silently detach every card the carrier
   * prices from, which is a quoting outage produced by editing a phone number.
   */
  test('saving the same code again edits it and keeps its attached cards', async () => {
    const before = (await carrier()) as unknown as { cardKeys?: unknown[] } | null;

    expectOk(
      await saveCarrierRecord(
        null,
        form({
          carrierId: CARRIER,
          name: `${MARK} Renamed Carrier`,
          active: 'on',
          rateStructure: 'zoneWeight',
        }),
      ),
      'the second save',
    );

    const count = await (await db()).collection('carriers').countDocuments({ carrierId: CARRIER });
    expect(count, 'an edit, not a duplicate').toBe(1);

    const after = (await carrier()) as unknown as { name: string; cardKeys?: unknown[] } | null;
    expect(after?.name).toBe(`${MARK} Renamed Carrier`);
    expect(after?.cardKeys, 'the attached cards survive an edit').toEqual(before?.cardKeys ?? []);
  });

  test('deactivating and reactivating both take effect', async () => {
    expectOk(await toggleCarrier(CARRIER, false), 'deactivating');
    expect(((await carrier()) as unknown as { active: boolean }).active).toBe(false);

    expectOk(await toggleCarrier(CARRIER, true), 'reactivating');
    expect(((await carrier()) as unknown as { active: boolean }).active).toBe(true);
  });

  test('a viewer can do neither', async () => {
    await signInAs('viewer', 'viewer');
    for (const attempt of [
      () => saveCarrierRecord(null, form({ carrierId: `${CARRIER}-x`, name: 'Nope' })),
      () => toggleCarrier(CARRIER, false),
    ]) {
      let refused = false;
      try {
        refused = Boolean(reasonFrom(await attempt()));
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    }
    expect(
      ((await carrier()) as unknown as { active: boolean }).active,
      'and the carrier is untouched',
    ).toBe(true);
    await signInAs('admin', 'admin');
  });
});

describe('the service registry', () => {
  beforeAll(async () => {
    await signInAs('admin', 'admin');
  });

  test('a configured service is stored', async () => {
    expectOk(
      await saveServiceRecord(
        null,
        form({
          key: SERVICE,
          name: `${MARK} Same Day`,
          network: 'surface',
          multiplier: 1.4,
          transitAdjustmentDays: -1,
          sac: '996812',
          gstRate: 0.18,
        }),
      ),
      'saving the service',
    );

    const stored = await (await db()).collection('services').findOne({ key: SERVICE });
    expect(stored, 'the service is in the collection').not.toBeNull();
    expect((stored as unknown as { name: string }).name).toBe(`${MARK} Same Day`);
  });

  test('a key that is not a slug is refused', async () => {
    const outcome = await saveServiceRecord(
      null,
      form({ key: 'Not Valid', name: 'Rejected service', network: 'surface' }),
    );
    expect(reasonFrom(outcome)).toMatch(/lower-case letters/i);
  });

  test('a missing name is refused', async () => {
    const outcome = await saveServiceRecord(null, form({ key: `${SERVICE}-2`, name: '' }));
    expect(reasonFrom(outcome)).toMatch(/name/i);
  });

  test('a configured service can be removed', async () => {
    expectOk(await removeService(SERVICE), 'removing the configured service');
    const stored = await (await db()).collection('services').findOne({ key: SERVICE });
    expect(stored).toBeNull();
  });

  /**
   * The four networks are the core's published tier names, and its contract is append-only.
   *
   * Deleting one would remove a name a caller is installed against, so it has to be refused
   * — and refused with a reason, because "nothing happened" is indistinguishable from a bug
   * to whoever pressed the button.
   */
  test('a built-in network cannot be deleted, and says why', async () => {
    for (const network of ['surface', 'air']) {
      const outcome = await removeService(network);
      expect(reasonFrom(outcome), `${network} must be protected`).not.toBe('');
    }
  });

  test('a viewer cannot save a service', async () => {
    await signInAs('viewer', 'viewer');
    let refused = false;
    try {
      refused = Boolean(
        reasonFrom(
          await saveServiceRecord(null, form({ key: `${SERVICE}-v`, name: 'Nope', network: 'surface' })),
        ),
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    await signInAs('admin', 'admin');
  });
});
