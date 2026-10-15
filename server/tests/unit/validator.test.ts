/**
 * Import validation (§6 Step 5, §29 "Excel imports").
 *
 * The validator is where a spreadsheet becomes accounting data, and where the
 * product's central promise is kept: nothing is silently discarded, nothing
 * missing is invented, and a row that cannot be read says why.
 */
import { describe, it, expect } from 'vitest';
import { validateDataset, buildDedupeKey } from '../../src/modules/imports/validator.js';
import type { SheetData } from '../../src/modules/imports/workbook.js';
import type { ColumnMapping } from '../../src/modules/imports/mapper.js';

/** Builds a SheetData the way the workbook reader would, from plain rows. */
function sheet(headers: string[], rows: Record<string, unknown>[], startRow = 2): SheetData {
  return {
    name: 'Sheet1',
    headers,
    headerRowIndex: startRow - 2,
    rows,
    rowNumbers: rows.map((_, i) => startRow + i),
    columns: headers.map((h) => ({ header: h, index: 0, samples: [], blankCount: 0, distinctCount: 0, inferredType: 'text' }) as any),
    totalRows: rows.length,
    blankRowsSkipped: 0,
    duplicateRowCount: 0,
  };
}

const VOUCHER_MAP: ColumnMapping = {
  voucherDate: 'Date',
  voucherType: 'Type',
  voucherNumber: 'Vch No',
  ledgerName: 'Particulars',
  debit: 'Debit',
  credit: 'Credit',
};

const VOUCHER_HEADERS = ['Date', 'Type', 'Vch No', 'Particulars', 'Debit', 'Credit'];

describe('voucher validation', () => {
  it('groups rows sharing a voucher number into one double-entry voucher', () => {
    const data = sheet(VOUCHER_HEADERS, [
      { Date: '05/04/2025', Type: 'Sales', 'Vch No': 'INV-1', Particulars: 'Acme Traders', Debit: 118000, Credit: '' },
      { Date: '', Type: '', 'Vch No': '', Particulars: 'Sales — Domestic', Debit: '', Credit: 100000 },
      { Date: '', Type: '', 'Vch No': '', Particulars: 'Output GST', Debit: '', Credit: 18000 },
    ]);

    const result = validateDataset({ categoryKey: 'vouchers', sheet: data, mapping: VOUCHER_MAP, options: { dateOrder: { voucherDate: 'dmy' } } });

    expect(result.vouchers).toHaveLength(1);
    expect(result.vouchers![0].lines).toHaveLength(3);
    expect(result.report.imbalancedVouchers).toHaveLength(0);
  });

  it('carries blank continuation cells down, the way Tally day books are laid out', () => {
    const data = sheet(VOUCHER_HEADERS, [
      { Date: '05/04/2025', Type: 'Sales', 'Vch No': 'INV-1', Particulars: 'Acme Traders', Debit: 100, Credit: '' },
      { Date: '', Type: '', 'Vch No': '', Particulars: 'Sales', Debit: '', Credit: 100 },
    ]);

    const result = validateDataset({ categoryKey: 'vouchers', sheet: data, mapping: VOUCHER_MAP, options: { dateOrder: { voucherDate: 'dmy' } } });

    // Both lines belong to one voucher, and the second inherited the date.
    expect(result.vouchers).toHaveLength(1);
    expect(result.vouchers![0].lines).toHaveLength(2);
    expect(result.vouchers![0].voucherDate).toBe('2025-04-05');
    expect(result.vouchers![0].voucherNumber).toBe('INV-1');
  });

  it('flags a voucher whose debits do not equal its credits, instead of balancing it', () => {
    const data = sheet(VOUCHER_HEADERS, [
      { Date: '05/04/2025', Type: 'Journal', 'Vch No': 'JV-1', Particulars: 'A', Debit: 1000, Credit: '' },
      { Date: '', Type: '', 'Vch No': '', Particulars: 'B', Debit: '', Credit: 900 },
    ]);

    const result = validateDataset({ categoryKey: 'vouchers', sheet: data, mapping: VOUCHER_MAP, options: { dateOrder: { voucherDate: 'dmy' } } });

    expect(result.report.imbalancedVouchers).toHaveLength(1);
    expect(result.report.imbalancedVouchers[0].imbalance).toBe(10000); // ₹100 in paise
  });

  it('rejects an unreadable amount rather than importing it as zero', () => {
    const data = sheet(VOUCHER_HEADERS, [
      { Date: '05/04/2025', Type: 'Sales', 'Vch No': 'INV-9', Particulars: 'A', Debit: 'approx 500', Credit: '' },
    ]);

    const result = validateDataset({ categoryKey: 'vouchers', sheet: data, mapping: VOUCHER_MAP, options: { dateOrder: { voucherDate: 'dmy' } } });

    expect(result.report.invalidAmounts).toBeGreaterThan(0);
    const row = result.rows[0];
    expect(row.errors.length).toBeGreaterThan(0);
    // The reason must be legible to the person fixing the spreadsheet.
    expect(row.errors[0].message ?? '').toMatch(/amount|number/i);
  });

  it('records a missing required field by name', () => {
    const data = sheet(VOUCHER_HEADERS, [
      { Date: '', Type: 'Sales', 'Vch No': 'INV-2', Particulars: 'A', Debit: 100, Credit: '' },
    ]);

    const result = validateDataset({
      categoryKey: 'vouchers',
      sheet: data,
      mapping: VOUCHER_MAP,
      // Forward fill off, so the blank date is genuinely missing.
      options: { dateOrder: { voucherDate: 'dmy' }, forwardFill: false },
    });

    expect(result.report.missingRequired.some((m) => m.field === 'voucherDate')).toBe(true);
  });

  it('reads dates day-first when told to, and month-first when told to', () => {
    const rows = [{ Date: '03/04/2025', Type: 'Sales', 'Vch No': 'INV-3', Particulars: 'A', Debit: 100, Credit: '' }];

    const dmy = validateDataset({ categoryKey: 'vouchers', sheet: sheet(VOUCHER_HEADERS, rows), mapping: VOUCHER_MAP, options: { dateOrder: { voucherDate: 'dmy' } } });
    const mdy = validateDataset({ categoryKey: 'vouchers', sheet: sheet(VOUCHER_HEADERS, rows), mapping: VOUCHER_MAP, options: { dateOrder: { voucherDate: 'mdy' } } });

    expect(dmy.rows[0].values.voucherDate).toBe('2025-04-03');
    expect(mdy.rows[0].values.voucherDate).toBe('2025-03-04');
  });

  it('reports the date range it found, for the import summary', () => {
    const data = sheet(VOUCHER_HEADERS, [
      { Date: '05/04/2025', Type: 'Sales', 'Vch No': 'A', Particulars: 'X', Debit: 100, Credit: '' },
      { Date: '20/06/2025', Type: 'Sales', 'Vch No': 'B', Particulars: 'Y', Debit: 100, Credit: '' },
    ]);

    const result = validateDataset({ categoryKey: 'vouchers', sheet: data, mapping: VOUCHER_MAP, options: { dateOrder: { voucherDate: 'dmy' } } });
    expect(result.report.dateRange).toEqual({ from: '2025-04-05', to: '2025-06-20' });
  });
});

describe('duplicate detection', () => {
  it('builds a stable key that does not depend on row position', () => {
    // §6: "Do not rely solely on row numbers."
    const a = buildDedupeKey('chart_of_accounts', { ledgerName: 'Acme Traders' });
    const b = buildDedupeKey('chart_of_accounts', { ledgerName: 'Acme Traders' });
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('treats differently-cased and differently-spaced names as the same record', () => {
    // Otherwise "Acme Traders" and "acme  traders" import as two ledgers.
    expect(buildDedupeKey('chart_of_accounts', { ledgerName: 'Acme Traders' })).toBe(
      buildDedupeKey('chart_of_accounts', { ledgerName: '  acme   traders ' }),
    );
  });

  it('distinguishes genuinely different records', () => {
    expect(buildDedupeKey('chart_of_accounts', { ledgerName: 'Acme Traders' })).not.toBe(
      buildDedupeKey('chart_of_accounts', { ledgerName: 'Acme Trading' }),
    );
  });

  it('prefers a source reference over a composite key when the export supplies one', () => {
    // Two invoices with identical fields but different source ids stay distinct.
    const a = buildDedupeKey('receivables', { externalId: 'GUID-1', partyName: 'A', documentNumber: '1', amount: 100 });
    const b = buildDedupeKey('receivables', { externalId: 'GUID-2', partyName: 'A', documentNumber: '1', amount: 100 });
    expect(a).not.toBe(b);
  });

  it('counts rows already present in the database as duplicates', () => {
    const data = sheet(['Ledger Name'], [{ 'Ledger Name': 'Acme Traders' }]);
    const existing = new Set([buildDedupeKey('chart_of_accounts', { ledgerName: 'Acme Traders' })]);

    const result = validateDataset({
      categoryKey: 'chart_of_accounts',
      sheet: data,
      mapping: { ledgerName: 'Ledger Name' },
      existingKeys: existing,
    });

    expect(result.report.duplicateRecordsInDatabase).toBe(1);
  });

  it('counts a row repeated within the same file', () => {
    const data = sheet(['Ledger Name'], [{ 'Ledger Name': 'Acme Traders' }, { 'Ledger Name': 'Acme Traders' }]);

    const result = validateDataset({ categoryKey: 'chart_of_accounts', sheet: data, mapping: { ledgerName: 'Ledger Name' } });
    expect(result.report.duplicateRowsInFile).toBe(1);
  });
});

describe('reporting', () => {
  it('accounts for every row — valid, invalid and duplicate', () => {
    const data = sheet(VOUCHER_HEADERS, [
      { Date: '05/04/2025', Type: 'Sales', 'Vch No': 'INV-1', Particulars: 'A', Debit: 100, Credit: '' },
      { Date: 'rubbish', Type: 'Sales', 'Vch No': 'INV-2', Particulars: 'B', Debit: 100, Credit: '' },
    ]);

    const result = validateDataset({ categoryKey: 'vouchers', sheet: data, mapping: VOUCHER_MAP, options: { dateOrder: { voucherDate: 'dmy' } } });

    // Nothing may vanish between the file and the report.
    expect(result.report.totalRows).toBe(2);
    expect(result.report.validRows + result.report.invalidRows).toBe(2);
    expect(result.rows).toHaveLength(2);
  });

  it('lists ledgers the file introduces, so the user can expect new accounts', () => {
    const data = sheet(VOUCHER_HEADERS, [
      { Date: '05/04/2025', Type: 'Sales', 'Vch No': 'INV-1', Particulars: 'Brand New Ledger', Debit: 100, Credit: '' },
    ]);

    const result = validateDataset({
      categoryKey: 'vouchers',
      sheet: data,
      mapping: VOUCHER_MAP,
      options: { dateOrder: { voucherDate: 'dmy' } },
      knownLedgers: new Set<string>(),
    });

    expect(result.report.newLedgers.length).toBeGreaterThan(0);
  });
});
