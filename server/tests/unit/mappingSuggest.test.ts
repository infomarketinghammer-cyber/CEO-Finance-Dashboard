/**
 * Automatic account mapping (§9).
 *
 * The brief is explicit that suggestions must be useful but never silently
 * authoritative: "Do not silently assign uncertain accounts to arbitrary
 * categories." So the tests check both that obvious ledgers are classified and
 * that genuinely unclear ones are left for a human.
 */
import { describe, it, expect } from 'vitest';
import { suggestCategoryForLedger, describeImpact } from '../../src/modules/mapping/suggest.js';
import { SYSTEM_CATEGORIES } from '../../src/modules/mapping/categories.js';

const suggest = (name: string, group?: string | null) => suggestCategoryForLedger(name, group ?? null);

describe('mapping by Tally group', () => {
  it('maps a ledger under Bank Accounts to Cash and Bank', () => {
    expect(suggest('HDFC Current A/c', 'Bank Accounts').categoryKey).toBe('cash_and_bank');
  });

  it('maps Sundry Debtors to Trade Receivables', () => {
    expect(suggest('Acme Traders', 'Sundry Debtors').categoryKey).toBe('trade_receivables');
  });

  it('maps Sundry Creditors to Trade Payables', () => {
    expect(suggest('Steel Supplier Ltd', 'Sundry Creditors').categoryKey).toBe('trade_payables');
  });

  it('maps a sales group to Revenue', () => {
    expect(suggest('Sales — Domestic', 'Sales Accounts').categoryKey).toBe('revenue');
  });

  it('maps a loan group to Loans and Borrowings', () => {
    expect(suggest('HDFC Term Loan', 'Loans (Liability)').categoryKey).toBe('loans_borrowings');
  });

  it('maps capital to Equity', () => {
    expect(suggest("Proprietor's Capital", 'Capital Account').categoryKey).toBe('equity_capital');
  });
});

describe('mapping by ledger name when no group is supplied', () => {
  it('recognises a bank account from its name alone', () => {
    const r = suggest('ICICI Bank Current Account');
    expect(r.categoryKey).toBe('cash_and_bank');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('recognises cash in hand', () => {
    expect(suggest('Cash in Hand').categoryKey).toBe('cash_and_bank');
  });

  it('does not mistake interest paid for a bank balance', () => {
    // "Bank" appears in the name, but this is a Profit & Loss item.
    const r = suggest('Interest on Bank Loan', 'Indirect Expenses');
    expect(r.categoryKey).not.toBe('cash_and_bank');
    expect(r.categoryKey).toBe('finance_cost');
  });

  it('recognises common tax ledgers as tax, not as a generic liability', () => {
    expect(suggest('Output GST Payable', 'Duties & Taxes').categoryKey).toBe('tax_payable');
  });

  it('recognises depreciation', () => {
    expect(suggest('Depreciation on Plant', 'Indirect Expenses').categoryKey).toBe('depreciation');
  });
});

describe('restraint', () => {
  it('declines to guess at a meaningless ledger name', () => {
    const r = suggest('Misc 1');
    expect(r.categoryKey).toBeNull();
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('always explains the reason for a suggestion it does make', () => {
    // §9: "View the reason for a suggestion."
    const r = suggest('HDFC Current A/c', 'Bank Accounts');
    expect(r.reason).toBeTruthy();
    expect(r.reason.length).toBeGreaterThan(5);
  });

  it('reports a confidence between 0 and 1', () => {
    for (const name of ['HDFC Bank', 'Misc 1', 'Sales — Export', 'Something Odd']) {
      const r = suggest(name);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('is more confident when the group agrees with the name than when it must guess', () => {
    const withGroup = suggest('HDFC Current A/c', 'Bank Accounts');
    const nameOnly = suggest('HDFC Current A/c');
    expect(withGroup.confidence).toBeGreaterThanOrEqual(nameOnly.confidence);
  });

  it('never suggests a category that is not available to the company', () => {
    // A company that has removed Inventory must not be handed it by a suggestion.
    const limited = SYSTEM_CATEGORIES.filter((c) => c.key !== 'cash_and_bank').map((c) => ({ key: c.key }));
    const r = suggestCategoryForLedger('HDFC Current A/c', 'Bank Accounts', limited);
    expect(r.categoryKey).not.toBe('cash_and_bank');
  });
});

describe('impact description', () => {
  it('explains where a category lands on the statements', () => {
    // §9: "View the impact of a mapping on financial statements."
    for (const key of ['revenue', 'cash_and_bank', 'equity_capital', 'trade_payables']) {
      expect(describeImpact(key).length).toBeGreaterThan(0);
    }
  });
});
