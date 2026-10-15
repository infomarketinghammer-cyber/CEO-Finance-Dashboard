/**
 * Date handling for imported workbooks.
 *
 * The hard problem is ambiguity: "05/04/2025" is 5 April in an Indian export and
 * 4 May in an American one, and guessing per cell produces a ledger where some
 * rows landed in the wrong month. So the format is decided once per COLUMN by
 * scanning every value in it for a disambiguating case (a component above 12),
 * and only then are the cells parsed. When a column stays ambiguous the caller is
 * told, and the import wizard asks the user instead of guessing.
 */

export type DateOrder = 'dmy' | 'mdy' | 'ymd' | 'unknown';

export interface DateFormatDetection {
  order: DateOrder;
  /** True when no value in the column could settle dmy vs mdy. */
  ambiguous: boolean;
  samples: string[];
  parsedCount: number;
  unparsedCount: number;
}

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/;
const SEPARATED_RE = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// "5 Apr 2025", "Apr 5, 2025", "5-Apr-25"
const TEXT_MONTH_RE = /^(\d{1,2})[\s\-/]+([a-z]{3,9})[\s\-/]+(\d{2,4})$/i;
const TEXT_MONTH_FIRST_RE = /^([a-z]{3,9})[\s\-/]+(\d{1,2})[,\s\-/]+(\d{2,4})$/i;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toIso(y: number, m: number, d: number): string | null {
  if (!isValidYmd(y, m, d)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function expandYear(y: number): number {
  if (y >= 1000) return y;
  // Two-digit years: 70–99 -> 1900s, 00–69 -> 2000s.
  return y >= 70 ? 1900 + y : 2000 + y;
}

/**
 * Inspect every value in a column and decide the day/month order.
 */
export function detectDateFormat(values: unknown[]): DateFormatDetection {
  let sawDayFirstEvidence = false;
  let sawMonthFirstEvidence = false;
  let isoCount = 0;
  let separatedCount = 0;
  let parsed = 0;
  let unparsed = 0;
  const samples: string[] = [];

  for (const raw of values) {
    if (raw === null || raw === undefined || raw === '') continue;
    if (raw instanceof Date) {
      parsed++;
      if (samples.length < 5) samples.push(raw.toISOString().slice(0, 10));
      continue;
    }
    if (typeof raw === 'number') {
      parsed++;
      if (samples.length < 5) samples.push(String(raw));
      continue;
    }

    const s = String(raw).trim();
    if (!s) continue;
    if (samples.length < 5) samples.push(s);

    if (ISO_RE.test(s)) {
      isoCount++;
      parsed++;
      continue;
    }
    if (TEXT_MONTH_RE.test(s) || TEXT_MONTH_FIRST_RE.test(s)) {
      parsed++;
      continue;
    }

    const m = SEPARATED_RE.exec(s);
    if (m) {
      separatedCount++;
      const a = Number(m[1]);
      const b = Number(m[2]);
      // A first component above 12 can only be a day; a second above 12 only a day.
      if (a > 12 && a <= 31) sawDayFirstEvidence = true;
      if (b > 12 && b <= 31) sawMonthFirstEvidence = true;
      parsed++;
      continue;
    }

    const native = Date.parse(s);
    if (!Number.isNaN(native)) parsed++;
    else unparsed++;
  }

  let order: DateOrder = 'unknown';
  let ambiguous = false;

  if (separatedCount === 0 && isoCount > 0) {
    order = 'ymd';
  } else if (sawDayFirstEvidence && !sawMonthFirstEvidence) {
    order = 'dmy';
  } else if (sawMonthFirstEvidence && !sawDayFirstEvidence) {
    order = 'mdy';
  } else if (sawDayFirstEvidence && sawMonthFirstEvidence) {
    // The column contains both 25/01 and 01/25 shapes — mixed or corrupt.
    order = 'unknown';
    ambiguous = true;
  } else if (separatedCount > 0) {
    // Nothing above 12 anywhere. Default to day-first (Indian convention) but say so.
    order = 'dmy';
    ambiguous = true;
  } else if (parsed > 0) {
    order = 'ymd';
  }

  return { order, ambiguous, samples, parsedCount: parsed, unparsedCount: unparsed };
}

/**
 * Parse one cell into an ISO `YYYY-MM-DD` string using a known column order.
 * Returns null for an empty cell, and throws for a present-but-unreadable value so
 * the row is rejected with a reason rather than silently dated.
 */
export function parseDate(raw: unknown, order: DateOrder = 'dmy'): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) throw new Error('Invalid date value');
    return `${raw.getUTCFullYear()}-${pad(raw.getUTCMonth() + 1)}-${pad(raw.getUTCDate())}`;
  }

  // Excel stores dates as a serial day count from 1899-12-30 (the 1900 system,
  // including its deliberate leap-year bug, which the epoch offset absorbs).
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 1 || raw > 2958465) {
      throw new Error(`Numeric value ${raw} is outside the range of a spreadsheet date`);
    }
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }

  const s = String(raw).trim();
  if (!s) return null;

  const iso = ISO_RE.exec(s);
  if (iso) {
    const r = toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (r) return r;
    throw new Error(`"${s}" is not a valid calendar date`);
  }

  const tm = TEXT_MONTH_RE.exec(s);
  if (tm) {
    const month = MONTHS[tm[2].toLowerCase()];
    if (month) {
      const r = toIso(expandYear(Number(tm[3])), month, Number(tm[1]));
      if (r) return r;
    }
    throw new Error(`"${s}" is not a valid calendar date`);
  }

  const tmf = TEXT_MONTH_FIRST_RE.exec(s);
  if (tmf) {
    const month = MONTHS[tmf[1].toLowerCase()];
    if (month) {
      const r = toIso(expandYear(Number(tmf[3])), month, Number(tmf[2]));
      if (r) return r;
    }
    throw new Error(`"${s}" is not a valid calendar date`);
  }

  const m = SEPARATED_RE.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);

    // A four-digit leading component is unambiguously a year.
    if (m[1].length === 4) {
      const r = toIso(a, b, c);
      if (r) return r;
      throw new Error(`"${s}" is not a valid calendar date`);
    }

    const year = expandYear(c);
    let day: number;
    let month: number;

    if (order === 'mdy') {
      month = a;
      day = b;
    } else {
      day = a;
      month = b;
    }

    // Self-correct an impossible reading rather than rejecting a clear date.
    if (month > 12 && day <= 12) {
      [day, month] = [month, day];
    }

    const r = toIso(year, month, day);
    if (r) return r;
    throw new Error(`"${s}" is not a valid calendar date`);
  }

  const native = Date.parse(s);
  if (!Number.isNaN(native)) {
    const dt = new Date(native);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }

  throw new Error(`"${s}" could not be read as a date`);
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  // Clamp to the last day of the target month (31 Jan + 1 month = 28/29 Feb).
  const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, lastDay));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(last)}`;
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Formats an ISO date for display in exports: 05 Apr 2025. */
export function formatDisplayDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (!y || !m || !d) return iso;
  return `${pad(d)} ${names[m - 1]} ${y}`;
}
