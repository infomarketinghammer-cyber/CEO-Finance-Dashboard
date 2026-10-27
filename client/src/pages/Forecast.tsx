import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, History, Plus, RotateCcw, Trash2, TrendingDown, TrendingUp, Wallet, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/state/AppContext';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  Input,
  LoadingPane,
  Select,
  Tabs,
  Tooltip,
} from '@/components/ui';
import { Explainer, PageHeader } from '@/components/financial';
import { ChartCard, ForecastChart } from '@/components/charts';
import { cx, formatAmount, formatDate, formatMoney, formatNumber, todayIso } from '@/lib/format';
import { ExportButtons, SelectCompanyNotice } from './Statements';

interface ForecastDay {
  date: string;
  openingBalance: number;
  inflow: number;
  outflow: number;
  closingBalance: number;
  belowThreshold: boolean;
}

interface ScenarioResult {
  days: ForecastDay[];
  closingBalance: number;
  lowestBalance: number;
  lowestBalanceDate: string;
  totalInflow: number;
  totalOutflow: number;
  shortfallDate: string | null;
  breachesThreshold: boolean;
}

interface Driver {
  date: string;
  kind: string;
  label: string;
  direction: 'inflow' | 'outflow';
  amount: number;
  applied: number;
  note?: string;
}

interface ForecastResponse {
  asOfDate: string;
  horizonDays: number;
  openingCash: number;
  openingCashAvailable: boolean;
  minCashThreshold: number | null;
  scenarios: { best: ScenarioResult; expected: ScenarioResult; worst: ScenarioResult };
  drivers: Driver[];
  shortfallExplanation: { date: string; balance: number; contributors: { label: string; amount: number; direction: string; date: string }[] } | null;
  dataSufficiency: {
    score: number;
    level: string;
    signals: { label: string; present: boolean; detail: string }[];
    unscheduled: {
      receivablesWithoutDueDate: number;
      receivablesWithoutDueDateCount: number;
      payablesWithoutDueDate: number;
      payablesWithoutDueDateCount: number;
    };
  };
  assumptions: string[];
  method: string;
  learning: LearningInfo | null;
  learningUnavailableReason: string | null;
}

interface LearningInfo {
  simulations: number;
  receivables: { settledInvoicesLearned: number; customersWithOwnHistory: number; medianDaysToPay: number | null; modelledInvoices: number };
  payables: { learned: boolean; settledBillsLearned: number; medianDaysToPay: number | null };
  variableExpenses: { name: string; monthlyForecast: number; spread: number; months: number }[];
  projections: { label: string; direction: 'inflow' | 'outflow'; monthlyForecast: number; spread: number; model: 'ses' | 'holt'; months: number }[];
  shortfallProbability: number | null;
  validation: {
    verdict: string;
    detail: string;
    mlMeanErrorPct: number | null;
    ruleMeanErrorPct: number | null;
    windows: { cutoff: string; actualCollected: number; mlPredicted: number; rulePredicted: number; mlErrorPct: number | null; ruleErrorPct: number | null }[];
  };
}

interface Adjustment {
  id: string;
  type: 'delay_collection' | 'defer_payment' | 'one_off_expense' | 'one_off_inflow' | 'min_cash_threshold';
  label: string;
  days?: number;
  amount?: number;
  date?: string;
}

export function ForecastPage() {
  const { company, currency, can, scopeQuery } = useApp();
  const navigate = useNavigate();

  const [baseline, setBaseline] = useState<ForecastResponse | null>(null);
  const [scenario, setScenario] = useState<ForecastResponse | null>(null);
  const [impact, setImpact] = useState<{ closingBalanceChange: number; lowestBalanceChange: number; shortfallDateBefore: string | null; shortfallDateAfter: string | null } | null>(null);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [horizon, setHorizon] = useState(90);
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [tab, setTab] = useState('chart');
  const [backtest, setBacktest] = useState<BacktestResponse | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordNote, setRecordNote] = useState<string | null>(null);

  const loadBacktest = async () => {
    if (!company) return;
    try {
      setBacktest(await api.get<BacktestResponse>('/finance/forecast/backtest', { companyId: company.id }));
    } catch {
      setBacktest(null);
    }
  };

  useEffect(() => {
    if (!company || tab !== 'accuracy') return;
    void loadBacktest();
  }, [company, tab]);

  /** Stores today's projection so it can be scored once its target date passes. */
  const recordRun = async () => {
    if (!company) return;
    setRecording(true);
    setRecordNote(null);
    try {
      const res = await api.post<{ run: { targetDate: string } }>('/finance/forecast/runs', {
        companyId: company.id,
        horizonDays: horizon,
        asOfDate,
      });
      setRecordNote(`Recorded. This projection will be scored against your actual cash position on ${formatDate(res.run.targetDate)}.`);
      await loadBacktest();
    } catch (err) {
      setRecordNote(err instanceof ApiError ? err.message : 'This forecast could not be recorded.');
    } finally {
      setRecording(false);
    }
  };

  useEffect(() => {
    if (!company) return;
    setLoading(true);
    void (async () => {
      try {
        setBaseline(await api.get<ForecastResponse>('/finance/forecast', { companyId: company.id, horizonDays: horizon, asOfDate }));
        setScenario(null);
        setImpact(null);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'The forecast could not be produced.');
      } finally {
        setLoading(false);
      }
    })();
  }, [company, horizon, asOfDate]);

  const runScenario = async (next: Adjustment[]) => {
    if (!company) return;
    setAdjustments(next);
    if (next.length === 0) {
      setScenario(null);
      setImpact(null);
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ baseline: ForecastResponse; scenario: ForecastResponse; impact: typeof impact }>(
        '/finance/forecast/scenario',
        { companyId: company.id, asOfDate, horizonDays: horizon, adjustments: next },
      );
      setScenario(res.scenario);
      setImpact(res.impact);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The scenario could not be run.');
    } finally {
      setBusy(false);
    }
  };

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <LoadingPane label="Building the projection…" />;
  if (error) return <Callout tone="danger">{error}</Callout>;
  if (!baseline) return null;

  const active = scenario ?? baseline;
  const chartDays = active.scenarios.expected.days.map((d, i) => ({
    date: d.date,
    best: active.scenarios.best.days[i]?.closingBalance ?? 0,
    expected: d.closingBalance,
    worst: active.scenarios.worst.days[i]?.closingBalance ?? 0,
  }));

  return (
    <>
      <PageHeader
        title="Cash Flow Forecast"
        description={
          active.learning
            ? 'A projection that learns from your own payment history, with probability bands from thousands of simulated futures.'
            : 'A rule-based projection assembled from outstanding invoices, bills, recurring expenses and known commitments.'
        }
        actions={
          <>
            <Select value={String(horizon)} onChange={(e) => setHorizon(Number(e.target.value))} className="w-32">
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
              <option value="180">180 days</option>
              <option value="365">365 days</option>
            </Select>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="h-9 px-3 text-sm bg-surface border border-line rounded-control text-ink focus:border-brand"
              aria-label="Start from"
            />
            {can('reports.export') && (
              <ExportButtons reportKey="cash_flow_forecast" scope={{ ...scopeQuery, asOfDate, horizonDays: String(horizon) }} />
            )}
          </>
        }
      />

      {/* --------------------------------------------------- honesty banner */}
      {active.learning ? (
        <Callout tone="info" title="Learned from your own books — a statistical estimate, not a guarantee" className="mb-4">
          How long each customer really takes to pay is learned from {formatNumber(active.learning.receivables.settledInvoicesLearned)} past
          payments, then {formatNumber(active.learning.simulations)} futures are simulated. <strong>Expected</strong> is the middle outcome;{' '}
          <strong>Best</strong> and <strong>Worst</strong> bound the likely range (8 in 10 outcomes fall between them).
          {active.learning.shortfallProbability !== null && (
            <>
              {' '}
              Chance of running short of cash during this period: <strong>{active.learning.shortfallProbability}%</strong>.
            </>
          )}{' '}
          It cannot foresee a customer failing or a one-off event.
        </Callout>
      ) : (
        <Callout tone="info" title="This is a rule-based projection, not a prediction" className="mb-4">
          It walks your opening cash balance forward through dated events that already exist in your imported data, applying documented
          collection assumptions (listed under Assumptions).{' '}
          {active.learningUnavailableReason && <>The learned model is not used because: {active.learningUnavailableReason}</>}
        </Callout>
      )}

      {!baseline.openingCashAvailable && (
        <Callout tone="danger" title="No cash or bank ledger is mapped" className="mb-4">
          The projection starts from zero, which makes every balance below meaningless. Map at least one ledger to Cash and Bank first.
          <div className="mt-2">
            <Button size="sm" onClick={() => navigate('/account-mapping')}>
              Open Account Mapping
            </Button>
          </div>
        </Callout>
      )}

      {/* ------------------------------------------------------ scenarios */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Card className="p-4">
          <p className="label-text">Opening cash</p>
          <p className="text-lg font-semibold tabular text-ink mt-1">{formatMoney(active.openingCash, currency)}</p>
          <p className="text-2xs text-ink-subtle mt-0.5">as at {formatDate(active.asOfDate)}</p>
        </Card>

        {(['best', 'expected', 'worst'] as const).map((s) => {
          const sc = active.scenarios[s];
          const label = s === 'best' ? 'Best case' : s === 'expected' ? 'Expected case' : 'Worst case';
          const band = active.learning ? (s === 'best' ? 'P90 · 1 in 10 is better' : s === 'expected' ? 'P50 · middle outcome' : 'P10 · 1 in 10 is worse') : null;
          return (
            <Card key={s} className={cx('p-4', s === 'expected' && 'border-brand-200')}>
              <div className="flex items-center justify-between gap-2">
                <p className="label-text">{label}</p>
                {sc.shortfallDate && <Badge tone="danger">Shortfall</Badge>}
              </div>
              {band && <p className="text-2xs text-ink-subtle">{band}</p>}
              <p className={cx('text-lg font-semibold tabular mt-1', sc.closingBalance < 0 ? 'text-danger' : 'text-ink')}>
                {formatMoney(sc.closingBalance, currency)}
              </p>
              <p className="text-2xs text-ink-subtle mt-0.5">
                lowest {formatMoney(sc.lowestBalance, currency)} on {formatDate(sc.lowestBalanceDate)}
              </p>
            </Card>
          );
        })}
      </div>

      {/* ------------------------------------------------- scenario impact */}
      {impact && scenario && (
        <Callout tone={impact.closingBalanceChange >= 0 ? 'positive' : 'warning'} title="Effect of your what-if changes" className="mb-4">
          <div className="grid sm:grid-cols-3 gap-3 mt-1">
            <div>
              <p className="label-text">Closing balance</p>
              <p className="tabular font-semibold">{formatMoney(impact.closingBalanceChange, currency)}</p>
            </div>
            <div>
              <p className="label-text">Lowest point</p>
              <p className="tabular font-semibold">{formatMoney(impact.lowestBalanceChange, currency)}</p>
            </div>
            <div>
              <p className="label-text">Shortfall date</p>
              <p className="font-semibold">
                {impact.shortfallDateBefore ? formatDate(impact.shortfallDateBefore) : 'none'} →{' '}
                {impact.shortfallDateAfter ? formatDate(impact.shortfallDateAfter) : 'none'}
              </p>
            </div>
          </div>
        </Callout>
      )}

      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-4 min-w-0">
          <ChartCard
            title="Projected cash balance"
            description={`${horizon} days from ${formatDate(active.asOfDate)}`}
            height={320}
            empty={chartDays.length === 0}
          >
            <ForecastChart days={chartDays} currency={currency} threshold={active.minCashThreshold} />
          </ChartCard>

          <Card>
            <div className="px-5 pt-4">
              <Tabs
                tabs={[
                  { key: 'chart', label: 'Weekly balances' },
                  { key: 'drivers', label: 'What drives it', count: active.drivers.filter((d) => d.applied !== 0).length },
                  { key: 'assumptions', label: 'Assumptions' },
                  { key: 'accuracy', label: 'Accuracy' },
                ]}
                active={tab}
                onChange={setTab}
                className="border-0"
              />
            </div>

            {tab === 'chart' && <WeeklyTable days={active.scenarios.expected.days} currency={currency} />}
            {tab === 'drivers' && <DriversTable drivers={active.drivers} currency={currency} />}
            {tab === 'assumptions' && (
              <ul className="p-5 space-y-2 text-xs text-ink-muted leading-relaxed list-disc list-inside">
                {active.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
            {tab === 'accuracy' && (
              <BacktestPanel
                data={backtest}
                currency={currency}
                canRecord={can('forecast.manage')}
                recording={recording}
                note={recordNote}
                onRecord={recordRun}
              />
            )}
          </Card>

          {active.shortfallExplanation && (
            <Card className="border-danger-border">
              <CardHeader
                title={`What causes the shortfall on ${formatDate(active.shortfallExplanation.date)}`}
                description={`Projected balance falls to ${formatMoney(active.shortfallExplanation.balance, currency)}. These are the largest movements up to that date.`}
                icon={<TrendingDown className="w-4 h-4 text-danger" />}
              />
              <table className="w-full text-sm">
                <tbody>
                  {active.shortfallExplanation.contributors.map((c, i) => (
                    <tr key={i} className="border-b border-line/60">
                      <td className="px-5 py-2 text-xs text-ink-muted tabular w-24">{formatDate(c.date)}</td>
                      <td className="px-2 py-2 text-ink">{c.label}</td>
                      <td className={cx('px-5 py-2 text-right tabular text-sm', c.direction === 'inflow' ? 'text-positive' : 'text-danger')}>
                        {c.direction === 'inflow' ? '+' : '−'}
                        {formatAmount(c.amount, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>

        {/* ------------------------------------------------ side panel */}
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="What-if scenarios"
              description="Test a change and see its effect immediately. Nothing here alters your data."
              actions={
                can('forecast.manage') && (
                  <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setAddOpen(true)}>
                    Add
                  </Button>
                )
              }
            />
            {adjustments.length === 0 ? (
              <p className="px-5 py-4 text-xs text-ink-muted leading-relaxed">
                No changes applied. Add one to test delaying a collection, deferring a payment, or a one-off cost.
              </p>
            ) : (
              <>
                <ul className="divide-y divide-line">
                  {adjustments.map((a) => (
                    <li key={a.id} className="px-5 py-2.5 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-ink">{a.label}</p>
                        <p className="text-2xs text-ink-subtle mt-0.5">
                          {a.days ? `${a.days} day(s)` : ''}
                          {a.amount ? formatMoney(a.amount, currency) : ''}
                          {a.date ? ` on ${formatDate(a.date)}` : ''}
                        </p>
                      </div>
                      <button
                        onClick={() => runScenario(adjustments.filter((x) => x.id !== a.id))}
                        className="text-ink-subtle hover:text-danger transition-colors shrink-0"
                        aria-label="Remove"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="px-5 py-3 border-t border-line">
                  <Button size="sm" fullWidth icon={<RotateCcw className="w-3.5 h-3.5" />} loading={busy} onClick={() => runScenario([])}>
                    Reset to baseline
                  </Button>
                </div>
              </>
            )}
          </Card>

          {active.learning && (
            <Card>
              <CardHeader title="What the model learned" description="From your imported transactions." />
              <div className="p-5 space-y-3 text-xs text-ink-muted leading-relaxed">
                <p>
                  Customers typically pay about{' '}
                  <strong className="text-ink">
                    {active.learning.receivables.medianDaysToPay !== null ? `${active.learning.receivables.medianDaysToPay} days` : 'an unknown number of days'}
                  </strong>{' '}
                  after invoicing. {formatNumber(active.learning.receivables.customersWithOwnHistory)} customer(s) have their own history; others use the
                  company average.
                </p>
                {active.learning.projections.length > 0 && (
                  <div>
                    <p className="label-text mb-1">Projected, not yet recorded (per month)</p>
                    <ul className="space-y-1">
                      {active.learning.projections.map((p) => (
                        <li key={p.label} className="flex justify-between gap-2">
                          <span className="truncate">{p.label}</span>
                          <span className={cx('tabular shrink-0', p.direction === 'inflow' ? 'text-positive' : 'text-ink')}>
                            {formatMoney(p.monthlyForecast, currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="pt-3 border-t border-line">
                  <p className="label-text mb-1">Tested against what really happened</p>
                  <p>{active.learning.validation.detail}</p>
                  {active.learning.validation.windows.length > 0 && (
                    <table className="w-full mt-2 text-2xs">
                      <thead>
                        <tr className="text-left text-ink-subtle">
                          <th className="font-medium py-1">From</th>
                          <th className="font-medium text-right">Actual</th>
                          <th className="font-medium text-right">Model</th>
                          <th className="font-medium text-right">Rules</th>
                        </tr>
                      </thead>
                      <tbody>
                        {active.learning.validation.windows.map((w) => (
                          <tr key={w.cutoff} className="border-t border-line/60 tabular">
                            <td className="py-1">{formatDate(w.cutoff)}</td>
                            <td className="text-right">{formatMoney(w.actualCollected, currency)}</td>
                            <td className="text-right">{formatMoney(w.mlPredicted, currency)}</td>
                            <td className="text-right">{formatMoney(w.rulePredicted, currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="mt-2 text-2xs text-ink-subtle">Collections in the 30 days after each date, predicted versus actual.</p>
                </div>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="How reliable is this?" description="Based on which inputs are actually present." />
            <div className="p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex-1 h-2 bg-navy-50 rounded-full overflow-hidden">
                  <div
                    className={cx(
                      'h-full rounded-full transition-all',
                      active.dataSufficiency.score >= 80 ? 'bg-positive' : active.dataSufficiency.score >= 50 ? 'bg-warning' : 'bg-danger',
                    )}
                    style={{ width: `${active.dataSufficiency.score}%` }}
                  />
                </div>
                <span className="text-xs font-semibold text-ink tabular shrink-0">{active.dataSufficiency.score}%</span>
              </div>
              <p className="text-xs text-ink-muted capitalize mb-3">Data sufficiency: {active.dataSufficiency.level}</p>

              <ul className="space-y-2.5">
                {active.dataSufficiency.signals.map((s, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span
                      className={cx(
                        'w-1.5 h-1.5 rounded-full shrink-0 mt-1.5',
                        s.present ? 'bg-positive' : 'bg-ink-subtle',
                      )}
                    />
                    <span className="min-w-0">
                      <span className={cx('block text-xs', s.present ? 'text-ink' : 'text-ink-muted')}>{s.label}</span>
                      <span className="block text-2xs text-ink-subtle leading-relaxed mt-0.5">{s.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>

              {(active.dataSufficiency.unscheduled.receivablesWithoutDueDateCount > 0 ||
                active.dataSufficiency.unscheduled.payablesWithoutDueDateCount > 0) && (
                <div className="mt-4 pt-3.5 border-t border-line">
                  <p className="label-text mb-1.5">Excluded from the projection</p>
                  {active.dataSufficiency.unscheduled.receivablesWithoutDueDateCount > 0 && (
                    <p className="text-2xs text-ink-muted leading-relaxed">
                      {formatMoney(active.dataSufficiency.unscheduled.receivablesWithoutDueDate, currency)} of receivables across{' '}
                      {formatNumber(active.dataSufficiency.unscheduled.receivablesWithoutDueDateCount)} invoice(s) have no due date, so they
                      cannot be placed on a day.
                    </p>
                  )}
                  {active.dataSufficiency.unscheduled.payablesWithoutDueDateCount > 0 && (
                    <p className="text-2xs text-ink-muted leading-relaxed mt-1">
                      {formatMoney(active.dataSufficiency.unscheduled.payablesWithoutDueDate, currency)} of payables across{' '}
                      {formatNumber(active.dataSufficiency.unscheduled.payablesWithoutDueDateCount)} bill(s) have no due date.
                    </p>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <Explainer
        className="mt-5"
        what="Projects your cash balance forward day by day, using invoices, bills, recurring expenses and commitments that already exist in your data."
        why="It answers the question that actually keeps owners awake: will there be enough cash, and if not, when does it run short?"
        needs="A mapped Cash and Bank ledger, plus receivables and payables with due dates. Recurring expenses make it considerably sharper."
        next="Use the what-if panel to test a late payment or an unplanned cost before it happens."
      />

      <AddAdjustmentDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        currencyScale={currency.scale}
        onAdd={(a) => {
          setAddOpen(false);
          void runScenario([...adjustments, a]);
        }}
      />
    </>
  );
}

/* ------------------------------------------------- forecast vs actual (§15) */

interface ScoredRun {
  id: string;
  label: string;
  createdAt: string;
  asOfDate: string;
  horizonDays: number;
  targetDate: string;
  projected: { best: number; expected: number; worst: number };
  actualClosingCash: number | null;
  status: 'not_yet_due' | 'no_data' | 'scored';
  statusDetail: string;
  varianceMinor: number | null;
  absolutePercentError: number | null;
  withinScenarioBand: boolean | null;
}

interface BacktestResponse {
  runs: ScoredRun[];
  accuracy: {
    scoredCount: number;
    pendingCount: number;
    mape: number | null;
    withinBandCount: number;
    within10PercentCount: number;
    note: string;
  };
  method: string;
}

function BacktestPanel({
  data,
  currency,
  canRecord,
  recording,
  note,
  onRecord,
}: {
  data: BacktestResponse | null;
  currency: { currency: string; scale: number };
  canRecord: boolean;
  recording: boolean;
  note: string | null;
  onRecord: () => void;
}) {
  if (!data) return <div className="p-5"><LoadingPane label="Looking up past forecasts…" /></div>;

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 max-w-xl">
          <p className="text-sm font-medium text-ink">How past forecasts turned out</p>
          <p className="text-xs text-ink-muted mt-1 leading-relaxed">{data.method}</p>
        </div>
        {canRecord && (
          <Button size="sm" variant="secondary" onClick={onRecord} loading={recording} icon={<History className="w-3.5 h-3.5" />}>
            Record this forecast
          </Button>
        )}
      </div>

      {note && <Callout tone={note.startsWith('Recorded') ? 'positive' : 'danger'}>{note}</Callout>}

      {data.runs.length === 0 ? (
        <EmptyState
          icon={<History className="w-5 h-5" />}
          title="No forecasts have been recorded yet"
          description="Record a projection to start building an accuracy history. Each recorded run is compared with your actual cash position once its target date arrives — a forecast can only be judged against an outcome it did not already know."
        />
      ) : (
        <>
          {/* Accuracy summary. Reported, never assumed to meet a target. */}
          <div className="grid sm:grid-cols-4 gap-3">
            <SummaryTile label="Scored" value={String(data.accuracy.scoredCount)} hint="Runs whose target date has passed" />
            <SummaryTile label="Awaiting outcome" value={String(data.accuracy.pendingCount)} hint="Target date not yet reached" />
            <SummaryTile
              label="Mean absolute error"
              value={data.accuracy.mape === null ? 'N/A' : `${data.accuracy.mape.toFixed(1)}%`}
              hint="Against the expected case"
            />
            <SummaryTile
              label="Inside the band"
              value={data.accuracy.scoredCount ? `${data.accuracy.withinBandCount}/${data.accuracy.scoredCount}` : 'N/A'}
              hint="Actual fell between worst and best case"
            />
          </div>

          <Callout tone="neutral">{data.accuracy.note}</Callout>

          <div className="overflow-x-auto -mx-5">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="border-y border-line">
                  <th className="text-left px-5 py-2 label-text">Forecast made</th>
                  <th className="text-left px-3 py-2 label-text">Target date</th>
                  <th className="text-right px-3 py-2 label-text">Projected</th>
                  <th className="text-right px-3 py-2 label-text">Actual</th>
                  <th className="text-right px-3 py-2 label-text">Error</th>
                  <th className="text-left px-5 py-2 label-text">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id} className="border-b border-line/60 hover:bg-navy-50/40">
                    <td className="px-5 py-2.5 text-xs text-ink-muted tabular whitespace-nowrap">
                      {formatDate(r.asOfDate)}
                      <span className="text-ink-subtle"> · {r.horizonDays}d</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-muted tabular whitespace-nowrap">{formatDate(r.targetDate)}</td>
                    <td className="px-3 py-2.5 text-right tabular text-xs text-ink whitespace-nowrap">
                      {formatAmount(r.projected.expected, currency)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular text-xs whitespace-nowrap">
                      {r.actualClosingCash === null ? (
                        <span className="text-ink-subtle">—</span>
                      ) : (
                        <span className="text-ink">{formatAmount(r.actualClosingCash, currency)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular text-xs whitespace-nowrap">
                      {r.absolutePercentError === null ? (
                        <span className="text-ink-subtle">—</span>
                      ) : (
                        <span className={cx(r.absolutePercentError <= 10 ? 'text-positive' : 'text-warning')}>
                          {r.absolutePercentError.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-2.5">
                      <Tooltip content={r.statusDetail}>
                        <span>
                          {r.status === 'scored' ? (
                            <Badge tone={r.withinScenarioBand ? 'positive' : 'warning'}>
                              {r.withinScenarioBand ? 'Within band' : 'Outside band'}
                            </Badge>
                          ) : r.status === 'no_data' ? (
                            <Badge tone="neutral">Data missing</Badge>
                          ) : (
                            <Badge tone="neutral">Awaiting outcome</Badge>
                          )}
                        </span>
                      </Tooltip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-input border border-line bg-navy-50/40 px-3.5 py-3">
      <p className="label-text">{label}</p>
      <p className="text-lg font-semibold text-ink tabular mt-1">{value}</p>
      <p className="text-2xs text-ink-subtle mt-0.5 leading-relaxed">{hint}</p>
    </div>
  );
}

function WeeklyTable({ days, currency }: { days: ForecastDay[]; currency: { currency: string; scale: number } }) {
  // One row per week keeps a 90-day projection readable.
  const weekly = days.filter((_, i) => i % 7 === 0 || i === days.length - 1);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line">
            <th className="text-left px-5 py-2.5 label-text">Date</th>
            <th className="text-right px-4 py-2.5 label-text">Opening</th>
            <th className="text-right px-4 py-2.5 label-text">In</th>
            <th className="text-right px-4 py-2.5 label-text">Out</th>
            <th className="text-right px-4 py-2.5 label-text">Closing</th>
          </tr>
        </thead>
        <tbody>
          {weekly.map((d) => (
            <tr key={d.date} className={cx('border-b border-line/60', d.belowThreshold && 'bg-danger-bg/40')}>
              <td className="px-5 py-2 text-xs text-ink-muted tabular whitespace-nowrap">{formatDate(d.date)}</td>
              <td className="px-4 py-2 text-right tabular text-xs text-ink-muted">{formatAmount(d.openingBalance, currency)}</td>
              <td className="px-4 py-2 text-right tabular text-xs text-positive">{d.inflow ? formatAmount(d.inflow, currency) : '—'}</td>
              <td className="px-4 py-2 text-right tabular text-xs text-danger">{d.outflow ? formatAmount(d.outflow, currency) : '—'}</td>
              <td className={cx('px-4 py-2 text-right tabular font-medium', d.closingBalance < 0 ? 'text-danger' : 'text-ink')}>
                {formatAmount(d.closingBalance, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DriversTable({ drivers, currency }: { drivers: Driver[]; currency: { currency: string; scale: number } }) {
  if (drivers.length === 0) {
    return (
      <EmptyState
        icon={<CalendarClock className="w-5 h-5" />}
        title="No dated cash events"
        description="Nothing in the imported data falls inside this horizon with a date attached."
      />
    );
  }

  return (
    <div className="overflow-x-auto max-h-[420px]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line">
            <th className="text-left px-5 py-2.5 label-text">Date</th>
            <th className="text-left px-4 py-2.5 label-text">Item</th>
            <th className="text-left px-4 py-2.5 label-text">Type</th>
            <th className="text-right px-4 py-2.5 label-text">Face value</th>
            <th className="text-right px-4 py-2.5 label-text">Applied</th>
          </tr>
        </thead>
        <tbody>
          {drivers.map((d, i) => (
            <tr key={i} className={cx('border-b border-line/60', d.applied === 0 && 'opacity-50')}>
              <td className="px-5 py-2 text-xs text-ink-muted tabular whitespace-nowrap">{formatDate(d.date)}</td>
              <td className="px-4 py-2">
                <p className="text-xs text-ink">{d.label}</p>
                {d.note && <p className="text-2xs text-ink-subtle mt-0.5 leading-relaxed">{d.note}</p>}
              </td>
              <td className="px-4 py-2">
                <Badge tone={d.direction === 'inflow' ? 'positive' : 'neutral'}>{d.kind.replace(/_/g, ' ')}</Badge>
              </td>
              <td className="px-4 py-2 text-right tabular text-xs text-ink-muted">{formatAmount(d.amount, currency)}</td>
              <td className={cx('px-4 py-2 text-right tabular text-xs font-medium', d.direction === 'inflow' ? 'text-positive' : 'text-danger')}>
                {d.applied === 0 ? '—' : `${d.direction === 'inflow' ? '+' : '−'}${formatAmount(d.applied, currency)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddAdjustmentDialog({
  open,
  onClose,
  onAdd,
  currencyScale,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (a: Adjustment) => void;
  currencyScale: number;
}) {
  const [type, setType] = useState<Adjustment['type']>('delay_collection');
  const [days, setDays] = useState(15);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [label, setLabel] = useState('');

  const needsAmount = type === 'one_off_expense' || type === 'one_off_inflow' || type === 'min_cash_threshold';
  const needsDate = type === 'one_off_expense' || type === 'one_off_inflow';
  const needsDays = type === 'delay_collection' || type === 'defer_payment';

  const submit = () => {
    const defaults: Record<Adjustment['type'], string> = {
      delay_collection: `All collections arrive ${days} days later`,
      defer_payment: `All payments deferred by ${days} days`,
      one_off_expense: label || 'One-off expense',
      one_off_inflow: label || 'One-off inflow',
      min_cash_threshold: 'Minimum cash threshold',
    };

    onAdd({
      id: Math.random().toString(36).slice(2),
      type,
      label: defaults[type],
      days: needsDays ? days : undefined,
      amount: needsAmount && amount ? Math.round(Number(amount) * Math.pow(10, currencyScale)) : undefined,
      date: needsDate ? date : undefined,
    });

    setAmount('');
    setLabel('');
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Test a change"
      description="Nothing is saved to your data. The projection is recalculated and shown against the baseline."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={needsAmount && !amount} onClick={submit}>
            Apply to the projection
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="What would you like to test?" required>
          <Select value={type} onChange={(e) => setType(e.target.value as Adjustment['type'])}>
            <option value="delay_collection">Customers pay later than expected</option>
            <option value="defer_payment">Defer paying suppliers</option>
            <option value="one_off_expense">An unplanned cost</option>
            <option value="one_off_inflow">An unexpected receipt</option>
            <option value="min_cash_threshold">Change the minimum cash threshold</option>
          </Select>
        </Field>

        {needsDays && (
          <Field label="By how many days?" required>
            <Input type="number" min={1} max={180} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </Field>
        )}

        {needsAmount && (
          <Field label="Amount" required hint="In your reporting currency.">
            <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50000" />
          </Field>
        )}

        {needsDate && (
          <Field label="On which date?" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}

        {(type === 'one_off_expense' || type === 'one_off_inflow') && (
          <Field label="Description" hint="Shown in the drivers list so you can tell it apart from real records.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New machinery deposit" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

export { TrendingUp, Wallet, Tooltip, X };
