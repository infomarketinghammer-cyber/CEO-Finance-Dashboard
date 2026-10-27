import { IMPORT_CATEGORIES } from './categories.js';
import { suggestMapping, validateMapping, type ColumnMapping } from './mapper.js';
import type { SheetData } from './workbook.js';

/**
 * Dependency order for a bulk import: masters before the records that refer to
 * them, so ledgers exist before opening balances and vouchers need them.
 */
export const IMPORT_ORDER = [
  'company_details',
  'ledger_groups',
  'cost_centres',
  'chart_of_accounts',
  'opening_balances',
  'vouchers',
  'receivables',
  'payables',
  'stock_items',
  'expenses',
  'budgets',
  'recurring_expenses',
  'commitments',
  'customers',
] as const;

/** File and sheet names are a hint, never a decision: headers must still fit. */
const NAME_HINTS: Record<string, RegExp> = {
  company_details: /company|profile/i,
  ledger_groups: /group/i,
  cost_centres: /cost.?cent|branch/i,
  chart_of_accounts: /chart|coa|ledger.?master|master/i,
  opening_balances: /opening/i,
  vouchers: /voucher|day.?book|transaction/i,
  receivables: /receivable|debtor/i,
  payables: /payable|creditor/i,
  stock_items: /stock|inventory/i,
  expenses: /expense/i,
  budgets: /budget/i,
  recurring_expenses: /recurring/i,
  commitments: /commitment/i,
  customers: /customer|crm/i,
};

export interface Detection {
  categoryKey: string;
  mapping: ColumnMapping;
  /** 0–1, how sure the match is relative to the runner-up. */
  confidence: number;
  runnerUp: string | null;
}

/**
 * Decides which import category a sheet belongs to, and the column mapping for it.
 *
 * A category is a candidate only if its own validation passes on the suggested
 * mapping (every required field mapped, "at least one of" groups satisfied).
 * Candidates are ranked on how many fields matched and how strongly, minus a
 * penalty for columns the category does not recognise — which is what separates,
 * say, a recurring-expense list from a plain expense list.
 */
export function detectCategory(sheet: SheetData, hintText: string): Detection | null {
  if (!sheet.headers.length || sheet.totalRows === 0) return null;

  const hinted = IMPORT_CATEGORIES.filter((c) => NAME_HINTS[c.key]?.test(hintText)).map((c) => c.key);
  const hintBonus = hinted.length === 1 ? 2 : hinted.length > 1 ? 1 : 0;

  const scored: { key: string; score: number; mapping: ColumnMapping }[] = [];

  for (const category of IMPORT_CATEGORIES) {
    const { suggestions, unrecognisedHeaders } = suggestMapping(category.key, sheet.headers, sheet.columns);
    const mapping: ColumnMapping = {};
    let sum = 0;
    for (const s of suggestions) {
      mapping[s.fieldKey] = s.header;
      if (s.header) sum += s.confidence;
    }

    if (!validateMapping(category.key, mapping, sheet.headers).ok) continue;

    // company_details has one data row and few fields; do not let it win by default.
    let score = sum - unrecognisedHeaders.length * 0.35;
    if (hinted.includes(category.key)) score += hintBonus;
    scored.push({ key: category.key, score, mapping });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  if (best.score < 1.5) return null;

  const margin = second ? best.score - second.score : best.score;
  const confidence = Math.max(0.3, Math.min(1, 0.5 + margin / 6));

  return { categoryKey: best.key, mapping: best.mapping, confidence: Math.round(confidence * 100) / 100, runnerUp: second?.key ?? null };
}
