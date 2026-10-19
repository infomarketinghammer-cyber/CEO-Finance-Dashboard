import { loadBalances, sumSections, hasSectionData, type BalanceOptions, type PeriodRef } from './engine.js';
import { plFigures } from './statements.js';
import { add, sub, ratio as safeRatio, type Minor } from '../../lib/money.js';
import { SECTION_ROLES } from '../mapping/categories.js';
import { daysBetween } from '../../lib/dates.js';

/**
 * Financial ratio calculator.
 *
 * Every ratio publishes the formula used, the inputs that fed it with their
 * values, and — where the textbook input is unavailable from imported data — the
 * substitution made and what it costs in accuracy. A ratio that cannot be
 * computed returns null with a reason; none is ever shown as 0, and division by
 * zero yields "not available" rather than Infinity.
 *
 * No ratio is labelled good or bad. Interpretation depends on industry, season and
 * business model, none of which this product can observe.
 */

export type RatioUnit = 'times' | 'percent' | 'days';

export interface RatioInput {
  label: string;
  value: Minor | number | null;
  unit: 'money' | 'number';
  source: string;
}

export interface RatioResult {
  key: string;
  label: string;
  group: 'liquidity' | 'profitability' | 'efficiency' | 'leverage';
  value: number | null;
  unit: RatioUnit;
  formula: string;
  inputs: RatioInput[];
  available: boolean;
  reason?: string;
  /** A methodological caveat that applies even when the ratio computed. */
  limitation?: string;
  explanation: string;
  /** True for ratios defined by the organisation rather than shipped with ArthSetu. */
  isCustom?: boolean;
}

export interface RatioReport {
  period: PeriodRef;
  ratios: RatioResult[];
  quality: ReturnType<typeof Object> extends never ? never : { warnings: string[] };
  isEmpty: boolean;
}

interface Ctx {
  // Closing position
  currentAssets: Minor;
  nonCurrentAssets: Minor;
  inventory: Minor;
  cash: Minor;
  receivables: Minor;
  currentLiabilities: Minor;
  nonCurrentLiabilities: Minor;
  payables: Minor;
  totalAssets: Minor;
  totalLiabilities: Minor;
  borrowings: Minor;
  equity: Minor;
  // Opening position
  openingTotalAssets: Minor;
  openingEquity: Minor;
  openingReceivables: Minor;
  openingPayables: Minor;
  openingInventory: Minor;
  // Period result
  revenue: Minor;
  cogs: Minor;
  grossProfit: Minor;
  operatingExpenses: Minor;
  otherIncome: Minor;
  ebit: Minor;
  netProfit: Minor;
  financeCost: Minor;
  // Availability flags
  hasBs: boolean;
  hasPl: boolean;
  hasOpening: boolean;
  hasInventoryLedger: boolean;
  days: number;
}

export async function computeRatios(
  companyId: string,
  period: PeriodRef,
  opts: BalanceOptions & { financialYearStart?: string | null } = {},
): Promise<{
  period: PeriodRef;
  ratios: RatioResult[];
  /** Named financial inputs for this period, for custom ratio formulas (§17). */
  inputs: Record<string, number | null>;
  warnings: string[];
  isEmpty: boolean;
}> {
  const fyStart = opts.financialYearStart ?? period.from;

  // Closing position at the period end, and the opening position at its start.
  const closing = await loadBalances(companyId, { from: fyStart, to: period.to }, opts);
  const opening = await loadBalances(companyId, { from: fyStart, to: period.from }, opts);
  const movement = await loadBalances(companyId, period, opts);

  const pl = plFigures(movement.balances);

  const equityAt = (set: typeof closing) => {
    const ledgerEquity = sumSections(set.balances, 'BS', SECTION_ROLES.equity);
    const result = plFigures(set.balances).netProfit;
    return add(ledgerEquity, result);
  };

  const ctx: Ctx = {
    currentAssets: sumSections(closing.balances, 'BS', SECTION_ROLES.currentAssets),
    nonCurrentAssets: sumSections(closing.balances, 'BS', SECTION_ROLES.nonCurrentAssets),
    nonCurrentLiabilities: sumSections(closing.balances, 'BS', SECTION_ROLES.nonCurrentLiabilities),
    inventory: sumSections(closing.balances, 'BS', ['inventory']),
    cash: sumSections(closing.balances, 'BS', ['cash_and_bank']),
    receivables: sumSections(closing.balances, 'BS', ['trade_receivables']),
    currentLiabilities: sumSections(closing.balances, 'BS', SECTION_ROLES.currentLiabilities),
    payables: sumSections(closing.balances, 'BS', ['trade_payables']),
    totalAssets: sumSections(closing.balances, 'BS', SECTION_ROLES.assets),
    totalLiabilities: sumSections(closing.balances, 'BS', SECTION_ROLES.liabilities),
    borrowings: sumSections(closing.balances, 'BS', ['loans_borrowings']),
    equity: equityAt(closing),
    openingTotalAssets: sumSections(opening.balances, 'BS', SECTION_ROLES.assets),
    openingEquity: equityAt(opening),
    openingReceivables: sumSections(opening.balances, 'BS', ['trade_receivables']),
    openingPayables: sumSections(opening.balances, 'BS', ['trade_payables']),
    openingInventory: sumSections(opening.balances, 'BS', ['inventory']),
    revenue: pl.revenue,
    cogs: add(pl.cogs, pl.direct),
    grossProfit: pl.grossProfit,
    operatingExpenses: pl.opex,
    otherIncome: pl.otherIncome,
    ebit: pl.ebit,
    netProfit: pl.netProfit,
    financeCost: pl.financeCost,
    hasBs: hasSectionData(closing.balances, 'BS', [...SECTION_ROLES.assets, ...SECTION_ROLES.liabilities, ...SECTION_ROLES.equity]),
    hasPl: hasSectionData(movement.balances, 'PL', SECTION_ROLES.revenue) || hasSectionData(movement.balances, 'PL', SECTION_ROLES.operatingExpenses),
    hasOpening: opening.balances.some((b) => b.openingDebit !== 0 || b.openingCredit !== 0),
    hasInventoryLedger: hasSectionData(closing.balances, 'BS', ['inventory']),
    days: Math.max(1, daysBetween(period.from, period.to) + 1),
  };

  const ratios: RatioResult[] = [
    ...liquidity(ctx),
    ...profitability(ctx),
    ...efficiency(ctx),
    ...leverage(ctx),
  ];

  return {
    period,
    ratios,
    inputs: inputValues(ctx),
    warnings: closing.quality.warnings,
    isEmpty: !ctx.hasBs && !ctx.hasPl,
  };
}

/**
 * The named inputs a custom formula may read (§17), resolved for this period.
 *
 * An input whose underlying statement was never imported resolves to `null`
 * rather than 0, so a custom ratio built on it reports "N/A" with a reason
 * instead of a confident wrong number (§10).
 */
export function inputValues(ctx: Ctx): Record<string, number | null> {
  const bs = (v: Minor): number | null => (ctx.hasBs ? v : null);
  const pl = (v: Minor): number | null => (ctx.hasPl ? v : null);
  const opening = (v: Minor): number | null => (ctx.hasBs && ctx.hasOpening ? v : null);
  const mean = (a: Minor, b: Minor): number | null => (ctx.hasBs && ctx.hasOpening ? (a + b) / 2 : null);

  return {
    currentAssets: bs(ctx.currentAssets),
    nonCurrentAssets: bs(ctx.nonCurrentAssets),
    totalAssets: bs(ctx.totalAssets),
    inventory: ctx.hasBs && ctx.hasInventoryLedger ? ctx.inventory : null,
    cash: bs(ctx.cash),
    receivables: bs(ctx.receivables),
    currentLiabilities: bs(ctx.currentLiabilities),
    nonCurrentLiabilities: bs(ctx.nonCurrentLiabilities),
    totalLiabilities: bs(ctx.totalLiabilities),
    payables: bs(ctx.payables),
    borrowings: bs(ctx.borrowings),
    equity: bs(ctx.equity),

    openingTotalAssets: opening(ctx.openingTotalAssets),
    openingEquity: opening(ctx.openingEquity),
    openingReceivables: opening(ctx.openingReceivables),
    openingPayables: opening(ctx.openingPayables),
    openingInventory: opening(ctx.openingInventory),
    averageEquity: mean(ctx.openingEquity, ctx.equity),
    averageAssets: mean(ctx.openingTotalAssets, ctx.totalAssets),
    averageReceivables: mean(ctx.openingReceivables, ctx.receivables),
    averagePayables: mean(ctx.openingPayables, ctx.payables),
    averageInventory: ctx.hasInventoryLedger ? mean(ctx.openingInventory, ctx.inventory) : null,

    revenue: pl(ctx.revenue),
    cogs: pl(ctx.cogs),
    grossProfit: pl(ctx.grossProfit),
    operatingExpenses: pl(ctx.operatingExpenses),
    ebit: pl(ctx.ebit),
    netProfit: pl(ctx.netProfit),
    financeCost: pl(ctx.financeCost),
    otherIncome: pl(ctx.otherIncome),

    periodDays: ctx.days,
  };
}

const money = (label: string, value: Minor | null, source: string): RatioInput => ({ label, value, unit: 'money', source });

function div(numerator: Minor, denominator: Minor): number | null {
  return safeRatio(numerator, denominator);
}

function liquidity(c: Ctx): RatioResult[] {
  const quickAssets = sub(c.currentAssets, c.inventory);

  return [
    {
      key: 'current_ratio',
      label: 'Current Ratio',
      group: 'liquidity',
      value: c.hasBs ? div(c.currentAssets, c.currentLiabilities) : null,
      unit: 'times',
      formula: 'Current Assets ÷ Current Liabilities',
      inputs: [
        money('Current Assets', c.currentAssets, 'Cash and Bank, Trade Receivables, Inventory and Other Current Assets'),
        money('Current Liabilities', c.currentLiabilities, 'Trade Payables and Other Current Liabilities'),
      ],
      available: c.hasBs && c.currentLiabilities !== 0,
      reason: !c.hasBs
        ? 'No Balance Sheet data has been categorised yet.'
        : c.currentLiabilities === 0
          ? 'Current liabilities are zero, so the ratio cannot be calculated.'
          : undefined,
      explanation: 'Compares short-term assets with short-term obligations. It describes cover, not health — the level that is comfortable differs sharply between a cash-collecting retailer and a project business on long credit terms.',
    },
    {
      key: 'quick_ratio',
      label: 'Quick Ratio',
      group: 'liquidity',
      value: c.hasBs ? div(quickAssets, c.currentLiabilities) : null,
      unit: 'times',
      formula: '(Current Assets − Inventory) ÷ Current Liabilities',
      inputs: [
        money('Current Assets', c.currentAssets, 'Balance Sheet'),
        money('Inventory', c.inventory, c.hasInventoryLedger ? 'Ledgers categorised as Inventory' : 'No inventory ledger categorised — treated as nil'),
        money('Current Liabilities', c.currentLiabilities, 'Balance Sheet'),
      ],
      available: c.hasBs && c.currentLiabilities !== 0,
      reason: !c.hasBs
        ? 'No Balance Sheet data has been categorised yet.'
        : c.currentLiabilities === 0
          ? 'Current liabilities are zero, so the ratio cannot be calculated.'
          : undefined,
      limitation: c.hasInventoryLedger
        ? undefined
        : 'No ledger is categorised as Inventory, so this is identical to the Current Ratio. Import or categorise stock data to separate the two.',
      explanation: 'The Current Ratio with inventory removed, on the basis that stock is the slowest current asset to turn into cash.',
    },
    {
      key: 'cash_ratio',
      label: 'Cash Ratio',
      group: 'liquidity',
      value: c.hasBs ? div(c.cash, c.currentLiabilities) : null,
      unit: 'times',
      formula: 'Cash and Cash Equivalents ÷ Current Liabilities',
      inputs: [
        money('Cash and Bank', c.cash, 'Ledgers categorised as Cash and Bank'),
        money('Current Liabilities', c.currentLiabilities, 'Balance Sheet'),
      ],
      available: c.hasBs && c.currentLiabilities !== 0,
      reason: !c.hasBs
        ? 'No Balance Sheet data has been categorised yet.'
        : c.currentLiabilities === 0
          ? 'Current liabilities are zero, so the ratio cannot be calculated.'
          : undefined,
      explanation: 'The strictest liquidity test: what could be settled today from cash alone, ignoring collections and stock.',
    },
  ];
}

function profitability(c: Ctx): RatioResult[] {
  const avgEquity = c.hasOpening ? Math.round((c.openingEquity + c.equity) / 2) : c.equity;
  const avgAssets = c.hasOpening ? Math.round((c.openingTotalAssets + c.totalAssets) / 2) : c.totalAssets;

  const pct = (n: Minor, d: Minor) => {
    const r = safeRatio(n, d);
    return r === null ? null : r * 100;
  };

  return [
    {
      key: 'gross_margin',
      label: 'Gross Margin',
      group: 'profitability',
      value: c.hasPl ? pct(c.grossProfit, c.revenue) : null,
      unit: 'percent',
      formula: 'Gross Profit ÷ Revenue × 100',
      inputs: [money('Gross Profit', c.grossProfit, 'Profit & Loss'), money('Revenue', c.revenue, 'Profit & Loss')],
      available: c.hasPl && c.revenue !== 0,
      reason: !c.hasPl ? 'No Profit & Loss activity in this period.' : c.revenue === 0 ? 'Revenue is zero for this period.' : undefined,
      explanation: 'The share of each rupee of sales left after direct costs, before any overhead.',
    },
    {
      key: 'operating_margin',
      label: 'Operating Margin',
      group: 'profitability',
      value: c.hasPl ? pct(c.ebit, c.revenue) : null,
      unit: 'percent',
      formula: 'EBIT ÷ Revenue × 100',
      inputs: [money('EBIT (Operating Profit)', c.ebit, 'Profit & Loss'), money('Revenue', c.revenue, 'Profit & Loss')],
      available: c.hasPl && c.revenue !== 0,
      reason: !c.hasPl ? 'No Profit & Loss activity in this period.' : c.revenue === 0 ? 'Revenue is zero for this period.' : undefined,
      explanation: 'Profitability of the trading operation after overheads but before interest and tax.',
    },
    {
      key: 'net_margin',
      label: 'Net Margin',
      group: 'profitability',
      value: c.hasPl ? pct(c.netProfit, c.revenue) : null,
      unit: 'percent',
      formula: 'Net Profit ÷ Revenue × 100',
      inputs: [money('Net Profit', c.netProfit, 'Profit & Loss'), money('Revenue', c.revenue, 'Profit & Loss')],
      available: c.hasPl && c.revenue !== 0,
      reason: !c.hasPl ? 'No Profit & Loss activity in this period.' : c.revenue === 0 ? 'Revenue is zero for this period.' : undefined,
      explanation: 'What finally remains from each rupee of sales after every cost, including interest and tax.',
    },
    {
      key: 'roe',
      label: 'Return on Equity (ROE)',
      group: 'profitability',
      value: c.hasPl && c.hasBs ? pct(c.netProfit, avgEquity) : null,
      unit: 'percent',
      formula: c.hasOpening ? 'Net Profit ÷ Average Equity × 100' : 'Net Profit ÷ Closing Equity × 100',
      inputs: [
        money('Net Profit', c.netProfit, 'Profit & Loss'),
        money(c.hasOpening ? 'Average Equity' : 'Closing Equity', avgEquity, c.hasOpening ? '(Opening Equity + Closing Equity) ÷ 2' : 'Balance Sheet at the period end'),
      ],
      available: c.hasPl && c.hasBs && avgEquity !== 0,
      reason: !c.hasBs
        ? 'No Balance Sheet data has been categorised yet.'
        : !c.hasPl
          ? 'No Profit & Loss activity in this period.'
          : avgEquity === 0
            ? 'Equity is zero, so a return on it cannot be calculated.'
            : undefined,
      limitation: c.hasOpening
        ? undefined
        : 'No opening balances are available, so closing equity is used in place of the average. Import Opening Balances for a correct average-equity basis.',
      explanation: 'The return earned on the owners’ capital over the period.',
    },
    {
      key: 'roa',
      label: 'Return on Assets (ROA)',
      group: 'profitability',
      value: c.hasPl && c.hasBs ? pct(c.netProfit, avgAssets) : null,
      unit: 'percent',
      formula: c.hasOpening ? 'Net Profit ÷ Average Total Assets × 100' : 'Net Profit ÷ Closing Total Assets × 100',
      inputs: [
        money('Net Profit', c.netProfit, 'Profit & Loss'),
        money(c.hasOpening ? 'Average Total Assets' : 'Closing Total Assets', avgAssets, c.hasOpening ? '(Opening + Closing) ÷ 2' : 'Balance Sheet at the period end'),
      ],
      available: c.hasPl && c.hasBs && avgAssets !== 0,
      reason: !c.hasBs
        ? 'No Balance Sheet data has been categorised yet.'
        : !c.hasPl
          ? 'No Profit & Loss activity in this period.'
          : avgAssets === 0
            ? 'Total assets are zero, so a return on them cannot be calculated.'
            : undefined,
      limitation: c.hasOpening ? undefined : 'No opening balances are available, so closing assets are used in place of the average.',
      explanation: 'How efficiently the asset base generated profit, regardless of how it was financed.',
    },
  ];
}

function efficiency(c: Ctx): RatioResult[] {
  const avgReceivables = c.hasOpening ? Math.round((c.openingReceivables + c.receivables) / 2) : c.receivables;
  const avgPayables = c.hasOpening ? Math.round((c.openingPayables + c.payables) / 2) : c.payables;
  const avgInventory = c.hasOpening ? Math.round((c.openingInventory + c.inventory) / 2) : c.inventory;
  const avgAssets = c.hasOpening ? Math.round((c.openingTotalAssets + c.totalAssets) / 2) : c.totalAssets;

  const days = (balance: Minor, flow: Minor) => {
    const r = safeRatio(balance, flow);
    return r === null ? null : r * c.days;
  };

  return [
    {
      key: 'dso',
      label: 'Receivable Days (DSO)',
      group: 'efficiency',
      value: c.hasBs && c.hasPl ? days(avgReceivables, c.revenue) : null,
      unit: 'days',
      formula: `${c.hasOpening ? 'Average' : 'Closing'} Trade Receivables ÷ Revenue × ${c.days} days in the period`,
      inputs: [
        money(`${c.hasOpening ? 'Average' : 'Closing'} Trade Receivables`, avgReceivables, 'Balance Sheet'),
        money('Revenue', c.revenue, 'Profit & Loss'),
        { label: 'Days in period', value: c.days, unit: 'number', source: 'Selected reporting period' },
      ],
      available: c.hasBs && c.hasPl && c.revenue !== 0,
      reason: !c.hasPl ? 'No Profit & Loss activity in this period.' : c.revenue === 0 ? 'Revenue is zero for this period.' : !c.hasBs ? 'No Balance Sheet data has been categorised yet.' : undefined,
      limitation:
        'The textbook formula uses CREDIT sales. Imported data does not distinguish credit from cash sales, so total Revenue is used. Where a material share of sales is settled in cash, the true DSO is lower than shown.',
      explanation: 'The average number of days between invoicing a customer and being paid.',
    },
    {
      key: 'dpo',
      label: 'Payable Days (DPO)',
      group: 'efficiency',
      value: c.hasBs && c.cogs !== 0 ? days(avgPayables, c.cogs) : null,
      unit: 'days',
      formula: `${c.hasOpening ? 'Average' : 'Closing'} Trade Payables ÷ Cost of Goods Sold × ${c.days} days in the period`,
      inputs: [
        money(`${c.hasOpening ? 'Average' : 'Closing'} Trade Payables`, avgPayables, 'Balance Sheet'),
        money('Cost of Goods Sold', c.cogs, 'Profit & Loss, including Direct Expenses'),
        { label: 'Days in period', value: c.days, unit: 'number', source: 'Selected reporting period' },
      ],
      available: c.hasBs && c.cogs !== 0,
      reason: !c.hasBs ? 'No Balance Sheet data has been categorised yet.' : c.cogs === 0 ? 'No cost of goods sold is categorised for this period, so the ratio has no denominator.' : undefined,
      limitation:
        'The textbook formula uses CREDIT purchases. Imported data does not identify purchases separately from cost of goods sold, so cost of goods sold is used as the proxy.',
      explanation: 'The average number of days taken to pay suppliers.',
    },
    {
      key: 'inventory_days',
      label: 'Inventory Days',
      group: 'efficiency',
      value: c.hasInventoryLedger && c.cogs !== 0 ? days(avgInventory, c.cogs) : null,
      unit: 'days',
      formula: `${c.hasOpening ? 'Average' : 'Closing'} Inventory ÷ Cost of Goods Sold × ${c.days} days in the period`,
      inputs: [
        money(`${c.hasOpening ? 'Average' : 'Closing'} Inventory`, avgInventory, 'Ledgers categorised as Inventory'),
        money('Cost of Goods Sold', c.cogs, 'Profit & Loss'),
        { label: 'Days in period', value: c.days, unit: 'number', source: 'Selected reporting period' },
      ],
      available: c.hasInventoryLedger && c.cogs !== 0,
      reason: !c.hasInventoryLedger
        ? 'No ledger is categorised as Inventory. Import stock data or map an inventory ledger.'
        : c.cogs === 0
          ? 'No cost of goods sold is categorised for this period.'
          : undefined,
      explanation: 'How long stock sits before it is sold.',
    },
    {
      key: 'asset_turnover',
      label: 'Asset Turnover',
      group: 'efficiency',
      value: c.hasBs && c.hasPl ? div(c.revenue, avgAssets) : null,
      unit: 'times',
      formula: `Revenue ÷ ${c.hasOpening ? 'Average' : 'Closing'} Total Assets`,
      inputs: [
        money('Revenue', c.revenue, 'Profit & Loss'),
        money(`${c.hasOpening ? 'Average' : 'Closing'} Total Assets`, avgAssets, 'Balance Sheet'),
      ],
      available: c.hasBs && c.hasPl && avgAssets !== 0,
      reason: avgAssets === 0 ? 'Total assets are zero.' : !c.hasBs ? 'No Balance Sheet data has been categorised yet.' : !c.hasPl ? 'No Profit & Loss activity in this period.' : undefined,
      limitation: c.days < 300 ? `Revenue covers ${c.days} days rather than a full year, so this figure is not annualised and should not be compared with an annual benchmark.` : undefined,
      explanation: 'How much revenue each rupee of assets generated.',
    },
  ];
}

function leverage(c: Ctx): RatioResult[] {
  return [
    {
      key: 'debt_to_equity',
      label: 'Debt-to-Equity',
      group: 'leverage',
      value: c.hasBs ? div(c.borrowings, c.equity) : null,
      unit: 'times',
      formula: 'Loans and Borrowings ÷ Equity',
      inputs: [
        money('Loans and Borrowings', c.borrowings, 'Ledgers categorised as Loans and Borrowings'),
        money('Equity', c.equity, 'Balance Sheet, including the profit for the period'),
      ],
      available: c.hasBs && c.equity !== 0,
      reason: !c.hasBs ? 'No Balance Sheet data has been categorised yet.' : c.equity === 0 ? 'Equity is zero, so the ratio cannot be calculated.' : undefined,
      limitation: 'Debt here means interest-bearing borrowings only. Trade payables and other current liabilities are excluded, which is the conventional treatment but not the only one.',
      explanation: 'How much borrowed money the business carries for each rupee of owners’ capital.',
    },
    {
      key: 'interest_coverage',
      label: 'Interest Coverage',
      group: 'leverage',
      value: c.hasPl && c.financeCost !== 0 ? div(c.ebit, c.financeCost) : null,
      unit: 'times',
      formula: 'EBIT ÷ Finance Costs',
      inputs: [money('EBIT (Operating Profit)', c.ebit, 'Profit & Loss'), money('Finance Costs', c.financeCost, 'Profit & Loss')],
      available: c.hasPl && c.financeCost !== 0,
      reason: !c.hasPl
        ? 'No Profit & Loss activity in this period.'
        : c.financeCost === 0
          ? 'No finance cost is categorised for this period, so there is no interest to cover.'
          : undefined,
      explanation: 'How many times over the operating profit covers the interest bill.',
    },
    {
      key: 'debt_ratio',
      label: 'Debt Ratio',
      group: 'leverage',
      value: c.hasBs ? div(c.totalLiabilities, c.totalAssets) : null,
      unit: 'times',
      formula: 'Total Liabilities ÷ Total Assets',
      inputs: [money('Total Liabilities', c.totalLiabilities, 'Balance Sheet'), money('Total Assets', c.totalAssets, 'Balance Sheet')],
      available: c.hasBs && c.totalAssets !== 0,
      reason: !c.hasBs ? 'No Balance Sheet data has been categorised yet.' : c.totalAssets === 0 ? 'Total assets are zero.' : undefined,
      explanation: 'The share of the asset base funded by liabilities rather than equity.',
    },
  ];
}
