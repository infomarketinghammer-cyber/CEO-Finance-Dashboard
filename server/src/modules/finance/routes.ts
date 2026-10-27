import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { add, sub, percentOf, type Minor } from '../../lib/money.js';
import { today, newId, nowIso } from '../../lib/ids.js';
import { writeJson, readJson } from '../../lib/json.js';
import { recordAudit } from '../audit/service.js';
import { loadBalances, sumSections, totalsBySection, hasSectionData } from './engine.js';
import { computeProfitAndLoss, computeBalanceSheet, computeEquityStatement, plFigures } from './statements.js';
import { computeRatios } from './ratios.js';
import { RATIO_INPUTS, groupedInputs } from './ratioInputs.js';
import {
  evaluateCustomRatios,
  validateDefinition,
  FormulaError,
  type CustomRatioDefinition,
} from './customRatios.js';
import { outstandingTotals, listOutstanding, getAgeingBuckets } from './ageing.js';
import { computeForecast, upcomingPayments, type ScenarioAdjustment } from './forecast.js';
import { recordForecastRun, scoreForecastRuns } from './backtest.js';
import { resolvePeriod, monthlyBuckets } from './periods.js';
import { SECTION_ROLES } from '../mapping/categories.js';

export const financeRouter = Router();
financeRouter.use(authenticate);

const periodQuery = (req: { query: Record<string, unknown>; companyId?: string }) => ({
  companyId: req.companyId!,
  financialYearId: (req.query.financialYearId as string) || null,
  periodType: (req.query.periodType as string) || 'financial_year',
  from: req.query.from as string | undefined,
  to: req.query.to as string | undefined,
});

const balanceOpts = (req: { query: Record<string, unknown> }) => ({
  confirmedOnly: req.query.confirmedOnly === 'true',
  costCentre: (req.query.costCentre as string) || null,
});

// ------------------------------------------------------------------ overview

financeRouter.get(
  '/dashboard',
  requireCapability('dashboard.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));
    const opts = { ...balanceOpts(req), financialYearId: resolved.financialYearId };
    const asOf = resolved.period.to > today() ? today() : resolved.period.to;

    const company = await db('companies').where({ id: req.companyId }).first();

    const [current, previous, ageing] = await Promise.all([
      loadBalances(req.companyId!, resolved.period, opts),
      loadBalances(req.companyId!, resolved.previousPeriod, opts),
      outstandingTotals(req.companyId!, asOf),
    ]);

    const closingSet = await loadBalances(
      req.companyId!,
      { from: resolved.financialYearStart ?? resolved.period.from, to: resolved.period.to },
      opts,
    );

    const pl = plFigures(current.balances);
    const plPrev = plFigures(previous.balances);

    const hasPl = hasSectionData(current.balances, 'PL', SECTION_ROLES.revenue) || hasSectionData(current.balances, 'PL', SECTION_ROLES.operatingExpenses);
    const hasPrevPl = hasSectionData(previous.balances, 'PL', SECTION_ROLES.revenue) || hasSectionData(previous.balances, 'PL', SECTION_ROLES.operatingExpenses);
    const hasBs = hasSectionData(closingSet.balances, 'BS', [...SECTION_ROLES.assets, ...SECTION_ROLES.liabilities]);

    const cash = sumSections(closingSet.balances, 'BS', ['cash_and_bank']);
    const hasCash = closingSet.balances.some((b) => b.section === 'cash_and_bank');
    const currentAssets = sumSections(closingSet.balances, 'BS', SECTION_ROLES.currentAssets);
    const currentLiabilities = sumSections(closingSet.balances, 'BS', SECTION_ROLES.currentLiabilities);

    // Budget utilisation across budgets overlapping the period.
    const budgetUtil = await budgetUtilisation(req.companyId!, resolved.period.from, resolved.period.to);

    // Forecast closing cash — only meaningful when a cash ledger exists.
    let forecastClosing: Minor | null = null;
    let forecastNote: string | undefined;
    if (hasCash) {
      try {
        const f = await computeForecast(req.companyId!, asOf, 90, { financialYearStart: resolved.financialYearStart });
        forecastClosing = f.scenarios.expected.closingBalance;
        forecastNote = `${f.learning ? 'Learned' : 'Rule-based'} 90-day projection, expected case. Data sufficiency: ${f.dataSufficiency.level}.`;
      } catch {
        forecastNote = 'The forecast could not be produced from the current data.';
      }
    } else {
      forecastNote = 'No ledger is categorised as Cash and Bank, so no cash position can be projected.';
    }

    const kpi = (
      key: string,
      label: string,
      value: Minor,
      available: boolean,
      previousValue: Minor | null,
      opts2: { reason?: string; note?: string; link?: string; higherIsBetter?: boolean } = {},
    ) => {
      const variance = available && previousValue !== null ? sub(value, previousValue) : null;
      return {
        key,
        label,
        value: available ? value : null,
        available,
        reason: available ? undefined : opts2.reason,
        previousValue,
        variance,
        variancePercent: variance !== null && previousValue ? percentOf(variance, Math.abs(previousValue)) : null,
        comparisonLabel: previousValue !== null ? 'vs previous period' : null,
        note: opts2.note,
        link: opts2.link,
        higherIsBetter: opts2.higherIsBetter ?? true,
      };
    };

    const kpis = [
      kpi('cash', 'Cash and Bank', cash, hasCash, null, {
        reason: 'No ledger is categorised as Cash and Bank. Map one in Account Mapping to see this.',
        note: `As at ${asOf}`,
        link: '/cash-and-bank',
      }),
      kpi('receivables', 'Total Receivables', ageing.receivables.total, ageing.receivables.totalCount > 0, null, {
        reason: 'No outstanding receivables have been imported.',
        note: ageing.receivables.overdueCount > 0 ? `${ageing.receivables.overdueCount} overdue` : undefined,
        link: '/receivables',
      }),
      kpi('payables', 'Total Payables', ageing.payables.total, ageing.payables.totalCount > 0, null, {
        reason: 'No outstanding payables have been imported.',
        note: ageing.payables.overdueCount > 0 ? `${ageing.payables.overdueCount} overdue` : undefined,
        link: '/payables',
        higherIsBetter: false,
      }),
      kpi('revenue', 'Revenue', pl.revenue, hasPl, hasPrevPl ? plPrev.revenue : null, {
        reason: 'No ledger is categorised as Revenue for this period.',
        link: '/profit-and-loss',
      }),
      kpi('grossProfit', 'Gross Profit', pl.grossProfit, hasPl, hasPrevPl ? plPrev.grossProfit : null, {
        reason: 'No Profit & Loss activity in this period.',
        link: '/profit-and-loss',
      }),
      kpi('netProfit', 'Net Profit', pl.netProfit, hasPl, hasPrevPl ? plPrev.netProfit : null, {
        reason: 'No Profit & Loss activity in this period.',
        link: '/profit-and-loss',
      }),
      kpi('totalExpenses', 'Total Expenses', pl.totalExpenses, hasPl, hasPrevPl ? plPrev.totalExpenses : null, {
        reason: 'No expense ledger is categorised for this period.',
        link: '/expenses',
        higherIsBetter: false,
      }),
      kpi('workingCapital', 'Working Capital', sub(currentAssets, currentLiabilities), hasBs, null, {
        reason: 'No current assets or liabilities are categorised yet.',
        note: 'Current Assets − Current Liabilities',
        link: '/balance-sheet',
      }),
      {
        key: 'budgetUtilisation',
        label: 'Budget Utilisation',
        value: budgetUtil.available ? Math.round(budgetUtil.utilisationPercent) : null,
        available: budgetUtil.available,
        reason: budgetUtil.available ? undefined : 'No budgets cover this period.',
        previousValue: null,
        variance: null,
        variancePercent: null,
        comparisonLabel: null,
        note: budgetUtil.available ? `${fmtMinor(budgetUtil.actual)} of ${fmtMinor(budgetUtil.budgeted)}` : undefined,
        link: '/budgets',
        isPercent: true,
        higherIsBetter: false,
      },
      kpi('forecastClosing', 'Forecast Closing Cash (90 days)', forecastClosing ?? 0, forecastClosing !== null, null, {
        reason: forecastNote,
        note: forecastNote,
        link: '/cash-flow-forecast',
      }),
    ];

    // --------------------------------------------------------------- charts
    const buckets = monthlyBuckets(resolved.period);
    const trend = await monthlyTrend(req.companyId!, buckets, opts);

    const expenseBreakdown = totalsBySection(current.balances, 'PL', [
      ...SECTION_ROLES.cogs,
      ...SECTION_ROLES.directExpenses,
      ...SECTION_ROLES.operatingExpenses,
      ...SECTION_ROLES.depreciation,
      ...SECTION_ROLES.financeCost,
      ...SECTION_ROLES.otherExpenses,
    ])
      .flatMap((s) => s.lines)
      .filter((l) => l.total !== 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);

    const budgetVsActual = await budgetVsActualSeries(req.companyId!, resolved.period.from, resolved.period.to);

    const lastImport = await db('import_batches')
      .where({ company_id: req.companyId, status: 'committed' })
      .orderBy('completed_at', 'desc')
      .first();

    const recentImports = await db('import_batches')
      .where({ company_id: req.companyId })
      .orderBy('created_at', 'desc')
      .limit(5);

    const alerts = await db('alerts')
      .where({ company_id: req.companyId })
      .whereNull('resolved_at')
      .orderByRaw("CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END")
      .limit(6);

    res.json({
      company: { id: company.id, name: company.name, currency: company.currency, currencyScale: company.currency_scale, isDemo: Boolean(company.is_demo) },
      period: resolved.period,
      periodType: resolved.type,
      financialYearId: resolved.financialYearId,
      asOfDate: asOf,
      kpis,
      charts: {
        trend,
        expenseBreakdown,
        receivablesAgeing: ageing.receivables.buckets,
        payablesAgeing: ageing.payables.buckets,
        receivablesVsPayables: { receivables: ageing.receivables.total, payables: ageing.payables.total },
        budgetVsActual,
      },
      dataSource: {
        kind: 'excel_import',
        label: 'Excel Import',
        lastImportAt: lastImport?.completed_at ?? null,
        lastImportFile: lastImport?.file_name ?? null,
        lastImportCategory: lastImport?.category ?? null,
      },
      recentImports: recentImports.map((b: Record<string, any>) => ({
        id: b.id,
        fileName: b.file_name,
        category: b.category,
        status: b.status,
        createdAt: b.created_at,
        completedAt: b.completed_at,
        totals: readJson(b.totals, null),
      })),
      alerts: alerts.map(serialiseAlert),
      quality: closingSet.quality,
      isEmpty: closingSet.isEmpty && !hasPl,
    });
  }),
);

// ------------------------------------------------------------ Profit & Loss

financeRouter.get(
  '/profit-and-loss',
  requireCapability('statements.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));
    const comparisonMode = (req.query.comparison as string) ?? 'previous';

    const comparison =
      comparisonMode === 'none'
        ? null
        : comparisonMode === 'last_year'
          ? { period: resolved.samePeriodLastYear, label: 'Same period last year' }
          : { period: resolved.previousPeriod, label: 'Previous period' };

    const pl = await computeProfitAndLoss(req.companyId!, resolved.period, {
      ...balanceOpts(req),
      financialYearId: resolved.financialYearId,
      comparison,
    });

    await recordAudit({
      action: 'report.viewed',
      summary: `Viewed Profit & Loss for ${resolved.period.label}`,
      companyId: req.companyId,
      entityType: 'report',
      entityId: 'profit_and_loss',
      req,
    });

    res.json({ ...pl, periodMeta: resolved, generatedAt: nowIso() });
  }),
);

// ------------------------------------------------------------ Balance Sheet

financeRouter.get(
  '/balance-sheet',
  requireCapability('statements.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));
    const asOfDate = (req.query.asOfDate as string) ?? resolved.period.to;

    const bs = await computeBalanceSheet(req.companyId!, asOfDate, {
      ...balanceOpts(req),
      financialYearId: resolved.financialYearId,
      financialYearStart: resolved.financialYearStart,
    });

    let comparative = null;
    if (req.query.comparison !== 'none') {
      const prevDate = resolved.samePeriodLastYear.to;
      const prevBs = await computeBalanceSheet(req.companyId!, prevDate, {
        ...balanceOpts(req),
        financialYearStart: resolved.financialYearStart ? `${Number(resolved.financialYearStart.slice(0, 4)) - 1}${resolved.financialYearStart.slice(4)}` : null,
      });
      comparative = {
        asOfDate: prevDate,
        totalAssets: prevBs.totalAssets,
        totalLiabilities: prevBs.totalLiabilities,
        totalEquity: prevBs.totalEquity,
        assets: prevBs.assets,
        liabilities: prevBs.liabilities,
        equity: prevBs.equity,
      };
    }

    await recordAudit({
      action: 'report.viewed',
      summary: `Viewed Balance Sheet as at ${asOfDate}`,
      companyId: req.companyId,
      entityType: 'report',
      entityId: 'balance_sheet',
      req,
    });

    res.json({ ...bs, comparative, periodMeta: resolved, generatedAt: nowIso() });
  }),
);

// --------------------------------------------------------- Equity statement

financeRouter.get(
  '/equity',
  requireCapability('statements.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));
    const company = await db('companies').where({ id: req.companyId }).first();

    const equity = await computeEquityStatement(req.companyId!, resolved.period, company.entity_type, {
      ...balanceOpts(req),
      financialYearId: resolved.financialYearId,
    });

    res.json({ ...equity, periodMeta: resolved, generatedAt: nowIso() });
  }),
);

// ------------------------------------------------------------------- ratios

financeRouter.get(
  '/ratios',
  requireCapability('ratios.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));

    const current = await computeRatios(req.companyId!, resolved.period, {
      ...balanceOpts(req),
      financialYearId: resolved.financialYearId,
      financialYearStart: resolved.financialYearStart,
    });

    // Trend across the months of the period, for ratios that make sense monthly.
    const trendRequested = req.query.trend === 'true';
    let trend: { label: string; period: { from: string; to: string }; values: Record<string, number | null> }[] = [];

    if (trendRequested) {
      const buckets = monthlyBuckets(resolved.period).slice(-12);
      for (const b of buckets) {
        const r = await computeRatios(req.companyId!, { from: b.from, to: b.to }, {
          ...balanceOpts(req),
          financialYearStart: resolved.financialYearStart,
        });
        trend.push({
          label: b.label,
          period: { from: b.from, to: b.to },
          values: Object.fromEntries(r.ratios.map((x) => [x.key, x.available ? x.value : null])),
        });
      }
    }

    const benchmarksRow = await db('app_settings').where({ company_id: req.companyId, key: 'ratio_benchmarks' }).first();
    const benchmarks = benchmarksRow ? readJson<Record<string, number>>(benchmarksRow.value, {}) : {};

    // §17 — custom ratios defined by this organisation, evaluated against the
    // same inputs as the built-in ones so the two can never disagree.
    const customDefs = await loadCustomRatios(req.companyId!);
    const customResults = evaluateCustomRatios(customDefs, current.inputs);

    res.json({
      ...current,
      ratios: [...current.ratios, ...customResults],
      trend,
      benchmarks,
      benchmarkNote:
        Object.keys(benchmarks).length === 0
          ? 'No industry benchmarks have been configured. Benchmarks are entered manually in Settings — ArthSetu does not supply industry data.'
          : 'Benchmarks shown were entered manually by your organisation, not sourced from an industry database.',
      periodMeta: resolved,
      generatedAt: nowIso(),
    });
  }),
);

// ----------------------------------------------------- custom ratio builder

/** Custom definitions live alongside the other per-company settings. */
async function loadCustomRatios(companyId: string): Promise<CustomRatioDefinition[]> {
  const row = await db('app_settings').where({ company_id: companyId, key: 'custom_ratios' }).first();
  if (!row) return [];
  const parsed = readJson<CustomRatioDefinition[]>(row.value, []);
  return Array.isArray(parsed) ? parsed : [];
}

async function saveCustomRatios(companyId: string, defs: CustomRatioDefinition[], userId: string): Promise<void> {
  const existing = await db('app_settings').where({ company_id: companyId, key: 'custom_ratios' }).first();
  const payload = {
    company_id: companyId,
    key: 'custom_ratios',
    value: writeJson(defs),
    updated_by: userId,
    updated_at: nowIso(),
  };

  if (existing) {
    await db('app_settings').where({ id: existing.id }).update(payload);
  } else {
    await db('app_settings').insert({ id: newId(), created_at: nowIso(), ...payload });
  }
}

/** The inputs a formula may reference, grouped for the picker. */
financeRouter.get(
  '/ratios/inputs',
  requireCapability('ratios.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));
    const current = await computeRatios(req.companyId!, resolved.period, {
      ...balanceOpts(req),
      financialYearId: resolved.financialYearId,
      financialYearStart: resolved.financialYearStart,
    });

    res.json({
      groups: groupedInputs(),
      // Current values let the builder preview a formula before it is saved,
      // and show which inputs this company's data cannot supply yet.
      values: current.inputs,
      unavailable: RATIO_INPUTS.filter((i) => current.inputs[i.key] === null).map((i) => i.key),
      syntax: 'Use the input names with + - * / and brackets, for example: (currentAssets - inventory) / currentLiabilities',
    });
  }),
);

financeRouter.get(
  '/ratios/custom',
  requireCapability('ratios.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    res.json({ ratios: await loadCustomRatios(req.companyId!) });
  }),
);

const customRatioSchema = z.object({
  key: z.string().max(60).optional(),
  label: z.string().min(1).max(120),
  formula: z.string().min(1).max(500),
  unit: z.enum(['times', 'percent', 'days']),
  explanation: z.string().max(600).optional(),
  group: z.enum(['liquidity', 'profitability', 'efficiency', 'leverage']).optional(),
});

/** Create or update a custom ratio. Requires the settings capability, not just view. */
financeRouter.put(
  '/ratios/custom',
  requireCapability('settings.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const input = customRatioSchema.parse(req.body);

    let definition: CustomRatioDefinition;
    try {
      definition = validateDefinition(input);
    } catch (err) {
      if (err instanceof FormulaError) throw badRequest(err.message);
      throw err;
    }

    const defs = await loadCustomRatios(req.companyId!);
    const index = defs.findIndex((d) => d.key === definition.key);
    const isUpdate = index >= 0;

    if (isUpdate) defs[index] = definition;
    else defs.push(definition);

    await saveCustomRatios(req.companyId!, defs, req.user!.id);
    await recordAudit({
      req,
      action: isUpdate ? 'ratio.custom_updated' : 'ratio.custom_created',
      summary: `${isUpdate ? 'Updated' : 'Created'} the custom ratio "${definition.label}"`,
      entityType: 'custom_ratio',
      entityId: definition.key,
      meta: { formula: definition.formula, unit: definition.unit },
    });

    res.status(isUpdate ? 200 : 201).json({ ratio: definition });
  }),
);

/** Checks a formula without saving it, so the builder can show errors live. */
financeRouter.post(
  '/ratios/custom/preview',
  requireCapability('ratios.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const input = customRatioSchema.parse(req.body);
    const resolved = await resolvePeriod(periodQuery(req));

    let definition: CustomRatioDefinition;
    try {
      definition = validateDefinition(input);
    } catch (err) {
      if (err instanceof FormulaError) {
        return res.status(200).json({ valid: false, error: err.message });
      }
      throw err;
    }

    const current = await computeRatios(req.companyId!, resolved.period, {
      ...balanceOpts(req),
      financialYearId: resolved.financialYearId,
      financialYearStart: resolved.financialYearStart,
    });

    const [result] = evaluateCustomRatios([definition], current.inputs);
    res.json({ valid: true, result });
  }),
);

financeRouter.delete(
  '/ratios/custom/:key',
  requireCapability('settings.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const defs = await loadCustomRatios(req.companyId!);
    const remaining = defs.filter((d) => d.key !== req.params.key);
    if (remaining.length === defs.length) throw notFound('That custom ratio could not be found.');

    await saveCustomRatios(req.companyId!, remaining, req.user!.id);
    await recordAudit({
      req,
      action: 'ratio.custom_deleted',
      summary: `Deleted the custom ratio "${defs.find((d) => d.key === req.params.key)?.label ?? req.params.key}"`,
      entityType: 'custom_ratio',
      entityId: req.params.key,
    });

    res.json({ deleted: req.params.key });
  }),
);

// ------------------------------------------------------------- cash and bank

financeRouter.get(
  '/cash-and-bank',
  requireCapability('cash.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));
    const asOfDate = (req.query.asOfDate as string) ?? resolved.period.to;

    const set = await loadBalances(req.companyId!, { from: resolved.financialYearStart ?? resolved.period.from, to: asOfDate }, {
      ...balanceOpts(req),
      financialYearId: resolved.financialYearId,
    });

    const accounts = set.balances
      .filter((b) => b.section === 'cash_and_bank')
      .map((b) => ({
        ledgerId: b.ledgerId,
        ledgerName: b.ledgerName,
        groupName: b.groupName,
        opening: sub(b.openingDebit, b.openingCredit),
        received: b.periodDebit,
        paid: b.periodCredit,
        closing: b.presented,
        transactionCount: b.transactionCount,
        mappingStatus: b.mappingStatus,
      }))
      .sort((a, b) => b.closing - a.closing);

    const buckets = monthlyBuckets({ from: resolved.period.from, to: asOfDate });
    const movement: { label: string; inflow: Minor; outflow: Minor; closing: Minor }[] = [];

    for (const bucket of buckets) {
      const s = await loadBalances(req.companyId!, { from: resolved.financialYearStart ?? bucket.from, to: bucket.to }, {
        financialYearId: resolved.financialYearId,
      });
      const monthSet = await loadBalances(req.companyId!, { from: bucket.from, to: bucket.to }, {});
      movement.push({
        label: bucket.label,
        inflow: monthSet.balances.filter((b) => b.section === 'cash_and_bank').reduce((acc, b) => add(acc, b.periodDebit), 0 as Minor),
        outflow: monthSet.balances.filter((b) => b.section === 'cash_and_bank').reduce((acc, b) => add(acc, b.periodCredit), 0 as Minor),
        closing: sumSections(s.balances, 'BS', ['cash_and_bank']),
      });
    }

    res.json({
      asOfDate,
      accounts,
      total: accounts.reduce((acc, a) => add(acc, a.closing), 0 as Minor),
      movement,
      available: accounts.length > 0,
      reason: accounts.length ? undefined : 'No ledger is categorised as Cash and Bank. Assign the category in Account Mapping to populate this module.',
      quality: set.quality,
      periodMeta: resolved,
    });
  }),
);

// ---------------------------------------------------- receivables / payables

for (const table of ['receivables', 'payables'] as const) {
  financeRouter.get(
    `/${table}`,
    table === 'receivables' ? requireCapability('receivables.view') : requireCapability('payables.view'),
    resolveCompany,
    asyncHandler(async (req, res) => {
      const asOfDate = (req.query.asOfDate as string) ?? today();
      const result = await listOutstanding({
        companyId: req.companyId!,
        table,
        asOfDate,
        search: (req.query.search as string) || undefined,
        bucketKey: (req.query.bucket as string) || undefined,
        partyName: (req.query.party as string) || undefined,
        includeSettled: req.query.includeSettled === 'true',
        page: Number(req.query.page ?? 1),
        pageSize: Number(req.query.pageSize ?? 50),
        sortBy: (req.query.sortBy as 'party' | 'dueDate' | 'outstanding' | 'overdueDays') || 'overdueDays',
        sortDir: (req.query.sortDir as 'asc' | 'desc') || 'desc',
      });

      res.json({ ...result, buckets: await getAgeingBuckets(req.companyId!), asOfDate });
    }),
  );
}

/** Sales role: the same receivables data, narrowed to the caller's own customers. */
financeRouter.get(
  '/my-customers/receivables',
  requireCapability('receivables.view.assigned'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const asOfDate = (req.query.asOfDate as string) ?? today();
    const result = await listOutstanding({
      companyId: req.companyId!,
      table: 'receivables',
      asOfDate,
      search: (req.query.search as string) || undefined,
      restrictToOwnerEmail: req.user!.email,
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.pageSize ?? 50),
    });

    res.json({
      ...result,
      asOfDate,
      scope: 'assigned',
      scopeNote:
        'You are seeing only the customers assigned to you in the imported customer records. Company-wide financial information is not available to the Sales role.',
    });
  }),
);

// ----------------------------------------------------------------- forecast

const adjustmentSchema = z.object({
  id: z.string(),
  type: z.enum(['delay_collection', 'defer_payment', 'one_off_expense', 'one_off_inflow', 'change_collection_date', 'min_cash_threshold']),
  label: z.string().max(200),
  days: z.number().int().min(-365).max(365).optional(),
  amount: z.number().int().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  targetId: z.string().optional(),
});

financeRouter.get(
  '/forecast',
  requireCapability('forecast.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));
    const horizon = Math.min(365, Math.max(7, Number(req.query.horizonDays ?? 90)));
    const asOf = (req.query.asOfDate as string) ?? today();

    const forecast = await computeForecast(req.companyId!, asOf, horizon, {
      financialYearStart: resolved.financialYearStart,
    });

    res.json(forecast);
  }),
);

/**
 * Records what the forecast projects today so it can be scored once the target
 * date arrives (§15 — the foundation for forecast-versus-actual backtesting).
 */
financeRouter.post(
  '/forecast/runs',
  requireCapability('forecast.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      label: z.string().min(1).max(200).optional(),
      horizonDays: z.number().int().min(7).max(365).default(90),
      asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    });

    const input = schema.parse(req.body);
    const resolved = await resolvePeriod(periodQuery(req));
    const asOf = input.asOfDate ?? today();

    const forecast = await computeForecast(req.companyId!, asOf, input.horizonDays, {
      financialYearStart: resolved.financialYearStart,
    });

    if (!forecast.openingCashAvailable) {
      throw badRequest(
        'This forecast has no opening cash position, so there would be nothing to score it against later. Import cash and bank balances first.',
      );
    }

    const { id, record } = await recordForecastRun({
      companyId: req.companyId!,
      financialYearId: resolved.financialYearId,
      label: input.label ?? `Forecast of ${asOf} over ${input.horizonDays} days`,
      userId: req.user!.id,
      forecast,
    });

    await recordAudit({
      req,
      action: 'forecast.run_recorded',
      summary: `Recorded a ${input.horizonDays}-day forecast run for scoring on ${record.targetDate}`,
      entityType: 'forecast_run',
      entityId: id,
      meta: { horizonDays: record.horizonDays, targetDate: record.targetDate },
    });

    res.status(201).json({ run: { id, ...record } });
  }),
);

/** Past forecast runs, scored against actuals wherever the data allows it. */
financeRouter.get(
  '/forecast/backtest',
  requireCapability('forecast.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));
    const { runs, accuracy } = await scoreForecastRuns({
      companyId: req.companyId!,
      financialYearStart: resolved.financialYearStart,
    });

    res.json({
      runs,
      accuracy,
      method:
        'Each recorded run is compared with the cash and bank position imported for its target date. Runs whose target date has not arrived, or whose period has not been imported, are listed but not scored.',
      generatedAt: nowIso(),
    });
  }),
);

financeRouter.post(
  '/forecast/scenario',
  requireCapability('forecast.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      horizonDays: z.number().int().min(7).max(365).default(90),
      adjustments: z.array(adjustmentSchema).max(25).default([]),
      minCashThreshold: z.number().int().nullable().optional(),
      save: z.object({ name: z.string().min(1).max(200) }).optional(),
    });

    const input = schema.parse(req.body);
    const resolved = await resolvePeriod(periodQuery(req));
    const asOf = input.asOfDate ?? today();

    const baseline = await computeForecast(req.companyId!, asOf, input.horizonDays, {
      financialYearStart: resolved.financialYearStart,
    });

    const scenario = await computeForecast(req.companyId!, asOf, input.horizonDays, {
      adjustments: input.adjustments as ScenarioAdjustment[],
      minCashThreshold: input.minCashThreshold ?? undefined,
      financialYearStart: resolved.financialYearStart,
    });

    if (input.save) {
      await db('forecast_scenarios').insert({
        id: newId(),
        company_id: req.companyId,
        name: input.save.name,
        horizon_days: input.horizonDays,
        min_cash_minor: input.minCashThreshold ?? null,
        adjustments: writeJson(input.adjustments),
        created_by: req.user!.id,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      await recordAudit({
        action: 'forecast.scenario_saved',
        summary: `Saved cash-flow scenario "${input.save.name}"`,
        companyId: req.companyId,
        req,
      });
    }

    res.json({
      baseline,
      scenario,
      impact: {
        closingBalanceChange: sub(scenario.scenarios.expected.closingBalance, baseline.scenarios.expected.closingBalance),
        lowestBalanceChange: sub(scenario.scenarios.expected.lowestBalance, baseline.scenarios.expected.lowestBalance),
        shortfallDateBefore: baseline.scenarios.expected.shortfallDate,
        shortfallDateAfter: scenario.scenarios.expected.shortfallDate,
      },
    });
  }),
);

financeRouter.get(
  '/forecast/scenarios',
  requireCapability('forecast.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const rows = await db('forecast_scenarios').where({ company_id: req.companyId }).orderBy('created_at', 'desc').limit(50);
    res.json({
      scenarios: rows.map((r: Record<string, any>) => ({
        id: r.id,
        name: r.name,
        horizonDays: r.horizon_days,
        minCashThreshold: r.min_cash_minor === null ? null : Number(r.min_cash_minor),
        adjustments: readJson(r.adjustments, []),
        createdAt: r.created_at,
      })),
    });
  }),
);

financeRouter.get(
  '/upcoming-payments',
  requireCapability('expenses.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const from = (req.query.from as string) ?? today();
    const days = Math.min(180, Math.max(7, Number(req.query.days ?? 60)));
    const items = await upcomingPayments(req.companyId!, from, days);
    res.json({
      from,
      days,
      items,
      total: items.reduce((acc, i) => add(acc, i.amount), 0 as Minor),
      note: 'Scheduled recurring expenses and outstanding bills. A recurring instalment that already exists as an outstanding bill is shown once, not twice.',
    });
  }),
);

// ----------------------------------------------------------------- drilldown

financeRouter.get(
  '/drilldown/category/:categoryKey',
  requireCapability('statements.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));
    const asOfDate = (req.query.asOfDate as string) ?? resolved.period.to;
    const isBalanceSheet = req.query.statement === 'BS';

    const set = await loadBalances(
      req.companyId!,
      isBalanceSheet ? { from: resolved.financialYearStart ?? resolved.period.from, to: asOfDate } : resolved.period,
      { ...balanceOpts(req), financialYearId: resolved.financialYearId },
    );

    const ledgers = set.balances
      .filter((b) => b.categoryKey === req.params.categoryKey)
      .map((b) => ({
        ledgerId: b.ledgerId,
        ledgerName: b.ledgerName,
        groupName: b.groupName,
        opening: sub(b.openingDebit, b.openingCredit),
        debit: b.periodDebit,
        credit: b.periodCredit,
        closing: b.presented,
        transactionCount: b.transactionCount,
        mappingStatus: b.mappingStatus,
      }))
      .filter((l) => l.closing !== 0 || l.transactionCount > 0)
      .sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing));

    res.json({
      categoryKey: req.params.categoryKey,
      period: isBalanceSheet ? { from: resolved.financialYearStart ?? resolved.period.from, to: asOfDate } : resolved.period,
      ledgers,
      total: ledgers.reduce((acc, l) => add(acc, l.closing), 0 as Minor),
    });
  }),
);

financeRouter.get(
  '/drilldown/ledger/:ledgerId',
  requireCapability('statements.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod(periodQuery(req));
    const ledger = await db('ledgers').where({ id: req.params.ledgerId, company_id: req.companyId }).first();
    if (!ledger) throw notFound('That ledger could not be found for this company.');

    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize ?? 50)));

    const base = db('voucher_lines')
      .join('vouchers', 'voucher_lines.voucher_id', 'vouchers.id')
      .where('voucher_lines.company_id', req.companyId)
      .andWhere('voucher_lines.ledger_id', req.params.ledgerId)
      .andWhere('vouchers.voucher_date', '>=', resolved.period.from)
      .andWhere('vouchers.voucher_date', '<=', resolved.period.to);

    const countRow = await base.clone().count({ c: 'voucher_lines.id' }).first();

    const rows = await base
      .clone()
      .orderBy('vouchers.voucher_date', 'desc')
      .orderBy('vouchers.voucher_number', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select(
        'voucher_lines.id',
        'voucher_lines.debit_minor',
        'voucher_lines.credit_minor',
        'voucher_lines.cost_centre',
        'voucher_lines.narration as line_narration',
        'vouchers.id as voucher_id',
        'vouchers.voucher_date',
        'vouchers.voucher_type',
        'vouchers.voucher_number',
        'vouchers.narration',
        'vouchers.reference',
        'vouchers.source_batch_id',
      );

    const totals = await base.clone().sum({ debit: 'voucher_lines.debit_minor' }).sum({ credit: 'voucher_lines.credit_minor' }).first();

    const mapping = await db('account_mappings').where({ company_id: req.companyId, ledger_id: ledger.id }).first();

    res.json({
      ledger: {
        id: ledger.id,
        name: ledger.name,
        groupName: ledger.group_name,
        openingBalance: ledger.opening_balance_minor === null ? null : Number(ledger.opening_balance_minor),
        openingSide: ledger.opening_side,
        categoryKey: mapping?.category_key ?? null,
        mappingStatus: mapping?.status ?? 'unmapped',
      },
      period: resolved.period,
      transactions: rows.map((r: Record<string, any>) => ({
        id: r.id,
        voucherId: r.voucher_id,
        date: r.voucher_date,
        voucherType: r.voucher_type,
        voucherNumber: r.voucher_number,
        narration: r.line_narration ?? r.narration,
        reference: r.reference,
        costCentre: r.cost_centre,
        debit: Number(r.debit_minor),
        credit: Number(r.credit_minor),
        sourceBatchId: r.source_batch_id,
      })),
      totals: {
        debit: Math.round(Number(totals?.debit ?? 0)),
        credit: Math.round(Number(totals?.credit ?? 0)),
      },
      pagination: { page, pageSize, total: Number(countRow?.c ?? 0) },
    });
  }),
);

financeRouter.get(
  '/drilldown/voucher/:voucherId',
  requireCapability('statements.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const voucher = await db('vouchers').where({ id: req.params.voucherId, company_id: req.companyId }).first();
    if (!voucher) throw notFound('That voucher could not be found for this company.');

    const lines = await db('voucher_lines')
      .join('ledgers', 'voucher_lines.ledger_id', 'ledgers.id')
      .where('voucher_lines.voucher_id', voucher.id)
      .orderBy('voucher_lines.line_no')
      .select('voucher_lines.*', 'ledgers.name as ledger_name', 'ledgers.group_name');

    const batch = voucher.source_batch_id ? await db('import_batches').where({ id: voucher.source_batch_id }).first() : null;

    const totalDebit = lines.reduce((acc: number, l: Record<string, any>) => acc + Number(l.debit_minor), 0);
    const totalCredit = lines.reduce((acc: number, l: Record<string, any>) => acc + Number(l.credit_minor), 0);

    res.json({
      voucher: {
        id: voucher.id,
        date: voucher.voucher_date,
        voucherType: voucher.voucher_type,
        voucherNumber: voucher.voucher_number,
        narration: voucher.narration,
        reference: voucher.reference,
      },
      lines: lines.map((l: Record<string, any>) => ({
        ledgerId: l.ledger_id,
        ledgerName: l.ledger_name,
        groupName: l.group_name,
        debit: Number(l.debit_minor),
        credit: Number(l.credit_minor),
        costCentre: l.cost_centre,
        narration: l.narration,
      })),
      totals: { debit: totalDebit, credit: totalCredit, imbalance: totalDebit - totalCredit },
      source: batch ? { batchId: batch.id, fileName: batch.file_name, importedAt: batch.completed_at } : null,
    });
  }),
);

// ----------------------------------------------------------------- snapshots

financeRouter.post(
  '/snapshots',
  requireCapability('reports.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      label: z.string().min(1).max(200),
      reportType: z.enum(['profit_and_loss', 'balance_sheet', 'equity', 'ratios']),
      asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    });
    const input = schema.parse(req.body);
    const resolved = await resolvePeriod(periodQuery(req));

    let payload: unknown;
    if (input.reportType === 'balance_sheet') {
      payload = await computeBalanceSheet(req.companyId!, input.asOfDate, {
        financialYearId: resolved.financialYearId,
        financialYearStart: resolved.financialYearStart,
      });
    } else if (input.reportType === 'profit_and_loss') {
      payload = await computeProfitAndLoss(req.companyId!, resolved.period, { financialYearId: resolved.financialYearId });
    } else if (input.reportType === 'equity') {
      const company = await db('companies').where({ id: req.companyId }).first();
      payload = await computeEquityStatement(req.companyId!, resolved.period, company.entity_type, {
        financialYearId: resolved.financialYearId,
      });
    } else {
      payload = await computeRatios(req.companyId!, resolved.period, {
        financialYearId: resolved.financialYearId,
        financialYearStart: resolved.financialYearStart,
      });
    }

    const id = newId();
    await db('financial_snapshots').insert({
      id,
      company_id: req.companyId,
      financial_year_id: resolved.financialYearId,
      label: input.label,
      as_of_date: input.asOfDate,
      report_type: input.reportType,
      payload: writeJson(payload),
      created_by: req.user!.id,
      created_at: nowIso(),
    });

    res.status(201).json({ snapshot: { id, label: input.label, reportType: input.reportType, asOfDate: input.asOfDate } });
  }),
);

financeRouter.get(
  '/snapshots',
  requireCapability('reports.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const rows = await db('financial_snapshots').where({ company_id: req.companyId }).orderBy('created_at', 'desc').limit(100);
    res.json({
      snapshots: rows.map((r: Record<string, any>) => ({
        id: r.id,
        label: r.label,
        reportType: r.report_type,
        asOfDate: r.as_of_date,
        createdAt: r.created_at,
      })),
    });
  }),
);

financeRouter.get(
  '/snapshots/:snapshotId',
  requireCapability('reports.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const row = await db('financial_snapshots').where({ id: req.params.snapshotId, company_id: req.companyId }).first();
    if (!row) throw notFound('That snapshot could not be found.');
    res.json({
      snapshot: {
        id: row.id,
        label: row.label,
        reportType: row.report_type,
        asOfDate: row.as_of_date,
        createdAt: row.created_at,
        payload: readJson(row.payload, null),
      },
    });
  }),
);

// -------------------------------------------------------------------- utils

async function monthlyTrend(
  companyId: string,
  buckets: { key: string; label: string; from: string; to: string }[],
  opts: { confirmedOnly?: boolean; costCentre?: string | null },
) {
  const out: { label: string; from: string; to: string; revenue: Minor; expenses: Minor; profit: Minor; available: boolean }[] = [];

  for (const b of buckets) {
    const set = await loadBalances(companyId, { from: b.from, to: b.to }, opts);
    const f = plFigures(set.balances);
    const available = hasSectionData(set.balances, 'PL', [...SECTION_ROLES.revenue, ...SECTION_ROLES.operatingExpenses, ...SECTION_ROLES.cogs]);
    out.push({ label: b.label, from: b.from, to: b.to, revenue: f.revenue, expenses: f.totalExpenses, profit: f.netProfit, available });
  }

  return out;
}

async function budgetUtilisation(companyId: string, from: string, to: string) {
  const budgets = await db('budgets')
    .where({ company_id: companyId })
    .andWhere('period_start', '<=', to)
    .andWhere('period_end', '>=', from);

  if (!budgets.length) return { available: false, budgeted: 0 as Minor, actual: 0 as Minor, utilisationPercent: 0 };

  let budgeted: Minor = 0;
  let actual: Minor = 0;

  for (const b of budgets) {
    budgeted = add(budgeted, Number(b.amount_minor));
    const spent = await db('expenses')
      .where({ company_id: companyId })
      .andWhereRaw("LOWER(COALESCE(category, '')) = LOWER(?)", [b.category])
      .andWhere('expense_date', '>=', b.period_start)
      .andWhere('expense_date', '<=', b.period_end)
      .sum({ total: 'amount_minor' })
      .first();
    actual = add(actual, Math.round(Number(spent?.total ?? 0)));
  }

  return {
    available: true,
    budgeted,
    actual,
    utilisationPercent: budgeted === 0 ? 0 : (actual / budgeted) * 100,
  };
}

async function budgetVsActualSeries(companyId: string, from: string, to: string) {
  const budgets = await db('budgets')
    .where({ company_id: companyId })
    .andWhere('period_start', '<=', to)
    .andWhere('period_end', '>=', from);

  const byCategory = new Map<string, { budgeted: Minor; actual: Minor }>();

  for (const b of budgets) {
    const entry = byCategory.get(b.category) ?? { budgeted: 0, actual: 0 };
    entry.budgeted = add(entry.budgeted, Number(b.amount_minor));
    const spent = await db('expenses')
      .where({ company_id: companyId })
      .andWhereRaw("LOWER(COALESCE(category, '')) = LOWER(?)", [b.category])
      .andWhere('expense_date', '>=', b.period_start)
      .andWhere('expense_date', '<=', b.period_end)
      .sum({ total: 'amount_minor' })
      .first();
    entry.actual = add(entry.actual, Math.round(Number(spent?.total ?? 0)));
    byCategory.set(b.category, entry);
  }

  return [...byCategory.entries()]
    .map(([category, v]) => ({ category, ...v, variance: sub(v.budgeted, v.actual) }))
    .sort((a, b) => b.budgeted - a.budgeted)
    .slice(0, 10);
}

function fmtMinor(m: Minor): string {
  return `₹${(m / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function serialiseAlert(a: Record<string, any>) {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    title: a.title,
    message: a.message,
    amount: a.amount_minor === null || a.amount_minor === undefined ? null : Number(a.amount_minor),
    link: a.link,
    isRead: Boolean(a.is_read),
    createdAt: a.created_at,
    resolvedAt: a.resolved_at ?? null,
    meta: readJson(a.meta, null),
  };
}

export { badRequest };
