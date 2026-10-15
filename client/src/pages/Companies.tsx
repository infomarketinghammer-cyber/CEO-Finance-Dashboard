import { useEffect, useState } from 'react';
import { Building2, CalendarPlus, Plus } from 'lucide-react';
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
  Textarea,
  ToastStack,
  useToasts,
} from '@/components/ui';
import { Explainer, PageHeader } from '@/components/financial';
import { formatDate, formatNumber, formatRelative } from '@/lib/format';

const ENTITY_TYPES: [string, string][] = [
  ['proprietorship', 'Proprietorship'],
  ['partnership', 'Partnership Firm'],
  ['llp', 'Limited Liability Partnership'],
  ['private_limited', 'Private Limited Company'],
  ['public_limited', 'Public Limited Company'],
  ['trust', 'Trust'],
  ['society', 'Society'],
  ['other', 'Other'],
];

interface CompanyRow {
  id: string;
  name: string;
  entityType: string;
  entityLabel: string;
  gstin: string | null;
  pan: string | null;
  currency: string;
  currencyScale: number;
  isDemo: boolean;
  financialYears: { id: string; label: string; startDate: string; endDate: string }[];
  lastImport: { at: string; fileName: string; category: string } | null;
}

export function CompaniesPage() {
  const { can, selectCompany, company: active, refreshCompanies } = useApp();
  const toasts = useToasts();

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [fyFor, setFyFor] = useState<CompanyRow | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get<{ companies: CompanyRow[] }>('/companies');
      setCompanies(res.companies);
    } catch (err) {
      toasts.error('Could not load companies', err instanceof ApiError ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <LoadingPane />;

  return (
    <>
      <PageHeader
        title="Companies and Financial Years"
        description="Each company keeps its own ledgers, mappings, imports, budgets and reports. Nothing is ever combined across companies."
        actions={
          can('companies.manage') && (
            <Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setCreateOpen(true)}>
              New company
            </Button>
          )
        }
      />

      {companies.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Building2 className="w-5 h-5" />}
            title="No companies yet"
            description="Create one to begin. You will need its name, entity type and reporting currency."
            action={
              can('companies.manage') ? (
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Create a company
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {companies.map((c) => (
            <Card key={c.id} className={c.id === active?.id ? 'border-brand-200' : undefined}>
              <div className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-sm font-semibold text-ink">{c.name}</h2>
                      {c.id === active?.id && <Badge tone="brand">Selected</Badge>}
                      {c.isDemo && <Badge tone="warning">Demo — synthetic data</Badge>}
                    </div>
                    <p className="text-xs text-ink-muted mt-1">
                      {c.entityLabel} · {c.currency}
                      {c.gstin && ` · GSTIN ${c.gstin}`}
                      {c.pan && ` · PAN ${c.pan}`}
                    </p>
                    <p className="text-2xs text-ink-subtle mt-1">
                      {c.lastImport
                        ? `Last import: ${c.lastImport.fileName} (${c.lastImport.category.replace(/_/g, ' ')}) ${formatRelative(c.lastImport.at)}`
                        : 'No data imported yet'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {c.id !== active?.id && (
                      <Button size="sm" onClick={() => selectCompany(c.id)}>
                        Select
                      </Button>
                    )}
                    {can('companies.manage') && (
                      <Button size="sm" icon={<CalendarPlus className="w-3.5 h-3.5" />} onClick={() => setFyFor(c)}>
                        Add financial year
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-4 pt-3.5 border-t border-line">
                  <p className="label-text mb-2">Financial years</p>
                  {c.financialYears.length === 0 ? (
                    <p className="text-xs text-warning">
                      None defined. A financial year is needed before opening balances and period reporting will work.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {c.financialYears.map((f) => (
                        <span key={f.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-navy-50 border border-line text-xs">
                          <span className="font-medium text-ink">{f.label}</span>
                          <span className="text-ink-subtle tabular">
                            {formatDate(f.startDate)} – {formatDate(f.endDate)}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Explainer
        className="mt-5"
        what="Holds each reporting entity and the financial years you report on."
        why="Mixing two companies' ledgers would produce statements that belong to neither. Separation here is what makes every other module trustworthy."
        needs="A company name, entity type and reporting currency. Entity type changes how the equity statement is presented."
        next="Add the financial year you are reporting on, then import that year's data."
      />

      <CreateCompanyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async () => {
          setCreateOpen(false);
          await load();
          await refreshCompanies();
          toasts.success('Company created');
        }}
      />

      <AddFinancialYearDialog
        company={fyFor}
        onClose={() => setFyFor(null)}
        onCreated={async () => {
          setFyFor(null);
          await load();
          toasts.success('Financial year added');
        }}
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

function CreateCompanyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: '',
    legalName: '',
    entityType: 'private_limited',
    gstin: '',
    pan: '',
    currency: 'INR',
    currencyScale: 2,
    country: 'India',
    address: '',
    isDemo: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.post('/companies', { ...form, gstin: form.gstin || undefined, pan: form.pan || undefined });
      setForm({ ...form, name: '', legalName: '', gstin: '', pan: '', address: '' });
      onCreated();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('The company could not be created.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a company"
      description="This becomes a separate reporting entity with its own data and mappings."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={form.name.trim().length < 2} onClick={submit}>
            Create company
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Company name" required error={fieldErrors.name}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme Industries Pvt Ltd" />
          </Field>

          <Field label="Legal name" hint="If it differs from the trading name.">
            <Input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
          </Field>

          <Field label="Entity type" required hint="Decides how the equity statement is presented.">
            <Select value={form.entityType} onChange={(e) => setForm({ ...form, entityType: e.target.value })}>
              {ENTITY_TYPES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Reporting currency" required>
            <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option value="INR">Indian Rupee (₹)</option>
              <option value="USD">US Dollar ($)</option>
              <option value="EUR">Euro (€)</option>
              <option value="GBP">Pound Sterling (£)</option>
              <option value="AED">UAE Dirham</option>
              <option value="SGD">Singapore Dollar</option>
            </Select>
          </Field>

          <Field label="GSTIN" error={fieldErrors.gstin} hint="15 characters. Used to match customer records to ledgers.">
            <Input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} placeholder="27AAAPA1234A1Z5" maxLength={15} />
          </Field>

          <Field label="PAN" error={fieldErrors.pan}>
            <Input value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })} placeholder="AAAPA1234A" maxLength={10} />
          </Field>
        </div>

        <Field label="Registered address">
          <Textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} rows={2} />
        </Field>

        <label className="flex items-start gap-3 cursor-pointer p-3 rounded-card border border-line">
          <input
            type="checkbox"
            checked={form.isDemo}
            onChange={(e) => setForm({ ...form, isDemo: e.target.checked })}
            className="mt-0.5 w-4 h-4 rounded border-line text-brand focus:ring-brand/30"
          />
          <span>
            <span className="block text-sm text-ink">This is a demo company with synthetic data</span>
            <span className="block text-xs text-ink-muted mt-0.5 leading-relaxed">
              Marked clearly throughout the application so demo figures are never mistaken for real financial records. Demo and production
              companies are entirely separate either way.
            </span>
          </span>
        </label>
      </div>
    </Dialog>
  );
}

function AddFinancialYearDialog({
  company,
  onClose,
  onCreated,
}: {
  company: CompanyRow | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [suggestions, setSuggestions] = useState<{ label: string; startDate: string; endDate: string; isCurrent: boolean }[]>([]);
  const [form, setForm] = useState({ label: '', startDate: '', endDate: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!company) return;
    setError(null);
    void (async () => {
      try {
        const res = await api.get<{ suggestions: typeof suggestions }>(`/companies/${company.id}/financial-years/suggestions`, {
          companyId: company.id,
        });
        setSuggestions(res.suggestions);
        const current = res.suggestions.find((s) => s.isCurrent) ?? res.suggestions[0];
        if (current) setForm({ label: current.label, startDate: current.startDate, endDate: current.endDate });
      } catch {
        /* suggestions are a convenience, not a requirement */
      }
    })();
  }, [company]);

  const submit = async () => {
    if (!company) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/companies/${company.id}/financial-years`, { ...form, companyId: company.id });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The financial year could not be added.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(company)}
      onClose={onClose}
      title={`Add a financial year to ${company?.name ?? ''}`}
      description="April to March is the Indian default, but any period works."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.label || !form.startDate || !form.endDate} onClick={submit}>
            Add financial year
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}

        {suggestions.length > 0 && (
          <div>
            <p className="label-text mb-1.5">Suggested</p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s.startDate}
                  onClick={() => setForm({ label: s.label, startDate: s.startDate, endDate: s.endDate })}
                  className={`px-2.5 py-1.5 rounded-control border text-xs transition-colors ${
                    form.startDate === s.startDate ? 'border-brand bg-brand-50 text-brand-700' : 'border-line hover:bg-navy-50'
                  }`}
                >
                  {s.label}
                  {s.isCurrent && <span className="text-ink-subtle"> · current</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <Field label="Label" required hint="How it appears in the year selector.">
          <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="FY 2025-26" />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Start date" required>
            <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </Field>
          <Field label="End date" required>
            <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </Field>
        </div>

        <Callout tone="info">Financial years cannot overlap, so a transaction can only ever belong to one of them.</Callout>
      </div>
    </Dialog>
  );
}

export { formatNumber };
