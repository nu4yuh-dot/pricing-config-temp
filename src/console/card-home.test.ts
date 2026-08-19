import { describe, expect, test } from 'vitest';
import { consoleHomeFor } from './card-home';
import { CARD_SOURCES } from '../domain/types';

describe('where a card opens in the console', () => {
  test('our own network opens on lane rates', () => {
    expect(consoleHomeFor('dns', 'model-1')).toBe('/console/model-1/rates');
  });

  test('a franchise card opens on its own editor, not the lane grid', () => {
    expect(consoleHomeFor('bluedart', 'bluedart')).toBe('/console/bluedart/bluedart');
  });

  test('an export card opens on its own editor', () => {
    expect(consoleHomeFor('ups', 'ups')).toBe('/console/ups/ups');
  });

  test('every source has a home, so no card can be sent to a 404', () => {
    // The lane pages are guarded to `dns`. A source with no case here would fall through
    // to /rates and refuse — which is exactly how the sheet's back link broke.
    for (const source of CARD_SOURCES) {
      const href = consoleHomeFor(source, 'card');
      if (source !== 'dns') expect(href).not.toBe('/console/card/rates');
      expect(href).toMatch(/^\/console\/card\/[a-z]+$/);
    }
  });
});
