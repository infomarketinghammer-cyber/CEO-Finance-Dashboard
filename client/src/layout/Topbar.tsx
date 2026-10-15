import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  Building2,
  Calendar,
  ChevronDown,
  Database,
  LogOut,
  Menu,
  Search,
  Upload,
  UserCircle2,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useApp, type PeriodType } from '@/state/AppContext';
import { Badge, Button, Tooltip } from '@/components/ui';
import { cx, formatRelative } from '@/lib/format';
import { findNavItem, visibleGroups } from './navigation';

const PERIOD_LABELS: Record<PeriodType, string> = {
  financial_year: 'Full financial year',
  quarter: 'Quarter to date',
  month: 'Month',
  custom: 'Custom range',
};

export function Topbar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const { user, company, companies, selectCompany, financialYear, financialYears, selectFinancialYear, period, setPeriod, logout, can } = useApp();
  const navigate = useNavigate();
  const location = useLocation();

  const [unread, setUnread] = useState(0);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const showFinanceControls = can('dashboard.view') || can('statements.view');

  // Unread alerts and data freshness, kept light: no polling loop.
  useEffect(() => {
    if (!company || !can('alerts.view')) return;
    let cancelled = false;

    void (async () => {
      try {
        const res = await api.get<{ unreadCount: number }>('/alerts', { companyId: company.id, refresh: 'false' });
        if (!cancelled) setUnread(res.unreadCount);
      } catch {
        /* the badge is not worth an error */
      }
    })();

    void (async () => {
      try {
        const res = await api.get<{ batches: { completedAt: string | null; status: string }[] }>('/imports/batches', {
          companyId: company.id,
          status: 'committed',
          pageSize: 1,
        });
        if (!cancelled) setLastImport(res.batches[0]?.completedAt ?? null);
      } catch {
        /* likewise */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [company, location.pathname, can]);

  return (
    <header className="sticky top-0 z-20 bg-surface/90 backdrop-blur-md border-b border-line no-print">
      <div className="flex items-center gap-2 h-[61px] px-3 sm:px-4">
        <button
          onClick={onOpenMobileNav}
          className="lg:hidden p-2 -ml-1 text-ink-muted hover:text-ink rounded-control hover:bg-navy-50"
          aria-label="Open navigation"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* ---- company ---- */}
        {companies.length > 0 && (
          <Dropdown
            trigger={
              <button className="flex items-center gap-2 px-2.5 h-9 rounded-control hover:bg-navy-50 transition-colors max-w-[190px] sm:max-w-[240px]">
                <Building2 className="w-4 h-4 text-ink-muted shrink-0" />
                <span className="text-sm font-medium text-ink truncate">{company?.name ?? 'Select a company'}</span>
                {company?.isDemo && <Badge tone="warning">Demo</Badge>}
                <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0" />
              </button>
            }
          >
            {(close) => (
              <div className="w-64">
                <p className="label-text px-3 pt-2.5 pb-1.5">Company</p>
                <ul className="max-h-72 overflow-y-auto pb-1">
                  {companies.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => {
                          selectCompany(c.id);
                          close();
                        }}
                        className={cx(
                          'w-full text-left px-3 py-2 text-sm hover:bg-navy-50 transition-colors flex items-center justify-between gap-2',
                          c.id === company?.id && 'bg-brand-50 text-brand-700 font-medium',
                        )}
                      >
                        <span className="truncate">{c.name}</span>
                        {c.isDemo && <Badge tone="warning">Demo</Badge>}
                      </button>
                    </li>
                  ))}
                </ul>
                {can('companies.manage') && (
                  <div className="border-t border-line p-1.5">
                    <Link
                      to="/companies"
                      onClick={close}
                      className="block px-2 py-1.5 text-xs text-brand hover:bg-brand-50 rounded-control transition-colors"
                    >
                      Manage companies and financial years
                    </Link>
                  </div>
                )}
              </div>
            )}
          </Dropdown>
        )}

        {/* ---- financial year ---- */}
        {showFinanceControls && financialYears.length > 0 && (
          <Dropdown
            trigger={
              <button className="hidden sm:flex items-center gap-2 px-2.5 h-9 rounded-control hover:bg-navy-50 transition-colors">
                <Calendar className="w-4 h-4 text-ink-muted shrink-0" />
                <span className="text-sm text-ink whitespace-nowrap">{financialYear?.label ?? 'Financial year'}</span>
                <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
              </button>
            }
          >
            {(close) => (
              <div className="w-60">
                <p className="label-text px-3 pt-2.5 pb-1.5">Financial year</p>
                <ul className="max-h-60 overflow-y-auto pb-1">
                  {financialYears.map((f) => (
                    <li key={f.id}>
                      <button
                        onClick={() => {
                          selectFinancialYear(f.id);
                          close();
                        }}
                        className={cx(
                          'w-full text-left px-3 py-2 hover:bg-navy-50 transition-colors',
                          f.id === financialYear?.id && 'bg-brand-50 text-brand-700 font-medium',
                        )}
                      >
                        <span className="text-sm block">{f.label}</span>
                        <span className="text-2xs text-ink-muted tabular">
                          {f.startDate} to {f.endDate}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="border-t border-line pt-1.5 pb-1">
                  <p className="label-text px-3 pb-1.5">Reporting period</p>
                  {(['financial_year', 'quarter', 'month'] as PeriodType[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setPeriod({ type: p });
                        close();
                      }}
                      className={cx(
                        'w-full text-left px-3 py-1.5 text-sm hover:bg-navy-50 transition-colors',
                        period.type === p && 'text-brand font-medium',
                      )}
                    >
                      {PERIOD_LABELS[p]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Dropdown>
        )}

        <div className="flex-1" />

        {/* ---- data source ---- */}
        {company && (
          <Tooltip
            content={
              lastImport
                ? `All figures come from Excel imports. The most recent completed ${formatRelative(lastImport)}. No accounting system is connected.`
                : 'All figures come from Excel imports. Nothing has been imported for this company yet.'
            }
          >
            <div className="hidden md:flex items-center gap-1.5 px-2.5 h-8 rounded-full bg-navy-50 border border-line">
              <Database className="w-3.5 h-3.5 text-ink-muted" />
              <span className="text-2xs font-medium text-ink-muted whitespace-nowrap">Excel Import</span>
              <span className="w-px h-3 bg-line-strong" aria-hidden />
              <span className="text-2xs text-ink-subtle whitespace-nowrap">{lastImport ? formatRelative(lastImport) : 'no data'}</span>
            </div>
          </Tooltip>
        )}

        {/* ---- global search ---- */}
        {showFinanceControls && (
          <button
            onClick={() => setSearchOpen(true)}
            className="hidden sm:flex items-center gap-2 h-9 px-2.5 rounded-control hover:bg-navy-50 text-ink-muted transition-colors"
            aria-label="Search modules"
          >
            <Search className="w-4 h-4" />
          </button>
        )}

        {/* ---- quick action ---- */}
        {can('imports.create') && (
          <Button variant="primary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => navigate('/import')} className="hidden sm:inline-flex">
            Import Excel
          </Button>
        )}

        {/* ---- notifications ---- */}
        {can('alerts.view') && (
          <button
            onClick={() => navigate('/alerts')}
            className="relative p-2 text-ink-muted hover:text-ink rounded-control hover:bg-navy-50 transition-colors"
            aria-label={`Alerts${unread ? `, ${unread} unread` : ''}`}
          >
            <Bell className="w-[18px] h-[18px]" />
            {unread > 0 && (
              <span className="absolute top-1 right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-danger text-white text-[9px] font-semibold flex items-center justify-center tabular">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
        )}

        {/* ---- profile ---- */}
        <Dropdown
          align="right"
          trigger={
            <button className="flex items-center gap-2 pl-1.5 pr-2 h-9 rounded-control hover:bg-navy-50 transition-colors">
              <span className="w-7 h-7 rounded-full bg-navy-gradient text-white text-2xs font-semibold flex items-center justify-center shrink-0">
                {initials(user?.name ?? '')}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-ink-muted hidden sm:block" />
            </button>
          }
        >
          {(close) => (
            <div className="w-60">
              <div className="px-3 py-2.5 border-b border-line">
                <p className="text-sm font-medium text-ink truncate">{user?.name}</p>
                <p className="text-xs text-ink-muted truncate">{user?.email}</p>
                <Badge tone="brand" className="mt-1.5">
                  {user?.roleLabel}
                </Badge>
              </div>
              <div className="p-1.5">
                <button
                  onClick={() => {
                    close();
                    navigate('/profile');
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-ink-muted hover:bg-navy-50 hover:text-ink rounded-control transition-colors"
                >
                  <UserCircle2 className="w-4 h-4" />
                  Your profile
                </button>
                <button
                  onClick={() => {
                    close();
                    void logout();
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-danger hover:bg-danger-bg rounded-control transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </Dropdown>
      </div>

      {searchOpen && <ModuleSearch onClose={() => setSearchOpen(false)} />}
    </header>
  );
}

/* ---------------------------------------------------------------- dropdown */

function Dropdown({
  trigger,
  children,
  align = 'left',
}: {
  trigger: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          className={cx(
            'absolute top-full mt-1.5 bg-surface border border-line rounded-card shadow-dropdown z-40 animate-slide-up overflow-hidden',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- module search */

function ModuleSearch({ onClose }: { onClose: () => void }) {
  const { user } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const all = visibleGroups(user?.capabilities ?? []).flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));
  const q = query.toLowerCase().trim();
  const results = q ? all.filter((i) => i.label.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)) : all;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4">
      <div className="absolute inset-0 bg-navy-950/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-lg bg-surface border border-line rounded-card shadow-dropdown overflow-hidden animate-slide-up">
        <div className="flex items-center gap-2.5 px-4 border-b border-line">
          <Search className="w-4 h-4 text-ink-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search modules…"
            className="flex-1 h-12 bg-transparent text-sm text-ink placeholder:text-ink-subtle focus:outline-none"
          />
          <kbd className="text-2xs text-ink-subtle border border-line rounded px-1.5 py-0.5">Esc</kbd>
        </div>
        <ul className="max-h-[52vh] overflow-y-auto py-1.5">
          {results.length === 0 && <li className="px-4 py-6 text-center text-xs text-ink-muted">No module matches “{query}”.</li>}
          {results.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.path}>
                <button
                  onClick={() => {
                    navigate(item.path);
                    onClose();
                  }}
                  className="w-full flex items-start gap-3 px-4 py-2.5 hover:bg-navy-50 transition-colors text-left"
                >
                  <Icon className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm text-ink">{item.label}</span>
                    <span className="block text-xs text-ink-muted truncate">{item.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase() ?? '')
    .join('');
}

export { findNavItem };
