import type { Request } from 'express';
import { db } from '../../db/index.js';
import { newId, nowIso } from '../../lib/ids.js';
import { writeJson } from '../../lib/json.js';
import { logger } from '../../lib/logger.js';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'company.created'
  | 'company.updated'
  | 'financial_year.created'
  | 'import.uploaded'
  | 'import.committed'
  | 'import.failed'
  | 'import.rolled_back'
  | 'mapping.confirmed'
  | 'mapping.changed'
  | 'mapping.bulk_changed'
  | 'category.created'
  | 'report.viewed'
  | 'report.exported'
  | 'budget.changed'
  | 'recurring_expense.changed'
  | 'expense.changed'
  | 'forecast.scenario_saved'
  | 'forecast.run_recorded'
  | 'ratio.custom_created'
  | 'ratio.custom_updated'
  | 'ratio.custom_deleted'
  | 'reconciliation.run'
  | 'alert.settings_changed'
  | 'crm.linked'
  | 'user.created'
  | 'user.updated'
  | 'user.deactivated'
  | 'settings.changed';

interface RecordArgs {
  action: AuditAction;
  summary: string;
  companyId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  meta?: Record<string, unknown> | null;
  req?: Request;
  /** For failed sign-ins, where there is no authenticated user. */
  userOverride?: { id?: string | null; email?: string | null };
}

/**
 * Append-only audit trail.
 *
 * Never records credentials, tokens or row-level financial payloads — a `meta`
 * object is expected to carry counts and identifiers, not amounts in bulk.
 * A failure to write an audit row is logged but never fails the user's request;
 * losing the action itself would be the worse outcome.
 */
export async function recordAudit(args: RecordArgs): Promise<void> {
  try {
    const user = args.req?.user;
    await db('audit_events').insert({
      id: newId(),
      company_id: args.companyId ?? args.req?.companyId ?? null,
      user_id: args.userOverride?.id ?? user?.id ?? null,
      user_email: args.userOverride?.email ?? user?.email ?? null,
      action: args.action,
      entity_type: args.entityType ?? null,
      entity_id: args.entityId ?? null,
      summary: args.summary,
      meta: args.meta ? writeJson(args.meta) : null,
      ip: args.req ? clientIp(args.req) : null,
      created_at: nowIso(),
    });
  } catch (err) {
    logger.warn('Audit event could not be written', {
      action: args.action,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.ip ?? null;
}
