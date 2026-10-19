import { NavLink } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { LogoHorizontal, LogoMark } from '@/components/Logo';
import { Tooltip } from '@/components/ui';
import { useApp } from '@/state/AppContext';
import { visibleGroups } from './navigation';
import { cx } from '@/lib/format';

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onCloseMobile,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const { user } = useApp();
  const groups = visibleGroups(user?.capabilities ?? []);

  const content = (
    <nav className="flex flex-col h-full bg-surface border-r border-line" aria-label="Main navigation">
      {/* ---- logo ---- */}
      <div className={cx('flex items-center border-b border-line shrink-0', collapsed ? 'justify-center h-[61px] px-2' : 'justify-between h-[61px] px-4')}>
        {collapsed ? (
          <Tooltip content="ArthSetu — CEO Finance Dashboard" side="right">
            <LogoMark size={30} />
          </Tooltip>
        ) : (
          <>
            <LogoHorizontal markSize={32} />
            <button
              onClick={onCloseMobile}
              className="lg:hidden p-1.5 -mr-1.5 text-ink-muted hover:text-ink rounded-control hover:bg-navy-50"
              aria-label="Close navigation"
            >
              <X className="w-4 h-4" />
            </button>
          </>
        )}
      </div>

      {/* ---- modules ---- */}
      <div className="flex-1 overflow-y-auto py-3 px-2.5 space-y-4">
        {groups.map((group) => (
          <div key={group.label}>
            {!collapsed && <p className="label-text px-2.5 mb-1.5">{group.label}</p>}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const link = (
                  <NavLink
                    to={item.path}
                    end={item.path === '/'}
                    onClick={onCloseMobile}
                    className={({ isActive }) =>
                      cx(
                        'relative flex items-center gap-2.5 rounded-control text-sm transition-colors duration-150 group',
                        collapsed ? 'justify-center h-9 w-9 mx-auto' : 'px-2.5 py-2',
                        isActive
                          ? 'bg-brand-50 text-brand-700 font-medium'
                          : 'text-ink-muted hover:bg-navy-50 hover:text-ink',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && !collapsed && (
                          <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-brand-gradient" aria-hidden />
                        )}
                        <Icon className={cx('w-4 h-4 shrink-0', isActive && 'text-brand')} />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </>
                    )}
                  </NavLink>
                );

                return (
                  <li key={item.path}>
                    {collapsed ? (
                      <Tooltip content={item.label} side="right">
                        {link}
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {/* ---- collapse ---- */}
      <div className="border-t border-line p-2.5 shrink-0 hidden lg:block">
        <button
          onClick={onToggleCollapsed}
          className={cx(
            'flex items-center gap-2.5 w-full rounded-control text-xs text-ink-muted hover:bg-navy-50 hover:text-ink transition-colors',
            collapsed ? 'justify-center h-9' : 'px-2.5 py-2',
          )}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </nav>
  );

  return (
    <>
      {/* desktop rail */}
      <aside
        className={cx(
          'hidden lg:block shrink-0 transition-[width] duration-200 ease-out no-print',
          collapsed ? 'w-[60px]' : 'w-[232px]',
        )}
      >
        <div className={cx('fixed top-0 bottom-0 left-0 z-30', collapsed ? 'w-[60px]' : 'w-[232px]')}>{content}</div>
      </aside>

      {/* mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 no-print">
          <div className="absolute inset-0 bg-navy-950/40 backdrop-blur-[2px] animate-fade-in" onClick={onCloseMobile} aria-hidden />
          <div className="relative w-[262px] h-full animate-slide-up">{content}</div>
        </div>
      )}
    </>
  );
}
