import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Database, Lock, ShieldCheck } from 'lucide-react';
import { LogoFull } from '@/components/Logo';
import { Button, Callout, Field, Input } from '@/components/ui';
import { useApp } from '@/state/AppContext';
import { ApiError } from '@/lib/api';

export function LoginPage() {
  const { user, login, loading } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-page">
        <div className="skeleton w-40 h-40 rounded-card" />
      </div>
    );
  }

  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_1fr] bg-page">
      {/* ---- form ---- */}
      <div className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm">
          <div className="flex justify-center mb-7">
            <LogoFull width={168} />
          </div>

          <div className="text-center mb-7">
            <h1 className="text-lg font-semibold text-ink">Sign in</h1>
            <p className="text-xs text-ink-muted mt-1.5">Access the financial position for the companies you are authorised to view.</p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {error && <Callout tone="danger">{error}</Callout>}

            <Field label="Email address" required htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                invalid={Boolean(error)}
              />
            </Field>

            <Field label="Password" required htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
                invalid={Boolean(error)}
              />
            </Field>

            <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting} icon={<Lock className="w-4 h-4" />}>
              Sign in
            </Button>
          </form>

          <p className="text-2xs text-ink-subtle text-center mt-6 leading-relaxed">
            Access is role-based and every sign-in, import and export is recorded in the audit log.
          </p>
        </div>
      </div>

      {/* ---- context panel ---- */}
      <div className="hidden lg:flex flex-col justify-center bg-navy-gradient text-white px-12 py-10 relative overflow-hidden">
        <div className="absolute -right-28 -top-28 w-[420px] h-[420px] rounded-full bg-brand-gradient opacity-[0.14] blur-3xl" aria-hidden />
        <div className="absolute -left-20 -bottom-24 w-[320px] h-[320px] rounded-full bg-cyan opacity-[0.10] blur-3xl" aria-hidden />

        <div className="relative max-w-md">
          <h2 className="text-2xl font-semibold leading-snug">Accounting data, turned into financial information.</h2>
          <p className="text-sm text-white/70 mt-3.5 leading-relaxed">
            Import your Excel exports and DHYEYA validates them, maps your ledgers to standard categories, and produces statements you can
            trace back to the underlying vouchers.
          </p>

          <ul className="mt-8 space-y-4">
            <Feature
              icon={<Database className="w-4 h-4" />}
              title="Excel is the data source today"
              body="No accounting system connection is required. The data layer is built so a Tally connector can be added later without rewriting the calculations."
            />
            <Feature
              icon={<ShieldCheck className="w-4 h-4" />}
              title="Every figure is traceable"
              body="Each line carries its formula, and you can drill from a KPI through to the ledger and the voucher behind it."
            />
            <Feature
              icon={<Lock className="w-4 h-4" />}
              title="Missing data stays missing"
              body="Where the source records do not support a figure, you see “Data unavailable” rather than a misleading zero."
            />
          </ul>
        </div>
      </div>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <li className="flex items-start gap-3.5">
      <span className="shrink-0 w-8 h-8 rounded-control bg-white/10 border border-white/15 flex items-center justify-center text-cyan-300">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-white/60 mt-1 leading-relaxed">{body}</span>
      </span>
    </li>
  );
}
