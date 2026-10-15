import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Building2,
  Clock,
  FileSpreadsheet,
  Sparkles,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/state/AppContext';
import { Badge, Button, Callout, Card, CardHeader, EmptyState, LoadingPane, SkeletonCard } from '@/components/ui';
import { DataQualityBanner, Explainer, KpiCard, PageHeader, type DataQuality, type KpiData } from '@/components/financial';
import { AgeingChart, BudgetVsActualChart, ChartCard, ComparisonBars, DonutChart, TrendChart } from '@/components/charts';
import { formatDateTime, formatMoney, formatRelative, greeting } from '@/lib/format';

interface DashboardData {
  company: { id: string; name: string; currency: string; currencyScale: number; isDemo: boolean };
  period: { from: string; to: string; label?: string };
  asOfDate: string;
  kpis: KpiData[];
  charts: {
    trend: { label: string; revenue: number; expenses: number; profit: number; available: boolean }[];
    expenseBreakdown: { categoryKey: string; label: string; total: number; ledgerCount: number }[];
    receivablesAgeing: { key: string; label: string; total: number; count: number }[];
    payablesAgeing: { key: string; label: string; total: number; count: number }[];
    receivablesVsPayables: { receivables: number; payables: number };
    budgetVsActual: { category: string; budgeted: number; actual: number; variance: number }[];
  };
  dataSource: { kind: string; label: string; lastImportAt: string | null; lastImportFile: string | null; lastImportCategory: string | null };
  recentImports: { id: string; fileName: string; category: string; status: string; createdAt: string; completedAt: string | null }[];
  alerts: { id: string; severity: string; title: string; message: string; link: string | null }[];
  quality: DataQuality;
  isEmpty: boolean;
}

export function DashboardPage() {
  const { company, user, scopeQuery, currency, can } = useApp();
  const navigate = useNavigate();

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!company) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const res = await api.get<DashboardData>('/finance/dashboard', scopeQuery);
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'The dashboard could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [company, scopeQuery.financialYearId, scopeQuery.periodType, scopeQuery.from, scopeQuery.to]);

  /* ------------------------------------------------- no company at all yet */
  if (!company) {
    return (
      <Card>
        <EmptyState
          icon={<Building2 className="w-5 h-5" />}
          title="Create your first company"
          description="DHYEYA keeps each company's financial data, mappings and reports entirely separate. Set one up to begin."
          action={
            can('companies.manage') ? (
              <Button variant="primary" icon={<Building2 className="w-4 h-4" />} onClick={() => navigate('/companies')}>
                Create a company
              </Button>
            ) : (
              <p className="text-xs text-ink-muted">Ask an administrator to grant you access to a company.</p>
            )
          }
        />
      </Card>
    );
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Executive Overview" />
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <SkeletonCard key={i} rows={2} />
          ))}
        </div>
        <LoadingPane label="Calculating from your imported data…" />
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader title="Executive Overview" />
        <Callout tone="danger" title="The dashboard could not be loaded">
          {error}
        </Callout>
      </>
    );
  }

  if (!data) return null;

  /* ------------------------------------------------- nothing imported yet */
  if (data.isEmpty) {
    return (
      <>
        <PageHeader title="Executive Overview" description={company.name} />
        <Card>
          <EmptyState
            icon={<FileSpreadsheet className="w-5 h-5" />}
            title="Import Your First Excel File"
            description={
              <>
                <span className="block">
                  Nothing has been imported for {company.name} yet, so there are no figures to show. Rather than filling this page with
                  sample numbers, it stays empty until your own data arrives.
                </span>
                <span className="block mt-3 font-medium text-ink">The minimum to get started:</span>
                <span className="block mt-1.5 text-left max-w-sm mx-auto">
                  <ol className="list-decimal list-inside space-y-1">
                    <li>A chart of accounts — your ledger names and their groups</li>
                    <li>Opening balances for the financial year, if the business did not start at zero</li>
                    <li>Vouchers or transactions for the period you want reported</li>
                  </ol>
                </span>
                <span className="block mt-3 text-left max-w-sm mx-auto">
                  Receivables, payables, expenses and budgets are optional and unlock the ageing, forecast and budget modules.
                </span>
              </>
            }
            action={
              can('imports.create') ? (
                <Button variant="primary" icon={<Upload className="w-4 h-4" />} onClick={() => navigate('/import')}>
                  Import Your First Excel File
                </Button>
              ) : (
                <p className="text-xs text-ink-muted">Ask a finance user to import data for this company.</p>
              )
            }
            secondaryAction={
              can('imports.view') ? (
                <Button onClick={() => navigate('/import?tab=templates')}>Download a template</Button>
              ) : undefined
            }
          />
        </Card>
      </>
    );
  }

  const trendRows = data.charts.trend.map((t) => ({ label: t.label, revenue: t.revenue, expenses: t.expenses, profit: t.profit }));
  const hasTrend = data.charts.trend.some((t) => t.available);

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${user?.name.split(' ')[0] ?? 'there'}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-ink">{data.company.name}</span>
            <span className="text-ink-subtle">·</span>
            <span>{data.period.label ?? `${data.period.from} to ${data.period.to}`}</span>
            <span className="text-ink-subtle">·</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {data.dataSource.lastImportAt ? `Data from Excel imports, latest ${formatRelative(data.dataSource.lastImportAt)}` : 'No completed import'}
            </span>
            {data.company.isDemo && <Badge tone="warning">Demo company — synthetic data</Badge>}
          </span>
        }
        actions={
          <>
            {can('reports.export') && (
              <Button size="sm" onClick={() => navigate('/reports')}>
                Export a report
              </Button>
            )}
            {can('imports.create') && (
              <Button variant="primary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => navigate('/import')}>
                Import Excel
              </Button>
            )}
          </>
        }
      />

      <DataQualityBanner quality={data.quality} currency={currency} onFix={() => navigate('/account-mapping')} className="mb-5" />

      {/* ------------------------------------------------------------- KPIs */}
      <section aria-label="Key figures" className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-5">
        {data.kpis.map((kpi) => (
          <KpiCard
            key={kpi.key}
            kpi={kpi}
            currency={currency}
            featured={kpi.key === 'netProfit'}
            onClick={kpi.link ? () => navigate(kpi.link!) : undefined}
          />
        ))}
      </section>

      {/* ----------------------------------------------------------- charts */}
      <section className="grid lg:grid-cols-2 gap-4 mb-4">
        <ChartCard
          title="Revenue, expenses and profit"
          description="Monthly movement across the selected period"
          empty={!hasTrend}
          emptyMessage="No Profit & Loss activity has been imported for this period."
          className="lg:col-span-2"
          height={290}
        >
          <TrendChart
            data={trendRows}
            currency={currency}
            type="area"
            series={[
              { key: 'revenue', name: 'Revenue', color: '#0878F9' },
              { key: 'expenses', name: 'Expenses', color: '#13C6D9' },
              { key: 'profit', name: 'Net profit', color: '#48E6A0' },
            ]}
          />
        </ChartCard>

        <ChartCard
          title="Expense breakdown"
          description="Largest expense categories in the period"
          empty={data.charts.expenseBreakdown.length === 0}
          emptyMessage="No expense ledger is categorised for this period."
        >
          <DonutChart
            data={data.charts.expenseBreakdown.map((e) => ({ label: e.label, value: e.total, categoryKey: e.categoryKey }))}
            currency={currency}
            onSliceClick={(key) => navigate(`/profit-and-loss?drill=${key}`)}
          />
        </ChartCard>

        <Card>
          <CardHeader title="Receivables against payables" description="What you are owed, against what you owe" />
          <div className="p-5">
            <ComparisonBars
              items={[
                { label: 'Receivables', value: data.charts.receivablesVsPayables.receivables, color: '#0878F9' },
                { label: 'Payables', value: data.charts.receivablesVsPayables.payables, color: '#13C6D9' },
              ]}
              currency={currency}
            />
            <div className="mt-5 pt-4 border-t border-line flex items-center justify-between">
              <span className="text-xs text-ink-muted">Net position</span>
              <span className="text-sm font-semibold tabular text-ink">
                {formatMoney(data.charts.receivablesVsPayables.receivables - data.charts.receivablesVsPayables.payables, currency)}
              </span>
            </div>
          </div>
        </Card>

        <ChartCard
          title="Receivables ageing"
          description="Outstanding customer invoices by how overdue they are"
          empty={data.charts.receivablesAgeing.every((b) => b.total === 0)}
          emptyMessage="No outstanding receivables have been imported."
          actions={
            can('receivables.view') && (
              <Button size="sm" variant="ghost" iconRight={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/receivables')}>
                Open
              </Button>
            )
          }
        >
          <AgeingChart buckets={data.charts.receivablesAgeing} currency={currency} onBucketClick={(k) => navigate(`/receivables?bucket=${k}`)} />
        </ChartCard>

        <ChartCard
          title="Payables ageing"
          description="Outstanding supplier bills by how overdue they are"
          empty={data.charts.payablesAgeing.every((b) => b.total === 0)}
          emptyMessage="No outstanding payables have been imported."
          actions={
            can('payables.view') && (
              <Button size="sm" variant="ghost" iconRight={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/payables')}>
                Open
              </Button>
            )
          }
        >
          <AgeingChart buckets={data.charts.payablesAgeing} currency={currency} onBucketClick={(k) => navigate(`/payables?bucket=${k}`)} />
        </ChartCard>

        {data.charts.budgetVsActual.length > 0 && (
          <ChartCard
            title="Actual spend against budget"
            description="By expense category for the selected period"
            className="lg:col-span-2"
            height={Math.max(220, data.charts.budgetVsActual.length * 42 + 70)}
            actions={
              can('budgets.view') && (
                <Button size="sm" variant="ghost" iconRight={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/budgets')}>
                  Open
                </Button>
              )
            }
          >
            <BudgetVsActualChart data={data.charts.budgetVsActual} currency={currency} />
          </ChartCard>
        )}
      </section>

      {/* ------------------------------------------------ alerts and imports */}
      <section className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader
            title="Needs attention"
            description="Exceptions found in the current data"
            actions={
              can('alerts.view') && (
                <Button size="sm" variant="ghost" iconRight={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/alerts')}>
                  All alerts
                </Button>
              )
            }
          />
          {data.alerts.length === 0 ? (
            <EmptyState icon={<Sparkles className="w-5 h-5" />} title="Nothing needs attention" description="No thresholds are breached in the current data." />
          ) : (
            <ul className="divide-y divide-line">
              {data.alerts.map((a) => (
                <li key={a.id}>
                  <button
                    onClick={() => a.link && navigate(a.link)}
                    disabled={!a.link}
                    className="w-full text-left px-5 py-3 hover:bg-navy-50/50 transition-colors disabled:cursor-default flex items-start gap-3"
                  >
                    <TriangleAlert
                      className={`w-4 h-4 shrink-0 mt-0.5 ${
                        a.severity === 'critical' ? 'text-danger' : a.severity === 'warning' ? 'text-warning' : 'text-info'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink font-medium">{a.title}</span>
                      <span className="block text-xs text-ink-muted mt-0.5 leading-relaxed line-clamp-2">{a.message}</span>
                    </span>
                    {a.link && <ArrowRight className="w-3.5 h-3.5 text-ink-subtle shrink-0 mt-1" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Recent import activity"
            description="Where the figures on this page came from"
            actions={
              can('imports.view') && (
                <Button size="sm" variant="ghost" iconRight={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/import')}>
                  Import Center
                </Button>
              )
            }
          />
          {data.recentImports.length === 0 ? (
            <EmptyState icon={<FileSpreadsheet className="w-5 h-5" />} title="No imports yet" />
          ) : (
            <ul className="divide-y divide-line">
              {data.recentImports.map((b) => (
                <li key={b.id} className="px-5 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink truncate">{b.fileName}</p>
                    <p className="text-xs text-ink-muted mt-0.5">
                      {b.category.replace(/_/g, ' ')} · {formatDateTime(b.completedAt ?? b.createdAt)}
                    </p>
                  </div>
                  <Badge
                    tone={b.status === 'committed' ? 'positive' : b.status === 'failed' ? 'danger' : 'neutral'}
                    className="shrink-0 mt-0.5"
                  >
                    {b.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <Explainer
        className="mt-5"
        what="Shows the financial position and result for the selected company and period, calculated from the Excel data you imported."
        why="It is the one place to see cash, profit, what you are owed and what you owe without opening four spreadsheets."
        needs="A chart of accounts with confirmed category mappings, plus vouchers for the period. Receivables, payables and budgets unlock the remaining cards."
        next="Click any figure to open the statement behind it, then keep drilling to the ledger and the voucher."
      />
    </>
  );
}
