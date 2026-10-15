import { db } from '../../db/index.js';
import { newId, nowIso, today } from '../../lib/ids.js';
import { readJson, writeJson } from '../../lib/json.js';
import { add, type Minor } from '../../lib/money.js';
import { loadBalances, sumSections } from '../finance/engine.js';
import { outstandingTotals } from '../finance/ageing.js';
import { computeForecast } from '../finance/forecast.js';

/**
 * Alert generation.
 *
 * Alerts are computed on demand — when an import completes, and when the user
 * opens the notification centre — against the current data. There is no background
 * scheduler in this version, and the UI says so plainly rather than implying that
 * alerts are being delivered somewhere. Email and scheduled PDF delivery report
 * their configuration status instead of a success state.
 *
 * Each alert has a stable dedupe key, so recomputing does not bury the user under
 * repeats of the same warning, and read state survives a refresh.
 */

export interface AlertThresholds {
  minCashMinor: number | null;
  overdueReceivableMinor: number;
  overdueReceivableDays: number;
  overduePayableDays: number;
  budgetOverrunPercent: number;
  expenseSpikePercent: number;
  staleDataDays: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  minCashMinor: null,
  overdueReceivableMinor: 10_000_00, // ₹10,000
  overdueReceivableDays: 30,
  overduePayableDays: 0,
  budgetOverrunPercent: 100,
  expenseSpikePercent: 50,
  staleDataDays: 30,
};

export async function getThresholds(companyId: string): Promise<AlertThresholds> {
  const row = await db('app_settings').where({ company_id: companyId, key: 'alert_thresholds' }).first();
  if (!row) return DEFAULT_THRESHOLDS;
  return { ...DEFAULT_THRESHOLDS, ...readJson<Partial<AlertThresholds>>(row.value, {}) };
}

export async function setThresholds(companyId: string, thresholds: Partial<AlertThresholds>, userId: string): Promise<AlertThresholds> {
  const merged = { ...(await getThresholds(companyId)), ...thresholds };
  const existing = await db('app_settings').where({ company_id: companyId, key: 'alert_thresholds' }).first();
  const now = nowIso();

  if (existing) {
    await db('app_settings').where({ id: existing.id }).update({ value: writeJson(merged), updated_by: userId, updated_at: now });
  } else {
    await db('app_settings').insert({
      id: newId(),
      company_id: companyId,
      key: 'alert_thresholds',
      value: writeJson(merged),
      updated_by: userId,
      created_at: now,
      updated_at: now,
    });
  }
  return merged;
}

interface Candidate {
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  amount?: Minor | null;
  link?: string;
  dedupeKey: string;
  meta?: Record<string, unknown>;
}

/** Recomputes alerts for a company and reconciles them with what is stored. */
export async function refreshAlerts(companyId: string): Promise<{ created: number; resolved: number; total: number }> {
  const thresholds = await getThresholds(companyId);
  const asOf = today();
  const candidates: Candidate[] = [];

  const company = await db('companies').where({ id: companyId }).first();
  if (!company) return { created: 0, resolved: 0, total: 0 };

  const activeFy = await db('financial_years').where({ company_id: companyId }).orderBy('start_date', 'desc').first();
  const fyStart = activeFy?.start_date ?? `${asOf.slice(0, 4)}-04-01`;

  // ---------------------------------------------------------------- mapping
  const unmapped = await db('ledgers')
    .where('ledgers.company_id', companyId)
    .leftJoin('account_mappings', 'account_mappings.ledger_id', 'ledgers.id')
    .where(function () {
      this.whereNull('account_mappings.category_key').orWhere('account_mappings.status', 'suggested');
    })
    .count({ c: '*' })
    .first();

  const unmappedCount = Number(unmapped?.c ?? 0);
  if (unmappedCount > 0) {
    candidates.push({
      type: 'unmapped_ledgers',
      severity: unmappedCount > 10 ? 'warning' : 'info',
      title: unmappedCount === 1 ? '1 ledger needs a confirmed category' : `${unmappedCount} ledgers need a confirmed category`,
      message:
        'Balances on ledgers without a confirmed financial category are either excluded from your statements or included on an unconfirmed basis. Reviewing them is the fastest way to make the reports trustworthy.',
      dedupeKey: 'unmapped_ledgers',
      link: '/account-mapping',
      meta: { count: unmappedCount },
    });
  }

  // ------------------------------------------------------------------- cash
  const set = await loadBalances(companyId, { from: fyStart, to: asOf });
  const cash = sumSections(set.balances, 'BS', ['cash_and_bank']);
  const hasCashLedger = set.balances.some((b) => b.section === 'cash_and_bank');

  if (hasCashLedger && thresholds.minCashMinor !== null && cash < thresholds.minCashMinor) {
    candidates.push({
      type: 'low_cash',
      severity: 'critical',
      title: 'Cash balance is below your minimum',
      message: `Cash and bank stands at ${fmt(cash)}, under the minimum of ${fmt(thresholds.minCashMinor)} you configured.`,
      amount: cash,
      dedupeKey: 'low_cash',
      link: '/cash-and-bank',
    });
  }

  // ------------------------------------------------------------ outstanding
  const { receivables, payables } = await outstandingTotals(companyId, asOf);

  if (receivables.overdueTotal >= thresholds.overdueReceivableMinor && receivables.overdueCount > 0) {
    candidates.push({
      type: 'overdue_receivables',
      severity: receivables.overdueTotal > thresholds.overdueReceivableMinor * 5 ? 'critical' : 'warning',
      title: `${receivables.overdueCount} overdue invoice${receivables.overdueCount === 1 ? '' : 's'}`,
      message: `${fmt(receivables.overdueTotal)} is past its due date across ${receivables.overdueCount} customer invoice${receivables.overdueCount === 1 ? '' : 's'}.`,
      amount: receivables.overdueTotal,
      dedupeKey: 'overdue_receivables',
      link: '/receivables',
      meta: { count: receivables.overdueCount },
    });
  }

  if (payables.overdueCount > 0) {
    candidates.push({
      type: 'overdue_payables',
      severity: 'warning',
      title: `${payables.overdueCount} overdue supplier bill${payables.overdueCount === 1 ? '' : 's'}`,
      message: `${fmt(payables.overdueTotal)} is past its due date across ${payables.overdueCount} bill${payables.overdueCount === 1 ? '' : 's'}.`,
      amount: payables.overdueTotal,
      dedupeKey: 'overdue_payables',
      link: '/payables',
      meta: { count: payables.overdueCount },
    });
  }

  if (receivables.missingDueDateCount > 0) {
    candidates.push({
      type: 'missing_due_dates',
      severity: 'info',
      title:
        receivables.missingDueDateCount === 1
          ? '1 invoice has no due date'
          : `${receivables.missingDueDateCount} invoices have no due date`,
      message: `${fmt(receivables.missingDueDateTotal)} of receivables cannot be aged or forecast because the imported data carries no due date. Due dates are never inferred.`,
      amount: receivables.missingDueDateTotal,
      dedupeKey: 'missing_due_dates',
      link: '/receivables',
    });
  }

  // --------------------------------------------------------------- forecast
  if (hasCashLedger) {
    try {
      const forecast = await computeForecast(companyId, asOf, 90, { financialYearStart: fyStart });
      const expected = forecast.scenarios.expected;
      if (expected.shortfallDate) {
        candidates.push({
          type: 'projected_shortfall',
          severity: 'critical',
          title: 'Projected cash shortfall',
          message: `On the expected case, the projected balance falls below ${forecast.minCashThreshold !== null ? 'your minimum' : 'zero'} on ${expected.shortfallDate}, reaching ${fmt(expected.lowestBalance)}. This is a rule-based projection from imported records, not a prediction.`,
          amount: expected.lowestBalance,
          dedupeKey: `projected_shortfall:${expected.shortfallDate}`,
          link: '/cash-flow-forecast',
        });
      }
    } catch {
      /* a forecast failure must not block the rest of the alerts */
    }
  }

  // ---------------------------------------------------------------- budgets
  const budgets = await db('budgets').where({ company_id: companyId }).andWhere('period_end', '>=', asOf);
  for (const b of budgets) {
    const spentRow = await db('expenses')
      .where({ company_id: companyId })
      .andWhereRaw('LOWER(COALESCE(category, \'\')) = LOWER(?)', [b.category])
      .andWhere('expense_date', '>=', b.period_start)
      .andWhere('expense_date', '<=', b.period_end)
      .sum({ total: 'amount_minor' })
      .first();

    const spent = Math.round(Number(spentRow?.total ?? 0));
    const budget = Number(b.amount_minor);
    if (budget <= 0) continue;

    const utilisation = (spent / budget) * 100;
    if (utilisation >= thresholds.budgetOverrunPercent) {
      candidates.push({
        type: 'budget_overrun',
        severity: utilisation >= thresholds.budgetOverrunPercent + 20 ? 'critical' : 'warning',
        title: `${b.category} is at ${utilisation.toFixed(0)}% of budget`,
        message: `${fmt(spent)} spent against a budget of ${fmt(budget)} for ${b.period_start} to ${b.period_end}.`,
        amount: spent - budget,
        dedupeKey: `budget_overrun:${b.id}`,
        link: '/budgets',
        meta: { category: b.category, utilisation: Math.round(utilisation) },
      });
    }
  }

  // --------------------------------------------------------- data freshness
  const lastImport = await db('import_batches')
    .where({ company_id: companyId, status: 'committed' })
    .orderBy('completed_at', 'desc')
    .first();

  if (!lastImport) {
    candidates.push({
      type: 'no_data',
      severity: 'info',
      title: 'No data has been imported yet',
      message: 'Import an Excel workbook to start producing financial reports for this company.',
      dedupeKey: 'no_data',
      link: '/import',
    });
  } else {
    const ageDays = Math.floor((Date.now() - Date.parse(lastImport.completed_at)) / 86400000);
    if (ageDays >= thresholds.staleDataDays) {
      candidates.push({
        type: 'stale_data',
        severity: 'warning',
        title: `Data is ${ageDays} days old`,
        message: `The most recent import finished on ${lastImport.completed_at.slice(0, 10)}. Figures reflect that import and nothing since.`,
        dedupeKey: 'stale_data',
        link: '/import',
        meta: { ageDays },
      });
    }
  }

  const failed = await db('import_batches')
    .where({ company_id: companyId, status: 'failed' })
    .orderBy('created_at', 'desc')
    .limit(5);

  for (const f of failed) {
    candidates.push({
      type: 'failed_import',
      severity: 'warning',
      title: `Import of "${f.file_name}" failed`,
      message: `${f.error_message ?? 'The import was rolled back.'} No data from this file was saved.`,
      dedupeKey: `failed_import:${f.id}`,
      link: '/import',
    });
  }

  // ------------------------------------------------------- reconcile stored
  // Every stored alert is loaded, resolved ones included: a condition that recurs
  // must reopen its existing row rather than collide with it on the unique key.
  const stored = await db('alerts').where({ company_id: companyId });
  const storedByKey = new Map<string, Record<string, any>>(
    stored.map((a: Record<string, any>) => [a.dedupe_key as string, a]),
  );
  const candidateKeys = new Set(candidates.map((c) => c.dedupeKey));

  let created = 0;
  const now = nowIso();

  for (const c of candidates) {
    const found = storedByKey.get(c.dedupeKey);

    if (found) {
      const wasResolved = Boolean(found.resolved_at);
      await db('alerts')
        .where({ id: found.id })
        .update({
          severity: c.severity,
          title: c.title,
          message: c.message,
          amount_minor: c.amount ?? null,
          link: c.link ?? null,
          meta: c.meta ? writeJson(c.meta) : null,
          resolved_at: null,
          // A condition that comes back deserves to be seen again.
          ...(wasResolved ? { is_read: false, created_at: now } : {}),
        });
      if (wasResolved) created++;
      continue;
    }

    await db('alerts').insert({
      id: newId(),
      company_id: companyId,
      type: c.type,
      severity: c.severity,
      title: c.title,
      message: c.message,
      amount_minor: c.amount ?? null,
      link: c.link ?? null,
      dedupe_key: c.dedupeKey,
      is_read: false,
      meta: c.meta ? writeJson(c.meta) : null,
      created_at: now,
    });
    created++;
  }

  // A condition that no longer holds is resolved rather than deleted.
  let resolved = 0;
  for (const a of stored) {
    if (!a.resolved_at && !candidateKeys.has(a.dedupe_key)) {
      await db('alerts').where({ id: a.id }).update({ resolved_at: now });
      resolved++;
    }
  }

  return { created, resolved, total: candidates.length };
}

function fmt(minor: Minor): string {
  return `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export { add };
