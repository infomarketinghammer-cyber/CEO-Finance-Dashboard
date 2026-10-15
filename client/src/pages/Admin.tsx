import { useEffect, useState } from 'react';
import { ClipboardList, KeyRound, Plus, Shield, UserCog, Users } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/state/AppContext';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  Input,
  LoadingPane,
  Pagination,
  Select,
  Tabs,
  ToastStack,
  Tooltip,
  useToasts,
} from '@/components/ui';
import { Explainer, PageHeader } from '@/components/financial';
import { cx, formatDateTime, formatMoney, formatRelative } from '@/lib/format';
import { SelectCompanyNotice } from './Statements';

/* ================================================================= Users */

export function UsersPage() {
  const { companies } = useApp();
  const toasts = useToasts();

  const [users, setUsers] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const load = async () => {
    try {
      const [u, r] = await Promise.all([api.get<any>('/admin/users'), api.get<any>('/admin/roles')]);
      setUsers(u.users);
      setRoles(r.roles);
    } catch (err) {
      toasts.error('Could not load users', err instanceof ApiError ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <LoadingPane />;

  return (
    <>
      <PageHeader
        title="Users and Roles"
        description="Who can reach what. Every permission here is enforced on the server as well as in the navigation."
        actions={
          <Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setCreateOpen(true)}>
            Add a user
          </Button>
        }
      />

      <Card className="mb-4">
        <CardHeader title="What each role can do" />
        <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3 p-5">
          {roles.map((r) => (
            <div key={r.key} className="p-4 rounded-card border border-line">
              <div className="flex items-center gap-2">
                <Shield className="w-3.5 h-3.5 text-ink-muted" />
                <p className="text-sm font-medium text-ink">{r.label}</p>
              </div>
              <p className="text-xs text-ink-muted mt-1.5 leading-relaxed">{r.description}</p>
              <p className="text-2xs text-ink-subtle mt-2">{r.capabilities.length} permissions</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Accounts" />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left px-5 py-2.5 label-text">Name</th>
                <th className="text-left px-4 py-2.5 label-text">Email</th>
                <th className="text-left px-4 py-2.5 label-text">Role</th>
                <th className="text-left px-4 py-2.5 label-text">Companies</th>
                <th className="text-left px-4 py-2.5 label-text">Last sign-in</th>
                <th className="text-left px-4 py-2.5 label-text">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={cx('border-b border-line/60', !u.isActive && 'opacity-55')}>
                  <td className="px-5 py-2.5 text-ink">{u.name}</td>
                  <td className="px-4 py-2.5 text-xs text-ink-muted">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={u.role === 'admin' ? 'brand' : 'neutral'}>{u.roleLabel}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-ink-muted">
                    {u.companies === 'all' ? 'All companies' : u.companies.length ? u.companies.map((c: any) => c.name).join(', ') : 'None assigned'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-ink-muted">{u.lastLoginAt ? formatRelative(u.lastLoginAt) : 'never'}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <Badge tone={u.isActive ? 'positive' : 'danger'}>{u.isActive ? 'Active' : 'Deactivated'}</Badge>
                      {u.mustChangePassword && (
                        <Tooltip content="This user must set a new password at their next sign-in.">
                          <Badge tone="warning">
                            <KeyRound className="w-2.5 h-2.5" />
                          </Badge>
                        </Tooltip>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button size="sm" variant="ghost" icon={<UserCog className="w-3.5 h-3.5" />} onClick={() => setEditing(u)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Explainer
        className="mt-5"
        what="Creates accounts, assigns roles, and controls which companies each person can reach."
        why="Financial data should be seen by the people who need it and no one else. Hiding a menu item is not security; these permissions are checked on every request."
        needs="An email address and a role. Non-administrators also need explicit company assignments."
        next="Give each person the narrowest role that lets them do their job. Sales in particular sees only their own customers."
      />

      <UserDialog
        open={createOpen}
        user={null}
        companies={companies}
        roles={roles}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          void load();
          toasts.success('User created', 'They will be asked to set a new password at first sign-in.');
        }}
      />

      <UserDialog
        open={Boolean(editing)}
        user={editing}
        companies={companies}
        roles={roles}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
          toasts.success('User updated');
        }}
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

function UserDialog({
  open,
  user,
  companies,
  roles,
  onClose,
  onSaved,
}: {
  open: boolean;
  user: any | null;
  companies: { id: string; name: string }[];
  roles: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({ email: '', name: '', role: 'executive', password: '', companyIds: [] as string[], isActive: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (user) {
      setForm({
        email: user.email,
        name: user.name,
        role: user.role,
        password: '',
        companyIds: user.companies === 'all' ? [] : user.companies.map((c: any) => c.id),
        isActive: user.isActive,
      });
    } else {
      setForm({ email: '', name: '', role: 'executive', password: '', companyIds: [], isActive: true });
    }
    setError(null);
    setFieldErrors({});
  }, [user, open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      if (user) {
        await api.patch(`/admin/users/${user.id}`, {
          name: form.name,
          role: form.role,
          isActive: form.isActive,
          companyIds: form.companyIds,
          ...(form.password ? { resetPassword: form.password } : {}),
        });
      } else {
        await api.post('/admin/users', form);
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else setError('The account could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const selectedRole = roles.find((r) => r.key === form.role);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'Add a user'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!form.email || !form.name || (!user && form.password.length < 10)}
            onClick={submit}
          >
            {user ? 'Save changes' : 'Create user'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Full name" required error={fieldErrors.name}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Email" required error={fieldErrors.email}>
            <Input type="email" disabled={Boolean(user)} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
        </div>

        <Field
          label={user ? 'Reset password' : 'Initial password'}
          required={!user}
          error={fieldErrors.password ?? fieldErrors.resetPassword}
          hint="At least 10 characters with an uppercase letter, a lowercase letter and a number. The user must change it at first sign-in."
        >
          <Input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder={user ? 'Leave blank to keep the current password' : ''}
          />
        </Field>

        <Field label="Role" required>
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>

        {selectedRole && <Callout tone="info">{selectedRole.description}</Callout>}

        {form.role !== 'admin' && (
          <Field label="Company access" hint="Administrators reach every company. Everyone else needs an explicit assignment.">
            <div className="space-y-1.5 max-h-40 overflow-y-auto border border-line rounded-control p-3">
              {companies.length === 0 && <p className="text-xs text-ink-muted">No companies exist yet.</p>}
              {companies.map((c) => (
                <label key={c.id} className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.companyIds.includes(c.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        companyIds: e.target.checked ? [...form.companyIds, c.id] : form.companyIds.filter((x) => x !== c.id),
                      })
                    }
                    className="w-4 h-4 rounded border-line text-brand focus:ring-brand/30"
                  />
                  <span className="text-sm text-ink">{c.name}</span>
                </label>
              ))}
            </div>
          </Field>
        )}

        {user && (
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              className="w-4 h-4 rounded border-line text-brand focus:ring-brand/30"
            />
            <span className="text-sm text-ink">Account is active</span>
          </label>
        )}
      </div>
    </Dialog>
  );
}

/* ============================================================ Audit logs */

export function AuditPage() {
  const { companies } = useApp();
  const [events, setEvents] = useState<any[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 50, total: 0 });
  const [filters, setFilters] = useState({ action: '', companyId: '', search: '', from: '', to: '' });
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await api.get<any>('/admin/audit', {
            page: pagination.page,
            pageSize: pagination.pageSize,
            action: filters.action || undefined,
            companyId: filters.companyId || undefined,
            search: filters.search || undefined,
            from: filters.from || undefined,
            to: filters.to || undefined,
          });
          setEvents(res.events);
          setPagination(res.pagination);
          setActions(res.availableActions);
          setNote(res.note);
        } finally {
          setLoading(false);
        }
      })();
    }, filters.search ? 280 : 0);
    return () => clearTimeout(t);
  }, [pagination.page, filters]);

  return (
    <>
      <PageHeader title="Audit Logs" description="An append-only record of sign-ins, imports, mapping changes, exports and administrative actions." />

      <Callout tone="neutral" className="mb-4">
        {note}
      </Callout>

      <Card>
        <div className="px-5 pt-4 pb-3 flex flex-wrap items-center gap-2.5">
          <Input
            value={filters.search}
            onChange={(e) => {
              setFilters({ ...filters, search: e.target.value });
              setPagination((p) => ({ ...p, page: 1 }));
            }}
            placeholder="Search the log…"
            className="w-56"
          />
          <Select
            value={filters.action}
            onChange={(e) => {
              setFilters({ ...filters, action: e.target.value });
              setPagination((p) => ({ ...p, page: 1 }));
            }}
            className="w-52"
          >
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a.replace(/[._]/g, ' ')}
              </option>
            ))}
          </Select>
          <Select
            value={filters.companyId}
            onChange={(e) => {
              setFilters({ ...filters, companyId: e.target.value });
              setPagination((p) => ({ ...p, page: 1 }));
            }}
            className="w-48"
          >
            <option value="">All companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            className="h-9 px-3 text-sm bg-surface border border-line rounded-control"
            aria-label="From date"
          />
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
            className="h-9 px-3 text-sm bg-surface border border-line rounded-control"
            aria-label="To date"
          />
        </div>

        {loading ? (
          <LoadingPane />
        ) : events.length === 0 ? (
          <EmptyState icon={<ClipboardList className="w-5 h-5" />} title="No matching events" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left px-5 py-2.5 label-text">When</th>
                    <th className="text-left px-4 py-2.5 label-text">User</th>
                    <th className="text-left px-4 py-2.5 label-text">Action</th>
                    <th className="text-left px-4 py-2.5 label-text">What happened</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} className="border-b border-line/60 hover:bg-navy-50/40">
                      <td className="px-5 py-2.5 text-xs text-ink-muted whitespace-nowrap">{formatDateTime(e.createdAt)}</td>
                      <td className="px-4 py-2.5 text-xs text-ink-muted truncate max-w-[180px]">{e.userEmail ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={e.action.startsWith('auth.login_failed') ? 'danger' : 'neutral'}>{e.action.replace(/[._]/g, ' ')}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-ink leading-relaxed">{e.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...pagination} onPageChange={(p) => setPagination((s) => ({ ...s, page: p }))} />
          </>
        )}
      </Card>

      <Explainer
        className="mt-5"
        what="Records who did what and when, across sign-ins, imports, mapping changes, exports and user administration."
        why="Financial data needs an answer to 'who changed this?'. The log is append-only, so the answer cannot be edited away."
        needs="Nothing — events are recorded automatically."
        next="Filter by action or company to investigate a specific change."
      />
    </>
  );
}

/* ============================================================== Settings */

export function SettingsPage() {
  const { company, currency, can } = useApp();
  const toasts = useToasts();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('integrations');
  const [buckets, setBuckets] = useState<any[]>([]);
  const [minCash, setMinCash] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!company) return;
    try {
      const res = await api.get<any>('/admin/settings', { companyId: company.id });
      setData(res);
      setBuckets(res.settings.ageing_buckets ?? []);
      setMinCash(
        res.settings.min_cash_threshold?.amountMinor !== undefined
          ? String(res.settings.min_cash_threshold.amountMinor / Math.pow(10, currency.scale))
          : '',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [company]);

  if (!company) return <SelectCompanyNotice />;
  if (loading) return <LoadingPane />;
  if (!data) return null;

  const saveSetting = async (key: string, value: unknown) => {
    setBusy(true);
    try {
      await api.put(`/admin/settings/${key}`, { companyId: company.id, value });
      toasts.success('Setting saved');
      void load();
    } catch (err) {
      toasts.error('Could not save', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const integrations = Object.entries(data.integrations) as [string, any][];

  return (
    <>
      <PageHeader title="Application Settings" description={`Configuration for ${company.name}. Each company has its own settings.`} />

      <Tabs
        tabs={[
          { key: 'integrations', label: 'Integrations' },
          { key: 'ageing', label: 'Ageing buckets' },
          { key: 'cash', label: 'Cash threshold' },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'integrations' && (
        <Card>
          <CardHeader
            title="Integration status"
            description="What is connected and what is not. Nothing here reports a connection that does not exist."
          />
          <ul className="divide-y divide-line">
            {integrations.map(([key, info]) => (
              <li key={key} className="px-5 py-3.5 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-ink capitalize">{key.replace(/([A-Z])/g, ' $1')}</p>
                    <Badge tone={info.connected ? 'positive' : 'neutral'}>{info.connected ? 'Connected' : 'Not connected'}</Badge>
                  </div>
                  <p className="text-xs text-ink-muted mt-1 leading-relaxed">{info.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {tab === 'ageing' && (
        <Card>
          <CardHeader
            title="Receivables and payables ageing buckets"
            description="How overdue balances are grouped. Documents with no due date are always reported separately and never placed in a bucket."
          />
          <div className="p-5 space-y-2.5">
            {buckets.map((b, i) => (
              <div key={b.key} className="grid grid-cols-[1fr_90px_90px] gap-2.5 items-end">
                <Field label={i === 0 ? 'Label' : ''}>
                  <Input
                    disabled={!can('settings.manage')}
                    value={b.label}
                    onChange={(e) => setBuckets(buckets.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  />
                </Field>
                <Field label={i === 0 ? 'From (days)' : ''}>
                  <Input
                    type="number"
                    disabled={!can('settings.manage') || b.key === 'not_due'}
                    value={b.minDays ?? ''}
                    onChange={(e) =>
                      setBuckets(buckets.map((x, j) => (j === i ? { ...x, minDays: e.target.value === '' ? null : Number(e.target.value) } : x)))
                    }
                  />
                </Field>
                <Field label={i === 0 ? 'To (days)' : ''}>
                  <Input
                    type="number"
                    disabled={!can('settings.manage') || b.key === 'not_due'}
                    value={b.maxDays ?? ''}
                    onChange={(e) =>
                      setBuckets(buckets.map((x, j) => (j === i ? { ...x, maxDays: e.target.value === '' ? null : Number(e.target.value) } : x)))
                    }
                    placeholder="open"
                  />
                </Field>
              </div>
            ))}
          </div>
          {can('settings.manage') && (
            <div className="px-5 py-3.5 border-t border-line flex justify-end">
              <Button variant="primary" loading={busy} onClick={() => saveSetting('ageing_buckets', buckets)}>
                Save buckets
              </Button>
            </div>
          )}
        </Card>
      )}

      {tab === 'cash' && (
        <Card>
          <CardHeader
            title="Minimum cash threshold"
            description="The level below which the cash position is treated as a shortfall. It drives the low-cash alert and the line on the forecast chart."
          />
          <div className="p-5 max-w-sm">
            <Field label={`Minimum balance (${currency.currency})`} hint="Leave blank to disable cash threshold alerts.">
              <Input
                type="number"
                step="0.01"
                disabled={!can('settings.manage')}
                value={minCash}
                onChange={(e) => setMinCash(e.target.value)}
                placeholder="No minimum set"
              />
            </Field>
            {minCash && (
              <p className="text-xs text-ink-muted mt-2">
                Alerts will fire when cash falls below {formatMoney(Math.round(Number(minCash) * Math.pow(10, currency.scale)), currency)}.
              </p>
            )}
          </div>
          {can('settings.manage') && (
            <div className="px-5 py-3.5 border-t border-line flex justify-end">
              <Button
                variant="primary"
                loading={busy}
                onClick={() =>
                  saveSetting('min_cash_threshold', minCash === '' ? null : { amountMinor: Math.round(Number(minCash) * Math.pow(10, currency.scale)) })
                }
              >
                Save threshold
              </Button>
            </div>
          )}
        </Card>
      )}

      <Explainer
        className="mt-5"
        what="Configures the business rules this company runs on: ageing buckets, cash thresholds, and what is connected."
        why="These are decisions about your business, not about software. Changing them should never require a developer."
        needs="Nothing — sensible defaults apply until you change them."
        next="Set your minimum cash threshold so the forecast and alerts reflect your actual comfort level."
      />

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

/* =============================================================== Profile */

export function ProfilePage() {
  const { user, refreshUser } = useApp();
  const toasts = useToasts();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (form.newPassword !== form.confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/change-password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      await refreshUser();
      toasts.success('Password changed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The password could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Your profile" />

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Account" />
          <dl className="p-5 space-y-3">
            <div>
              <dt className="label-text">Name</dt>
              <dd className="text-sm text-ink mt-0.5">{user?.name}</dd>
            </div>
            <div>
              <dt className="label-text">Email</dt>
              <dd className="text-sm text-ink mt-0.5">{user?.email}</dd>
            </div>
            <div>
              <dt className="label-text">Role</dt>
              <dd className="mt-1">
                <Badge tone="brand">{user?.roleLabel}</Badge>
              </dd>
            </div>
            <div>
              <dt className="label-text">Last sign-in</dt>
              <dd className="text-sm text-ink mt-0.5">{user?.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'This is your first session'}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardHeader title="Change your password" />
          <div className="p-5 space-y-4">
            {user?.mustChangePassword && (
              <Callout tone="warning" title="Please set a new password">
                Your account is using a password set by an administrator. Change it now so only you know it.
              </Callout>
            )}
            {error && <Callout tone="danger">{error}</Callout>}

            <Field label="Current password" required>
              <Input type="password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
            </Field>
            <Field label="New password" required hint="At least 10 characters with an uppercase letter, a lowercase letter and a number.">
              <Input type="password" value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
            </Field>
            <Field label="Confirm new password" required>
              <Input type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
            </Field>
          </div>
          <div className="px-5 py-3.5 border-t border-line flex justify-end">
            <Button
              variant="primary"
              loading={busy}
              disabled={!form.currentPassword || form.newPassword.length < 10}
              onClick={submit}
            >
              Change password
            </Button>
          </div>
        </Card>
      </div>

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

export { Users, Shield };
