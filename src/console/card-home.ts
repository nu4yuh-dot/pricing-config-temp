import type { CardSource } from '../domain/types';

/**
 * Where a card's editing starts in the console.
 *
 * The lane-shaped pages exist only for our own network — a franchise or export card has
 * no lane grid, and those routes refuse a card that is not `dns`. So "go and edit this
 * card" is a different address per source, and getting it wrong is a 404 rather than a
 * wrong-looking page.
 *
 * One function because there are three callers — the pending-changes screen, the sheet
 * view's way back, and anything added later — and three copies of a mapping is how one
 * of them ends up stale. One already did: the sheet's return link dropped the UPS branch
 * while UPS had no tabs, then broke the moment it got them.
 */
export function consoleHomeFor(source: CardSource, cardKey: string): string {
  if (source === 'bluedart') return `/console/${cardKey}/bluedart`;
  if (source === 'ups') return `/console/${cardKey}/ups`;
  return `/console/${cardKey}/rates`;
}
