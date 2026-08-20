import { CARD_SOURCES, type CardSource } from '../domain/types';

/**
 * The card switcher in the console rail: which cards, in what order, under what label.
 *
 * Two things the raw card list gets wrong for a narrow rail.
 *
 * Order. `listCards` sorts by key, which is right for a table and wrong here — it puts
 * Bluedart above Model 1, so the first thing in a pricing tool is a partner's card rather
 * than our own network. Our cards come first, then partners in the order they were taken
 * on.
 *
 * Length. Card names carry a description after an em dash — "UPS / MOVIN — international
 * export, ex-Mumbai" — which is what you want on a page heading and four wrapped lines in
 * a rail. The rail shows the part before the dash, and the full name is the heading of the
 * section immediately below it, so nothing is actually hidden.
 */

/** The rail label: the name up to its em dash, or the whole name if it has none. */
export function pickerLabel(name: string): string {
  const [short] = name.split('—');
  return (short ?? name).trim() || name;
}

/** Our own network first, then partners in `CARD_SOURCES` order; stable within a source. */
export function orderForPicker<T extends { source?: CardSource }>(cards: readonly T[]): T[] {
  const rank = (card: T) => {
    const at = CARD_SOURCES.indexOf(card.source ?? 'dns');
    // An unknown source sorts last rather than first, which is where -1 would put it.
    return at === -1 ? CARD_SOURCES.length : at;
  };
  return [...cards].sort((a, b) => rank(a) - rank(b));
}
