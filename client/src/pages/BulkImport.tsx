import { useRef, useState } from 'react';
import { CheckCircle2, FileSpreadsheet, TriangleAlert, Upload, X, XCircle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/state/AppContext';
import { Badge, Button, Callout, Card, CardHeader } from '@/components/ui';
import { cx, formatFileSize, formatNumber } from '@/lib/format';

interface BulkRow {
  fileName: string;
  sheetName: string | null;
  category: string | null;
  categoryLabel: string | null;
  confidence: number | null;
  status: 'imported' | 'skipped' | 'failed';
  inserted: number;
  updated: number;
  skipped: number;
  rejected: number;
  ledgersCreated: number;
  batchId: string | null;
  message: string;
}

interface BulkResponse {
  summary: {
    files: number;
    sheetsDetected: number;
    imported: number;
    failed: number;
    skipped: number;
    recordsAdded: number;
    ledgersCreated: number;
  };
  results: BulkRow[];
  nextSteps: string[];
}

const ACCEPT = ['.xlsx', '.xls', '.csv'];
const MAX_FILES = 40;

/**
 * Bulk upload: choose or drop every workbook at once. The server recognises what
 * each sheet contains from its headings, maps the columns, and imports them in
 * dependency order. The step-by-step wizard stays available for anything that
 * needs a hand-made mapping.
 */
export function BulkImport() {
  const { company, financialYear } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<BulkResponse | null>(null);

  const addFiles = (incoming: FileList | File[]) => {
    const valid: File[] = [];
    const rejected: string[] = [];
    for (const f of Array.from(incoming)) {
      const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
      if (ACCEPT.includes(ext)) valid.push(f);
      else rejected.push(f.name);
    }
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}|${f.size}`));
      const merged = [...prev, ...valid.filter((f) => !seen.has(`${f.name}|${f.size}`))];
      return merged.slice(0, MAX_FILES);
    });
    setError(rejected.length ? `Skipped ${rejected.length} unsupported file${rejected.length === 1 ? '' : 's'}: ${rejected.join(', ')}. Use .xlsx, .xls or .csv.` : null);
    setResponse(null);
  };

  const run = async () => {
    if (!company || !files.length) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      form.append('companyId', company.id);
      if (financialYear) form.append('financialYearId', financialYear.id);
      const res = await api.post<BulkResponse>('/imports/bulk', form);
      setResponse(res);
      setFiles([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The files could not be imported.');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setResponse(null);
    setFiles([]);
    setError(null);
  };

  const totalSize = files.reduce((s, f) => s + f.size, 0);

  return (
    <div className="space-y-4">
      <Callout tone="info" title="Upload everything in one go">
        Select all your workbooks together. ArthSetu reads each sheet's headings to work out what it holds (ledgers, opening balances, vouchers,
        receivables and so on), maps the columns, and imports them in the right order. Rows that cannot be read are kept for download rather than
        dropped. For a file it cannot recognise, use <strong>New import</strong> to map it by hand.
      </Callout>

      {!financialYear && (
        <Callout tone="warning">
          No financial year is selected. Opening balances need one — select it in the top bar before importing, or that file will be reported as failed.
        </Callout>
      )}

      {error && (
        <Callout tone="danger" title="That did not work" onDismiss={() => setError(null)}>
          {error}
        </Callout>
      )}

      {!response && (
        <Card>
          <CardHeader
            title="Choose your files"
            description={`Up to ${MAX_FILES} files, each up to 25 MB. Company: ${company?.name ?? '—'}${financialYear ? ` · Financial year: ${financialYear.label ?? ''}` : ''}`}
          />
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
                if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
              }}
              className={cx(
                'border-2 border-dashed rounded-card p-10 text-center transition-colors',
                dragging ? 'border-brand bg-brand-50/50' : 'border-line bg-navy-50/30',
              )}
            >
              <Upload className={cx('w-8 h-8 mx-auto mb-3', dragging ? 'text-brand' : 'text-ink-subtle')} />
              <p className="text-sm font-medium text-ink">Drop all your workbooks here</p>
              <p className="text-xs text-ink-muted mt-1">.xlsx, .xls or .csv — select many files at once</p>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <Button variant="primary" className="mt-4" onClick={() => inputRef.current?.click()} disabled={busy}>
                Choose files
              </Button>
            </div>

            {files.length > 0 && (
              <div className="mt-5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-ink">
                    {files.length} file{files.length === 1 ? '' : 's'} ready · {formatFileSize(totalSize)}
                  </p>
                  <button className="text-xs text-ink-muted hover:text-ink" onClick={() => setFiles([])} disabled={busy}>
                    Clear all
                  </button>
                </div>
                <ul className="divide-y divide-line border border-line rounded-card max-h-72 overflow-y-auto">
                  {files.map((f) => (
                    <li key={`${f.name}|${f.size}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <FileSpreadsheet className="w-4 h-4 text-ink-subtle shrink-0" />
                      <span className="flex-1 truncate text-ink">{f.name}</span>
                      <span className="text-xs text-ink-muted">{formatFileSize(f.size)}</span>
                      <button
                        className="p-1 text-ink-subtle hover:text-ink"
                        aria-label={`Remove ${f.name}`}
                        onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                        disabled={busy}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex items-center gap-3">
                  <Button variant="primary" loading={busy} onClick={run}>
                    Import {files.length} file{files.length === 1 ? '' : 's'}
                  </Button>
                  <span className="text-xs text-ink-muted">
                    Records already imported are skipped, so running this twice will not create duplicates.
                  </span>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {response && (
        <>
          <Card>
            <CardHeader
              title="Import finished"
              description={`${formatNumber(response.summary.recordsAdded)} record(s) added or updated across ${response.summary.imported} sheet(s).`}
              actions={
                <Button size="sm" onClick={reset}>
                  Import more files
                </Button>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left px-5 py-2.5 label-text">File</th>
                    <th className="text-left px-4 py-2.5 label-text">Recognised as</th>
                    <th className="text-left px-4 py-2.5 label-text">Result</th>
                    <th className="text-right px-4 py-2.5 label-text">Added</th>
                    <th className="text-right px-4 py-2.5 label-text">Rejected</th>
                    <th className="text-left px-4 py-2.5 label-text">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {response.results.map((r, i) => (
                    <tr key={`${r.fileName}-${r.sheetName}-${i}`} className="border-b border-line/60 align-top">
                      <td className="px-5 py-2.5 text-ink">
                        {r.fileName}
                        {r.sheetName && <span className="block text-xs text-ink-muted">Sheet: {r.sheetName}</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.categoryLabel ? (
                          <>
                            <span className="text-ink">{r.categoryLabel}</span>
                            {r.confidence !== null && r.confidence < 0.7 && (
                              <span className="block text-xs text-amber-700">Low confidence — check the result</span>
                            )}
                          </>
                        ) : (
                          <span className="text-ink-muted">Not recognised</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.status === 'imported' && (
                          <Badge tone="positive">
                            <CheckCircle2 className="w-3 h-3 mr-1 inline" />
                            Imported
                          </Badge>
                        )}
                        {r.status === 'failed' && (
                          <Badge tone="danger">
                            <XCircle className="w-3 h-3 mr-1 inline" />
                            Failed
                          </Badge>
                        )}
                        {r.status === 'skipped' && (
                          <Badge tone="warning">
                            <TriangleAlert className="w-3 h-3 mr-1 inline" />
                            Skipped
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(r.inserted + r.updated)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.rejected ? formatNumber(r.rejected) : '—'}</td>
                      <td className="px-4 py-2.5 text-ink-muted">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {response.nextSteps.length > 0 && (
            <Callout tone="info" title="Next steps">
              <ul className="list-disc pl-5 space-y-1">
                {response.nextSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </Callout>
          )}
        </>
      )}
    </div>
  );
}
