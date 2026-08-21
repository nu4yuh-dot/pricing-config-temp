/**
 * Does each configurable thing actually change a price?
 *
 * Not "is it saved", and not "does the screen render" — does it reach the number. A setting
 * that can be edited and has no observable effect is broken however good it looks, and that
 * failure is invisible to every other check here: the unit tests pass, the page renders, the
 * value is stored, and the price does not move.
 *
 * It found a real one. Offers were applied by `GET /api/v1/network/quotes` and by nothing
 * else, so an offer created and assigned in the console changed no price on the endpoint the
 * core actually calls, and none in the calculator — which is the screen somebody would use to
 * check that the offer worked.
 *
 * Each probe changes one thing, re-prices, and puts it back. A `NO EFFECT` line is either a
 * bug or a deliberately superseded field; the three below are the latter and say so.
 *
 *   npm run verify:effects
 *
 * Needs a database with a customer and a live card. Never point it at production: it mutates
 * and restores, and a crash between the two would leave a card edited.
 */
import { db, COLLECTIONS } from '../src/data/mongo';
import { findCustomer, contractedCard, baseCardFor } from '../src/data/customers';
import { findPincodePair } from '../src/data/pincodes';
import { quote } from '../src/pricing/quote';
import { offersFor } from '../src/data/offers';

const CODE = 'MAHLE';

async function priceNow() {
  const c = (await findCustomer(CODE))!;
  const card = await contractedCard(c);
  const { origin, destination } = (await findPincodePair(110001, 400001))!;
  const offers = await offersFor({
    at: new Date(), customerCode: CODE,
    ...(c.tags ? { tags: c.tags } : {}),
    ...(c.appliedProduct ? { productKey: c.appliedProduct.key } : {}),
  });
  const r = quote({ mode: 'surface', actualWeight: 500 }, { origin, destination }, card,
    c.commercial ? { gstApplicable: c.commercial.gstApplicable } as never : undefined,
    c.liveTerms.overrides, c.liveTerms.laneRules, offers);
  if (!r.available) throw new Error('not priced: ' + r.reason);
  const b = r.breakdown;
  return { freight: b.freight, fuel: b.fuel, pickup: b.pickup, delivery: b.delivery,
           docket: b.docket, oda: b.pickupOda + b.deliveryOda, gst: b.gst, total: b.total,
           transit: b.transitDays, sac: b.tax.sac, charges: b.charges.length };
}

const results: string[] = [];
async function probe(what: string, mutate: () => Promise<void>, undo: () => Promise<void>, field: keyof Awaited<ReturnType<typeof priceNow>> = 'total') {
  const before = await priceNow();
  let after;
  try {
    await mutate();
    after = await priceNow();
  } catch (e) {
    await undo();
    results.push(`  ERROR     ${what.padEnd(34)} ${(e as Error).message}`);
    return;
  }
  await undo();
  const back = await priceNow();
  const moved = JSON.stringify(before[field]) !== JSON.stringify(after[field]);
  const restored = JSON.stringify(before[field]) === JSON.stringify(back[field]);
  results.push(`  ${moved ? 'AFFECTS  ' : 'NO EFFECT'} ${what.padEnd(34)} ${field}: ${before[field]} -> ${after[field]}${restored ? '' : '  (NOT RESTORED)'}`);
}

async function main() {
  const d = await db();
  const cust = d.collection(COLLECTIONS.customers);
  const versions = d.collection(COLLECTIONS.rateCardVersions);
  const c = (await findCustomer(CODE))!;
  const card = await baseCardFor(c);
  const liveId = (await d.collection(COLLECTIONS.rateCards).findOne({ key: card.key }))!.liveVersionId;
  const orig = JSON.parse(JSON.stringify((await versions.findOne({ _id: liveId }))!.data));
  const setCard = async (patch: (data: Record<string, unknown>) => void): Promise<void> => {
    const copy = JSON.parse(JSON.stringify(orig)) as Record<string, unknown>;
    patch(copy);
    await versions.updateOne({ _id: liveId }, { $set: { data: copy } });
  };
  const resetCard = async (): Promise<void> => {
    await versions.updateOne({ _id: liveId }, { $set: { data: orig } });
  };

  console.log('baseline:', JSON.stringify(await priceNow()));
  console.log('');

  await probe('card: fuel rate', () => setCard((d: Record<string, unknown>) => { (d as unknown as {charges:{fuelSurface:number}}).charges.fuelSurface = 0.9; }), resetCard, 'fuel');
  await probe('card: docket', () => setCard((d: Record<string, unknown>) => { (d as unknown as {charges:{docket:number}}).charges.docket = 999; }), resetCard, 'docket');
  await probe('card: pickup/delivery', () => setCard((d: Record<string, unknown>) => {
    const pd=(d as unknown as {pickupDelivery:Record<string,Record<string,number>>}).pickupDelivery;
    for (const z of Object.keys(pd)) { pd[z]!.pickupSurface = 4321; }
  }), resetCard, 'pickup');
  await probe('card: GST rate', () => setCard((d: Record<string, unknown>) => { (d as unknown as {charges:{gstSurface:number}}).charges.gstSurface = 0.28; }), resetCard, 'gst');
  await probe('card: transit times', () => setCard((d: Record<string, unknown>) => {
    const t=(d as unknown as {transitTimes:Record<string,Record<string,Record<string,number>>>}).transitTimes;
    for (const z of Object.keys(t.surface ?? {})) for (const z2 of Object.keys(t.surface![z]!)) t.surface![z]![z2] = 99;
  }), resetCard, 'transit');
  await probe('card: grid rate (tier1)', () => setCard((d: Record<string, unknown>) => {
    // grids.surface is keyed tier -> origin -> destination.
    const g=(d as unknown as {grids:{surface:Record<string,Record<string,Record<string,number>>>}}).grids;
    for (const o of Object.keys(g.surface.tier1 ?? {}))
      for (const dd of Object.keys(g.surface.tier1![o]!)) g.surface.tier1![o]![dd] = 999;
  }), resetCard, 'freight');
  await probe('card: minimum charge', () => setCard((d: Record<string, unknown>) => {
    const g=(d as unknown as {grids:{surface:Record<string,Record<string,Record<string,number>>>}}).grids;
    for (const o of Object.keys(g.surface.minCharge ?? {}))
      for (const dd of Object.keys(g.surface.minCharge![o]!)) g.surface.minCharge![o]![dd] = 5000;
  }), resetCard, 'freight');

  // Overrides are a flat map of DOTTED PATHS, so the key must be quoted as one key.
  await probe('customer: charge override',
    () => cust.updateOne({ code: CODE }, { $set: { 'liveTerms.overrides': { ...c.liveTerms.overrides, 'charges.docket': 777 } } }).then(() => undefined),
    () => cust.updateOne({ code: CODE }, { $set: { 'liveTerms.overrides': c.liveTerms.overrides } }).then(() => undefined),
    'docket');
  await probe('customer: lane rate override',
    () => cust.updateOne({ code: CODE }, { $set: { 'liveTerms.overrides': { ...c.liveTerms.overrides, 'grids.surface.tier1.NCR.BOM': 88 } } }).then(() => undefined),
    () => cust.updateOne({ code: CODE }, { $set: { 'liveTerms.overrides': c.liveTerms.overrides } }).then(() => undefined),
    'freight');
  await probe('charge library: docket amount', () => setCard((d: Record<string, unknown>) => {
    const cat=(d as unknown as {chargeCatalog:Record<string,{amount:number}>}).chargeCatalog;
    if (cat.docket) cat.docket.amount = 999;
  }), resetCard, 'docket');
  await probe('charge library: deactivate docket', () => setCard((d: Record<string, unknown>) => {
    const cat=(d as unknown as {chargeCatalog:Record<string,{active:string}>}).chargeCatalog;
    if (cat.docket) cat.docket.active = 'No';
  }), resetCard, 'charges');
  await probe('card: mode tax (GST)', () => setCard((d: Record<string, unknown>) => {
    const mt=(d as unknown as {modeTax:Record<string,{gstRate?:number}>}).modeTax;
    if (mt.surface) mt.surface.gstRate = 0.28;
  }), resetCard, 'gst');
  await probe('offer: 10% off freight',
    async () => { const { createOffer } = await import('../src/data/offers');
      await createOffer({ name:'Probe Offer', kind:'percent-off-freight', value:10,
        startsAt:new Date(Date.now()-8.64e7), endsAt:new Date(Date.now()+8.64e7),
        audience:{kind:'customer',value:CODE}, actor:{id:'p',email:'p@x',name:'p'} } as never); },
    () => d.collection(COLLECTIONS.offers).deleteMany({ name:'Probe Offer' }).then(() => undefined),
    'freight');

  console.log(results.join('\n'));
  await resetCard();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
