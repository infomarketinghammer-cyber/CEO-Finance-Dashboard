import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { db, withTransaction } from '../../db/index.js';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { newId, nowIso, normalizeName, today } from '../../lib/ids.js';
import { readJson, writeJson } from '../../lib/json.js';
import { add, sub, parseAmount, type Minor } from '../../lib/money.js';
import { recordAudit } from '../audit/service.js';
import { readWorkbook, readSheet } from '../imports/workbook.js';
import { suggestMapping } from '../imports/mapper.js';
import { loadBalances } from '../finance/engine.js';
import { resolvePeriod } from '../finance/periods.js';

export const reconciliationRouter = Router();
reconciliationRouter.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes, files: 1 },
});

/**
 * Reconciliation compares the balances ArthSetu computed against an independent
 * reference — typically a trial balance exported straight from the accounting
 * system. Without such a reference there is nothing to reconcile against, and the
 * module says "Reference data not provided" rather than reporting a successful
 * reconciliation it has not performed.
 */

reconciliationRouter.get(
  '/status',
  requireCapability('reconciliation.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const latest = await db('reconciliations').where({ company_id: req.companyId }).orderBy('created_at', 'desc').first();

    if (!latest) {
      return res.json({
        status: 'no_reference',
        message: 'Reference data not provided',
        detail:
          'No reference report has been uploaded for this company, so no reconciliation has been performed. Upload a trial balance or ledger-balance export to compare it against the imported figures.',
        latest: null,
      });
    }

    res.json({
      status: latest.status,
      message:
        latest.status === 'matched'
          ? 'Imported balances matched the reference report'
          : latest.status === 'mismatched'
            ? 'Differences were found against the reference report'
            : 'Reference data not provided',
      latest: {
        id: latest.id,
        asOfDate: latest.as_of_date,
        referenceFileName: latest.reference_file_name,
        createdAt: latest.created_at,
        summary: readJson(latest.summary, null),
      },
    });
  }),
);

reconciliationRouter.get(
  '/',
  requireCapability('reconciliation.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const rows = await db('reconciliations').where({ company_id: req.companyId }).orderBy('created_at', 'desc').limit(50);
    res.json({
      reconciliations: rows.map((r: Record<string, any>) => ({
        id: r.id,
        asOfDate: r.as_of_date,
        referenceFileName: r.reference_file_name,
        status: r.status,
        summary: readJson(r.summary, null),
        createdAt: r.created_at,
      })),
    });
  }),
);

reconciliationRouter.get(
  '/:id',
  requireCapability('reconciliation.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const recon = await db('reconciliations').where({ id: req.params.id, company_id: req.companyId }).first();
    if (!recon) throw notFound('That reconciliation could not be found.');

    const lines = await db('reconciliation_lines').where({ reconciliation_id: recon.id }).orderByRaw('ABS(COALESCE(difference_minor,0)) DESC');

    res.json({
      reconciliation: {
        id: recon.id,
        asOfDate: recon.as_of_date,
        referenceFileName: recon.reference_file_name,
        status: recon.status,
        summary: readJson(recon.summary, null),
        createdAt: recon.created_at,
      },
      lines: lines.map((l: Record<string, any>) => ({
        ledgerName: l.ledger_name,
        ledgerId: l.ledger_id,
        imported: l.imported_minor === null ? null : Number(l.imported_minor),
        reference: l.reference_minor === null ? null : Number(l.reference_minor),
        difference: l.difference_minor === null ? null : Number(l.difference_minor),
        status: l.status,
      })),
    });
  }),
);

reconciliationRouter.post(
  '/run',
  requireCapability('reconciliation.manage'),
  upload.single('file'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Upload a reference report to reconcile against.');

    const asOfDate = (req.body.asOfDate as string) || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw badRequest('Provide the reference date as YYYY-MM-DD.');

    const wb = readWorkbook(req.file.buffer, req.file.originalname);
    const sheetName = (req.body.sheetName as string) || wb.SheetNames[0];
    const sheet = readSheet(wb, sheetName);

    // The reference needs only a ledger name and a balance. Mapping is inferred
    // unless the caller supplies explicit column names.
    const explicitLedgerCol = req.body.ledgerColumn as string | undefined;
    const explicitBalanceCol = req.body.balanceColumn as string | undefined;
    const explicitDebitCol = req.body.debitColumn as string | undefined;
    const explicitCreditCol = req.body.creditColumn as string | undefined;

    const guess = suggestMapping('opening_balances', sheet.headers, sheet.columns);
    const guessed = Object.fromEntries(guess.suggestions.map((s) => [s.fieldKey, s.header]));

    const ledgerCol = explicitLedgerCol ?? guessed.ledgerName;
    const balanceCol = explicitBalanceCol ?? guessed.amount;
    const debitCol = explicitDebitCol ?? guessed.debit;
    const creditCol = explicitCreditCol ?? guessed.credit;

    if (!ledgerCol) {
      throw badRequest(
        `No ledger-name column could be identified in "${req.file.originalname}". Available columns: ${sheet.headers.join(', ')}. Send ledgerColumn to choose one explicitly.`,
      );
    }
    if (!balanceCol && !debitCol && !creditCol) {
      throw badRequest(
        `No balance column could be identified in "${req.file.originalname}". Available columns: ${sheet.headers.join(', ')}. Send balanceColumn, or debitColumn and creditColumn.`,
      );
    }

    // ---- reference balances, debit-positive ----
    const reference = new Map<string, { name: string; amount: Minor }>();
    const unreadable: string[] = [];

    for (const row of sheet.rows) {
      const rawName = row[ledgerCol];
      if (rawName === null || rawName === undefined || String(rawName).trim() === '') continue;
      const name = String(rawName).trim();
      const key = normalizeName(name);

      // Skip the total line most trial balances end with.
      if (/^(grand\s+)?total$/i.test(name)) continue;

      let amount: Minor = 0;
      try {
        if (debitCol || creditCol) {
          const d = debitCol ? (parseAmount(row[debitCol]) ?? 0) : 0;
          const c = creditCol ? (parseAmount(row[creditCol]) ?? 0) : 0;
          amount = sub(d, c);
        } else {
          amount = parseAmount(row[balanceCol!]) ?? 0;
        }
      } catch {
        unreadable.push(name);
        continue;
      }

      const existing = reference.get(key);
      reference.set(key, { name, amount: existing ? add(existing.amount, amount) : amount });
    }

    // ---- imported balances at the same date ----
    const resolved = await resolvePeriod({
      companyId: req.companyId!,
      financialYearId: (req.body.financialYearId as string) || null,
      periodType: 'financial_year',
    });

    const set = await loadBalances(req.companyId!, { from: resolved.financialYearStart ?? `${asOfDate.slice(0, 4)}-04-01`, to: asOfDate }, {
      financialYearId: resolved.financialYearId,
    });

    const imported = new Map(set.balances.map((b) => [normalizeName(b.ledgerName), b]));

    // ---- compare ----
    const lines: {
      ledgerName: string;
      ledgerId: string | null;
      imported: Minor | null;
      reference: Minor | null;
      difference: Minor | null;
      status: 'match' | 'mismatch' | 'missing_in_import' | 'missing_in_reference';
    }[] = [];

    const allKeys = new Set([...reference.keys(), ...imported.keys()]);

    for (const key of allKeys) {
      const ref = reference.get(key);
      const imp = imported.get(key);

      if (ref && imp) {
        const difference = sub(imp.closingNet, ref.amount);
        lines.push({
          ledgerName: imp.ledgerName,
          ledgerId: imp.ledgerId,
          imported: imp.closingNet,
          reference: ref.amount,
          difference,
          status: difference === 0 ? 'match' : 'mismatch',
        });
      } else if (ref) {
        lines.push({
          ledgerName: ref.name,
          ledgerId: null,
          imported: null,
          reference: ref.amount,
          difference: null,
          status: 'missing_in_import',
        });
      } else if (imp && (imp.closingNet !== 0 || imp.transactionCount > 0)) {
        lines.push({
          ledgerName: imp.ledgerName,
          ledgerId: imp.ledgerId,
          imported: imp.closingNet,
          reference: null,
          difference: null,
          status: 'missing_in_reference',
        });
      }
    }

    const matched = lines.filter((l) => l.status === 'match').length;
    const mismatched = lines.filter((l) => l.status === 'mismatch');
    const missingInImport = lines.filter((l) => l.status === 'missing_in_import');
    const missingInReference = lines.filter((l) => l.status === 'missing_in_reference');

    const netDifference = mismatched.reduce((acc, l) => add(acc, l.difference ?? 0), 0 as Minor);
    const status = mismatched.length === 0 && missingInImport.length === 0 ? 'matched' : 'mismatched';

    const summary = {
      totalCompared: lines.length,
      matched,
      mismatched: mismatched.length,
      missingInImport: missingInImport.length,
      missingInReference: missingInReference.length,
      netDifference,
      largestDifference: mismatched.length
        ? mismatched.reduce((max, l) => (Math.abs(l.difference ?? 0) > Math.abs(max.difference ?? 0) ? l : max)).ledgerName
        : null,
      unreadableRows: unreadable.length,
      matchRatePercent: lines.length ? Math.round((matched / lines.length) * 100) : 0,
    };

    const reconId = newId();
    const now = nowIso();

    await withTransaction(async (trx) => {
      await trx('reconciliations').insert({
        id: reconId,
        company_id: req.companyId,
        financial_year_id: resolved.financialYearId,
        as_of_date: asOfDate,
        reference_file_name: req.file!.originalname,
        status,
        summary: writeJson(summary),
        created_by: req.user!.id,
        created_at: now,
      });

      const chunkSize = 200;
      const payload = lines.map((l) => ({
        id: newId(),
        reconciliation_id: reconId,
        ledger_name: l.ledgerName,
        ledger_id: l.ledgerId,
        imported_minor: l.imported,
        reference_minor: l.reference,
        difference_minor: l.difference,
        status: l.status,
      }));
      for (let i = 0; i < payload.length; i += chunkSize) {
        await trx('reconciliation_lines').insert(payload.slice(i, i + chunkSize));
      }
    });

    await recordAudit({
      action: 'reconciliation.run',
      summary: `Reconciled against "${req.file.originalname}" as at ${asOfDate}: ${matched} matched, ${mismatched.length} differing`,
      companyId: req.companyId,
      entityType: 'reconciliation',
      entityId: reconId,
      meta: summary,
      req,
    });

    res.status(201).json({
      id: reconId,
      status,
      asOfDate,
      summary,
      lines: lines.sort((a, b) => Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0)).slice(0, 200),
      interpretation:
        status === 'matched'
          ? 'Every ledger in the reference report matches the imported balance at this date.'
          : `${mismatched.length} ledger(s) differ and ${missingInImport.length} appear in the reference but not in the imported data. A ledger missing from the import usually means a category of records has not been imported yet.`,
    });
  }),
);

const sheetSchema = z.object({ fileName: z.string().optional() });
export { sheetSchema };
