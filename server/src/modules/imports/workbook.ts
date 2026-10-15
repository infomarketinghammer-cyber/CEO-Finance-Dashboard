import XLSX from 'xlsx';
import { badRequest } from '../../lib/errors.js';
import { detectDateFormat, type DateFormatDetection } from '../../lib/dates.js';
import { parseAmount } from '../../lib/money.js';

export interface ColumnProfile {
  header: string;
  index: number;
  nonEmptyCount: number;
  emptyCount: number;
  distinctCount: number;
  /** Best guess at what the column holds, used to warn about likely mis-mappings. */
  detectedType: 'date' | 'number' | 'amount' | 'text' | 'empty' | 'mixed';
  dateFormat?: DateFormatDetection;
  numericFormat?: { hasThousandSeparators: boolean; hasCurrencySymbols: boolean; hasParenthesesNegatives: boolean; hasDrCrMarkers: boolean };
  samples: string[];
  unreadableSamples: string[];
}

export interface SheetSummary {
  name: string;
  rowCount: number;
  columnCount: number;
  headerRowIndex: number;
  headers: string[];
  isEmpty: boolean;
}

export interface SheetData {
  name: string;
  headers: string[];
  headerRowIndex: number;
  rows: Record<string, unknown>[];
  /** 1-based spreadsheet row number for each entry in `rows`, for error reporting. */
  rowNumbers: number[];
  columns: ColumnProfile[];
  totalRows: number;
  blankRowsSkipped: number;
  duplicateRowCount: number;
}

const MAX_SCAN_ROWS_FOR_HEADER = 25;

/** Parses the bytes of an uploaded workbook. Supports .xlsx, .xls and .csv. */
export function readWorkbook(buffer: Buffer, fileName: string): XLSX.WorkBook {
  try {
    return XLSX.read(buffer, {
      type: 'buffer',
      cellDates: true, // real Date objects rather than serial numbers
      cellNF: false,
      cellText: false,
      raw: false,
      dense: false,
    });
  } catch (err) {
    throw badRequest(
      `"${fileName}" could not be opened as a spreadsheet. Check that it is a valid .xlsx, .xls or .csv file and is not password protected.`,
      { reason: err instanceof Error ? err.message : String(err) },
    );
  }
}

export function summariseSheets(wb: XLSX.WorkBook): SheetSummary[] {
  return wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const grid = sheetToGrid(sheet);
    const headerRowIndex = findHeaderRow(grid);
    const headers = headerRowIndex >= 0 ? dedupeHeaders(grid[headerRowIndex].map(cellToHeader)) : [];
    const dataRows = headerRowIndex >= 0 ? countDataRows(grid, headerRowIndex) : 0;
    return {
      name,
      rowCount: dataRows,
      columnCount: headers.length,
      headerRowIndex,
      headers,
      isEmpty: dataRows === 0 || headers.length === 0,
    };
  });
}

function sheetToGrid(sheet: XLSX.WorkSheet): unknown[][] {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: true,
    defval: null,
    raw: false,
  });
  return grid as unknown[][];
}

function cellToHeader(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

/**
 * Finds the header row.
 *
 * Exports frequently open with a company name, a report title and a date range
 * before the real table starts, so the first row is usually not the header. The
 * header is taken to be the earliest row with at least two distinct non-empty text
 * cells that is followed by a row of comparable width — a title line fails the
 * second test because the row beneath it is narrow or blank.
 */
function findHeaderRow(grid: unknown[][]): number {
  const limit = Math.min(grid.length, MAX_SCAN_ROWS_FOR_HEADER);
  let best = -1;
  let bestScore = 0;

  for (let i = 0; i < limit; i++) {
    const row = grid[i] ?? [];
    const filled = row.filter((c) => c !== null && c !== undefined && String(c).trim() !== '');
    if (filled.length < 2) continue;

    const textCells = filled.filter((c) => typeof c === 'string' && !/^-?[\d,.\s]+$/.test(String(c).trim()));
    if (textCells.length < 2) continue;

    const distinct = new Set(filled.map((c) => String(c).trim().toLowerCase())).size;
    if (distinct < 2) continue;

    // How much data follows this row?
    let following = 0;
    for (let j = i + 1; j < Math.min(grid.length, i + 6); j++) {
      const r = grid[j] ?? [];
      if (r.some((c) => c !== null && c !== undefined && String(c).trim() !== '')) following++;
    }
    if (following === 0) continue;

    const score = distinct * 2 + textCells.length + following;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
    // A strong header near the top wins; stop once one is clearly good.
    if (best === i && textCells.length >= 3 && following >= 3) break;
  }

  return best;
}

function countDataRows(grid: unknown[][], headerRowIndex: number): number {
  let n = 0;
  for (let i = headerRowIndex + 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (row.some((c) => c !== null && c !== undefined && String(c).trim() !== '')) n++;
  }
  return n;
}

/** Guarantees unique, non-empty header names so rows can be keyed safely. */
function dedupeHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h || `Column ${i + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

export interface ReadSheetOptions {
  /** Override the detected header row (0-based grid index). */
  headerRowIndex?: number;
  /** Cap the rows returned; used for the preview step. */
  maxRows?: number;
}

export function readSheet(wb: XLSX.WorkBook, sheetName: string, opts: ReadSheetOptions = {}): SheetData {
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw badRequest(`The workbook has no sheet named "${sheetName}".`);

  const grid = sheetToGrid(sheet);
  const headerRowIndex = opts.headerRowIndex ?? findHeaderRow(grid);

  if (headerRowIndex < 0) {
    throw badRequest(
      `No column headings could be found on sheet "${sheetName}". The sheet appears to be empty, or the headings are further down than the first 25 rows.`,
    );
  }

  const headers = dedupeHeaders((grid[headerRowIndex] ?? []).map(cellToHeader));
  if (!headers.length) throw badRequest(`Sheet "${sheetName}" has no usable column headings.`);

  const rows: Record<string, unknown>[] = [];
  const rowNumbers: number[] = [];
  const columnValues: unknown[][] = headers.map(() => []);
  let blankRowsSkipped = 0;

  const limit = opts.maxRows ? headerRowIndex + 1 + opts.maxRows : grid.length;

  for (let i = headerRowIndex + 1; i < Math.min(grid.length, limit); i++) {
    const raw = grid[i] ?? [];
    const hasContent = raw.some((c) => c !== null && c !== undefined && String(c).trim() !== '');
    if (!hasContent) {
      blankRowsSkipped++;
      continue;
    }

    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      const v = raw[idx] ?? null;
      obj[h] = v === '' ? null : v;
      columnValues[idx].push(v);
    });

    rows.push(obj);
    rowNumbers.push(i + 1); // spreadsheet rows are 1-based
  }

  const columns = headers.map((header, index) => profileColumn(header, index, columnValues[index]));

  // Identical rows, compared on their full content.
  const seen = new Set<string>();
  let duplicateRowCount = 0;
  for (const row of rows) {
    const key = JSON.stringify(headers.map((h) => normaliseForCompare(row[h])));
    if (seen.has(key)) duplicateRowCount++;
    else seen.add(key);
  }

  return {
    name: sheetName,
    headers,
    headerRowIndex,
    rows,
    rowNumbers,
    columns,
    totalRows: rows.length,
    blankRowsSkipped,
    duplicateRowCount,
  };
}

function normaliseForCompare(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim().toLowerCase();
}

function profileColumn(header: string, index: number, values: unknown[]): ColumnProfile {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  const distinct = new Set(nonEmpty.map(normaliseForCompare)).size;

  const samples = nonEmpty.slice(0, 5).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v)));
  const unreadableSamples: string[] = [];

  if (nonEmpty.length === 0) {
    return {
      header,
      index,
      nonEmptyCount: 0,
      emptyCount: values.length,
      distinctCount: 0,
      detectedType: 'empty',
      samples: [],
      unreadableSamples: [],
    };
  }

  let dateLike = 0;
  let amountLike = 0;
  let textLike = 0;
  let hasThousandSeparators = false;
  let hasCurrencySymbols = false;
  let hasParenthesesNegatives = false;
  let hasDrCrMarkers = false;

  for (const v of nonEmpty.slice(0, 500)) {
    if (v instanceof Date) {
      dateLike++;
      continue;
    }
    const s = String(v).trim();

    if (/[₹$€£¥]/.test(s)) hasCurrencySymbols = true;
    if (/^\(.*\)$/.test(s)) hasParenthesesNegatives = true;
    if (/\b(dr|cr)\.?\s*$/i.test(s)) hasDrCrMarkers = true;
    if (/\d,\d/.test(s)) hasThousandSeparators = true;

    if (/^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}[\s\-/][a-z]{3,9}[\s\-/]\d{2,4}$/i.test(s)) {
      dateLike++;
      continue;
    }

    try {
      const parsed = parseAmount(s);
      if (parsed !== null) {
        amountLike++;
        continue;
      }
    } catch {
      /* not an amount */
    }

    textLike++;
    if (unreadableSamples.length < 3 && /\d/.test(s) && !/^[a-z\s]+$/i.test(s)) {
      unreadableSamples.push(s);
    }
  }

  const total = dateLike + amountLike + textLike || 1;
  let detectedType: ColumnProfile['detectedType'];
  if (dateLike / total > 0.7) detectedType = 'date';
  else if (amountLike / total > 0.7) detectedType = 'amount';
  else if (textLike / total > 0.7) detectedType = 'text';
  else detectedType = 'mixed';

  const profile: ColumnProfile = {
    header,
    index,
    nonEmptyCount: nonEmpty.length,
    emptyCount: values.length - nonEmpty.length,
    distinctCount: distinct,
    detectedType,
    samples,
    unreadableSamples,
  };

  if (detectedType === 'date' || dateLike > 0) {
    profile.dateFormat = detectDateFormat(nonEmpty);
  }
  if (detectedType === 'amount' || amountLike > 0) {
    profile.numericFormat = { hasThousandSeparators, hasCurrencySymbols, hasParenthesesNegatives, hasDrCrMarkers };
  }

  return profile;
}
