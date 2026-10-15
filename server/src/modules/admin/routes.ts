import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, dialect } from '../../db/index.js';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany, accessibleCompanyIds } from '../../middleware/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newId, nowIso } from '../../lib/ids.js';
import { readJson, writeJson } from '../../lib/json.js';
import { recordAudit } from '../audit/service.js';
import { ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, ROLE_CAPABILITIES, type Role } from '../auth/permissions.js';
import { DEFAULT_BUCKETS } from '../finance/ageing.js';

export const adminRouter = Router();
adminRouter.use(authenticate);

// --------------------------------------------------------------------- users

adminRouter.get(
  '/roles',
  asyncHandler(async (_req, res) => {
    res.json({
      roles: ROLES.map((r) => ({
        key: r,
        label: ROLE_LABELS[r],
        description: ROLE_DESCRIPTIONS[r],
        capabilities: ROLE_CAPABILITIES[r],
      })),
    });
  }),
);

adminRouter.get(
  '/users',
  requireCapability('users.manage'),
  asyncHandler(async (req, res) => {
    const users = await db('users').orderBy('name');
    const assignments = await db('user_companies').join('companies', 'user_companies.company_id', 'companies.id').select('user_companies.user_id', 'companies.id', 'companies.name');

    const byUser = new Map<string, { id: string; name: string }[]>();
    for (const a of assignments) {
      byUser.set(a.user_id, [...(byUser.get(a.user_id) ?? []), { id: a.id, name: a.name }]);
    }

    res.json({
      users: users.map((u: Record<string, any>) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        roleLabel: ROLE_LABELS[u.role as Role] ?? u.role,
        isActive: dialect.bool(u.is_active),
        mustChangePassword: dialect.bool(u.must_change_password),
        lastLoginAt: u.last_login_at,
        createdAt: u.created_at,
        companies: u.role === 'admin' ? 'all' : (byUser.get(u.id) ?? []),
      })),
    });
  }),
);

const userSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(2).max(160),
  role: z.enum(['admin', 'finance', 'executive', 'sales']),
  password: z
    .string()
    .min(10, 'Use at least 10 characters')
    .regex(/[a-z]/, 'Include a lowercase letter')
    .regex(/[A-Z]/, 'Include an uppercase letter')
    .regex(/[0-9]/, 'Include a number'),
  companyIds: z.array(z.string()).default([]),
});

adminRouter.post(
  '/users',
  requireCapability('users.manage'),
  asyncHandler(async (req, res) => {
    const input = userSchema.parse(req.body);
    const email = input.email.toLowerCase().trim();

    const existing = await db('users').where({ email }).first();
    if (existing) throw conflict(`A user with the email ${email} already exists.`);

    const id = newId();
    const now = nowIso();

    await db('users').insert({
      id,
      email,
      name: input.name,
      password_hash: await bcrypt.hash(input.password, 12),
      role: input.role,
      is_active: true,
      must_change_password: true,
      created_at: now,
      updated_at: now,
    });

    for (const companyId of input.companyIds) {
      const company = await db('companies').where({ id: companyId }).first();
      if (!company) continue;
      await db('user_companies').insert({ id: newId(), user_id: id, company_id: companyId, created_at: now });
    }

    await recordAudit({
      action: 'user.created',
      summary: `Created the ${ROLE_LABELS[input.role]} account ${email}`,
      entityType: 'user',
      entityId: id,
      meta: { role: input.role, companyCount: input.companyIds.length },
      req,
    });

    res.status(201).json({ user: { id, email, name: input.name, role: input.role, mustChangePassword: true } });
  }),
);

adminRouter.patch(
  '/users/:userId',
  requireCapability('users.manage'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().trim().min(2).max(160).optional(),
      role: z.enum(['admin', 'finance', 'executive', 'sales']).optional(),
      isActive: z.boolean().optional(),
      companyIds: z.array(z.string()).optional(),
      resetPassword: z.string().min(10).optional(),
    });

    const input = schema.parse(req.body);
    const user = await db('users').where({ id: req.params.userId }).first();
    if (!user) throw notFound('That user could not be found.');

    // Guard against removing the last way into the system.
    if ((input.role && input.role !== 'admin' && user.role === 'admin') || (input.isActive === false && user.role === 'admin')) {
      const otherAdmins = await db('users').where({ role: 'admin', is_active: true }).whereNot('id', user.id).count({ c: '*' }).first();
      if (Number(otherAdmins?.c ?? 0) === 0) {
        throw badRequest('This is the only active administrator. Promote another user to administrator before changing this account.');
      }
    }

    const patch: Record<string, unknown> = { updated_at: nowIso() };
    if (input.name) patch.name = input.name;
    if (input.role) patch.role = input.role;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (input.resetPassword) {
      patch.password_hash = await bcrypt.hash(input.resetPassword, 12);
      patch.must_change_password = true;
    }

    await db('users').where({ id: user.id }).update(patch);

    if (input.companyIds) {
      await db('user_companies').where({ user_id: user.id }).del();
      const now = nowIso();
      for (const companyId of input.companyIds) {
        const company = await db('companies').where({ id: companyId }).first();
        if (!company) continue;
        await db('user_companies').insert({ id: newId(), user_id: user.id, company_id: companyId, created_at: now });
      }
    }

    await recordAudit({
      action: input.isActive === false ? 'user.deactivated' : 'user.updated',
      summary: `Updated the account ${user.email}`,
      entityType: 'user',
      entityId: user.id,
      meta: { fields: Object.keys(patch).filter((k) => k !== 'updated_at' && k !== 'password_hash'), passwordReset: Boolean(input.resetPassword) },
      req,
    });

    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- audit log

adminRouter.get(
  '/audit',
  requireCapability('audit.view'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize ?? 50)));

    let q = db('audit_events');

    // Non-admins see only the companies they can reach.
    const allowed = await accessibleCompanyIds(req.user!);
    if (allowed !== null) {
      q = q.where(function () {
        this.whereIn('company_id', allowed.length ? allowed : ['__none__']).orWhereNull('company_id');
      });
    }

    if (req.query.companyId) q = q.andWhere('company_id', req.query.companyId as string);
    if (req.query.action) q = q.andWhere('action', req.query.action as string);
    if (req.query.userId) q = q.andWhere('user_id', req.query.userId as string);
    if (req.query.from) q = q.andWhere('created_at', '>=', req.query.from as string);
    if (req.query.to) q = q.andWhere('created_at', '<=', `${req.query.to}T23:59:59.999Z`);
    if (req.query.search) {
      const p = `%${String(req.query.search).toLowerCase()}%`;
      q = q.andWhereRaw('LOWER(summary) LIKE ?', [p]);
    }

    const countRow = await q.clone().count({ c: '*' }).first();
    const rows = await q.clone().orderBy('created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize);

    const actions = await db('audit_events').distinct('action').orderBy('action');

    res.json({
      events: rows.map((e: Record<string, any>) => ({
        id: e.id,
        companyId: e.company_id,
        userId: e.user_id,
        userEmail: e.user_email,
        action: e.action,
        entityType: e.entity_type,
        entityId: e.entity_id,
        summary: e.summary,
        meta: readJson(e.meta, null),
        ip: e.ip,
        createdAt: e.created_at,
      })),
      pagination: { page, pageSize, total: Number(countRow?.c ?? 0) },
      availableActions: actions.map((a: { action: string }) => a.action),
      note: 'Audit events are append-only. Passwords, tokens and row-level financial payloads are never recorded.',
    });
  }),
);

// ----------------------------------------------------------------- settings

adminRouter.get(
  '/settings',
  requireCapability('settings.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const rows = await db('app_settings').where({ company_id: req.companyId });
    const settings: Record<string, unknown> = {};
    for (const r of rows) settings[r.key] = readJson(r.value, null);

    const company = await db('companies').where({ id: req.companyId }).first();

    res.json({
      settings: {
        ageing_buckets: settings.ageing_buckets ?? DEFAULT_BUCKETS,
        min_cash_threshold: settings.min_cash_threshold ?? null,
        ratio_benchmarks: settings.ratio_benchmarks ?? {},
        alert_thresholds: settings.alert_thresholds ?? null,
        expense_categories: settings.expense_categories ?? [],
        ...settings,
      },
      company: {
        currency: company.currency,
        currencyScale: company.currency_scale,
        entityType: company.entity_type,
      },
      integrations: {
        dataSource: { kind: 'excel_import', label: 'Excel Import', connected: true, detail: 'All financial data in this version comes from Excel imports.' },
        tally: {
          connected: false,
          detail:
            'No Tally connector exists in this version. The data layer is built around a provider interface so a Tally connector can be added later without changing the calculation or reporting modules.',
        },
        crm: {
          connected: false,
          provider: env.integrations.crmProvider,
          detail: env.integrations.crmProvider
            ? 'A provider is named in the configuration, but no adapter for it ships in this version.'
            : 'Not configured.',
        },
        ai: {
          connected: Boolean(env.integrations.aiProvider && env.integrations.aiApiKey),
          provider: env.integrations.aiProvider,
          detail:
            env.integrations.aiProvider && env.integrations.aiApiKey
              ? `Configured with ${env.integrations.aiProvider}.`
              : 'Not configured. Set AI_PROVIDER and AI_API_KEY in the server environment to enable AI-assisted summaries.',
        },
        email: {
          connected: Boolean(env.integrations.smtpUrl),
          detail: env.integrations.smtpUrl ? 'SMTP is configured.' : 'Not configured. Scheduled email summaries are unavailable.',
        },
        scheduler: {
          connected: false,
          detail: 'No background scheduler is deployed. Alerts are computed when pages are opened and after imports.',
        },
      },
    });
  }),
);

adminRouter.put(
  '/settings/:key',
  requireCapability('settings.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const allowed = new Set(['ageing_buckets', 'min_cash_threshold', 'ratio_benchmarks', 'expense_categories', 'report_footer']);
    const key = req.params.key;
    if (!allowed.has(key)) throw badRequest(`"${key}" is not a configurable setting.`);

    if (key === 'ageing_buckets') {
      const schema = z.array(
        z.object({
          key: z.string().min(1).max(32),
          label: z.string().min(1).max(80),
          minDays: z.number().int().nullable(),
          maxDays: z.number().int().nullable(),
        }),
      ).min(1).max(10);
      schema.parse(req.body.value);
    }

    const existing = await db('app_settings').where({ company_id: req.companyId, key }).first();
    const now = nowIso();

    if (existing) {
      await db('app_settings').where({ id: existing.id }).update({ value: writeJson(req.body.value), updated_by: req.user!.id, updated_at: now });
    } else {
      await db('app_settings').insert({
        id: newId(),
        company_id: req.companyId,
        key,
        value: writeJson(req.body.value),
        updated_by: req.user!.id,
        created_at: now,
        updated_at: now,
      });
    }

    await recordAudit({
      action: 'settings.changed',
      summary: `Updated the setting "${key}"`,
      companyId: req.companyId,
      entityType: 'app_setting',
      entityId: key,
      req,
    });

    res.json({ ok: true, key, value: req.body.value });
  }),
);
