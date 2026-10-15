import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCheck, Lightbulb, ListChecks, RefreshCw, Search, Sparkles } from 'lucide-react';
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
  ToastStack,
  Tooltip,
  useToasts,
} from '@/components/ui';
import { Explainer, MappingStatusBadge, PageHeader } from '@/components/financial';
import { cx, formatAmount, formatMoney, formatNumber } from '@/lib/format';
import { SelectCompanyNotice } from './Statements';

interface LedgerRow {
  ledgerId: string;
  ledgerName: string;
  groupName: string | null;
  categoryKey: string | null;
  categoryLabel: string | null;
  status: 'confirmed' | 'suggested' | 'unmapped';
  confidence: number | null;
  reason: string | null;
  changedSinceLastImport: boolean;
  closingBalance: number;
  transactionCount: number;
  impact: string | null;
}

interface Category {
  id: string;
  key: string;
  label: string;
  statement: 'PL' | 'BS';
  section: string;
  normalSide: string;
  isSystem: boolean;
  isActive: boolean;
  description: string | null;
}

export function AccountMappingPage() {
  const { company, financialYear, currency, can } = useApp();
  const navigate = useNavigate();
  const toasts = useToasts();

  const [ledgers, setLedgers] = useState<LedgerRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [summary, setSummary] = useState({ total: 0, confirmed: 0, suggested: 0, unmapped: 0, unmappedNet: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('needs_review');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCategory, setBulkCategory] = useState('');
  const [newCategoryOpen, setNewCategoryOpen] = useState(false);

  const load = async () => {
    if (!company) return;
    setLoading(true);
    try {
      const [l, c] = await Promise.all([
        api.get<{ ledgers: LedgerRow[]; summary: typeof summary }>('/mapping/ledgers', {
          companyId: company.id,
          financialYearId: financialYear?.id,
        }),
        api.get<{ categories: Category[] }>('/mapping/categories', { companyId: company.id }),
      ]);
      setLedgers(l.ledgers);
      setSummary(l.summary);
      setCategories(c.categories.filter((x) => x.isActive));
    } catch (err) {
      toasts.error('Could not load mappings', err instanceof ApiError ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [company, financialYear]);

  const filtered = useMemo(() => {
    let rows = ledgers;
    if (tab === 'needs_review') rows = rows.filter((r) => r.status !== 'confirmed');
    else if (tab === 'unmapped') rows = rows.filter((r) => r.status === 'unmapped');
    else if (tab === 'confirmed') rows = rows.filter((r) => r.status === 'confirmed');

    const q = search.toLowerCase().trim();
    if (q) rows = rows.filter((r) => r.ledgerName.toLowerCase().includes(q) || (r.groupName ?? '').toLowerCase().includes(q));
    return rows;
  }, [ledgers, tab, search]);

  const assign = async (ledgerIds: string[], categoryKey: string | null, confirm = true) => {
    if (!company) return;
    setBusy(true);
    try {
      const res = await api.post<{ updated: number; impact: string }>('/mapping/assign', {
        companyId: company.id,
        ledgerIds,
        categoryKey,
        confirm,
      });
      toasts.success(`${res.updated} ledger(s) mapped`, res.impact);
      setSelected(new Set());
      setBulkOpen(false);
      await load();
    } catch (err) {
      toasts.error('Mapping failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const acceptSuggestions = async () => {
    if (!company) return;
    setBusy(true);
    try {
      const res = await api.post<{ confirmed: number; note: string }>('/mapping/accept-suggestions', {
        companyId: company.id,
        minConfidence: 0.8,
      });
      toasts.success(`${res.confirmed} suggestion(s) confirmed`, res.note);
      await load();
    } catch (err) {
      toasts.error('Could not accept suggestions', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const resuggest = async () => {
    if (!company) return;
    setBusy(true);
    try {
      const res = await api.post<{ suggested: number; remaining: number; note?: string }>('/mapping/resuggest', { companyId: company.id });
      toasts.info(`${res.suggested} new suggestion(s)`, res.note);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <LoadingPane label="Loading ledgers…" />;

  const readOnly = !can('mapping.manage');

  return (
    <>
      <PageHeader
        title="Account Mapping"
        description="Your ledger names are yours. This is where they are matched to the standard categories the statements are built from."
        actions={
          !readOnly && (
            <>
              <Button size="sm" icon={<RefreshCw className="w-3.5 h-3.5" />} loading={busy} onClick={resuggest}>
                Re-suggest unmapped
              </Button>
              {summary.suggested > 0 && (
                <Button size="sm" variant="primary" icon={<CheckCheck className="w-3.5 h-3.5" />} loading={busy} onClick={acceptSuggestions}>
                  Accept confident suggestions
                </Button>
              )}
            </>
          )
        }
      />

      {/* -------------------------------------------------------- summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <SummaryTile label="Total ledgers" value={formatNumber(summary.total)} />
        <SummaryTile label="Confirmed" value={formatNumber(summary.confirmed)} tone="positive" />
        <SummaryTile label="Unconfirmed suggestions" value={formatNumber(summary.suggested)} tone={summary.suggested ? 'warning' : undefined} />
        <SummaryTile label="No category" value={formatNumber(summary.unmapped)} tone={summary.unmapped ? 'danger' : undefined} />
      </div>

      {summary.unmapped > 0 && (
        <Callout tone="warning" title={`${summary.unmapped} ledger(s) are excluded from your statements`} className="mb-4">
          Their combined balance of {formatMoney(Math.abs(summary.unmappedNet), currency)} appears in neither the Profit & Loss nor the
          Balance Sheet, which is the usual reason a Balance Sheet does not balance. Uncertain accounts are deliberately left unmapped rather
          than filed under a guess.
        </Callout>
      )}

      {summary.suggested > 0 && (
        <Callout tone="info" title={`${summary.suggested} mapping(s) are suggestions, not decisions`} className="mb-4">
          Figures currently include them, and every statement says so. Approving them removes that caveat.
        </Callout>
      )}

      {/* --------------------------------------------------------- table */}
      <Card>
        <div className="px-5 pt-4 pb-3 flex flex-wrap items-center justify-between gap-3">
          <Tabs
            tabs={[
              { key: 'needs_review', label: 'Needs review', count: summary.suggested + summary.unmapped },
              { key: 'unmapped', label: 'No category', count: summary.unmapped },
              { key: 'confirmed', label: 'Confirmed', count: summary.confirmed },
              { key: 'all', label: 'All', count: summary.total },
            ]}
            active={tab}
            onChange={setTab}
            className="border-0"
          />
          <div className="relative">
            <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ledger or group…" className="pl-9 w-56" />
          </div>
        </div>

        {selected.size > 0 && !readOnly && (
          <div className="px-5 py-2.5 bg-brand-50 border-y border-brand-200 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-brand-700 font-medium">{selected.size} ledger(s) selected</p>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
              <Button size="sm" variant="primary" onClick={() => setBulkOpen(true)}>
                Map selected together
              </Button>
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="w-5 h-5" />}
            title={tab === 'needs_review' ? 'Every ledger has a confirmed category' : 'Nothing matches'}
            description={
              tab === 'needs_review'
                ? 'Your statements include every imported balance. Nothing is being left out.'
                : 'Adjust the filter or search term.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  {!readOnly && (
                    <th className="w-10 px-5 py-2.5">
                      <input
                        type="checkbox"
                        checked={filtered.length > 0 && filtered.every((r) => selected.has(r.ledgerId))}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(filtered.map((r) => r.ledgerId)) : new Set())
                        }
                        className="w-4 h-4 rounded border-line text-brand focus:ring-brand/30"
                        aria-label="Select all shown"
                      />
                    </th>
                  )}
                  <th className="text-left px-2 py-2.5 label-text">Ledger</th>
                  <th className="text-left px-4 py-2.5 label-text">Group in your books</th>
                  <th className="text-right px-4 py-2.5 label-text">Balance</th>
                  <th className="text-left px-4 py-2.5 label-text">Status</th>
                  <th className="text-left px-4 py-2.5 label-text min-w-[220px]">Financial category</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.ledgerId} className="border-b border-line/60 hover:bg-navy-50/40">
                    {!readOnly && (
                      <td className="px-5 py-2.5">
                        <input
                          type="checkbox"
                          checked={selected.has(row.ledgerId)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(row.ledgerId);
                            else next.delete(row.ledgerId);
                            setSelected(next);
                          }}
                          className="w-4 h-4 rounded border-line text-brand focus:ring-brand/30"
                          aria-label={`Select ${row.ledgerName}`}
                        />
                      </td>
                    )}
                    <td className="px-2 py-2.5">
                      <p className="text-ink">{row.ledgerName}</p>
                      {row.transactionCount > 0 && (
                        <p className="text-2xs text-ink-subtle">{formatNumber(row.transactionCount)} transaction(s)</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-muted">{row.groupName ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular text-xs">{formatAmount(row.closingBalance, currency)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <MappingStatusBadge status={row.status} />
                        {row.reason && (
                          <Tooltip content={row.reason}>
                            <Lightbulb className="w-3.5 h-3.5 text-ink-subtle" />
                          </Tooltip>
                        )}
                        {row.changedSinceLastImport && (
                          <Tooltip content="This mapping changed since the previous import.">
                            <Badge tone="info">changed</Badge>
                          </Tooltip>
                        )}
                      </div>
                      {row.confidence !== null && row.status === 'suggested' && (
                        <p className="text-2xs text-ink-subtle mt-0.5">{Math.round(row.confidence * 100)}% confidence</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {readOnly ? (
                        <span className="text-xs text-ink-muted">{row.categoryLabel ?? 'Not mapped'}</span>
                      ) : (
                        <Select
                          value={row.categoryKey ?? ''}
                          invalid={row.status === 'unmapped'}
                          onChange={(e) => assign([row.ledgerId], e.target.value || null, true)}
                        >
                          <option value="">— choose a category —</option>
                          <optgroup label="Profit & Loss">
                            {categories
                              .filter((c) => c.statement === 'PL')
                              .map((c) => (
                                <option key={c.key} value={c.key}>
                                  {c.label}
                                </option>
                              ))}
                          </optgroup>
                          <optgroup label="Balance Sheet">
                            {categories
                              .filter((c) => c.statement === 'BS')
                              .map((c) => (
                                <option key={c.key} value={c.key}>
                                  {c.label}
                                </option>
                              ))}
                          </optgroup>
                        </Select>
                      )}
                      {row.impact && row.status === 'confirmed' && <p className="text-2xs text-ink-subtle mt-1">{row.impact}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ----------------------------------------------------- categories */}
      <Card className="mt-4">
        <CardHeader
          title="Financial categories"
          description="The standard vocabulary your ledgers are mapped into. Add your own where the defaults do not fit."
          actions={
            can('mapping.manage') && (
              <Button size="sm" onClick={() => setNewCategoryOpen(true)}>
                Add a category
              </Button>
            )
          }
        />
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5 p-5">
          {categories.map((c) => {
            const count = ledgers.filter((l) => l.categoryKey === c.key).length;
            return (
              <div key={c.key} className="p-3 rounded-card border border-line">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-ink font-medium">{c.label}</p>
                  <Badge tone={c.statement === 'PL' ? 'brand' : 'info'}>{c.statement === 'PL' ? 'P&L' : 'BS'}</Badge>
                </div>
                {c.description && <p className="text-2xs text-ink-muted mt-1 leading-relaxed line-clamp-2">{c.description}</p>}
                <p className="text-2xs text-ink-subtle mt-1.5">
                  {count} ledger{count === 1 ? '' : 's'} · normally a {c.normalSide} balance
                  {!c.isSystem && ' · custom'}
                </p>
              </div>
            );
          })}
        </div>
      </Card>

      <Explainer
        className="mt-5"
        what="Matches each imported ledger to a standard financial category so the statements know where its balance belongs."
        why="Two companies calling the same thing different names is normal. Without this layer, a Profit & Loss cannot be produced from arbitrary ledger names."
        needs="An imported chart of accounts. Ledger groups from your accounting system make the suggestions far more accurate."
        next="Work through anything marked unconfirmed or without a category. Figures only become fully reliable once each one is settled."
      />

      {/* -------------------------------------------------------- dialogs */}
      <Dialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title={`Map ${selected.size} ledger(s) together`}
        description="Every selected ledger gets this category, confirmed."
        footer={
          <>
            <Button onClick={() => setBulkOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!bulkCategory} loading={busy} onClick={() => assign([...selected], bulkCategory, true)}>
              Map them
            </Button>
          </>
        }
      >
        <Field label="Financial category" required>
          <Select value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)}>
            <option value="">— choose —</option>
            <optgroup label="Profit & Loss">
              {categories.filter((c) => c.statement === 'PL').map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Balance Sheet">
              {categories.filter((c) => c.statement === 'BS').map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        <ul className="mt-3 max-h-40 overflow-y-auto text-xs text-ink-muted space-y-1">
          {[...selected].slice(0, 30).map((id) => (
            <li key={id}>· {ledgers.find((l) => l.ledgerId === id)?.ledgerName}</li>
          ))}
        </ul>
      </Dialog>

      <NewCategoryDialog
        open={newCategoryOpen}
        onClose={() => setNewCategoryOpen(false)}
        onCreated={() => {
          setNewCategoryOpen(false);
          void load();
          toasts.success('Category created');
        }}
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

function NewCategoryDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { company } = useApp();
  const [label, setLabel] = useState('');
  const [statement, setStatement] = useState<'PL' | 'BS'>('PL');
  const [section, setSection] = useState('operating_expenses');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const PL_SECTIONS = [
    ['revenue', 'Revenue'],
    ['cogs', 'Cost of Goods Sold'],
    ['direct_expenses', 'Direct Expenses'],
    ['operating_expenses', 'Operating Expenses'],
    ['depreciation', 'Depreciation & Amortisation'],
    ['finance_cost', 'Finance Costs'],
    ['other_income', 'Other Income'],
    ['other_expenses', 'Other Expenses'],
    ['tax', 'Tax Expense'],
  ];
  const BS_SECTIONS = [
    ['cash_and_bank', 'Cash and Bank'],
    ['trade_receivables', 'Trade Receivables'],
    ['inventory', 'Inventory'],
    ['current_assets', 'Other Current Assets'],
    ['non_current_assets', 'Non-current Assets'],
    ['trade_payables', 'Trade Payables'],
    ['current_liabilities', 'Other Current Liabilities'],
    ['non_current_liabilities', 'Non-current Liabilities'],
    ['loans_borrowings', 'Loans and Borrowings'],
    ['equity', 'Equity'],
  ];

  const sections = statement === 'PL' ? PL_SECTIONS : BS_SECTIONS;
  const normalSide =
    statement === 'PL'
      ? ['revenue', 'other_income'].includes(section)
        ? 'credit'
        : 'debit'
      : ['trade_payables', 'current_liabilities', 'non_current_liabilities', 'loans_borrowings', 'equity'].includes(section)
        ? 'credit'
        : 'debit';

  const submit = async () => {
    if (!company) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/mapping/categories', {
        companyId: company.id,
        key: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60),
        label,
        statement,
        section,
        normalSide,
      });
      setLabel('');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The category could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a financial category"
      description="A custom category behaves exactly like a built-in one. Its statement section decides where balances appear and how they are signed."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={label.trim().length < 2} loading={busy} onClick={submit}>
            Create category
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}

        <Field label="Name" required hint="How it appears on statements, for example “Research and Development”.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Research and Development" />
        </Field>

        <Field label="Which statement?" required>
          <Select
            value={statement}
            onChange={(e) => {
              const v = e.target.value as 'PL' | 'BS';
              setStatement(v);
              setSection(v === 'PL' ? 'operating_expenses' : 'current_assets');
            }}
          >
            <option value="PL">Profit &amp; Loss</option>
            <option value="BS">Balance Sheet</option>
          </Select>
        </Field>

        <Field label="Section" required hint="This decides where the total rolls up and whether a debit or credit balance is the normal one.">
          <Select value={section} onChange={(e) => setSection(e.target.value)}>
            {sections.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>

        <Callout tone="info">
          Balances here will be treated as normally carrying a <strong>{normalSide}</strong> balance, consistent with the section chosen.
        </Callout>
      </div>
    </Dialog>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'warning' | 'danger' }) {
  return (
    <Card className="p-4">
      <p className="label-text">{label}</p>
      <p
        className={cx(
          'text-xl font-semibold tabular mt-1',
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

export { ListChecks };
