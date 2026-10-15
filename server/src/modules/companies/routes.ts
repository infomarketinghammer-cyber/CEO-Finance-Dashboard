import { Router } from 'express';
import { z } from 'zod';
import { db, dialect, withTransaction } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany, accessibleCompanyIds } from '../../middleware/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newId, nowIso } from '../../lib/ids.js';
import { recordAudit } from '../audit/service.js';

export const companiesRouter = Router();
companiesRouter.use(authenticate);

export const ENTITY_TYPES = [
  'proprietorship',
  'partnership',
  'llp',
  'private_limited',
  'public_limited',
  'trust',
  'society',
  'other',
] as const;

export const ENTITY_LABELS: Record<string, string> = {
  proprietorship: 'Proprietorship',
  partnership: 'Partnership Firm',
  llp: 'Limited Liability Partnership',
  private_limited: 'Private Limited Company',
  public_limited: 'Public Limited Company',
  trust: 'Trust',
  society: 'Society',
  other: 'Other',
};

const companySchema = z.object({
  name: z.string().trim().min(2, 'Company name is required').max(200),
  legalName: z.string().trim().max(255).optional().nullable(),
  entityType: z.enum(ENTITY_TYPES),
  gstin: z
    .string()
    .trim()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'That does not look like a valid 15-character GSTIN')
    .optional()
    .or(z.literal('')),
  pan: z
    .string()
    .trim()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'That does not look like a valid 10-character PAN')
    .optional()
    .or(z.literal('')),
  currency: z.string().trim().length(3).default('INR'),
  currencyScale: z.number().int().min(0).max(4).default(2),
  country: z.string().trim().max(64).default('India'),
  address: z.string().trim().max(1000).optional().nullable(),
  isDemo: z.boolean().default(false),
});

// ------------------------------------------------------------------ companies

companiesRouter.get(
  '/',
  requireCapability('companies.view'),
  asyncHandler(async (req, res) => {
    const allowed = await accessibleCompanyIds(req.user!);
    let query = db('companies').where('is_active', true).orderBy('name');
    if (allowed !== null) query = query.whereIn('id', allowed.length ? allowed : ['__none__']);

    const rows = await query;
    const ids = rows.map((r: { id: string }) => r.id);

    // Freshness is derived from imports, never described as a live sync.
    const lastImports = ids.length
      ? await db('import_batches')
          .whereIn('company_id', ids)
          .andWhere('status', 'committed')
          .orderBy('completed_at', 'desc')
          .select('company_id', 'completed_at', 'file_name', 'category')
      : [];

    const freshness = new Map<string, { at: string; fileName: string; category: string }>();
    for (const imp of lastImports) {
      if (!freshness.has(imp.company_id)) {
        freshness.set(imp.company_id, { at: imp.completed_at, fileName: imp.file_name, category: imp.category });
      }
    }

    res.json({
      companies: await Promise.all(rows.map(async (c: Record<string, any>) => ({
        ...serialiseCompany(c),
        financialYears: (await db('financial_years').where({ company_id: c.id }).orderBy('start_date', 'desc')).map(
          serialiseFinancialYear,
        ),
        lastImport: freshness.get(c.id) ?? null,
      }))),
    });
  }),
);

companiesRouter.post(
  '/',
  requireCapability('companies.manage'),
  asyncHandler(async (req, res) => {
    const input = companySchema.parse(req.body);

    const duplicate = await db('companies').whereRaw('LOWER(name) = LOWER(?)', [input.name]).first();
    if (duplicate) throw conflict(`A company named "${input.name}" already exists.`);

    const now = nowIso();
    const id = newId();

    await withTransaction(async (trx) => {
      await trx('companies').insert({
        id,
        name: input.name,
        legal_name: input.legalName || null,
        entity_type: input.entityType,
        gstin: input.gstin || null,
        pan: input.pan || null,
        currency: input.currency,
        currency_scale: input.currencyScale,
        country: input.country,
        address: input.address || null,
        is_demo: input.isDemo,
        is_active: true,
        created_by: req.user!.id,
        created_at: now,
        updated_at: now,
      });

      // The creator keeps access even if they are not an administrator.
      await trx('user_companies').insert({
        id: newId(),
        user_id: req.user!.id,
        company_id: id,
        created_at: now,
      });
    });

    await recordAudit({
      action: 'company.created',
      summary: `Created company "${input.name}"`,
      companyId: id,
      entityType: 'company',
      entityId: id,
      meta: { entityType: input.entityType, currency: input.currency, isDemo: input.isDemo },
      req,
    });

    const created = await db('companies').where({ id }).first();
    res.status(201).json({ company: serialiseCompany(created) });
  }),
);

companiesRouter.get(
  '/:companyId',
  requireCapability('companies.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const company = await db('companies').where({ id: req.companyId }).first();
    if (!company) throw notFound('Company not found.');

    const years = await db('financial_years').where({ company_id: req.companyId }).orderBy('start_date', 'desc');

    const counts = await Promise.all([
      db('ledgers').where({ company_id: req.companyId }).count({ c: '*' }).first(),
      db('vouchers').where({ company_id: req.companyId }).count({ c: '*' }).first(),
      db('receivables').where({ company_id: req.companyId }).count({ c: '*' }).first(),
      db('payables').where({ company_id: req.companyId }).count({ c: '*' }).first(),
      db('import_batches').where({ company_id: req.companyId, status: 'committed' }).count({ c: '*' }).first(),
    ]);

    res.json({
      company: serialiseCompany(company),
      financialYears: years.map(serialiseFinancialYear),
      dataCounts: {
        ledgers: Number(counts[0]?.c ?? 0),
        vouchers: Number(counts[1]?.c ?? 0),
        receivables: Number(counts[2]?.c ?? 0),
        payables: Number(counts[3]?.c ?? 0),
        imports: Number(counts[4]?.c ?? 0),
      },
    });
  }),
);

companiesRouter.patch(
  '/:companyId',
  requireCapability('companies.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const input = companySchema.partial().parse(req.body);
    const company = await db('companies').where({ id: req.companyId }).first();
    if (!company) throw notFound('Company not found.');

    // Changing the currency scale would silently reinterpret every stored amount.
    if (input.currencyScale !== undefined && input.currencyScale !== company.currency_scale) {
      const hasData = await db('voucher_lines').where({ company_id: req.companyId }).first();
      if (hasData) {
        throw badRequest(
          'The decimal scale cannot be changed once financial records exist, because stored amounts are held at the current scale.',
        );
      }
    }

    const patch: Record<string, unknown> = { updated_at: nowIso() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.legalName !== undefined) patch.legal_name = input.legalName || null;
    if (input.entityType !== undefined) patch.entity_type = input.entityType;
    if (input.gstin !== undefined) patch.gstin = input.gstin || null;
    if (input.pan !== undefined) patch.pan = input.pan || null;
    if (input.currency !== undefined) patch.currency = input.currency;
    if (input.currencyScale !== undefined) patch.currency_scale = input.currencyScale;
    if (input.country !== undefined) patch.country = input.country;
    if (input.address !== undefined) patch.address = input.address || null;

    await db('companies').where({ id: req.companyId }).update(patch);

    await recordAudit({
      action: 'company.updated',
      summary: `Updated company "${input.name ?? company.name}"`,
      companyId: req.companyId,
      entityType: 'company',
      entityId: req.companyId,
      meta: { fields: Object.keys(patch).filter((k) => k !== 'updated_at') },
      req,
    });

    res.json({ company: serialiseCompany(await db('companies').where({ id: req.companyId }).first()) });
  }),
);

// ----------------------------------------------------------- financial years

const fySchema = z
  .object({
    label: z.string().trim().min(2).max(40),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD'),
  })
  .refine((v) => v.endDate > v.startDate, {
    message: 'The end date must fall after the start date',
    path: ['endDate'],
  });

companiesRouter.get(
  '/:companyId/financial-years',
  requireCapability('companies.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const years = await db('financial_years').where({ company_id: req.companyId }).orderBy('start_date', 'desc');
    res.json({ financialYears: years.map(serialiseFinancialYear) });
  }),
);

companiesRouter.post(
  '/:companyId/financial-years',
  requireCapability('companies.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const input = fySchema.parse(req.body);

    const clash = await db('financial_years')
      .where({ company_id: req.companyId })
      .andWhere('start_date', '<=', input.endDate)
      .andWhere('end_date', '>=', input.startDate)
      .first();
    if (clash) {
      throw conflict(
        `That period overlaps "${clash.label}" (${clash.start_date} to ${clash.end_date}). Financial years must not overlap.`,
      );
    }

    const id = newId();
    const now = nowIso();
    await db('financial_years').insert({
      id,
      company_id: req.companyId,
      label: input.label,
      start_date: input.startDate,
      end_date: input.endDate,
      is_active: true,
      created_at: now,
      updated_at: now,
    });

    await recordAudit({
      action: 'financial_year.created',
      summary: `Added financial year "${input.label}" (${input.startDate} to ${input.endDate})`,
      companyId: req.companyId,
      entityType: 'financial_year',
      entityId: id,
      req,
    });

    res.status(201).json({ financialYear: serialiseFinancialYear(await db('financial_years').where({ id }).first()) });
  }),
);

/** Suggests the Indian April–March years around today, excluding ones already defined. */
companiesRouter.get(
  '/:companyId/financial-years/suggestions',
  requireCapability('companies.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const existing = await db('financial_years').where({ company_id: req.companyId }).select('start_date');
    const taken = new Set(existing.map((r: { start_date: string }) => r.start_date));

    const now = new Date();
    const currentFyStartYear = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;

    const suggestions = [];
    for (let offset = 1; offset >= -1; offset--) {
      const y = currentFyStartYear - offset;
      const startDate = `${y}-04-01`;
      if (taken.has(startDate)) continue;
      suggestions.push({
        label: `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}`,
        startDate,
        endDate: `${y + 1}-03-31`,
        isCurrent: y === currentFyStartYear,
      });
    }

    res.json({ suggestions });
  }),
);

export function serialiseCompany(row: Record<string, any>) {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name ?? null,
    entityType: row.entity_type,
    entityLabel: ENTITY_LABELS[row.entity_type] ?? row.entity_type,
    gstin: row.gstin ?? null,
    pan: row.pan ?? null,
    currency: row.currency,
    currencyScale: row.currency_scale,
    country: row.country,
    address: row.address ?? null,
    isDemo: dialect.bool(row.is_demo),
    isActive: dialect.bool(row.is_active),
    createdAt: row.created_at,
  };
}

export function serialiseFinancialYear(row: Record<string, any>) {
  return {
    id: row.id,
    companyId: row.company_id,
    label: row.label,
    startDate: row.start_date,
    endDate: row.end_date,
    isActive: dialect.bool(row.is_active),
  };
}
