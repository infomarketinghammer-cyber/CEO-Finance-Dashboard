import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardHeader, EmptyState } from '@/components/ui';
import { formatMoneyCompact, formatMoney, toMajor, type CurrencyConfig } from '@/lib/format';

/**
 * Chart palette drawn from the logo: the brand blue leads, cyan and mint follow,
 * then navy and supporting tones. Series are distinguishable without relying on
 * colour alone — every chart also labels its axes and names its series in the
 * legend and tooltip.
 */
export const SERIES_COLORS = ['#0878F9', '#13C6D9', '#48E6A0', '#10264A', '#5FA3FB', '#0892B0', '#13B574', '#365390'];

export const POSITIVE = '#0F8A5F';
export const NEGATIVE = '#B91C1C';
const GRID = '#E4EAF2';
const AXIS = '#68758A';

const axisStyle = { fontSize: 11, fill: AXIS };

/**
 * Recharts' ResponsiveContainer clones its single child and injects the measured
 * width and height. That only works when the child IS a chart — cloning a wrapper
 * component silently drops the dimensions and the chart renders at zero size. So
 * each chart below owns its container and keeps a real chart element as the child.
 */
function Responsive({ children }: { children: React.ReactElement }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      {children}
    </ResponsiveContainer>
  );
}

export function ChartCard({
  title,
  description,
  actions,
  children,
  empty,
  emptyMessage,
  height = 260,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  empty?: boolean;
  emptyMessage?: string;
  height?: number;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader title={title} description={description} actions={actions} />
      {empty ? (
        <EmptyState title="Nothing to chart yet" description={emptyMessage ?? 'Import the relevant data to populate this view.'} />
      ) : (
        <div className="p-4" style={{ height }}>
          {children}
        </div>
      )}
    </Card>
  );
}

function MoneyTooltip({ active, payload, label, currency }: any & { currency: CurrencyConfig }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-line rounded-control shadow-dropdown px-3 py-2 text-xs">
      <p className="font-semibold text-ink mb-1.5">{label}</p>
      <div className="space-y-1">
        {payload.map((p: any, i: number) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <span className="inline-flex items-center gap-1.5 text-ink-muted">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.color ?? p.fill }} />
              {p.name}
            </span>
            <span className="tabular font-medium text-ink">
              {formatMoney(Math.round((p.value ?? 0) * Math.pow(10, currency.scale)), currency)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- trend (money) */

export function TrendChart({
  data,
  currency,
  series,
  type = 'line',
}: {
  data: { label: string; [k: string]: string | number | boolean | null }[];
  currency: CurrencyConfig;
  series: { key: string; name: string; color?: string }[];
  type?: 'line' | 'area' | 'bar';
}) {
  const rows = data.map((d) => {
    const row: Record<string, string | number> = { label: String(d.label) };
    for (const s of series) {
      const v = d[s.key];
      row[s.key] = typeof v === 'number' ? toMajor(v, currency.scale) : 0;
    }
    return row;
  });

  const tickFormatter = (v: number) => formatMoneyCompact(Math.round(v * Math.pow(10, currency.scale)), currency);

  if (type === 'bar') {
    return (
      <Responsive>
      <BarChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={tickFormatter} width={64} />
        <RTooltip content={<MoneyTooltip currency={currency} />} cursor={{ fill: 'rgba(8,120,249,0.05)' }} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="square" iconSize={9} />
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]} radius={[3, 3, 0, 0]} maxBarSize={44} />
        ))}
      </BarChart>
      </Responsive>
    );
  }

  if (type === 'area') {
    return (
      <Responsive>
      <AreaChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0.26} />
              <stop offset="95%" stopColor={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={tickFormatter} width={64} />
        <RTooltip content={<MoneyTooltip currency={currency} />} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="square" iconSize={9} />
        {series.map((s, i) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
            strokeWidth={2}
            fill={`url(#grad-${s.key})`}
          />
        ))}
      </AreaChart>
      </Responsive>
    );
  }

  return (
    <Responsive>
    <LineChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
      <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: GRID }} />
      <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={tickFormatter} width={64} />
      <RTooltip content={<MoneyTooltip currency={currency} />} />
      <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="plainline" iconSize={14} />
      {series.map((s, i) => (
        <Line
          key={s.key}
          type="monotone"
          dataKey={s.key}
          name={s.name}
          stroke={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
          strokeWidth={2}
          dot={{ r: 2.5, strokeWidth: 0 }}
          activeDot={{ r: 4 }}
        />
      ))}
    </LineChart>
    </Responsive>
  );
}

/* ----------------------------------------------------------------- donut */

export function DonutChart({
  data,
  currency,
  onSliceClick,
}: {
  data: { label: string; value: number; categoryKey?: string }[];
  currency: CurrencyConfig;
  onSliceClick?: (categoryKey: string, label: string) => void;
}) {
  const rows = data.map((d) => ({ ...d, major: toMajor(Math.abs(d.value), currency.scale) }));

  return (
    <Responsive>
    <PieChart>
      <Pie
        data={rows}
        dataKey="major"
        nameKey="label"
        innerRadius="54%"
        outerRadius="80%"
        paddingAngle={2}
        onClick={(entry: any) => entry?.categoryKey && onSliceClick?.(entry.categoryKey, entry.label)}
        cursor={onSliceClick ? 'pointer' : undefined}
      >
        {rows.map((_, i) => (
          <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} stroke="#fff" strokeWidth={2} />
        ))}
      </Pie>
      <RTooltip content={<MoneyTooltip currency={currency} />} />
      <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} layout="vertical" align="right" verticalAlign="middle" />
    </PieChart>
    </Responsive>
  );
}

/* --------------------------------------------------------------- ageing */

export function AgeingChart({
  buckets,
  currency,
  onBucketClick,
}: {
  buckets: { key: string; label: string; total: number; count: number }[];
  currency: CurrencyConfig;
  onBucketClick?: (key: string) => void;
}) {
  const rows = buckets.map((b) => ({ ...b, major: toMajor(b.total, currency.scale) }));

  // Not-due is reassuring; overdue buckets darken as they age; "no due date" is
  // deliberately neutral because it is a data gap rather than a risk level.
  const colorFor = (key: string) => {
    if (key === 'not_due') return POSITIVE;
    if (key === 'no_due_date') return '#94A1B4';
    if (key === 'd1_30') return '#F0B429';
    if (key === 'd31_60') return '#DE911D';
    if (key === 'd61_90') return '#CB6E17';
    return NEGATIVE;
  };

  return (
    <Responsive>
    <BarChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
      <XAxis dataKey="label" tick={{ ...axisStyle, fontSize: 10 }} tickLine={false} axisLine={{ stroke: GRID }} interval={0} angle={-12} textAnchor="end" height={48} />
      <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatMoneyCompact(Math.round(v * Math.pow(10, currency.scale)), currency)} width={64} />
      <RTooltip content={<MoneyTooltip currency={currency} />} cursor={{ fill: 'rgba(8,120,249,0.05)' }} />
      <Bar
        dataKey="major"
        name="Outstanding"
        radius={[3, 3, 0, 0]}
        maxBarSize={56}
        cursor={onBucketClick ? 'pointer' : undefined}
        onClick={(entry: any) => entry?.key && onBucketClick?.(entry.key)}
      >
        {rows.map((r) => (
          <Cell key={r.key} fill={colorFor(r.key)} />
        ))}
      </Bar>
    </BarChart>
    </Responsive>
  );
}

/* ------------------------------------------------------- forecast scenarios */

export function ForecastChart({
  days,
  currency,
  threshold,
}: {
  days: { date: string; best: number; expected: number; worst: number }[];
  currency: CurrencyConfig;
  threshold?: number | null;
}) {
  const rows = days.map((d) => ({
    label: d.date.slice(8, 10) + '/' + d.date.slice(5, 7),
    best: toMajor(d.best, currency.scale),
    expected: toMajor(d.expected, currency.scale),
    worst: toMajor(d.worst, currency.scale),
    threshold: threshold !== null && threshold !== undefined ? toMajor(threshold, currency.scale) : undefined,
  }));

  return (
    <Responsive>
    <LineChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
      <XAxis dataKey="label" tick={{ ...axisStyle, fontSize: 10 }} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={28} />
      <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatMoneyCompact(Math.round(v * Math.pow(10, currency.scale)), currency)} width={64} />
      <RTooltip content={<MoneyTooltip currency={currency} />} />
      <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="plainline" iconSize={14} />
      <Line type="monotone" dataKey="best" name="Best case" stroke={POSITIVE} strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
      <Line type="monotone" dataKey="expected" name="Expected case" stroke="#0878F9" strokeWidth={2.5} dot={false} />
      <Line type="monotone" dataKey="worst" name="Worst case" stroke={NEGATIVE} strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
      {threshold !== null && threshold !== undefined && (
        <Line type="monotone" dataKey="threshold" name="Minimum cash" stroke="#68758A" strokeWidth={1} dot={false} strokeDasharray="2 4" />
      )}
    </LineChart>
    </Responsive>
  );
}

/* ----------------------------------------------------- budget vs actual */

export function BudgetVsActualChart({
  data,
  currency,
}: {
  data: { category: string; budgeted: number; actual: number }[];
  currency: CurrencyConfig;
}) {
  const rows = data.map((d) => ({
    label: d.category,
    Budgeted: toMajor(d.budgeted, currency.scale),
    Actual: toMajor(d.actual, currency.scale),
  }));

  return (
    <Responsive>
    <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={GRID} horizontal={false} />
      <XAxis type="number" tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatMoneyCompact(Math.round(v * Math.pow(10, currency.scale)), currency)} />
      <YAxis type="category" dataKey="label" tick={{ ...axisStyle, fontSize: 10 }} tickLine={false} axisLine={false} width={108} />
      <RTooltip content={<MoneyTooltip currency={currency} />} cursor={{ fill: 'rgba(8,120,249,0.05)' }} />
      <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="square" iconSize={9} />
      <Bar dataKey="Budgeted" fill="#C3DDFC" radius={[0, 3, 3, 0]} maxBarSize={14} />
      <Bar dataKey="Actual" fill="#0878F9" radius={[0, 3, 3, 0]} maxBarSize={14} />
    </BarChart>
    </Responsive>
  );
}

/* ------------------------------------------------------ simple comparison */

export function ComparisonBars({
  items,
  currency,
}: {
  items: { label: string; value: number; color?: string }[];
  currency: CurrencyConfig;
}) {
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);

  return (
    <div className="space-y-3.5 p-1">
      {items.map((item, i) => (
        <div key={item.label}>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-ink-muted">{item.label}</span>
            <span className="tabular font-medium text-ink">{formatMoney(item.value, currency)}</span>
          </div>
          <div className="h-2 bg-navy-50 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${(Math.abs(item.value) / max) * 100}%`,
                background: item.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
