import { describe, expect, test } from 'vitest';
import { pickerLabel, orderForPicker } from './card-picker';
import { CARD_SOURCES, type CardSource } from '../domain/types';

describe('the rail label', () => {
  test('keeps the name and drops the description after the em dash', () => {
    expect(pickerLabel('UPS / MOVIN — international export, ex-Mumbai')).toBe('UPS / MOVIN');
    expect(pickerLabel('Model 3 — max of minimum or full weight')).toBe('Model 3');
  });

  test('a name with no dash is left alone', () => {
    expect(pickerLabel('Bluedart')).toBe('Bluedart');
  });

  test('a name that is nothing but a description keeps the whole thing', () => {
    // Better a long label than an empty one — an unlabelled link is unclickable in practice.
    expect(pickerLabel('— surface only')).toBe('— surface only');
  });
});

describe('the order cards appear in', () => {
  const card = (key: string, source: CardSource) => ({ key, source });

  test('our own network comes before partners, whatever the keys sort like', () => {
    // Sorted by key, Bluedart leads. It should not.
    const ordered = orderForPicker([
      card('bluedart', 'bluedart'),
      card('model-1', 'dns'),
      card('model-2', 'dns'),
      card('ups', 'ups'),
    ]);
    expect(ordered.map((entry) => entry.key)).toEqual(['model-1', 'model-2', 'bluedart', 'ups']);
  });

  test('order within one source is left as it came', () => {
    const ordered = orderForPicker([card('model-3', 'dns'), card('model-1', 'dns')]);
    expect(ordered.map((entry) => entry.key)).toEqual(['model-3', 'model-1']);
  });

  test('a card with no source is treated as ours, as findCard does', () => {
    const ordered = orderForPicker([{ key: 'bluedart', source: 'bluedart' as CardSource }, { key: 'legacy' }]);
    expect(ordered.map((entry) => entry.key)).toEqual(['legacy', 'bluedart']);
  });

  test('every known source has a place, so no card can fall out of the picker', () => {
    const one = CARD_SOURCES.map((source, at) => card(`card-${at}`, source));
    expect(orderForPicker(one)).toHaveLength(CARD_SOURCES.length);
  });
});
