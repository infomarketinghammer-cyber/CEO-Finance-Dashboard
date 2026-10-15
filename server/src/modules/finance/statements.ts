import {
  loadBalances,
  totalsBySection,
  sumSections,
  hasSectionData,
  type BalanceSet,
  type LedgerBalance,
  type PeriodRef,
  type BalanceOptions,
  type SectionTotal,
} from './engine.js';
import { add, sub, percentOf, type Minor } from '../../lib/money.js';
import { SECTION_ROLES } from '../mapping/categories.js';

/**
 * Statement builders.
 *
 * Each line carries the formula that produced it and the sections it drew from, so
 * a figure can be traced from the dashboard back to the ledgers behind it. A line
 * whose inputs are absent is marked unavailable rather than reported as zero.
 */

export interface StatementLine {
  key: string;
  label: string;
  value: Minor | null;
  available: boolean;
  /** How the value was derived, shown in the UI and in exports. */
  formula: string;
  /** 'total' lines are subtotals; 'detail' lines are drillable categories. */
  kind: 'detail' | 'subtotal' | 'total';
  indent: number;
  emphasis?: boolean;
  sections?: string[];
  children?: { categoryKey: string; label: string; total: Minor; ledgerCount: number }[];
  note?: string;
}

export interface ComparativeLine extends StatementLine {
  previousValue?: Minor | null;
  variance?: Minor | null;
  variancePercent?: number | null;
}

// ------------------------------------------------------------ Profit & Loss

export interface ProfitAndLoss {
  period: PeriodRef;
  lines: ComparativeLine[];
  revenue: Minor | null;
  grossProfit: Minor | null;
  ebitda: Minor | null;
  ebit: Minor | null;
  netProfit: Minor | null;
  totalExpenses: Minor | null;
  quality: BalanceSet['quality'];
  comparison: { period: PeriodRef; label: string } | null;
  isEmpty: boolean;
  methodology: string[];
}

function plFigures(balances: LedgerBalance[]) {
  const revenue = sumSections(balances, 'PL', SECTION_ROLES.revenue);
  const cogs = sumSections(balances, 'PL', SECTION_ROLES.cogs);
  const direct = sumSections(balances, 'PL', SECTION_ROLES.directExpenses);
  const opex = sumSections(balances, 'PL', SECTION_ROLES.operatingExpenses);
  const depreciation = sumSections(balances, 'PL', SECTION_ROLES.depreciation);
  const financeCost = sumSections(balances, 'PL', SECTION_ROLES.financeCost);
  const otherIncome = sumSections(balances, 'PL', SECTION_ROLES.otherIncome);
  const otherExpenses = sumSections(balances, 'PL', SECTION_ROLES.otherExpenses);
  const tax = sumSections(balances, 'PL', SECTION_ROLES.tax);

  const grossProfit = sub(revenue, add(cogs, direct));
  const ebitda = sub(grossProfit, opex);
  const ebit = sub(ebitda, depreciation);
  const profitBeforeTax = sub(add(ebit, otherIncome), add(financeCost, otherExpenses));
  const netProfit = sub(profitBeforeTax, tax);
  const totalExpenses = add(cogs, direct, opex, depreciation, financeCost, otherExpenses);

  return { revenue, cogs, direct, opex, depreciation, financeCost, otherIncome, otherExpenses, tax, grossProfit, ebitda, ebit, profitBeforeTax, netProfit, totalExpenses };
}

export async function computeProfitAndLoss(
  companyId: string,
  period: PeriodRef,
  opts: BalanceOptions & { comparison?: { period: PeriodRef; label: string } | null } = {},
): Promise<ProfitAndLoss> {
  const set = await loadBalances(companyId, period, opts);
  const f = plFigures(set.balances);

  const sectionDetail = totalsBySection(set.balances, 'PL');
  const detailFor = (sections: readonly string[]) =>
    sectionDetail.filter((s) => sections.includes(s.section)).flatMap((s) => s.lines);

  let comparisonFigures: ReturnType<typeof plFigures> | null = null;
  if (opts.comparison) {
    const prev = await loadBalances(companyId, opts.comparison.period, opts);
    comparisonFigures = plFigures(prev.balances);
  }

  const hasRevenue = hasSectionData(set.balances, 'PL', SECTION_ROLES.revenue);
  const hasAnyExpense = hasSectionData(set.balances, 'PL', [
    ...SECTION_ROLES.cogs,
    ...SECTION_ROLES.directExpenses,
    ...SECTION_ROLES.operatingExpenses,
    ...SECTION_ROLES.depreciation,
    ...SECTION_ROLES.financeCost,
    ...SECTION_ROLES.otherExpenses,
  ]);
  const hasAny = hasRevenue || hasAnyExpense;

  const line = (
    key: string,
    label: string,
    value: Minor,
    formula: string,
    kind: StatementLine['kind'],
    indent: number,
    available: boolean,
    extras: Partial<ComparativeLine> = {},
  ): ComparativeLine => {
    const prevValue = comparisonFigures ? (comparisonFigures as unknown as Record<string, Minor>)[key] : undefined;
    const variance = prevValue !== undefined && available ? sub(value, prevValue) : null;
    return {
      key,
      label,
      value: available ? value : null,
      available,
      formula,
      kind,
      indent,
      previousValue: prevValue !== undefined ? prevValue : undefined,
      variance,
      variancePercent: variance !== null && prevValue ? percentOf(variance, Math.abs(prevValue)) : null,
      ...extras,
    };
  };

  const lines: ComparativeLine[] = [
    line('revenue', 'Revenue', f.revenue, 'Sum of ledgers categorised as Revenue', 'detail', 0, hasRevenue, {
      sections: [...SECTION_ROLES.revenue],
      children: detailFor(SECTION_ROLES.revenue),
      note: hasRevenue ? undefined : 'No ledger is categorised as Revenue yet.',
    }),
    line('cogs', 'Cost of Goods Sold', f.cogs, 'Sum of ledgers categorised as Cost of Goods Sold', 'detail', 0, true, {
      sections: [...SECTION_ROLES.cogs],
      children: detailFor(SECTION_ROLES.cogs),
    }),
    line('direct', 'Direct Expenses', f.direct, 'Sum of ledgers categorised as Direct Expenses', 'detail', 0, true, {
      sections: [...SECTION_ROLES.directExpenses],
      children: detailFor(SECTION_ROLES.directExpenses),
    }),
    line('grossProfit', 'Gross Profit', f.grossProfit, 'Revenue − (Cost of Goods Sold + Direct Expenses)', 'subtotal', 0, hasAny, {
      emphasis: true,
    }),
    line('opex', 'Operating Expenses', f.opex, 'Sum of ledgers categorised as Operating Expenses', 'detail', 0, true, {
      sections: [...SECTION_ROLES.operatingExpenses],
      children: detailFor(SECTION_ROLES.operatingExpenses),
    }),
    line('ebitda', 'EBITDA', f.ebitda, 'Gross Profit − Operating Expenses (before depreciation, interest and tax)', 'subtotal', 0, hasAny, {
      note: hasSectionData(set.balances, 'PL', SECTION_ROLES.depreciation)
        ? undefined
        : 'No depreciation ledger is categorised, so EBITDA and EBIT are equal here.',
    }),
    line('depreciation', 'Depreciation & Amortisation', f.depreciation, 'Sum of ledgers categorised as Depreciation & Amortisation', 'detail', 0, true, {
      sections: [...SECTION_ROLES.depreciation],
      children: detailFor(SECTION_ROLES.depreciation),
    }),
    line('ebit', 'EBIT (Operating Profit)', f.ebit, 'EBITDA − Depreciation & Amortisation', 'subtotal', 0, hasAny),
    line('otherIncome', 'Other Income', f.otherIncome, 'Sum of ledgers categorised as Other Income', 'detail', 0, true, {
      sections: [...SECTION_ROLES.otherIncome],
      children: detailFor(SECTION_ROLES.otherIncome),
    }),
    line('financeCost', 'Finance Costs', f.financeCost, 'Sum of ledgers categorised as Finance Costs', 'detail', 0, true, {
      sections: [...SECTION_ROLES.financeCost],
      children: detailFor(SECTION_ROLES.financeCost),
    }),
    line('otherExpenses', 'Other Expenses', f.otherExpenses, 'Sum of ledgers categorised as Other Expenses', 'detail', 0, true, {
      sections: [...SECTION_ROLES.otherExpenses],
      children: detailFor(SECTION_ROLES.otherExpenses),
    }),
    line('profitBeforeTax', 'Profit Before Tax', f.profitBeforeTax, 'EBIT + Other Income − Finance Costs − Other Expenses', 'subtotal', 0, hasAny),
    line('tax', 'Tax Expense', f.tax, 'Sum of ledgers categorised as Tax Expense', 'detail', 0, true, {
      sections: [...SECTION_ROLES.tax],
      children: detailFor(SECTION_ROLES.tax),
      note: hasSectionData(set.balances, 'PL', SECTION_ROLES.tax) ? undefined : 'No tax ledger is categorised for this period.',
    }),
    line('netProfit', 'Net Profit', f.netProfit, 'Profit Before Tax − Tax Expense', 'total', 0, hasAny, { emphasis: true }),
  ];

  return {
    period,
    lines,
    revenue: hasRevenue ? f.revenue : null,
    grossProfit: hasAny ? f.grossProfit : null,
    ebitda: hasAny ? f.ebitda : null,
    ebit: hasAny ? f.ebit : null,
    netProfit: hasAny ? f.netProfit : null,
    totalExpenses: hasAnyExpense ? f.totalExpenses : null,
    quality: set.quality,
    comparison: opts.comparison ?? null,
    isEmpty: !hasAny,
    methodology: [
      'Gross Profit deducts both Cost of Goods Sold and Direct Expenses from Revenue, following the Indian trading-account convention.',
      'EBITDA is taken before depreciation, interest and tax, and before Other Income, so it reflects trading performance alone.',
      'Profit & Loss ledgers are measured on period movement only. Opening balances belong to the Balance Sheet and are not carried into the result.',
      'Figures cover the selected reporting period. A line with no categorised ledger is reported as unavailable rather than zero.',
    ],
  };
}

// ------------------------------------------------------------ Balance Sheet

export interface BalanceSheetDiagnostic {
  cause: string;
  detail: string;
  amount?: Minor;
  action: string;
}

export interface BalanceSheet {
  asOfDate: string;
  financialYearStart: string | null;
  assets: SectionTotal[];
  liabilities: SectionTotal[];
  equity: SectionTotal[];
  totalAssets: Minor;
  totalLiabilities: Minor;
  totalEquity: Minor;
  /** Current-period result, included within equity so the equation can hold. */
  profitForPeriod: Minor | null;
  equationDifference: Minor;
  balances: boolean;
  diagnostics: BalanceSheetDiagnostic[];
  quality: BalanceSet['quality'];
  isEmpty: boolean;
  methodology: string[];
}

export async function computeBalanceSheet(
  companyId: string,
  asOfDate: string,
  opts: BalanceOptions & { financialYearStart?: string | null } = {},
): Promise<BalanceSheet> {
  const fyStart = opts.financialYearStart ?? `${asOfDate.slice(0, 4)}-01-01`;
  const period: PeriodRef = { from: fyStart, to: asOfDate, label: `As at ${asOfDate}` };

  const set = await loadBalances(companyId, period, opts);

  const assets = totalsBySection(set.balances, 'BS', [...SECTION_ROLES.assets]);
  const liabilities = totalsBySection(set.balances, 'BS', [...SECTION_ROLES.liabilities]);
  const equitySections = totalsBySection(set.balances, 'BS', [...SECTION_ROLES.equity]);

  const totalAssets = sumSections(set.balances, 'BS', SECTION_ROLES.assets);
  const totalLiabilities = sumSections(set.balances, 'BS', SECTION_ROLES.liabilities);
  const equityFromLedgers = sumSections(set.balances, 'BS', SECTION_ROLES.equity);

  // The year's result is not yet in a reserve ledger, so it is shown as its own
  // equity line. Without this an otherwise correct Balance Sheet cannot balance.
  const pl = plFigures(set.balances);
  const hasPlActivity =
    hasSectionData(set.balances, 'PL', SECTION_ROLES.revenue) ||
    hasSectionData(set.balances, 'PL', [...SECTION_ROLES.cogs, ...SECTION_ROLES.operatingExpenses, ...SECTION_ROLES.directExpenses]);
  const profitForPeriod = hasPlActivity ? pl.netProfit : null;

  const totalEquity = add(equityFromLedgers, profitForPeriod ?? 0);

  const equity: SectionTotal[] = [...equitySections];
  if (profitForPeriod !== null) {
    equity.push({
      // A distinct section identifier: this is a derived line, not the equity
      // ledger section, and the two must not collide when sections are keyed.
      section: 'equity_result',
      label: 'Profit for the period',
      total: profitForPeriod,
      lines: [
        {
          categoryKey: '__profit_for_period',
          label: `Profit & Loss for ${fyStart} to ${asOfDate}`,
          total: profitForPeriod,
          ledgerCount: 0,
        },
      ],
    });
  }

  const equationDifference = sub(totalAssets, add(totalLiabilities, totalEquity));
  const balances = equationDifference === 0;

  const diagnostics: BalanceSheetDiagnostic[] = [];
  if (!balances) {
    if (set.quality.unmappedLedgerCount > 0) {
      diagnostics.push({
        cause: 'Unmapped ledgers',
        detail:
          set.quality.unmappedLedgerCount === 1
            ? '1 ledger carries a balance but has no financial category, so it is excluded from both sides of the statement.'
            : `${set.quality.unmappedLedgerCount} ledgers carry a balance but have no financial category, so they are excluded from both sides of the statement.`,
        amount: set.quality.unmappedNet,
        action: 'Open Account Mapping and assign a category to each unmapped ledger.',
      });
    }
    if (set.quality.ledgersWithoutOpeningBalance > 0) {
      diagnostics.push({
        cause: 'Missing opening balances',
        detail: `${set.quality.ledgersWithoutOpeningBalance} ledger${set.quality.ledgersWithoutOpeningBalance === 1 ? ' has' : 's have'} no opening balance for this financial year. Where the business did not start at zero, the Balance Sheet cannot balance without them.`,
        action: 'Import the Opening Balances category from the Excel Import Center.',
      });
    }
    const imbalancedVouchers = await countImbalancedVouchers(companyId, fyStart, asOfDate);
    if (imbalancedVouchers.count > 0) {
      diagnostics.push({
        cause: 'Vouchers that do not balance',
        detail:
          imbalancedVouchers.count === 1
            ? `1 voucher in this period has debits that do not equal credits, by a net of ${(imbalancedVouchers.net / 100).toFixed(2)}.`
            : `${imbalancedVouchers.count} vouchers in this period have debits that do not equal credits, by a net of ${(imbalancedVouchers.net / 100).toFixed(2)}.`,
        amount: imbalancedVouchers.net,
        action: 'Review those vouchers in the Profit & Loss drill-down, or correct them in the source file and re-import.',
      });
    }
    if (!diagnostics.length) {
      diagnostics.push({
        cause: 'Incomplete source data',
        detail:
          'Every ledger is categorised and every voucher balances, so the difference points to records that were never imported — most often opening balances or a date range that excludes part of the year.',
        amount: equationDifference,
        action: 'Check the import history for the periods and categories covered, and import anything missing.',
      });
    }
  }

  return {
    asOfDate,
    financialYearStart: fyStart,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    profitForPeriod,
    equationDifference,
    balances,
    diagnostics,
    quality: set.quality,
    isEmpty: set.isEmpty,
    methodology: [
      'Balances are the opening position for the financial year plus all voucher movement up to the reporting date.',
      'The result for the period is presented within Equity as "Profit for the period", because it has not yet been transferred to reserves.',
      'The statement is never forced to balance. Any difference is reported with its likely causes.',
    ],
  };
}

async function countImbalancedVouchers(companyId: string, from: string, to: string): Promise<{ count: number; net: Minor }> {
  const { db } = await import('../../db/index.js');
  const rows = await db('voucher_lines')
    .join('vouchers', 'voucher_lines.voucher_id', 'vouchers.id')
    .where('voucher_lines.company_id', companyId)
    .andWhere('vouchers.voucher_date', '>=', from)
    .andWhere('vouchers.voucher_date', '<=', to)
    .groupBy('vouchers.id')
    .select('vouchers.id')
    .sum({ debit: 'voucher_lines.debit_minor' })
    .sum({ credit: 'voucher_lines.credit_minor' });

  let count = 0;
  let net = 0;
  for (const r of rows as Array<Record<string, unknown>>) {
    const diff = Math.round(Number(r.debit ?? 0)) - Math.round(Number(r.credit ?? 0));
    if (diff !== 0) {
      count++;
      net += diff;
    }
  }
  return { count, net };
}

// ---------------------------------------------------------- Equity statement

export interface EquityStatement {
  period: PeriodRef;
  entityType: string;
  lines: StatementLine[];
  openingEquity: Minor | null;
  closingEquity: Minor | null;
  balanceSheetEquity: Minor | null;
  reconciles: boolean;
  unexplainedDifference: Minor | null;
  quality: BalanceSet['quality'];
  isEmpty: boolean;
  methodology: string[];
}

export async function computeEquityStatement(
  companyId: string,
  period: PeriodRef,
  entityType: string,
  opts: BalanceOptions = {},
): Promise<EquityStatement> {
  const set = await loadBalances(companyId, period, opts);

  const equityLedgers = set.balances.filter((b) => b.statement === 'BS' && b.section === 'equity');

  const pick = (categoryKey: string) => equityLedgers.filter((b) => b.categoryKey === categoryKey);

  // Opening equity is the position carried in, before this period's movement.
  const openingNet = equityLedgers.reduce((acc, b) => add(acc, sub(b.openingDebit, b.openingCredit)), 0 as Minor);
  const openingEquity = -openingNet; // credit-normal presentation

  const movementOf = (categoryKey: string) => {
    const rows = pick(categoryKey);
    const net = rows.reduce((acc, b) => add(acc, sub(b.periodDebit, b.periodCredit)), 0 as Minor);
    return { net, rows };
  };

  const capital = movementOf('equity_capital');
  const reserves = movementOf('equity_reserves');
  const drawings = movementOf('equity_drawings');
  const other = movementOf('equity_other');

  const capitalIntroduced = -capital.net; // credits increase capital
  const reserveMovement = -reserves.net;
  const drawingsAmount = drawings.net; // debits increase drawings
  const otherMovement = -other.net;

  const pl = plFigures(set.balances);
  const hasPl =
    hasSectionData(set.balances, 'PL', SECTION_ROLES.revenue) ||
    hasSectionData(set.balances, 'PL', [...SECTION_ROLES.cogs, ...SECTION_ROLES.operatingExpenses]);
  const profit = hasPl ? pl.netProfit : 0;

  const closingEquity = add(openingEquity, capitalIntroduced, profit, reserveMovement, otherMovement, -drawingsAmount);

  const hasEquityData = equityLedgers.length > 0;

  // Reconcile against the Balance Sheet equity at the same date.
  const bsEquity = add(
    equityLedgers.reduce((acc, b) => add(acc, b.presented), 0 as Minor),
    profit,
  );
  const unexplained = sub(closingEquity, bsEquity);

  const isCompany = ['private_limited', 'public_limited'].includes(entityType);
  const drawingsLabel = isCompany ? 'Dividends paid' : 'Drawings';
  const capitalLabel = isCompany ? 'Share capital issued' : 'Capital introduced';

  const lines: StatementLine[] = [
    {
      key: 'opening',
      label: 'Opening Equity',
      value: hasEquityData ? openingEquity : null,
      available: hasEquityData,
      formula: 'Opening balances of all ledgers categorised under Equity',
      kind: 'subtotal',
      indent: 0,
      note: hasEquityData ? undefined : 'No ledger is categorised under Equity yet.',
    },
    {
      key: 'capital',
      label: capitalLabel,
      value: capitalIntroduced,
      available: true,
      formula: 'Net credits to Capital Account ledgers during the period',
      kind: 'detail',
      indent: 1,
    },
    {
      key: 'profit',
      label: 'Profit or loss for the period',
      value: hasPl ? profit : null,
      available: hasPl,
      formula: 'Net Profit from the Profit & Loss for the same period',
      kind: 'detail',
      indent: 1,
      note: hasPl ? undefined : 'No Profit & Loss activity in this period.',
    },
    {
      key: 'drawings',
      label: drawingsLabel,
      value: -drawingsAmount,
      available: true,
      formula: `Net debits to ${drawingsLabel} ledgers during the period, shown as a reduction`,
      kind: 'detail',
      indent: 1,
    },
    {
      key: 'reserves',
      label: 'Reserve movements',
      value: reserveMovement,
      available: true,
      formula: 'Net credits to Reserves and Surplus ledgers during the period',
      kind: 'detail',
      indent: 1,
    },
    {
      key: 'other',
      label: 'Other equity adjustments',
      value: otherMovement,
      available: true,
      formula: 'Net credits to Other Equity ledgers during the period',
      kind: 'detail',
      indent: 1,
    },
    {
      key: 'closing',
      label: 'Closing Equity',
      value: hasEquityData || hasPl ? closingEquity : null,
      available: hasEquityData || hasPl,
      formula: `Opening Equity + ${capitalLabel} + Profit + Reserve movements + Other adjustments − ${drawingsLabel}`,
      kind: 'total',
      indent: 0,
      emphasis: true,
    },
  ];

  return {
    period,
    entityType,
    lines,
    openingEquity: hasEquityData ? openingEquity : null,
    closingEquity: hasEquityData || hasPl ? closingEquity : null,
    balanceSheetEquity: hasEquityData || hasPl ? bsEquity : null,
    reconciles: unexplained === 0,
    unexplainedDifference: unexplained,
    quality: set.quality,
    isEmpty: !hasEquityData && !hasPl,
    methodology: [
      isCompany
        ? 'Presented for a company: capital movements are shown as share capital and distributions as dividends.'
        : 'Presented for a proprietorship or partnership: capital movements are shown as capital introduced and withdrawals as drawings.',
      'The closing figure is reconciled against the equity total on the Balance Sheet at the same date. Any unexplained difference is reported rather than absorbed.',
    ],
  };
}

export { plFigures };
