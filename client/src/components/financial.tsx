import { Fragment, useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronRight, HelpCircle, Minus, ShieldAlert, Sigma, TriangleAlert } from 'lucide-react';
import { Badge, Callout, Card, Tooltip } from '@/components/ui';
import { cx, formatAmount, formatMoney, formatMoneyCompact, formatPercent, type CurrencyConfig } from '@/lib/format';

/* ------------------------------------------------------------------ KpiCard */

export interface KpiData {
  key: string;
  label: string;
  value: number | null;
  available: boolean;
  reason?: string;
  previousValue: number | null;
  variance: number | null;
  variancePercent: number | null;
  comparisonLabel: string | null;
  note?: string;
  link?: string;
  higherIsBetter?: boolean;
  isPercent?: boolean;
}

export function KpiCard({
  kpi,
  currency,
  onClick,
  featured,
}: {
  kpi: KpiData;
  currency: CurrencyConfig;
  onClick?: () => void;
  featured?: boolean;
}) {
  const clickable = Boolean(onClick) && kpi.available;

  const display = !kpi.available
    ? null
    : kpi.isPercent
      ? `${kpi.value ?? 0}%`
      : formatMoneyCompact(kpi.value, currency);

  const exact = kpi.available && !kpi.isPercent ? formatMoney(kpi.value, currency) : null;

  // Direction is only meaningful when a valid comparison exists; §7 forbids
  // inventing a percentage where the previous period has no data.
  const hasTrend = kpi.available && kpi.variance !== null && kpi.previousValue !== null;
  const rising = (kpi.variance ?? 0) > 0;
  const flat = (kpi.variance ?? 0) === 0;
  const good = kpi.higherIsBetter === false ? !rising : rising;

  return (
    <Card
      className={cx(
        'p-4 flex flex-col justify-between min-h-[118px] relative overflow-hidden',
        clickable && 'card-interactive cursor-pointer',
        featured && 'border-brand-200',
      )}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      {featured && <div className="absolute inset-x-0 top-0 h-0.5 bg-brand-gradient" aria-hidden />}

      <div className="flex items-start justify-between gap-2">
        <p className="label-text truncate">{kpi.label}</p>
        {!kpi.available && kpi.reason && (
          <Tooltip content={kpi.reason}>
            <HelpCircle className="w-3.5 h-3.5 text-ink-subtle shrink-0" />
          </Tooltip>
        )}
      </div>

      <div className="mt-2">
        {kpi.available ? (
          exact ? (
            <Tooltip content={exact}>
              <p className="text-2xl font-semibold text-ink tabular leading-tight cursor-default">{display}</p>
            </Tooltip>
          ) : (
            <p className="text-2xl font-semibold text-ink tabular leading-tight">{display}</p>
          )
        ) : (
          <p className="text-sm font-medium text-ink-subtle leading-tight py-1.5">Data unavailable</p>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 min-h-[18px]">
        {hasTrend ? (
          <span
            className={cx(
              'inline-flex items-center gap-1 text-xs font-medium tabular',
              flat ? 'text-ink-muted' : good ? 'text-positive' : 'text-danger',
            )}
          >
            {flat ? <Minus className="w-3 h-3" /> : rising ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {kpi.variancePercent !== null ? formatPercent(Math.abs(kpi.variancePercent)) : formatMoneyCompact(Math.abs(kpi.variance ?? 0), currency)}
            <span className="text-ink-subtle font-normal">{kpi.comparisonLabel}</span>
          </span>
        ) : kpi.available && kpi.note ? (
          <span className="text-2xs text-ink-subtle truncate">{kpi.note}</span>
        ) : kpi.available ? (
          <span className="text-2xs text-ink-subtle">No comparable prior period</span>
        ) : (
          <span />
        )}
        {clickable && <ChevronRight className="w-3.5 h-3.5 text-ink-subtle shrink-0" />}
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------- quality banner */

export interface DataQuality {
  unmappedLedgerCount: number;
  unmappedNet: number;
  suggestedLedgerCount: number;
  suggestedNet: number;
  ledgersWithoutOpeningBalance: number;
  warnings: string[];
}

export function DataQualityBanner({
  quality,
  currency,
  onFix,
  className,
}: {
  quality?: DataQuality | null;
  currency: CurrencyConfig;
  onFix?: () => void;
  className?: string;
}) {
  if (!quality || quality.warnings.length === 0) return null;

  const severe = quality.unmappedLedgerCount > 0;

  return (
    <Callout
      tone={severe ? 'warning' : 'info'}
      title={severe ? 'These figures are incomplete' : 'A note on these figures'}
      className={className}
      actions={
        onFix && (
          <button onClick={onFix} className="text-xs font-semibold underline underline-offset-2 hover:opacity-80">
            Open Account Mapping
          </button>
        )
      }
    >
      <ul className="space-y-1 list-disc list-inside">
        {quality.warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
      {quality.unmappedLedgerCount > 0 && quality.unmappedNet !== 0 && (
        <p className="mt-1.5 font-medium">
          Excluded balance: {formatMoney(Math.abs(quality.unmappedNet), currency)}
        </p>
      )}
    </Callout>
  );
}

/* ---------------------------------------------------------- statement table */

export interface StatementLineData {
  key: string;
  label: string;
  value: number | null;
  available: boolean;
  formula: string;
  kind: 'detail' | 'subtotal' | 'total';
  indent: number;
  emphasis?: boolean;
  note?: string;
  previousValue?: number | null;
  variance?: number | null;
  variancePercent?: number | null;
  children?: { categoryKey: string; label: string; total: number; ledgerCount: number }[];
}

export function StatementTable({
  lines,
  currency,
  comparisonLabel,
  onDrill,
  showFormula = true,
}: {
  lines: StatementLineData[];
  currency: CurrencyConfig;
  comparisonLabel?: string | null;
  onDrill?: (categoryKey: string, label: string) => void;
  showFormula?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const hasComparison = lines.some((l) => l.previousValue !== undefined && l.previousValue !== null);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line">
            <th className="text-left px-5 py-2.5 label-text">Line</th>
            <th className="text-right px-4 py-2.5 label-text whitespace-nowrap">This period</th>
            {hasComparison && <th className="text-right px-4 py-2.5 label-text whitespace-nowrap">{comparisonLabel ?? 'Previous'}</th>}
            {hasComparison && <th className="text-right px-4 py-2.5 label-text whitespace-nowrap">Variance</th>}
            {hasComparison && <th className="text-right px-4 py-2.5 label-text whitespace-nowrap">%</th>}
            {showFormula && <th className="text-left px-4 py-2.5 label-text w-8" />}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const isTotal = line.kind === 'total';
            const isSubtotal = line.kind === 'subtotal';
            const canExpand = Boolean(line.children?.length) && Boolean(onDrill);
            const isOpen = expanded.has(line.key);

            return (
              <Fragment key={line.key}>
                <tr
                  className={cx(
                    'border-b border-line/70 transition-colors',
                    isTotal && 'bg-navy-50 font-semibold',
                    isSubtotal && 'bg-navy-50/40 font-medium',
                    !isTotal && !isSubtotal && 'hover:bg-navy-50/40',
                  )}
                >
                  <td className="px-5 py-2.5" style={{ paddingLeft: `${1.25 + line.indent * 1}rem` }}>
                    <div className="flex items-center gap-1.5">
                      {canExpand ? (
                        <button
                          onClick={() => toggle(line.key)}
                          className="inline-flex items-center gap-1.5 text-left hover:text-brand transition-colors group"
                          aria-expanded={isOpen}
                        >
                          <ChevronRight className={cx('w-3.5 h-3.5 text-ink-subtle transition-transform shrink-0', isOpen && 'rotate-90')} />
                          <span className={cx(line.emphasis && 'text-navy-900')}>{line.label}</span>
                        </button>
                      ) : (
                        <span className={cx('pl-5', line.emphasis && 'text-navy-900')}>{line.label}</span>
                      )}
                      {line.note && (
                        <Tooltip content={line.note}>
                          <TriangleAlert className="w-3 h-3 text-warning shrink-0" />
                        </Tooltip>
                      )}
                    </div>
                  </td>

                  <td className={cx('px-4 py-2.5 text-right tabular whitespace-nowrap', !line.available && 'text-ink-subtle text-xs')}>
                    {line.available ? formatAmount(line.value, currency) : 'Data unavailable'}
                  </td>

                  {hasComparison && (
                    <td className="px-4 py-2.5 text-right tabular whitespace-nowrap text-ink-muted">
                      {line.previousValue !== undefined && line.previousValue !== null ? formatAmount(line.previousValue, currency) : '—'}
                    </td>
                  )}
                  {hasComparison && (
                    <td
                      className={cx(
                        'px-4 py-2.5 text-right tabular whitespace-nowrap',
                        line.variance === null || line.variance === undefined
                          ? 'text-ink-subtle'
                          : line.variance > 0
                            ? 'text-positive'
                            : line.variance < 0
                              ? 'text-danger'
                              : 'text-ink-muted',
                      )}
                    >
                      {line.variance !== null && line.variance !== undefined ? formatAmount(line.variance, currency) : '—'}
                    </td>
                  )}
                  {hasComparison && (
                    <td className="px-4 py-2.5 text-right tabular whitespace-nowrap text-ink-muted text-xs">
                      {line.variancePercent !== null && line.variancePercent !== undefined ? formatPercent(line.variancePercent, { showSign: true }) : '—'}
                    </td>
                  )}

                  {showFormula && (
                    <td className="px-4 py-2.5">
                      <Tooltip content={line.formula}>
                        <Sigma className="w-3.5 h-3.5 text-ink-subtle hover:text-brand transition-colors" />
                      </Tooltip>
                    </td>
                  )}
                </tr>

                {isOpen &&
                  line.children?.map((child) => (
                    <tr key={`${line.key}-${child.categoryKey}`} className="border-b border-line/50 bg-navy-50/20">
                      <td className="py-2 text-xs" style={{ paddingLeft: `${2.75 + line.indent}rem`, paddingRight: '1.25rem' }}>
                        <button
                          onClick={() => onDrill?.(child.categoryKey, child.label)}
                          className="text-left text-ink-muted hover:text-brand transition-colors inline-flex items-center gap-1.5"
                        >
                          {child.label}
                          <span className="text-ink-subtle">
                            ({child.ledgerCount} ledger{child.ledgerCount === 1 ? '' : 's'})
                          </span>
                          <ChevronRight className="w-3 h-3" />
                        </button>
                      </td>
                      <td className="px-4 py-2 text-right tabular text-xs text-ink-muted whitespace-nowrap">
                        {formatAmount(child.total, currency)}
                      </td>
                      {hasComparison && <td colSpan={3} />}
                      {showFormula && <td />}
                    </tr>
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------- mapping badge */

export function MappingStatusBadge({ status }: { status: 'confirmed' | 'suggested' | 'unmapped' }) {
  if (status === 'confirmed') return <Badge tone="positive">Confirmed</Badge>;
  if (status === 'suggested')
    return (
      <Badge tone="warning" icon={<ShieldAlert className="w-3 h-3" />}>
        Unconfirmed
      </Badge>
    );
  return <Badge tone="danger">No category</Badge>;
}

/* ------------------------------------------------------------- page header */

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
          {description && <p className="text-xs text-ink-muted mt-1 max-w-3xl leading-relaxed">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0 no-print">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/* --------------------------------------------------------- explainer panel */

/**
 * §26 asks every complex feature to say what it does, why it matters, what it
 * needs and what to do next. This renders that consistently.
 */
export function Explainer({
  what,
  why,
  needs,
  next,
  className,
}: {
  what: string;
  why: string;
  needs?: string;
  next?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cx('rounded-card border border-line bg-navy-50/40', className)}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left"
        aria-expanded={open}
      >
        <span className="text-xs font-medium text-ink inline-flex items-center gap-2">
          <HelpCircle className="w-3.5 h-3.5 text-ink-muted" />
          About this page
        </span>
        <ChevronRight className={cx('w-3.5 h-3.5 text-ink-muted transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <dl className="px-4 pb-3.5 pt-0.5 space-y-2 text-xs leading-relaxed animate-fade-in">
          <div>
            <dt className="font-semibold text-ink">What it does</dt>
            <dd className="text-ink-muted">{what}</dd>
          </div>
          <div>
            <dt className="font-semibold text-ink">Why it matters</dt>
            <dd className="text-ink-muted">{why}</dd>
          </div>
          {needs && (
            <div>
              <dt className="font-semibold text-ink">What it needs</dt>
              <dd className="text-ink-muted">{needs}</dd>
            </div>
          )}
          {next && (
            <div>
              <dt className="font-semibold text-ink">What to do next</dt>
              <dd className="text-ink-muted">{next}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
