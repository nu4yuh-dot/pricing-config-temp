import { AIR_ZONES, SURFACE_ZONES } from './zones';
import { GRID_NAMES, STORED_MODES } from './types';
import { gridBindPath } from './lane-rules';
import type { RateCardData } from './types';
import type { Overrides } from './customers';

/**
 * Freezing today's prices on lanes a customer never negotiated.
 *
 * The mockup asks for this as a checkbox — *Lock today's prices on every other lane too*
 * — and it is worth having as a deliberate act rather than as a side effect, which is how
 * it was originally described. A sparse contract tracks the base card: raise a standard
 * rate and every customer who did not negotiate that lane moves with it. Usually that is
 * exactly right. Occasionally somebody has promised a customer that nothing moves for a
 * year, and then it is not.
 *
 * So the price of the promise is stated rather than hidden: locking writes a cell for
 * every lane, and that number is shown before anything is written. It is the one place in
 * this system where thousands of override cells are the correct answer, because the thing
 * being recorded genuinely is "every one of these prices, as of today".
 */

/**
 * The overrides that would pin every currently-served lane at its present price.
 *
 * Anything already negotiated is left alone — a locked price must never overwrite an
 * agreed one — and unserved lanes are skipped. A lane the card does not carry has no
 * price to protect, and writing `null` to freeze it shut would quietly keep the customer
 * off a lane the network opens later, which is not what anybody means by locking a price.
 */
export function priceLockOverrides(data: RateCardData, negotiated: Overrides): Overrides {
  const locked: Overrides = {};

  for (const mode of STORED_MODES) {
    const zones = mode === 'air' ? AIR_ZONES : SURFACE_ZONES;
    const grids = data.grids[mode];

    for (const origin of zones) {
      for (const destination of zones) {
        for (const rate of GRID_NAMES) {
          const value = grids[rate][origin]?.[destination];
          if (value === null || value === undefined) continue;

          const path = gridBindPath(mode, rate, origin, destination);
          if (path in negotiated) continue;

          locked[path] = value;
        }
      }
    }
  }

  return locked;
}
