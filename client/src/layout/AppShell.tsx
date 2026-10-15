import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { findNavItem } from './navigation';
import { useApp } from '@/state/AppContext';
import { cx } from '@/lib/format';

export function AppShell() {
  const location = useLocation();
  const { company } = useApp();

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('dhyeya_nav_collapsed') === '1');
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem('dhyeya_nav_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  // A route change should never leave the drawer open behind the new page.
  useEffect(() => {
    setMobileOpen(false);
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  const current = findNavItem(location.pathname);
  const segments = location.pathname.split('/').filter(Boolean);
  const isNested = segments.length > 1;

  return (
    <div className="min-h-screen flex bg-page">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />

      <div className={cx('flex-1 min-w-0 flex flex-col')}>
        <Topbar onOpenMobileNav={() => setMobileOpen(true)} />

        <main className="flex-1 px-3 sm:px-5 lg:px-6 py-5 max-w-[1560px] w-full mx-auto">
          {(isNested || (current && current.path !== '/')) && (
            <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-xs text-ink-muted no-print">
              <Link to="/" className="inline-flex items-center gap-1 hover:text-ink transition-colors">
                <Home className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{company?.name ?? 'DHYEYA'}</span>
              </Link>
              {current && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 text-ink-subtle" />
                  <span className={cx(isNested ? 'hover:text-ink' : 'text-ink font-medium')}>
                    {isNested ? <Link to={current.path}>{current.label}</Link> : current.label}
                  </span>
                </>
              )}
              {isNested && segments.length > 1 && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 text-ink-subtle" />
                  <span className="text-ink font-medium capitalize">{decodeURIComponent(segments[segments.length - 1]).replace(/-/g, ' ')}</span>
                </>
              )}
            </nav>
          )}

          <Outlet />
        </main>

        <footer className="px-5 py-3.5 border-t border-line text-2xs text-ink-subtle no-print">
          <div className="max-w-[1560px] mx-auto flex flex-wrap items-center justify-between gap-2">
            <span>
              DHYEYA — Business and Executive Dashboard. Management reports produced from imported accounting data; not audited financial
              statements.
            </span>
            <span>Data source: Excel Import</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
