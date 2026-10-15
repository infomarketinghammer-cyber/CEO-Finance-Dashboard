import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, Info, Loader2, X } from 'lucide-react';
import { cx } from '@/lib/format';

/* ------------------------------------------------------------------ Button */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'gradient';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-600 active:bg-brand-700 disabled:bg-brand-300 shadow-sm',
  secondary: 'bg-surface text-ink border border-line hover:bg-navy-50 hover:border-line-strong active:bg-navy-100 disabled:text-ink-subtle',
  ghost: 'text-ink-muted hover:bg-navy-50 hover:text-ink active:bg-navy-100',
  danger: 'bg-danger text-white hover:bg-red-800 active:bg-red-900 shadow-sm',
  gradient: 'bg-brand-gradient text-white hover:brightness-[1.06] active:brightness-95 shadow-sm',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconRight, fullWidth, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center font-medium rounded-control transition-all duration-150',
        'disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  );
});

/* -------------------------------------------------------------------- Card */

export function Card({
  className,
  children,
  as: As = 'div',
  ...rest
}: { className?: string; children: ReactNode; as?: 'div' | 'section' | 'article' } & Record<string, unknown>) {
  return (
    <As className={cx('card', className)} {...rest}>
      {children}
    </As>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex items-start justify-between gap-4 px-5 py-4 border-b border-line', className)}>
      <div className="min-w-0 flex items-start gap-3">
        {icon && <div className="shrink-0 mt-0.5 text-ink-muted">{icon}</div>}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink truncate">{title}</h2>
          {description && <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">{description}</p>}
        </div>
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------- Badge */

type BadgeTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info' | 'brand';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-navy-50 text-ink-muted border-line',
  positive: 'bg-positive-bg text-positive border-positive-border',
  warning: 'bg-warning-bg text-warning border-warning-border',
  danger: 'bg-danger-bg text-danger border-danger-border',
  info: 'bg-info-bg text-info border-info-border',
  brand: 'bg-brand-50 text-brand-700 border-brand-200',
};

export function Badge({
  tone = 'neutral',
  children,
  icon,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-2xs font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ Fields */

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}

export function Field({ label, hint, error, required, children, className, htmlFor }: FieldProps) {
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-ink">
        {label}
        {required && <span className="text-danger ml-0.5">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger flex items-start gap-1">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-muted leading-relaxed">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL_BASE =
  'w-full h-9 px-3 text-sm bg-surface border rounded-control text-ink placeholder:text-ink-subtle ' +
  'transition-colors duration-150 disabled:bg-navy-50 disabled:text-ink-muted disabled:cursor-not-allowed';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cx(CONTROL_BASE, invalid ? 'border-danger focus:border-danger' : 'border-line focus:border-brand', className)}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cx(
          CONTROL_BASE,
          'h-auto py-2 min-h-[72px] resize-y',
          invalid ? 'border-danger' : 'border-line focus:border-brand',
          className,
        )}
        {...props}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className, invalid, children, ...props }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cx(
            CONTROL_BASE,
            'appearance-none pr-9 cursor-pointer',
            invalid ? 'border-danger' : 'border-line focus:border-brand',
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="w-4 h-4 text-ink-muted absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
    );
  },
);

/* ----------------------------------------------------------------- Callout */

type CalloutTone = 'info' | 'warning' | 'danger' | 'positive' | 'neutral';

const CALLOUT_STYLES: Record<CalloutTone, { wrap: string; icon: ReactNode }> = {
  info: { wrap: 'bg-info-bg border-info-border text-info', icon: <Info className="w-4 h-4" /> },
  warning: { wrap: 'bg-warning-bg border-warning-border text-warning', icon: <AlertTriangle className="w-4 h-4" /> },
  danger: { wrap: 'bg-danger-bg border-danger-border text-danger', icon: <AlertCircle className="w-4 h-4" /> },
  positive: { wrap: 'bg-positive-bg border-positive-border text-positive', icon: <CheckCircle2 className="w-4 h-4" /> },
  neutral: { wrap: 'bg-navy-50 border-line text-ink-muted', icon: <Info className="w-4 h-4" /> },
};

export function Callout({
  tone = 'info',
  title,
  children,
  actions,
  className,
  onDismiss,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  onDismiss?: () => void;
}) {
  const style = CALLOUT_STYLES[tone];
  return (
    <div className={cx('flex items-start gap-3 p-3.5 border rounded-card', style.wrap, className)}>
      <div className="shrink-0 mt-0.5">{style.icon}</div>
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="text-xs font-semibold">{title}</p>}
        {children && <div className="text-xs leading-relaxed opacity-90">{children}</div>}
        {actions && <div className="pt-1.5 flex flex-wrap gap-2">{actions}</div>}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100 transition-opacity" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- EmptyState */

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center px-6 py-14', className)}>
      {icon && (
        <div className="w-12 h-12 rounded-full bg-navy-50 border border-line flex items-center justify-center text-ink-muted mb-4">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="text-xs text-ink-muted mt-1.5 max-w-md leading-relaxed">{description}</p>}
      {(action || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Skeleton */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} />;
}

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <Card className="p-5 space-y-3">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-3 w-full" />
      ))}
    </Card>
  );
}

export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-5">
      <div className="flex gap-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-8 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Dialog */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-navy-950/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'relative w-full bg-surface rounded-card shadow-dropdown border border-line animate-slide-up',
          'max-h-[88vh] flex flex-col',
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description && <p className="text-xs text-ink-muted mt-1 leading-relaxed">{description}</p>}
          </div>
          <button onClick={onClose} className="shrink-0 p-1 -m-1 text-ink-muted hover:text-ink transition-colors" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="px-5 py-3.5 border-t border-line bg-navy-50/50 flex items-center justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  tone = 'danger',
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-muted leading-relaxed">{message}</p>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- Tooltip */

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'right' }) {
  const [open, setOpen] = useState(false);

  const position =
    side === 'bottom'
      ? 'top-full mt-1.5 left-1/2 -translate-x-1/2'
      : side === 'right'
        ? 'left-full ml-2 top-1/2 -translate-y-1/2'
        : 'bottom-full mb-1.5 left-1/2 -translate-x-1/2';

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cx(
            'absolute z-40 px-2.5 py-1.5 rounded-control bg-navy-900 text-white text-2xs leading-relaxed',
            'shadow-dropdown max-w-[18rem] w-max pointer-events-none animate-fade-in',
            position,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}

/* -------------------------------------------------------------------- Tabs */

export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: { key: string; label: string; count?: number; icon?: ReactNode }[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={cx('flex items-center gap-1 border-b border-line overflow-x-auto', className)} role="tablist">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.key)}
            className={cx(
              'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap',
              'border-b-2 -mb-px transition-colors duration-150',
              isActive ? 'border-brand text-brand' : 'border-transparent text-ink-muted hover:text-ink hover:border-line-strong',
            )}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && (
              <span className={cx('px-1.5 py-0.5 rounded-full text-2xs tabular', isActive ? 'bg-brand-50 text-brand-700' : 'bg-navy-50 text-ink-muted')}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- Pagination */

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3 border-t border-line">
      <p className="text-xs text-ink-muted tabular">
        {from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}
      </p>
      <div className="flex items-center gap-1.5">
        <Button size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <span className="text-xs text-ink-muted px-2 tabular">
          {page} / {pages}
        </span>
        <Button size="sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Toasts */

export interface Toast {
  id: string;
  tone: 'positive' | 'danger' | 'info' | 'warning';
  title: string;
  message?: string;
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))] no-print">
      {toasts.map((t) => (
        <div key={t.id} className="animate-slide-up">
          <Callout tone={t.tone} title={t.title} onDismiss={() => onDismiss(t.id)} className="shadow-dropdown bg-surface">
            {t.message}
          </Callout>
        </div>
      ))}
    </div>
  );
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = (tone: Toast['tone'], title: string, message?: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, tone, title, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), tone === 'danger' ? 9000 : 5000);
  };

  return {
    toasts,
    dismiss: (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    success: (title: string, message?: string) => push('positive', title, message),
    error: (title: string, message?: string) => push('danger', title, message),
    info: (title: string, message?: string) => push('info', title, message),
    warn: (title: string, message?: string) => push('warning', title, message),
  };
}

/* ------------------------------------------------------------------ Spinner */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('animate-spin text-ink-muted', className ?? 'w-4 h-4')} />;
}

export function LoadingPane({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <Spinner className="w-6 h-6 text-brand" />
      <p className="text-xs text-ink-muted">{label}</p>
    </div>
  );
}
