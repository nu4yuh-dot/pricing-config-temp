import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quote } from './quote';
import { toPaise } from './money';
import type { Mode, Pincode, RateCard } from '../domain/types';

/**
 * Every quote the engine can produce adds up.
 *
 * The golden suite proves the engine agrees with the workbooks. This proves something the
 * golden suite cannot: that each quote is internally consistent to the paisa — that the
 * components on a quote, converted to paise, sum to exactly the total the same quote
 * reports. A float engine can agree with a workbook on every line and still hand billing a
 * total that is a paisa away from its own parts, and that is the failure this file exists
 * to make impossible.
 *
 * It runs over the same 150 cases as the golden suite, because those are the shapes real
 * shipments take, and the point is not one worked example but every one of them.
 */

const root = join(import.meta.dirname, '..', '..');

interface Fixture {
  models: {
    key: string;
    cases: {
      case: {
        id: string;
        description: string;
        mode: string;
        fromPincode: number;
        toPincode: number;
        actualWeight: number;
        length: number;
        breadth: number;
        height: number;
        pieces: number;
        singlePackageOver100kg: boolean;
      };
      expected: Record<string, unknown>;
    }[];
  }[];
}

const fixtures: Fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '__fixtures__', 'golden.json'), 'utf8'),
);

const pincodeList: Pincode[] = JSON.parse(
  readFileSync(join(root, 'data', 'extracted', 'pincodes.json'), 'utf8'),
);
const pincodes = new Map(pincodeList.map((p) => [p.pincode, p]));

const cards = new Map(
  ['model-1', 'model-2', 'model-3'].map((key) => [
    key,
    JSON.parse(readFileSync(join(root, 'data', 'extracted', `${key}.json`), 'utf8')) as RateCard,
  ]),
);

interface Checked {
  id: string;
  /** The freight, cartage, ODA, fuel and taxed charges that make up the taxable value. */
  taxablePartsPaise: number;
  subTotalPaise: number;
  totalPaise: number;
  gstPaise: number;
  chargesOutsideTaxPaise: number;
  chargesTotalPaise: number;
  chargeLinesPaise: number;
}

/** Price every fixture case once, in paise, and keep only what the identities need. */
const checked: Checked[] = [];

for (const model of fixtures.models) {
  const card = cards.get(model.key);
  if (!card) throw new Error(`no extracted card for ${model.key}`);

  for (const { case: c, expected } of model.cases) {
    if (typeof expected.freight !== 'number') continue;

    const result = quote(
      {
        mode: c.mode.toLowerCase() as Mode,
        actualWeight: c.actualWeight,
        length: c.length,
        breadth: c.breadth,
        height: c.height,
        pieces: c.pieces,
        singlePackageOver100kg: c.singlePackageOver100kg,
      },
      {
        origin: pincodes.get(c.fromPincode) ?? null,
        destination: pincodes.get(c.toPincode) ?? null,
      },
      card,
    );
    if (!result.available) continue;
    const b = result.breakdown;

    const taxedCharges = b.charges.filter((charge) => charge.gstApplies);
    const untaxedCharges = b.charges.filter((charge) => !charge.gstApplies);

    checked.push({
      id: `${model.key}/${c.id}`,
      taxablePartsPaise:
        toPaise(b.freight) +
        toPaise(b.pickup) +
        toPaise(b.delivery) +
        toPaise(b.pickupOda) +
        toPaise(b.deliveryOda) +
        toPaise(b.fuel) +
        taxedCharges.reduce(
          (sum, charge) => sum + toPaise(charge.amount) + toPaise(charge.fuel),
          0,
        ),
      subTotalPaise: toPaise(b.subTotal),
      totalPaise: toPaise(b.total),
      gstPaise: toPaise(b.gst),
      chargesOutsideTaxPaise: untaxedCharges.reduce(
        (sum, charge) => sum + toPaise(charge.amount) + toPaise(charge.fuel),
        0,
      ),
      chargesTotalPaise: toPaise(b.chargesTotal),
      chargeLinesPaise: b.charges.reduce(
        (sum, charge) => sum + toPaise(charge.amount) + toPaise(charge.fuel),
        0,
      ),
    });
  }
}

describe('every quote adds up, to the paisa', () => {
  test('there are cases to check, so a green run means something', () => {
    expect(checked.length).toBeGreaterThan(100);
  });

  test('the taxable value is exactly its parts', () => {
    // An ODA billed as a `by-pincode` charge is reported on the charge line and zeroed on
    // the ODA line, so it is counted once either way and the identity holds regardless.
    const off = checked.filter((c) => c.taxablePartsPaise !== c.subTotalPaise);
    expect(off.map((c) => `${c.id}: parts ${c.taxablePartsPaise} vs subTotal ${c.subTotalPaise}`)).toEqual(
      [],
    );
  });

  test('the total is exactly the taxable value plus GST plus what sits outside tax', () => {
    const off = checked.filter(
      (c) => c.subTotalPaise + c.gstPaise + c.chargesOutsideTaxPaise !== c.totalPaise,
    );
    expect(off.map((c) => `${c.id}: expected ${c.totalPaise}`)).toEqual([]);
  });

  test('the charges total is exactly the charge lines', () => {
    const off = checked.filter((c) => c.chargeLinesPaise !== c.chargesTotalPaise);
    expect(off.map((c) => `${c.id}: lines ${c.chargeLinesPaise} vs total ${c.chargesTotalPaise}`)).toEqual(
      [],
    );
  });

  test('every amount on a quote is a whole number of paise', () => {
    // The one that would have failed before: a float total can carry
    // 2375.6000000000004, which is not an amount anybody can be billed.
    const fractional = checked.filter(
      (c) =>
        !Number.isInteger(c.totalPaise) ||
        !Number.isInteger(c.subTotalPaise) ||
        !Number.isInteger(c.gstPaise),
    );
    expect(fractional.map((c) => c.id)).toEqual([]);
  });
});
