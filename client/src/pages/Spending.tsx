import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarClock, Coins, Plus, Repeat, Search, Trash2, TrendingUp } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/state/AppContext';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  LoadingPane,
  Pagination,
  Select,
  Tabs,
  Textarea,
  ToastStack,
  Tooltip,
  useToasts,
} from '@/components/ui';
import { Explainer, PageHeader } from '@/components/financial';
import { BudgetVsActualChart, ChartCard, DonutChart, TrendChart } from '@/components/charts';
import { cx, formatAmount, formatDate, formatMoney, formatNumber, formatPercent, todayIso } from '@/lib/format';
import { ExportButtons, SelectCompanyNotice } from './Statements';

/* =============================================================== Expenses */

export function ExpensesPage() {
  const { company, scopeQuery, currency, can } = useApp();
  const toasts = useToasts();

  const [tab, setTab] = useState('expenses');
  const [data, setData] = useState<any>(null);
  const [recurring, setRecurring] = useState<any[]>([]);
  const [anomalies, setAnomalies] = useState<any>(null);
  const [upcoming, setUpcoming] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [deleteRecurring, setDeleteRecurring] = useState<any>(null);

  const load = async () => {
    if (!company) return;
    setLoading(true);
    try {
      const [e, r, a, u] = await Promise.all([
        api.get<any>('/expenses', { ...scopeQuery, page, pageSize: 50, search: search || undefined }),
        api.get<any>('/expenses/recurring', { companyId: company.id }),
        api.get<any>('/expenses/anomalies', scopeQuery),
        api.get<any>('/finance/upcoming-payments', { companyId: company.id, from: todayIso(), days: 60 }),
      ]);
      setData(e);
      setRecurring(r.recurring);
      setAnomalies(a);
      setUpcoming(u);
    } catch (err) {
      toasts.error('Could not load expenses', err instanceof ApiError ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 280 : 0);
    return () => clearTimeout(t);
  }, [company, scopeQuery.financialYearId, scopeQuery.periodType, page, search]);

  if (!company) return <SelectCompanyNotice />;
  if (loading && !data) return <LoadingPane />;

  return (
    <>
      <PageHeader
        title="Expense Management"
        description="Expenses, the schedule of recurring commitments, and anomalies worth a second look."
        actions={
          <>
            {can('reports.export') && <ExportButtons reportKey="expense_analysis" scope={scopeQuery} />}
            {can('expenses.manage') && (
              <Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setExpenseOpen(true)}>
                Record an expense
              </Button>
            )}
          </>
        }
      />

      <Tabs
        tabs={[
          { key: 'expenses', label: 'Expenses', count: data?.pagination?.total },
          { key: 'recurring', label: 'Recurring', count: recurring.length },
          { key: 'upcoming', label: 'Upcoming payments', count: upcoming?.items?.length },
          { key: 'anomalies', label: 'Anomalies', count: anomalies?.findings?.length },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {/* ------------------------------------------------------- expenses */}
      {tab === 'expenses' && data && (
        <>
          {data.pagination.total === 0 ? (
            <Card>
              <EmptyState
                icon={<Coins className="w-5 h-5" />}
                title="No expense records for this period"
                description="Import the Expense Records category, or record expenses here by hand. Expenses drive the budget variance and anomaly views."
              />
            </Card>
          ) : (
            <>
              <div className="grid lg:grid-cols-2 gap-4 mb-4">
                <ChartCard title="Expenses over time" description="Monthly total across the period">
                  <TrendChart
                    data={data.trend}
                    currency={currency}
                    type="bar"
                    series={[{ key: 'total', name: 'Expenses', color: '#0878F9' }]}
                  />
                </ChartCard>

                <ChartCard title="By category" description="Where the money went" empty={data.byCategory.length === 0}>
                  <DonutChart data={data.byCategory.map((c: any) => ({ label: c.category, value: c.total }))} currency={currency} />
                </ChartCard>
              </div>

              <Card>
                <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-sm">
                    <span className="text-ink-muted">Total for this period:</span>{' '}
                    <span className="font-semibold tabular text-ink">{formatMoney(data.total, currency)}</span>
                  </p>
                  <div className="relative">
                    <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
                    <Input
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setPage(1);
                      }}
                      placeholder="Search category, vendor or reference…"
                      className="pl-9 w-64"
                    />
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line">
                        <th className="text-left px-5 py-2.5 label-text">Date</th>
                        <th className="text-left px-4 py-2.5 label-text">Category</th>
                        <th className="text-left px-4 py-2.5 label-text">Vendor</th>
                        <th className="text-left px-4 py-2.5 label-text">Type</th>
                        <th className="text-left px-4 py-2.5 label-text">Reference</th>
                        <th className="text-right px-4 py-2.5 label-text">Amount</th>
                        <th className="text-left px-4 py-2.5 label-text">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.expenses.map((e: any) => (
                        <tr key={e.id} className="border-b border-line/60 hover:bg-navy-50/40">
                          <td className="px-5 py-2.5 text-xs text-ink-muted tabular whitespace-nowrap">{formatDate(e.expenseDate)}</td>
                          <td className="px-4 py-2.5 text-ink">{e.category ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-ink-muted">{e.vendor ?? '—'}</td>
                          <td className="px-4 py-2.5">
                            <Badge tone="neutral">{String(e.expenseType).replace(/_/g, ' ')}</Badge>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-ink-muted">{e.reference ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular font-medium">{formatAmount(e.amount, currency)}</td>
                          <td className="px-4 py-2.5">
                            <span className="text-2xs text-ink-subtle">{e.fromImport ? 'Imported' : 'Entered here'}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination {...data.pagination} onPageChange={setPage} />
              </Card>
            </>
          )}
        </>
      )}

      {/* ------------------------------------------------------ recurring */}
      {tab === 'recurring' && (
        <Card>
          <CardHeader
            title="Recurring expenses"
            description="Scheduled commitments such as rent, salaries, subscriptions and loan instalments. These feed the cash-flow forecast."
            actions={
              can('expenses.manage') && (
                <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setRecurringOpen(true)}>
                  Add
                </Button>
              )
            }
          />
          {recurring.length === 0 ? (
            <EmptyState
              icon={<Repeat className="w-5 h-5" />}
              title="No recurring expenses defined"
              description="Without these, the cash-flow forecast misses rent, salaries and other fixed outflows, which makes it optimistic."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left px-5 py-2.5 label-text">Name</th>
                    <th className="text-left px-4 py-2.5 label-text">Category</th>
                    <th className="text-left px-4 py-2.5 label-text">Vendor</th>
                    <th className="text-left px-4 py-2.5 label-text">Frequency</th>
                    <th className="text-left px-4 py-2.5 label-text">Next due</th>
                    <th className="text-right px-4 py-2.5 label-text">Amount</th>
                    <th className="text-left px-4 py-2.5 label-text">Status</th>
                    {can('expenses.manage') && <th className="px-4 py-2.5" />}
                  </tr>
                </thead>
                <tbody>
                  {recurring.map((r) => (
                    <tr key={r.id} className={cx('border-b border-line/60', !r.isActive && 'opacity-50')}>
                      <td className="px-5 py-2.5 text-ink">{r.name}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{r.category ?? '—'}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted">{r.vendor ?? '—'}</td>
                      <td className="px-4 py-2.5 text-xs capitalize">{String(r.frequency).replace(/_/g, '-')}</td>
                      <td className="px-4 py-2.5 text-xs tabular">{formatDate(r.nextDueDate)}</td>
                      <td className="px-4 py-2.5 text-right tabular font-medium">
                        {formatAmount(r.amount, currency)}
                        {r.isVariable && (
                          <Tooltip content="The amount varies between periods. The last known amount is used in the forecast.">
                            <span className="text-2xs text-warning ml-1">~</span>
                          </Tooltip>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={r.isActive ? 'positive' : 'neutral'}>{r.isActive ? 'Active' : 'Inactive'}</Badge>
                      </td>
                      {can('expenses.manage') && (
                        <td className="px-4 py-2.5 text-right">
                          <button onClick={() => setDeleteRecurring(r)} className="text-ink-subtle hover:text-danger transition-colors" aria-label="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ------------------------------------------------------- upcoming */}
      {tab === 'upcoming' && upcoming && (
        <Card>
          <CardHeader
            title="Upcoming payments"
            description={`Due in the next 60 days · ${formatMoney(upcoming.total, currency)} in total`}
            icon={<CalendarClock className="w-4 h-4" />}
          />
          <Callout tone="info" className="m-5 mb-0">
            {upcoming.note}
          </Callout>
          {upcoming.items.length === 0 ? (
            <EmptyState title="Nothing scheduled" description="No bills or recurring expenses fall due in this window." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left px-5 py-2.5 label-text">Due</th>
                  <th className="text-left px-4 py-2.5 label-text">Item</th>
                  <th className="text-left px-4 py-2.5 label-text">Type</th>
                  <th className="text-right px-4 py-2.5 label-text">Amount</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.items.map((i: any, idx: number) => (
                  <tr key={idx} className={cx('border-b border-line/60', i.overdue && 'bg-danger-bg/30')}>
                    <td className="px-5 py-2.5 text-xs tabular whitespace-nowrap">
                      {formatDate(i.date)}
                      {i.overdue && <Badge tone="danger" className="ml-1.5">overdue</Badge>}
                    </td>
                    <td className="px-4 py-2.5 text-ink">{i.label}</td>
                    <td className="px-4 py-2.5 text-xs text-ink-muted">{i.kind}</td>
                    <td className="px-4 py-2.5 text-right tabular font-medium">{formatAmount(i.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* ------------------------------------------------------ anomalies */}
      {tab === 'anomalies' && anomalies && (
        <>
          <Callout tone="neutral" className="mb-4">
            {anomalies.note}
          </Callout>
          {anomalies.historyNote && (
            <Callout tone="warning" className="mb-4">
              {anomalies.historyNote}
            </Callout>
          )}

          {anomalies.findings.length === 0 ? (
            <Card>
              <EmptyState icon={<AlertTriangle className="w-5 h-5" />} title="Nothing unusual found" description="No duplicates, spikes or missed recurring payments in this period." />
            </Card>
          ) : (
            <div className="space-y-2.5">
              {anomalies.findings.map((f: any, i: number) => (
                <Card key={i} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-ink">{f.title}</p>
                        <Badge tone={f.certainty === 'confirmed' ? 'danger' : 'warning'}>
                          {f.certainty === 'confirmed' ? 'Confirmed by the data' : 'Heuristic — worth a look'}
                        </Badge>
                      </div>
                      <p className="text-xs text-ink-muted mt-1 leading-relaxed">{f.detail}</p>
                    </div>
                    {f.amount !== null && (
                      <p className="text-sm font-semibold tabular text-ink shrink-0">{formatMoney(f.amount, currency)}</p>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <Explainer
        className="mt-5"
        what="Tracks what the business spends, what it is committed to spending, and what looks out of the ordinary."
        why="Expenses are the easiest place for money to leak quietly — a duplicate payment, a subscription nobody cancelled, a supplier whose price crept up."
        needs="Imported expense records, or entries made here. Recurring definitions make the forecast considerably more accurate."
        next="Define your recurring expenses first, then review anything the anomalies tab flags."
      />

      <ExpenseDialog
        open={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        onSaved={() => {
          setExpenseOpen(false);
          void load();
          toasts.success('Expense recorded');
        }}
      />

      <RecurringDialog
        open={recurringOpen}
        onClose={() => setRecurringOpen(false)}
        onSaved={() => {
          setRecurringOpen(false);
          void load();
          toasts.success('Recurring expense added');
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteRecurring)}
        onClose={() => setDeleteRecurring(null)}
        title="Delete this recurring expense?"
        message={`"${deleteRecurring?.name}" will stop appearing in the cash-flow forecast and the upcoming payments calendar. Expenses already recorded are not affected.`}
        confirmLabel="Delete"
        onConfirm={async () => {
          await api.delete(`/expenses/recurring/${deleteRecurring.id}`, { companyId: company.id });
          setDeleteRecurring(null);
          void load();
          toasts.success('Deleted');
        }}
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

function ExpenseDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { company, financialYear, currency } = useApp();
  const [form, setForm] = useState({ expenseDate: todayIso(), category: '', vendor: '', amount: '', expenseType: 'one_off', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!company) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/expenses', {
        companyId: company.id,
        financialYearId: financialYear?.id,
        ...form,
        amount: Math.round(Number(form.amount) * Math.pow(10, currency.scale)),
        vendor: form.vendor || null,
        reference: form.reference || null,
        notes: form.notes || null,
      });
      setForm({ ...form, category: '', vendor: '', amount: '', reference: '', notes: '' });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The expense could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Record an expense"
      description="For costs that are not in your imported data. Imported expenses cannot be edited here — correct the source file instead."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.category || !form.amount} onClick={submit}>
            Save expense
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Date" required>
            <Input type="date" value={form.expenseDate} onChange={(e) => setForm({ ...form, expenseDate: e.target.value })} />
          </Field>
          <Field label="Amount" required>
            <Input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="Category" required hint="Must match a budget category to count towards it.">
            <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Rent" />
          </Field>
          <Field label="Vendor">
            <Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
          </Field>
          <Field label="Type" required>
            <Select value={form.expenseType} onChange={(e) => setForm({ ...form, expenseType: e.target.value })}>
              <option value="fixed">Fixed</option>
              <option value="recurring_variable">Recurring, variable amount</option>
              <option value="one_off">One-off</option>
            </Select>
          </Field>
          <Field label="Reference">
            <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
        </Field>
      </div>
    </Dialog>
  );
}

function RecurringDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { company, currency } = useApp();
  const [form, setForm] = useState({
    name: '',
    category: '',
    vendor: '',
    amount: '',
    frequency: 'monthly',
    startDate: todayIso(),
    nextDueDate: todayIso(),
    isVariable: false,
    isActive: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!company) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/expenses/recurring', {
        companyId: company.id,
        ...form,
        amount: Math.round(Number(form.amount) * Math.pow(10, currency.scale)),
        category: form.category || null,
        vendor: form.vendor || null,
      });
      setForm({ ...form, name: '', category: '', vendor: '', amount: '' });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'It could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a recurring expense"
      description="Scheduled outflows feed the cash-flow forecast and the upcoming payments calendar."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.name || !form.amount} onClick={submit}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Name" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Office rent" />
          </Field>
          <Field label="Amount" required>
            <Input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="Category">
            <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </Field>
          <Field label="Vendor">
            <Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
          </Field>
          <Field label="Frequency" required>
            <Select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="half_yearly">Half-yearly</option>
              <option value="yearly">Yearly</option>
            </Select>
          </Field>
          <Field label="Next due date" required>
            <Input type="date" value={form.nextDueDate} onChange={(e) => setForm({ ...form, nextDueDate: e.target.value, startDate: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.isVariable}
            onChange={(e) => setForm({ ...form, isVariable: e.target.checked })}
            className="mt-0.5 w-4 h-4 rounded border-line text-brand focus:ring-brand/30"
          />
          <span>
            <span className="block text-sm text-ink">The amount varies between periods</span>
            <span className="block text-xs text-ink-muted mt-0.5">Electricity, for instance. The forecast uses the amount above and labels it as an estimate.</span>
          </span>
        </label>
      </div>
    </Dialog>
  );
}

/* ================================================================ Budgets */

export function BudgetsPage() {
  const { company, scopeQuery, financialYear, currency, can } = useApp();
  const navigate = useNavigate();
  const toasts = useToasts();

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [toDelete, setToDelete] = useState<any>(null);

  const load = async () => {
    if (!company) return;
    setLoading(true);
    try {
      setData(await api.get<any>('/expenses/budgets', scopeQuery));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [company, scopeQuery.financialYearId, scopeQuery.periodType]);

  if (!company) return <SelectCompanyNotice />;
  if (loading && !data) return <LoadingPane />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="Budget Management"
        description="Budgets by category and period, measured against what was actually spent."
        actions={
          <>
            {can('reports.export') && <ExportButtons reportKey="budget_variance" scope={scopeQuery} />}
            {can('budgets.manage') && (
              <Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setAddOpen(true)}>
                Add a budget
              </Button>
            )}
          </>
        }
      />

      {!data.summary.available ? (
        <Card>
          <EmptyState
            icon={<TrendingUp className="w-5 h-5" />}
            title="No budgets cover this period"
            description={data.note}
            action={can('budgets.manage') ? <Button variant="primary" onClick={() => setAddOpen(true)}>Add a budget</Button> : undefined}
            secondaryAction={can('imports.create') ? <Button onClick={() => navigate('/import')}>Import budgets</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <Card className="p-4">
              <p className="label-text">Budgeted</p>
              <p className="text-lg font-semibold tabular text-ink mt-1">{formatMoney(data.summary.totalBudgeted, currency)}</p>
            </Card>
            <Card className="p-4">
              <p className="label-text">Actual</p>
              <p className="text-lg font-semibold tabular text-ink mt-1">{formatMoney(data.summary.totalActual, currency)}</p>
            </Card>
            <Card className="p-4">
              <p className="label-text">Remaining</p>
              <p className={cx('text-lg font-semibold tabular mt-1', data.summary.remaining < 0 ? 'text-danger' : 'text-positive')}>
                {formatMoney(data.summary.remaining, currency)}
              </p>
            </Card>
            <Card className="p-4">
              <p className="label-text">Utilisation</p>
              <p
                className={cx(
                  'text-lg font-semibold tabular mt-1',
                  (data.summary.utilisationPercent ?? 0) > 100 ? 'text-danger' : 'text-ink',
                )}
              >
                {formatPercent(data.summary.utilisationPercent)}
              </p>
            </Card>
          </div>

          <ChartCard
            title="Budget against actual"
            description="By category for the selected period"
            className="mb-4"
            height={Math.max(220, data.budgets.length * 42 + 70)}
          >
            <BudgetVsActualChart data={data.budgets} currency={currency} />
          </ChartCard>

          <Card>
            <CardHeader title="Budget detail" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left px-5 py-2.5 label-text">Category</th>
                    <th className="text-left px-4 py-2.5 label-text">Period</th>
                    <th className="text-left px-4 py-2.5 label-text">Cost centre</th>
                    <th className="text-right px-4 py-2.5 label-text">Budgeted</th>
                    <th className="text-right px-4 py-2.5 label-text">Actual</th>
                    <th className="text-right px-4 py-2.5 label-text">Remaining</th>
                    <th className="text-right px-4 py-2.5 label-text">Used</th>
                    {can('budgets.manage') && <th className="px-4 py-2.5" />}
                  </tr>
                </thead>
                <tbody>
                  {data.budgets.map((b: any) => {
                    const over = (b.utilisationPercent ?? 0) > 100;
                    return (
                      <tr key={b.id} className="border-b border-line/60 hover:bg-navy-50/40">
                        <td className="px-5 py-2.5 text-ink">{b.category}</td>
                        <td className="px-4 py-2.5 text-xs text-ink-muted tabular whitespace-nowrap">
                          {formatDate(b.periodStart)} – {formatDate(b.periodEnd)}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-ink-muted">{b.costCentre ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right tabular">{formatAmount(b.budgeted, currency)}</td>
                        <td className="px-4 py-2.5 text-right tabular">{formatAmount(b.actual, currency)}</td>
                        <td className={cx('px-4 py-2.5 text-right tabular', b.remaining < 0 ? 'text-danger' : 'text-positive')}>
                          {formatAmount(b.remaining, currency)}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-14 h-1.5 bg-navy-50 rounded-full overflow-hidden">
                              <div
                                className={cx('h-full rounded-full', over ? 'bg-danger' : (b.utilisationPercent ?? 0) > 85 ? 'bg-warning' : 'bg-positive')}
                                style={{ width: `${Math.min(100, b.utilisationPercent ?? 0)}%` }}
                              />
                            </div>
                            <span className={cx('tabular text-xs', over && 'text-danger font-medium')}>
                              {formatPercent(b.utilisationPercent, { digits: 0 })}
                            </span>
                          </div>
                        </td>
                        {can('budgets.manage') && (
                          <td className="px-4 py-2.5 text-right">
                            <button onClick={() => setToDelete(b)} className="text-ink-subtle hover:text-danger transition-colors" aria-label="Delete">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <Explainer
        className="mt-5"
        what="Sets a spending limit per category and period, and measures actual expenses against it."
        why="A budget only earns its keep when the comparison is automatic — which is also what makes an overrun alert possible."
        needs="Budgets defined here or imported, plus expense records whose category names match the budget categories."
        next="Add budgets for your main expense categories, then watch the utilisation column as the period progresses."
      />

      <BudgetDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        defaultStart={financialYear?.startDate}
        defaultEnd={financialYear?.endDate}
        onSaved={() => {
          setAddOpen(false);
          void load();
          toasts.success('Budget added');
        }}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title="Delete this budget?"
        message={`The budget for "${toDelete?.category}" will be removed. Expenses already recorded against it are not affected.`}
        confirmLabel="Delete"
        onConfirm={async () => {
          await api.delete(`/expenses/budgets/${toDelete.id}`, { companyId: company.id });
          setToDelete(null);
          void load();
          toasts.success('Budget deleted');
        }}
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

function BudgetDialog({
  open,
  onClose,
  onSaved,
  defaultStart,
  defaultEnd,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  defaultStart?: string;
  defaultEnd?: string;
}) {
  const { company, financialYear, currency } = useApp();
  const [form, setForm] = useState({
    category: '',
    amount: '',
    periodType: 'year',
    periodStart: defaultStart ?? todayIso(),
    periodEnd: defaultEnd ?? todayIso(),
    costCentre: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (defaultStart && defaultEnd) setForm((f) => ({ ...f, periodStart: defaultStart, periodEnd: defaultEnd }));
  }, [defaultStart, defaultEnd]);

  const submit = async () => {
    if (!company) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/expenses/budgets', {
        companyId: company.id,
        financialYearId: financialYear?.id,
        ...form,
        amount: Math.round(Number(form.amount) * Math.pow(10, currency.scale)),
        costCentre: form.costCentre || null,
      });
      setForm({ ...form, category: '', amount: '', costCentre: '' });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The budget could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a budget"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.category || !form.amount} onClick={submit}>
            Add budget
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="Expense category" required hint="Must match the category used on your expense records, letter for letter.">
          <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Rent" />
        </Field>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Budget amount" required>
            <Input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="Period type" required>
            <Select value={form.periodType} onChange={(e) => setForm({ ...form, periodType: e.target.value })}>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
              <option value="custom">Custom</option>
            </Select>
          </Field>
          <Field label="From" required>
            <Input type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} />
          </Field>
          <Field label="To" required>
            <Input type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} />
          </Field>
        </div>
        <Field label="Cost centre" hint="Optional. Restricts the comparison to expenses tagged with this cost centre.">
          <Input value={form.costCentre} onChange={(e) => setForm({ ...form, costCentre: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

export { formatNumber };
