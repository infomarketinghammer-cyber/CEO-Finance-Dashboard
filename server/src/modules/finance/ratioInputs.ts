/**
 * The financial inputs a custom ratio formula may reference (§17).
 *
 * This catalogue is the contract between three places: the formula parser
 * validates identifiers against it, the ratio engine fills it from the period's
 * balances, and the UI lists it so a user picks inputs rather than guessing
 * names. Adding an input means adding it here and in `inputValues()`.
 *
 * Money inputs are in minor units (paise). Because a ratio divides money by
 * money the scale cancels, so formulas stay scale-independent. `periodDays` is
 * a plain count, which is what day-based ratios such as DSO need.
 */
export const RATIO_INPUTS = [
  // ---- closing position (Balance Sheet) ----
  { key: 'currentAssets', label: 'Current assets', kind: 'money', source: 'Balance Sheet · current asset categories', group: 'Balance Sheet' },
  { key: 'nonCurrentAssets', label: 'Non-current assets', kind: 'money', source: 'Balance Sheet · non-current asset categories', group: 'Balance Sheet' },
  { key: 'totalAssets', label: 'Total assets', kind: 'money', source: 'Balance Sheet · all asset categories', group: 'Balance Sheet' },
  { key: 'inventory', label: 'Inventory', kind: 'money', source: 'Balance Sheet · Inventory', group: 'Balance Sheet' },
  { key: 'cash', label: 'Cash and bank', kind: 'money', source: 'Balance Sheet · Cash and Bank', group: 'Balance Sheet' },
  { key: 'receivables', label: 'Trade receivables', kind: 'money', source: 'Balance Sheet · Trade Receivables', group: 'Balance Sheet' },
  { key: 'currentLiabilities', label: 'Current liabilities', kind: 'money', source: 'Balance Sheet · current liability categories', group: 'Balance Sheet' },
  { key: 'nonCurrentLiabilities', label: 'Non-current liabilities', kind: 'money', source: 'Balance Sheet · non-current liability categories', group: 'Balance Sheet' },
  { key: 'totalLiabilities', label: 'Total liabilities', kind: 'money', source: 'Balance Sheet · all liability categories', group: 'Balance Sheet' },
  { key: 'payables', label: 'Trade payables', kind: 'money', source: 'Balance Sheet · Trade Payables', group: 'Balance Sheet' },
  { key: 'borrowings', label: 'Loans and borrowings', kind: 'money', source: 'Balance Sheet · Loans and Borrowings', group: 'Balance Sheet' },
  { key: 'equity', label: 'Equity (closing)', kind: 'money', source: 'Balance Sheet · equity categories plus the result for the period', group: 'Balance Sheet' },

  // ---- opening position ----
  { key: 'openingTotalAssets', label: 'Total assets (opening)', kind: 'money', source: 'Position at the start of the period', group: 'Opening position' },
  { key: 'openingEquity', label: 'Equity (opening)', kind: 'money', source: 'Position at the start of the period', group: 'Opening position' },
  { key: 'openingReceivables', label: 'Trade receivables (opening)', kind: 'money', source: 'Position at the start of the period', group: 'Opening position' },
  { key: 'openingPayables', label: 'Trade payables (opening)', kind: 'money', source: 'Position at the start of the period', group: 'Opening position' },
  { key: 'openingInventory', label: 'Inventory (opening)', kind: 'money', source: 'Position at the start of the period', group: 'Opening position' },
  { key: 'averageEquity', label: 'Average equity', kind: 'money', source: 'Mean of opening and closing equity', group: 'Opening position' },
  { key: 'averageAssets', label: 'Average total assets', kind: 'money', source: 'Mean of opening and closing total assets', group: 'Opening position' },
  { key: 'averageReceivables', label: 'Average trade receivables', kind: 'money', source: 'Mean of opening and closing receivables', group: 'Opening position' },
  { key: 'averagePayables', label: 'Average trade payables', kind: 'money', source: 'Mean of opening and closing payables', group: 'Opening position' },
  { key: 'averageInventory', label: 'Average inventory', kind: 'money', source: 'Mean of opening and closing inventory', group: 'Opening position' },

  // ---- result for the period (Profit & Loss) ----
  { key: 'revenue', label: 'Revenue', kind: 'money', source: 'Profit & Loss · Revenue', group: 'Profit & Loss' },
  { key: 'cogs', label: 'Cost of goods sold', kind: 'money', source: 'Profit & Loss · COGS and direct expenses', group: 'Profit & Loss' },
  { key: 'grossProfit', label: 'Gross profit', kind: 'money', source: 'Profit & Loss · Revenue less COGS', group: 'Profit & Loss' },
  { key: 'operatingExpenses', label: 'Operating expenses', kind: 'money', source: 'Profit & Loss · Operating Expenses', group: 'Profit & Loss' },
  { key: 'ebit', label: 'Operating profit (EBIT)', kind: 'money', source: 'Profit & Loss · profit before finance cost and tax', group: 'Profit & Loss' },
  { key: 'netProfit', label: 'Net profit', kind: 'money', source: 'Profit & Loss · result for the period', group: 'Profit & Loss' },
  { key: 'financeCost', label: 'Finance costs', kind: 'money', source: 'Profit & Loss · Finance Costs', group: 'Profit & Loss' },
  { key: 'otherIncome', label: 'Other income', kind: 'money', source: 'Profit & Loss · Other Income', group: 'Profit & Loss' },

  // ---- period shape ----
  { key: 'periodDays', label: 'Days in the period', kind: 'number', source: 'The selected reporting period', group: 'Period' },
] as const;

export type RatioInputKey = (typeof RATIO_INPUTS)[number]['key'];

export interface RatioInputMeta {
  key: string;
  label: string;
  kind: 'money' | 'number';
  source: string;
  group: string;
}

/** Grouped for the picker in the UI. */
export function groupedInputs(): { group: string; inputs: RatioInputMeta[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, RatioInputMeta[]>();

  for (const input of RATIO_INPUTS as readonly RatioInputMeta[]) {
    if (!byGroup.has(input.group)) {
      byGroup.set(input.group, []);
      order.push(input.group);
    }
    byGroup.get(input.group)!.push(input);
  }

  return order.map((group) => ({ group, inputs: byGroup.get(group)! }));
}
