import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany } from '../../middleware/auth.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { nowIso, normalizeName } from '../../lib/ids.js';
import { add, type Minor } from '../../lib/money.js';
import { recordAudit } from '../audit/service.js';
import { listOutstanding } from '../finance/ageing.js';
import { today } from '../../lib/ids.js';

export const crmRouter = Router();
crmRouter.use(authenticate);

/**
 * CRM integration.
 *
 * No CRM adapter exists in this version. The module reports that honestly, and
 * provides the parts that work without one: customer records imported from Excel,
 * and their linkage to accounting ledgers by GSTIN, ledger name or manual choice.
 * No deals, contacts or activity are fabricated to fill the screen.
 */

crmRouter.get(
  '/status',
  requireCapability('crm.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const total = await db('crm_links').where({ company_id: req.companyId }).count({ c: '*' }).first();
    const linked = await db('crm_links').where({ company_id: req.companyId }).whereNotNull('ledger_id').count({ c: '*' }).first();
    const lastImport = await db('import_batches')
      .where({ company_id: req.companyId, category: 'customers', status: 'committed' })
      .orderBy('completed_at', 'desc')
      .first();

    res.json({
      connection: {
        connected: false,
        provider: env.integrations.crmProvider,
        status: env.integrations.crmProvider
          ? 'A CRM provider is named in the server configuration, but no adapter for it is implemented in this version. Deals, contacts and activity are not available.'
          : 'Not connected. No CRM API is configured, and no CRM adapter ships in this version.',
        availableWithoutConnection: [
          'Customer records imported from Excel',
          'Linking customers to accounting ledgers by GSTIN, ledger name or manual mapping',
          'Outstanding and payment status per customer',
          'Scoping the Sales role to a user’s own customers',
        ],
        requiresConnection: ['CRM deals and pipeline', 'Contact and activity history', 'Pushing overdue balances back into the CRM'],
        howToProceed:
          'Import the "Customer / CRM Data" category from the Excel Import Center to populate customer records now. A live CRM adapter can be added later without changing this data model.',
      },
      customers: {
        total: Number(total?.c ?? 0),
        linkedToLedger: Number(linked?.c ?? 0),
        unlinked: Number(total?.c ?? 0) - Number(linked?.c ?? 0),
      },
      lastImport: lastImport ? { fileName: lastImport.file_name, at: lastImport.completed_at } : null,
    });
  }),
);

crmRouter.get(
  '/customers',
  requireCapability('crm.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize ?? 50)));

    let base = db('crm_links').where({ company_id: req.companyId });

    // Sales users see only their own accounts, enforced here rather than in the UI.
    if (req.user!.role === 'sales') base = base.andWhere('owner', req.user!.email.toLowerCase());

    if (req.query.search) {
      const p = `%${String(req.query.search).toLowerCase()}%`;
      base = base.andWhere((qb) => {
        qb.whereRaw('LOWER(customer_name) LIKE ?', [p]).orWhereRaw("LOWER(COALESCE(gstin,'')) LIKE ?", [p]);
      });
    }
    if (req.query.linked === 'false') base = base.whereNull('ledger_id');

    const countRow = await base.clone().count({ c: '*' }).first();
    const rows = await base.clone().orderBy('customer_name').limit(pageSize).offset((page - 1) * pageSize);

    // Outstanding per customer, from the accounting side.
    const asOf = today();
    const receivables = await db('receivables').where({ company_id: req.companyId }).andWhere('outstanding_minor', '!=', 0);
    const byParty = new Map<string, { outstanding: Minor; count: number; oldestDue: string | null }>();
    for (const r of receivables) {
      const k = normalizeName(r.party_name);
      const e = byParty.get(k) ?? { outstanding: 0, count: 0, oldestDue: null };
      e.outstanding = add(e.outstanding, Number(r.outstanding_minor));
      e.count++;
      if (r.due_date && (!e.oldestDue || r.due_date < e.oldestDue)) e.oldestDue = r.due_date;
      byParty.set(k, e);
    }

    res.json({
      customers: rows.map((c: Record<string, any>) => {
        const match = byParty.get(normalizeName(c.customer_name));
        return {
          id: c.id,
          customerName: c.customer_name,
          gstin: c.gstin,
          contactEmail: c.contact_email,
          contactPhone: c.contact_phone,
          owner: c.owner,
          ledgerId: c.ledger_id,
          matchMethod: c.match_method,
          crmAccountId: c.crm_account_id,
          crmSource: c.crm_source,
          outstanding: match?.outstanding ?? 0,
          openInvoices: match?.count ?? 0,
          oldestDueDate: match?.oldestDue ?? null,
          fromImport: Boolean(c.source_batch_id),
        };
      }),
      pagination: { page, pageSize, total: Number(countRow?.c ?? 0) },
      asOfDate: asOf,
      note: 'Deals, contacts and activity require a connected CRM and are not shown. Outstanding figures come from imported receivables.',
    });
  }),
);

crmRouter.get(
  '/customers/:id',
  requireCapability('crm.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const customer = await db('crm_links').where({ id: req.params.id, company_id: req.companyId }).first();
    if (!customer) throw notFound('That customer could not be found.');

    if (req.user!.role === 'sales' && (customer.owner ?? '') !== req.user!.email.toLowerCase()) {
      throw notFound('That customer could not be found.');
    }

    const asOf = today();
    const outstanding = await listOutstanding({
      companyId: req.companyId!,
      table: 'receivables',
      asOfDate: asOf,
      partyName: customer.customer_name,
      pageSize: 200,
    });

    const ledger = customer.ledger_id ? await db('ledgers').where({ id: customer.ledger_id }).first() : null;

    res.json({
      customer: {
        id: customer.id,
        customerName: customer.customer_name,
        gstin: customer.gstin,
        contactEmail: customer.contact_email,
        contactPhone: customer.contact_phone,
        owner: customer.owner,
        matchMethod: customer.match_method,
        crmAccountId: customer.crm_account_id,
      },
      ledger: ledger ? { id: ledger.id, name: ledger.name, groupName: ledger.group_name } : null,
      outstanding: outstanding.documents,
      summary: outstanding.summary,
      crmData: {
        available: false,
        reason: 'No CRM is connected, so deals, contacts and activity for this customer are not available.',
      },
    });
  }),
);

crmRouter.post(
  '/customers/:id/link',
  requireCapability('crm.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const schema = z.object({ ledgerId: z.string().nullable() });
    const { ledgerId } = schema.parse(req.body);

    const customer = await db('crm_links').where({ id: req.params.id, company_id: req.companyId }).first();
    if (!customer) throw notFound('That customer could not be found.');

    if (ledgerId) {
      const ledger = await db('ledgers').where({ id: ledgerId, company_id: req.companyId }).first();
      if (!ledger) throw badRequest('That ledger does not belong to this company.');
    }

    await db('crm_links').where({ id: customer.id }).update({
      ledger_id: ledgerId,
      match_method: ledgerId ? 'manual' : null,
      updated_at: nowIso(),
    });

    await recordAudit({
      action: 'crm.linked',
      summary: ledgerId
        ? `Linked customer "${customer.customer_name}" to a ledger`
        : `Removed the ledger link for customer "${customer.customer_name}"`,
      companyId: req.companyId,
      entityType: 'crm_link',
      entityId: customer.id,
      req,
    });

    res.json({ ok: true });
  }),
);

/** Attempts to link every unlinked customer by GSTIN, then by name. */
crmRouter.post(
  '/auto-link',
  requireCapability('crm.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const unlinked = await db('crm_links').where({ company_id: req.companyId }).whereNull('ledger_id');
    const ledgers = await db('ledgers').where({ company_id: req.companyId });

    const byGstin = new Map(ledgers.filter((l: Record<string, any>) => l.gstin).map((l: Record<string, any>) => [l.gstin, l]));
    const byName = new Map(ledgers.map((l: Record<string, any>) => [l.normalized_name, l]));

    let linked = 0;
    const now = nowIso();

    for (const c of unlinked) {
      let match = c.gstin ? byGstin.get(c.gstin) : undefined;
      let method = 'gstin';
      if (!match) {
        match = byName.get(normalizeName(c.customer_name));
        method = 'name';
      }
      if (!match) continue;

      await db('crm_links').where({ id: c.id }).update({ ledger_id: match.id, match_method: method, updated_at: now });
      linked++;
    }

    await recordAudit({
      action: 'crm.linked',
      summary: `Automatically linked ${linked} customer record(s) to ledgers`,
      companyId: req.companyId,
      meta: { linked, attempted: unlinked.length },
      req,
    });

    res.json({
      linked,
      remaining: unlinked.length - linked,
      note:
        unlinked.length - linked > 0
          ? `${unlinked.length - linked} customer(s) could not be matched by GSTIN or by name. Link those manually.`
          : undefined,
    });
  }),
);
