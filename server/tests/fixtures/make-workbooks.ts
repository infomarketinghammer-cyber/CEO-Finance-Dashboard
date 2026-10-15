/**
 * Generates test workbooks with KNOWN expected results.
 *
 * Deliberately awkward in the ways real exports are: a title block above the
 * header row, dates in DD-MM-YYYY, amounts with rupee symbols and thousand
 * separators, parenthesised negatives, Dr/Cr markers, blank continuation cells on
 * multi-line vouchers, a deliberately unbalanced voucher and some unreadable rows.
 * A pipeline that only handles clean files is not a pipeline.
 */
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'workbooks');

// ---------------------------------------------------------------- expectations
export const EXPECTED = {
  // Chart of accounts
  ledgerCount: 18,

  // Opening balances (in rupees)
  openingCash: 1_450_000,
  openingDebtors: 220_000,
  openingCapital: 2_500_000,

  // Vouchers — three balanced, one deliberately unbalanced
  voucherCount: 4,
  balancedVoucherCount: 3,
  unbalancedVoucherNumber: 'JV-0009',

  // Profit & Loss for FY 2025-26 from the voucher set
  revenue: 300_000, // 100,000 + 200,000
  cogs: 120_000,
  grossProfit: 180_000,
  // Operating expenses include the ₹5,000 travel line from the deliberately
  // unbalanced JV-0009. An unbalanced voucher is flagged, not discarded, so its
  // expense must still reach the Profit & Loss.
  operatingExpenses: 90_000, // 60,000 salaries + 25,000 rent + 5,000 travel
  netProfit: 90_000, // 180,000 − 90,000

  // Receivables
  receivableCount: 4,
  receivableOutstanding: 341_000,
  receivableWithoutDueDate: 1,

  // Rows that must be rejected
  rejectedVoucherRows: 1, // one row with an unreadable amount
};

async function write(wb: ExcelJS.Workbook, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await wb.xlsx.writeFile(path.join(OUT, name));
  // eslint-disable-next-line no-console
  console.log(`  wrote ${name}`);
}

function titleBlock(sheet: ExcelJS.Worksheet, title: string) {
  // Real exports start with junk above the table. The header detector must cope.
  sheet.addRow(['Dhyeya Test Industries Pvt Ltd']);
  sheet.addRow([title]);
  sheet.addRow(['1-Apr-2025 to 31-Mar-2026']);
  sheet.addRow([]);
}

async function chartOfAccounts() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Ledgers');
  titleBlock(sheet, 'List of Ledgers');

  sheet.addRow(['Ledger Name', 'Under', 'Opening Balance', 'GSTIN/UIN']);

  const rows: [string, string, string | number, string][] = [
    ['Sales - Domestic', 'Sales Accounts', 0, ''],
    ['Sales - Export', 'Sales Accounts', 0, ''],
    ['Purchase - Raw Material', 'Purchase Accounts', 0, ''],
    ['Salaries & Wages', 'Indirect Expenses', 0, ''],
    ['Office Rent', 'Indirect Expenses', 0, ''],
    ['Electricity Charges', 'Indirect Expenses', 0, ''],
    ['Travelling Expenses', 'Indirect Expenses', 0, ''],
    ['Interest on Term Loan', 'Indirect Expenses', 0, ''],
    ['Depreciation', 'Indirect Expenses', 0, ''],
    ['HDFC Bank Current A/c', 'Bank Accounts', '₹14,50,000 Dr', ''],
    ['Cash in Hand', 'Cash-in-Hand', 0, ''],
    ['Acme Traders', 'Sundry Debtors', '₹2,20,000 Dr', '27AAAPA1234A1Z5'],
    ['Vertex Industries', 'Sundry Debtors', 0, '29AABCV1234B1Z9'],
    ['Nova Supplies', 'Sundry Creditors', '(86,000)', ''],
    ['Capital Account', 'Capital Account', '25,00,000 Cr', ''],
    ['Plant & Machinery', 'Fixed Assets', '12,00,000 Dr', ''],
    ['Output GST', 'Duties & Taxes', 0, ''],
    ['Term Loan - HDFC', 'Loans (Liability)', '5,00,000 Cr', ''],
  ];

  for (const r of rows) sheet.addRow(r);
  await write(wb, 'chart-of-accounts.xlsx');
}

async function openingBalances() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Trial Balance');
  titleBlock(sheet, 'Opening Trial Balance');

  sheet.addRow(['Particulars', 'Debit', 'Credit']);

  const rows: [string, number | string, number | string][] = [
    ['HDFC Bank Current A/c', 1450000, ''],
    ['Acme Traders', 220000, ''],
    ['Plant & Machinery', 1200000, ''],
    ['Cash in Hand', 30000, ''],
    ['Nova Supplies', '', 86000],
    ['Term Loan - HDFC', '', 500000],
    ['Capital Account', '', 2500000],
    // A total row — the reconciler and importer should both cope with it.
    ['Total', 2900000, 3086000],
  ];

  for (const r of rows) sheet.addRow(r);
  await write(wb, 'opening-balances.xlsx');
}

async function vouchers() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Day Book');
  titleBlock(sheet, 'Day Book');

  sheet.addRow(['Date', 'Voucher Type', 'Vch No.', 'Particulars', 'Debit', 'Credit', 'Narration']);

  // Tally style: date / type / number appear only on a voucher's first line.
  const rows: (string | number)[][] = [
    // INV-0001 — a balanced sales voucher, 100,000 + 18,000 GST
    ['05-04-2025', 'Sales', 'INV-0001', 'Acme Traders', '1,18,000', '', 'Invoice 0001'],
    ['', '', '', 'Sales - Domestic', '', '₹1,00,000', ''],
    ['', '', '', 'Output GST', '', 18000, ''],

    // INV-0002 — a balanced export sale of 200,000
    ['12-05-2025', 'Sales', 'INV-0002', 'Vertex Industries', 200000, '', 'Export invoice'],
    ['', '', '', 'Sales - Export', '', 200000, ''],

    // PUR-0003 — purchase and expenses, balanced: 120,000 + 85,000 = 205,000
    ['20-06-2025', 'Purchase', 'PUR-0003', 'Purchase - Raw Material', 120000, '', 'Raw material'],
    ['', '', '', 'Salaries & Wages', 60000, '', ''],
    ['', '', '', 'Office Rent', 25000, '', ''],
    ['', '', '', 'HDFC Bank Current A/c', '', 205000, ''],

    // JV-0009 — DELIBERATELY unbalanced: debits 5,000 against credits 4,000
    ['30-06-2025', 'Journal', 'JV-0009', 'Travelling Expenses', 5000, '', 'Unbalanced on purpose'],
    ['', '', '', 'Cash in Hand', '', 4000, ''],

    // A row whose amount cannot be read — must be rejected with a reason, and
    // must not silently become zero.
    ['15-07-2025', 'Payment', 'PAY-0010', 'Electricity Charges', 'approx 9k', '', 'Unreadable amount'],
  ];

  for (const r of rows) sheet.addRow(r);
  await write(wb, 'vouchers.xlsx');
}

async function receivables() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Bills Outstanding');
  titleBlock(sheet, 'Bills Receivable');

  sheet.addRow(['Party', 'Bill No', 'Bill Date', 'Due Date', 'Bill Amount', 'Received', 'Pending']);

  const rows: (string | number)[][] = [
    ['Acme Traders', 'INV-0001', '05-04-2025', '05-05-2025', 118000, 0, 118000],
    ['Vertex Industries', 'INV-0002', '12-05-2025', '11-06-2025', 200000, 50000, 150000],
    ['Acme Traders', 'INV-0007', '18-08-2025', '', 65000, 0, 65000], // no due date — never inferred
    ['Orion Pvt Ltd', 'INV-0011', '02-09-2025', '02-10-2025', 8000, 0, 8000],
    ['Settled Customer', 'INV-0003', '01-04-2025', '01-05-2025', 40000, 40000, 0], // settled
  ];

  for (const r of rows) sheet.addRow(r);
  await write(wb, 'receivables.xlsx');
}

async function payables() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Payables');
  sheet.addRow(['Supplier', 'Bill No', 'Bill Date', 'Due Date', 'Amount', 'Outstanding']);
  sheet.addRow(['Nova Supplies', 'BILL-221', '12-04-2025', '12-05-2025', 86000, 86000]);
  sheet.addRow(['Zenith Services', 'BILL-305', '03-07-2025', '02-08-2025', 42000, 42000]);
  await write(wb, 'payables.xlsx');
}

async function expensesAndBudgets() {
  const wb = new ExcelJS.Workbook();

  const exp = wb.addWorksheet('Expenses');
  exp.addRow(['Date', 'Category', 'Vendor', 'Amount', 'Expense Type', 'Reference']);
  const expenseRows: (string | number)[][] = [
    ['30-04-2025', 'Rent', 'Landlord', 25000, 'fixed', 'PAY-001'],
    ['31-05-2025', 'Rent', 'Landlord', 25000, 'fixed', 'PAY-002'],
    ['30-06-2025', 'Rent', 'Landlord', 25000, 'fixed', 'PAY-003'],
    ['30-04-2025', 'Salaries', 'Payroll', 60000, 'fixed', 'PAY-004'],
    ['31-05-2025', 'Salaries', 'Payroll', 60000, 'fixed', 'PAY-005'],
    ['30-06-2025', 'Salaries', 'Payroll', 150000, 'fixed', 'PAY-006'], // a spike
    ['15-05-2025', 'Travel', 'Airline', 18000, 'one_off', 'PAY-007'],
    ['15-05-2025', 'Travel', 'Airline', 18000, 'one_off', 'PAY-008'], // same-day duplicate
  ];
  for (const r of expenseRows) exp.addRow(r);

  const bud = wb.addWorksheet('Budgets');
  bud.addRow(['Category', 'Period Start', 'Period End', 'Budget Amount', 'Period Type']);
  bud.addRow(['Rent', '01-04-2025', '31-03-2026', 300000, 'year']);
  bud.addRow(['Salaries', '01-04-2025', '31-03-2026', 720000, 'year']);
  bud.addRow(['Travel', '01-04-2025', '31-03-2026', 30000, 'year']); // will overrun

  await write(wb, 'expenses-and-budgets.xlsx');
}

async function referenceTrialBalance() {
  // A reference report that agrees with the imported data on most ledgers and
  // deliberately differs on one, so reconciliation has something real to find.
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('TB');
  sheet.addRow(['Ledger', 'Debit', 'Credit']);
  sheet.addRow(['HDFC Bank Current A/c', 1245000, '']);
  sheet.addRow(['Acme Traders', 338000, '']);
  sheet.addRow(['Capital Account', '', 2500000]);
  sheet.addRow(['Plant & Machinery', 1250000, '']); // differs by 50,000 on purpose
  await write(wb, 'reference-trial-balance.xlsx');
}

export async function generateAll() {
  // eslint-disable-next-line no-console
  console.log('Generating test workbooks…');
  await chartOfAccounts();
  await openingBalances();
  await vouchers();
  await receivables();
  await payables();
  await expensesAndBudgets();
  await referenceTrialBalance();
}

if (process.argv[1] && process.argv[1].endsWith('make-workbooks.ts')) {
  generateAll().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
