import { Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FileSpreadsheet, FileText, Info, Scale, TriangleAlert, Wrench } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/state/AppContext';
import { Badge, Button, Callout, Card, CardHeader, EmptyState, LoadingPane, Select, Tooltip } from '@/components/ui';
import { DataQualityBanner, Explainer, PageHeader, StatementTable, type DataQuality, type StatementLineData } from '@/components/financial';
import { DrilldownPanel } from '@/components/Drilldown';
import { cx, formatAmount, formatDate, formatMoney, todayIso } from '@/lib/format';

type Drill = { kind: 'category'; categoryKey: string; label: string; statement?: 'PL' | 'BS' } | null;

/* ============================================================ Profit & Loss */

interface PlResponse {
  period: { from: string; to: string; label?: string };
  lines: StatementLineData[];
  quality: DataQuality;
  comparison: { label: string } | null;
  isEmpty: boolean;
  methodology: string[];
  generatedAt: string;
}

export function ProfitAndLossPage() {
  const { company, scopeQuery, currency, can } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<PlResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<'previous' | 'last_year' | 'none'>('previous');
  const [drill, setDrill] = useState<Drill>(null);

  useEffect(() => {
    if (!company) return;
    setLoading(true);
    void (async () => {
      try {
        setData(await api.get<PlResponse>('/finance/profit-and-loss', { ...scopeQuery, comparison }));
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'The Profit & Loss could not be produced.');
      } finally {
        setLoading(false);
      }
    })();
  }, [company, scopeQuery.financialYearId, scopeQuery.periodType, scopeQuery.from, scopeQuery.to, comparison]);

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <StatementSkeleton title="Profit & Loss" />;
  if (error) return <ErrorNotice title="Profit & Loss" message={error} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="Profit & Loss"
        description={
          <span>
            {company.name} · {data.period.label ?? `${data.period.from} to ${data.period.to}`}
          </span>
        }
        actions={
          <>
            <Select value={comparison} onChange={(e) => setComparison(e.target.value as typeof comparison)} className="w-44">
              <option value="previous">vs previous period</option>
              <option value="last_year">vs same period last year</option>
              <option value="none">No comparison</option>
            </Select>
            {can('reports.export') && <ExportButtons reportKey="profit_and_loss" scope={scopeQuery} />}
          </>
        }
      />

      {data.isEmpty ? (
        <Card>
          <EmptyState
            icon={<FileText className="w-5 h-5" />}
            title="No Profit & Loss activity in this period"
            description="No ledger categorised under a Profit & Loss section carries a movement here. Import vouchers for this period, or confirm the account mappings so income and expense ledgers are classified."
            action={can('imports.create') ? <Button variant="primary" onClick={() => navigate('/import')}>Import vouchers</Button> : undefined}
            secondaryAction={can('mapping.view') ? <Button onClick={() => navigate('/account-mapping')}>Review mappings</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          <DataQualityBanner quality={data.quality} currency={currency} onFix={() => navigate('/account-mapping')} className="mb-4" />

          <Card className="overflow-hidden">
            <StatementTable
              lines={data.lines}
              currency={currency}
              comparisonLabel={data.comparison?.label}
              onDrill={(categoryKey, label) => setDrill({ kind: 'category', categoryKey, label, statement: 'PL' })}
            />
          </Card>

          <MethodologyNote items={data.methodology} generatedAt={data.generatedAt} />
        </>
      )}

      <Explainer
        className="mt-5"
        what="Shows income and expenses for the selected period, from revenue down to net profit, with the previous period alongside."
        why="It is the measure of whether the business made money, and where it went."
        needs="Vouchers for the period, and income and expense ledgers with confirmed category mappings."
        next="Expand a line to see its categories, then click a category to see the ledgers and the vouchers behind it."
      />

      {drill && <DrilldownPanel initial={drill} onClose={() => setDrill(null)} />}
    </>
  );
}

/* ============================================================ Balance Sheet */

interface BsResponse {
  asOfDate: string;
  assets: Section[];
  liabilities: Section[];
  equity: Section[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  profitForPeriod: number | null;
  equationDifference: number;
  balances: boolean;
  diagnostics: { cause: string; detail: string; amount?: number; action: string }[];
  quality: DataQuality;
  isEmpty: boolean;
  methodology: string[];
  comparative: { asOfDate: string; totalAssets: number; totalLiabilities: number; totalEquity: number } | null;
  generatedAt: string;
}

interface Section {
  section: string;
  label: string;
  total: number;
  lines: { categoryKey: string; label: string; total: number; ledgerCount: number }[];
}

export function BalanceSheetPage() {
  const { company, scopeQuery, financialYear, currency, can } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<BsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asOfDate, setAsOfDate] = useState<string>('');
  const [drill, setDrill] = useState<Drill>(null);

  useEffect(() => {
    if (financialYear && !asOfDate) {
      const today = todayIso();
      setAsOfDate(financialYear.endDate < today ? financialYear.endDate : today);
    }
  }, [financialYear, asOfDate]);

  useEffect(() => {
    if (!company) return;
    setLoading(true);
    void (async () => {
      try {
        setData(await api.get<BsResponse>('/finance/balance-sheet', { ...scopeQuery, asOfDate: asOfDate || undefined }));
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'The Balance Sheet could not be produced.');
      } finally {
        setLoading(false);
      }
    })();
  }, [company, scopeQuery.financialYearId, asOfDate]);

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <StatementSkeleton title="Balance Sheet" />;
  if (error) return <ErrorNotice title="Balance Sheet" message={error} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="Balance Sheet"
        description={`${company.name} · as at ${formatDate(data.asOfDate)}`}
        actions={
          <>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="h-9 px-3 text-sm bg-surface border border-line rounded-control text-ink focus:border-brand"
              aria-label="Reporting date"
            />
            {can('reports.export') && <ExportButtons reportKey="balance_sheet" scope={{ ...scopeQuery, asOfDate }} />}
          </>
        }
      />

      {data.isEmpty ? (
        <Card>
          <EmptyState
            icon={<Scale className="w-5 h-5" />}
            title="No Balance Sheet data yet"
            description="Import a chart of accounts and opening balances, then confirm the category mappings so each ledger knows where it belongs."
            action={can('imports.create') ? <Button variant="primary" onClick={() => navigate('/import')}>Import data</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          <DataQualityBanner quality={data.quality} currency={currency} onFix={() => navigate('/account-mapping')} className="mb-4" />

          {/* ------------------------------------------- the equation check */}
          <Card className={cx('mb-4 border-2', data.balances ? 'border-positive-border' : 'border-warning-border')}>
            <div className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div
                    className={cx(
                      'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                      data.balances ? 'bg-positive-bg text-positive' : 'bg-warning-bg text-warning',
                    )}
                  >
                    {data.balances ? <Scale className="w-4 h-4" /> : <TriangleAlert className="w-4 h-4" />}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-ink">
                      {data.balances ? 'The statement balances' : 'The statement does not balance'}
                    </p>
                    <p className="text-xs text-ink-muted mt-0.5">Assets = Liabilities + Equity</p>
                  </div>
                </div>

                <div className="flex items-center gap-5 text-sm tabular flex-wrap">
                  <Figure label="Assets" value={data.totalAssets} currency={currency} />
                  <span className="text-ink-subtle">=</span>
                  <Figure label="Liabilities" value={data.totalLiabilities} currency={currency} />
                  <span className="text-ink-subtle">+</span>
                  <Figure label="Equity" value={data.totalEquity} currency={currency} />
                  {!data.balances && (
                    <>
                      <span className="text-ink-subtle">·</span>
                      <Figure label="Difference" value={data.equationDifference} currency={currency} tone="warning" />
                    </>
                  )}
                </div>
              </div>
            </div>

            {!data.balances && data.diagnostics.length > 0 && (
              <div className="border-t border-line bg-warning-bg/30 px-5 py-4">
                <p className="text-xs font-semibold text-ink mb-2.5 flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5" />
                  Likely causes — the statement is never forced to balance
                </p>
                <ul className="space-y-2.5">
                  {data.diagnostics.map((d, i) => (
                    <li key={i} className="text-xs">
                      <p className="font-medium text-ink">
                        {d.cause}
                        {d.amount !== undefined && d.amount !== 0 && (
                          <span className="font-normal text-ink-muted"> · {formatMoney(Math.abs(d.amount), currency)}</span>
                        )}
                      </p>
                      <p className="text-ink-muted mt-0.5 leading-relaxed">{d.detail}</p>
                      <p className="text-brand mt-0.5">{d.action}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <div className="grid lg:grid-cols-2 gap-4">
            <BsColumn title="Assets" sections={data.assets} total={data.totalAssets} currency={currency} onDrill={setDrill} />
            <div className="space-y-4">
              <BsColumn title="Liabilities" sections={data.liabilities} total={data.totalLiabilities} currency={currency} onDrill={setDrill} />
              <BsColumn title="Equity" sections={data.equity} total={data.totalEquity} currency={currency} onDrill={setDrill} />
            </div>
          </div>

          {data.comparative && (
            <Card className="mt-4">
              <CardHeader title="Comparative position" description={`Against ${formatDate(data.comparative.asOfDate)}`} />
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left px-5 py-2.5 label-text">Measure</th>
                    <th className="text-right px-4 py-2.5 label-text">{formatDate(data.asOfDate)}</th>
                    <th className="text-right px-4 py-2.5 label-text">{formatDate(data.comparative.asOfDate)}</th>
                    <th className="text-right px-4 py-2.5 label-text">Movement</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['Total assets', data.totalAssets, data.comparative.totalAssets],
                      ['Total liabilities', data.totalLiabilities, data.comparative.totalLiabilities],
                      ['Total equity', data.totalEquity, data.comparative.totalEquity],
                    ] as [string, number, number][]
                  ).map(([label, now, before]) => (
                    <tr key={label} className="border-b border-line/60">
                      <td className="px-5 py-2.5 text-ink">{label}</td>
                      <td className="px-4 py-2.5 text-right tabular">{formatAmount(now, currency)}</td>
                      <td className="px-4 py-2.5 text-right tabular text-ink-muted">{formatAmount(before, currency)}</td>
                      <td className={cx('px-4 py-2.5 text-right tabular', now - before >= 0 ? 'text-positive' : 'text-danger')}>
                        {formatAmount(now - before, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <MethodologyNote items={data.methodology} generatedAt={data.generatedAt} />
        </>
      )}

      <Explainer
        className="mt-5"
        what="Shows what the business owns, what it owes and what is left for the owners, at a single date."
        why="Where the Profit & Loss covers a period, this is the position at a moment — the basis of every liquidity and leverage ratio."
        needs="Opening balances for the financial year plus vouchers up to the reporting date, with Balance Sheet ledgers mapped."
        next="If it does not balance, work through the likely causes above. Click any category to see the ledgers behind it."
      />

      {drill && <DrilldownPanel initial={drill} onClose={() => setDrill(null)} />}
    </>
  );
}

function BsColumn({
  title,
  sections,
  total,
  currency,
  onDrill,
}: {
  title: string;
  sections: Section[];
  total: number;
  currency: { currency: string; scale: number };
  onDrill: (d: Drill) => void;
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <table className="w-full text-sm">
        <tbody>
          {sections.map((s) => (
            <Fragment key={s.section}>
              {s.lines.map((l) => (
                <tr key={`${s.section}-${l.categoryKey}`} className="border-b border-line/60 hover:bg-navy-50/40">
                  <td className="px-5 py-2 pl-8">
                    {l.categoryKey.startsWith('__') ? (
                      <span className="text-ink-muted text-xs italic">{l.label}</span>
                    ) : (
                      <button
                        onClick={() => onDrill({ kind: 'category', categoryKey: l.categoryKey, label: l.label, statement: 'BS' })}
                        className="text-ink-muted hover:text-brand transition-colors text-left text-xs"
                      >
                        {l.label}
                        <span className="text-ink-subtle"> ({l.ledgerCount})</span>
                      </button>
                    )}
                  </td>
                  <td className="px-5 py-2 text-right tabular text-xs text-ink-muted">{formatAmount(l.total, currency)}</td>
                </tr>
              ))}
              <tr className="border-b border-line bg-navy-50/50">
                <td className="px-5 py-2 text-sm font-medium text-ink">{s.label}</td>
                <td className="px-5 py-2 text-right tabular text-sm font-medium text-ink">{formatAmount(s.total, currency)}</td>
              </tr>
            </Fragment>
          ))}
          <tr className="bg-navy-50 border-t-2 border-line-strong">
            <td className="px-5 py-3 text-sm font-semibold text-navy-900">Total {title.toLowerCase()}</td>
            <td className="px-5 py-3 text-right tabular text-sm font-semibold text-navy-900">{formatAmount(total, currency)}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

/* ================================================================== Equity */

export function EquityPage() {
  const { company, scopeQuery, currency, can } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!company) return;
    setLoading(true);
    void (async () => {
      try {
        setData(await api.get<any>('/finance/equity', scopeQuery));
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'The equity statement could not be produced.');
      } finally {
        setLoading(false);
      }
    })();
  }, [company, scopeQuery.financialYearId, scopeQuery.periodType]);

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <StatementSkeleton title="Equity Statement" />;
  if (error) return <ErrorNotice title="Equity Statement" message={error} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="Statement of Changes in Equity"
        description={`${company.name} · ${data.period.label ?? `${data.period.from} to ${data.period.to}`} · presented for a ${company.entityLabel ?? company.entityType.replace(/_/g, ' ')}`}
        actions={can('reports.export') && <ExportButtons reportKey="equity" scope={scopeQuery} />}
      />

      {data.isEmpty ? (
        <Card>
          <EmptyState
            icon={<FileText className="w-5 h-5" />}
            title="No equity data yet"
            description="Map at least one ledger to a Capital Account, Reserves or Drawings category, and import the period's vouchers."
            action={can('mapping.view') ? <Button variant="primary" onClick={() => navigate('/account-mapping')}>Open Account Mapping</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          <DataQualityBanner quality={data.quality} currency={currency} onFix={() => navigate('/account-mapping')} className="mb-4" />

          {!data.reconciles && (
            <Callout tone="warning" title="Closing equity does not match the Balance Sheet" className="mb-4">
              The difference is {formatMoney(Math.abs(data.unexplainedDifference), currency)}. This is reported rather than absorbed, because
              an unexplained equity movement usually points at a ledger mapped to the wrong category or a missing opening balance.
            </Callout>
          )}

          <Card className="overflow-hidden">
            <StatementTable lines={data.lines} currency={currency} showFormula />
          </Card>

          <Card className="mt-4">
            <CardHeader title="Reconciliation to the Balance Sheet" />
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b border-line/60">
                  <td className="px-5 py-2.5 text-ink">Closing equity per this statement</td>
                  <td className="px-5 py-2.5 text-right tabular">{formatAmount(data.closingEquity, currency)}</td>
                </tr>
                <tr className="border-b border-line/60">
                  <td className="px-5 py-2.5 text-ink">Equity per the Balance Sheet</td>
                  <td className="px-5 py-2.5 text-right tabular">{formatAmount(data.balanceSheetEquity, currency)}</td>
                </tr>
                <tr className={cx(data.reconciles ? 'bg-positive-bg' : 'bg-warning-bg')}>
                  <td className="px-5 py-2.5 font-medium text-ink">{data.reconciles ? 'Reconciled' : 'Unexplained difference'}</td>
                  <td className="px-5 py-2.5 text-right tabular font-semibold">{formatAmount(data.unexplainedDifference, currency)}</td>
                </tr>
              </tbody>
            </table>
          </Card>

          <MethodologyNote items={data.methodology} generatedAt={data.generatedAt} />
        </>
      )}

      <Explainer
        className="mt-5"
        what="Shows how the owners' stake moved across the period: what was put in, what the business earned, and what was taken out."
        why="It connects the Profit & Loss to the Balance Sheet and shows whether profits stayed in the business."
        needs="Ledgers mapped to Capital Account, Reserves and Surplus, or Drawings, plus the period's vouchers."
        next="If the closing figure does not reconcile with the Balance Sheet, check those mappings first."
      />
    </>
  );
}

/* ---------------------------------------------------------------- helpers */

function Figure({
  label,
  value,
  currency,
  tone,
}: {
  label: string;
  value: number;
  currency: { currency: string; scale: number };
  tone?: 'warning';
}) {
  return (
    <span className="inline-flex flex-col">
      <span className="label-text">{label}</span>
      <span className={cx('font-semibold', tone === 'warning' ? 'text-warning' : 'text-ink')}>{formatMoney(value, currency)}</span>
    </span>
  );
}

export function ExportButtons({ reportKey, scope }: { reportKey: string; scope: Record<string, string | undefined> }) {
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (format: 'pdf' | 'xlsx') => {
    setBusy(format);
    try {
      await api.download(`/reports/${reportKey}/export.${format}`, scope);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" loading={busy === 'pdf'} icon={<FileText className="w-3.5 h-3.5" />} onClick={() => run('pdf')}>
        PDF
      </Button>
      <Button size="sm" loading={busy === 'xlsx'} icon={<FileSpreadsheet className="w-3.5 h-3.5" />} onClick={() => run('xlsx')}>
        Excel
      </Button>
    </div>
  );
}

export function MethodologyNote({ items, generatedAt }: { items: string[]; generatedAt?: string }) {
  return (
    <div className="mt-4 rounded-card border border-line bg-navy-50/40 px-4 py-3">
      <p className="text-xs font-medium text-ink mb-1.5 flex items-center gap-1.5">
        <Info className="w-3.5 h-3.5 text-ink-muted" />
        How these figures are produced
      </p>
      <ul className="space-y-1 text-xs text-ink-muted leading-relaxed list-disc list-inside">
        {items.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
      <p className="text-2xs text-ink-subtle mt-2">
        Data source: Excel Import{generatedAt && ` · Generated ${new Date(generatedAt).toLocaleString('en-IN')}`}. Management report, not an
        audited financial statement.
      </p>
    </div>
  );
}

export function SelectCompanyNotice() {
  const navigate = useNavigate();
  return (
    <Card>
      <EmptyState
        title="Select a company"
        description="Financial statements are produced for one company at a time."
        action={<Button variant="primary" onClick={() => navigate('/companies')}>Go to Companies</Button>}
      />
    </Card>
  );
}

export function StatementSkeleton({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <LoadingPane label="Calculating from your ledgers…" />
      </Card>
    </>
  );
}

export function ErrorNotice({ title, message }: { title: string; message: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Callout tone="danger" title="This could not be produced">
        {message}
      </Callout>
    </>
  );
}

export { Badge, Tooltip, Download };
