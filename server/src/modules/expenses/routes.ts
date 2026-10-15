import { Router } from 'express';
import { z } from 'zod';
import { db, dialect } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, requireCapability, resolveCompany } from '../../middleware/auth.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { newId, nowIso, today, dedupeKey, normalizeName } from '../../lib/ids.js';
import { add, sub, percentOf, type Minor } from '../../lib/money.js';
import { monthKey, addMonths } from '../../lib/dates.js';
import { recordAudit } from '../audit/service.js';
import { resolvePeriod, monthlyBuckets } from '../finance/periods.js';

export const expensesRouter = Router();
expensesRouter.use(authenticate);

// ------------------------------------------------------------------ expenses

expensesRouter.get(
  '/',
  requireCapability('expenses.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod({
      companyId: req.companyId!,
      financialYearId: (req.query.financialYearId as string) || null,
      periodType: (req.query.periodType as string) || 'financial_year',
      from: req.query.from as string,
      to: req.query.to as string,
    });

    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize ?? 50)));

    let base = db('expenses')
      .where({ company_id: req.companyId })
      .andWhere('expense_date', '>=', resolved.period.from)
      .andWhere('expense_date', '<=', resolved.period.to);

    if (req.query.category) base = base.andWhere('category', req.query.category as string);
    if (req.query.vendor) base = base.andWhere('vendor', req.query.vendor as string);
    if (req.query.costCentre) base = base.andWhere('cost_centre', req.query.costCentre as string);
    if (req.query.expenseType) base = base.andWhere('expense_type', req.query.expenseType as string);
    if (req.query.search) {
      const p = `%${String(req.query.search).toLowerCase()}%`;
      base = base.andWhere((qb) => {
        qb.whereRaw("LOWER(COALESCE(category,'')) LIKE ?", [p])
          .orWhereRaw("LOWER(COALESCE(vendor,'')) LIKE ?", [p])
          .orWhereRaw("LOWER(COALESCE(reference,'')) LIKE ?", [p]);
      });
    }

    const countRow = await base.clone().count({ c: '*' }).first();
    const totalRow = await base.clone().sum({ total: 'amount_minor' }).first();

    const rows = await base
      .clone()
      .orderBy('expense_date', (req.query.sortDir as string) === 'asc' ? 'asc' : 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const byCategory = await base
      .clone()
      .groupBy('category')
      .select('category')
      .sum({ total: 'amount_minor' })
      .count({ c: '*' });

    const buckets = monthlyBuckets(resolved.period);
    const trend: { label: string; total: Minor }[] = [];
    for (const b of buckets) {
      const r = await db('expenses')
        .where({ company_id: req.companyId })
        .andWhere('expense_date', '>=', b.from)
        .andWhere('expense_date', '<=', b.to)
        .sum({ total: 'amount_minor' })
        .first();
      trend.push({ label: b.label, total: Math.round(Number(r?.total ?? 0)) });
    }

    res.json({
      expenses: rows.map(serialiseExpense),
      pagination: { page, pageSize, total: Number(countRow?.c ?? 0) },
      total: Math.round(Number(totalRow?.total ?? 0)),
      byCategory: (byCategory as Array<Record<string, unknown>>)
        .map((r) => ({ category: (r.category as string) ?? 'Uncategorised', total: Math.round(Number(r.total ?? 0)), count: Number(r.c ?? 0) }))
        .sort((a, b) => b.total - a.total),
      trend,
      period: resolved.period,
    });
  }),
);

const expenseSchema = z.object({
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.string().trim().min(1).max(120),
  vendor: z.string().trim().max(200).optional().nullable(),
  amount: z.number().int(),
  expenseType: z.enum(['fixed', 'recurring_variable', 'one_off']).default('one_off'),
  costCentre: z.string().trim().max(160).optional().nullable(),
  reference: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  ledgerId: z.string().optional().nullable(),
});

expensesRouter.post(
  '/',
  requireCapability('expenses.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const input = expenseSchema.parse(req.body);
    const now = nowIso();
    const id = newId();

    await db('expenses').insert({
      id,
      company_id: req.companyId,
      financial_year_id: (req.body.financialYearId as string) || null,
      expense_date: input.expenseDate,
      category: input.category,
      vendor: input.vendor ?? null,
      ledger_id: input.ledgerId ?? null,
      amount_minor: input.amount,
      expense_type: input.expenseType,
      cost_centre: input.costCentre ?? null,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      dedupe_key: dedupeKey(['exp', input.expenseDate, normalizeName(input.category), normalizeName(input.vendor ?? ''), input.amount, normalizeName(input.reference ?? ''), id]),
      created_by: req.user!.id,
      created_at: now,
      updated_at: now,
    });

    await recordAudit({
      action: 'expense.changed',
      summary: `Recorded an expense of ${(input.amount / 100).toFixed(2)} under ${input.category}`,
      companyId: req.companyId,
      entityType: 'expense',
      entityId: id,
      req,
    });

    res.status(201).json({ expense: serialiseExpense(await db('expenses').where({ id }).first()) });
  }),
);

expensesRouter.patch(
  '/:expenseId',
  requireCapability('expenses.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const existing = await db('expenses').where({ id: req.params.expenseId, company_id: req.companyId }).first();
    if (!existing) throw notFound('That expense could not be found.');

    const input = expenseSchema.partial().parse(req.body);
    const patch: Record<string, unknown> = { updated_at: nowIso() };
    if (input.expenseDate) patch.expense_date = input.expenseDate;
    if (input.category) patch.category = input.category;
    if (input.vendor !== undefined) patch.vendor = input.vendor ?? null;
    if (input.amount !== undefined) patch.amount_minor = input.amount;
    if (input.expenseType) patch.expense_type = input.expenseType;
    if (input.costCentre !== undefined) patch.cost_centre = input.costCentre ?? null;
    if (input.reference !== undefined) patch.reference = input.reference ?? null;
    if (input.notes !== undefined) patch.notes = input.notes ?? null;

    await db('expenses').where({ id: existing.id }).update(patch);

    await recordAudit({
      action: 'expense.changed',
      summary: `Updated an expense under ${input.category ?? existing.category}`,
      companyId: req.companyId,
      entityType: 'expense',
      entityId: existing.id,
      req,
    });

    res.json({ expense: serialiseExpense(await db('expenses').where({ id: existing.id }).first()) });
  }),
);

expensesRouter.delete(
  '/:expenseId',
  requireCapability('expenses.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const existing = await db('expenses').where({ id: req.params.expenseId, company_id: req.companyId }).first();
    if (!existing) throw notFound('That expense could not be found.');
    if (existing.source_batch_id) {
      throw badRequest(
        'This expense came from an Excel import and cannot be deleted individually. Correct the source file and re-import with the "update matched records" option.',
      );
    }

    await db('expenses').where({ id: existing.id }).del();
    await recordAudit({
      action: 'expense.changed',
      summary: `Deleted a manually entered expense under ${existing.category}`,
      companyId: req.companyId,
      entityType: 'expense',
      entityId: existing.id,
      req,
    });
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------- recurring expenses

const recurringSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(120).optional().nullable(),
  amount: z.number().int().min(0),
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly']),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  vendor: z.string().trim().max(200).optional().nullable(),
  ledgerId: z.string().optional().nullable(),
  costCentre: z.string().trim().max(160).optional().nullable(),
  isActive: z.boolean().default(true),
  isVariable: z.boolean().default(false),
});

expensesRouter.get(
  '/recurring',
  requireCapability('expenses.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const rows = await db('recurring_expenses').where({ company_id: req.companyId }).orderBy('next_due_date');
    res.json({ recurring: rows.map(serialiseRecurring) });
  }),
);

expensesRouter.post(
  '/recurring',
  requireCapability('expenses.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const input = recurringSchema.parse(req.body);
    const id = newId();
    const now = nowIso();

    await db('recurring_expenses').insert({
      id,
      company_id: req.companyId,
      name: input.name,
      category: input.category ?? null,
      amount_minor: input.amount,
      frequency: input.frequency,
      start_date: input.startDate,
      next_due_date: input.nextDueDate ?? input.startDate,
      end_date: input.endDate ?? null,
      ledger_id: input.ledgerId ?? null,
      vendor: input.vendor ?? null,
      cost_centre: input.costCentre ?? null,
      is_active: input.isActive,
      is_variable: input.isVariable,
      created_by: req.user!.id,
      created_at: now,
      updated_at: now,
    });

    await recordAudit({
      action: 'recurring_expense.changed',
      summary: `Added the recurring expense "${input.name}" (${input.frequency})`,
      companyId: req.companyId,
      entityType: 'recurring_expense',
      entityId: id,
      req,
    });

    res.status(201).json({ recurring: serialiseRecurring(await db('recurring_expenses').where({ id }).first()) });
  }),
);

expensesRouter.patch(
  '/recurring/:id',
  requireCapability('expenses.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const existing = await db('recurring_expenses').where({ id: req.params.id, company_id: req.companyId }).first();
    if (!existing) throw notFound('That recurring expense could not be found.');

    const input = recurringSchema.partial().parse(req.body);
    const patch: Record<string, unknown> = { updated_at: nowIso() };
    if (input.name) patch.name = input.name;
    if (input.category !== undefined) patch.category = input.category ?? null;
    if (input.amount !== undefined) patch.amount_minor = input.amount;
    if (input.frequency) patch.frequency = input.frequency;
    if (input.startDate) patch.start_date = input.startDate;
    if (input.nextDueDate) patch.next_due_date = input.nextDueDate;
    if (input.endDate !== undefined) patch.end_date = input.endDate ?? null;
    if (input.vendor !== undefined) patch.vendor = input.vendor ?? null;
    if (input.costCentre !== undefined) patch.cost_centre = input.costCentre ?? null;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (input.isVariable !== undefined) patch.is_variable = input.isVariable;

    await db('recurring_expenses').where({ id: existing.id }).update(patch);

    await recordAudit({
      action: 'recurring_expense.changed',
      summary: `Updated the recurring expense "${existing.name}"`,
      companyId: req.companyId,
      entityType: 'recurring_expense',
      entityId: existing.id,
      req,
    });

    res.json({ recurring: serialiseRecurring(await db('recurring_expenses').where({ id: existing.id }).first()) });
  }),
);

expensesRouter.delete(
  '/recurring/:id',
  requireCapability('expenses.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const existing = await db('recurring_expenses').where({ id: req.params.id, company_id: req.companyId }).first();
    if (!existing) throw notFound('That recurring expense could not be found.');
    await db('recurring_expenses').where({ id: existing.id }).del();
    await recordAudit({
      action: 'recurring_expense.changed',
      summary: `Deleted the recurring expense "${existing.name}"`,
      companyId: req.companyId,
      req,
    });
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ budgets

const budgetSchema = z.object({
  category: z.string().trim().min(1).max(120),
  periodType: z.enum(['month', 'quarter', 'year', 'custom']).default('custom'),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  costCentre: z.string().trim().max(160).optional().nullable(),
  amount: z.number().int().min(0),
  notes: z.string().trim().max(500).optional().nullable(),
});

expensesRouter.get(
  '/budgets',
  requireCapability('budgets.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod({
      companyId: req.companyId!,
      financialYearId: (req.query.financialYearId as string) || null,
      periodType: (req.query.periodType as string) || 'financial_year',
      from: req.query.from as string,
      to: req.query.to as string,
    });

    const budgets = await db('budgets')
      .where({ company_id: req.companyId })
      .andWhere('period_start', '<=', resolved.period.to)
      .andWhere('period_end', '>=', resolved.period.from)
      .orderBy('category');

    const rows = [];
    let totalBudgeted: Minor = 0;
    let totalActual: Minor = 0;

    for (const b of budgets) {
      let q = db('expenses')
        .where({ company_id: req.companyId })
        .andWhereRaw("LOWER(COALESCE(category,'')) = LOWER(?)", [b.category])
        .andWhere('expense_date', '>=', b.period_start)
        .andWhere('expense_date', '<=', b.period_end);

      if (b.cost_centre) q = q.andWhere('cost_centre', b.cost_centre);

      const spentRow = await q.sum({ total: 'amount_minor' }).first();
      const actual = Math.round(Number(spentRow?.total ?? 0));
      const budgeted = Number(b.amount_minor);

      totalBudgeted = add(totalBudgeted, budgeted);
      totalActual = add(totalActual, actual);

      rows.push({
        id: b.id,
        category: b.category,
        periodType: b.period_type,
        periodStart: b.period_start,
        periodEnd: b.period_end,
        costCentre: b.cost_centre,
        budgeted,
        actual,
        remaining: sub(budgeted, actual),
        variance: sub(budgeted, actual),
        variancePercent: percentOf(sub(budgeted, actual), budgeted),
        utilisationPercent: budgeted === 0 ? null : (actual / budgeted) * 100,
        notes: b.notes,
        fromImport: Boolean(b.source_batch_id),
      });
    }

    res.json({
      budgets: rows,
      summary: {
        totalBudgeted,
        totalActual,
        remaining: sub(totalBudgeted, totalActual),
        utilisationPercent: totalBudgeted === 0 ? null : (totalActual / totalBudgeted) * 100,
        available: rows.length > 0,
      },
      period: resolved.period,
      note: rows.length ? undefined : 'No budgets cover this period. Add one below, or import the Budgets category from the Excel Import Center.',
    });
  }),
);

expensesRouter.post(
  '/budgets',
  requireCapability('budgets.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const input = budgetSchema.parse(req.body);
    if (input.periodEnd < input.periodStart) throw badRequest('The budget period ends before it starts.');

    const id = newId();
    const now = nowIso();

    await db('budgets').insert({
      id,
      company_id: req.companyId,
      financial_year_id: (req.body.financialYearId as string) || null,
      category: input.category,
      period_type: input.periodType,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      cost_centre: input.costCentre ?? null,
      amount_minor: input.amount,
      notes: input.notes ?? null,
      created_by: req.user!.id,
      created_at: now,
      updated_at: now,
    });

    await recordAudit({
      action: 'budget.changed',
      summary: `Set a budget of ${(input.amount / 100).toFixed(2)} for ${input.category} (${input.periodStart} to ${input.periodEnd})`,
      companyId: req.companyId,
      entityType: 'budget',
      entityId: id,
      req,
    });

    res.status(201).json({ budget: { id, ...input } });
  }),
);

expensesRouter.patch(
  '/budgets/:id',
  requireCapability('budgets.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const existing = await db('budgets').where({ id: req.params.id, company_id: req.companyId }).first();
    if (!existing) throw notFound('That budget could not be found.');

    const input = budgetSchema.partial().parse(req.body);
    const patch: Record<string, unknown> = { updated_at: nowIso() };
    if (input.category) patch.category = input.category;
    if (input.amount !== undefined) patch.amount_minor = input.amount;
    if (input.periodStart) patch.period_start = input.periodStart;
    if (input.periodEnd) patch.period_end = input.periodEnd;
    if (input.periodType) patch.period_type = input.periodType;
    if (input.costCentre !== undefined) patch.cost_centre = input.costCentre ?? null;
    if (input.notes !== undefined) patch.notes = input.notes ?? null;

    await db('budgets').where({ id: existing.id }).update(patch);
    await recordAudit({
      action: 'budget.changed',
      summary: `Updated the budget for ${input.category ?? existing.category}`,
      companyId: req.companyId,
      entityType: 'budget',
      entityId: existing.id,
      req,
    });

    res.json({ ok: true });
  }),
);

expensesRouter.delete(
  '/budgets/:id',
  requireCapability('budgets.manage'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const existing = await db('budgets').where({ id: req.params.id, company_id: req.companyId }).first();
    if (!existing) throw notFound('That budget could not be found.');
    await db('budgets').where({ id: existing.id }).del();
    await recordAudit({ action: 'budget.changed', summary: `Deleted the budget for ${existing.category}`, companyId: req.companyId, req });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- anomalies

expensesRouter.get(
  '/anomalies',
  requireCapability('expenses.view'),
  resolveCompany,
  asyncHandler(async (req, res) => {
    const resolved = await resolvePeriod({
      companyId: req.companyId!,
      financialYearId: (req.query.financialYearId as string) || null,
      periodType: 'financial_year',
    });

    const expenses = await db('expenses')
      .where({ company_id: req.companyId })
      .andWhere('expense_date', '>=', resolved.period.from)
      .andWhere('expense_date', '<=', resolved.period.to);

    const findings: {
      kind: string;
      certainty: 'confirmed' | 'heuristic';
      title: string;
      detail: string;
      amount: Minor | null;
      references: string[];
    }[] = [];

    // --- exact duplicates: same date, vendor and amount. Certain, by definition.
    const dupKey = new Map<string, Record<string, any>[]>();
    for (const e of expenses) {
      const k = `${e.expense_date}|${normalizeName(e.vendor ?? '')}|${e.amount_minor}`;
      dupKey.set(k, [...(dupKey.get(k) ?? []), e]);
    }
    for (const [, group] of dupKey) {
      if (group.length > 1 && group[0].vendor) {
        findings.push({
          kind: 'duplicate_payment',
          certainty: 'confirmed',
          title: `${group.length} identical entries for ${group[0].vendor}`,
          detail: `${group.length} expenses of the same amount were recorded for ${group[0].vendor} on ${group[0].expense_date}. These may be a genuine repeat, or the same payment entered twice.`,
          amount: Number(group[0].amount_minor) * (group.length - 1),
          references: group.map((g) => g.id),
        });
      }
    }

    // --- category spikes against that category's own monthly average.
    const byCategoryMonth = new Map<string, Map<string, Minor>>();
    for (const e of expenses) {
      const cat = e.category ?? 'Uncategorised';
      const m = monthKey(e.expense_date);
      const months = byCategoryMonth.get(cat) ?? new Map<string, Minor>();
      months.set(m, add(months.get(m) ?? 0, Number(e.amount_minor)));
      byCategoryMonth.set(cat, months);
    }

    for (const [category, months] of byCategoryMonth) {
      if (months.size < 3) continue; // too little history to call anything a spike
      const values = [...months.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const totals = values.map((v) => v[1]);
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
      if (mean <= 0) continue;

      for (const [month, total] of values) {
        const excess = ((total - mean) / mean) * 100;
        if (excess >= 50) {
          findings.push({
            kind: 'expense_spike',
            certainty: 'heuristic',
            title: `${category} was ${excess.toFixed(0)}% above its average in ${month}`,
            detail: `Spend of ${(total / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} against a monthly average of ${(mean / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} across ${months.size} months. This compares a category with itself and takes no account of seasonality, so treat it as a prompt to look rather than a finding.`,
            amount: Math.round(total - mean),
            references: [],
          });
        }
      }
    }

    // --- recurring expenses whose due date has passed with no matching payment.
    const recurring = await db('recurring_expenses').where({ company_id: req.companyId, is_active: true });
    const now = today();

    for (const r of recurring) {
      if (r.next_due_date >= now) continue;
      const windowStart = r.next_due_date;
      const windowEnd = addMonths(r.next_due_date, 1);

      const match = expenses.find(
        (e: Record<string, any>) =>
          e.expense_date >= windowStart &&
          e.expense_date <= windowEnd &&
          (normalizeName(e.vendor ?? '') === normalizeName(r.vendor ?? '') || normalizeName(e.category ?? '') === normalizeName(r.category ?? '')),
      );

      if (!match) {
        findings.push({
          kind: 'missed_recurring',
          certainty: 'heuristic',
          title: `No payment recorded for "${r.name}"`,
          detail: `This recurring expense was due on ${r.next_due_date} and no matching expense was found within a month of that date. It may simply not have been imported yet.`,
          amount: Number(r.amount_minor),
          references: [r.id],
        });
      }
    }

    // --- large spend with a vendor seen only once.
    const byVendor = new Map<string, { total: Minor; count: number; name: string }>();
    for (const e of expenses) {
      if (!e.vendor) continue;
      const k = normalizeName(e.vendor);
      const v = byVendor.get(k) ?? { total: 0, count: 0, name: e.vendor };
      v.total = add(v.total, Number(e.amount_minor));
      v.count++;
      byVendor.set(k, v);
    }
    const vendorTotals = [...byVendor.values()].map((v) => v.total);
    const vendorMean = vendorTotals.length ? vendorTotals.reduce((a, b) => a + b, 0) / vendorTotals.length : 0;

    for (const v of byVendor.values()) {
      if (v.count === 1 && vendorMean > 0 && v.total > vendorMean * 3) {
        findings.push({
          kind: 'new_vendor_large_spend',
          certainty: 'heuristic',
          title: `A single large payment to ${v.name}`,
          detail: `One expense of ${(v.total / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}, more than three times the average spend per vendor in this period, with no other transactions for this vendor.`,
          amount: v.total,
          references: [],
        });
      }
    }

    res.json({
      findings: findings.slice(0, 100),
      period: resolved.period,
      note:
        'Items marked "confirmed" are facts about the data, such as two identical entries on the same day. Items marked "heuristic" are statistical prompts to investigate, computed against this company’s own history — they are not evidence of an error.',
      hasEnoughHistory: expenses.length >= 20,
      historyNote: expenses.length < 20 ? 'Fewer than 20 expense records exist, so spike detection has little to compare against and may be unreliable.' : undefined,
    });
  }),
);

function serialiseExpense(r: Record<string, any>) {
  return {
    id: r.id,
    expenseDate: r.expense_date,
    category: r.category,
    vendor: r.vendor,
    ledgerId: r.ledger_id,
    amount: Number(r.amount_minor),
    expenseType: r.expense_type,
    costCentre: r.cost_centre,
    reference: r.reference,
    notes: r.notes,
    fromImport: Boolean(r.source_batch_id),
    createdAt: r.created_at,
  };
}

function serialiseRecurring(r: Record<string, any>) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    amount: Number(r.amount_minor),
    frequency: r.frequency,
    startDate: r.start_date,
    nextDueDate: r.next_due_date,
    endDate: r.end_date,
    ledgerId: r.ledger_id,
    vendor: r.vendor,
    costCentre: r.cost_centre,
    isActive: dialect.bool(r.is_active),
    isVariable: dialect.bool(r.is_variable),
    fromImport: Boolean(r.source_batch_id),
  };
}
