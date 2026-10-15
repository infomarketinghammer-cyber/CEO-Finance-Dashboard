/**
 * Date handling.
 *
 * Indian accounting exports are day-first; most spreadsheet defaults are
 * month-first. Reading 03/04/2025 as 3 April or 4 March moves a voucher between
 * quarters, so detection and explicit ordering both have to be right.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDate,
  detectDateFormat,
  addDays,
  addMonths,
  daysBetween,
  monthKey,
  startOfMonth,
  endOfMonth,
} from '../../src/lib/dates.js';

describe('parseDate', () => {
  it('reads ISO dates unambiguously', () => {
    expect(parseDate('2025-04-03')).toBe('2025-04-03');
  });

  it('respects day-first ordering', () => {
    expect(parseDate('03/04/2025', 'dmy')).toBe('2025-04-03');
    expect(parseDate('03-04-2025', 'dmy')).toBe('2025-04-03');
  });

  it('respects month-first ordering', () => {
    expect(parseDate('03/04/2025', 'mdy')).toBe('2025-03-04');
  });

  it('reads written month names regardless of ordering', () => {
    expect(parseDate('3 Apr 2025', 'dmy')).toBe('2025-04-03');
    expect(parseDate('3-Apr-25', 'dmy')).toBe('2025-04-03');
  });

  it('returns null for an absent value, so a blank is not turned into today', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('   ')).toBeNull();
  });

  it('throws on an impossible date rather than rolling it over', () => {
    // 31 February must not silently become 2 or 3 March. A present-but-invalid
    // date is an error the importer turns into a rejected row with a reason,
    // which is different from an absent one.
    expect(() => parseDate('31/02/2025', 'dmy')).toThrow(/not a valid calendar date/);
  });

  it('throws on text that is not a date at all, rather than inventing one', () => {
    expect(() => parseDate('not a date')).toThrow(/could not be read as a date/);
  });

  it('reads an Excel date serial under the 1900 system', () => {
    // 45658 = 1 Jan 2025; 93 days later is 4 Apr 2025.
    expect(parseDate(45658)).toBe('2025-01-01');
    expect(parseDate(45751)).toBe('2025-04-04');
  });

  it('reads a JavaScript Date', () => {
    expect(parseDate(new Date(Date.UTC(2025, 3, 3)))).toBe('2025-04-03');
  });
});

describe('detectDateFormat', () => {
  it('detects day-first when a value exceeds 12 in the first position', () => {
    const d = detectDateFormat(['01/04/2025', '15/04/2025', '28/04/2025']);
    expect(d.order).toBe('dmy');
    expect(d.ambiguous).toBe(false);
    expect(d.parsedCount).toBe(3);
  });

  it('detects month-first when a value exceeds 12 in the second position', () => {
    const d = detectDateFormat(['04/15/2025', '04/28/2025']);
    expect(d.order).toBe('mdy');
    expect(d.ambiguous).toBe(false);
  });

  it('declares ambiguity when no value can settle the order', () => {
    // Nothing above 12 anywhere: genuinely undecidable from the data alone, so
    // the importer must ask rather than assume.
    const d = detectDateFormat(['01/02/2025', '03/04/2025', '05/06/2025']);
    expect(d.ambiguous).toBe(true);
  });

  it('counts values it could not read, so the wizard can warn', () => {
    const d = detectDateFormat(['15/04/2025', 'not a date', '']);
    expect(d.unparsedCount).toBeGreaterThan(0);
  });
});

describe('date arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2025-04-28', 5)).toBe('2025-05-03');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
  });

  it('adds days across a leap day', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
  });

  it('adds months and clamps to the end of a shorter month', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
  });

  it('counts days between two dates', () => {
    expect(daysBetween('2025-04-01', '2025-04-30')).toBe(29);
    expect(daysBetween('2025-04-01', '2025-04-01')).toBe(0);
    expect(daysBetween('2025-04-30', '2025-04-01')).toBe(-29);
  });

  it('derives month keys and boundaries', () => {
    expect(monthKey('2025-04-15')).toBe('2025-04');
    expect(startOfMonth('2025-04-15')).toBe('2025-04-01');
    expect(endOfMonth('2025-04-15')).toBe('2025-04-30');
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
  });
});
