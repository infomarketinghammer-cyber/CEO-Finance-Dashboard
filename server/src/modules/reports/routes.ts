import { Router } from 'express';
import { db } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany } from '../../middleware/auth.js';
import { badRequest } from '../../lib/errors.js';
import { nowIso, today } from '../../lib/ids.js';
import { formatDisplayDate } from '../../lib/dates.js';
import type { Minor } from '../../lib/money.js';
import { recordAudit } from '../audit/service.js';
import { resolvePeriod } from '../finance/periods.js';
import { computeProfitAndLoss, computeBalanceSheet, computeEquityStatement } from '../finance/statements.js';
import { computeRatios } from '../finance/ratios.js';
import { listOutstanding } from '../finance/ageing.js';
import { computeForecast } from '../finance/forecast.js';
import { loadBalances, sumSections } from '../finance/engine.js';
import { ENTITY_LABELS } from '../companies/routes.js';
import { buildPdf, buildExcel, excelMoney, pdfMoney, type ReportMeta, type ReportSection } from './exporters.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

export const REPORT_TYPES = [
  { key: 'executive_summary', label: 'Executive Financial Summary', description: 'Headline position, result and outstanding balances on one page.', formats: ['pdf', 'xlsx'] },
  { key: 'profit_and_loss', label: 'Profit & Loss', description: 'Revenue through to net profit, with period comparison and variance.', formats: ['pdf', 'xlsx'] },
  { key: 'balance_sheet', label: 'Balance Sheet', description: 'Assets, liabilities and equity at a reporting date, with the accounting equation check.', formats: ['pdf', 'xlsx'] },
  { key: 'equity', label: 'Equity Statement', description: 'Movement in equity across the period, reconciled to the Balance Sheet.', formats: ['pdf', 'xlsx'] },
  { key: 'cash_and_bank', label: 'Cash and Bank', description: 'Balance and movement per cash or bank ledger.', formats: ['pdf', 'xlsx'] },
  { key: 'receivables_ageing', label: 'Receivables Ageing', description: 'Outstanding customer invoices by ageing bucket.', formats: ['pdf', 'xlsx'] },
  { key: 'payables_ageing', label: 'Payables Ageing', description: 'Outstanding supplier bills by ageing bucket.', formats: ['pdf', 'xlsx'] },
  { key: 'expense_analysis', label: 'Expense Analysis', description: 'Expenses by category and vendor across the period.', formats: ['pdf', 'xlsx'] },
  { key: 'budget_variance', label: 'Budget Variance', description: 'Budgeted against actual spend, with variance and utilisation.', formats: ['pdf', 'xlsx'] },
  { key: 'cash_flow_forecast', label: 'Cash Flow Forecast', description: 'Rule-based projection with best, expected and worst cases.', formats: ['pdf', 'xlsx'] },
  { key: 'financial_ratios', label: 'Financial Ratios', description: 'Every ratio with its formula, inputs and limitations.', formats: ['pdf', 'xlsx'] },
  { key: 'import_history', label: 'Import History', description: 'Every import with record counts, status and warnings.', formats: ['xlsx'] },
  { key: 'data_reconciliation', label: 'Data Reconciliation', description: 'Imported balances against the most recent reference report.', formats: ['xlsx'] },
  { key: 'data_quality', label: 'Data Quality and Unmapped Accounts', description: 'Ledgers without a confirmed category and the balances affected.', formats: ['pdf', 'xlsx'] },
] as const;

reportsRouter.get(
  '/',
  requireCapability('reports.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    // Which reports can actually produce content right now.
    const [ledgerCount, voucherCount, arCount, apCount, expenseCount, budgetCount, importCount, reconCount] = await Promise.all([
      db('ledgers').where({ company_id: req.companyId }).count({ c: '*' }).first(),
      db('vouchers').where({ company_id: req.companyId }).count({ c: '*' }).first(),
      db('receivables').where({ company_id: req.companyId }).count({ c: '*' }).first(),
      db('payables').where({ company_id: req.companyId }).count({ c: '*' }).first(),
      db('expenses').where({ company_id: req.companyId }).count({ c: '*' }).first(),
      db('budgets').where({ company_id: req.companyId }).count({ c: '*' }).first(),
      db('import_batches').where({ company_id: req.companyId, status: 'committed' }).count({ c: '*' }).first(),
      db('reconciliations').where({ company_id: req.companyId }).count({ c: '*' }).first(),
    ]);

    const n = (r: unknown) => Number((r as { c?: number } | undefined)?.c ?? 0);

    const requirements: Record<string, { ready: boolean; reason?: string }> = {
      executive_summary: { ready: n(ledgerCount) > 0, reason: 'Import a chart of accounts and some transactions first.' },
      profit_and_loss: { ready: n(voucherCount) > 0, reason: 'No vouchers have been imported, so there is no Profit & Loss activity.' },
      balance_sheet: { ready: n(ledgerCount) > 0, reason: 'Import a chart of accounts and opening balances first.' },
      equity: { ready: n(ledgerCount) > 0, reason: 'Import a chart of accounts first.' },
      cash_and_bank: { ready: n(ledgerCount) > 0, reason: 'Import a chart of accounts first.' },
      receivables_ageing: { ready: n(arCount) > 0, reason: 'No receivables have been imported.' },
      payables_ageing: { ready: n(apCount) > 0, reason: 'No payables have been imported.' },
      expense_analysis: { ready: n(expenseCount) > 0 || n(voucherCount) > 0, reason: 'No expense records or vouchers have been imported.' },
      budget_variance: { ready: n(budgetCount) > 0, reason: 'No budgets have been defined or imported.' },
      cash_flow_forecast: { ready: n(ledgerCount) > 0, reason: 'Import a chart of accounts first.' },
      financial_ratios: { ready: n(ledgerCount) > 0, reason: 'Import a chart of accounts first.' },
      import_history: { ready: n(importCount) > 0, reason: 'No imports have been completed yet.' },
      data_reconciliation: { ready: n(reconCount) > 0, reason: 'Reference data not provided — run a reconciliation first.' },
      data_quality: { ready: n(ledgerCount) > 0, reason: 'Import a chart of accounts first.' },
    };

    res.json({
      reports: REPORT_TYPES.map((r) => ({ ...r, ...requirements[r.key] })),
      note: 'Exports contain real imported and calculated data for the company, financial year, period and filters currently selected.',
    });
  }),
);

reportsRouter.get(
  '/:reportKey/export.:format(pdf|xlsx)',
  requireCapability('reports.export'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const reportKey = req.params.reportKey;
    const format = req.params.format as 'pdf' | 'xlsx';

    const definition = REPORT_TYPES.find((r) => r.key === reportKey);
    if (!definition) throw badRequest(`"${reportKey}" is not a report DHYEYA produces.`);
    if (!(definition.formats as readonly string[]).includes(format)) {
      throw badRequest(`${definition.label} is not available as a ${format.toUpperCase()}. Available: ${definition.formats.join(', ')}.`);
    }

    const company = await db('companies').where({ id: req.companyId }).first();
    const resolved = await resolvePeriod({
      companyId: req.companyId!,
      financialYearId: (req.query.financialYearId as string) || null,
      periodType: (req.query.periodType as string) || 'financial_year',
      from: req.query.from as string,
      to: req.query.to as string,
    });

    const scale = company.currency_scale as number;
    const money = format === 'pdf' ? (m: Minor | null) => pdfMoney(m, scale) : (m: Minor | null) => excelMoney(m, scale);

    const filters: { label: string; value: string }[] = [];
    if (req.query.costCentre) filters.push({ label: 'Cost centre', value: String(req.query.costCentre) });
    if (req.query.confirmedOnly === 'true') filters.push({ label: 'Mappings', value: 'Confirmed only' });

    const meta: ReportMeta = {
      companyName: company.name,
      companyEntity: ENTITY_LABELS[company.entity_type] ?? company.entity_type,
      gstin: company.gstin,
      reportTitle: definition.label,
      periodLabel: resolved.period.label ?? `${resolved.period.from} to ${resolved.period.to}`,
      currency: company.currency,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      generatedBy: `${req.user!.name} (${req.user!.email})`,
      dataSource: 'Excel Import',
      filters,
      warnings: [],
    };

    const balanceOpts = {
      confirmedOnly: req.query.confirmedOnly === 'true',
      costCentre: (req.query.costCentre as string) || null,
      financialYearId: resolved.financialYearId,
    };

    let sections: ReportSection[] = [];

    switch (reportKey) {
      case 'profit_and_loss': {
        const pl = await computeProfitAndLoss(req.companyId!, resolved.period, {
          ...balanceOpts,
          comparison: { period: resolved.previousPeriod, label: 'Previous period' },
        });
        meta.warnings = pl.quality.warnings;
        sections = [
          {
            title: 'Profit & Loss',
            columns: [
              { key: 'line', label: 'Line', width: 3 },
              { key: 'current', label: 'This period', numeric: true, width: 1.3 },
              { key: 'previous', label: 'Previous period', numeric: true, width: 1.3 },
              { key: 'variance', label: 'Variance', numeric: true, width: 1.2 },
              { key: 'variancePct', label: 'Variance %', numeric: true, width: 1 },
              { key: 'formula', label: 'How it is calculated', width: 3 },
            ],
            rows: pl.lines.map((l) => ({
              line: l.label,
              current: l.available ? money(l.value) : format === 'pdf' ? 'Data unavailable' : null,
              previous: l.previousValue !== undefined ? money(l.previousValue ?? null) : null,
              variance: l.variance !== null && l.variance !== undefined ? money(l.variance) : null,
              variancePct: l.variancePercent !== null && l.variancePercent !== undefined ? Number(l.variancePercent.toFixed(1)) : null,
              formula: l.formula,
            })),
            totalRowIndexes: pl.lines.map((l, i) => (l.kind !== 'detail' ? i : -1)).filter((i) => i >= 0),
            note: pl.methodology.join(' '),
          },
        ];
        break;
      }

      case 'balance_sheet': {
        const asOfDate = (req.query.asOfDate as string) ?? resolved.period.to;
        const bs = await computeBalanceSheet(req.companyId!, asOfDate, { ...balanceOpts, financialYearStart: resolved.financialYearStart });
        meta.asOfLabel = formatDisplayDate(asOfDate);
        meta.warnings = [
          ...bs.quality.warnings,
          ...(bs.balances ? [] : [`The statement does not balance. Difference: ${pdfMoney(bs.equationDifference, scale)}. See the diagnostics section.`]),
        ];

        const toRows = (groups: typeof bs.assets) =>
          groups.flatMap((g) => [
            ...g.lines.map((l) => ({ line: `  ${l.label}`, amount: money(l.total), ledgers: l.ledgerCount })),
            { line: g.label, amount: money(g.total), ledgers: null as number | null },
          ]);

        const assetRows = toRows(bs.assets);
        const liabilityRows = toRows(bs.liabilities);
        const equityRows = toRows(bs.equity);

        sections = [
          {
            title: 'Assets',
            columns: [
              { key: 'line', label: 'Line', width: 3 },
              { key: 'amount', label: 'Amount', numeric: true, width: 1.4 },
              { key: 'ledgers', label: 'Ledgers', numeric: true, width: 0.7 },
            ],
            rows: [...assetRows, { line: 'TOTAL ASSETS', amount: money(bs.totalAssets), ledgers: null }],
            totalRowIndexes: [assetRows.length],
          },
          {
            title: 'Liabilities',
            columns: [
              { key: 'line', label: 'Line', width: 3 },
              { key: 'amount', label: 'Amount', numeric: true, width: 1.4 },
              { key: 'ledgers', label: 'Ledgers', numeric: true, width: 0.7 },
            ],
            rows: [...liabilityRows, { line: 'TOTAL LIABILITIES', amount: money(bs.totalLiabilities), ledgers: null }],
            totalRowIndexes: [liabilityRows.length],
          },
          {
            title: 'Equity',
            columns: [
              { key: 'line', label: 'Line', width: 3 },
              { key: 'amount', label: 'Amount', numeric: true, width: 1.4 },
              { key: 'ledgers', label: 'Ledgers', numeric: true, width: 0.7 },
            ],
            rows: [...equityRows, { line: 'TOTAL EQUITY', amount: money(bs.totalEquity), ledgers: null }],
            totalRowIndexes: [equityRows.length],
          },
          {
            title: 'Accounting equation',
            columns: [
              { key: 'check', label: 'Check', width: 3 },
              { key: 'amount', label: 'Amount', numeric: true, width: 1.4 },
            ],
            rows: [
              { check: 'Total Assets', amount: money(bs.totalAssets) },
              { check: 'Total Liabilities + Total Equity', amount: money(bs.totalLiabilities + bs.totalEquity) },
              { check: bs.balances ? 'Difference — the statement balances' : 'Difference — the statement does NOT balance', amount: money(bs.equationDifference) },
            ],
            totalRowIndexes: [2],
            note: bs.balances
              ? bs.methodology.join(' ')
              : `${bs.diagnostics.map((d) => `${d.cause}: ${d.detail} ${d.action}`).join(' ')} ${bs.methodology.join(' ')}`,
          },
        ];
        break;
      }

      case 'equity': {
        const eq = await computeEquityStatement(req.companyId!, resolved.period, company.entity_type, balanceOpts);
        meta.warnings = [
          ...eq.quality.warnings,
          ...(eq.reconciles ? [] : [`Closing equity differs from the Balance Sheet equity by ${pdfMoney(eq.unexplainedDifference, scale)}.`]),
        ];
        sections = [
          {
            title: 'Statement of Changes in Equity',
            columns: [
              { key: 'line', label: 'Line', width: 3 },
              { key: 'amount', label: 'Amount', numeric: true, width: 1.4 },
              { key: 'formula', label: 'How it is calculated', width: 3.5 },
            ],
            rows: eq.lines.map((l) => ({
              line: l.label,
              amount: l.available ? money(l.value) : format === 'pdf' ? 'Data unavailable' : null,
              formula: l.formula,
            })),
            totalRowIndexes: eq.lines.map((l, i) => (l.kind !== 'detail' ? i : -1)).filter((i) => i >= 0),
            note: eq.methodology.join(' '),
          },
        ];
        break;
      }

      case 'financial_ratios': {
        const r = await computeRatios(req.companyId!, resolved.period, { ...balanceOpts, financialYearStart: resolved.financialYearStart });
        meta.warnings = r.warnings;
        sections = [
          {
            title: 'Financial Ratios',
            columns: [
              { key: 'ratio', label: 'Ratio', width: 1.6 },
              { key: 'group', label: 'Group', width: 1 },
              { key: 'value', label: 'Value', numeric: true, width: 0.9 },
              { key: 'unit', label: 'Unit', width: 0.7 },
              { key: 'formula', label: 'Formula', width: 2.4 },
              { key: 'note', label: 'Limitation or reason unavailable', width: 3 },
            ],
            rows: r.ratios.map((x) => ({
              ratio: x.label,
              group: x.group,
              value: x.available && x.value !== null ? Number(x.value.toFixed(2)) : format === 'pdf' ? 'N/A' : null,
              unit: x.unit,
              formula: x.formula,
              note: x.available ? (x.limitation ?? '') : (x.reason ?? 'Not available'),
            })),
            note: 'No ratio is described as good or bad. Interpretation depends on industry, seasonality and business model, which this product cannot observe.',
          },
        ];
        break;
      }

      case 'receivables_ageing':
      case 'payables_ageing': {
        const table = reportKey === 'receivables_ageing' ? 'receivables' : 'payables';
        const asOf = (req.query.asOfDate as string) ?? today();
        const result = await listOutstanding({ companyId: req.companyId!, table, asOfDate: asOf, pageSize: 10000 });
        meta.asOfLabel = formatDisplayDate(asOf);
        meta.warnings = result.summary.warnings;

        sections = [
          {
            title: 'Ageing summary',
            columns: [
              { key: 'bucket', label: 'Ageing bucket', width: 2 },
              { key: 'count', label: 'Documents', numeric: true, width: 1 },
              { key: 'amount', label: 'Outstanding', numeric: true, width: 1.4 },
            ],
            rows: [
              ...result.summary.buckets.map((b) => ({ bucket: b.label, count: b.count, amount: money(b.total) })),
              { bucket: 'Total', count: result.summary.totalCount, amount: money(result.summary.total) },
            ],
            totalRowIndexes: [result.summary.buckets.length],
          },
          {
            title: 'Outstanding documents',
            columns: [
              { key: 'party', label: table === 'receivables' ? 'Customer' : 'Supplier', width: 2.2 },
              { key: 'doc', label: table === 'receivables' ? 'Invoice' : 'Bill', width: 1.2 },
              { key: 'docDate', label: 'Date', width: 1 },
              { key: 'dueDate', label: 'Due', width: 1 },
              { key: 'amount', label: 'Amount', numeric: true, width: 1.1 },
              { key: 'paid', label: 'Settled', numeric: true, width: 1.1 },
              { key: 'outstanding', label: 'Outstanding', numeric: true, width: 1.2 },
              { key: 'overdue', label: 'Days overdue', numeric: true, width: 0.9 },
              { key: 'bucket', label: 'Bucket', width: 1.4 },
            ],
            rows: result.documents.map((d) => ({
              party: d.partyName,
              doc: d.documentNumber ?? '—',
              docDate: d.documentDate ? formatDisplayDate(d.documentDate) : '—',
              dueDate: d.dueDate ? formatDisplayDate(d.dueDate) : 'Not supplied',
              amount: money(d.amount),
              paid: d.paid === null ? null : money(d.paid),
              outstanding: money(d.outstanding),
              overdue: d.overdueDays !== null && d.overdueDays > 0 ? d.overdueDays : null,
              bucket: d.bucketLabel,
            })),
            note: 'Documents with no due date are listed with "Not supplied" and excluded from the overdue buckets. A due date is never inferred.',
          },
        ];
        break;
      }

      case 'cash_and_bank': {
        const asOf = (req.query.asOfDate as string) ?? resolved.period.to;
        const set = await loadBalances(req.companyId!, { from: resolved.financialYearStart ?? resolved.period.from, to: asOf }, balanceOpts);
        const accounts = set.balances.filter((b) => b.section === 'cash_and_bank');
        meta.asOfLabel = formatDisplayDate(asOf);
        meta.warnings = set.quality.warnings;

        sections = [
          {
            title: 'Cash and Bank',
            columns: [
              { key: 'ledger', label: 'Ledger', width: 2.4 },
              { key: 'group', label: 'Group', width: 1.4 },
              { key: 'opening', label: 'Opening', numeric: true, width: 1.2 },
              { key: 'received', label: 'Received', numeric: true, width: 1.2 },
              { key: 'paid', label: 'Paid', numeric: true, width: 1.2 },
              { key: 'closing', label: 'Closing', numeric: true, width: 1.2 },
            ],
            rows: [
              ...accounts.map((a) => ({
                ledger: a.ledgerName,
                group: a.groupName ?? '—',
                opening: money(a.openingDebit - a.openingCredit),
                received: money(a.periodDebit),
                paid: money(a.periodCredit),
                closing: money(a.presented),
              })),
              {
                ledger: 'Total',
                group: '',
                opening: money(accounts.reduce((s, a) => s + a.openingDebit - a.openingCredit, 0)),
                received: money(accounts.reduce((s, a) => s + a.periodDebit, 0)),
                paid: money(accounts.reduce((s, a) => s + a.periodCredit, 0)),
                closing: money(sumSections(set.balances, 'BS', ['cash_and_bank'])),
              },
            ],
            totalRowIndexes: [accounts.length],
          },
        ];
        break;
      }

      case 'expense_analysis': {
        const expenses = await db('expenses')
          .where({ company_id: req.companyId })
          .andWhere('expense_date', '>=', resolved.period.from)
          .andWhere('expense_date', '<=', resolved.period.to)
          .orderBy('expense_date', 'desc');

        const byCategory = new Map<string, { total: number; count: number }>();
        const byVendor = new Map<string, { total: number; count: number }>();
        for (const e of expenses) {
          const cat = e.category ?? 'Uncategorised';
          const c = byCategory.get(cat) ?? { total: 0, count: 0 };
          c.total += Number(e.amount_minor);
          c.count++;
          byCategory.set(cat, c);

          if (e.vendor) {
            const v = byVendor.get(e.vendor) ?? { total: 0, count: 0 };
            v.total += Number(e.amount_minor);
            v.count++;
            byVendor.set(e.vendor, v);
          }
        }

        sections = [
          {
            title: 'By category',
            columns: [
              { key: 'category', label: 'Category', width: 2.5 },
              { key: 'count', label: 'Entries', numeric: true, width: 1 },
              { key: 'total', label: 'Total', numeric: true, width: 1.4 },
            ],
            rows: [...byCategory.entries()]
              .sort((a, b) => b[1].total - a[1].total)
              .map(([category, v]) => ({ category, count: v.count, total: money(v.total) })),
          },
          {
            title: 'By vendor',
            columns: [
              { key: 'vendor', label: 'Vendor', width: 2.5 },
              { key: 'count', label: 'Entries', numeric: true, width: 1 },
              { key: 'total', label: 'Total', numeric: true, width: 1.4 },
            ],
            rows: [...byVendor.entries()]
              .sort((a, b) => b[1].total - a[1].total)
              .slice(0, 100)
              .map(([vendor, v]) => ({ vendor, count: v.count, total: money(v.total) })),
            note: byVendor.size === 0 ? 'No vendor is recorded against the imported expenses.' : undefined,
          },
          {
            title: 'Expense detail',
            columns: [
              { key: 'date', label: 'Date', width: 1 },
              { key: 'category', label: 'Category', width: 1.6 },
              { key: 'vendor', label: 'Vendor', width: 1.6 },
              { key: 'type', label: 'Type', width: 1.1 },
              { key: 'costCentre', label: 'Cost centre', width: 1.2 },
              { key: 'reference', label: 'Reference', width: 1.2 },
              { key: 'amount', label: 'Amount', numeric: true, width: 1.2 },
            ],
            rows: expenses.map((e: Record<string, any>) => ({
              date: formatDisplayDate(e.expense_date),
              category: e.category ?? '—',
              vendor: e.vendor ?? '—',
              type: e.expense_type,
              costCentre: e.cost_centre ?? '—',
              reference: e.reference ?? '—',
              amount: money(Number(e.amount_minor)),
            })),
          },
        ];
        break;
      }

      case 'budget_variance': {
        const budgets = await db('budgets')
          .where({ company_id: req.companyId })
          .andWhere('period_start', '<=', resolved.period.to)
          .andWhere('period_end', '>=', resolved.period.from)
          .orderBy('category');

        const rows = [];
        for (const b of budgets) {
          const spent = await db('expenses')
            .where({ company_id: req.companyId })
            .andWhereRaw("LOWER(COALESCE(category,'')) = LOWER(?)", [b.category])
            .andWhere('expense_date', '>=', b.period_start)
            .andWhere('expense_date', '<=', b.period_end)
            .sum({ total: 'amount_minor' })
            .first();
          const actual = Math.round(Number(spent?.total ?? 0));
          const budgeted = Number(b.amount_minor);
          rows.push({
            category: b.category,
            period: `${formatDisplayDate(b.period_start)} – ${formatDisplayDate(b.period_end)}`,
            costCentre: b.cost_centre ?? '—',
            budgeted: money(budgeted),
            actual: money(actual),
            remaining: money(budgeted - actual),
            utilisation: budgeted ? Number(((actual / budgeted) * 100).toFixed(1)) : null,
          });
        }

        sections = [
          {
            title: 'Budget variance',
            columns: [
              { key: 'category', label: 'Category', width: 2 },
              { key: 'period', label: 'Period', width: 1.8 },
              { key: 'costCentre', label: 'Cost centre', width: 1.2 },
              { key: 'budgeted', label: 'Budgeted', numeric: true, width: 1.2 },
              { key: 'actual', label: 'Actual', numeric: true, width: 1.2 },
              { key: 'remaining', label: 'Remaining', numeric: true, width: 1.2 },
              { key: 'utilisation', label: 'Used %', numeric: true, width: 0.9 },
            ],
            rows,
            note: rows.length ? undefined : 'No budgets cover the selected period.',
          },
        ];
        break;
      }

      case 'cash_flow_forecast': {
        const asOf = (req.query.asOfDate as string) ?? today();
        const horizon = Math.min(365, Math.max(7, Number(req.query.horizonDays ?? 90)));
        const f = await computeForecast(req.companyId!, asOf, horizon, { financialYearStart: resolved.financialYearStart });
        meta.asOfLabel = formatDisplayDate(asOf);
        meta.warnings = [
          'This is a rule-based projection built from imported records. It is not a statistical or machine-learned prediction.',
          ...(f.openingCashAvailable ? [] : ['No ledger is categorised as Cash and Bank, so the projection starts from zero.']),
        ];

        sections = [
          {
            title: 'Scenario summary',
            columns: [
              { key: 'scenario', label: 'Scenario', width: 1.4 },
              { key: 'closing', label: `Closing after ${horizon} days`, numeric: true, width: 1.5 },
              { key: 'lowest', label: 'Lowest balance', numeric: true, width: 1.3 },
              { key: 'lowestDate', label: 'On', width: 1.1 },
              { key: 'inflow', label: 'Total inflow', numeric: true, width: 1.3 },
              { key: 'outflow', label: 'Total outflow', numeric: true, width: 1.3 },
              { key: 'shortfall', label: 'Shortfall date', width: 1.1 },
            ],
            rows: (['best', 'expected', 'worst'] as const).map((s) => ({
              scenario: s === 'best' ? 'Best case' : s === 'expected' ? 'Expected case' : 'Worst case',
              closing: money(f.scenarios[s].closingBalance),
              lowest: money(f.scenarios[s].lowestBalance),
              lowestDate: formatDisplayDate(f.scenarios[s].lowestBalanceDate),
              inflow: money(f.scenarios[s].totalInflow),
              outflow: money(f.scenarios[s].totalOutflow),
              shortfall: f.scenarios[s].shortfallDate ? formatDisplayDate(f.scenarios[s].shortfallDate!) : 'None',
            })),
            note: f.assumptions.join(' '),
          },
          {
            title: 'Expected case drivers',
            columns: [
              { key: 'date', label: 'Date', width: 1 },
              { key: 'kind', label: 'Type', width: 1.2 },
              { key: 'label', label: 'Item', width: 2.6 },
              { key: 'direction', label: 'Direction', width: 0.9 },
              { key: 'amount', label: 'Face value', numeric: true, width: 1.2 },
              { key: 'applied', label: 'Applied', numeric: true, width: 1.2 },
              { key: 'note', label: 'Basis', width: 2.4 },
            ],
            rows: f.drivers.map((d) => ({
              date: formatDisplayDate(d.date),
              kind: d.kind.replace(/_/g, ' '),
              label: d.label,
              direction: d.direction,
              amount: money(d.amount),
              applied: money(d.applied),
              note: d.note ?? '',
            })),
          },
        ];
        break;
      }

      case 'data_quality': {
        const set = await loadBalances(req.companyId!, resolved.period, { financialYearId: resolved.financialYearId });
        const problem = set.balances.filter((b) => b.mappingStatus !== 'confirmed');
        meta.warnings = set.quality.warnings;

        sections = [
          {
            title: 'Ledgers needing attention',
            columns: [
              { key: 'ledger', label: 'Ledger', width: 2.4 },
              { key: 'group', label: 'Group', width: 1.6 },
              { key: 'status', label: 'Mapping status', width: 1.2 },
              { key: 'category', label: 'Suggested category', width: 1.6 },
              { key: 'balance', label: 'Balance affected', numeric: true, width: 1.3 },
            ],
            rows: problem.map((b) => ({
              ledger: b.ledgerName,
              group: b.groupName ?? '—',
              status: b.mappingStatus === 'unmapped' ? 'No category' : 'Unconfirmed suggestion',
              category: b.categoryLabel ?? '—',
              balance: money(b.closingNet),
            })),
            note: 'A ledger with no category is excluded from the statements entirely. An unconfirmed suggestion is included, but should be approved before the figures are relied on.',
          },
        ];
        break;
      }

      case 'import_history': {
        const batches = await db('import_batches')
          .where({ company_id: req.companyId })
          .leftJoin('users', 'import_batches.created_by', 'users.id')
          .orderBy('import_batches.created_at', 'desc')
          .select('import_batches.*', 'users.email as user_email');

        sections = [
          {
            title: 'Import history',
            columns: [
              { key: 'createdAt', label: 'Started', width: 1.4 },
              { key: 'completedAt', label: 'Completed', width: 1.4 },
              { key: 'fileName', label: 'File', width: 2.2 },
              { key: 'category', label: 'Category', width: 1.6 },
              { key: 'status', label: 'Status', width: 1 },
              { key: 'user', label: 'User', width: 1.6 },
              { key: 'inserted', label: 'Added', numeric: true, width: 0.8 },
              { key: 'updated', label: 'Updated', numeric: true, width: 0.8 },
              { key: 'skipped', label: 'Skipped', numeric: true, width: 0.8 },
              { key: 'rejected', label: 'Rejected', numeric: true, width: 0.8 },
            ],
            rows: batches.map((b: Record<string, any>) => {
              const t = b.totals ? (typeof b.totals === 'string' ? JSON.parse(b.totals) : b.totals) : {};
              return {
                createdAt: b.created_at?.slice(0, 19).replace('T', ' ') ?? '—',
                completedAt: b.completed_at?.slice(0, 19).replace('T', ' ') ?? '—',
                fileName: b.file_name,
                category: b.category,
                status: b.status,
                user: b.user_email ?? '—',
                inserted: t.inserted ?? null,
                updated: t.updated ?? null,
                skipped: t.skipped ?? null,
                rejected: t.invalidRows ?? null,
              };
            }),
          },
        ];
        break;
      }

      case 'data_reconciliation': {
        const recon = await db('reconciliations').where({ company_id: req.companyId }).orderBy('created_at', 'desc').first();
        if (!recon) throw badRequest('Reference data not provided — run a reconciliation before exporting this report.');

        const lines = await db('reconciliation_lines').where({ reconciliation_id: recon.id });
        meta.asOfLabel = formatDisplayDate(recon.as_of_date);

        sections = [
          {
            title: 'Reconciliation',
            columns: [
              { key: 'ledger', label: 'Ledger', width: 2.6 },
              { key: 'imported', label: 'Imported', numeric: true, width: 1.3 },
              { key: 'reference', label: 'Reference', numeric: true, width: 1.3 },
              { key: 'difference', label: 'Difference', numeric: true, width: 1.3 },
              { key: 'status', label: 'Status', width: 1.4 },
            ],
            rows: lines
              .sort((a: Record<string, any>, b: Record<string, any>) => Math.abs(Number(b.difference_minor ?? 0)) - Math.abs(Number(a.difference_minor ?? 0)))
              .map((l: Record<string, any>) => ({
                ledger: l.ledger_name,
                imported: l.imported_minor === null ? null : money(Number(l.imported_minor)),
                reference: l.reference_minor === null ? null : money(Number(l.reference_minor)),
                difference: l.difference_minor === null ? null : money(Number(l.difference_minor)),
                status: l.status.replace(/_/g, ' '),
              })),
            note: `Reference file: ${recon.reference_file_name}. Balances are compared on a debit-positive basis.`,
          },
        ];
        break;
      }

      case 'executive_summary':
      default: {
        const asOf = resolved.period.to;
        const [pl, bs, ar, ap] = await Promise.all([
          computeProfitAndLoss(req.companyId!, resolved.period, balanceOpts),
          computeBalanceSheet(req.companyId!, asOf, { ...balanceOpts, financialYearStart: resolved.financialYearStart }),
          listOutstanding({ companyId: req.companyId!, table: 'receivables', asOfDate: today(), pageSize: 1 }),
          listOutstanding({ companyId: req.companyId!, table: 'payables', asOfDate: today(), pageSize: 1 }),
        ]);

        meta.warnings = bs.quality.warnings;

        sections = [
          {
            title: 'Headline figures',
            columns: [
              { key: 'measure', label: 'Measure', width: 2.4 },
              { key: 'value', label: 'Value', numeric: true, width: 1.4 },
              { key: 'basis', label: 'Basis', width: 3 },
            ],
            rows: [
              { measure: 'Revenue', value: pl.revenue !== null ? money(pl.revenue) : format === 'pdf' ? 'Data unavailable' : null, basis: 'Profit & Loss for the period' },
              { measure: 'Gross Profit', value: pl.grossProfit !== null ? money(pl.grossProfit) : format === 'pdf' ? 'Data unavailable' : null, basis: 'Revenue − (COGS + Direct Expenses)' },
              { measure: 'Net Profit', value: pl.netProfit !== null ? money(pl.netProfit) : format === 'pdf' ? 'Data unavailable' : null, basis: 'Profit Before Tax − Tax Expense' },
              { measure: 'Total Assets', value: money(bs.totalAssets), basis: `Balance Sheet as at ${formatDisplayDate(asOf)}` },
              { measure: 'Total Liabilities', value: money(bs.totalLiabilities), basis: `Balance Sheet as at ${formatDisplayDate(asOf)}` },
              { measure: 'Total Equity', value: money(bs.totalEquity), basis: 'Including the profit for the period' },
              { measure: 'Total Receivables', value: money(ar.summary.total), basis: `${ar.summary.totalCount} open invoice(s)` },
              { measure: 'Overdue Receivables', value: money(ar.summary.overdueTotal), basis: `${ar.summary.overdueCount} overdue invoice(s)` },
              { measure: 'Total Payables', value: money(ap.summary.total), basis: `${ap.summary.totalCount} open bill(s)` },
              { measure: 'Overdue Payables', value: money(ap.summary.overdueTotal), basis: `${ap.summary.overdueCount} overdue bill(s)` },
            ],
            note: bs.balances ? undefined : `Note: the Balance Sheet does not balance. Difference ${pdfMoney(bs.equationDifference, scale)}.`,
          },
        ];
        break;
      }
    }

    const buffer = format === 'pdf' ? await buildPdf(meta, sections) : await buildExcel(meta, sections);

    await recordAudit({
      action: 'report.exported',
      summary: `Exported ${definition.label} as ${format.toUpperCase()} for ${meta.periodLabel}`,
      companyId: req.companyId,
      entityType: 'report',
      entityId: reportKey,
      meta: { format, period: resolved.period, filters },
      req,
    });

    const safeCompany = company.name.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40);
    const fileName = `DHYEYA-${definition.label.replace(/[^a-zA-Z0-9]/g, '-')}-${safeCompany}-${today()}.${format}`;

    res.setHeader(
      'Content-Type',
      format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  }),
);

export { nowIso };
