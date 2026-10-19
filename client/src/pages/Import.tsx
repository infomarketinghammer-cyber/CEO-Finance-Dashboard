import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Copy,
  Download,
  FileSpreadsheet,
  FileWarning,
  Info,
  RotateCcw,
  Table2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/state/AppContext';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  LoadingPane,
  Pagination,
  Select,
  Tabs,
  ToastStack,
  Tooltip,
  useToasts,
} from '@/components/ui';
import { Explainer, PageHeader } from '@/components/financial';
import { cx, formatDateTime, formatFileSize, formatNumber } from '@/lib/format';

/* --------------------------------------------------------------------- types */

interface ImportField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  enumValues: string[] | null;
  help: string | null;
}

interface ImportCategory {
  key: string;
  label: string;
  description: string;
  enables: string[];
  supportsPartialImport: boolean;
  supportsForwardFill: boolean;
  duplicateBasis: string;
  fields: ImportField[];
  anyOf: { label: string; keys: string[] }[];
}

interface SheetSummary {
  name: string;
  rowCount: number;
  columnCount: number;
  headerRowIndex: number;
  headers: string[];
  isEmpty: boolean;
}

interface ColumnProfile {
  header: string;
  index: number;
  nonEmptyCount: number;
  emptyCount: number;
  distinctCount: number;
  detectedType: string;
  dateFormat?: { order: string; ambiguous: boolean; samples: string[]; unparsedCount: number };
  numericFormat?: { hasThousandSeparators: boolean; hasCurrencySymbols: boolean; hasParenthesesNegatives: boolean; hasDrCrMarkers: boolean };
  samples: string[];
  unreadableSamples: string[];
}

interface Suggestion {
  fieldKey: string;
  header: string | null;
  confidence: number;
  reason: string;
  alternatives: { header: string; confidence: number; reason: string }[];
  warning?: string;
}

interface InspectResponse {
  batch: { id: string; category: string; categoryLabel: string; fileName: string; fileSize: number; status: string };
  sheets: SheetSummary[];
  sheet: {
    name: string;
    headerRowIndex: number;
    headers: string[];
    totalRows: number;
    blankRowsSkipped: number;
    duplicateRowCount: number;
    sampleRows: { rowNumber: number; values: Record<string, unknown> }[];
    columns: ColumnProfile[];
  };
  suggestions: Suggestion[];
  unrecognisedHeaders: string[];
  effectiveMapping: Record<string, string | null>;
  savedProfile: { id: string; name: string; useCount: number } | null;
  matchesSupportedTemplate: { matches: boolean; detail: string };
}

interface ValidationReport {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  warningRows: number;
  duplicateRowsInFile: number;
  duplicateRecordsInDatabase: number;
  blankRowsSkipped: number;
  missingRequired: { field: string; label: string; count: number }[];
  invalidDates: number;
  invalidAmounts: number;
  unmappedAccounts: string[];
  newLedgers: string[];
  imbalancedVouchers: { voucherNumber: string | null; date: string; imbalance: number; rowNumbers: number[] }[];
  dateRange: { from: string; to: string } | null;
  notes: string[];
}

interface ValidateResponse {
  report: ValidationReport;
  mappingWarnings: string[];
  canImportAll: boolean;
  canImportValidOnly: boolean;
  preview: { kind: 'vouchers' | 'rows'; items: any[]; totalItems: number };
  rejectedPreview: { rowNumber: number; errors: { message: string }[]; raw: Record<string, unknown> }[];
}

interface CommitResponse {
  result: {
    processed: number;
    accepted: number;
    inserted: number;
    updated: number;
    skipped: number;
    rejected: number;
    ledgersCreated: number;
    mappingsSuggested: number;
    changes: { type: string; label: string; detail?: string }[];
    changeCount: number;
  };
  nextSteps: string[];
}

type Step = 'category' | 'upload' | 'mapping' | 'validate' | 'done';

/* ---------------------------------------------------------------- component */

export function ImportPage() {
  const { company, financialYear, can, currency } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const toasts = useToasts();

  const [tab, setTab] = useState(params.get('tab') ?? 'wizard');
  const [categories, setCategories] = useState<ImportCategory[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(true);

  const [step, setStep] = useState<Step>('category');
  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const [inspect, setInspect] = useState<InspectResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [options, setOptions] = useState<Record<string, unknown>>({});
  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);
  const [duplicateStrategy, setDuplicateStrategy] = useState<'skip' | 'update' | 'review'>('skip');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [priorIdentical, setPriorIdentical] = useState<{ message: string; completedAt: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ categories: ImportCategory[] }>('/imports/categories');
        setCategories(res.categories);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Import categories could not be loaded.');
      } finally {
        setLoadingCategories(false);
      }
    })();
  }, []);

  const category = categories.find((c) => c.key === categoryKey) ?? null;

  const reset = () => {
    setStep('category');
    setCategoryKey(null);
    setInspect(null);
    setMapping({});
    setOptions({});
    setValidation(null);
    setCommitResult(null);
    setPriorIdentical(null);
    setError(null);
  };

  /* --------------------------------------------------------------- upload */

  const onFileChosen = useCallback(
    async (file: File) => {
      if (!company || !categoryKey) return;
      setBusy(true);
      setError(null);

      try {
        const form = new FormData();
        form.append('file', file);
        form.append('category', categoryKey);
        form.append('companyId', company.id);
        if (financialYear) form.append('financialYearId', financialYear.id);

        const res = await api.post<{ batch: { id: string }; previousIdenticalImport: { message: string; completedAt: string } | null }>(
          '/imports/upload',
          form,
        );
        setPriorIdentical(res.previousIdenticalImport);

        const ins = await api.get<InspectResponse>(`/imports/batches/${res.batch.id}/inspect`);
        setInspect(ins);
        setMapping(ins.effectiveMapping);
        setStep('mapping');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'The file could not be uploaded.');
      } finally {
        setBusy(false);
      }
    },
    [company, categoryKey, financialYear],
  );

  const changeSheet = async (sheetName: string) => {
    if (!inspect) return;
    setBusy(true);
    try {
      const ins = await api.get<InspectResponse>(`/imports/batches/${inspect.batch.id}/inspect`, { sheet: sheetName });
      setInspect(ins);
      setMapping(ins.effectiveMapping);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That sheet could not be read.');
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------- validate */

  const runValidation = async () => {
    if (!inspect) return;
    setBusy(true);
    setError(null);

    try {
      const res = await api.post<ValidateResponse>(`/imports/batches/${inspect.batch.id}/validate`, {
        sheetName: inspect.sheet.name,
        headerRowIndex: inspect.sheet.headerRowIndex,
        mapping,
        options,
        rememberMapping: true,
      });
      setValidation(res);
      setStep('validate');
    } catch (err) {
      if (err instanceof ApiError && err.details) {
        const d = err.details as { errors?: string[] };
        setError(`${err.message} ${d.errors?.join(' ') ?? ''}`);
      } else {
        setError(err instanceof ApiError ? err.message : 'Validation failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  /* --------------------------------------------------------------- commit */

  const runCommit = async (partial: boolean) => {
    if (!inspect) return;
    setConfirmOpen(false);
    setBusy(true);
    setError(null);

    try {
      const res = await api.post<CommitResponse>(`/imports/batches/${inspect.batch.id}/commit`, {
        duplicateStrategy,
        partialImport: partial,
        acknowledgedWarnings: true,
      });
      setCommitResult(res);
      setStep('done');
      toasts.success('Import complete', `${res.result.accepted} record(s) accepted.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import could not be completed. No data was changed.');
    } finally {
      setBusy(false);
    }
  };

  /* ----------------------------------------------------------------- gates */

  if (!company) {
    return (
      <Card>
        <EmptyState
          icon={<FileSpreadsheet className="w-5 h-5" />}
          title="Select a company first"
          description="Imports are stored against one company. Choose or create one before importing."
          action={<Button variant="primary" onClick={() => navigate('/companies')}>Go to Companies</Button>}
        />
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title="Excel Import Center"
        description="Upload workbooks exported from your accounting system, map their columns to ArthSetu's fields, review what will change, and import."
        actions={
          step !== 'category' && (
            <Button size="sm" icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={reset}>
              Start over
            </Button>
          )
        }
      />

      <Tabs
        tabs={[
          { key: 'wizard', label: 'New import' },
          { key: 'history', label: 'Import history' },
          { key: 'templates', label: 'Templates' },
        ]}
        active={tab}
        onChange={(k) => {
          setTab(k);
          setParams(k === 'wizard' ? {} : { tab: k });
        }}
        className="mb-5"
      />

      {tab === 'history' && <ImportHistory />}
      {tab === 'templates' && <TemplateList categories={categories} loading={loadingCategories} />}

      {tab === 'wizard' && (
        <>
          {!can('imports.create') ? (
            <Callout tone="info" title="You have read-only access to imports">
              Your role can review import history but cannot upload new data. A finance user or administrator can import on your behalf.
            </Callout>
          ) : (
            <>
              <StepIndicator step={step} />

              {error && (
                <Callout tone="danger" title="That did not work" className="mb-4" onDismiss={() => setError(null)}>
                  {error}
                </Callout>
              )}

              {step === 'category' && (
                <CategoryStep
                  categories={categories}
                  loading={loadingCategories}
                  onPick={(key) => {
                    setCategoryKey(key);
                    setStep('upload');
                  }}
                />
              )}

              {step === 'upload' && category && (
                <UploadStep
                  category={category}
                  busy={busy}
                  companyName={company.name}
                  financialYearLabel={financialYear?.label ?? null}
                  onBack={() => setStep('category')}
                  onFile={onFileChosen}
                />
              )}

              {step === 'mapping' && inspect && category && (
                <MappingStep
                  inspect={inspect}
                  category={category}
                  mapping={mapping}
                  setMapping={setMapping}
                  options={options}
                  setOptions={setOptions}
                  priorIdentical={priorIdentical}
                  busy={busy}
                  onSheetChange={changeSheet}
                  onBack={() => setStep('upload')}
                  onNext={runValidation}
                />
              )}

              {step === 'validate' && validation && inspect && category && (
                <ValidateStep
                  validation={validation}
                  category={category}
                  batchId={inspect.batch.id}
                  duplicateStrategy={duplicateStrategy}
                  setDuplicateStrategy={setDuplicateStrategy}
                  busy={busy}
                  currencyScale={currency.scale}
                  onBack={() => setStep('mapping')}
                  onImport={() => setConfirmOpen(true)}
                />
              )}

              {step === 'done' && commitResult && inspect && (
                <DoneStep result={commitResult} fileName={inspect.batch.fileName} batchId={inspect.batch.id} onAnother={reset} />
              )}

              <ConfirmDialog
                open={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                onConfirm={() => runCommit((validation?.report.invalidRows ?? 0) > 0)}
                loading={busy}
                tone="primary"
                confirmLabel="Import now"
                title="Confirm this import"
                message={
                  validation && category ? (
                    <span className="block space-y-2">
                      <span className="block">
                        <strong>{formatNumber(validation.report.validRows)}</strong> valid row(s) from{' '}
                        <strong>{inspect?.batch.fileName}</strong> will be imported as <strong>{category.label}</strong> for{' '}
                        <strong>{company.name}</strong>.
                      </span>
                      {validation.report.invalidRows > 0 && (
                        <span className="block text-warning">
                          {formatNumber(validation.report.invalidRows)} invalid row(s) will be skipped and kept in a downloadable report.
                        </span>
                      )}
                      {validation.report.duplicateRecordsInDatabase > 0 && (
                        <span className="block">
                          {formatNumber(validation.report.duplicateRecordsInDatabase)} record(s) already exist and will be{' '}
                          <strong>{duplicateStrategy === 'update' ? 'updated in place' : 'left untouched'}</strong>.
                        </span>
                      )}
                      <span className="block text-ink-subtle">
                        The whole batch is written in a single transaction. If any part fails, nothing is saved.
                      </span>
                    </span>
                  ) : null
                }
              />
            </>
          )}

          <Explainer
            className="mt-5"
            what="Reads an Excel or CSV workbook, lets you match its columns to ArthSetu's fields, checks every row, and stores the valid ones."
            why="Your export layout is yours. Rather than forcing one fixed spreadsheet format, this maps whatever columns you have."
            needs="An .xlsx, .xls or .csv file with a heading row. Column order does not matter and headings need not match ours."
            next="Pick what kind of data the file holds, upload it, confirm the suggested column mapping, then review the validation report before importing."
          />
        </>
      )}

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

/* ------------------------------------------------------------ step indicator */

const STEPS: { key: Step; label: string }[] = [
  { key: 'category', label: 'Data type' },
  { key: 'upload', label: 'Upload' },
  { key: 'mapping', label: 'Map columns' },
  { key: 'validate', label: 'Review' },
  { key: 'done', label: 'Imported' },
];

function StepIndicator({ step }: { step: Step }) {
  const index = STEPS.findIndex((s) => s.key === step);

  return (
    <ol className="flex items-center gap-1 mb-5 overflow-x-auto pb-1" aria-label="Import progress">
      {STEPS.map((s, i) => {
        const done = i < index;
        const active = i === index;
        return (
          <li key={s.key} className="flex items-center gap-1 shrink-0">
            <div
              className={cx(
                'flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors',
                active && 'bg-brand-50 border-brand-200 text-brand-700',
                done && 'bg-positive-bg border-positive-border text-positive',
                !active && !done && 'bg-surface border-line text-ink-subtle',
              )}
            >
              <span
                className={cx(
                  'w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-semibold shrink-0',
                  active && 'bg-brand text-white',
                  done && 'bg-positive text-white',
                  !active && !done && 'bg-navy-100 text-ink-subtle',
                )}
              >
                {done ? '✓' : i + 1}
              </span>
              {s.label}
            </div>
            {i < STEPS.length - 1 && <div className={cx('w-4 h-px shrink-0', done ? 'bg-positive-border' : 'bg-line')} />}
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------------------------------------- step: type */

function CategoryStep({
  categories,
  loading,
  onPick,
}: {
  categories: ImportCategory[];
  loading: boolean;
  onPick: (key: string) => void;
}) {
  if (loading) return <LoadingPane label="Loading import types…" />;

  return (
    <Card>
      <CardHeader
        title="What kind of data does this file hold?"
        description="Pick the closest match. Not every workbook contains every category, and you can import them one at a time."
      />
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 p-5">
        {categories.map((c) => (
          <button
            key={c.key}
            onClick={() => onPick(c.key)}
            className="text-left p-4 rounded-card border border-line hover:border-brand-200 hover:bg-brand-50/30 transition-colors group"
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium text-ink group-hover:text-brand-700">{c.label}</h3>
              <ArrowRight className="w-3.5 h-3.5 text-ink-subtle group-hover:text-brand shrink-0 mt-0.5" />
            </div>
            <p className="text-xs text-ink-muted mt-1.5 leading-relaxed">{c.description}</p>
            {c.enables.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1">
                {c.enables.slice(0, 3).map((e) => (
                  <Badge key={e} tone="neutral">
                    {e}
                  </Badge>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------- step: upload */

function UploadStep({
  category,
  busy,
  companyName,
  financialYearLabel,
  onBack,
  onFile,
}: {
  category: ImportCategory;
  busy: boolean;
  companyName: string;
  financialYearLabel: string | null;
  onBack: () => void;
  onFile: (f: File) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={`Upload a ${category.label} file`}
          description={category.description}
          actions={
            <Button size="sm" icon={<ArrowLeft className="w-3.5 h-3.5" />} onClick={onBack}>
              Change type
            </Button>
          }
        />

        <div className="px-5 pt-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-ink-muted">
            <span>
              Company: <strong className="text-ink">{companyName}</strong>
            </span>
            <span>
              Financial year: <strong className="text-ink">{financialYearLabel ?? 'none selected'}</strong>
            </span>
          </div>
          {!financialYearLabel && (
            <Callout tone="warning" className="mt-3">
              No financial year is selected. Opening balances and period-scoped records need one — set it in the top bar first.
            </Callout>
          )}
        </div>

        <div className="p-5">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) onFile(f);
            }}
            className={cx(
              'border-2 border-dashed rounded-card p-10 text-center transition-colors',
              dragging ? 'border-brand bg-brand-50/50' : 'border-line bg-navy-50/30',
            )}
          >
            <Upload className={cx('w-8 h-8 mx-auto mb-3', dragging ? 'text-brand' : 'text-ink-subtle')} />
            <p className="text-sm font-medium text-ink">Drop your workbook here</p>
            <p className="text-xs text-ink-muted mt-1">.xlsx, .xls or .csv — up to 25 MB</p>

            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = '';
              }}
            />
            <Button variant="primary" className="mt-4" loading={busy} onClick={() => inputRef.current?.click()}>
              Choose a file
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="What this file can contain" description="Column order does not matter, and your headings need not match these names." />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left px-5 py-2.5 label-text">Field</th>
                <th className="text-left px-4 py-2.5 label-text">Required</th>
                <th className="text-left px-4 py-2.5 label-text">Type</th>
                <th className="text-left px-4 py-2.5 label-text">Notes</th>
              </tr>
            </thead>
            <tbody>
              {category.fields.map((f) => (
                <tr key={f.key} className="border-b border-line/60">
                  <td className="px-5 py-2.5 text-ink">{f.label}</td>
                  <td className="px-4 py-2.5">
                    {f.required ? <Badge tone="danger">Required</Badge> : <span className="text-xs text-ink-subtle">Optional</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-ink-muted capitalize">{f.type}</td>
                  <td className="px-4 py-2.5 text-xs text-ink-muted leading-relaxed">
                    {f.enumValues ? `One of: ${f.enumValues.join(', ')}. ` : ''}
                    {f.help ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3.5 border-t border-line flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-ink-muted">
            Duplicate detection for this type: <strong className="text-ink">{category.duplicateBasis}</strong>
          </p>
          <Button
            size="sm"
            icon={<Download className="w-3.5 h-3.5" />}
            onClick={() => api.download(`/imports/templates/${category.key}`, undefined, `ArthSetu-template-${category.key}.xlsx`)}
          >
            Download template
          </Button>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------ step: mapping */

function MappingStep({
  inspect,
  category,
  mapping,
  setMapping,
  options,
  setOptions,
  priorIdentical,
  busy,
  onSheetChange,
  onBack,
  onNext,
}: {
  inspect: InspectResponse;
  category: ImportCategory;
  mapping: Record<string, string | null>;
  setMapping: (m: Record<string, string | null>) => void;
  options: Record<string, unknown>;
  setOptions: (o: Record<string, unknown>) => void;
  priorIdentical: { message: string; completedAt: string } | null;
  busy: boolean;
  onSheetChange: (name: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { sheet, suggestions, unrecognisedHeaders, matchesSupportedTemplate, savedProfile, batch } = inspect;

  const missingRequired = category.fields.filter((f) => f.required && !mapping[f.key]);
  const anyOfUnmet = category.anyOf.filter((g) => !g.keys.some((k) => mapping[k]));
  const canContinue = missingRequired.length === 0 && anyOfUnmet.length === 0;

  const ambiguousDateFields = category.fields.filter((f) => {
    if (f.type !== 'date') return false;
    const header = mapping[f.key];
    if (!header) return false;
    return sheet.columns.find((c) => c.header === header)?.dateFormat?.ambiguous;
  });

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------- file summary */}
      <Card>
        <CardHeader
          title={batch.fileName}
          description={`${formatFileSize(batch.fileSize)} · ${inspect.sheets.length} sheet(s) · importing as ${batch.categoryLabel}`}
          icon={<FileSpreadsheet className="w-4 h-4" />}
          actions={
            <Button size="sm" icon={<ArrowLeft className="w-3.5 h-3.5" />} onClick={onBack}>
              Replace file
            </Button>
          }
        />

        <div className="p-5 space-y-3">
          {priorIdentical && (
            <Callout tone="warning" title="This exact file has been imported before">
              {priorIdentical.message} The previous import completed on {formatDateTime(priorIdentical.completedAt)}.
            </Callout>
          )}

          <Callout tone={matchesSupportedTemplate.matches ? 'positive' : 'info'}>{matchesSupportedTemplate.detail}</Callout>

          {savedProfile && (
            <Callout tone="info" title="A saved mapping was applied">
              This column layout was mapped before ({savedProfile.useCount} time{savedProfile.useCount === 1 ? '' : 's'}), so those choices
              have been restored. Change anything below if this file differs.
            </Callout>
          )}

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Sheet" value={sheet.name} />
            <Stat label="Data rows" value={formatNumber(sheet.totalRows)} />
            <Stat label="Columns detected" value={formatNumber(sheet.headers.length)} />
            <Stat label="Heading row" value={`Row ${sheet.headerRowIndex + 1}`} />
          </div>

          {sheet.blankRowsSkipped > 0 && (
            <p className="text-xs text-ink-muted">{formatNumber(sheet.blankRowsSkipped)} blank row(s) were skipped.</p>
          )}
          {sheet.duplicateRowCount > 0 && (
            <p className="text-xs text-warning">
              {formatNumber(sheet.duplicateRowCount)} row(s) are identical to another row in this file. They are reported again after
              validation.
            </p>
          )}

          {inspect.sheets.length > 1 && (
            <Field label="Worksheet" hint="Choose which sheet holds this data.">
              <Select value={sheet.name} onChange={(e) => onSheetChange(e.target.value)} disabled={busy}>
                {inspect.sheets.map((s) => (
                  <option key={s.name} value={s.name} disabled={s.isEmpty}>
                    {s.name} {s.isEmpty ? '(empty)' : `— ${s.rowCount} rows, ${s.columnCount} columns`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      </Card>

      {/* ------------------------------------------------------ the mapping */}
      <Card>
        <CardHeader
          title="Match your columns to ArthSetu's fields"
          description="Suggestions come from your column headings and the values beneath them. Review each one — a wrong mapping accepted here is hard to spot later."
        />

        <div className="divide-y divide-line">
          {category.fields.map((field) => {
            const suggestion = suggestions.find((s) => s.fieldKey === field.key);
            const selected = mapping[field.key] ?? '';
            const column = sheet.columns.find((c) => c.header === selected);
            const isSuggested = suggestion?.header === selected && selected !== '';

            return (
              <div key={field.key} className="px-5 py-3.5 grid lg:grid-cols-[1fr_auto_1.2fr] gap-3 items-start">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-ink">{field.label}</span>
                    {field.required && <Badge tone="danger">Required</Badge>}
                    {field.help && (
                      <Tooltip content={field.help}>
                        <Info className="w-3.5 h-3.5 text-ink-subtle" />
                      </Tooltip>
                    )}
                  </div>
                  <p className="text-xs text-ink-muted mt-0.5 capitalize">{field.type}</p>
                </div>

                <ArrowRight className="hidden lg:block w-4 h-4 text-ink-subtle mt-2.5" />

                <div className="min-w-0 space-y-1.5">
                  <Select
                    value={selected}
                    invalid={field.required && !selected}
                    onChange={(e) => setMapping({ ...mapping, [field.key]: e.target.value || null })}
                  >
                    <option value="">— not in this file —</option>
                    {sheet.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>

                  {selected && column && (
                    <p className="text-2xs text-ink-subtle truncate">
                      {column.detectedType} · {formatNumber(column.nonEmptyCount)} values
                      {column.samples.length > 0 && ` · e.g. ${column.samples.slice(0, 2).join(', ')}`}
                    </p>
                  )}

                  {isSuggested && suggestion && (
                    <p className="text-2xs text-ink-subtle">
                      {suggestion.reason} ({Math.round(suggestion.confidence * 100)}% confidence)
                    </p>
                  )}

                  {suggestion?.warning && (
                    <p className="text-2xs text-warning flex items-start gap-1">
                      <TriangleAlert className="w-3 h-3 shrink-0 mt-px" />
                      {suggestion.warning}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {unrecognisedHeaders.length > 0 && (
          <div className="px-5 py-3.5 border-t border-line">
            <p className="text-xs text-ink-muted">
              <strong className="text-ink">Columns not mapped:</strong> {unrecognisedHeaders.join(', ')}. These are ignored and their data
              is not imported.
            </p>
          </div>
        )}
      </Card>

      {/* --------------------------------------------------- reading options */}
      {(category.supportsForwardFill || ambiguousDateFields.length > 0 || mapping.amount) && (
        <Card>
          <CardHeader title="How to read this file" description="Adjust these only if the defaults misread your data." />
          <div className="p-5 space-y-4">
            {category.supportsForwardFill && (
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.forwardFill !== false}
                  onChange={(e) => setOptions({ ...options, forwardFill: e.target.checked })}
                  className="mt-0.5 w-4 h-4 rounded border-line text-brand focus:ring-brand/30"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">Carry blank date, type and voucher number down from the row above</span>
                  <span className="block text-xs text-ink-muted mt-0.5 leading-relaxed">
                    Most accounting exports print these once per voucher and leave them blank on continuation lines. With this off, every
                    line after the first will be rejected for a missing date.
                  </span>
                </span>
              </label>
            )}

            {ambiguousDateFields.map((f) => (
              <Field
                key={f.key}
                label={`Date format for "${mapping[f.key]}"`}
                hint="No value in this column had a day above 12, so the order cannot be settled from the data. Day-first is the Indian convention."
              >
                <Select
                  value={(options.dateOrder as Record<string, string>)?.[f.key] ?? 'dmy'}
                  onChange={(e) =>
                    setOptions({ ...options, dateOrder: { ...((options.dateOrder as object) ?? {}), [f.key]: e.target.value } })
                  }
                >
                  <option value="dmy">Day first — 05/04/2025 is 5 April</option>
                  <option value="mdy">Month first — 05/04/2025 is 4 May</option>
                  <option value="ymd">Year first — 2025-04-05</option>
                </Select>
              </Field>
            ))}

            {mapping.amount && !mapping.debit && !mapping.credit && (
              <Field
                label="How to read a single signed amount column"
                hint="Only applies where there is no separate debit and credit column, and no Dr/Cr marker on the value."
              >
                <Select
                  value={options.negativeMeansCredit === false ? 'false' : 'true'}
                  onChange={(e) => setOptions({ ...options, negativeMeansCredit: e.target.value === 'true' })}
                >
                  <option value="true">Positive is a debit, negative is a credit</option>
                  <option value="false">Positive is a credit, negative is a debit</option>
                </Select>
              </Field>
            )}
          </div>
        </Card>
      )}

      {/* ----------------------------------------------------- sample rows */}
      <Card>
        <CardHeader title="Sample rows from your file" description={`The first ${Math.min(10, sheet.sampleRows.length)} data rows, exactly as read.`} icon={<Table2 className="w-4 h-4" />} />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left px-5 py-2 label-text sticky left-0 bg-surface">Row</th>
                {sheet.headers.map((h) => (
                  <th key={h} className="text-left px-3 py-2 label-text whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.sampleRows.slice(0, 10).map((r) => (
                <tr key={r.rowNumber} className="border-b border-line/60">
                  <td className="px-5 py-1.5 text-ink-subtle tabular sticky left-0 bg-surface">{r.rowNumber}</td>
                  {sheet.headers.map((h) => (
                    <td key={h} className="px-3 py-1.5 text-ink-muted whitespace-nowrap max-w-[180px] truncate">
                      {r.values[h] === null || r.values[h] === undefined || r.values[h] === '' ? (
                        <span className="text-ink-subtle">—</span>
                      ) : (
                        String(r.values[h])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* -------------------------------------------------------- continue */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-ink-muted">
          {missingRequired.length > 0 && (
            <span className="text-danger">Still required: {missingRequired.map((f) => f.label).join(', ')}</span>
          )}
          {missingRequired.length === 0 && anyOfUnmet.length > 0 && (
            <span className="text-danger">This import also needs {anyOfUnmet.map((g) => g.label).join(', and ')}.</span>
          )}
          {canContinue && <span className="text-positive">Every required field is mapped.</span>}
        </div>
        <Button variant="primary" disabled={!canContinue} loading={busy} onClick={onNext} iconRight={<ArrowRight className="w-4 h-4" />}>
          Validate this file
        </Button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- step: validate */

function ValidateStep({
  validation,
  category,
  batchId,
  duplicateStrategy,
  setDuplicateStrategy,
  busy,
  currencyScale,
  onBack,
  onImport,
}: {
  validation: ValidateResponse;
  category: ImportCategory;
  batchId: string;
  duplicateStrategy: 'skip' | 'update' | 'review';
  setDuplicateStrategy: (s: 'skip' | 'update' | 'review') => void;
  busy: boolean;
  currencyScale: number;
  onBack: () => void;
  onImport: () => void;
}) {
  const r = validation.report;
  const hasIssues = r.invalidRows > 0 || r.imbalancedVouchers.length > 0 || r.duplicateRecordsInDatabase > 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Validation report" description="Everything checked before anything is written. Nothing has been saved yet." />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 p-5">
          <Stat label="Total rows" value={formatNumber(r.totalRows)} />
          <Stat label="Valid" value={formatNumber(r.validRows)} tone={r.validRows > 0 ? 'positive' : undefined} />
          <Stat label="Rejected" value={formatNumber(r.invalidRows)} tone={r.invalidRows > 0 ? 'danger' : undefined} />
          <Stat label="With warnings" value={formatNumber(r.warningRows)} tone={r.warningRows > 0 ? 'warning' : undefined} />
          <Stat label="Repeated in file" value={formatNumber(r.duplicateRowsInFile)} tone={r.duplicateRowsInFile > 0 ? 'warning' : undefined} />
          <Stat
            label="Already imported"
            value={formatNumber(r.duplicateRecordsInDatabase)}
            tone={r.duplicateRecordsInDatabase > 0 ? 'warning' : undefined}
          />
        </div>

        {r.dateRange && (
          <div className="px-5 pb-4">
            <p className="text-xs text-ink-muted">
              Dates in this file span <strong className="text-ink">{r.dateRange.from}</strong> to{' '}
              <strong className="text-ink">{r.dateRange.to}</strong>.
            </p>
          </div>
        )}

        {r.notes.length > 0 && (
          <div className="px-5 pb-5 space-y-2">
            {r.notes.map((n, i) => (
              <Callout key={i} tone="info">
                {n}
              </Callout>
            ))}
          </div>
        )}
      </Card>

      {/* --------------------------------------------------------- problems */}
      {r.missingRequired.length > 0 && (
        <Callout tone="danger" title="Rows are missing required values">
          <ul className="list-disc list-inside space-y-0.5">
            {r.missingRequired.map((m) => (
              <li key={m.field}>
                {m.label}: empty in {formatNumber(m.count)} row(s)
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {(r.invalidDates > 0 || r.invalidAmounts > 0) && (
        <Callout tone="warning" title="Some values could not be read">
          {r.invalidDates > 0 && <p>{formatNumber(r.invalidDates)} date value(s) could not be interpreted.</p>}
          {r.invalidAmounts > 0 && <p>{formatNumber(r.invalidAmounts)} amount value(s) could not be interpreted.</p>}
          <p className="mt-1">These rows are rejected rather than stored as zero, so no invented figure reaches your accounts.</p>
        </Callout>
      )}

      {r.imbalancedVouchers.length > 0 && (
        <Card>
          <CardHeader
            title={`${r.imbalancedVouchers.length} voucher(s) do not balance`}
            description="Debits do not equal credits. These are imported with the difference recorded, not silently adjusted — adjusting them would hide a real bookkeeping error."
            icon={<TriangleAlert className="w-4 h-4 text-warning" />}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left px-5 py-2 label-text">Voucher</th>
                  <th className="text-left px-4 py-2 label-text">Date</th>
                  <th className="text-right px-4 py-2 label-text">Difference</th>
                  <th className="text-left px-4 py-2 label-text">Spreadsheet rows</th>
                </tr>
              </thead>
              <tbody>
                {r.imbalancedVouchers.slice(0, 15).map((v, i) => (
                  <tr key={i} className="border-b border-line/60">
                    <td className="px-5 py-2 text-ink">{v.voucherNumber ?? '(no number)'}</td>
                    <td className="px-4 py-2 text-ink-muted tabular">{v.date}</td>
                    <td className="px-4 py-2 text-right tabular text-warning">
                      {(v.imbalance / Math.pow(10, currencyScale)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-subtle tabular">{v.rowNumbers.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {r.newLedgers.length > 0 && (
        <Callout tone="info" title={`${r.newLedgers.length} ledger(s) are new to this company`}>
          <p>
            These accounts will be created and given an unconfirmed category suggestion. Their balances stay out of your statements until you
            approve the category in Account Mapping.
          </p>
          <p className="mt-1.5 font-mono text-2xs break-words">{r.newLedgers.slice(0, 12).join(' · ')}{r.newLedgers.length > 12 && ' …'}</p>
        </Callout>
      )}

      {/* ------------------------------------------------- rejected rows */}
      {validation.rejectedPreview.length > 0 && (
        <Card>
          <CardHeader
            title={`${formatNumber(r.invalidRows)} rejected row(s)`}
            description="Each with the reason it failed. Correct these in your file and import again, or import only the valid rows."
            icon={<FileWarning className="w-4 h-4 text-danger" />}
            actions={
              <Button
                size="sm"
                icon={<Download className="w-3.5 h-3.5" />}
                onClick={() => api.download(`/imports/batches/${batchId}/rejections.xlsx`)}
              >
                Download all
              </Button>
            }
          />
          <div className="overflow-x-auto max-h-80">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left px-5 py-2 label-text">Row</th>
                  <th className="text-left px-4 py-2 label-text">Why it was rejected</th>
                </tr>
              </thead>
              <tbody>
                {validation.rejectedPreview.map((row) => (
                  <tr key={row.rowNumber} className="border-b border-line/60">
                    <td className="px-5 py-2 tabular text-ink-subtle align-top">{row.rowNumber}</td>
                    <td className="px-4 py-2 text-danger leading-relaxed">{row.errors.map((e) => e.message).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-5 py-2.5 text-2xs text-ink-subtle border-t border-line">
            Showing the first {validation.rejectedPreview.length}. The downloadable report contains every rejected row with its original values.
          </p>
        </Card>
      )}

      {/* --------------------------------------------------------- preview */}
      <Card>
        <CardHeader
          title="What will be imported"
          description={`${formatNumber(validation.preview.totalItems)} record(s) ready. Showing the first ${validation.preview.items.length}.`}
        />
        {validation.preview.kind === 'vouchers' ? (
          <div className="divide-y divide-line max-h-96 overflow-y-auto">
            {validation.preview.items.map((v: any, i: number) => (
              <div key={i} className="px-5 py-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-sm">
                    <span className="font-medium text-ink">{v.voucherNumber ?? '(no number)'}</span>
                    <span className="text-ink-muted"> · {v.voucherType ?? 'Journal'} · {v.voucherDate}</span>
                  </div>
                  {v.imbalance !== 0 && <Badge tone="warning">Out by {(v.imbalance / Math.pow(10, currencyScale)).toFixed(2)}</Badge>}
                </div>
                {v.narration && <p className="text-xs text-ink-muted mt-0.5">{v.narration}</p>}
                <table className="w-full text-xs mt-2">
                  <tbody>
                    {v.lines.map((l: any, j: number) => (
                      <tr key={j}>
                        <td className="py-0.5 text-ink-muted">{l.ledgerName}</td>
                        <td className="py-0.5 text-right tabular text-ink w-28">
                          {l.debit ? (l.debit / Math.pow(10, currencyScale)).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : ''}
                        </td>
                        <td className="py-0.5 text-right tabular text-ink w-28">
                          {l.credit ? (l.credit / Math.pow(10, currencyScale)).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left px-5 py-2 label-text">Row</th>
                  {category.fields.slice(0, 7).map((f) => (
                    <th key={f.key} className="text-left px-3 py-2 label-text whitespace-nowrap">
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {validation.preview.items.map((item: any) => (
                  <tr key={item.rowNumber} className="border-b border-line/60">
                    <td className="px-5 py-1.5 tabular text-ink-subtle">{item.rowNumber}</td>
                    {category.fields.slice(0, 7).map((f) => {
                      const v = item.values[f.key];
                      const display =
                        v === null || v === undefined
                          ? '—'
                          : f.type === 'amount'
                            ? (Number(v) / Math.pow(10, currencyScale)).toLocaleString('en-IN', { minimumFractionDigits: 2 })
                            : String(v);
                      return (
                        <td key={f.key} className={cx('px-3 py-1.5 whitespace-nowrap', f.type === 'amount' ? 'text-right tabular' : 'text-ink-muted')}>
                          {display}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* -------------------------------------------------- duplicate policy */}
      {r.duplicateRecordsInDatabase > 0 && (
        <Card>
          <CardHeader
            title={`${formatNumber(r.duplicateRecordsInDatabase)} record(s) already exist`}
            description={`Matched on: ${category.duplicateBasis}. Choose what should happen to them.`}
            icon={<Copy className="w-4 h-4 text-warning" />}
          />
          <div className="p-5 space-y-2.5">
            {(
              [
                { key: 'skip', title: 'Leave existing records untouched', body: 'Only genuinely new records are imported. Your financial history is not modified in any way.' },
                { key: 'update', title: 'Update matched records with the new values', body: 'Existing records are overwritten and the differences are listed after the import, so you can see exactly what changed.' },
              ] as const
            ).map((opt) => (
              <label
                key={opt.key}
                className={cx(
                  'flex items-start gap-3 p-3.5 rounded-card border cursor-pointer transition-colors',
                  duplicateStrategy === opt.key ? 'border-brand-200 bg-brand-50/40' : 'border-line hover:bg-navy-50/50',
                )}
              >
                <input
                  type="radio"
                  name="duplicateStrategy"
                  checked={duplicateStrategy === opt.key}
                  onChange={() => setDuplicateStrategy(opt.key)}
                  className="mt-0.5 w-4 h-4 border-line text-brand focus:ring-brand/30"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink font-medium">{opt.title}</span>
                  <span className="block text-xs text-ink-muted mt-0.5 leading-relaxed">{opt.body}</span>
                </span>
              </label>
            ))}
          </div>
        </Card>
      )}

      {/* -------------------------------------------------------- actions */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Button icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>
          Back to mapping
        </Button>

        <div className="flex items-center gap-2.5 flex-wrap">
          {r.invalidRows > 0 && !validation.canImportValidOnly && (
            <p className="text-xs text-danger">
              {category.label} does not allow partial imports. Fix the rejected rows and upload again.
            </p>
          )}
          <Button
            variant={hasIssues ? 'secondary' : 'primary'}
            loading={busy}
            disabled={r.validRows === 0 || (r.invalidRows > 0 && !validation.canImportValidOnly)}
            onClick={onImport}
            iconRight={<ArrowRight className="w-4 h-4" />}
          >
            {r.invalidRows > 0 ? `Import ${formatNumber(r.validRows)} valid row(s) only` : `Import ${formatNumber(r.validRows)} record(s)`}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- step: done */

function DoneStep({
  result,
  fileName,
  batchId,
  onAnother,
}: {
  result: CommitResponse;
  fileName: string;
  batchId: string;
  onAnother: () => void;
}) {
  const navigate = useNavigate();
  const r = result.result;

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-6 text-center">
          <div className="w-12 h-12 rounded-full bg-positive-bg border border-positive-border flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-6 h-6 text-positive" />
          </div>
          <h2 className="text-base font-semibold text-ink">Import complete</h2>
          <p className="text-xs text-ink-muted mt-1.5">
            {fileName} · {formatNumber(r.processed)} row(s) processed
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 px-5 pb-5">
          <Stat label="Added" value={formatNumber(r.inserted)} tone="positive" />
          <Stat label="Updated" value={formatNumber(r.updated)} tone={r.updated > 0 ? 'warning' : undefined} />
          <Stat label="Skipped" value={formatNumber(r.skipped)} />
          <Stat label="Rejected" value={formatNumber(r.rejected)} tone={r.rejected > 0 ? 'danger' : undefined} />
          <Stat label="New ledgers" value={formatNumber(r.ledgersCreated)} />
        </div>
      </Card>

      {r.changes.length > 0 && (
        <Card>
          <CardHeader
            title={`${formatNumber(r.changeCount)} record(s) changed`}
            description="What differs from what was stored before. Financial history is never replaced silently."
          />
          <ul className="divide-y divide-line max-h-72 overflow-y-auto">
            {r.changes.map((c, i) => (
              <li key={i} className="px-5 py-2.5 flex items-start justify-between gap-3">
                <span className="text-sm text-ink min-w-0 truncate">{c.label}</span>
                {c.detail && <span className="text-xs text-ink-muted shrink-0">{c.detail}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {result.nextSteps.length > 0 && (
        <Card>
          <CardHeader title="What to do next" />
          <ul className="p-5 space-y-2">
            {result.nextSteps.map((s, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-ink-muted leading-relaxed">
                <ArrowRight className="w-3.5 h-3.5 text-brand shrink-0 mt-1" />
                {s}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="primary" onClick={() => navigate('/')}>
          Open the dashboard
        </Button>
        {r.ledgersCreated > 0 && <Button onClick={() => navigate('/account-mapping')}>Review new ledger categories</Button>}
        {r.rejected > 0 && (
          <Button icon={<Download className="w-3.5 h-3.5" />} onClick={() => api.download(`/imports/batches/${batchId}/rejections.xlsx`)}>
            Download rejected rows
          </Button>
        )}
        <Button onClick={onAnother}>Import another file</Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ history */

interface BatchRow {
  id: string;
  fileName: string;
  categoryLabel: string;
  category: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  fileSize: number;
  createdByName: string | null;
  partialImport: boolean;
  totals: { totalRows?: number; inserted?: number; updated?: number; skipped?: number; invalidRows?: number } | null;
  warnings: string[];
  errorMessage: string | null;
}

function ImportHistory() {
  const { company } = useApp();
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 25, total: 0 });
  const [recon, setRecon] = useState<{ status: string; message?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!company) return;
    setLoading(true);
    void (async () => {
      try {
        const res = await api.get<{
          batches: BatchRow[];
          pagination: { page: number; pageSize: number; total: number };
          reconciliationStatus: { status: string; message?: string };
        }>('/imports/batches', { companyId: company.id, page: pagination.page, pageSize: pagination.pageSize });
        setBatches(res.batches);
        setPagination(res.pagination);
        setRecon(res.reconciliationStatus);
      } finally {
        setLoading(false);
      }
    })();
  }, [company, pagination.page]);

  if (loading) return <LoadingPane />;

  return (
    <Card>
      <CardHeader
        title="Import history"
        description="Every import, with record counts, who ran it and what it changed."
        actions={
          recon && (
            <Badge tone={recon.status === 'matched' ? 'positive' : recon.status === 'mismatched' ? 'warning' : 'neutral'}>
              Reconciliation: {recon.status === 'no_reference' ? 'Reference data not provided' : recon.status}
            </Badge>
          )
        }
      />

      {batches.length === 0 ? (
        <EmptyState icon={<FileSpreadsheet className="w-5 h-5" />} title="No imports yet" description="Imports for this company will appear here." />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left px-5 py-2.5 label-text">File</th>
                  <th className="text-left px-4 py-2.5 label-text">Type</th>
                  <th className="text-left px-4 py-2.5 label-text">When</th>
                  <th className="text-left px-4 py-2.5 label-text">By</th>
                  <th className="text-right px-4 py-2.5 label-text">Added</th>
                  <th className="text-right px-4 py-2.5 label-text">Updated</th>
                  <th className="text-right px-4 py-2.5 label-text">Skipped</th>
                  <th className="text-right px-4 py-2.5 label-text">Rejected</th>
                  <th className="text-left px-4 py-2.5 label-text">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-b border-line/60 hover:bg-navy-50/40">
                    <td className="px-5 py-2.5">
                      <p className="text-ink truncate max-w-[220px]">{b.fileName}</p>
                      <p className="text-2xs text-ink-subtle">{formatFileSize(b.fileSize)}</p>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-muted">{b.categoryLabel}</td>
                    <td className="px-4 py-2.5 text-xs text-ink-muted whitespace-nowrap">{formatDateTime(b.completedAt ?? b.createdAt)}</td>
                    <td className="px-4 py-2.5 text-xs text-ink-muted truncate max-w-[140px]">{b.createdByName ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular text-xs">{b.totals?.inserted ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular text-xs">{b.totals?.updated ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular text-xs">{b.totals?.skipped ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular text-xs">
                      {b.totals?.invalidRows ? <span className="text-danger">{b.totals.invalidRows}</span> : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge
                        tone={b.status === 'committed' ? 'positive' : b.status === 'failed' ? 'danger' : 'neutral'}
                      >
                        {b.status}
                      </Badge>
                      {b.partialImport && (
                        <Tooltip content="Only the valid rows from this file were imported.">
                          <Badge tone="warning" className="ml-1">
                            partial
                          </Badge>
                        </Tooltip>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {Boolean(b.totals?.invalidRows) && (
                        <Button size="sm" variant="ghost" onClick={() => api.download(`/imports/batches/${b.id}/rejections.xlsx`)}>
                          Errors
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination {...pagination} onPageChange={(p) => setPagination((s) => ({ ...s, page: p }))} />
        </>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- templates */

function TemplateList({ categories, loading }: { categories: ImportCategory[]; loading: boolean }) {
  if (loading) return <LoadingPane />;

  return (
    <Card>
      <CardHeader
        title="Import templates"
        description="Each template includes the column definitions and a few clearly-marked example rows. You do not have to use them — any layout works, because you map the columns during import."
      />
      <Callout tone="warning" className="m-5 mb-0">
        Example rows in every template are prefixed “EXAMPLE —”. Delete them before entering your own data so sample values never reach your
        financial records.
      </Callout>
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 p-5">
        {categories.map((c) => (
          <div key={c.key} className="p-4 rounded-card border border-line flex flex-col">
            <h3 className="text-sm font-medium text-ink">{c.label}</h3>
            <p className="text-xs text-ink-muted mt-1.5 leading-relaxed flex-1">{c.description}</p>
            <p className="text-2xs text-ink-subtle mt-2.5">
              Required: {c.fields.filter((f) => f.required).map((f) => f.label).join(', ') || 'none'}
            </p>
            <Button
              size="sm"
              className="mt-3 self-start"
              icon={<Download className="w-3.5 h-3.5" />}
              onClick={() => api.download(`/imports/templates/${c.key}`, undefined, `ArthSetu-template-${c.key}.xlsx`)}
            >
              Download
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------- stat */

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'warning' | 'danger' }) {
  return (
    <div className="px-3.5 py-2.5 rounded-card border border-line bg-navy-50/40">
      <p className="label-text truncate">{label}</p>
      <p
        className={cx(
          'text-base font-semibold tabular mt-0.5 truncate',
          tone === 'positive' && 'text-positive',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
          !tone && 'text-ink',
        )}
      >
        {value}
      </p>
    </div>
  );
}

export { AlertCircle };
