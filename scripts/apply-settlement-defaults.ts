import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settlementFill } from '../src/pricing/card-config';
import type { RateCard } from '../src/domain/types';

/**
 * Fill in the settlement configuration on the extracted cards.
 *
 * `scripts/extract.py` reads only what the workbooks contain, and the workbooks have
 * nowhere to state GST per mode, what the fuel percentage rides on, or a menu of
 * ancillary charges — they hardcode one rate, one fuel base and one docket field. This
 * writes those as data so they appear on the Tax & Charges tab and go through the same
 * edit, diff and approval path as any other cell.
 *
 * The values written reproduce the behaviour the cards already have, so no quoted number
 * moves. Run after extract.py. It fills gaps at any depth and never overwrites a value that
 * is already set, so running it twice is harmless and an edited configuration is safe.
 *
 *   npx tsx scripts/apply-settlement-defaults.ts
 */

const CARDS = ['model-1', 'model-2', 'model-3'];
const DIR = join(import.meta.dirname, '..', 'data', 'extracted');

let changed = 0;

for (const key of CARDS) {
  const path = join(DIR, `${key}.json`);
  const card = JSON.parse(readFileSync(path, 'utf8')) as RateCard;
  const fill = settlementFill(card.data);
  const additions = Object.keys(fill);
  Object.assign(card.data, fill);

  if (additions.length === 0) {
    console.log(`${key}: already configured`);
    continue;
  }
  writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`);
  console.log(`${key}: added ${additions.join(', ')}`);
  changed += 1;
}

console.log(changed === 0 ? 'nothing to do' : `updated ${changed} card(s)`);
