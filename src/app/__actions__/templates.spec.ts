import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signInAs, db, cleanup, closeDb, MARK, form, expectOk, reasonFrom, PEOPLE } from './harness';
import {
  createBlankTemplate,
  saveTemplateTerms,
  markTemplateParameters,
  assignTemplate,
  removeTemplate,
  createCatalogProduct,
  applyProduct,
  saveCustomerTags,
  lockTodaysPrices,
} from '../console-actions';
import { registerCustomer, findCustomer, contractedCard } from '../../data/customers';
import { findPincodePair } from '../../data/pincodes';
import { quote } from '../../pricing/quote';

/**
 * Templates and products — negotiated terms written once and applied to many.
 *
 * The property that matters is that applying either lands in the customer's **draft**, not
 * in live pricing. A template that skipped review would let one assignment move prices for
 * every customer it touched, without a single approval line.
 *
 * Two smaller rules are asserted because both are easy to get backwards. A blank answer to a
 * template parameter is **left blank rather than read as zero** — nobody agreed to zero. And
 * deleting a template does not disturb the contracts built from it, because the terms were
 * copied rather than referenced; what is lost is only the ability to say where they came
 * from, which is why the count goes into the audit entry.
 */

const CODE = `${MARK}-TEMPLATE`;
const TEMPLATE_NAME = `${MARK} Standard terms`;
const PRODUCT_NAME = `${MARK} Bundle`;
const BIND = 'grids.surface.minCharge.PNQ.NCR';

async function templateKey(name = TEMPLATE_NAME): Promise<string> {
  const doc = await (await db()).collection('rateTemplates').findOne({ name });
  if (!doc) throw new Error(`no template called ${name}`);
  return String((doc as unknown as { key: string }).key);
}

async function priceIt(): Promise<number> {
  const customer = await findCustomer(CODE);
  if (!customer) throw new Error(`${CODE} vanished mid-test`);
  const card = await contractedCard(customer);
  const { origin, destination } = await findPincodePair(411001, 110001);
  if (!origin || !destination) throw new Error('the probe lane is not serviceable');
  const priced = quote(
    { mode: 'surface', actualWeight: 5 },
    { origin, destination },
    card,
    undefined,
    customer.liveTerms.overrides,
    customer.liveTerms.laneRules,
  );
  if (!priced.available) throw new Error(`did not price: ${priced.reason}`);
  return priced.breakdown.total;
}

async function draftOverrides(): Promise<Record<string, unknown>> {
  const customer = (await findCustomer(CODE)) as unknown as {
    draftTerms?: { overrides?: Record<string, unknown> };
  } | null;
  return customer?.draftTerms?.overrides ?? {};
}

describe('templates', () => {
  let listPrice = 0;

  beforeAll(async () => {
    await cleanup();
    await signInAs('admin', 'admin');
    await registerCustomer({
      code: CODE,
      name: `${MARK} Template Co`,
      baseCardKey: 'model-1',
      source: 'manual',
      actor: PEOPLE.admin,
    });
    listPrice = await priceIt();
    expect(listPrice).toBeGreaterThan(0);
  });

  test('a template needs a name and a card', async () => {
    expect(reasonFrom(await createBlankTemplate(null, form({ name: '', baseCardKey: 'model-1' }))))
      .toMatch(/name/i);
    expect(reasonFrom(await createBlankTemplate(null, form({ name: 'x', baseCardKey: '' }))))
      .toMatch(/rate card/i);

    const count = await (await db()).collection('rateTemplates').countDocuments({ name: 'x' });
    expect(count, 'neither refusal wrote anything').toBe(0);
  });

  test('a blank template starts with nothing negotiated', async () => {
    expectOk(
      await createBlankTemplate(
        null,
        form({ name: TEMPLATE_NAME, description: 'for the tests', baseCardKey: 'model-1' }),
      ),
      'creating the template',
    );

    const doc = await (await db()).collection('rateTemplates').findOne({ name: TEMPLATE_NAME });
    expect(doc, 'the template exists').not.toBeNull();
    expect(
      Object.keys((doc as unknown as { overrides?: Record<string, unknown> }).overrides ?? {}),
      'a template assigned in this state changes no price',
    ).toHaveLength(0);
  });

  test('terms can be written into it', async () => {
    expectOk(
      await saveTemplateTerms(await templateKey(), [{ bind: BIND, value: 410 }]),
      'saving template terms',
    );
    const doc = await (await db()).collection('rateTemplates').findOne({ name: TEMPLATE_NAME });
    expect(
      (doc as unknown as { overrides: Record<string, unknown> }).overrides[BIND],
    ).toBe(410);
  });

  test('a parameter can be declared', async () => {
    expectOk(await markTemplateParameters(await templateKey(), [BIND]), 'declaring a parameter');
    const doc = await (await db()).collection('rateTemplates').findOne({ name: TEMPLATE_NAME });
    expect((doc as unknown as { parameters?: string[] }).parameters).toContain(BIND);
  });

  test('assigning it lands in the draft and does not move live pricing', async () => {
    expectOk(
      await assignTemplate(
        null,
        form({
          templateKey: await templateKey(),
          customerCode: CODE,
          mode: 'fill-gaps',
          [`answer:${BIND}`]: 390,
        }),
      ),
      'assigning the template',
    );

    expect(await draftOverrides(), 'the answer is in the draft').toHaveProperty(BIND, 390);
    expect(await priceIt(), 'and live pricing has not moved').toBe(listPrice);
  });

  test('deleting a template is admin-only and reports what was built from it', async () => {
    const key = await templateKey();

    await signInAs('configurator', 'configurator');
    let refused = false;
    try {
      refused = Boolean(reasonFrom(await removeTemplate(key)));
    } catch {
      refused = true;
    }
    expect(refused, 'deleting needs manage-users').toBe(true);
    expect(
      await (await db()).collection('rateTemplates').countDocuments({ name: TEMPLATE_NAME }),
      'and the template survives',
    ).toBe(1);

    await signInAs('admin', 'admin');
    const outcome = await removeTemplate(key);
    expectOk(outcome, 'deleting as admin');
    expect(
      (outcome as unknown as { builtFrom?: number }).builtFrom,
      'the count is reported, because nothing else knows it afterwards',
    ).toBeDefined();

    expect(
      await (await db()).collection('rateTemplates').countDocuments({ name: TEMPLATE_NAME }),
    ).toBe(0);
  });

  /**
   * Deleting the template does not disturb what was built from it.
   *
   * The terms were **copied** into the customer's draft rather than referenced, so the
   * assignment survives its template. What is lost is the ability to say where those numbers
   * came from, which is why the count goes into the audit entry — nothing else knows it
   * afterwards.
   */
  test('and the contract built from it survives the deletion', async () => {
    expect(
      Object.keys(await draftOverrides()).length,
      'the assignment is still there after the template went',
    ).toBeGreaterThan(0);
    expect(await priceIt(), 'and live pricing was never involved').toBe(listPrice);
  });

  /** Nobody agreed to zero. */
  test('a blank answer is skipped rather than read as zero', async () => {
    const other = `${MARK} Second terms`;
    expectOk(
      await createBlankTemplate(null, form({ name: other, description: '', baseCardKey: 'model-1' })),
      'creating the second template',
    );
    const key = await templateKey(other);
    expectOk(await saveTemplateTerms(key, [{ bind: BIND, value: 400 }]), 'terms');
    expectOk(await markTemplateParameters(key, [BIND]), 'parameter');

    const before = await draftOverrides();
    expectOk(
      await assignTemplate(
        null,
        form({ templateKey: key, customerCode: CODE, mode: 'replace', [`answer:${BIND}`]: '' }),
      ),
      'assigning with a blank answer',
    );

    const after = await draftOverrides();
    expect(after[BIND], 'a blank must not become zero').not.toBe(0);
    expect(
      after[BIND] === undefined || after[BIND] === before[BIND] || after[BIND] === 400,
      `a blank answer left ${JSON.stringify(after[BIND])}`,
    ).toBe(true);
  });
});

describe('products, tags and price locks', () => {
  beforeAll(async () => {
    await signInAs('admin', 'admin');
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  /**
   * A product may name a template that does not exist yet; applying it may not.
   *
   * Creation is deliberately permissive — a product can be catalogued before the template it
   * will price from is written — and the strictness is at the point of use, where the error
   * can say what is actually wrong. I expected the refusal at creation and was wrong; the
   * behaviour is better than the one I assumed, so the test asserts it rather than changing
   * it. What must not happen is a silent application that writes nothing.
   */
  test('a product may reference a template that does not exist yet', async () => {
    expectOk(
      await createCatalogProduct({
        name: PRODUCT_NAME,
        description: 'test bundle',
        templateKey: `${MARK}-nosuch-template`,
        charges: [],
        modes: ['surface'],
        segment: `${MARK}-segment`,
      }),
      'cataloguing the product',
    );

    const stored = await (await db()).collection('products').findOne({ name: PRODUCT_NAME });
    expect(stored).not.toBeNull();
  });

  test('but applying it is refused, naming the missing template', async () => {
    const product = (await (await db())
      .collection('products')
      .findOne({ name: PRODUCT_NAME })) as unknown as { key: string };

    const outcome = await applyProduct(
      null,
      form({ productKey: product.key, customerCode: CODE, mode: 'fill-gaps' }),
    );
    expect(reasonFrom(outcome), 'the refusal has to name the template').toMatch(
      /does not exist|not found/i,
    );
  });

  test('a product with no name is refused', async () => {
    const outcome = await createCatalogProduct({
      name: '',
      description: '',
      templateKey: 'anything',
      charges: [],
      modes: ['surface'],
      segment: '',
    });
    expect(reasonFrom(outcome)).toMatch(/name/i);
  });

  test('tags are stored, and are what an offer can target', async () => {
    expectOk(await saveCustomerTags(CODE, [`${MARK}-tag`, 'priority']), 'saving tags');
    const customer = (await findCustomer(CODE)) as unknown as { tags?: string[] } | null;
    expect(customer?.tags).toContain(`${MARK}-tag`);
    expect(customer?.tags).toContain('priority');
  });

  test('tags can be cleared', async () => {
    expectOk(await saveCustomerTags(CODE, []), 'clearing tags');
    const customer = (await findCustomer(CODE)) as unknown as { tags?: string[] } | null;
    expect(customer?.tags ?? []).toHaveLength(0);
  });

  /**
   * A price lock freezes today's prices into the customer's own terms.
   *
   * It writes overrides rather than a flag, so what is locked is the number rather than a
   * promise to remember one — and it lands in the draft like every other negotiation.
   */
  test('locking prices writes overrides into the draft, and unlocking removes them', async () => {
    const locked = await lockTodaysPrices(CODE, true);
    expectOk(locked, 'locking');
    const count = (locked as unknown as { locked?: number }).locked;
    expect(count, 'it reports how many cells were pinned').toBeGreaterThan(0);

    const customer = (await findCustomer(CODE)) as unknown as {
      draftTerms?: { priceLock?: unknown };
    } | null;
    expect(customer?.draftTerms?.priceLock, 'the lock is recorded on the draft').toBeTruthy();

    expectOk(await lockTodaysPrices(CODE, false), 'unlocking');
    const after = (await findCustomer(CODE)) as unknown as {
      draftTerms?: { priceLock?: unknown };
    } | null;
    expect(after?.draftTerms?.priceLock ?? null).toBeNull();
  });

  test('a viewer cannot lock prices', async () => {
    await signInAs('viewer', 'viewer');
    let refused = false;
    try {
      refused = Boolean(reasonFrom(await lockTodaysPrices(CODE, true)));
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    await signInAs('admin', 'admin');
  });
});
