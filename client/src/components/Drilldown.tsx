import { useEffect, useState } from 'react';
import { ArrowLeft, FileText, Receipt, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useApp } from '@/state/AppContext';
import { Badge, Button, EmptyState, LoadingPane, Pagination } from '@/components/ui';
import { MappingStatusBadge } from '@/components/financial';
import { cx, formatAmount, formatDate, formatMoney, formatNumber } from '@/lib/format';

/**
 * Drill-down panel.
 *
 * Opens from a KPI, a statement line or a chart segment and walks the same path
 * every time: category → ledgers → transactions → the full voucher. The company,
 * financial year and period in force are carried through at every level, so what
 * you see at the bottom is exactly what produced the figure at the top.
 */

type Level =
  | { kind: 'category'; categoryKey: string; label: string; statement?: 'PL' | 'BS' }
  | { kind: 'ledger'; ledgerId: string; label: string }
  | { kind: 'voucher'; voucherId: string; label: string };

export function DrilldownPanel({ initial, onClose }: { initial: Level; onClose: () => void }) {
  const [stack, setStack] = useState<Level[]>([initial]);
  const current = stack[stack.length - 1];

  const push = (level: Level) => setStack((s) => [...s, level]);
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end no-print">
      <div className="absolute inset-0 bg-navy-950/40 backdrop-blur-[2px] animate-fade-in" onClick={onClose} aria-hidden />

      <aside
        className="relative w-full max-w-3xl h-full bg-surface border-l border-line shadow-dropdown flex flex-col animate-slide-up"
        role="dialog"
        aria-label="Drill-down"
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line shrink-0">
          <div className="min-w-0 flex items-start gap-2.5">
            {stack.length > 1 && (
              <button onClick={pop} className="p-1 -ml-1 mt-0.5 text-ink-muted hover:text-ink rounded-control hover:bg-navy-50" aria-label="Back">
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <div className="min-w-0">
              <p className="label-text">
                {current.kind === 'category' ? 'Category' : current.kind === 'ledger' ? 'Ledger' : 'Voucher'}
              </p>
              <h2 className="text-sm font-semibold text-ink truncate">{current.label}</h2>
              {stack.length > 1 && (
                <p className="text-2xs text-ink-subtle truncate mt-0.5">{stack.map((s) => s.label).join(' › ')}</p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-1 -mr-1 text-ink-muted hover:text-ink rounded-control hover:bg-navy-50" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {current.kind === 'category' && <CategoryLevel level={current} onOpenLedger={(id, label) => push({ kind: 'ledger', ledgerId: id, label })} />}
          {current.kind === 'ledger' && (
            <LedgerLevel level={current} onOpenVoucher={(id, label) => push({ kind: 'voucher', voucherId: id, label })} />
          )}
          {current.kind === 'voucher' && <VoucherLevel level={current} />}
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------- category */

function CategoryLevel({
  level,
  onOpenLedger,
}: {
  level: Extract<Level, { kind: 'category' }>;
  onOpenLedger: (id: string, label: string) => void;
}) {
  const { scopeQuery, currency } = useApp();
  const [data, setData] = useState<{ ledgers: any[]; total: number; period: { from: string; to: string } } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void (async () => {
      try {
        const res = await api.get<any>(`/finance/drilldown/category/${level.categoryKey}`, {
          ...scopeQuery,
          statement: level.statement ?? 'PL',
        });
        setData(res);
      } finally {
        setLoading(false);
      }
    })();
  }, [level.categoryKey, level.statement, scopeQuery.financialYearId, scopeQuery.periodType]);

  if (loading) return <LoadingPane />;
  if (!data || data.ledgers.length === 0)
    return <EmptyState icon={<FileText className="w-5 h-5" />} title="No ledgers in this category" description="Nothing is mapped here for the selected period." />;

  return (
    <div>
      <div className="px-5 py-3 border-b border-line flex items-center justify-between gap-3 bg-navy-50/40">
        <p className="text-xs text-ink-muted">
          {data.ledgers.length} ledger(s) · {data.period.from} to {data.period.to}
        </p>
        <p className="text-sm font-semibold tabular text-ink">{formatMoney(data.total, currency)}</p>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line">
            <th className="text-left px-5 py-2.5 label-text">Ledger</th>
            <th className="text-right px-4 py-2.5 label-text">Debit</th>
            <th className="text-right px-4 py-2.5 label-text">Credit</th>
            <th className="text-right px-4 py-2.5 label-text">Balance</th>
            <th className="text-right px-4 py-2.5 label-text">Entries</th>
          </tr>
        </thead>
        <tbody>
          {data.ledgers.map((l: any) => (
            <tr
              key={l.ledgerId}
              onClick={() => onOpenLedger(l.ledgerId, l.ledgerName)}
              className="border-b border-line/60 hover:bg-brand-50/40 cursor-pointer transition-colors"
            >
              <td className="px-5 py-2.5">
                <p className="text-ink">{l.ledgerName}</p>
                <p className="text-2xs text-ink-subtle">{l.groupName ?? 'no group'}</p>
              </td>
              <td className="px-4 py-2.5 text-right tabular text-ink-muted">{formatAmount(l.debit, currency)}</td>
              <td className="px-4 py-2.5 text-right tabular text-ink-muted">{formatAmount(l.credit, currency)}</td>
              <td className="px-4 py-2.5 text-right tabular font-medium text-ink">{formatAmount(l.closing, currency)}</td>
              <td className="px-4 py-2.5 text-right tabular text-xs text-ink-subtle">{formatNumber(l.transactionCount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------------------------- ledger */

function LedgerLevel({
  level,
  onOpenVoucher,
}: {
  level: Extract<Level, { kind: 'ledger' }>;
  onOpenVoucher: (id: string, label: string) => void;
}) {
  const { scopeQuery, currency } = useApp();
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void (async () => {
      try {
        const res = await api.get<any>(`/finance/drilldown/ledger/${level.ledgerId}`, { ...scopeQuery, page, pageSize: 50 });
        setData(res);
      } finally {
        setLoading(false);
      }
    })();
  }, [level.ledgerId, page, scopeQuery.financialYearId, scopeQuery.periodType]);

  if (loading) return <LoadingPane />;
  if (!data) return null;

  return (
    <div>
      <div className="px-5 py-3 border-b border-line bg-navy-50/40 space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <MappingStatusBadge status={data.ledger.mappingStatus} />
            {data.ledger.groupName && <Badge tone="neutral">{data.ledger.groupName}</Badge>}
          </div>
          <p className="text-xs text-ink-muted">
            Opening:{' '}
            <span className="tabular font-medium text-ink">
              {data.ledger.openingBalance === null
                ? 'not supplied'
                : `${formatAmount(data.ledger.openingBalance, currency)} ${data.ledger.openingSide ?? ''}`}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-5 text-xs">
          <span className="text-ink-muted">
            Debits <span className="tabular font-medium text-ink">{formatAmount(data.totals.debit, currency)}</span>
          </span>
          <span className="text-ink-muted">
            Credits <span className="tabular font-medium text-ink">{formatAmount(data.totals.credit, currency)}</span>
          </span>
          <span className="text-ink-muted">
            {formatNumber(data.pagination.total)} entr{data.pagination.total === 1 ? 'y' : 'ies'}
          </span>
        </div>
      </div>

      {data.transactions.length === 0 ? (
        <EmptyState icon={<Receipt className="w-5 h-5" />} title="No transactions in this period" />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left px-5 py-2.5 label-text">Date</th>
                <th className="text-left px-4 py-2.5 label-text">Voucher</th>
                <th className="text-left px-4 py-2.5 label-text">Narration</th>
                <th className="text-right px-4 py-2.5 label-text">Debit</th>
                <th className="text-right px-4 py-2.5 label-text">Credit</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t: any) => (
                <tr
                  key={t.id}
                  onClick={() => onOpenVoucher(t.voucherId, `${t.voucherNumber ?? 'Voucher'} · ${t.date}`)}
                  className="border-b border-line/60 hover:bg-brand-50/40 cursor-pointer transition-colors"
                >
                  <td className="px-5 py-2.5 tabular text-xs whitespace-nowrap text-ink-muted">{formatDate(t.date)}</td>
                  <td className="px-4 py-2.5">
                    <p className="text-ink text-xs">{t.voucherNumber ?? '—'}</p>
                    <p className="text-2xs text-ink-subtle">{t.voucherType ?? ''}</p>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-ink-muted max-w-[200px] truncate">{t.narration ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular">{t.debit ? formatAmount(t.debit, currency) : ''}</td>
                  <td className="px-4 py-2.5 text-right tabular">{t.credit ? formatAmount(t.credit, currency) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination {...data.pagination} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- voucher */

function VoucherLevel({ level }: { level: Extract<Level, { kind: 'voucher' }> }) {
  const { currency } = useApp();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void (async () => {
      try {
        setData(await api.get<any>(`/finance/drilldown/voucher/${level.voucherId}`));
      } finally {
        setLoading(false);
      }
    })();
  }, [level.voucherId]);

  if (loading) return <LoadingPane />;
  if (!data) return null;

  return (
    <div className="p-5 space-y-4">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Detail label="Date" value={formatDate(data.voucher.date)} />
        <Detail label="Type" value={data.voucher.voucherType ?? '—'} />
        <Detail label="Number" value={data.voucher.voucherNumber ?? '—'} />
        <Detail label="Reference" value={data.voucher.reference ?? '—'} />
      </dl>

      {data.voucher.narration && (
        <div>
          <p className="label-text mb-1">Narration</p>
          <p className="text-sm text-ink-muted leading-relaxed">{data.voucher.narration}</p>
        </div>
      )}

      <div className="rounded-card border border-line overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-navy-50/50">
              <th className="text-left px-4 py-2.5 label-text">Ledger</th>
              <th className="text-right px-4 py-2.5 label-text">Debit</th>
              <th className="text-right px-4 py-2.5 label-text">Credit</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l: any, i: number) => (
              <tr key={i} className="border-b border-line/60">
                <td className="px-4 py-2.5">
                  <p className="text-ink">{l.ledgerName}</p>
                  {l.costCentre && <p className="text-2xs text-ink-subtle">{l.costCentre}</p>}
                </td>
                <td className="px-4 py-2.5 text-right tabular">{l.debit ? formatAmount(l.debit, currency) : ''}</td>
                <td className="px-4 py-2.5 text-right tabular">{l.credit ? formatAmount(l.credit, currency) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={cx('border-t-2', data.totals.imbalance === 0 ? 'border-line bg-navy-50' : 'border-warning-border bg-warning-bg')}>
              <td className="px-4 py-2.5 text-xs font-medium">
                {data.totals.imbalance === 0 ? 'Balanced' : `Out of balance by ${formatAmount(Math.abs(data.totals.imbalance), currency)}`}
              </td>
              <td className="px-4 py-2.5 text-right tabular font-semibold">{formatAmount(data.totals.debit, currency)}</td>
              <td className="px-4 py-2.5 text-right tabular font-semibold">{formatAmount(data.totals.credit, currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {data.source && (
        <p className="text-xs text-ink-muted">
          Imported from <strong className="text-ink">{data.source.fileName}</strong> on {formatDate(data.source.importedAt?.slice(0, 10))}.
        </p>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label-text">{label}</dt>
      <dd className="text-sm text-ink mt-0.5 truncate">{value}</dd>
    </div>
  );
}

export { Button };
