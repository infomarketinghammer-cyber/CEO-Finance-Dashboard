/**
 * Decimal-safe money handling.
 *
 * Every monetary amount in DHYEYA is stored and transported as an integer number
 * of MINOR UNITS (paise for INR, cents for USD). Floating point is never used for
 * storage or accumulation. Conversion to a float happens only at the presentation
 * boundary, and even then the API ships the integer alongside it.
 *
 * Rationale: 0.1 + 0.2 !== 0.3 in IEEE-754. A trial balance built from floats
 * drifts, and a drifting trial balance is indistinguishable from a real accounting
 * error, which is the one thing a finance product must never confuse.
 */

export type Minor = number; // integer minor units

const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER; // ±90,071,992,547,409.91 in rupees

export class MoneyError extends Error {}

/** Assert a value is a safe integer count of minor units. */
export function assertMinor(v: unknown, label = 'amount'): asserts v is Minor {
  if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > MAX_SAFE_MINOR) {
    throw new MoneyError(`${label} must be a safe integer of minor units, received ${String(v)}`);
  }
}

/**
 * Parse a user- or spreadsheet-supplied amount into minor units.
 *
 * Accepts: number, numeric string, strings with thousand separators (Indian or
 * Western grouping), currency symbols, trailing/leading signs, parenthesised
 * negatives (accounting convention), and Dr/Cr suffixes.
 *
 * Returns null when the value is absent. Throws MoneyError when the value is
 * present but not interpretable — the import pipeline turns that into a rejected
 * row with a reason, rather than silently substituting zero.
 */
export function parseAmount(raw: unknown, opts: { scale?: number } = {}): Minor | null {
  const scale = opts.scale ?? 2;
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new MoneyError(`Amount is not a finite number: ${raw}`);
    return roundToMinor(raw, scale);
  }

  if (raw instanceof Date) {
    throw new MoneyError('A date was supplied where an amount was expected');
  }

  let s = String(raw).trim();
  if (s === '' || s === '-' || s.toLowerCase() === 'nil' || s.toLowerCase() === 'n/a') return null;

  let negative = false;

  // Accounting-style parentheses: (1,234.50) means -1234.50
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Dr / Cr suffixes carry sign meaning in Tally exports. Cr is treated as negative
  // only by the caller that knows the account's natural side; here we record it.
  const drCr = /\b(dr|cr)\.?$/i.exec(s);
  if (drCr) s = s.slice(0, drCr.index).trim();

  // Strip a leading currency word before symbols, so "Rs. 1,000", "INR 1000"
  // and "USD 1000" parse. Tally exports commonly carry the "Rs." prefix.
  s = s.replace(/^(rs\.?|inr|usd|eur|gbp|aed|sgd)\s*/i, '').trim();

  // Strip currency symbols, spaces, non-breaking spaces and grouping commas.
  s = s.replace(/[₹$€£¥]/g, '').replace(/[\s  ]/g, '').replace(/,/g, '');

  // A trailing currency word, as in "1000INR" once spaces have gone.
  s = s.replace(/(rs\.?|inr|usd|eur|gbp|aed|sgd)$/i, '');

  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }

  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') {
    throw new MoneyError(`Amount could not be interpreted as a number: "${String(raw)}"`);
  }

  const n = Number(s);
  if (!Number.isFinite(n)) throw new MoneyError(`Amount is not a finite number: "${String(raw)}"`);

  const minor = roundToMinor(n, scale);
  return negative ? -minor : minor;
}

/** Was the raw cell marked Cr (credit) by the source system? */
export function hasCreditMarker(raw: unknown): boolean {
  return typeof raw === 'string' && /\bcr\.?\s*$/i.test(raw.trim());
}

export function hasDebitMarker(raw: unknown): boolean {
  return typeof raw === 'string' && /\bdr\.?\s*$/i.test(raw.trim());
}

/**
 * Convert a major-unit number to minor units using round-half-away-from-zero,
 * the convention Indian accounting software applies to rupee rounding.
 */
export function roundToMinor(major: number, scale = 2): Minor {
  const factor = Math.pow(10, scale);
  // Work in a string-free way but compensate for binary representation error by
  // nudging with EPSILON scaled to the magnitude before rounding.
  const scaled = major * factor;
  const eps = Math.sign(scaled) * Math.abs(scaled) * Number.EPSILON * 4;
  const rounded = Math.round(scaled + eps);
  if (!Number.isSafeInteger(rounded)) {
    throw new MoneyError(`Amount ${major} exceeds the safe range for exact arithmetic`);
  }
  return rounded;
}

export function toMajor(minor: Minor, scale = 2): number {
  assertMinor(minor);
  return minor / Math.pow(10, scale);
}

export function add(...values: Minor[]): Minor {
  let total = 0;
  for (const v of values) {
    assertMinor(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new MoneyError('Sum exceeded the safe integer range');
  }
  return total;
}

export function sum(values: Minor[]): Minor {
  return add(...values);
}

export function sub(a: Minor, b: Minor): Minor {
  assertMinor(a);
  assertMinor(b);
  return a - b;
}

export function neg(a: Minor): Minor {
  assertMinor(a);
  return -a;
}

export function abs(a: Minor): Minor {
  assertMinor(a);
  return Math.abs(a);
}

/** Multiply money by a plain ratio (e.g. a 0.8 collection probability). */
export function mulRatio(a: Minor, ratio: number): Minor {
  assertMinor(a);
  if (!Number.isFinite(ratio)) throw new MoneyError(`Ratio is not finite: ${ratio}`);
  return Math.round(a * ratio);
}

/**
 * Divide two money values into a plain ratio. Returns null when the denominator is
 * zero — callers surface that as "N/A" rather than Infinity or NaN.
 */
export function ratio(numerator: Minor, denominator: Minor): number | null {
  assertMinor(numerator);
  assertMinor(denominator);
  if (denominator === 0) return null;
  return numerator / denominator;
}

/** Percentage of a over b, or null when b is zero. */
export function percentOf(a: Minor, b: Minor): number | null {
  const r = ratio(a, b);
  return r === null ? null : r * 100;
}

export function isZero(a: Minor): boolean {
  assertMinor(a);
  return a === 0;
}

/** Format for logs and PDF/Excel exports. Not used for arithmetic. */
export function formatMinor(minor: Minor, opts: { currency?: string; scale?: number } = {}): string {
  const scale = opts.scale ?? 2;
  const currency = opts.currency ?? 'INR';
  const value = toMajor(minor, scale);
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    }).format(value);
  } catch {
    return value.toFixed(scale);
  }
}
