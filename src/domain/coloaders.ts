import { computeFreightPaise } from '../pricing/freight';
import { toRupees } from '../pricing/money';
import { marginFor, type Margin } from '../pricing/margin';
import { STORED_MODES } from './types';
import type { CostGrids, FreightMethod, RateCardData, StoredMode } from './types';
import type { LaneRates } from '../pricing/freight';

/**
 * Co-loaders — the buy side, as an entity rather than as a hidden field.
 *
 * The engine has held a buy tariff since margin was built: `data.cost` on a card, in the
 * same four-rate shape as sell, priced by the same freight function. What it never had
 * was a place to *look* at it. Which lanes a co-loader covers, and what every customer
 * quoting one of those lanes earns on it, are both answerable from data already stored —
 * they were simply never asked.
 *
 * Nothing here invents a second buy model. A co-loader is a card's cost grid, named.
 */

export interface Coloader {
  /** The card whose cost grid this is. One buy tariff per card, as stored today. */
  cardKey: string;
  cardName: string;
  /** Who the buy rate is with. */
  carrier: string;
  method: FreightMethod;
  /** Modes the tariff actually prices, rather than modes the card has grids for. */
  modes: StoredMode[];
  /** How many lanes carry a buy rate. */
  lanes: number;
}

function pricedLanes(grids: CostGrids['grids'][StoredMode]): number {
  let count = 0;
  for (const row of Object.values(grids.minCharge ?? {})) {
    for (const value of Object.values(row ?? {})) {
      if (value !== null && value !== undefined) count++;
    }
  }
  return count;
}

/** Every co-loader the cards know about. A card with no cost grid simply has none. */
export function coloadersFrom(
  cards: readonly { key: string; name: string; data: RateCardData }[],
): Coloader[] {
  const found: Coloader[] = [];

  for (const card of cards) {
    const cost = card.data.cost;
    if (!cost) continue;

    const modes = STORED_MODES.filter((mode) => pricedLanes(cost.grids[mode]) > 0);
    found.push({
      cardKey: card.key,
      cardName: card.name,
      carrier: cost.carrier,
      method: cost.method,
      modes,
      lanes: modes.reduce((total, mode) => total + pricedLanes(cost.grids[mode]), 0),
    });
  }

  return found.sort((a, b) => a.carrier.localeCompare(b.carrier));
}

export interface LaneMarginRow {
  customerCode: string;
  customerName: string;
  /** The sell freight this customer would pay on the lane, at the sample weight. */
  sell: number;
  margin: Margin | null;
  /** Set when this customer cannot be compared, and why. */
  skipped?: string;
}

/**
 * What every customer quoting one lane earns on it.
 *
 * The comparison a margin conversation actually needs, and the one no screen could
 * answer: a buy rate on its own says nothing, and a sell rate on its own says nothing.
 * Both sides are freight only — before fuel, cartage and tax — because mixing a landed
 * sell against a bare buy would flatter every lane on the list.
 *
 * A customer priced from another card is skipped rather than compared. Their rates are
 * real, but they are not being bought from this co-loader, and putting them in the same
 * table would invent a margin nobody is earning.
 */
export function laneMargins(input: {
  cardKey: string;
  cost: CostGrids;
  mode: StoredMode;
  origin: string;
  destination: string;
  chargeableWeight: number;
  minWeight: number;
  sellMethod: FreightMethod;
  customers: readonly {
    code: string;
    name: string;
    baseCardKey: string;
    /** The customer's effective rates for this lane, contract applied. */
    rates: LaneRates;
  }[];
}): LaneMarginRow[] {
  const buyRates = ratesAt(input.cost.grids[input.mode], input.origin, input.destination);

  return input.customers.map((customer) => {
    if (customer.baseCardKey !== input.cardKey) {
      return {
        customerCode: customer.code,
        customerName: customer.name,
        sell: 0,
        margin: null,
        skipped: `priced from ${customer.baseCardKey}, not bought from this co-loader`,
      };
    }

    const sellPaise = computeFreightPaise(
      input.sellMethod,
      input.chargeableWeight,
      input.minWeight,
      customer.rates,
    );
    if (sellPaise === null) {
      return {
        customerCode: customer.code,
        customerName: customer.name,
        sell: 0,
        margin: null,
        skipped: 'this lane is not carried on their contract',
      };
    }

    const margin = marginFor({
      sellFreightPaise: sellPaise,
      cost: {
        carrier: input.cost.carrier,
        method: input.cost.method,
        minWeight: input.minWeight,
        rates: buyRates,
      },
      chargeableWeight: input.chargeableWeight,
    });

    return {
      customerCode: customer.code,
      customerName: customer.name,
      sell: toRupees(sellPaise),
      margin,
    };
  });
}

function ratesAt(
  grids: CostGrids['grids'][StoredMode],
  origin: string,
  destination: string,
): LaneRates {
  return {
    minCharge: grids.minCharge[origin]?.[destination] ?? null,
    tier1: grids.tier1[origin]?.[destination] ?? null,
    tier2: grids.tier2[origin]?.[destination] ?? null,
    tier3: grids.tier3[origin]?.[destination] ?? null,
  };
}
