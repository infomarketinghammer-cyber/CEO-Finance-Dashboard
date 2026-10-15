import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany } from '../../middleware/auth.js';
import { notFound } from '../../lib/errors.js';
import { nowIso } from '../../lib/ids.js';
import { env } from '../../config/env.js';
import { recordAudit } from '../audit/service.js';
import { refreshAlerts, getThresholds, setThresholds, DEFAULT_THRESHOLDS } from './service.js';
import { serialiseAlert } from '../finance/routes.js';

export const alertsRouter = Router();
alertsRouter.use(authenticate);

alertsRouter.get(
  '/',
  requireCapability('alerts.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    // Alerts are evaluated when they are read, because there is no scheduler here.
    if (req.query.refresh !== 'false') {
      await refreshAlerts(req.companyId!).catch(() => undefined);
    }

    let q = db('alerts').where({ company_id: req.companyId });
    if (req.query.status === 'unread') q = q.andWhere('is_read', false).whereNull('resolved_at');
    else if (req.query.status === 'resolved') q = q.whereNotNull('resolved_at');
    else q = q.whereNull('resolved_at');

    if (req.query.severity) q = q.andWhere('severity', req.query.severity as string);
    if (req.query.type) q = q.andWhere('type', req.query.type as string);

    const rows = await q
      .orderByRaw("CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END")
      .orderBy('created_at', 'desc')
      .limit(200);

    const unreadRow = await db('alerts').where({ company_id: req.companyId, is_read: false }).whereNull('resolved_at').count({ c: '*' }).first();

    res.json({
      alerts: rows.map(serialiseAlert),
      unreadCount: Number(unreadRow?.c ?? 0),
      delivery: {
        inApp: { configured: true, status: 'Alerts are computed when this page is opened and after every import.' },
        scheduler: {
          configured: false,
          status:
            'No background scheduler is running in this version, so alerts are not evaluated while you are away. They are recalculated whenever you open this page or complete an import.',
        },
        email: {
          configured: Boolean(env.integrations.smtpUrl),
          status: env.integrations.smtpUrl
            ? 'An SMTP server is configured. Scheduled email summaries can be enabled once a scheduler is deployed.'
            : 'No SMTP server is configured, so email summaries cannot be sent. Set SMTP_URL in the server environment to enable them.',
        },
      },
    });
  }),
);

alertsRouter.post(
  '/:alertId/read',
  requireCapability('alerts.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const alert = await db('alerts').where({ id: req.params.alertId, company_id: req.companyId }).first();
    if (!alert) throw notFound('That alert could not be found.');
    const isRead = req.body?.isRead !== false;
    await db('alerts').where({ id: alert.id }).update({ is_read: isRead });
    res.json({ ok: true });
  }),
);

alertsRouter.post(
  '/read-all',
  requireCapability('alerts.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const n = await db('alerts').where({ company_id: req.companyId, is_read: false }).whereNull('resolved_at').update({ is_read: true });
    res.json({ updated: n });
  }),
);

alertsRouter.get(
  '/thresholds',
  requireCapability('alerts.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    res.json({ thresholds: await getThresholds(req.companyId!), defaults: DEFAULT_THRESHOLDS });
  }),
);

alertsRouter.put(
  '/thresholds',
  requireCapability('alerts.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      minCashMinor: z.number().int().nullable().optional(),
      overdueReceivableMinor: z.number().int().min(0).optional(),
      overdueReceivableDays: z.number().int().min(0).max(365).optional(),
      overduePayableDays: z.number().int().min(0).max(365).optional(),
      budgetOverrunPercent: z.number().min(1).max(500).optional(),
      expenseSpikePercent: z.number().min(1).max(1000).optional(),
      staleDataDays: z.number().int().min(1).max(365).optional(),
    });

    const input = schema.parse(req.body);
    const thresholds = await setThresholds(req.companyId!, input, req.user!.id);

    await recordAudit({
      action: 'alert.settings_changed',
      summary: 'Updated alert thresholds',
      companyId: req.companyId,
      meta: { fields: Object.keys(input) },
      req,
    });

    await refreshAlerts(req.companyId!).catch(() => undefined);
    res.json({ thresholds });
  }),
);

alertsRouter.post(
  '/refresh',
  requireCapability('alerts.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const result = await refreshAlerts(req.companyId!);
    res.json({ ...result, refreshedAt: nowIso() });
  }),
);
