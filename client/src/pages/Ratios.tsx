import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calculator, Info, Percent, Plus, Trash2, TriangleAlert, Wand2 } from 'lucide-react';
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
  Select,
  Tabs,
  Textarea,
  Tooltip,
} from '@/components/ui';
import { Explainer, PageHeader } from '@/components/financial';
import { cx, formatMoney, formatRatio } from '@/lib/format';
import { ExportButtons, SelectCompanyNotice } from './Statements';

interface RatioInput {
  label: string;
  value: number | null;
  unit: 'money' | 'number';
  source: string;
}

interface Ratio {
  key: string;
  label: string;
  group: 'liquidity' | 'profitability' | 'efficiency' | 'leverage';
  value: number | null;
  unit: 'times' | 'percent' | 'days';
  formula: string;
  inputs: RatioInput[];
  available: boolean;
  reason?: string;
  limitation?: string;
  explanation: string;
  isCustom?: boolean;
}

interface InputMeta {
  key: string;
  label: string;
  kind: 'money' | 'number';
  source: string;
  group: string;
}

interface InputCatalogue {
  groups: { group: string; inputs: InputMeta[] }[];
  values: Record<string, number | null>;
  unavailable: string[];
  syntax: string;
}

interface CustomDefinition {
  key: string;
  label: string;
  formula: string;
  unit: 'times' | 'percent' | 'days';
  explanation: string;
  group: 'liquidity' | 'profitability' | 'efficiency' | 'leverage';
}

const GROUPS = [
  { key: 'liquidity', label: 'Liquidity', blurb: 'Can short-term obligations be met?' },
  { key: 'profitability', label: 'Profitability', blurb: 'How much of each rupee of sales is kept?' },
  { key: 'efficiency', label: 'Efficiency', blurb: 'How quickly do working-capital items turn into cash?' },
  { key: 'leverage', label: 'Leverage', blurb: 'How much of the business is funded by debt?' },
] as const;

export function RatiosPage() {
  const { company, scopeQuery, currency, can } = useApp();
  const navigate = useNavigate();

  const [data, setData] = useState<{ ratios: Ratio[]; warnings: string[]; isEmpty: boolean; benchmarks: Record<string, number>; benchmarkNote: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<string>('all');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<CustomDefinition | null>(null);
  const [deleting, setDeleting] = useState<Ratio | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<any>('/finance/ratios', scopeQuery));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ratios could not be calculated.');
    } finally {
      setLoading(false);
    }
  }, [scopeQuery.financialYearId, scopeQuery.periodType, scopeQuery.from, scopeQuery.to]);

  useEffect(() => {
    if (!company) return;
    void load();
  }, [company, load]);

  const removeCustom = async () => {
    if (!deleting) return;
    try {
      await api.delete(`/finance/ratios/custom/${encodeURIComponent(deleting.key)}`);
      setDeleting(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That ratio could not be removed.');
      setDeleting(null);
    }
  };

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <LoadingPane label="Calculating ratios…" />;
  if (error) return <Callout tone="danger">{error}</Callout>;
  if (!data) return null;

  const customRatios = data.ratios.filter((r) => r.isCustom);
  const shown =
    group === 'all' ? data.ratios : group === 'custom' ? customRatios : data.ratios.filter((r) => r.group === group && !r.isCustom);
  const availableCount = data.ratios.filter((r) => r.available).length;

  const openBuilder = (ratio?: Ratio) => {
    setEditing(
      ratio
        ? {
            key: ratio.key,
            label: ratio.label,
            formula: ratio.formula,
            unit: ratio.unit,
            explanation: ratio.explanation,
            group: ratio.group,
          }
        : null,
    );
    setBuilderOpen(true);
  };

  return (
    <>
      <PageHeader
        title="Financial Ratios"
        description="Every ratio shows the formula it used, the figures that fed it, and where the imported data forces a compromise."
        actions={
          <div className="flex items-center gap-2">
            {can('settings.manage') && (
              <Button variant="secondary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => openBuilder()}>
                Build a ratio
              </Button>
            )}
            {can('reports.export') && <ExportButtons reportKey="financial_ratios" scope={scopeQuery} />}
          </div>
        }
      />

      {data.isEmpty ? (
        <Card>
          <EmptyState
            icon={<Percent className="w-5 h-5" />}
            title="Not enough data to calculate ratios"
            description="Ratios draw on both the Balance Sheet and the Profit & Loss. Import a chart of accounts, opening balances and vouchers, then confirm the mappings."
            action={can('imports.create') ? <Button variant="primary" onClick={() => navigate('/import')}>Import data</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          <Callout tone="neutral" className="mb-4">
            {availableCount} of {data.ratios.length} ratios can be calculated from the current data. The rest say why they cannot, rather
            than showing a misleading figure. No ratio here is described as good or bad — that depends on your industry and season, which
            this product cannot see.
          </Callout>

          {data.warnings.map((w, i) => (
            <Callout key={i} tone="warning" className="mb-4">
              {w}
            </Callout>
          ))}

          <Tabs
            tabs={[
              { key: 'all', label: 'All ratios', count: data.ratios.length },
              ...GROUPS.map((g) => ({
                key: g.key,
                label: g.label,
                count: data.ratios.filter((r) => r.group === g.key && !r.isCustom).length,
              })),
              ...(customRatios.length ? [{ key: 'custom', label: 'Custom', count: customRatios.length }] : []),
            ]}
            active={group}
            onChange={setGroup}
            className="mb-4"
          />

          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            {shown.map((r) => (
              <RatioCard
                key={r.key}
                ratio={r}
                currency={currency}
                benchmark={data.benchmarks[r.key]}
                onEdit={r.isCustom && can('settings.manage') ? () => openBuilder(r) : undefined}
                onDelete={r.isCustom && can('settings.manage') ? () => setDeleting(r) : undefined}
              />
            ))}
          </div>

          {group === 'custom' && customRatios.length === 0 && (
            <Card>
              <EmptyState
                icon={<Wand2 className="w-5 h-5" />}
                title="No custom ratios yet"
                description="Build a ratio from the financial inputs ArthSetu already calculates — useful when your board or lender tracks a measure that is not one of the standard ones."
                action={
                  can('settings.manage') ? (
                    <Button variant="primary" onClick={() => openBuilder()}>
                      Build a ratio
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          )}

          <Callout tone="neutral" className="mt-4">
            {data.benchmarkNote}
          </Callout>
        </>
      )}

      <Explainer
        className="mt-5"
        what="Calculates the standard liquidity, profitability, efficiency and leverage ratios from the same figures as your statements, and lets you define ratios of your own."
        why="Absolute amounts tell you the size of things; ratios tell you the shape, and make one period comparable with another."
        needs="A Balance Sheet and a Profit & Loss for the period. Opening balances matter: without them, averages fall back to closing figures."
        next="Open a ratio to see the exact inputs behind it. Where a limitation is noted, importing better data will sharpen the figure."
      />

      <RatioBuilder
        open={builderOpen}
        existing={editing}
        scope={scopeQuery}
        currency={currency}
        onClose={() => setBuilderOpen(false)}
        onSaved={async () => {
          setBuilderOpen(false);
          await load();
        }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={removeCustom}
        title="Remove this custom ratio?"
        message={`"${deleting?.label}" will no longer appear on this page or in the ratio export. The financial data behind it is not affected.`}
        confirmLabel="Remove ratio"
      />
    </>
  );
}

/* ------------------------------------------------------------- the builder */

const UNIT_HELP: Record<CustomDefinition['unit'], string> = {
  times: 'Shown as a multiple, for example 1.8×. Use for a plain ratio of one figure to another.',
  percent: 'Shown as a percentage. Multiply by 100 in the formula, for example netProfit / revenue * 100.',
  days: 'Shown as a number of days. Day-based measures usually multiply by periodDays.',
};

function RatioBuilder({
  open,
  existing,
  scope,
  currency,
  onClose,
  onSaved,
}: {
  open: boolean;
  existing: CustomDefinition | null;
  scope: Record<string, any>;
  currency: { currency: string; scale: number };
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [catalogue, setCatalogue] = useState<InputCatalogue | null>(null);
  const [label, setLabel] = useState('');
  const [formula, setFormula] = useState('');
  const [unit, setUnit] = useState<CustomDefinition['unit']>('times');
  const [groupKey, setGroupKey] = useState<CustomDefinition['group']>('profitability');
  const [explanation, setExplanation] = useState('');
  const [preview, setPreview] = useState<{ valid: boolean; error?: string; result?: Ratio } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset the form each time the dialog opens, so an edit never leaks into a create.
  useEffect(() => {
    if (!open) return;
    setLabel(existing?.label ?? '');
    setFormula(existing?.formula ?? '');
    setUnit(existing?.unit ?? 'times');
    setGroupKey(existing?.group ?? 'profitability');
    setExplanation(existing?.explanation ?? '');
    setPreview(null);
    setSaveError(null);

    void (async () => {
      try {
        setCatalogue(await api.get<InputCatalogue>('/finance/ratios/inputs', scope));
      } catch {
        setCatalogue(null);
      }
    })();
  }, [open, existing]);

  // Validate and price the formula as it is typed, debounced so each keystroke
  // does not hit the server.
  useEffect(() => {
    if (!open || !formula.trim() || !label.trim()) {
      setPreview(null);
      return;
    }
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await api.post<{ valid: boolean; error?: string; result?: Ratio }>(
            '/finance/ratios/custom/preview',
            { key: existing?.key, label: label.trim(), formula, unit, group: groupKey, explanation: explanation.trim() || undefined },
            scope,
          );
          setPreview(res);
        } catch (err) {
          setPreview({ valid: false, error: err instanceof ApiError ? err.message : 'That formula could not be checked.' });
        }
      })();
    }, 450);
    return () => clearTimeout(handle);
  }, [open, formula, label, unit, groupKey, explanation]);

  const insert = (key: string) => setFormula((f) => (f.trim() ? `${f.trimEnd()} ${key}` : key));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.put('/finance/ratios/custom', {
        key: existing?.key,
        label: label.trim(),
        formula: formula.trim(),
        unit,
        group: groupKey,
        explanation: explanation.trim() || undefined,
      });
      await onSaved();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'The ratio could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const canSave = Boolean(label.trim() && formula.trim() && preview?.valid && !saving);

  /**
   * A formula that scales by 100 but is labelled as a multiple (or the reverse)
   * is a live mistake the preview alone does not name. Warn, but never block —
   * there are legitimate formulas that do either.
   */
  const unitHint =
    /\*\s*100\b/.test(formula) && unit === 'times'
      ? 'This formula multiplies by 100, which usually means the result is a percentage. Consider showing it as a percentage.'
      : !/\*\s*100\b/.test(formula) && unit === 'percent'
        ? 'This is shown as a percentage but the formula does not multiply by 100, so the figure will read as a fraction of 1.'
        : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={existing ? `Edit "${existing.label}"` : 'Build a custom ratio'}
      description="Combine the financial inputs ArthSetu already calculates. The result sits alongside the standard ratios and uses exactly the same figures as your statements."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!canSave} loading={saving}>
            {existing ? 'Save changes' : 'Create ratio'}
          </Button>
        </>
      }
    >
      <div className="grid lg:grid-cols-[1fr_280px] gap-5">
        <div className="space-y-4 min-w-0">
          <Field label="Name" required hint="What this measure is called in your organisation.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Cash conversion" maxLength={120} />
          </Field>

          <Field
            label="Formula"
            required
            hint="Use the input names from the list, with + − × ÷ written as + - * / and brackets for grouping."
          >
            <Textarea
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              rows={3}
              className="font-mono text-xs"
              placeholder="(currentAssets - inventory) / currentLiabilities"
              invalid={preview ? !preview.valid : false}
            />
          </Field>

          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Shown as" hint={UNIT_HELP[unit]}>
              <Select value={unit} onChange={(e) => setUnit(e.target.value as CustomDefinition['unit'])}>
                <option value="times">A multiple (1.8×)</option>
                <option value="percent">A percentage (18.0%)</option>
                <option value="days">Days (18 days)</option>
              </Select>
            </Field>

            <Field label="Group it with" hint="Where the ratio appears among the standard tabs.">
              <Select value={groupKey} onChange={(e) => setGroupKey(e.target.value as CustomDefinition['group'])}>
                {GROUPS.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="What it means" hint="Shown under the figure, so whoever reads the ratio knows how to take it.">
            <Textarea
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              rows={2}
              maxLength={600}
              placeholder="Describe what a higher or lower figure indicates for this business."
            />
          </Field>

          {unitHint && preview?.valid && <Callout tone="warning">{unitHint}</Callout>}

          {/* Live result against the selected period. */}
          {preview && (
            <div
              className={cx(
                'rounded-input border px-4 py-3',
                preview.valid ? 'border-line bg-navy-50/50' : 'border-danger/40 bg-danger/5',
              )}
            >
              {preview.valid && preview.result ? (
                <>
                  <p className="label-text mb-1">Result for the selected period</p>
                  {preview.result.available ? (
                    <p className="text-xl font-semibold text-ink tabular">{formatRatio(preview.result.value, preview.result.unit)}</p>
                  ) : (
                    <>
                      <p className="text-base font-semibold text-ink-subtle">N/A</p>
                      <p className="text-2xs text-ink-muted mt-1 leading-relaxed">{preview.result.reason}</p>
                    </>
                  )}
                  {preview.result.inputs.length > 0 && (
                    <ul className="mt-2.5 space-y-1 border-t border-line pt-2.5">
                      {preview.result.inputs.map((inp, i) => (
                        <li key={i} className="flex items-center justify-between gap-3 text-2xs">
                          <span className="text-ink-muted">{inp.label}</span>
                          <span className="tabular text-ink shrink-0">
                            {inp.value === null
                              ? 'unavailable'
                              : inp.unit === 'money'
                                ? formatMoney(inp.value, currency)
                                : inp.value.toLocaleString('en-IN')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  <p className="label-text mb-1 text-danger">That formula cannot be used</p>
                  <p className="text-xs text-danger leading-relaxed">{preview.error}</p>
                </>
              )}
            </div>
          )}

          {saveError && <Callout tone="danger">{saveError}</Callout>}
        </div>

        {/* Input picker */}
        <div className="lg:border-l lg:border-line lg:pl-5 min-w-0">
          <p className="label-text mb-2">Available inputs</p>
          <p className="text-2xs text-ink-muted mb-3 leading-relaxed">
            Click one to add it to the formula. Inputs your imported data cannot supply yet are marked.
          </p>

          <div className="max-h-[420px] overflow-y-auto pr-1 space-y-3">
            {catalogue?.groups.map((g) => (
              <div key={g.group}>
                <p className="text-2xs font-semibold text-ink-subtle uppercase tracking-wide mb-1.5">{g.group}</p>
                <div className="flex flex-wrap gap-1">
                  {g.inputs.map((inp) => {
                    const missing = catalogue.unavailable.includes(inp.key);
                    return (
                      <Tooltip key={inp.key} content={`${inp.label} — ${inp.source}${missing ? ' (not available from your data yet)' : ''}`}>
                        <button
                          type="button"
                          onClick={() => insert(inp.key)}
                          className={cx(
                            'px-1.5 py-1 rounded border text-2xs font-mono transition-colors',
                            missing
                              ? 'border-line bg-navy-50/60 text-ink-subtle hover:border-warning/50'
                              : 'border-line bg-surface text-ink-muted hover:border-brand hover:text-brand',
                          )}
                        >
                          {inp.key}
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            ))}
            {!catalogue && <p className="text-xs text-ink-subtle">Loading the available inputs…</p>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function RatioCard({
  ratio,
  currency,
  benchmark,
  onEdit,
  onDelete,
}: {
  ratio: Ratio;
  currency: { currency: string; scale: number };
  benchmark?: number;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card className={cx('flex flex-col', !ratio.available && 'bg-navy-50/40')}>
      <div className="p-4 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{ratio.label}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <p className="text-2xs text-ink-subtle capitalize">{ratio.group}</p>
              {ratio.isCustom && <Badge tone="brand">Custom</Badge>}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {ratio.limitation && (
              <Tooltip content={ratio.limitation}>
                <TriangleAlert className="w-3.5 h-3.5 text-warning" />
              </Tooltip>
            )}
            {onEdit && (
              <Tooltip content="Edit this ratio">
                <button onClick={onEdit} className="p-1 -m-0.5 text-ink-subtle hover:text-brand transition-colors" aria-label="Edit ratio">
                  <Wand2 className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            )}
            {onDelete && (
              <Tooltip content="Remove this ratio">
                <button
                  onClick={onDelete}
                  className="p-1 -m-0.5 text-ink-subtle hover:text-danger transition-colors"
                  aria-label="Remove ratio"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="mt-3">
          {ratio.available ? (
            <p className="text-2xl font-semibold text-ink tabular">{formatRatio(ratio.value, ratio.unit)}</p>
          ) : (
            <>
              <p className="text-xl font-semibold text-ink-subtle">N/A</p>
              <p className="text-2xs text-ink-muted mt-1 leading-relaxed">{ratio.reason}</p>
            </>
          )}
          {benchmark !== undefined && ratio.available && (
            <p className="text-2xs text-ink-subtle mt-1">
              Your configured benchmark: {formatRatio(benchmark, ratio.unit)}
            </p>
          )}
        </div>

        <p className="text-xs text-ink-muted mt-3 leading-relaxed">{ratio.explanation}</p>
      </div>

      <button
        onClick={() => setOpen((v) => !v)}
        className="px-4 py-2.5 border-t border-line text-left hover:bg-navy-50/60 transition-colors"
        aria-expanded={open}
      >
        <span className="text-2xs font-medium text-brand inline-flex items-center gap-1.5">
          <Calculator className="w-3 h-3" />
          {open ? 'Hide the working' : 'Show the working'}
        </span>
      </button>

      {open && (
        <div className="px-4 py-3 border-t border-line bg-navy-50/40 space-y-2.5 animate-fade-in">
          <div>
            <p className="label-text mb-1">Formula</p>
            <p className="text-xs text-ink font-mono leading-relaxed">{ratio.formula}</p>
          </div>

          <div>
            <p className="label-text mb-1">Inputs</p>
            <ul className="space-y-1.5">
              {ratio.inputs.map((inp, i) => (
                <li key={i} className="text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink-muted">{inp.label}</span>
                    <span className="tabular font-medium text-ink shrink-0">
                      {inp.value === null
                        ? '—'
                        : inp.unit === 'money'
                          ? formatMoney(inp.value, currency)
                          : inp.value.toLocaleString('en-IN')}
                    </span>
                  </div>
                  <p className="text-2xs text-ink-subtle mt-0.5">{inp.source}</p>
                </li>
              ))}
            </ul>
          </div>

          {ratio.limitation && (
            <div>
              <p className="label-text mb-1 text-warning">Limitation</p>
              <p className="text-2xs text-warning leading-relaxed">{ratio.limitation}</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export { Badge, Info };
