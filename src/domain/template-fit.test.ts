import { describe, test, expect } from 'vitest';
import {
  templateConflicts,
  scoreTemplateFit,
  rankTemplates,
  resolveTemplateParameters,
} from './template-fit';

const template = {
  key: 'zone-directional',
  baseCardKey: 'model-1',
  overrides: {
    'grids.surface.tier1.PNQ.NCR': 23,
    'grids.surface.tier1.PNQ.BOM': 21,
    'charges.docket': 100,
  },
};

describe('what a template would tread on', () => {
  test('a negotiated cell the template disagrees with is a conflict', () => {
    const conflicts = templateConflicts(template, { 'charges.docket': 80 });

    expect(conflicts).toEqual([{ bind: 'charges.docket', theirs: 80, template: 100 }]);
  });

  test('agreeing on a value is not a conflict', () => {
    expect(templateConflicts(template, { 'charges.docket': 100 })).toEqual([]);
  });

  test('a cell they never negotiated is not a conflict — setting it is the point', () => {
    expect(templateConflicts(template, {})).toEqual([]);
  });
});

describe('how well a template fits a customer', () => {
  test('overlap that agrees is what scores', () => {
    const fit = scoreTemplateFit(template, {
      baseCardKey: 'model-1',
      overrides: { 'grids.surface.tier1.PNQ.NCR': 23, 'charges.docket': 80 },
    });

    expect(fit).toMatchObject({ agreeing: 1, conflicting: 1, fresh: 1, agreement: 0.5 });
  });

  test('a customer with nothing negotiated is no evidence, not a bad fit', () => {
    // Zero would sort them below templates that genuinely clash, which is backwards.
    expect(scoreTemplateFit(template, { baseCardKey: 'model-1', overrides: {} }).agreement).toBeNull();
  });

  test('a different base card is meaningless rather than poor', () => {
    const fit = scoreTemplateFit(template, { baseCardKey: 'model-3', overrides: {} });

    expect(fit.blocked).toContain('model-1');
    expect(fit.agreeing).toBe(0);
  });

  test('ranking puts the best agreement first and anything blocked last', () => {
    const ranked = rankTemplates([
      { templateKey: 'blocked', agreeing: 9, conflicting: 0, fresh: 0, agreement: 1, blocked: 'no' },
      { templateKey: 'poor', agreeing: 1, conflicting: 3, fresh: 0, agreement: 0.25 },
      { templateKey: 'good', agreeing: 3, conflicting: 1, fresh: 0, agreement: 0.75 },
    ]);

    expect(ranked.map((fit) => fit.templateKey)).toEqual(['good', 'poor', 'blocked']);
  });
});

describe('parameters', () => {
  const parameterised = { ...template, parameters: ['grids.surface.tier1.PNQ.NCR'] };

  test('an answered parameter takes the answer', () => {
    const resolved = resolveTemplateParameters(parameterised, {
      'grids.surface.tier1.PNQ.NCR': 19,
    });

    expect(resolved['grids.surface.tier1.PNQ.NCR']).toBe(19);
  });

  test('a fixed cell is copied as it stands, answer or no answer', () => {
    expect(resolveTemplateParameters(parameterised, {})['charges.docket']).toBe(100);
  });

  test('an unanswered parameter is dropped, not defaulted to the stored example', () => {
    // Copying it would present the template author's last figure as a decision somebody
    // made for this customer, which is worse than having no parameters at all.
    const resolved = resolveTemplateParameters(parameterised, {});

    expect('grids.surface.tier1.PNQ.NCR' in resolved).toBe(false);
  });

  test('a template with no parameters resolves to exactly its overrides', () => {
    expect(resolveTemplateParameters(template, {})).toEqual(template.overrides);
  });
});
