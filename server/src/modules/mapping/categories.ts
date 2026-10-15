/**
 * Standard financial categories.
 *
 * Imported ledgers mean nothing to a report until they are classified. This is the
 * target vocabulary. Companies may add their own categories or deactivate these,
 * so nothing downstream hardcodes a key outside of SECTION_ROLES below.
 *
 * `normalSide` is the side on which the category ordinarily carries a balance. It
 * decides the sign convention when a ledger's net movement is folded into a
 * statement line, which is why it is data rather than a branch in the calculator.
 */

export type Statement = 'PL' | 'BS';
export type Side = 'debit' | 'credit';

export interface CategoryDef {
  key: string;
  label: string;
  statement: Statement;
  section: string;
  normalSide: Side;
  sortOrder: number;
  description: string;
  /** Lowercase substrings matched against a ledger's Tally group name. */
  groupHints: string[];
  /** Lowercase substrings matched against the ledger's own name. */
  nameHints: string[];
}

export const SYSTEM_CATEGORIES: CategoryDef[] = [
  // ------------------------------------------------------------- Profit & Loss
  {
    key: 'revenue',
    label: 'Revenue',
    statement: 'PL',
    section: 'revenue',
    normalSide: 'credit',
    sortOrder: 10,
    description: 'Income from the sale of goods or services — the top line of the Profit & Loss.',
    groupHints: ['sales account', 'direct income', 'direct incomes', 'revenue from operations'],
    nameHints: ['sales', 'revenue', 'service income', 'fees earned', 'professional fees', 'job work income'],
  },
  {
    key: 'cogs',
    label: 'Cost of Goods Sold',
    statement: 'PL',
    section: 'cogs',
    normalSide: 'debit',
    sortOrder: 20,
    description: 'Direct cost of the goods or services sold. Deducted from Revenue to give Gross Profit.',
    groupHints: ['purchase account', 'purchase accounts'],
    nameHints: ['purchase', 'cost of goods', 'cogs', 'raw material', 'opening stock', 'closing stock', 'consumption'],
  },
  {
    key: 'direct_expenses',
    label: 'Direct Expenses',
    statement: 'PL',
    section: 'direct_expenses',
    normalSide: 'debit',
    sortOrder: 30,
    description: 'Expenses directly attributable to production or delivery, above the Gross Profit line.',
    groupHints: ['direct expense', 'direct expenses'],
    nameHints: ['freight inward', 'carriage inward', 'wages', 'factory', 'power and fuel', 'labour charges'],
  },
  {
    key: 'operating_expenses',
    label: 'Operating Expenses',
    statement: 'PL',
    section: 'operating_expenses',
    normalSide: 'debit',
    sortOrder: 40,
    description: 'Day-to-day running costs: salaries, rent, utilities, marketing, administration.',
    groupHints: ['indirect expense', 'indirect expenses', 'administrative expenses', 'selling'],
    nameHints: [
      'salary', 'salaries', 'rent', 'electricity', 'telephone', 'internet', 'travel', 'conveyance',
      'printing', 'stationery', 'advertisement', 'marketing', 'repairs', 'insurance', 'professional charges',
      'audit fee', 'legal', 'office expense', 'staff welfare', 'commission paid', 'subscription',
    ],
  },
  {
    key: 'depreciation',
    label: 'Depreciation & Amortisation',
    statement: 'PL',
    section: 'depreciation',
    normalSide: 'debit',
    sortOrder: 50,
    description: 'Non-cash charge for the use of fixed and intangible assets. Added back to reach EBITDA.',
    groupHints: [],
    nameHints: ['depreciation', 'amortisation', 'amortization'],
  },
  {
    key: 'finance_cost',
    label: 'Finance Costs',
    statement: 'PL',
    section: 'finance_cost',
    normalSide: 'debit',
    sortOrder: 60,
    description: 'Interest and borrowing costs. Used as the denominator of interest coverage.',
    groupHints: [],
    nameHints: ['interest paid', 'interest on', 'bank charges', 'finance cost', 'loan interest', 'processing fee'],
  },
  {
    key: 'other_income',
    label: 'Other Income',
    statement: 'PL',
    section: 'other_income',
    normalSide: 'credit',
    sortOrder: 70,
    description: 'Income outside normal operations: interest received, rent received, gains on disposal.',
    groupHints: ['indirect income', 'indirect incomes'],
    nameHints: ['interest received', 'interest income', 'discount received', 'rent received', 'other income', 'misc income'],
  },
  {
    key: 'other_expenses',
    label: 'Other Expenses',
    statement: 'PL',
    section: 'other_expenses',
    normalSide: 'debit',
    sortOrder: 80,
    description: 'Non-operating or exceptional charges that sit below the operating result.',
    groupHints: [],
    nameHints: ['donation', 'loss on sale', 'written off', 'penalty', 'prior period'],
  },
  {
    key: 'tax_expense',
    label: 'Tax Expense',
    statement: 'PL',
    section: 'tax',
    normalSide: 'debit',
    sortOrder: 90,
    description: 'Income tax charged against the result for the period.',
    groupHints: [],
    nameHints: ['income tax', 'provision for tax', 'deferred tax', 'tax expense'],
  },

  // ------------------------------------------------------------- Balance Sheet
  {
    key: 'cash_and_bank',
    label: 'Cash and Bank',
    statement: 'BS',
    section: 'cash_and_bank',
    normalSide: 'debit',
    sortOrder: 100,
    description: 'Cash in hand and balances with banks. The opening position for every cash forecast.',
    groupHints: ['bank account', 'bank accounts', 'cash-in-hand', 'cash in hand', 'bank od', 'bank occ'],
    nameHints: ['cash', 'bank', 'petty cash', 'current account', 'savings account', 'hdfc', 'icici', 'sbi', 'axis', 'kotak'],
  },
  {
    key: 'trade_receivables',
    label: 'Trade Receivables',
    statement: 'BS',
    section: 'trade_receivables',
    normalSide: 'debit',
    sortOrder: 110,
    description: 'Amounts owed by customers. Drives receivable ageing and DSO.',
    groupHints: ['sundry debtor', 'sundry debtors', 'accounts receivable', 'trade receivable'],
    nameHints: ['debtor', 'receivable'],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    statement: 'BS',
    section: 'inventory',
    normalSide: 'debit',
    sortOrder: 120,
    description: 'Stock held for sale or use. Excluded from the Quick Ratio.',
    groupHints: ['stock-in-hand', 'stock in hand'],
    nameHints: ['stock', 'inventory', 'work in progress', 'finished goods'],
  },
  {
    key: 'current_assets',
    label: 'Other Current Assets',
    statement: 'BS',
    section: 'current_assets',
    normalSide: 'debit',
    sortOrder: 130,
    description: 'Current assets other than cash, receivables and inventory: advances, prepaid, deposits.',
    groupHints: ['current asset', 'current assets', 'loans & advances (asset)', 'deposit (asset)'],
    nameHints: ['advance to', 'prepaid', 'security deposit', 'accrued income', 'tds receivable'],
  },
  {
    key: 'tax_receivable',
    label: 'Tax Assets',
    statement: 'BS',
    section: 'current_assets',
    normalSide: 'debit',
    sortOrder: 135,
    description: 'Input tax credit and taxes recoverable from the authorities.',
    groupHints: [],
    nameHints: ['input gst', 'gst input', 'input cgst', 'input sgst', 'input igst', 'itc', 'advance tax', 'tds asset'],
  },
  {
    key: 'non_current_assets',
    label: 'Non-current Assets',
    statement: 'BS',
    section: 'non_current_assets',
    normalSide: 'debit',
    sortOrder: 140,
    description: 'Fixed and long-term assets: property, plant, equipment, intangibles, investments.',
    groupHints: ['fixed asset', 'fixed assets', 'investment', 'investments', 'misc. expenses (asset)'],
    nameHints: ['furniture', 'machinery', 'plant', 'building', 'land', 'vehicle', 'computer', 'equipment', 'goodwill', 'software'],
  },
  {
    key: 'trade_payables',
    label: 'Trade Payables',
    statement: 'BS',
    section: 'trade_payables',
    normalSide: 'credit',
    sortOrder: 150,
    description: 'Amounts owed to suppliers. Drives payable ageing and DPO.',
    groupHints: ['sundry creditor', 'sundry creditors', 'accounts payable', 'trade payable'],
    nameHints: ['creditor', 'payable to'],
  },
  {
    key: 'current_liabilities',
    label: 'Other Current Liabilities',
    statement: 'BS',
    section: 'current_liabilities',
    normalSide: 'credit',
    sortOrder: 160,
    description: 'Short-term obligations other than trade payables: provisions, outstanding expenses, advances received.',
    groupHints: ['current liabilit', 'provisions', 'bills payable'],
    nameHints: ['outstanding', 'provision for', 'advance from', 'salary payable', 'expenses payable', 'audit fee payable'],
  },
  {
    key: 'tax_payable',
    label: 'Tax Liabilities',
    statement: 'BS',
    section: 'current_liabilities',
    normalSide: 'credit',
    sortOrder: 165,
    description: 'Statutory dues payable: GST output, TDS deducted, PF, ESI, professional tax.',
    groupHints: ['duties & taxes', 'duties and taxes'],
    nameHints: ['output gst', 'gst payable', 'output cgst', 'output sgst', 'output igst', 'tds payable', 'pf payable', 'esi', 'professional tax'],
  },
  {
    key: 'loans_borrowings',
    label: 'Loans and Borrowings',
    statement: 'BS',
    section: 'loans_borrowings',
    normalSide: 'credit',
    sortOrder: 170,
    description: 'Secured and unsecured borrowings. The numerator of debt-to-equity and debt ratio.',
    groupHints: ['loan (liability)', 'loans (liability)', 'secured loan', 'unsecured loan', 'bank od a/c'],
    nameHints: ['loan from', 'term loan', 'car loan', 'cc limit', 'overdraft', 'borrowing'],
  },
  {
    key: 'non_current_liabilities',
    label: 'Non-current Liabilities',
    statement: 'BS',
    section: 'non_current_liabilities',
    normalSide: 'credit',
    sortOrder: 180,
    description: 'Obligations falling due beyond twelve months, other than borrowings.',
    groupHints: [],
    nameHints: ['deferred tax liability', 'long term provision', 'lease liability'],
  },
  {
    key: 'equity_capital',
    label: 'Capital Account',
    statement: 'BS',
    section: 'equity',
    normalSide: 'credit',
    sortOrder: 190,
    description: "Owner's, partners' or share capital introduced into the business.",
    groupHints: ['capital account', 'capital accounts'],
    nameHints: ['capital', 'share capital', 'partner capital', 'proprietor'],
  },
  {
    key: 'equity_reserves',
    label: 'Reserves and Surplus',
    statement: 'BS',
    section: 'equity',
    normalSide: 'credit',
    sortOrder: 200,
    description: 'Accumulated profits and reserves retained in the business.',
    groupHints: ['reserves & surplus', 'reserves and surplus'],
    nameHints: ['reserve', 'surplus', 'retained earning', 'general reserve', 'profit & loss a/c', 'profit and loss account'],
  },
  {
    key: 'equity_drawings',
    label: 'Drawings and Dividends',
    statement: 'BS',
    section: 'equity',
    normalSide: 'debit',
    sortOrder: 210,
    description: 'Amounts withdrawn by owners or distributed to shareholders. Reduces equity.',
    groupHints: [],
    nameHints: ['drawing', 'drawings', 'dividend paid', 'dividend'],
  },
  {
    key: 'equity_other',
    label: 'Other Equity',
    statement: 'BS',
    section: 'equity',
    normalSide: 'credit',
    sortOrder: 220,
    description: 'Equity movements that do not fall under capital, reserves or drawings.',
    groupHints: [],
    nameHints: ['share premium', 'revaluation reserve', 'capital reserve'],
  },
];

/**
 * How sections roll up into the statements. The calculation service reads this
 * instead of naming individual categories, so a company-defined category inherits
 * correct behaviour purely from the section it is filed under.
 */
export const SECTION_ROLES = {
  // Profit & Loss
  revenue: ['revenue'],
  cogs: ['cogs'],
  directExpenses: ['direct_expenses'],
  operatingExpenses: ['operating_expenses'],
  depreciation: ['depreciation'],
  financeCost: ['finance_cost'],
  otherIncome: ['other_income'],
  otherExpenses: ['other_expenses'],
  tax: ['tax'],

  // Balance Sheet
  assets: ['cash_and_bank', 'trade_receivables', 'inventory', 'current_assets', 'non_current_assets'],
  currentAssets: ['cash_and_bank', 'trade_receivables', 'inventory', 'current_assets'],
  nonCurrentAssets: ['non_current_assets'],
  liabilities: ['trade_payables', 'current_liabilities', 'non_current_liabilities', 'loans_borrowings'],
  currentLiabilities: ['trade_payables', 'current_liabilities'],
  nonCurrentLiabilities: ['non_current_liabilities', 'loans_borrowings'],
  equity: ['equity'],
} as const;

export const PL_SECTIONS = [
  'revenue', 'cogs', 'direct_expenses', 'operating_expenses', 'depreciation',
  'finance_cost', 'other_income', 'other_expenses', 'tax',
];

export const BS_SECTIONS = [
  'cash_and_bank', 'trade_receivables', 'inventory', 'current_assets', 'non_current_assets',
  'trade_payables', 'current_liabilities', 'non_current_liabilities', 'loans_borrowings', 'equity',
];

export const SECTION_LABELS: Record<string, string> = {
  revenue: 'Revenue',
  cogs: 'Cost of Goods Sold',
  direct_expenses: 'Direct Expenses',
  operating_expenses: 'Operating Expenses',
  depreciation: 'Depreciation & Amortisation',
  finance_cost: 'Finance Costs',
  other_income: 'Other Income',
  other_expenses: 'Other Expenses',
  tax: 'Tax Expense',
  cash_and_bank: 'Cash and Bank',
  trade_receivables: 'Trade Receivables',
  inventory: 'Inventory',
  current_assets: 'Other Current Assets',
  non_current_assets: 'Non-current Assets',
  trade_payables: 'Trade Payables',
  current_liabilities: 'Other Current Liabilities',
  non_current_liabilities: 'Non-current Liabilities',
  loans_borrowings: 'Loans and Borrowings',
  equity: 'Equity',
};
