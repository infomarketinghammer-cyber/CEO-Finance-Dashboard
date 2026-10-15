import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db, dialect, withTransaction } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany } from '../../middleware/auth.js';
import { badRequest, notFound, conflict, unprocessable } from '../../lib/errors.js';
import { newId, nowIso, sha256, normalizeName } from '../../lib/ids.js';
import { readJson, writeJson } from '../../lib/json.js';
import { recordAudit } from '../audit/service.js';
import { IMPORT_CATEGORIES, getCategory } from './categories.js';
import { readWorkbook, summariseSheets, readSheet } from './workbook.js';
import { suggestMapping, headerSignature, validateMapping, type ColumnMapping } from './mapper.js';
import { validateDataset, type ImportOptions } from './validator.js';
import { commitDataset, type DuplicateStrategy } from './committer.js';
import { buildTemplate, buildRejectionReport } from './templates.js';
import { refreshAlerts } from '../alerts/service.js';

export const importsRouter = Router();
importsRouter.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) cb(null, true);
    else cb(new Error(`"${ext || 'This file'}" is not a supported format. Upload an .xlsx, .xls or .csv file.`));
  },
});

const PREVIEW_ROWS = 25;

// ------------------------------------------------------------------ metadata

importsRouter.get(
  '/categories',
  requireCapability('imports.view'),
  asyncHandler(async (_req, res) => {
    res.json({
      categories: IMPORT_CATEGORIES.map((c) => ({
        key: c.key,
        label: c.label,
        description: c.description,
        enables: c.enables,
        supportsPartialImport: c.supportsPartialImport,
        supportsForwardFill: Boolean(c.supportsForwardFill),
        duplicateBasis: c.duplicateBasis,
        fields: c.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          required: Boolean(f.required),
          enumValues: f.enumValues ?? null,
          help: f.help ?? null,
        })),
        anyOf: c.anyOf ?? [],
      })),
    });
  }),
);

importsRouter.get(
  '/templates/:categoryKey',
  requireCapability('imports.view'),
  asyncHandler(async (req, res) => {
    const category = getCategory(req.params.categoryKey);
    const buffer = await buildTemplate(category.key);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="DHYEYA-template-${category.key}.xlsx"`);
    res.send(buffer);
  }),
);

// -------------------------------------------------------------- step 3: upload

importsRouter.post(
  '/upload',
  requireCapability('imports.create'),
  upload.single('file'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file was received. Choose a workbook and try again.');

    const categoryKey = String(req.body.category ?? '');
    const category = getCategory(categoryKey);
    const financialYearId = (req.body.financialYearId as string) || null;

    if (financialYearId) {
      const fy = await db('financial_years').where({ id: financialYearId, company_id: req.companyId }).first();
      if (!fy) throw badRequest('The selected financial year does not belong to this company.');
    }

    const checksum = sha256(req.file.buffer);

    // Re-uploading an identical file is usually a mistake; say so rather than
    // quietly creating a second batch over the same numbers.
    const priorIdentical = await db('import_batches')
      .where({ company_id: req.companyId, checksum, category: categoryKey, status: 'committed' })
      .orderBy('completed_at', 'desc')
      .first();

    const wb = readWorkbook(req.file.buffer, req.file.originalname);
    const sheets = summariseSheets(wb);
    if (!sheets.some((s) => !s.isEmpty)) {
      throw badRequest(
        `"${req.file.originalname}" contains no readable table. Check that the sheet has a heading row followed by data rows.`,
      );
    }

    const batchId = newId();
    const dir = path.join(env.uploadDir, req.companyId!);
    await fs.mkdir(dir, { recursive: true });
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const storedPath = path.join(dir, `${batchId}__${safeName}`);
    await fs.writeFile(storedPath, req.file.buffer, { mode: 0o600 });

    const now = nowIso();
    await db('import_batches').insert({
      id: batchId,
      company_id: req.companyId,
      financial_year_id: financialYearId,
      category: categoryKey,
      file_name: req.file.originalname,
      file_size: req.file.size,
      stored_path: storedPath,
      checksum,
      status: 'uploaded',
      created_by: req.user!.id,
      created_at: now,
      updated_at: now,
    });

    await recordAudit({
      action: 'import.uploaded',
      summary: `Uploaded "${req.file.originalname}" for ${category.label}`,
      companyId: req.companyId,
      entityType: 'import_batch',
      entityId: batchId,
      meta: { category: categoryKey, sizeBytes: req.file.size, sheets: sheets.length },
      req,
    });

    res.status(201).json({
      batch: {
        id: batchId,
        category: categoryKey,
        categoryLabel: category.label,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        status: 'uploaded',
        financialYearId,
      },
      sheets,
      previousIdenticalImport: priorIdentical
        ? {
            id: priorIdentical.id,
            completedAt: priorIdentical.completed_at,
            fileName: priorIdentical.file_name,
            message:
              'A file with identical contents was already imported for this company. Continuing is safe — matching records are detected and handled using the duplicate option you choose — but check that this is not an accidental re-upload.',
          }
        : null,
    });
  }),
);

// ------------------------------------------------- step 3/4: inspect and map

importsRouter.get(
  '/batches/:batchId/inspect',
  requireCapability('imports.view'),
  asyncHandler(async (req, res) => {
    const batch = await loadBatch(req.params.batchId, req);
    const category = getCategory(batch.category);

    const buffer = await fs.readFile(batch.stored_path);
    const wb = readWorkbook(buffer, batch.file_name);
    const sheets = summariseSheets(wb);

    const sheetName = (req.query.sheet as string) ?? batch.sheet_name ?? sheets.find((s) => !s.isEmpty)?.name ?? sheets[0]?.name;
    if (!sheetName) throw badRequest('The workbook has no readable sheet.');

    const headerRowOverride = req.query.headerRow !== undefined ? Number(req.query.headerRow) : undefined;
    const sheet = readSheet(wb, sheetName, { headerRowIndex: headerRowOverride });

    const { suggestions, unrecognisedHeaders } = suggestMapping(batch.category, sheet.headers, sheet.columns);

    // A mapping approved for this exact column set before is reused.
    const signature = headerSignature(sheet.headers);
    const profile = await db('mapping_profiles')
      .where({ company_id: batch.company_id, category: batch.category, header_signature: signature })
      .first();

    const savedMapping = profile ? readJson<ColumnMapping>(profile.mapping, {}) : null;
    const savedOptions = profile ? readJson<ImportOptions>(profile.options, {}) : null;

    const effectiveMapping: ColumnMapping = {};
    for (const s of suggestions) {
      effectiveMapping[s.fieldKey] = savedMapping?.[s.fieldKey] !== undefined ? savedMapping[s.fieldKey] : s.header;
    }

    res.json({
      batch: serialiseBatch(batch, category.label),
      sheets,
      sheet: {
        name: sheet.name,
        headerRowIndex: sheet.headerRowIndex,
        headers: sheet.headers,
        totalRows: sheet.totalRows,
        blankRowsSkipped: sheet.blankRowsSkipped,
        duplicateRowCount: sheet.duplicateRowCount,
        sampleRows: sheet.rows.slice(0, PREVIEW_ROWS).map((r, i) => ({
          rowNumber: sheet.rowNumbers[i],
          values: Object.fromEntries(
            Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v]),
          ),
        })),
        columns: sheet.columns,
      },
      suggestions,
      unrecognisedHeaders,
      effectiveMapping,
      savedProfile: profile
        ? { id: profile.id, name: profile.name, useCount: profile.use_count, options: savedOptions }
        : null,
      matchesSupportedTemplate: matchesTemplate(batch.category, sheet.headers),
    });
  }),
);

// ----------------------------------------------- step 5: validate and preview

const validateSchema = z.object({
  sheetName: z.string().min(1),
  headerRowIndex: z.number().int().min(0).optional(),
  mapping: z.record(z.string().nullable()),
  options: z
    .object({
      dateOrder: z.record(z.enum(['dmy', 'mdy', 'ymd', 'unknown'])).optional(),
      forwardFill: z.boolean().optional(),
      negativeMeansCredit: z.boolean().optional(),
      defaultOpeningSide: z.enum(['debit', 'credit']).optional(),
      imbalanceToleranceMinor: z.number().int().min(0).max(10000).optional(),
    })
    .optional(),
  rememberMapping: z.boolean().optional(),
});

importsRouter.post(
  '/batches/:batchId/validate',
  requireCapability('imports.create'),
  asyncHandler(async (req, res) => {
    const batch = await loadBatch(req.params.batchId, req);
    if (batch.status === 'committed') throw conflict('This import has already been committed and cannot be re-validated.');

    const input = validateSchema.parse(req.body);
    const category = getCategory(batch.category);

    const buffer = await fs.readFile(batch.stored_path);
    const wb = readWorkbook(buffer, batch.file_name);
    const sheet = readSheet(wb, input.sheetName, { headerRowIndex: input.headerRowIndex });

    const mappingCheck = validateMapping(batch.category, input.mapping, sheet.headers);
    if (!mappingCheck.ok) {
      throw unprocessable('The column mapping is incomplete.', { errors: mappingCheck.errors, warnings: mappingCheck.warnings });
    }

    const { knownLedgers, existingKeys } = await loadComparisonSets(batch.company_id, batch.category);

    const dataset = validateDataset({
      categoryKey: batch.category,
      sheet,
      mapping: input.mapping,
      options: input.options,
      knownLedgers,
      existingKeys,
    });

    await db('import_batches').where({ id: batch.id }).update({
      sheet_name: input.sheetName,
      status: 'validated',
      mapping: writeJson({ mapping: input.mapping, options: input.options ?? {}, headerRowIndex: sheet.headerRowIndex }),
      totals: writeJson(dataset.report),
      warnings: writeJson(mappingCheck.warnings),
      updated_at: nowIso(),
    });

    if (input.rememberMapping) {
      await saveMappingProfile(batch, sheet.headers, input.mapping, input.options ?? {}, req.user!.id);
    }

    res.json({
      report: dataset.report,
      mappingWarnings: mappingCheck.warnings,
      canImportAll: dataset.report.invalidRows === 0,
      canImportValidOnly: category.supportsPartialImport && dataset.report.validRows > 0,
      preview: buildPreview(dataset, batch.category),
      rejectedPreview: dataset.rejectedRows.slice(0, 50).map((r) => ({
        rowNumber: r.rowNumber,
        errors: r.errors,
        raw: Object.fromEntries(
          Object.entries(r.raw).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v]),
        ),
      })),
    });
  }),
);

// --------------------------------------------------- step 6: confirm and import

const commitSchema = z.object({
  duplicateStrategy: z.enum(['skip', 'update', 'review']).default('skip'),
  partialImport: z.boolean().default(false),
  acknowledgedWarnings: z.boolean().default(false),
});

importsRouter.post(
  '/batches/:batchId/commit',
  requireCapability('imports.create'),
  asyncHandler(async (req, res) => {
    const batch = await loadBatch(req.params.batchId, req);
    if (batch.status === 'committed') throw conflict('This import has already been committed.');
    if (batch.status !== 'validated') throw badRequest('Validate the file before importing it.');

    const input = commitSchema.parse(req.body);
    const category = getCategory(batch.category);

    const stored = readJson<{ mapping: ColumnMapping; options: ImportOptions; headerRowIndex: number }>(batch.mapping, {
      mapping: {},
      options: {},
      headerRowIndex: 0,
    });

    const buffer = await fs.readFile(batch.stored_path);
    const wb = readWorkbook(buffer, batch.file_name);
    const sheet = readSheet(wb, batch.sheet_name, { headerRowIndex: stored.headerRowIndex });

    const { knownLedgers, existingKeys } = await loadComparisonSets(batch.company_id, batch.category);

    const dataset = validateDataset({
      categoryKey: batch.category,
      sheet,
      mapping: stored.mapping,
      options: stored.options,
      knownLedgers,
      existingKeys,
    });

    if (dataset.report.invalidRows > 0 && !input.partialImport) {
      throw unprocessable(
        `${dataset.report.invalidRows} row${dataset.report.invalidRows === 1 ? '' : 's'} could not be read. Fix the file, or choose to import only the valid rows.`,
        { invalidRows: dataset.report.invalidRows },
      );
    }

    if (dataset.report.invalidRows > 0 && input.partialImport && !category.supportsPartialImport) {
      throw badRequest(`${category.label} does not support partial imports. Every row must be valid.`);
    }

    const now = nowIso();
    let commitResult;

    try {
      commitResult = await withTransaction(async (trx) => {
        const r = await commitDataset(dataset, {
          trx,
          companyId: batch.company_id,
          financialYearId: batch.financial_year_id,
          batchId: batch.id,
          userId: req.user!.id,
          duplicateStrategy: input.duplicateStrategy as DuplicateStrategy,
        });

        // Rejections are stored so the user can download them later, not only now.
        await trx('import_rejections').where({ batch_id: batch.id }).del();
        if (dataset.rejectedRows.length) {
          const chunks = chunk(
            dataset.rejectedRows.map((row) => ({
              id: newId(),
              batch_id: batch.id,
              row_number: row.rowNumber,
              raw: writeJson(
                Object.fromEntries(
                  Object.entries(row.raw).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v]),
                ),
              ),
              errors: writeJson(row.errors),
              severity: 'error',
              created_at: now,
            })),
            200,
          );
          for (const c of chunks) await trx('import_rejections').insert(c);
        }

        await trx('import_batches').where({ id: batch.id }).update({
          status: 'committed',
          duplicate_strategy: input.duplicateStrategy,
          partial_import: input.partialImport,
          totals: writeJson({ ...dataset.report, ...r }),
          completed_at: now,
          updated_at: now,
        });

        return r;
      });
    } catch (err) {
      await db('import_batches').where({ id: batch.id }).update({
        status: 'failed',
        error_message: err instanceof Error ? err.message : String(err),
        updated_at: nowIso(),
      });
      await recordAudit({
        action: 'import.failed',
        summary: `Import of "${batch.file_name}" failed and was rolled back`,
        companyId: batch.company_id,
        entityType: 'import_batch',
        entityId: batch.id,
        meta: { reason: err instanceof Error ? err.message : String(err) },
        req,
      });
      throw err;
    }

    await recordAudit({
      action: 'import.committed',
      summary: `Imported ${commitResult.inserted} new and ${commitResult.updated} updated ${category.label.toLowerCase()} record(s) from "${batch.file_name}"`,
      companyId: batch.company_id,
      entityType: 'import_batch',
      entityId: batch.id,
      meta: {
        category: batch.category,
        inserted: commitResult.inserted,
        updated: commitResult.updated,
        skipped: commitResult.skipped,
        rejected: dataset.report.invalidRows,
        ledgersCreated: commitResult.ledgersCreated,
        duplicateStrategy: input.duplicateStrategy,
      },
      req,
    });

    // Alerts are recomputed from the new position rather than left stale.
    await refreshAlerts(batch.company_id).catch(() => undefined);

    res.json({
      result: {
        processed: dataset.report.totalRows,
        accepted: commitResult.inserted + commitResult.updated,
        inserted: commitResult.inserted,
        updated: commitResult.updated,
        skipped: commitResult.skipped,
        rejected: dataset.report.invalidRows,
        ledgersCreated: commitResult.ledgersCreated,
        mappingsSuggested: commitResult.mappingsSuggested,
        changes: commitResult.changes.slice(0, 50),
        changeCount: commitResult.changes.length,
      },
      nextSteps: buildNextSteps(batch.category, commitResult, dataset.report.invalidRows),
    });
  }),
);

// ------------------------------------------------------------------- history

importsRouter.get(
  '/batches',
  requireCapability('imports.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize ?? 25)));
    const status = req.query.status as string | undefined;
    const categoryFilter = req.query.category as string | undefined;

    let query = db('import_batches').where({ company_id: req.companyId });
    if (status) query = query.andWhere('status', status);
    if (categoryFilter) query = query.andWhere('category', categoryFilter);

    const countRow = await query.clone().count({ c: '*' }).first();
    const rows = await query
      .clone()
      .leftJoin('users', 'import_batches.created_by', 'users.id')
      .orderBy('import_batches.created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select('import_batches.*', 'users.name as created_by_name', 'users.email as created_by_email');

    const recon = await db('reconciliations')
      .where({ company_id: req.companyId })
      .orderBy('created_at', 'desc')
      .first();

    res.json({
      batches: rows.map((b: Record<string, any>) => ({
        ...serialiseBatch(b, getCategory(b.category).label),
        createdByName: b.created_by_name ?? null,
        createdByEmail: b.created_by_email ?? null,
      })),
      pagination: { page, pageSize, total: Number(countRow?.c ?? 0) },
      reconciliationStatus: recon
        ? { status: recon.status, asOfDate: recon.as_of_date, createdAt: recon.created_at }
        : { status: 'no_reference', message: 'Reference data not provided' },
    });
  }),
);

importsRouter.get(
  '/batches/:batchId',
  requireCapability('imports.view'),
  asyncHandler(async (req, res) => {
    const batch = await loadBatch(req.params.batchId, req);
    const rejectionCount = await db('import_rejections').where({ batch_id: batch.id }).count({ c: '*' }).first();
    const rejections = await db('import_rejections').where({ batch_id: batch.id }).orderBy('row_number').limit(100);

    res.json({
      batch: serialiseBatch(batch, getCategory(batch.category).label),
      report: readJson(batch.totals, null),
      mapping: readJson(batch.mapping, null),
      rejectionCount: Number(rejectionCount?.c ?? 0),
      rejections: rejections.map((r: Record<string, any>) => ({
        rowNumber: r.row_number,
        raw: readJson(r.raw, {}),
        errors: readJson(r.errors, []),
      })),
    });
  }),
);

importsRouter.get(
  '/batches/:batchId/rejections.xlsx',
  requireCapability('imports.view'),
  asyncHandler(async (req, res) => {
    const batch = await loadBatch(req.params.batchId, req);
    const company = await db('companies').where({ id: batch.company_id }).first();
    const rows = await db('import_rejections').where({ batch_id: batch.id }).orderBy('row_number');

    if (!rows.length) throw notFound('This import has no rejected rows.');

    const buffer = await buildRejectionReport(
      getCategory(batch.category).label,
      company.name,
      batch.file_name,
      rows.map((r: Record<string, any>) => ({
        rowNumber: r.row_number,
        raw: readJson(r.raw, {}),
        errors: readJson(r.errors, []),
      })),
    );

    await recordAudit({
      action: 'report.exported',
      summary: `Downloaded the rejected-row report for "${batch.file_name}"`,
      companyId: batch.company_id,
      entityType: 'import_batch',
      entityId: batch.id,
      req,
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="DHYEYA-rejected-rows-${batch.id.slice(0, 8)}.xlsx"`);
    res.send(buffer);
  }),
);

// ------------------------------------------------------------------ helpers

async function loadBatch(batchId: string, req: Parameters<typeof resolveCompany>[0]) {
  const batch = await db('import_batches').where({ id: batchId }).first();
  if (!batch) throw notFound('That import could not be found.');

  if (req.user!.role !== 'admin') {
    const assignment = await db('user_companies').where({ user_id: req.user!.id, company_id: batch.company_id }).first();
    if (!assignment) throw notFound('That import could not be found.');
  }

  req.companyId = batch.company_id;
  return batch;
}

async function loadComparisonSets(companyId: string, categoryKey: string) {
  const ledgerRows = await db('ledgers').where({ company_id: companyId }).select('normalized_name');
  const knownLedgers = new Set(ledgerRows.map((r: { normalized_name: string }) => r.normalized_name));

  const existingKeys = new Set<string>();
  const keyTable: Record<string, string> = {
    vouchers: 'vouchers',
    receivables: 'receivables',
    payables: 'payables',
    expenses: 'expenses',
  };
  const table = keyTable[categoryKey];
  if (table) {
    const rows = await db(table).where({ company_id: companyId }).select('dedupe_key');
    for (const r of rows) existingKeys.add(r.dedupe_key);
  } else if (categoryKey === 'chart_of_accounts') {
    const { dedupeKey } = await import('../../lib/ids.js');
    for (const r of ledgerRows) existingKeys.add(dedupeKey(['ledger', r.normalized_name]));
  }

  return { knownLedgers, existingKeys };
}

async function saveMappingProfile(
  batch: Record<string, any>,
  headers: string[],
  mapping: ColumnMapping,
  options: ImportOptions,
  userId: string,
) {
  const signature = headerSignature(headers);
  const existing = await db('mapping_profiles')
    .where({ company_id: batch.company_id, category: batch.category, header_signature: signature })
    .first();

  const now = nowIso();
  if (existing) {
    await db('mapping_profiles')
      .where({ id: existing.id })
      .update({ mapping: writeJson(mapping), options: writeJson(options), use_count: Number(existing.use_count) + 1, updated_at: now });
  } else {
    await db('mapping_profiles').insert({
      id: newId(),
      company_id: batch.company_id,
      category: batch.category,
      name: `${batch.file_name} layout`,
      header_signature: signature,
      mapping: writeJson(mapping),
      options: writeJson(options),
      use_count: 1,
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
  }
}

function matchesTemplate(categoryKey: string, headers: string[]): { matches: boolean; detail: string } {
  const category = getCategory(categoryKey);
  const expected = category.fields.map((f) => f.label.toLowerCase());
  const actual = headers.map((h) => h.toLowerCase());
  const overlap = expected.filter((e) => actual.includes(e)).length;
  const requiredLabels = category.fields.filter((f) => f.required).map((f) => f.label.toLowerCase());
  const requiredPresent = requiredLabels.every((r) => actual.includes(r));

  if (requiredPresent && overlap >= Math.min(expected.length, 3)) {
    return { matches: true, detail: 'This file matches the DHYEYA template for this import type. The suggested mapping should need no changes.' };
  }
  return {
    matches: false,
    detail: `This file does not use the DHYEYA template layout, which is fine — ${overlap} of ${expected.length} column headings were recognised and you can map the rest yourself below.`,
  };
}

function buildPreview(dataset: ReturnType<typeof validateDataset>, categoryKey: string) {
  if (categoryKey === 'vouchers' && dataset.vouchers) {
    return {
      kind: 'vouchers' as const,
      items: dataset.vouchers.slice(0, 20).map((v) => ({
        voucherDate: v.voucherDate,
        voucherType: v.voucherType,
        voucherNumber: v.voucherNumber,
        narration: v.narration,
        totalDebit: v.totalDebit,
        totalCredit: v.totalCredit,
        imbalance: v.imbalance,
        lines: v.lines.map((l) => ({ ledgerName: l.ledgerName, debit: l.debit, credit: l.credit, costCentre: l.costCentre })),
      })),
      totalItems: dataset.vouchers.length,
    };
  }
  return {
    kind: 'rows' as const,
    items: dataset.validRows.slice(0, 20).map((r) => ({
      rowNumber: r.rowNumber,
      values: Object.fromEntries(Object.entries(r.values).filter(([k]) => !k.startsWith('__'))),
      warnings: r.warnings,
    })),
    totalItems: dataset.validRows.length,
  };
}

function buildNextSteps(categoryKey: string, result: { ledgersCreated: number; mappingsSuggested: number }, rejected: number): string[] {
  const steps: string[] = [];
  if (result.ledgersCreated > 0) {
    steps.push(
      `${result.ledgersCreated} new ledger${result.ledgersCreated === 1 ? '' : 's'} were created. Review their suggested categories in Account Mapping — balances stay out of your statements until a category is confirmed.`,
    );
  }
  if (rejected > 0) {
    steps.push(`${rejected} row${rejected === 1 ? '' : 's'} were rejected. Download the rejected-row report to see why, correct the file and import again.`);
  }
  if (categoryKey === 'chart_of_accounts') steps.push('Import opening balances and vouchers next to produce a Balance Sheet and Profit & Loss.');
  if (categoryKey === 'vouchers') steps.push('Open the Executive Overview to see the figures this data produces.');
  if (categoryKey === 'receivables' || categoryKey === 'payables') steps.push('Ageing buckets and the cash flow forecast now include these documents.');
  if (!steps.length) steps.push('Open the Executive Overview to see the updated position.');
  return steps;
}

function serialiseBatch(b: Record<string, any>, categoryLabel: string) {
  return {
    id: b.id,
    companyId: b.company_id,
    financialYearId: b.financial_year_id,
    category: b.category,
    categoryLabel,
    fileName: b.file_name,
    fileSize: Number(b.file_size),
    sheetName: b.sheet_name,
    status: b.status,
    duplicateStrategy: b.duplicate_strategy,
    partialImport: dialect.bool(b.partial_import),
    totals: readJson(b.totals, null),
    warnings: readJson(b.warnings, []),
    errorMessage: b.error_message ?? null,
    createdAt: b.created_at,
    completedAt: b.completed_at,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export { normalizeName };
