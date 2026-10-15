/**
 * Money handling — the foundation every financial figure in the product rests on.
 *
 * These tests exist because a finance product that is wrong by a paisa is wrong,
 * and because the import pipeline must distinguish "absent", "zero" and
 * "unreadable" from each other (§10 of the brief).
 */
import { describe, it, expect } from 'vitest';
import {
  add,
  sub,
  sum,
  neg,
  abs,
  parseAmount,
  roundToMinor,
  toMajor,
  ratio,
  percentOf,
  mulRatio,
  isZero,
  assertMinor,
  hasCreditMarker,
  hasDebitMarker,
  formatMinor,
  MoneyError,
} from '../../src/lib/money.js';

describe('parseAmount', () => {
  it('reads plain numbers and numeric strings into minor units', () => {
    expect(parseAmount(1234.5)).toBe(123450);
    expect(parseAmount('1234.50')).toBe(123450);
    expect(parseAmount(0)).toBe(0);
  });

  it('reads Indian and Western thousand separators', () => {
    expect(parseAmount('1,23,456.78')).toBe(12345678);
    expect(parseAmount('123,456.78')).toBe(12345678);
  });

  it('reads currency symbols, currency words and spacing', () => {
    expect(parseAmount('₹ 1,000')).toBe(100000);
    // Tally exports routinely prefix "Rs."
    expect(parseAmount('Rs. 1,000')).toBe(100000);
    expect(parseAmount('Rs 1,000')).toBe(100000);
    expect(parseAmount('INR 1000')).toBe(100000);
    expect(parseAmount('1,000 INR')).toBe(100000);
    expect(parseAmount('$1,000.00')).toBe(100000);
  });

  it('treats parenthesised amounts as negative, per accounting convention', () => {
    expect(parseAmount('(1,234.50)')).toBe(-123450);
  });

  it('distinguishes absent from zero', () => {
    // Absent → null, so the importer can tell "not supplied" from "nil".
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('   ')).toBeNull();
    expect(parseAmount('nil')).toBeNull();
    expect(parseAmount('N/A')).toBeNull();

    // Present and zero → 0, which is a real balance.
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('0.00')).toBe(0);
  });

  it('throws on a value that is present but not an amount, rather than guessing zero', () => {
    expect(() => parseAmount('not a number')).toThrow(MoneyError);
    expect(() => parseAmount(Number.NaN)).toThrow(MoneyError);
    expect(() => parseAmount(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => parseAmount(new Date())).toThrow(MoneyError);
  });

  it('honours a non-2 currency scale', () => {
    expect(parseAmount('1.5', { scale: 3 })).toBe(1500);
    expect(parseAmount('1', { scale: 0 })).toBe(1);
  });
});

describe('decimal safety', () => {
  it('does not drift the way floating point does', () => {
    // The reason minor units exist at all.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(add(parseAmount('0.1')!, parseAmount('0.2')!)).toBe(parseAmount('0.3')!);
  });

  it('accumulates a long column without drift', () => {
    const values = Array.from({ length: 1000 }, () => parseAmount('0.07')!);
    expect(sum(values)).toBe(7000); // ₹70.00 exactly
  });

  it('rounds half away from zero at the minor unit', () => {
    expect(roundToMinor(1.005)).toBe(101);
    expect(roundToMinor(-1.005)).toBe(-101);
  });

  it('round-trips through major units', () => {
    expect(toMajor(123450)).toBe(1234.5);
    expect(toMajor(parseAmount('99.99')!)).toBe(99.99);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, negates and takes absolute values', () => {
    expect(add(100, 250, -50)).toBe(300);
    expect(sub(500, 125)).toBe(375);
    expect(neg(-400)).toBe(400);
    expect(abs(-400)).toBe(400);
    expect(isZero(0)).toBe(true);
    expect(isZero(1)).toBe(false);
  });

  it('keeps multiplication by a rate in integer minor units', () => {
    expect(Number.isInteger(mulRatio(10000, 0.333))).toBe(true);
    expect(mulRatio(10000, 0.5)).toBe(5000);
  });

  it('refuses non-integer minor amounts', () => {
    expect(() => assertMinor(10.5)).toThrow(MoneyError);
    expect(() => assertMinor('100' as unknown)).toThrow(MoneyError);
    expect(() => assertMinor(100)).not.toThrow();
  });
});

describe('division guards', () => {
  it('returns null rather than Infinity or NaN when the denominator is zero', () => {
    // §17: a ratio that cannot be computed must read N/A, never Infinity.
    expect(ratio(1000, 0)).toBeNull();
    expect(percentOf(1000, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
  });

  it('computes normally when the denominator is non-zero', () => {
    expect(ratio(2000, 1000)).toBe(2);
    expect(percentOf(250, 1000)).toBe(25);
  });
});

describe('debit and credit markers', () => {
  it('recognises Dr and Cr suffixes used by Tally exports', () => {
    expect(hasCreditMarker('1,000 Cr')).toBe(true);
    expect(hasDebitMarker('1,000 Dr')).toBe(true);
    expect(hasCreditMarker('1,000')).toBe(false);
    expect(hasDebitMarker('1,000')).toBe(false);
  });
});

describe('formatting', () => {
  it('formats minor units for display without losing precision', () => {
    expect(formatMinor(12345678)).toContain('1,23,456.78');
  });
});
