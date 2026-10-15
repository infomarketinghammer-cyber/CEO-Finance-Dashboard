import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  BellOff,
  CheckCheck,
  Contact,
  Download,
  FileSpreadsheet,
  FileText,
  Link2,
  ShieldCheck,
  Upload,
  Wallet,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/state/AppContext';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  LoadingPane,
  Pagination,
  Select,
  Tabs,
  ToastStack,
  Tooltip,
  useToasts,
} from '@/components/ui';
import { DataQualityBanner, Explainer, PageHeader } from '@/components/financial';
import { ChartCard, TrendChart } from '@/components/charts';
import { cx, formatAmount, formatDate, formatDateTime, formatMoney, formatNumber, formatRelative, todayIso } from '@/lib/format';
import { ExportButtons, SelectCompanyNotice } from './Statements';

/* ========================================================== Cash and Bank */

export function CashAndBankPage() {
  const { company, scopeQuery, currency, can } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!company) return;
    setLoading(true);
    void (async () => {
      try {
        setData(await api.get<any>('/finance/cash-and-bank', scopeQuery));
      } finally {
        setLoading(false);
      }
    })();
  }, [company, scopeQuery.financialYearId, scopeQuery.periodType]);

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <LoadingPane />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="Cash and Bank"
        description={`Balance and movement for each cash or bank ledger, as at ${formatDate(data.asOfDate)}.`}
        actions={can('reports.export') && <ExportButtons reportKey="cash_and_bank" scope={scopeQuery} />}
      />

      {!data.available ? (
        <Card>
          <EmptyState
            icon={<Wallet className="w-5 h-5" />}
            title="No cash or bank ledger is mapped"
            description={data.reason}
            action={can('mapping.view') ? <Button variant="primary" onClick={() => navigate('/account-mapping')}>Open Account Mapping</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          <DataQualityBanner quality={data.quality} currency={currency} onFix={() => navigate('/account-mapping')} className="mb-4" />

          <Card className="mb-4 p-5">
            <p className="label-text">Total cash and bank</p>
            <p className="text-2xl font-semibold tabular text-ink mt-1">{formatMoney(data.total, currency)}</p>
            <p className="text-xs text-ink-muted mt-1">
              Across {data.accounts.length} account{data.accounts.length === 1 ? '' : 's'} · as at {formatDate(data.asOfDate)}
            </p>
          </Card>

          <ChartCard title="Cash position over time" description="Closing balance at each month end" className="mb-4">
            <TrendChart
              data={data.movement}
              currency={currency}
              type="area"
              series={[{ key: 'closing', name: 'Closing balance', color: '#0878F9' }]}
            />
          </ChartCard>

          <Card>
            <CardHeader title="Accounts" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left px-5 py-2.5 label-text">Ledger</th>
                    <th className="text-left px-4 py-2.5 label-text">Group</th>
                    <th className="text-right px-4 py-2.5 label-text">Opening</th>
                    <th className="text-right px-4 py-2.5 label-text">Received</th>
                    <th className="text-right px-4 py-2.5 label-text">Paid</th>
                    <th className="text-right px-4 py-2.5 label-text">Closing</th>
                    <th className="text-right px-4 py-2.5 label-text">Entries</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a: any) => (
                    <tr key={a.ledgerId} className="border-b border-line/60 hover:bg-navy-50/40">
                      <td className="px-5 py-2.5 text-ink">{a.ledgerName}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{a.groupName ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right tabular text-xs text-ink-muted">{formatAmount(a.opening, currency)}</td>
                      <td className="px-4 py-2.5 text-right tabular text-xs text-positive">{formatAmount(a.received, currency)}</td>
                      <td className="px-4 py-2.5 text-right tabular text-xs text-danger">{formatAmount(a.paid, currency)}</td>
                      <td className="px-4 py-2.5 text-right tabular font-medium">{formatAmount(a.closing, currency)}</td>
                      <td className="px-4 py-2.5 text-right tabular text-xs text-ink-subtle">{formatNumber(a.transactionCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <Explainer
        className="mt-5"
        what="Shows the balance and movement of every ledger you have mapped to Cash and Bank."
        why="It is the opening position for every cash forecast, and the fastest sanity check against your actual bank statement."
        needs="At least one ledger mapped to Cash and Bank, plus its opening balance and the period's vouchers."
        next="Compare these closing balances with your bank statements. A difference usually means a missing import rather than a calculation problem."
      />
    </>
  );
}

/* =============================================================== Reports */

export function ReportsPage() {
  const { company, scopeQuery, can } = useApp();
  const toasts = useToasts();
  const [reports, setReports] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        const res = await api.get<{ reports: any[] }>('/reports', { companyId: company.id });
        setReports(res.reports);
      } finally {
        setLoading(false);
      }
    })();
  }, [company]);

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <LoadingPane />;

  const run = async (key: string, format: 'pdf' | 'xlsx') => {
    setBusy(`${key}-${format}`);
    try {
      await api.download(`/reports/${key}/export.${format}`, scopeQuery);
      toasts.success('Export ready', 'The file has been downloaded.');
    } catch (err) {
      toasts.error('Export failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Reports and Exports"
        description="Every export reflects the company, financial year, period and filters currently selected, and contains real imported or calculated data."
      />

      <Callout tone="neutral" className="mb-4">
        Reports are management information produced from imported accounting data. They are not audited financial statements and have not
        been reviewed or certified by a chartered accountant. Every PDF and Excel export says so on its face.
      </Callout>

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {reports.map((r) => (
          <Card key={r.key} className={cx('flex flex-col', !r.ready && 'bg-navy-50/40')}>
            <div className="p-4 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-medium text-ink">{r.label}</h3>
                {!r.ready && <Badge tone="neutral">Not ready</Badge>}
              </div>
              <p className="text-xs text-ink-muted mt-1.5 leading-relaxed">{r.description}</p>
              {!r.ready && r.reason && <p className="text-2xs text-warning mt-2">{r.reason}</p>}
            </div>

            <div className="px-4 py-3 border-t border-line flex items-center gap-1.5">
              {r.formats.includes('pdf') && (
                <Button
                  size="sm"
                  disabled={!r.ready || !can('reports.export')}
                  loading={busy === `${r.key}-pdf`}
                  icon={<FileText className="w-3.5 h-3.5" />}
                  onClick={() => run(r.key, 'pdf')}
                >
                  PDF
                </Button>
              )}
              {r.formats.includes('xlsx') && (
                <Button
                  size="sm"
                  disabled={!r.ready || !can('reports.export')}
                  loading={busy === `${r.key}-xlsx`}
                  icon={<FileSpreadsheet className="w-3.5 h-3.5" />}
                  onClick={() => run(r.key, 'xlsx')}
                >
                  Excel
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      <Explainer
        className="mt-5"
        what="Produces PDF and Excel versions of every report, built from the same calculation service as the screens."
        why="A figure that changes between the screen and the export is worse than no export at all. These share one source."
        needs="The underlying data for each report. Reports that cannot yet be produced say what is missing instead of exporting an empty file."
        next="Set the company, year and period in the top bar first — the export inherits exactly what you have selected."
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

/* ================================================================ Alerts */

export function AlertsPage() {
  const { company, currency, can } = useApp();
  const navigate = useNavigate();
  const toasts = useToasts();

  const [data, setData] = useState<any>(null);
  const [thresholds, setThresholds] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('open');

  const load = async () => {
    if (!company) return;
    setLoading(true);
    try {
      const [a, t] = await Promise.all([
        api.get<any>('/alerts', { companyId: company.id, status: tab === 'resolved' ? 'resolved' : undefined }),
        can('alerts.view') ? api.get<any>('/alerts/thresholds', { companyId: company.id }) : Promise.resolve(null),
      ]);
      setData(a);
      setThresholds(t?.thresholds ?? null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [company, tab]);

  if (!company) return <SelectCompanyNotice />;
  if (loading && !data) return <LoadingPane />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="Alerts and Notifications"
        description="Exceptions found in the current data, recalculated whenever you open this page or complete an import."
        actions={
          data.unreadCount > 0 && (
            <Button
              size="sm"
              icon={<CheckCheck className="w-3.5 h-3.5" />}
              onClick={async () => {
                await api.post('/alerts/read-all', { companyId: company.id });
                void load();
              }}
            >
              Mark all read
            </Button>
          )
        }
      />

      <Callout tone="info" title="How alerts are delivered" className="mb-4">
        <ul className="space-y-1 mt-1">
          <li>
            <strong>In the app:</strong> {data.delivery.inApp.status}
          </li>
          <li>
            <strong>Background scheduler:</strong> {data.delivery.scheduler.status}
          </li>
          <li>
            <strong>Email summaries:</strong> {data.delivery.email.status}
          </li>
        </ul>
      </Callout>

      <Tabs
        tabs={[
          { key: 'open', label: 'Open', count: data.alerts.length },
          { key: 'resolved', label: 'Resolved' },
          { key: 'thresholds', label: 'Thresholds' },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab !== 'thresholds' && (
        <Card>
          {data.alerts.length === 0 ? (
            <EmptyState
              icon={<BellOff className="w-5 h-5" />}
              title={tab === 'resolved' ? 'Nothing resolved yet' : 'Nothing needs attention'}
              description={tab === 'resolved' ? 'Conditions that stop applying are resolved here rather than deleted.' : 'No configured threshold is breached in the current data.'}
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.alerts.map((a: any) => (
                <li key={a.id} className={cx('px-5 py-3.5 flex items-start gap-3', !a.isRead && 'bg-brand-50/20')}>
                  <span
                    className={cx(
                      'w-2 h-2 rounded-full shrink-0 mt-1.5',
                      a.severity === 'critical' ? 'bg-danger' : a.severity === 'warning' ? 'bg-warning' : 'bg-info',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-ink">{a.title}</p>
                      <Badge tone={a.severity === 'critical' ? 'danger' : a.severity === 'warning' ? 'warning' : 'info'}>{a.severity}</Badge>
                      {!a.isRead && <Badge tone="brand">New</Badge>}
                    </div>
                    <p className="text-xs text-ink-muted mt-1 leading-relaxed">{a.message}</p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="text-2xs text-ink-subtle">{formatRelative(a.createdAt)}</span>
                      {a.amount !== null && <span className="text-2xs tabular font-medium text-ink">{formatMoney(a.amount, currency)}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {a.link && (
                      <Button size="sm" variant="ghost" onClick={() => navigate(a.link)}>
                        View
                      </Button>
                    )}
                    {!a.isRead && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await api.post(`/alerts/${a.id}/read`, { companyId: company.id, isRead: true });
                          void load();
                        }}
                      >
                        Mark read
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'thresholds' && thresholds && (
        <ThresholdForm
          thresholds={thresholds}
          readOnly={!can('alerts.manage')}
          onSaved={() => {
            void load();
            toasts.success('Thresholds updated', 'Alerts have been recalculated.');
          }}
        />
      )}

      <Explainer
        className="mt-5"
        what="Watches your data for conditions worth knowing about: low cash, overdue balances, budget overruns, unmapped ledgers and stale data."
        why="The figures only help if someone notices when they move. These are the things that usually matter before anyone goes looking."
        needs="Imported data and, for the cash alerts, a minimum cash threshold set below."
        next="Set your thresholds so alerts reflect what actually matters to your business rather than generic defaults."
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

function ThresholdForm({ thresholds, readOnly, onSaved }: { thresholds: any; readOnly: boolean; onSaved: () => void }) {
  const { company, currency } = useApp();
  const [form, setForm] = useState({
    minCash: thresholds.minCashMinor !== null ? String(thresholds.minCashMinor / Math.pow(10, currency.scale)) : '',
    overdueReceivable: String(thresholds.overdueReceivableMinor / Math.pow(10, currency.scale)),
    budgetOverrunPercent: String(thresholds.budgetOverrunPercent),
    staleDataDays: String(thresholds.staleDataDays),
  });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!company) return;
    setBusy(true);
    try {
      await api.put('/alerts/thresholds', {
        companyId: company.id,
        minCashMinor: form.minCash === '' ? null : Math.round(Number(form.minCash) * Math.pow(10, currency.scale)),
        overdueReceivableMinor: Math.round(Number(form.overdueReceivable) * Math.pow(10, currency.scale)),
        budgetOverrunPercent: Number(form.budgetOverrunPercent),
        staleDataDays: Number(form.staleDataDays),
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Alert thresholds" description="These decide when an alert is raised. They apply to the selected company only." />
      <div className="p-5 grid sm:grid-cols-2 gap-4">
        <Field label="Minimum cash balance" hint="Leave blank to disable the low-cash and shortfall alerts.">
          <Input
            type="number"
            step="0.01"
            disabled={readOnly}
            value={form.minCash}
            onChange={(e) => setForm({ ...form, minCash: e.target.value })}
            placeholder="No minimum set"
          />
        </Field>
        <Field label="Overdue receivables alert above" hint="Total overdue amount that triggers an alert.">
          <Input
            type="number"
            step="0.01"
            disabled={readOnly}
            value={form.overdueReceivable}
            onChange={(e) => setForm({ ...form, overdueReceivable: e.target.value })}
          />
        </Field>
        <Field label="Budget overrun at (%)" hint="100% means alert as soon as a budget is fully consumed.">
          <Input
            type="number"
            min="1"
            max="500"
            disabled={readOnly}
            value={form.budgetOverrunPercent}
            onChange={(e) => setForm({ ...form, budgetOverrunPercent: e.target.value })}
          />
        </Field>
        <Field label="Warn when data is older than (days)">
          <Input
            type="number"
            min="1"
            max="365"
            disabled={readOnly}
            value={form.staleDataDays}
            onChange={(e) => setForm({ ...form, staleDataDays: e.target.value })}
          />
        </Field>
      </div>
      {!readOnly && (
        <div className="px-5 py-3.5 border-t border-line flex justify-end">
          <Button variant="primary" loading={busy} onClick={submit}>
            Save thresholds
          </Button>
        </div>
      )}
    </Card>
  );
}

/* ======================================================== Reconciliation */

export function ReconciliationPage() {
  const { company, financialYear, currency, can } = useApp();
  const toasts = useToasts();
  const fileRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [asOfDate, setAsOfDate] = useState(todayIso());

  const load = async () => {
    if (!company) return;
    try {
      const [s, h] = await Promise.all([
        api.get<any>('/reconciliation/status', { companyId: company.id }),
        api.get<any>('/reconciliation', { companyId: company.id }),
      ]);
      setStatus(s);
      setHistory(h.reconciliations);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [company]);

  useEffect(() => {
    if (financialYear) setAsOfDate(financialYear.endDate);
  }, [financialYear]);

  const run = async (file: File) => {
    if (!company) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('companyId', company.id);
      form.append('asOfDate', asOfDate);
      if (financialYear) form.append('financialYearId', financialYear.id);

      const res = await api.post<any>('/reconciliation/run', form);
      setResult(res);
      await load();
      toasts.success('Reconciliation complete', res.interpretation);
    } catch (err) {
      toasts.error('Reconciliation failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <LoadingPane />;

  return (
    <>
      <PageHeader
        title="Data Reconciliation"
        description="Compares the balances DHYEYA calculated against an independent reference — usually a trial balance straight from your accounting system."
      />

      <Card className="mb-4">
        <div className="p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ShieldCheck
                className={cx(
                  'w-4 h-4',
                  status?.status === 'matched' ? 'text-positive' : status?.status === 'mismatched' ? 'text-warning' : 'text-ink-muted',
                )}
              />
              <p className="text-sm font-semibold text-ink">{status?.message}</p>
            </div>
            <p className="text-xs text-ink-muted mt-1 leading-relaxed max-w-2xl">
              {status?.detail ??
                (status?.latest
                  ? `Last run against ${status.latest.referenceFileName} as at ${formatDate(status.latest.asOfDate)}, ${formatRelative(status.latest.createdAt)}.`
                  : '')}
            </p>
          </div>

          {can('reconciliation.manage') && (
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
                className="h-9 px-3 text-sm bg-surface border border-line rounded-control"
                aria-label="Reference date"
              />
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void run(f);
                  e.target.value = '';
                }}
              />
              <Button variant="primary" loading={busy} icon={<Upload className="w-3.5 h-3.5" />} onClick={() => fileRef.current?.click()}>
                Upload reference report
              </Button>
            </div>
          )}
        </div>
      </Card>

      {result && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
            <Tile label="Compared" value={formatNumber(result.summary.totalCompared)} />
            <Tile label="Matched" value={formatNumber(result.summary.matched)} tone="positive" />
            <Tile label="Differ" value={formatNumber(result.summary.mismatched)} tone={result.summary.mismatched ? 'danger' : undefined} />
            <Tile label="Missing in import" value={formatNumber(result.summary.missingInImport)} tone={result.summary.missingInImport ? 'warning' : undefined} />
            <Tile label="Net difference" value={formatMoney(result.summary.netDifference, currency)} />
          </div>

          <Callout tone={result.status === 'matched' ? 'positive' : 'warning'} className="mb-4">
            {result.interpretation}
          </Callout>

          <Card className="mb-4">
            <CardHeader title="Ledger comparison" description="Largest differences first. Balances are compared on a debit-positive basis." />
            <div className="overflow-x-auto max-h-[460px]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left px-5 py-2.5 label-text">Ledger</th>
                    <th className="text-right px-4 py-2.5 label-text">Imported</th>
                    <th className="text-right px-4 py-2.5 label-text">Reference</th>
                    <th className="text-right px-4 py-2.5 label-text">Difference</th>
                    <th className="text-left px-4 py-2.5 label-text">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.lines.map((l: any, i: number) => (
                    <tr key={i} className={cx('border-b border-line/60', l.status === 'mismatch' && 'bg-warning-bg/30')}>
                      <td className="px-5 py-2.5 text-ink">{l.ledgerName}</td>
                      <td className="px-4 py-2.5 text-right tabular text-xs">{l.imported === null ? '—' : formatAmount(l.imported, currency)}</td>
                      <td className="px-4 py-2.5 text-right tabular text-xs">{l.reference === null ? '—' : formatAmount(l.reference, currency)}</td>
                      <td className={cx('px-4 py-2.5 text-right tabular text-xs font-medium', l.difference ? 'text-danger' : 'text-ink-subtle')}>
                        {l.difference === null ? '—' : formatAmount(l.difference, currency)}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge
                          tone={
                            l.status === 'match' ? 'positive' : l.status === 'mismatch' ? 'danger' : 'warning'
                          }
                        >
                          {String(l.status).replace(/_/g, ' ')}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {history.length > 0 && (
        <Card>
          <CardHeader
            title="Reconciliation history"
            actions={can('reports.export') && <ExportButtons reportKey="data_reconciliation" scope={{ companyId: company.id }} />}
          />
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left px-5 py-2.5 label-text">Run</th>
                <th className="text-left px-4 py-2.5 label-text">Reference file</th>
                <th className="text-left px-4 py-2.5 label-text">As at</th>
                <th className="text-right px-4 py-2.5 label-text">Matched</th>
                <th className="text-right px-4 py-2.5 label-text">Differ</th>
                <th className="text-left px-4 py-2.5 label-text">Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-b border-line/60">
                  <td className="px-5 py-2.5 text-xs text-ink-muted">{formatDateTime(h.createdAt)}</td>
                  <td className="px-4 py-2.5 text-xs text-ink truncate max-w-[220px]">{h.referenceFileName}</td>
                  <td className="px-4 py-2.5 text-xs tabular">{formatDate(h.asOfDate)}</td>
                  <td className="px-4 py-2.5 text-right tabular text-xs">{h.summary?.matched ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular text-xs">{h.summary?.mismatched ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={h.status === 'matched' ? 'positive' : 'warning'}>{h.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Explainer
        className="mt-5"
        what="Compares each ledger balance DHYEYA calculated with the same ledger in a reference report you supply."
        why="It is the only way to prove the imported data is complete. Without a reference, nothing has been reconciled — and this module says so rather than implying otherwise."
        needs="A trial balance or ledger-balance export with a ledger-name column and either a balance column or separate debit and credit columns."
        next="A ledger present in the reference but missing from the import usually means a category of records has not been imported yet."
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

/* =================================================================== CRM */

export function CrmPage() {
  const { company, currency, can } = useApp();
  const toasts = useToasts();
  const [status, setStatus] = useState<any>(null);
  const [customers, setCustomers] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!company) return;
    try {
      const [s, c] = await Promise.all([
        api.get<any>('/crm/status', { companyId: company.id }),
        api.get<any>('/crm/customers', { companyId: company.id, search: search || undefined, page, pageSize: 50 }),
      ]);
      setStatus(s);
      setCustomers(c);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 280 : 0);
    return () => clearTimeout(t);
  }, [company, search, page]);

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <LoadingPane />;
  if (!status) return null;

  return (
    <>
      <PageHeader title="CRM Integration" description="Customer records and how they connect to your accounting ledgers." />

      <Card className="mb-4">
        <div className="p-5">
          <div className="flex items-center gap-2 mb-2">
            <Link2 className="w-4 h-4 text-ink-muted" />
            <p className="text-sm font-semibold text-ink">Not connected</p>
            <Badge tone="neutral">No CRM adapter in this version</Badge>
          </div>
          <p className="text-xs text-ink-muted leading-relaxed max-w-3xl">{status.connection.status}</p>

          <div className="grid sm:grid-cols-2 gap-5 mt-4">
            <div>
              <p className="label-text mb-1.5">Available without a connection</p>
              <ul className="space-y-1 text-xs text-ink-muted list-disc list-inside">
                {status.connection.availableWithoutConnection.map((s: string, i: number) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="label-text mb-1.5">Needs a connected CRM</p>
              <ul className="space-y-1 text-xs text-ink-subtle list-disc list-inside">
                {status.connection.requiresConnection.map((s: string, i: number) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          </div>

          <Callout tone="info" className="mt-4">
            {status.connection.howToProceed}
          </Callout>
        </div>
      </Card>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Tile label="Customer records" value={formatNumber(status.customers.total)} />
        <Tile label="Linked to a ledger" value={formatNumber(status.customers.linkedToLedger)} tone="positive" />
        <Tile label="Not linked" value={formatNumber(status.customers.unlinked)} tone={status.customers.unlinked ? 'warning' : undefined} />
      </div>

      <Card>
        <CardHeader
          title="Customers"
          description="Outstanding balances come from your imported receivables, matched by ledger or name."
          actions={
            can('crm.manage') &&
            status.customers.unlinked > 0 && (
              <Button
                size="sm"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await api.post<any>('/crm/auto-link', { companyId: company.id });
                    toasts.success(`${res.linked} customer(s) linked`, res.note);
                    void load();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Link automatically
              </Button>
            )
          }
        />

        <div className="px-5 pt-4 pb-3">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search customer or GSTIN…"
            className="w-72"
          />
        </div>

        {!customers || customers.customers.length === 0 ? (
          <EmptyState
            icon={<Contact className="w-5 h-5" />}
            title="No customer records"
            description="Import the Customer / CRM Data category to populate this. It also scopes what Sales users can see."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left px-5 py-2.5 label-text">Customer</th>
                    <th className="text-left px-4 py-2.5 label-text">GSTIN</th>
                    <th className="text-left px-4 py-2.5 label-text">Owner</th>
                    <th className="text-left px-4 py-2.5 label-text">Ledger link</th>
                    <th className="text-right px-4 py-2.5 label-text">Outstanding</th>
                    <th className="text-right px-4 py-2.5 label-text">Open invoices</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.customers.map((c: any) => (
                    <tr key={c.id} className="border-b border-line/60 hover:bg-navy-50/40">
                      <td className="px-5 py-2.5 text-ink">{c.customerName}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted font-mono">{c.gstin ?? '—'}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{c.owner ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        {c.ledgerId ? (
                          <Badge tone="positive">Linked by {c.matchMethod}</Badge>
                        ) : (
                          <Tooltip content="No accounting ledger matched this customer by ledger name, GSTIN or name.">
                            <Badge tone="warning">Not linked</Badge>
                          </Tooltip>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular font-medium">{formatAmount(c.outstanding, currency)}</td>
                      <td className="px-4 py-2.5 text-right tabular text-xs text-ink-subtle">{c.openInvoices}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...customers.pagination} onPageChange={setPage} />
            <p className="px-5 py-2.5 text-2xs text-ink-subtle border-t border-line">{customers.note}</p>
          </>
        )}
      </Card>

      <Explainer
        className="mt-5"
        what="Holds customer records and links them to the accounting ledgers that carry their balances."
        why="Finance knows what a customer owes; sales knows who they are. The link is what lets a sales user see their own accounts without exposing the whole ledger."
        needs="Imported customer records. The Account Owner column is what scopes a Sales user's access."
        next="Link any unmatched customers, then import an Account Owner column to give your sales team their own view."
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'warning' | 'danger' }) {
  return (
    <Card className="p-4">
      <p className="label-text">{label}</p>
      <p
        className={cx(
          'text-lg font-semibold tabular mt-1',
          tone === 'positive' && 'text-positive',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
          !tone && 'text-ink',
        )}
      >
        {value}
      </p>
    </Card>
  );
}

export { Activity, Download, Select };
