import { Router } from 'express';
import { z } from 'zod';
import { db, dialect, withTransaction } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany } from '../../middleware/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newId, nowIso } from '../../lib/ids.js';
import { add, sub, type Minor } from '../../lib/money.js';
import { recordAudit } from '../audit/service.js';
import { loadBalances } from '../finance/engine.js';
import { resolvePeriod } from '../finance/periods.js';
import { suggestCategoryForLedger, describeImpact } from './suggest.js';
import { SYSTEM_CATEGORIES } from './categories.js';
import { refreshAlerts } from '../alerts/service.js';

export const mappingRouter = Router();
mappingRouter.use(authenticate);

// ---------------------------------------------------------------- categories

mappingRouter.get(
  '/categories',
  requireCapability('mapping.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const rows = await db('account_categories')
      .where(function () {
        this.whereNull('company_id').orWhere('company_id', req.companyId);
      })
      .orderBy('sort_order');

    res.json({
      categories: rows.map((r: Record<string, any>) => ({
        id: r.id,
        key: r.key,
        label: r.label,
        statement: r.statement,
        section: r.section,
        normalSide: r.normal_side,
        sortOrder: r.sort_order,
        isSystem: dialect.bool(r.is_system),
        isActive: dialect.bool(r.is_active),
        isCompanySpecific: r.company_id !== null,
        description: r.description,
      })),
    });
  }),
);

const categorySchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, numbers and underscores, starting with a letter'),
  label: z.string().trim().min(2).max(120),
  statement: z.enum(['PL', 'BS']),
  section: z.string().trim().min(2).max(48),
  normalSide: z.enum(['debit', 'credit']),
  description: z.string().trim().max(500).optional(),
  sortOrder: z.number().int().min(0).max(9999).default(500),
});

mappingRouter.post(
  '/categories',
  requireCapability('mapping.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const input = categorySchema.parse(req.body);

    const clash = await db('account_categories')
      .where({ key: input.key })
      .andWhere(function () {
        this.whereNull('company_id').orWhere('company_id', req.companyId);
      })
      .first();
    if (clash) throw conflict(`A category with the key "${input.key}" already exists.`);

    // A custom category inherits the behaviour of its section, so it must use one
    // the calculation engine recognises.
    const knownSections = new Set(SYSTEM_CATEGORIES.map((c) => c.section));
    if (!knownSections.has(input.section)) {
      throw badRequest(
        `"${input.section}" is not a recognised statement section. Use one of: ${[...knownSections].join(', ')}. The section decides where the balance appears and how it is signed.`,
      );
    }

    const id = newId();
    const now = nowIso();
    await db('account_categories').insert({
      id,
      company_id: req.companyId,
      key: input.key,
      label: input.label,
      statement: input.statement,
      section: input.section,
      normal_side: input.normalSide,
      sort_order: input.sortOrder,
      is_system: false,
      is_active: true,
      description: input.description ?? null,
      created_at: now,
      updated_at: now,
    });

    await recordAudit({
      action: 'category.created',
      summary: `Created the custom account category "${input.label}"`,
      companyId: req.companyId,
      entityType: 'account_category',
      entityId: id,
      req,
    });

    res.status(201).json({ category: { id, ...input, isSystem: false, isActive: true } });
  }),
);

mappingRouter.patch(
  '/categories/:categoryId',
  requireCapability('mapping.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const row = await db('account_categories').where({ id: req.params.categoryId }).first();
    if (!row) throw notFound('That category could not be found.');
    if (row.company_id !== req.companyId && dialect.bool(row.is_system)) {
      // A system category can be deactivated for a company but not edited globally.
      const schema = z.object({ isActive: z.boolean() });
      const { isActive } = schema.parse(req.body);

      const override = await db('account_categories').where({ company_id: req.companyId, key: row.key }).first();
      if (override) {
        await db('account_categories').where({ id: override.id }).update({ is_active: isActive, updated_at: nowIso() });
      } else {
        await db('account_categories').insert({
          id: newId(),
          company_id: req.companyId,
          key: row.key,
          label: row.label,
          statement: row.statement,
          section: row.section,
          normal_side: row.normal_side,
          sort_order: row.sort_order,
          is_system: false,
          is_active: isActive,
          description: row.description,
          created_at: nowIso(),
          updated_at: nowIso(),
        });
      }
      return res.json({ ok: true, scope: 'company_override' });
    }

    const schema = categorySchema.partial().extend({ isActive: z.boolean().optional() });
    const input = schema.parse(req.body);
    const patch: Record<string, unknown> = { updated_at: nowIso() };
    if (input.label !== undefined) patch.label = input.label;
    if (input.description !== undefined) patch.description = input.description;
    if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
    if (input.isActive !== undefined) patch.is_active = input.isActive;

    await db('account_categories').where({ id: row.id }).update(patch);
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ mappings

mappingRouter.get(
  '/ledgers',
  requireCapability('mapping.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod({
      companyId: req.companyId!,
      financialYearId: (req.query.financialYearId as string) || null,
      periodType: 'financial_year',
    });

    const set = await loadBalances(req.companyId!, resolved.period, { financialYearId: resolved.financialYearId });

    const statusFilter = req.query.status as string | undefined;
    const search = (req.query.search as string | undefined)?.toLowerCase();

    const mappings = await db('account_mappings').where({ company_id: req.companyId });
    const mappingByLedger = new Map(mappings.map((m: Record<string, any>) => [m.ledger_id, m]));

    let rows = set.balances.map((b) => {
      const m = mappingByLedger.get(b.ledgerId);
      return {
        ledgerId: b.ledgerId,
        ledgerName: b.ledgerName,
        groupName: b.groupName,
        categoryKey: m?.category_key ?? null,
        categoryLabel: b.categoryLabel,
        status: b.mappingStatus,
        confidence: m?.confidence === null || m?.confidence === undefined ? null : Number(m.confidence),
        reason: m?.reason ?? null,
        previousCategoryKey: m?.previous_category_key ?? null,
        changedSinceLastImport: Boolean(m?.previous_category_key && m.previous_category_key !== m.category_key),
        closingBalance: b.closingNet,
        transactionCount: b.transactionCount,
        impact: m?.category_key ? describeImpact(m.category_key) : null,
      };
    });

    if (statusFilter === 'unmapped') rows = rows.filter((r) => r.status === 'unmapped');
    else if (statusFilter === 'suggested') rows = rows.filter((r) => r.status === 'suggested');
    else if (statusFilter === 'confirmed') rows = rows.filter((r) => r.status === 'confirmed');

    if (search) {
      rows = rows.filter((r) => r.ledgerName.toLowerCase().includes(search) || (r.groupName ?? '').toLowerCase().includes(search));
    }

    rows.sort((a, b) => {
      const rank = (s: string) => (s === 'unmapped' ? 0 : s === 'suggested' ? 1 : 2);
      const d = rank(a.status) - rank(b.status);
      if (d !== 0) return d;
      return Math.abs(b.closingBalance) - Math.abs(a.closingBalance);
    });

    const unmappedNet = set.balances.filter((b) => b.mappingStatus === 'unmapped').reduce((acc, b) => add(acc, b.closingNet), 0 as Minor);

    res.json({
      ledgers: rows,
      summary: {
        total: set.balances.length,
        confirmed: set.balances.filter((b) => b.mappingStatus === 'confirmed').length,
        suggested: set.balances.filter((b) => b.mappingStatus === 'suggested').length,
        unmapped: set.balances.filter((b) => b.mappingStatus === 'unmapped').length,
        unmappedNet,
      },
      quality: set.quality,
      period: resolved.period,
    });
  }),
);

const assignSchema = z.object({
  ledgerIds: z.array(z.string()).min(1).max(500),
  categoryKey: z.string().min(1).nullable(),
  confirm: z.boolean().default(true),
});

mappingRouter.post(
  '/assign',
  requireCapability('mapping.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const input = assignSchema.parse(req.body);

    if (input.categoryKey) {
      const category = await db('account_categories')
        .where({ key: input.categoryKey })
        .andWhere(function () {
          this.whereNull('company_id').orWhere('company_id', req.companyId);
        })
        .andWhere('is_active', true)
        .first();
      if (!category) throw badRequest(`"${input.categoryKey}" is not an active category for this company.`);
    }

    const ledgers = await db('ledgers').whereIn('id', input.ledgerIds).andWhere('company_id', req.companyId);
    if (ledgers.length !== input.ledgerIds.length) {
      throw badRequest('One or more of the selected ledgers do not belong to this company.');
    }

    const now = nowIso();
    let updated = 0;

    await withTransaction(async (trx) => {
      for (const ledger of ledgers) {
        const existing = await trx('account_mappings').where({ company_id: req.companyId, ledger_id: ledger.id }).first();

        if (existing) {
          await trx('account_mappings')
            .where({ id: existing.id })
            .update({
              previous_category_key: existing.category_key,
              category_key: input.categoryKey,
              status: input.confirm ? 'confirmed' : 'suggested',
              confirmed_by: input.confirm ? req.user!.id : null,
              confirmed_at: input.confirm ? now : null,
              reason: input.confirm ? `Confirmed by ${req.user!.name}` : existing.reason,
              updated_at: now,
            });
        } else {
          await trx('account_mappings').insert({
            id: newId(),
            company_id: req.companyId,
            ledger_id: ledger.id,
            category_key: input.categoryKey,
            status: input.confirm ? 'confirmed' : 'suggested',
            confidence: null,
            reason: input.confirm ? `Set by ${req.user!.name}` : null,
            created_by: req.user!.id,
            confirmed_by: input.confirm ? req.user!.id : null,
            confirmed_at: input.confirm ? now : null,
            created_at: now,
            updated_at: now,
          });
        }
        updated++;
      }
    });

    await recordAudit({
      action: input.ledgerIds.length > 1 ? 'mapping.bulk_changed' : 'mapping.changed',
      summary:
        input.ledgerIds.length > 1
          ? `Mapped ${updated} ledgers to ${input.categoryKey ?? 'no category'}`
          : `Mapped "${ledgers[0].name}" to ${input.categoryKey ?? 'no category'}`,
      companyId: req.companyId,
      entityType: 'account_mapping',
      meta: { ledgerCount: updated, categoryKey: input.categoryKey, confirmed: input.confirm },
      req,
    });

    await refreshAlerts(req.companyId!).catch(() => undefined);

    res.json({ updated, impact: input.categoryKey ? describeImpact(input.categoryKey) : 'These ledgers are now excluded from the statements.' });
  }),
);

mappingRouter.post(
  '/accept-suggestions',
  requireCapability('mapping.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const schema = z.object({ minConfidence: z.number().min(0).max(1).default(0.8) });
    const { minConfidence } = schema.parse(req.body ?? {});

    const candidates = await db('account_mappings')
      .where({ company_id: req.companyId, status: 'suggested' })
      .whereNotNull('category_key')
      .andWhere('confidence', '>=', minConfidence);

    const now = nowIso();
    for (const c of candidates) {
      await db('account_mappings').where({ id: c.id }).update({
        status: 'confirmed',
        confirmed_by: req.user!.id,
        confirmed_at: now,
        updated_at: now,
      });
    }

    await recordAudit({
      action: 'mapping.bulk_changed',
      summary: `Accepted ${candidates.length} suggested mapping(s) at ${Math.round(minConfidence * 100)}% confidence or above`,
      companyId: req.companyId,
      meta: { count: candidates.length, minConfidence },
      req,
    });

    await refreshAlerts(req.companyId!).catch(() => undefined);

    res.json({
      confirmed: candidates.length,
      note:
        candidates.length === 0
          ? 'No suggestion met that confidence threshold. Lower the threshold or review the remaining ledgers one at a time.'
          : `${candidates.length} mapping(s) confirmed. Ledgers below the threshold are left for you to review, because a weak suggestion filed silently is how a balance ends up in the wrong statement.`,
    });
  }),
);

mappingRouter.post(
  '/resuggest',
  requireCapability('mapping.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const categories = await db('account_categories')
      .where(function () {
        this.whereNull('company_id').orWhere('company_id', req.companyId);
      })
      .andWhere('is_active', true)
      .select('key');

    const unmapped = await db('ledgers')
      .where('ledgers.company_id', req.companyId)
      .leftJoin('account_mappings', 'account_mappings.ledger_id', 'ledgers.id')
      .where(function () {
        this.whereNull('account_mappings.id').orWhereNull('account_mappings.category_key');
      })
      .select('ledgers.id', 'ledgers.name', 'ledgers.group_name', 'account_mappings.id as mapping_id');

    const now = nowIso();
    let suggested = 0;

    for (const l of unmapped) {
      const s = suggestCategoryForLedger(l.name, l.group_name, categories);
      if (!s.categoryKey) continue;

      if (l.mapping_id) {
        await db('account_mappings').where({ id: l.mapping_id }).update({
          category_key: s.categoryKey,
          confidence: s.confidence,
          reason: s.reason,
          status: 'suggested',
          updated_at: now,
        });
      } else {
        await db('account_mappings').insert({
          id: newId(),
          company_id: req.companyId,
          ledger_id: l.id,
          category_key: s.categoryKey,
          status: 'suggested',
          confidence: s.confidence,
          reason: s.reason,
          created_by: req.user!.id,
          created_at: now,
          updated_at: now,
        });
      }
      suggested++;
    }

    res.json({
      suggested,
      remaining: unmapped.length - suggested,
      note:
        unmapped.length - suggested > 0
          ? `${unmapped.length - suggested} ledger(s) could not be matched confidently and are left unmapped for you to decide.`
          : undefined,
    });
  }),
);

/** Shows what changing one ledger's category would do, before it is applied. */
mappingRouter.get(
  '/impact/:ledgerId',
  requireCapability('mapping.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod({ companyId: req.companyId!, periodType: 'financial_year' });
    const set = await loadBalances(req.companyId!, resolved.period, { financialYearId: resolved.financialYearId });
    const balance = set.balances.find((b) => b.ledgerId === req.params.ledgerId);
    if (!balance) throw notFound('That ledger could not be found for this company.');

    const candidateKey = req.query.categoryKey as string | undefined;
    const category = candidateKey ? SYSTEM_CATEGORIES.find((c) => c.key === candidateKey) : null;

    res.json({
      ledger: { id: balance.ledgerId, name: balance.ledgerName, groupName: balance.groupName },
      closingBalance: balance.closingNet,
      currentCategory: balance.categoryKey,
      candidate: category
        ? {
            key: category.key,
            label: category.label,
            statement: category.statement,
            presentedValue: category.normalSide === 'credit' ? -balance.closingNet : balance.closingNet,
            effect: `${(Math.abs(balance.closingNet) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} would move into ${category.label} on the ${category.statement === 'PL' ? 'Profit & Loss' : 'Balance Sheet'}.`,
          }
        : null,
    });
  }),
);

export { sub };
