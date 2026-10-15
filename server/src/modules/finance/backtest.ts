/**
 * Forecast-versus-actual backtesting (§15 of the brief, §4.3 of the PRD).
 *
 * The brief asks for "a foundation for future forecast-versus-actual
 * backtesting", and the PRD for a view "comparing past forecasts with actuals
 * and displaying forecast accuracy". A forecast can only be scored against an
 * outcome that was not knowable when it was made, so the foundation is:
 *
 *   1. A forecast run is *recorded* — what was projected, for which date, from
 *      which opening position, under which assumptions.
 *   2. Once that target date has passed and cash movement up to it has actually
 *      been imported, the run is *scored* against the real closing cash.
 *
 * Runs are stored as financial snapshots, which already exist for reproducing
 * past reports (§24), so this adds no table. A run recorded today is explicitly
 * reported as "not yet due" rather than scored against incomplete data — a
 * forecast graded against data that has not arrived would be meaningless.
 */
import { db } from '../../db/index.js';
import { readJson, writeJson } from '../../lib/json.js';
import { newId, nowIso, today } from '../../lib/ids.js';
import { loadBalances, sumSections } from './engine.js';
import type { Minor } from '../../lib/money.js';
import type { ForecastResult, Scenario } from './forecast.js';

export const FORECAST_RUN_REPORT_TYPE = 'cash_flow_forecast_run';

export interface ForecastRunRecord {
  asOfDate: string;
  horizonDays: number;
  targetDate: string;
  openingCash: Minor;
  minCashThreshold: Minor | null;
  method: ForecastResult['method'];
  dataSufficiency: number;
  projected: Record<Scenario, Minor>;
  assumptions: string[];
  adjustmentCount: number;
}

export interface ScoredRun extends ForecastRunRecord {
  id: string;
  label: string;
  createdAt: string;
  /** Null until the target date has passed. */
  actualClosingCash: Minor | null;
  status: 'not_yet_due' | 'no_data' | 'scored';
  statusDetail: string;
  /** Signed error against the expected case, in minor units. Positive = over-forecast. */
  varianceMinor: number | null;
  /** Absolute percentage error against the expected case. */
  absolutePercentError: number | null;
  /** Whether the actual landed inside the worst-to-best band. */
  withinScenarioBand: boolean | null;
}

/** Captures what a forecast projected, so it can be scored later. */
export function toRunRecord(forecast: ForecastResult): ForecastRunRecord {
  return {
    asOfDate: forecast.asOfDate,
    horizonDays: forecast.horizonDays,
    targetDate: addDays(forecast.asOfDate, forecast.horizonDays),
    openingCash: forecast.openingCash,
    minCashThreshold: forecast.minCashThreshold,
    method: forecast.method,
    dataSufficiency: forecast.dataSufficiency.score,
    projected: {
      best: forecast.scenarios.best.closingBalance,
      expected: forecast.scenarios.expected.closingBalance,
      worst: forecast.scenarios.worst.closingBalance,
    },
    assumptions: forecast.assumptions,
    adjustmentCount: forecast.appliedAdjustments.length,
  };
}

export async function recordForecastRun(args: {
  companyId: string;
  financialYearId: string | null;
  label: string;
  userId: string;
  forecast: ForecastResult;
}): Promise<{ id: string; record: ForecastRunRecord }> {
  const record = toRunRecord(args.forecast);
  const id = newId();

  await db('financial_snapshots').insert({
    id,
    company_id: args.companyId,
    financial_year_id: args.financialYearId,
    label: args.label,
    as_of_date: record.asOfDate,
    report_type: FORECAST_RUN_REPORT_TYPE,
    payload: writeJson(record),
    created_by: args.userId,
    created_at: nowIso(),
  });

  return { id, record };
}

/**
 * Scores every recorded run for a company.
 *
 * `financialYearStart` anchors the balance query so the actual cash position
 * includes opening balances, matching how the forecast's own opening cash was
 * derived — otherwise the comparison would be between different quantities.
 */
export async function scoreForecastRuns(args: {
  companyId: string;
  financialYearStart: string | null;
  asOf?: string;
}): Promise<{ runs: ScoredRun[]; accuracy: AccuracySummary }> {
  const asOf = args.asOf ?? today();

  const rows = await db('financial_snapshots')
    .where({ company_id: args.companyId, report_type: FORECAST_RUN_REPORT_TYPE })
    .orderBy('created_at', 'desc')
    .limit(100);

  const runs: ScoredRun[] = [];

  for (const row of rows) {
    const record = readJson<ForecastRunRecord | null>(row.payload, null);
    if (!record) continue;

    const base: ScoredRun = {
      ...record,
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      actualClosingCash: null,
      status: 'not_yet_due',
      statusDetail: `This forecast runs to ${record.targetDate}. It can be scored once that date has passed and the period's transactions have been imported.`,
      varianceMinor: null,
      absolutePercentError: null,
      withinScenarioBand: null,
    };

    if (record.targetDate > asOf) {
      runs.push(base);
      continue;
    }

    const actual = await actualCashAt(args.companyId, record.targetDate, args.financialYearStart ?? record.asOfDate);

    if (!actual.available) {
      runs.push({
        ...base,
        status: 'no_data',
        statusDetail:
          'The target date has passed, but no cash or bank ledger balance is available for it. Import the transactions covering that date to score this forecast.',
      });
      continue;
    }

    const variance = record.projected.expected - actual.value;
    const denominator = Math.abs(actual.value);

    runs.push({
      ...base,
      actualClosingCash: actual.value,
      status: 'scored',
      statusDetail: 'Scored against the imported cash and bank position on the target date.',
      varianceMinor: variance,
      // Undefined rather than Infinity when the actual balance is exactly zero.
      absolutePercentError: denominator === 0 ? null : Math.abs(variance / denominator) * 100,
      withinScenarioBand: actual.value >= record.projected.worst && actual.value <= record.projected.best,
    });
  }

  return { runs, accuracy: summarise(runs) };
}

export interface AccuracySummary {
  scoredCount: number;
  pendingCount: number;
  /** Mean absolute percentage error across scored runs, or null when none are scored. */
  mape: number | null;
  withinBandCount: number;
  /** The PRD proposes ±10% at 30 days; reported, never assumed to be met. */
  within10PercentCount: number;
  note: string;
}

function summarise(runs: ScoredRun[]): AccuracySummary {
  const scored = runs.filter((r) => r.status === 'scored');
  const withError = scored.filter((r) => r.absolutePercentError !== null);

  const mape = withError.length
    ? withError.reduce((sum, r) => sum + (r.absolutePercentError ?? 0), 0) / withError.length
    : null;

  return {
    scoredCount: scored.length,
    pendingCount: runs.length - scored.length,
    mape,
    withinBandCount: scored.filter((r) => r.withinScenarioBand).length,
    within10PercentCount: withError.filter((r) => (r.absolutePercentError ?? 0) <= 10).length,
    note: scored.length
      ? 'Accuracy is measured against the expected-case projection and the imported cash position on each target date.'
      : 'No forecast has reached its target date with imported data behind it yet, so no accuracy figure can be reported.',
  };
}

/** The imported cash and bank position on a date, or an explicit "unavailable". */
async function actualCashAt(
  companyId: string,
  date: string,
  financialYearStart: string,
): Promise<{ available: boolean; value: Minor }> {
  const set = await loadBalances(companyId, { from: financialYearStart, to: date }, {});
  const hasCashLedger = set.balances.some((b) => b.section === 'cash_and_bank');
  if (!hasCashLedger) return { available: false, value: 0 };
  return { available: true, value: sumSections(set.balances, 'BS', ['cash_and_bank']) };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
