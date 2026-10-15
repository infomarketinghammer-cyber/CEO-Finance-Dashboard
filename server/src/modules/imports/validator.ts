import { getCategory, type CategoryDef, type FieldDef } from './categories.js';
import type { SheetData } from './workbook.js';
import type { ColumnMapping } from './mapper.js';
import { parseAmount, hasCreditMarker, hasDebitMarker, MoneyError, type Minor } from '../../lib/money.js';
import { parseDate, detectDateFormat, type DateOrder } from '../../lib/dates.js';
import { dedupeKey, normalizeName } from '../../lib/ids.js';

export interface RowIssue {
  field?: string;
  column?: string;
  message: string;
}

export interface ParsedRow {
  rowNumber: number;
  values: Record<string, any>;
  raw: Record<string, unknown>;
  errors: RowIssue[];
  warnings: RowIssue[];
}

export interface VoucherGroup {
  key: string;
  dedupeKey: string;
  voucherDate: string;
  voucherType: string | null;
  voucherNumber: string | null;
  narration: string | null;
  reference: string | null;
  externalId: string | null;
  lines: {
    ledgerName: string;
    debit: Minor;
    credit: Minor;
    costCentre: string | null;
    narration: string | null;
    rowNumber: number;
  }[];
  totalDebit: Minor;
  totalCredit: Minor;
  imbalance: Minor;
  rowNumbers: number[];
}

export interface ImportOptions {
  /** Per-field override of the detected day/month order. */
  dateOrder?: Record<string, DateOrder>;
  /** Blank leading cells inherit the row above (Tally merged-cell exports). */
  forwardFill?: boolean;
  /** For a single signed amount column: does a negative value mean a credit? */
  negativeMeansCredit?: boolean;
  /** Side assumed for an opening balance that carries no sign or marker. */
  defaultOpeningSide?: 'debit' | 'credit';
  /** Vouchers whose debits and credits differ by at most this many minor units are accepted. */
  imbalanceToleranceMinor?: number;
}

export interface ValidationReport {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  warningRows: number;
  duplicateRowsInFile: number;
  duplicateRecordsInDatabase: number;
  blankRowsSkipped: number;
  missingRequired: { field: string; label: string; count: number }[];
  invalidDates: number;
  invalidAmounts: number;
  unmappedAccounts: string[];
  newLedgers: string[];
  imbalancedVouchers: { voucherNumber: string | null; date: string; imbalance: number; rowNumbers: number[] }[];
  dateRange: { from: string; to: string } | null;
  detectedDateOrders: Record<string, { order: DateOrder; ambiguous: boolean }>;
  notes: string[];
}

export interface ParsedDataset {
  category: string;
  rows: ParsedRow[];
  validRows: ParsedRow[];
  rejectedRows: ParsedRow[];
  vouchers?: VoucherGroup[];
  report: ValidationReport;
}

// --------------------------------------------------------------- field parsing

function readField(
  field: FieldDef,
  rawRow: Record<string, unknown>,
  mapping: ColumnMapping,
  dateOrders: Record<string, DateOrder>,
): { value: any; issue?: RowIssue } {
  const header = mapping[field.key];
  if (!header) return { value: null };

  const raw = rawRow[header];
  const isBlank = raw === null || raw === undefined || String(raw).trim() === '';

  if (isBlank) {
    if (field.required) {
      return { value: null, issue: { field: field.key, column: header, message: `${field.label} is empty` } };
    }
    return { value: null };
  }

  switch (field.type) {
    case 'date': {
      try {
        const iso = parseDate(raw, dateOrders[field.key] ?? 'dmy');
        return { value: iso };
      } catch (err) {
        return {
          value: null,
          issue: { field: field.key, column: header, message: `${field.label}: ${err instanceof Error ? err.message : 'unreadable date'}` },
        };
      }
    }
    case 'amount': {
      try {
        const minor = parseAmount(raw);
        return { value: minor };
      } catch (err) {
        return {
          value: null,
          issue: {
            field: field.key,
            column: header,
            message: `${field.label}: ${err instanceof MoneyError ? err.message : 'unreadable amount'}`,
          },
        };
      }
    }
    case 'number': {
      const n = Number(String(raw).replace(/,/g, '').trim());
      if (!Number.isFinite(n)) {
        return { value: null, issue: { field: field.key, column: header, message: `${field.label} is not a number: "${String(raw)}"` } };
      }
      return { value: n };
    }
    case 'boolean': {
      const s = String(raw).trim().toLowerCase();
      if (['yes', 'y', 'true', '1', 'active', 'enabled'].includes(s)) return { value: true };
      if (['no', 'n', 'false', '0', 'inactive', 'disabled'].includes(s)) return { value: false };
      return { value: null, issue: { field: field.key, column: header, message: `${field.label}: expected Yes or No, found "${String(raw)}"` } };
    }
    case 'enum': {
      const s = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
      const allowed = field.enumValues ?? [];
      if (allowed.includes(s)) return { value: s };
      // Common shorthands.
      const shorthand: Record<string, string> = {
        dr: 'debit', d: 'debit', cr: 'credit', c: 'credit',
        in: 'inflow', out: 'outflow', receipt: 'inflow', payment: 'outflow',
        m: 'monthly', q: 'quarterly', y: 'yearly', annual: 'yearly', annually: 'yearly',
        halfyearly: 'half_yearly', semiannual: 'half_yearly', fortnightly: 'weekly',
        oneoff: 'one_off', onetime: 'one_off', variable: 'recurring_variable',
      };
      if (shorthand[s] && allowed.includes(shorthand[s])) return { value: shorthand[s] };
      return {
        value: null,
        issue: {
          field: field.key,
          column: header,
          message: `${field.label}: "${String(raw)}" is not one of ${allowed.join(', ')}`,
        },
      };
    }
    default: {
      const s = String(raw).trim();
      return { value: s === '' ? null : s };
    }
  }
}

/** Decides the day/month order for each mapped date column by scanning the data. */
function resolveDateOrders(
  category: CategoryDef,
  sheet: SheetData,
  mapping: ColumnMapping,
  overrides: Record<string, DateOrder> = {},
): { orders: Record<string, DateOrder>; detected: Record<string, { order: DateOrder; ambiguous: boolean }> } {
  const orders: Record<string, DateOrder> = {};
  const detected: Record<string, { order: DateOrder; ambiguous: boolean }> = {};

  for (const field of category.fields) {
    if (field.type !== 'date') continue;
    const header = mapping[field.key];
    if (!header) continue;

    const values = sheet.rows.map((r) => r[header]);
    const d = detectDateFormat(values);
    detected[field.key] = { order: d.order, ambiguous: d.ambiguous };
    orders[field.key] = overrides[field.key] ?? (d.order === 'unknown' ? 'dmy' : d.order);
  }

  return { orders, detected };
}

/**
 * Carries blank leading cells down from the row above.
 *
 * Tally's day book export prints the date, voucher type and voucher number once
 * per voucher and leaves them blank on the remaining lines. Without this the
 * second and third lines of every voucher are rejected for a missing date.
 */
function applyForwardFill(sheet: SheetData, mapping: ColumnMapping, fieldKeys: string[]): Record<string, unknown>[] {
  const headers = fieldKeys.map((k) => mapping[k]).filter((h): h is string => Boolean(h));
  if (!headers.length) return sheet.rows;

  const filled: Record<string, unknown>[] = [];
  const carry: Record<string, unknown> = {};

  for (const row of sheet.rows) {
    const next = { ...row };
    for (const h of headers) {
      const v = next[h];
      if (v === null || v === undefined || String(v).trim() === '') {
        if (carry[h] !== undefined) next[h] = carry[h];
      } else {
        carry[h] = v;
      }
    }
    filled.push(next);
  }

  return filled;
}

// ------------------------------------------------------------------ main pass

export interface ValidateArgs {
  categoryKey: string;
  sheet: SheetData;
  mapping: ColumnMapping;
  options?: ImportOptions;
  /** Normalised ledger names already present for the company. */
  knownLedgers?: Set<string>;
  /** Dedupe keys already committed for this company and category. */
  existingKeys?: Set<string>;
}

export function validateDataset(args: ValidateArgs): ParsedDataset {
  const category = getCategory(args.categoryKey);
  const options = args.options ?? {};
  const knownLedgers = args.knownLedgers ?? new Set<string>();
  const existingKeys = args.existingKeys ?? new Set<string>();

  const { orders, detected } = resolveDateOrders(category, args.sheet, args.mapping, options.dateOrder);

  const sourceRows =
    category.supportsForwardFill && options.forwardFill !== false
      ? applyForwardFill(args.sheet, args.mapping, ['voucherDate', 'voucherType', 'voucherNumber'])
      : args.sheet.rows;

  const rows: ParsedRow[] = [];
  const missingRequiredCounts = new Map<string, number>();
  let invalidDates = 0;
  let invalidAmounts = 0;

  for (let i = 0; i < sourceRows.length; i++) {
    const raw = sourceRows[i];
    const rowNumber = args.sheet.rowNumbers[i] ?? i + 1;
    const values: Record<string, any> = {};
    const errors: RowIssue[] = [];
    const warnings: RowIssue[] = [];

    for (const field of category.fields) {
      const { value, issue } = readField(field, raw, args.mapping, orders);
      values[field.key] = value;
      if (issue) {
        errors.push(issue);
        if (field.type === 'date') invalidDates++;
        if (field.type === 'amount') invalidAmounts++;
        if (field.required && value === null) {
          missingRequiredCounts.set(field.key, (missingRequiredCounts.get(field.key) ?? 0) + 1);
        }
      }
    }

    // Category-specific derivation and cross-field checks.
    applyCategoryRules(category, values, raw, args.mapping, errors, warnings, options);

    rows.push({ rowNumber, values, raw: args.sheet.rows[i] ?? raw, errors, warnings });
  }

  // ------------------------------------------- dedupe and category assembly
  let vouchers: VoucherGroup[] | undefined;
  let duplicateRowsInFile = 0;
  let duplicateRecordsInDatabase = 0;

  if (args.categoryKey === 'vouchers') {
    const grouped = groupVouchers(rows, options);
    vouchers = grouped.vouchers;
    duplicateRowsInFile = grouped.duplicateCount;
    for (const v of vouchers) {
      if (existingKeys.has(v.dedupeKey)) duplicateRecordsInDatabase++;
    }
  } else {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.errors.length) continue;
      const key = buildDedupeKey(args.categoryKey, row.values);
      row.values.__dedupeKey = key;
      if (seen.has(key)) {
        duplicateRowsInFile++;
        row.warnings.push({ message: 'This row repeats an earlier row in the same file' });
      } else {
        seen.add(key);
      }
      if (existingKeys.has(key)) {
        duplicateRecordsInDatabase++;
        row.warnings.push({ message: 'A matching record already exists from a previous import' });
      }
    }
  }

  // ---------------------------------------------------- ledger reconciliation
  const referencedLedgers = new Set<string>();
  for (const row of rows) {
    const name = row.values.ledgerName ?? row.values.partyName ?? null;
    if (typeof name === 'string' && name.trim()) referencedLedgers.add(normalizeName(name));
  }
  const newLedgers = [...referencedLedgers].filter((n) => !knownLedgers.has(n));

  // Ledgers referenced by transactions that have no master record yet. For voucher
  // imports these are created on commit; the count is surfaced either way so the
  // user is never surprised by accounts appearing in their chart.
  const unmappedAccounts = newLedgers.slice(0, 200);

  const imbalancedVouchers = (vouchers ?? [])
    .filter((v) => v.imbalance !== 0)
    .slice(0, 100)
    .map((v) => ({ voucherNumber: v.voucherNumber, date: v.voucherDate, imbalance: v.imbalance, rowNumbers: v.rowNumbers }));

  const validRows = rows.filter((r) => r.errors.length === 0);
  const rejectedRows = rows.filter((r) => r.errors.length > 0);

  const dates = validRows
    .map((r) => r.values.voucherDate ?? r.values.expenseDate ?? r.values.documentDate ?? r.values.expectedDate ?? r.values.periodStart)
    .filter((d): d is string => typeof d === 'string');

  const notes: string[] = [];
  if (category.supportsForwardFill && options.forwardFill !== false) {
    notes.push('Blank date, voucher type and voucher number cells were carried down from the row above, which is how most accounting exports lay out multi-line vouchers.');
  }
  for (const [fieldKey, d] of Object.entries(detected)) {
    if (d.ambiguous) {
      const label = category.fields.find((f) => f.key === fieldKey)?.label ?? fieldKey;
      notes.push(`Dates in "${label}" are ambiguous — no value had a day above 12. They are being read as day-first (DD/MM/YYYY).`);
    }
  }

  const report: ValidationReport = {
    totalRows: rows.length,
    validRows: validRows.length,
    invalidRows: rejectedRows.length,
    warningRows: rows.filter((r) => r.errors.length === 0 && r.warnings.length > 0).length,
    duplicateRowsInFile,
    duplicateRecordsInDatabase,
    blankRowsSkipped: args.sheet.blankRowsSkipped,
    missingRequired: [...missingRequiredCounts.entries()].map(([field, count]) => ({
      field,
      label: category.fields.find((f) => f.key === field)?.label ?? field,
      count,
    })),
    invalidDates,
    invalidAmounts,
    unmappedAccounts,
    newLedgers,
    imbalancedVouchers,
    dateRange: dates.length ? { from: dates.reduce((a, b) => (a < b ? a : b)), to: dates.reduce((a, b) => (a > b ? a : b)) } : null,
    detectedDateOrders: detected,
    notes,
  };

  return { category: args.categoryKey, rows, validRows, rejectedRows, vouchers, report };
}

// -------------------------------------------------------- category-specific

function applyCategoryRules(
  category: CategoryDef,
  values: Record<string, any>,
  raw: Record<string, unknown>,
  mapping: ColumnMapping,
  errors: RowIssue[],
  warnings: RowIssue[],
  options: ImportOptions,
): void {
  switch (category.key) {
    case 'vouchers': {
      resolveDebitCredit(values, raw, mapping, errors, warnings, options);
      break;
    }

    case 'opening_balances': {
      resolveDebitCredit(values, raw, mapping, errors, warnings, options);
      if (values.debit === 0 && values.credit === 0 && values.amount === null) {
        errors.push({ message: 'No opening amount was supplied' });
      }
      // A single `amount` column with an explicit side.
      if (values.amount !== null && values.debit === 0 && values.credit === 0) {
        const side = values.side ?? (values.amount < 0 ? 'credit' : options.defaultOpeningSide ?? 'debit');
        const magnitude = Math.abs(values.amount);
        if (side === 'credit') values.credit = magnitude;
        else values.debit = magnitude;
      }
      values.side = values.credit > 0 ? 'credit' : 'debit';
      values.resolvedAmount = values.credit > 0 ? values.credit : values.debit;
      break;
    }

    case 'chart_of_accounts': {
      if (values.openingBalance !== null) {
        const header = mapping.openingBalance;
        const rawVal = header ? raw[header] : null;
        let side = values.openingSide as 'debit' | 'credit' | null;
        if (!side) {
          if (hasCreditMarker(rawVal)) side = 'credit';
          else if (hasDebitMarker(rawVal)) side = 'debit';
          else side = values.openingBalance < 0 ? 'credit' : 'debit';
        }
        values.openingSide = side;
        values.openingBalance = Math.abs(values.openingBalance);
      }
      break;
    }

    case 'receivables':
    case 'payables': {
      const amount = values.amount;
      const paid = values.paidMinor;
      let outstanding = values.outstanding;

      if (outstanding === null && amount !== null) {
        outstanding = amount - (paid ?? 0);
      }
      if (outstanding === null) {
        errors.push({ message: 'Neither an outstanding amount nor an invoice amount was supplied' });
        break;
      }

      values.outstanding = Math.abs(outstanding);
      values.amount = amount === null ? values.outstanding : Math.abs(amount);
      values.paidMinor = paid === null ? null : Math.abs(paid);

      if (amount !== null && paid !== null && values.outstanding !== null) {
        const expected = Math.abs(amount) - Math.abs(paid);
        if (Math.abs(expected - values.outstanding) > 1) {
          warnings.push({
            message: `The outstanding amount does not equal invoice minus paid (difference of ${(Math.abs(expected - values.outstanding) / 100).toFixed(2)}). The supplied outstanding amount is used as-is.`,
          });
        }
      }

      if (!values.dueDate) {
        // Recorded as a fact, not filled in. Ageing treats these separately.
        warnings.push({ message: 'No due date supplied — this record is excluded from overdue ageing buckets' });
      } else if (values.documentDate && values.dueDate < values.documentDate) {
        warnings.push({ message: 'The due date falls before the document date' });
      }

      if (values.outstanding === 0) {
        warnings.push({ message: 'Outstanding amount is zero — this document appears settled' });
      }
      break;
    }

    case 'expenses': {
      if (values.amount !== null && values.amount < 0) {
        warnings.push({ message: 'A negative expense amount was supplied; it is recorded as a credit note or refund' });
      }
      if (!values.expenseType) values.expenseType = 'one_off';
      break;
    }

    case 'budgets': {
      if (values.periodStart && values.periodEnd && values.periodEnd < values.periodStart) {
        errors.push({ message: 'The budget period ends before it starts' });
      }
      if (values.amount !== null && values.amount < 0) {
        errors.push({ message: 'A budget amount cannot be negative' });
      }
      if (!values.periodType && values.periodStart && values.periodEnd) {
        values.periodType = inferPeriodType(values.periodStart, values.periodEnd);
      }
      break;
    }

    case 'recurring_expenses': {
      if (values.amount !== null && values.amount < 0) {
        errors.push({ message: 'A recurring expense amount cannot be negative' });
      }
      if (!values.nextDueDate && values.startDate) values.nextDueDate = values.startDate;
      if (values.endDate && values.startDate && values.endDate < values.startDate) {
        errors.push({ message: 'The end date falls before the start date' });
      }
      if (values.isActive === null) values.isActive = true;
      if (values.isVariable === null) values.isVariable = false;
      break;
    }

    case 'commitments': {
      if (values.amount !== null && values.amount < 0) {
        // A negative inflow is an outflow; record the intent rather than rejecting.
        values.direction = values.direction === 'inflow' ? 'outflow' : 'inflow';
        values.amount = Math.abs(values.amount);
        warnings.push({ message: 'A negative amount was supplied; the direction has been reversed accordingly' });
      }
      break;
    }

    case 'stock_items': {
      if (values.value === null && values.quantity !== null && values.rate !== null) {
        values.value = Math.round(values.quantity * values.rate);
      }
      if (values.value !== null && values.value < 0) {
        warnings.push({ message: 'Negative stock value supplied' });
      }
      break;
    }

    case 'customers': {
      if (values.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(String(values.gstin).toUpperCase())) {
        warnings.push({ field: 'gstin', message: `"${values.gstin}" is not a valid 15-character GSTIN; it is stored but will not be used for matching` });
        values.gstinValid = false;
      } else if (values.gstin) {
        values.gstin = String(values.gstin).toUpperCase();
        values.gstinValid = true;
      }
      break;
    }

    default:
      break;
  }
}

/**
 * Normalises every way a workbook can express a debit and a credit into a pair of
 * non-negative minor-unit amounts.
 *
 * Handled: separate Debit and Credit columns; a single signed Amount column; a
 * single Amount column with a Dr/Cr marker; and an Amount column accompanied by a
 * separate side column.
 */
function resolveDebitCredit(
  values: Record<string, any>,
  raw: Record<string, unknown>,
  mapping: ColumnMapping,
  errors: RowIssue[],
  warnings: RowIssue[],
  options: ImportOptions,
): void {
  const hasDebitCol = Boolean(mapping.debit);
  const hasCreditCol = Boolean(mapping.credit);
  const hasAmountCol = Boolean(mapping.amount);

  let debit: Minor = 0;
  let credit: Minor = 0;

  if (hasDebitCol || hasCreditCol) {
    const d = values.debit ?? 0;
    const c = values.credit ?? 0;

    if (d !== 0 && c !== 0) {
      warnings.push({ message: 'This line carries both a debit and a credit; the net of the two is recorded' });
      const net = d - c;
      if (net >= 0) {
        debit = net;
        credit = 0;
      } else {
        debit = 0;
        credit = -net;
      }
    } else if (d < 0) {
      credit = -d;
    } else if (c < 0) {
      debit = -c;
    } else {
      debit = d;
      credit = c;
    }
  }

  if (debit === 0 && credit === 0 && hasAmountCol && values.amount !== null) {
    const header = mapping.amount!;
    const rawVal = raw[header];
    const magnitude = Math.abs(values.amount);

    if (hasCreditMarker(rawVal)) {
      credit = magnitude;
    } else if (hasDebitMarker(rawVal)) {
      debit = magnitude;
    } else if (values.side === 'credit') {
      credit = magnitude;
    } else if (values.side === 'debit') {
      debit = magnitude;
    } else {
      const negIsCredit = options.negativeMeansCredit !== false;
      if (values.amount < 0) {
        if (negIsCredit) credit = magnitude;
        else debit = magnitude;
      } else {
        if (negIsCredit) debit = magnitude;
        else credit = magnitude;
      }
    }
  }

  values.debit = debit;
  values.credit = credit;

  if (debit === 0 && credit === 0) {
    errors.push({ message: 'No debit or credit amount on this line' });
  }
}

function inferPeriodType(start: string, end: string): 'month' | 'quarter' | 'year' | 'custom' {
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  if (days >= 28 && days <= 31) return 'month';
  if (days >= 89 && days <= 92) return 'quarter';
  if (days >= 360 && days <= 371) return 'year';
  return 'custom';
}

// ------------------------------------------------------------------ vouchers

function groupVouchers(rows: ParsedRow[], options: ImportOptions): { vouchers: VoucherGroup[]; duplicateCount: number } {
  const tolerance = options.imbalanceToleranceMinor ?? 0;
  const byKey = new Map<string, VoucherGroup>();
  let duplicateCount = 0;

  for (const row of rows) {
    if (row.errors.length) continue;

    const date = row.values.voucherDate as string;
    const type = (row.values.voucherType as string) ?? null;
    const number = (row.values.voucherNumber as string) ?? null;
    const externalId = (row.values.externalId as string) ?? null;

    // Group identity: the source's own id when it has one, otherwise the natural
    // key of a voucher. Row position is never part of it.
    const groupKey = externalId
      ? `ext:${externalId}`
      : `nat:${date}|${normalizeName(type ?? '')}|${normalizeName(number ?? '')}`;

    let group = byKey.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        dedupeKey: '',
        voucherDate: date,
        voucherType: type,
        voucherNumber: number,
        narration: (row.values.narration as string) ?? null,
        reference: (row.values.reference as string) ?? null,
        externalId,
        lines: [],
        totalDebit: 0,
        totalCredit: 0,
        imbalance: 0,
        rowNumbers: [],
      };
      byKey.set(groupKey, group);
    }

    group.lines.push({
      ledgerName: row.values.ledgerName as string,
      debit: row.values.debit as Minor,
      credit: row.values.credit as Minor,
      costCentre: (row.values.costCentre as string) ?? null,
      narration: (row.values.narration as string) ?? null,
      rowNumber: row.rowNumber,
    });
    group.totalDebit += row.values.debit as Minor;
    group.totalCredit += row.values.credit as Minor;
    group.rowNumbers.push(row.rowNumber);
    if (!group.narration && row.values.narration) group.narration = row.values.narration as string;
  }

  const vouchers = [...byKey.values()];

  for (const v of vouchers) {
    const diff = v.totalDebit - v.totalCredit;
    v.imbalance = Math.abs(diff) <= tolerance ? 0 : diff;

    // The identity includes the money and the line count, so two different
    // vouchers that happen to share a number are not collapsed into one.
    v.dedupeKey = v.externalId
      ? dedupeKey(['voucher', 'ext', v.externalId])
      : dedupeKey(['voucher', v.voucherDate, v.voucherType, v.voucherNumber, v.totalDebit, v.totalCredit, v.lines.length]);

    if (v.imbalance !== 0) {
      for (const line of v.lines) {
        const row = rows.find((r) => r.rowNumber === line.rowNumber);
        row?.warnings.push({
          message: `Voucher ${v.voucherNumber ?? '(no number)'} dated ${v.voucherDate} does not balance: debits ${(v.totalDebit / 100).toFixed(2)} against credits ${(v.totalCredit / 100).toFixed(2)}`,
        });
      }
    }
  }

  // Two groups resolving to the same dedupe key means the same voucher appears
  // twice in the file under different groupings.
  const keys = new Set<string>();
  for (const v of vouchers) {
    if (keys.has(v.dedupeKey)) duplicateCount++;
    else keys.add(v.dedupeKey);
  }

  return { vouchers, duplicateCount };
}

// ------------------------------------------------------------- dedupe keys

export function buildDedupeKey(categoryKey: string, values: Record<string, any>): string {
  const ext = values.externalId;
  switch (categoryKey) {
    case 'chart_of_accounts':
      return dedupeKey(['ledger', normalizeName(values.ledgerName ?? '')]);
    case 'ledger_groups':
      return dedupeKey(['group', normalizeName(values.groupName ?? '')]);
    case 'opening_balances':
      return dedupeKey(['opening', normalizeName(values.ledgerName ?? '')]);
    case 'receivables':
      return ext
        ? dedupeKey(['ar', 'ext', ext])
        : dedupeKey(['ar', normalizeName(values.partyName ?? ''), values.documentNumber, values.documentDate, values.amount]);
    case 'payables':
      return ext
        ? dedupeKey(['ap', 'ext', ext])
        : dedupeKey(['ap', normalizeName(values.partyName ?? ''), values.documentNumber, values.documentDate, values.amount]);
    case 'cost_centres':
      return dedupeKey(['cc', normalizeName(values.name ?? '')]);
    case 'stock_items':
      return dedupeKey(['stock', normalizeName(values.name ?? '')]);
    case 'expenses':
      return dedupeKey([
        'exp',
        values.expenseDate,
        normalizeName(values.category ?? ''),
        normalizeName(values.vendor ?? ''),
        values.amount,
        normalizeName(values.reference ?? ''),
      ]);
    case 'budgets':
      return dedupeKey([
        'budget',
        normalizeName(values.category ?? ''),
        values.periodStart,
        values.periodEnd,
        normalizeName(values.costCentre ?? ''),
      ]);
    case 'recurring_expenses':
      return dedupeKey(['rec', normalizeName(values.name ?? ''), values.frequency, values.startDate]);
    case 'commitments':
      return dedupeKey(['commit', normalizeName(values.name ?? ''), values.expectedDate, values.amount]);
    case 'customers':
      return values.gstin && values.gstinValid !== false
        ? dedupeKey(['cust', 'gstin', values.gstin])
        : dedupeKey(['cust', normalizeName(values.customerName ?? '')]);
    case 'company_details':
      return dedupeKey(['company', normalizeName(values.name ?? '')]);
    default:
      return dedupeKey([categoryKey, JSON.stringify(values)]);
  }
}
