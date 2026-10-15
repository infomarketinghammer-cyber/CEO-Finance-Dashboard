import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarX2, Search, Users } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/state/AppContext';
import { Badge, Button, Callout, Card, CardHeader, EmptyState, Input, LoadingPane, Pagination, Select, Tooltip } from '@/components/ui';
import { Explainer, PageHeader } from '@/components/financial';
import { AgeingChart, ChartCard, ComparisonBars } from '@/components/charts';
import { cx, formatAmount, formatDate, formatMoney, formatNumber, todayIso } from '@/lib/format';
import { ExportButtons, SelectCompanyNotice } from './Statements';

interface Doc {
  id: string;
  partyName: string;
  documentNumber: string | null;
  documentDate: string | null;
  dueDate: string | null;
  amount: number;
  paid: number | null;
  outstanding: number;
  overdueDays: number | null;
  bucketKey: string;
  bucketLabel: string;
  status: 'not_due' | 'overdue' | 'unknown_due_date' | 'settled';
  costCentre: string | null;
  reference: string | null;
}

interface Summary {
  buckets: { key: string; label: string; total: number; count: number }[];
  total: number;
  totalCount: number;
  overdueTotal: number;
  overdueCount: number;
  missingDueDateTotal: number;
  missingDueDateCount: number;
  topParties: { partyName: string; outstanding: number; overdue: number; count: number }[];
  warnings: string[];
}

export function OutstandingPage({ table }: { table: 'receivables' | 'payables' }) {
  const { company, currency, can } = useApp();
  const [params, setParams] = useSearchParams();

  const [docs, setDocs] = useState<Doc[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [bucket, setBucket] = useState(params.get('bucket') ?? '');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<'overdueDays' | 'outstanding' | 'party' | 'dueDate'>('overdueDays');
  const [asOfDate, setAsOfDate] = useState(todayIso());

  const isAr = table === 'receivables';
  const partyLabel = isAr ? 'Customer' : 'Supplier';
  const docLabel = isAr ? 'Invoice' : 'Bill';

  useEffect(() => {
    if (!company) return;
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await api.get<{ documents: Doc[]; total: number; summary: Summary }>(`/finance/${table}`, {
            companyId: company.id,
            asOfDate,
            search: search || undefined,
            bucket: bucket || undefined,
            page,
            pageSize: 50,
            sortBy,
            sortDir: 'desc',
          });
          setDocs(res.documents);
          setSummary(res.summary);
          setTotal(res.total);
          setError(null);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'This could not be loaded.');
        } finally {
          setLoading(false);
        }
      })();
    }, search ? 280 : 0);

    return () => clearTimeout(timer);
  }, [company, table, search, bucket, page, sortBy, asOfDate]);

  if (!company) return <SelectCompanyNotice />;
  if (loading && !summary) return <LoadingPane />;
  if (error) return <Callout tone="danger">{error}</Callout>;

  const empty = summary?.totalCount === 0 && !search && !bucket;

  return (
    <>
      <PageHeader
        title={isAr ? 'Receivables' : 'Payables'}
        description={
          isAr
            ? 'Outstanding customer invoices, aged against their due dates.'
            : 'Outstanding supplier bills, aged against their due dates.'
        }
        actions={
          <>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="h-9 px-3 text-sm bg-surface border border-line rounded-control text-ink focus:border-brand"
              aria-label="Age as at"
            />
            {can('reports.export') && (
              <ExportButtons reportKey={isAr ? 'receivables_ageing' : 'payables_ageing'} scope={{ companyId: company.id, asOfDate }} />
            )}
          </>
        }
      />

      {empty ? (
        <Card>
          <EmptyState
            icon={<Users className="w-5 h-5" />}
            title={`No outstanding ${isAr ? 'invoices' : 'bills'} imported`}
            description={`Import the ${isAr ? 'Receivables' : 'Payables'} category from the Excel Import Center to see ageing, overdue totals and the cash-flow effect.`}
          />
        </Card>
      ) : (
        <>
          {summary && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <Tile label="Total outstanding" value={formatMoney(summary.total, currency)} sub={`${formatNumber(summary.totalCount)} open`} />
                <Tile
                  label="Overdue"
                  value={formatMoney(summary.overdueTotal, currency)}
                  sub={`${formatNumber(summary.overdueCount)} past due`}
                  tone={summary.overdueTotal > 0 ? 'danger' : undefined}
                />
                <Tile
                  label="No due date supplied"
                  value={formatMoney(summary.missingDueDateTotal, currency)}
                  sub={`${formatNumber(summary.missingDueDateCount)} document(s)`}
                  tone={summary.missingDueDateCount > 0 ? 'warning' : undefined}
                />
                <Tile
                  label="Not yet due"
                  value={formatMoney(summary.buckets.find((b) => b.key === 'not_due')?.total ?? 0, currency)}
                  sub={`${formatNumber(summary.buckets.find((b) => b.key === 'not_due')?.count ?? 0)} document(s)`}
                  tone="positive"
                />
              </div>

              {summary.warnings.map((w, i) => (
                <Callout key={i} tone="warning" className="mb-4">
                  {w}
                </Callout>
              ))}

              <div className="grid lg:grid-cols-2 gap-4 mb-4">
                <ChartCard title="Ageing" description="Click a bar to filter the list below">
                  <AgeingChart buckets={summary.buckets} currency={currency} onBucketClick={(k) => { setBucket(k); setPage(1); }} />
                </ChartCard>

                <Card>
                  <CardHeader title={`Largest ${partyLabel.toLowerCase()} balances`} description="By total outstanding" />
                  <div className="p-5">
                    {summary.topParties.length === 0 ? (
                      <p className="text-xs text-ink-muted">Nothing outstanding.</p>
                    ) : (
                      <ComparisonBars
                        items={summary.topParties.slice(0, 7).map((p) => ({ label: p.partyName, value: p.outstanding }))}
                        currency={currency}
                      />
                    )}
                  </div>
                </Card>
              </div>
            </>
          )}

          <Card>
            <div className="px-5 pt-4 pb-3 flex flex-wrap items-center gap-2.5">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder={`Search ${partyLabel.toLowerCase()} or ${docLabel.toLowerCase()} number…`}
                  className="pl-9"
                />
              </div>

              <Select
                value={bucket}
                onChange={(e) => {
                  setBucket(e.target.value);
                  setPage(1);
                  setParams(e.target.value ? { bucket: e.target.value } : {});
                }}
                className="w-52"
              >
                <option value="">All ageing buckets</option>
                {summary?.buckets.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label} ({b.count})
                  </option>
                ))}
              </Select>

              <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className="w-44">
                <option value="overdueDays">Most overdue first</option>
                <option value="outstanding">Largest amount first</option>
                <option value="party">{partyLabel} name</option>
                <option value="dueDate">Due date</option>
              </Select>
            </div>

            {docs.length === 0 ? (
              <EmptyState title="Nothing matches those filters" description="Clear the search or bucket filter to see everything." />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line">
                        <th className="text-left px-5 py-2.5 label-text">{partyLabel}</th>
                        <th className="text-left px-4 py-2.5 label-text">{docLabel}</th>
                        <th className="text-left px-4 py-2.5 label-text">Date</th>
                        <th className="text-left px-4 py-2.5 label-text">Due</th>
                        <th className="text-right px-4 py-2.5 label-text">Amount</th>
                        <th className="text-right px-4 py-2.5 label-text">{isAr ? 'Received' : 'Paid'}</th>
                        <th className="text-right px-4 py-2.5 label-text">Outstanding</th>
                        <th className="text-right px-4 py-2.5 label-text">Overdue</th>
                        <th className="text-left px-4 py-2.5 label-text">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {docs.map((d) => (
                        <tr key={d.id} className="border-b border-line/60 hover:bg-navy-50/40">
                          <td className="px-5 py-2.5 text-ink max-w-[200px] truncate">{d.partyName}</td>
                          <td className="px-4 py-2.5 text-xs text-ink-muted">{d.documentNumber ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-ink-muted whitespace-nowrap">{formatDate(d.documentDate)}</td>
                          <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                            {d.dueDate ? (
                              <span className="text-ink-muted">{formatDate(d.dueDate)}</span>
                            ) : (
                              <Tooltip content="The imported data supplied no due date. DHYEYA never infers one.">
                                <span className="text-warning">Not supplied</span>
                              </Tooltip>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular text-xs">{formatAmount(d.amount, currency)}</td>
                          <td className="px-4 py-2.5 text-right tabular text-xs text-ink-muted">
                            {d.paid === null ? '—' : formatAmount(d.paid, currency)}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular font-medium">{formatAmount(d.outstanding, currency)}</td>
                          <td className={cx('px-4 py-2.5 text-right tabular text-xs', (d.overdueDays ?? 0) > 0 ? 'text-danger' : 'text-ink-subtle')}>
                            {d.overdueDays !== null && d.overdueDays > 0 ? `${d.overdueDays}d` : '—'}
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge
                              tone={
                                d.status === 'overdue'
                                  ? 'danger'
                                  : d.status === 'not_due'
                                    ? 'positive'
                                    : d.status === 'settled'
                                      ? 'neutral'
                                      : 'warning'
                              }
                            >
                              {d.bucketLabel}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} pageSize={50} total={total} onPageChange={setPage} />
              </>
            )}
          </Card>
        </>
      )}

      <Explainer
        className="mt-5"
        what={`Lists every unpaid ${isAr ? 'customer invoice' : 'supplier bill'} and groups them by how overdue they are.`}
        why={
          isAr
            ? 'Overdue receivables are cash you have earned but not collected, and the single biggest driver of a cash squeeze.'
            : 'Knowing what falls due when is what makes a cash forecast meaningful rather than a guess.'
        }
        needs={`The ${isAr ? 'Receivables' : 'Payables'} import category. Due dates are optional, but documents without one cannot be aged or forecast.`}
        next="Filter by an ageing bucket to work the oldest balances first, or export the ageing for a collections meeting."
      />
    </>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'positive' | 'warning' | 'danger' }) {
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
      {sub && <p className="text-2xs text-ink-subtle mt-0.5">{sub}</p>}
    </Card>
  );
}

/* --------------------------------------------------- sales-scoped variant */

export function MyCustomersPage() {
  const { company, currency } = useApp();
  const [data, setData] = useState<{ documents: Doc[]; summary: Summary; scopeNote: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        setData(await api.get<any>('/finance/my-customers/receivables', { companyId: company.id, pageSize: 200 }));
      } finally {
        setLoading(false);
      }
    })();
  }, [company]);

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <LoadingPane />;
  if (!data) return null;

  return (
    <>
      <PageHeader title="My Customers" description="Outstanding and payment status for the accounts assigned to you." />

      <Callout tone="info" className="mb-4">
        {data.scopeNote}
      </Callout>

      {data.documents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users className="w-5 h-5" />}
            title="No customers are assigned to you yet"
            description="Customer ownership comes from the Account Owner column in the imported customer records. Ask your finance team to import or update it."
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
            <Tile label="Total outstanding" value={formatMoney(data.summary.total, currency)} sub={`${data.summary.totalCount} open`} />
            <Tile
              label="Overdue"
              value={formatMoney(data.summary.overdueTotal, currency)}
              sub={`${data.summary.overdueCount} past due`}
              tone={data.summary.overdueTotal > 0 ? 'danger' : undefined}
            />
            <Tile label="Customers" value={formatNumber(data.summary.topParties.length)} />
          </div>

          <Card>
            <CardHeader title="Your outstanding invoices" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left px-5 py-2.5 label-text">Customer</th>
                    <th className="text-left px-4 py-2.5 label-text">Invoice</th>
                    <th className="text-left px-4 py-2.5 label-text">Due</th>
                    <th className="text-right px-4 py-2.5 label-text">Outstanding</th>
                    <th className="text-left px-4 py-2.5 label-text">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.documents.map((d) => (
                    <tr key={d.id} className="border-b border-line/60">
                      <td className="px-5 py-2.5 text-ink">{d.partyName}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{d.documentNumber ?? '—'}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{d.dueDate ? formatDate(d.dueDate) : 'Not supplied'}</td>
                      <td className="px-4 py-2.5 text-right tabular">{formatAmount(d.outstanding, currency)}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={d.status === 'overdue' ? 'danger' : d.status === 'not_due' ? 'positive' : 'warning'}>{d.bucketLabel}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

export { Button };
