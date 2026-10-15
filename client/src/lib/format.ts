/**
 * Presentation of money, dates and measures.
 *
 * Amounts arrive from the API as integer MINOR units (paise). They are converted
 * here, at the last possible moment, and never used for arithmetic afterwards.
 *
 * `null` means the server could not compute the figure. It is shown as
 * "Data unavailable", never as ₹0.00 — the difference between a real zero balance
 * and an unimported one is the difference between a correct report and a wrong one.
 */

export interface CurrencyConfig {
  currency: string;
  scale: number;
}

export const DEFAULT_CURRENCY: CurrencyConfig = { currency: 'INR', scale: 2 };

export const UNAVAILABLE = 'Data unavailable';

function localeFor(currency: string): string {
  return currency === 'INR' ? 'en-IN' : 'en-US';
}

/** Full precision, with the currency symbol. */
export function formatMoney(
  minor: number | null | undefined,
  config: CurrencyConfig = DEFAULT_CURRENCY,
  opts: { showSign?: boolean; unavailableText?: string } = {},
): string {
  if (minor === null || minor === undefined) return opts.unavailableText ?? UNAVAILABLE;

  const value = minor / Math.pow(10, config.scale);
  const formatted = new Intl.NumberFormat(localeFor(config.currency), {
    style: 'currency',
    currency: config.currency,
    minimumFractionDigits: config.scale,
    maximumFractionDigits: config.scale,
  }).format(Math.abs(value));

  if (value < 0) return `(${formatted})`;
  if (opts.showSign && value > 0) return `+${formatted}`;
  return formatted;
}

/** Compact form for KPI cards: ₹1.2 Cr, ₹45.3 L, ₹8,200. */
export function formatMoneyCompact(
  minor: number | null | undefined,
  config: CurrencyConfig = DEFAULT_CURRENCY,
  opts: { unavailableText?: string } = {},
): string {
  if (minor === null || minor === undefined) return opts.unavailableText ?? UNAVAILABLE;

  const value = minor / Math.pow(10, config.scale);
  const abs = Math.abs(value);
  const symbol = currencySymbol(config.currency);
  const sign = value < 0 ? '-' : '';

  if (config.currency === 'INR') {
    // Indian readers scan in lakh and crore, not million and billion.
    if (abs >= 1_00_00_000) return `${sign}${symbol}${trim(abs / 1_00_00_000)} Cr`;
    if (abs >= 1_00_000) return `${sign}${symbol}${trim(abs / 1_00_000)} L`;
  } else {
    if (abs >= 1_000_000_000) return `${sign}${symbol}${trim(abs / 1_000_000_000)}B`;
    if (abs >= 1_000_000) return `${sign}${symbol}${trim(abs / 1_000_000)}M`;
    if (abs >= 1_000) return `${sign}${symbol}${trim(abs / 1_000)}K`;
  }

  return `${sign}${symbol}${new Intl.NumberFormat(localeFor(config.currency), {
    minimumFractionDigits: 0,
    maximumFractionDigits: abs < 100 ? 2 : 0,
  }).format(abs)}`;
}

function trim(n: number): string {
  const r = Math.round(n * 100) / 100;
  return r % 1 === 0 ? String(r) : r.toFixed(r >= 100 ? 0 : r >= 10 ? 1 : 2);
}

export function currencySymbol(currency: string): string {
  const map: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'د.إ', SGD: 'S$' };
  return map[currency] ?? `${currency} `;
}

/** Number without a currency symbol, for table columns under a currency header. */
export function formatAmount(
  minor: number | null | undefined,
  config: CurrencyConfig = DEFAULT_CURRENCY,
  opts: { unavailableText?: string } = {},
): string {
  if (minor === null || minor === undefined) return opts.unavailableText ?? '—';
  const value = minor / Math.pow(10, config.scale);
  const formatted = new Intl.NumberFormat(localeFor(config.currency), {
    minimumFractionDigits: config.scale,
    maximumFractionDigits: config.scale,
  }).format(Math.abs(value));
  return value < 0 ? `(${formatted})` : formatted;
}

export function formatPercent(value: number | null | undefined, opts: { digits?: number; showSign?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  const digits = opts.digits ?? 1;
  const sign = opts.showSign && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatRatio(value: number | null | undefined, unit: 'times' | 'percent' | 'days'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  if (unit === 'percent') return `${value.toFixed(1)}%`;
  if (unit === 'days') return `${Math.round(value)} days`;
  return `${value.toFixed(2)}×`;
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(iso: string | null | undefined, opts: { fallback?: string } = {}): string {
  if (!iso) return opts.fallback ?? '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!m || !d) return iso;
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return `${formatDate(dt.toISOString())} at ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

/** "3 days ago", "just now" — for data freshness. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;

  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(seconds / 86400);
  if (d < 31) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const yr = Math.floor(d / 365);
  return `${yr} year${yr === 1 ? '' : 's'} ago`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Chart axes need plain numbers in major units. */
export function toMajor(minor: number, scale = 2): number {
  return minor / Math.pow(10, scale);
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
