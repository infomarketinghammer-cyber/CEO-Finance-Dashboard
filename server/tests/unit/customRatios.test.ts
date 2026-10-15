/**
 * The custom ratio formula engine (§17).
 *
 * Two things matter here above correctness of arithmetic: a stored formula must
 * never be executed as JavaScript, and an input the imported data cannot supply
 * must produce "N/A" with a reason rather than a confident wrong number.
 */
import { describe, it, expect } from 'vitest';
import {
  compileFormula,
  evaluateCustomRatios,
  referencedInputs,
  validateDefinition,
  FormulaError,
  type CustomRatioDefinition,
} from '../../src/modules/finance/customRatios.js';
import { RATIO_INPUTS, groupedInputs } from '../../src/modules/finance/ratioInputs.js';

/** A complete set of inputs, so a formula only fails when the test means it to. */
const VALUES: Record<string, number | null> = Object.fromEntries(RATIO_INPUTS.map((i) => [i.key, 100]));

function evalOne(formula: string, values: Record<string, number | null> = VALUES) {
  const def: CustomRatioDefinition = {
    key: 'custom_test',
    label: 'Test',
    formula,
    unit: 'times',
    explanation: '',
    group: 'profitability',
  };
  return evaluateCustomRatios([def], values)[0];
}

describe('formula parsing', () => {
  it('accepts the four operators, brackets and decimals', () => {
    expect(() => compileFormula('revenue + cogs - netProfit * 2 / 4')).not.toThrow();
    expect(() => compileFormula('(currentAssets - inventory) / currentLiabilities')).not.toThrow();
    expect(() => compileFormula('netProfit / revenue * 100')).not.toThrow();
    expect(() => compileFormula('1.5 * revenue')).not.toThrow();
    expect(() => compileFormula('-revenue')).not.toThrow();
  });

  it('refuses an identifier that is not a published input', () => {
    expect(() => compileFormula('revenue / mystery')).toThrow(FormulaError);
    expect(() => compileFormula('revenue / mystery')).toThrow(/mystery/);
  });

  it('refuses malformed expressions rather than guessing', () => {
    expect(() => compileFormula('revenue /')).toThrow(FormulaError);
    expect(() => compileFormula('(revenue / cogs')).toThrow(FormulaError);
    expect(() => compileFormula('revenue cogs')).toThrow(FormulaError);
    expect(() => compileFormula('')).toThrow(FormulaError);
    expect(() => compileFormula('   ')).toThrow(FormulaError);
  });

  it('never executes the formula as JavaScript', () => {
    // Each of these is valid JS and must be refused by the grammar.
    for (const attempt of [
      'process.exit(1)',
      'globalThis.process',
      'require("fs")',
      'revenue; process.exit(1)',
      '(() => 1)()',
      'revenue ** 2',
      'constructor',
      'revenue || 1',
    ]) {
      expect(() => compileFormula(attempt), attempt).toThrow(FormulaError);
    }
  });

  it('refuses characters outside the grammar', () => {
    expect(() => compileFormula('revenue % cogs')).toThrow(FormulaError);
    expect(() => compileFormula('revenue & cogs')).toThrow(FormulaError);
    expect(() => compileFormula('revenue > cogs')).toThrow(FormulaError);
  });

  it('reports which inputs a formula reads', () => {
    const used = referencedInputs(compileFormula('(currentAssets - inventory) / currentLiabilities'));
    expect([...used].sort()).toEqual(['currentAssets', 'currentLiabilities', 'inventory']);
  });
});

describe('evaluation', () => {
  it('applies normal operator precedence', () => {
    // 100 + 100 * 2 = 300, not 400.
    expect(evalOne('revenue + cogs * 2').value).toBe(300);
    expect(evalOne('(revenue + cogs) * 2').value).toBe(400);
  });

  it('computes a quick ratio correctly', () => {
    const values = { ...VALUES, currentAssets: 300, inventory: 100, currentLiabilities: 100 };
    expect(evalOne('(currentAssets - inventory) / currentLiabilities', values).value).toBe(2);
  });

  it('computes a percentage', () => {
    const values = { ...VALUES, netProfit: 25, revenue: 100 };
    expect(evalOne('netProfit / revenue * 100', values).value).toBe(25);
  });

  it('handles unary minus', () => {
    expect(evalOne('-revenue / cogs').value).toBe(-1);
  });

  it('is scale-independent, because money cancels', () => {
    const rupees = { ...VALUES, currentAssets: 300, currentLiabilities: 100 };
    const paise = { ...VALUES, currentAssets: 30000, currentLiabilities: 10000 };
    const f = 'currentAssets / currentLiabilities';
    expect(evalOne(f, rupees).value).toBe(evalOne(f, paise).value);
  });
});

describe('honest unavailability', () => {
  it('returns N/A with a reason when the divisor is zero, never Infinity', () => {
    const r = evalOne('revenue / cogs', { ...VALUES, cogs: 0 });
    expect(r.available).toBe(false);
    expect(r.value).toBeNull();
    expect(r.reason).toMatch(/zero/i);
  });

  it('returns N/A when an input is missing, rather than treating it as zero', () => {
    const r = evalOne('revenue / inventory', { ...VALUES, inventory: null });
    expect(r.available).toBe(false);
    expect(r.value).toBeNull();
    expect(r.reason).toMatch(/Inventory/);
  });

  it('propagates a missing input through nested arithmetic', () => {
    const r = evalOne('(revenue + inventory) / cogs', { ...VALUES, inventory: null });
    expect(r.available).toBe(false);
  });

  it('does not fail the whole report when one stored formula is unreadable', () => {
    const results = evaluateCustomRatios(
      [
        { key: 'a', label: 'Good', formula: 'revenue / cogs', unit: 'times', explanation: '', group: 'profitability' },
        { key: 'b', label: 'Broken', formula: 'revenue /', unit: 'times', explanation: '', group: 'profitability' },
      ],
      VALUES,
    );
    expect(results).toHaveLength(2);
    expect(results[0].available).toBe(true);
    expect(results[1].available).toBe(false);
    expect(results[1].reason).toMatch(/no longer be read/i);
  });

  it('carries the source of every input it used, for traceability', () => {
    const r = evalOne('currentAssets / currentLiabilities');
    expect(r.inputs).toHaveLength(2);
    expect(r.inputs.every((i) => typeof i.source === 'string' && i.source.length > 0)).toBe(true);
  });
});

describe('definition validation', () => {
  it('derives a stable key from the label', () => {
    const def = validateDefinition({ label: 'Cash Conversion!', formula: 'cash / revenue', unit: 'times' });
    expect(def.key).toBe('custom_cash_conversion');
  });

  it('keeps an explicit key when editing', () => {
    const def = validateDefinition({ key: 'custom_existing', label: 'Renamed', formula: 'cash / revenue', unit: 'times' });
    expect(def.key).toBe('custom_existing');
  });

  it('refuses an empty name and an unusable formula', () => {
    expect(() => validateDefinition({ label: '  ', formula: 'cash / revenue', unit: 'times' })).toThrow(FormulaError);
    expect(() => validateDefinition({ label: 'Bad', formula: 'cash /', unit: 'times' })).toThrow(FormulaError);
  });
});

describe('input catalogue', () => {
  it('publishes every input with a label, kind and source', () => {
    for (const input of RATIO_INPUTS) {
      expect(input.key).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      expect(input.label.length).toBeGreaterThan(0);
      expect(['money', 'number']).toContain(input.kind);
      expect(input.source.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate keys', () => {
    const keys = RATIO_INPUTS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('groups every input for the picker without losing any', () => {
    const grouped = groupedInputs();
    const total = grouped.reduce((n, g) => n + g.inputs.length, 0);
    expect(total).toBe(RATIO_INPUTS.length);
  });
});
