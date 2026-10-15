import type { Tx } from '../../db/index.js';
import { newId, nowIso, normalizeName, dedupeKey } from '../../lib/ids.js';
import type { ParsedDataset, ParsedRow, VoucherGroup } from './validator.js';
import { suggestCategoryForLedger } from '../mapping/suggest.js';

export type DuplicateStrategy = 'skip' | 'update' | 'review';

export interface CommitContext {
  trx: Tx;
  companyId: string;
  financialYearId: string | null;
  batchId: string;
  userId: string;
  duplicateStrategy: DuplicateStrategy;
}

export interface CommitResult {
  inserted: number;
  updated: number;
  skipped: number;
  ledgersCreated: number;
  mappingsSuggested: number;
  changes: { type: 'created' | 'updated'; label: string; detail?: string }[];
}

const emptyResult = (): CommitResult => ({
  inserted: 0,
  updated: 0,
  skipped: 0,
  ledgersCreated: 0,
  mappingsSuggested: 0,
  changes: [],
});

/**
 * Writes a validated dataset.
 *
 * Runs entirely inside the caller's transaction: a failure anywhere rolls the whole
 * batch back rather than leaving half a month of vouchers behind. Existing records
 * are matched on their dedupe key, never on row position, and what happens to a
 * match is the user's explicit choice — `skip` leaves history untouched, `update`
 * overwrites and reports what changed, `review` imports only the genuinely new
 * records and reports the rest.
 */
export async function commitDataset(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  switch (dataset.category) {
    case 'chart_of_accounts':
      return commitLedgers(dataset, ctx);
    case 'ledger_groups':
      return commitLedgerGroups(dataset, ctx);
    case 'opening_balances':
      return commitOpeningBalances(dataset, ctx);
    case 'vouchers':
      return commitVouchers(dataset, ctx);
    case 'receivables':
      return commitOutstanding(dataset, ctx, 'receivables');
    case 'payables':
      return commitOutstanding(dataset, ctx, 'payables');
    case 'cost_centres':
      return commitCostCentres(dataset, ctx);
    case 'stock_items':
      return commitStockItems(dataset, ctx);
    case 'expenses':
      return commitExpenses(dataset, ctx);
    case 'budgets':
      return commitBudgets(dataset, ctx);
    case 'recurring_expenses':
      return commitRecurringExpenses(dataset, ctx);
    case 'commitments':
      return commitCommitments(dataset, ctx);
    case 'customers':
      return commitCustomers(dataset, ctx);
    case 'company_details':
      return commitCompanyDetails(dataset, ctx);
    default:
      throw new Error(`No commit handler for import category "${dataset.category}"`);
  }
}

// --------------------------------------------------------------- ledger utils

/**
 * Finds a ledger by normalised name, creating it when a transaction references an
 * account that has no master record. New ledgers get an unconfirmed category
 * suggestion so they surface in Account Mapping for review.
 */
async function ensureLedger(
  ctx: CommitContext,
  name: string,
  groupName: string | null,
  result: CommitResult,
  cache: Map<string, string>,
): Promise<string> {
  const key = normalizeName(name);
  const cached = cache.get(key);
  if (cached) return cached;

  const existing = await ctx.trx('ledgers').where({ company_id: ctx.companyId, normalized_name: key }).first();
  if (existing) {
    // Fill in a group we did not previously know.
    if (groupName && !existing.group_name) {
      await ctx.trx('ledgers').where({ id: existing.id }).update({ group_name: groupName, updated_at: nowIso() });
    }
    cache.set(key, existing.id);
    return existing.id;
  }

  const id = newId();
  const now = nowIso();
  await ctx.trx('ledgers').insert({
    id,
    company_id: ctx.companyId,
    name: name.trim(),
    normalized_name: key,
    group_name: groupName,
    opening_balance_minor: null,
    opening_side: null,
    source_batch_id: ctx.batchId,
    created_at: now,
    updated_at: now,
  });
  cache.set(key, id);
  result.ledgersCreated++;

  await createSuggestedMapping(ctx, id, name, groupName, result);
  return id;
}

async function createSuggestedMapping(
  ctx: CommitContext,
  ledgerId: string,
  name: string,
  groupName: string | null,
  result: CommitResult,
): Promise<void> {
  const existing = await ctx.trx('account_mappings').where({ company_id: ctx.companyId, ledger_id: ledgerId }).first();
  if (existing) return;

  const categories = await ctx
    .trx('account_categories')
    .where(function () {
      this.whereNull('company_id').orWhere('company_id', ctx.companyId);
    })
    .andWhere('is_active', true)
    .select('key');

  const suggestion = suggestCategoryForLedger(name, groupName, categories);
  const now = nowIso();

  await ctx.trx('account_mappings').insert({
    id: newId(),
    company_id: ctx.companyId,
    ledger_id: ledgerId,
    category_key: suggestion.categoryKey,
    status: 'suggested',
    confidence: suggestion.confidence || null,
    reason: suggestion.reason,
    created_by: ctx.userId,
    created_at: now,
    updated_at: now,
  });

  if (suggestion.categoryKey) result.mappingsSuggested++;
}

// ------------------------------------------------------------------ handlers

async function commitLedgers(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();

  for (const row of dataset.validRows) {
    const name = String(row.values.ledgerName).trim();
    const key = normalizeName(name);
    const existing = await ctx.trx('ledgers').where({ company_id: ctx.companyId, normalized_name: key }).first();

    const payload = {
      name,
      group_name: row.values.groupName ?? null,
      gstin: row.values.gstin ?? null,
      opening_balance_minor: row.values.openingBalance ?? null,
      opening_side: row.values.openingSide ?? null,
      external_id: row.values.externalId ?? null,
      source_batch_id: ctx.batchId,
      updated_at: now,
    };

    if (existing) {
      if (ctx.duplicateStrategy === 'skip' || ctx.duplicateStrategy === 'review') {
        result.skipped++;
        continue;
      }
      const changedGroup = existing.group_name !== payload.group_name;
      const changedOpening = Number(existing.opening_balance_minor ?? NaN) !== Number(payload.opening_balance_minor ?? NaN);
      await ctx.trx('ledgers').where({ id: existing.id }).update(payload);
      result.updated++;
      if (changedGroup || changedOpening) {
        result.changes.push({
          type: 'updated',
          label: name,
          detail: [
            changedGroup ? `group ${existing.group_name ?? '(none)'} → ${payload.group_name ?? '(none)'}` : null,
            changedOpening ? `opening balance changed` : null,
          ]
            .filter(Boolean)
            .join('; '),
        });
      }
      continue;
    }

    const id = newId();
    await ctx.trx('ledgers').insert({
      id,
      company_id: ctx.companyId,
      normalized_name: key,
      created_at: now,
      ...payload,
    });
    result.inserted++;
    await createSuggestedMapping(ctx, id, name, row.values.groupName ?? null, result);
  }

  return result;
}

async function commitLedgerGroups(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();

  for (const row of dataset.validRows) {
    const name = String(row.values.groupName).trim();
    const key = normalizeName(name);
    const existing = await ctx.trx('ledger_groups').where({ company_id: ctx.companyId, normalized_name: key }).first();

    const payload = {
      name,
      parent_name: row.values.parentName ?? null,
      nature: row.values.nature ?? null,
      external_id: row.values.externalId ?? null,
      source_batch_id: ctx.batchId,
      updated_at: now,
    };

    if (existing) {
      if (ctx.duplicateStrategy === 'update') {
        await ctx.trx('ledger_groups').where({ id: existing.id }).update(payload);
        result.updated++;
      } else {
        result.skipped++;
      }
      continue;
    }

    await ctx.trx('ledger_groups').insert({ id: newId(), company_id: ctx.companyId, normalized_name: key, created_at: now, ...payload });
    result.inserted++;
  }

  return result;
}

async function commitOpeningBalances(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();
  const cache = new Map<string, string>();

  if (!ctx.financialYearId) {
    throw new Error('Opening balances require a financial year to be selected.');
  }

  for (const row of dataset.validRows) {
    const ledgerId = await ensureLedger(ctx, String(row.values.ledgerName), null, result, cache);

    const existing = await ctx
      .trx('opening_balances')
      .where({ company_id: ctx.companyId, financial_year_id: ctx.financialYearId, ledger_id: ledgerId })
      .first();

    const payload = {
      amount_minor: row.values.resolvedAmount ?? 0,
      side: row.values.side ?? 'debit',
      source_batch_id: ctx.batchId,
      updated_at: now,
    };

    if (existing) {
      if (ctx.duplicateStrategy !== 'update') {
        result.skipped++;
        continue;
      }
      if (Number(existing.amount_minor) !== payload.amount_minor || existing.side !== payload.side) {
        result.changes.push({
          type: 'updated',
          label: String(row.values.ledgerName),
          detail: `${(Number(existing.amount_minor) / 100).toFixed(2)} ${existing.side} → ${(payload.amount_minor / 100).toFixed(2)} ${payload.side}`,
        });
      }
      await ctx.trx('opening_balances').where({ id: existing.id }).update(payload);
      result.updated++;
      continue;
    }

    await ctx.trx('opening_balances').insert({
      id: newId(),
      company_id: ctx.companyId,
      financial_year_id: ctx.financialYearId,
      ledger_id: ledgerId,
      created_at: now,
      ...payload,
    });
    result.inserted++;

    // Mirror onto the ledger master when it has no opening balance of its own.
    await ctx
      .trx('ledgers')
      .where({ id: ledgerId })
      .whereNull('opening_balance_minor')
      .update({ opening_balance_minor: payload.amount_minor, opening_side: payload.side, updated_at: now });
  }

  return result;
}

async function commitVouchers(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();
  const cache = new Map<string, string>();
  const vouchers: VoucherGroup[] = dataset.vouchers ?? [];

  for (const v of vouchers) {
    const existing = await ctx.trx('vouchers').where({ company_id: ctx.companyId, dedupe_key: v.dedupeKey }).first();

    if (existing) {
      if (ctx.duplicateStrategy !== 'update') {
        result.skipped++;
        continue;
      }
      // Replace the lines wholesale — a voucher is an atomic document, and a
      // partial line update would leave it unbalanced.
      await ctx.trx('voucher_lines').where({ voucher_id: existing.id }).del();
      await writeVoucherLines(ctx, existing.id, v, result, cache, now);
      await ctx.trx('vouchers').where({ id: existing.id }).update({
        voucher_date: v.voucherDate,
        voucher_type: v.voucherType,
        voucher_number: v.voucherNumber,
        narration: v.narration,
        reference: v.reference,
        financial_year_id: ctx.financialYearId,
        source_batch_id: ctx.batchId,
        updated_at: now,
      });
      result.updated++;
      result.changes.push({
        type: 'updated',
        label: `Voucher ${v.voucherNumber ?? '(no number)'} dated ${v.voucherDate}`,
        detail: `${v.lines.length} line${v.lines.length === 1 ? '' : 's'} replaced`,
      });
      continue;
    }

    const voucherId = newId();
    await ctx.trx('vouchers').insert({
      id: voucherId,
      company_id: ctx.companyId,
      financial_year_id: ctx.financialYearId,
      voucher_date: v.voucherDate,
      voucher_type: v.voucherType,
      voucher_number: v.voucherNumber,
      narration: v.narration,
      reference: v.reference,
      external_id: v.externalId,
      dedupe_key: v.dedupeKey,
      source_batch_id: ctx.batchId,
      created_at: now,
      updated_at: now,
    });

    await writeVoucherLines(ctx, voucherId, v, result, cache, now);
    result.inserted++;
  }

  return result;
}

async function writeVoucherLines(
  ctx: CommitContext,
  voucherId: string,
  v: VoucherGroup,
  result: CommitResult,
  cache: Map<string, string>,
  now: string,
): Promise<void> {
  let lineNo = 1;
  for (const line of v.lines) {
    const ledgerId = await ensureLedger(ctx, line.ledgerName, null, result, cache);
    await ctx.trx('voucher_lines').insert({
      id: newId(),
      voucher_id: voucherId,
      company_id: ctx.companyId,
      ledger_id: ledgerId,
      line_no: lineNo++,
      debit_minor: line.debit,
      credit_minor: line.credit,
      cost_centre: line.costCentre,
      narration: line.narration,
      created_at: now,
    });
  }
}

async function commitOutstanding(
  dataset: ParsedDataset,
  ctx: CommitContext,
  table: 'receivables' | 'payables',
): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();
  const cache = new Map<string, string>();

  for (const row of dataset.validRows) {
    const key = row.values.__dedupeKey as string;
    const existing = await ctx.trx(table).where({ company_id: ctx.companyId, dedupe_key: key }).first();

    // Link to a ledger when one already exists; a bill does not justify inventing
    // a new account in the chart.
    const partyKey = normalizeName(String(row.values.partyName));
    let partyLedgerId = cache.get(partyKey) ?? null;
    if (!partyLedgerId) {
      const ledger = await ctx.trx('ledgers').where({ company_id: ctx.companyId, normalized_name: partyKey }).first();
      if (ledger) {
        partyLedgerId = ledger.id;
        cache.set(partyKey, ledger.id);
      }
    }

    const payload = {
      financial_year_id: ctx.financialYearId,
      party_name: String(row.values.partyName).trim(),
      party_ledger_id: partyLedgerId,
      document_number: row.values.documentNumber ?? null,
      document_date: row.values.documentDate ?? null,
      due_date: row.values.dueDate ?? null,
      amount_minor: row.values.amount ?? row.values.outstanding ?? 0,
      paid_minor: row.values.paidMinor ?? null,
      outstanding_minor: row.values.outstanding ?? 0,
      cost_centre: row.values.costCentre ?? null,
      reference: row.values.reference ?? null,
      source_batch_id: ctx.batchId,
      updated_at: now,
    };

    if (existing) {
      if (ctx.duplicateStrategy !== 'update') {
        result.skipped++;
        continue;
      }
      if (Number(existing.outstanding_minor) !== payload.outstanding_minor) {
        result.changes.push({
          type: 'updated',
          label: `${payload.party_name} — ${payload.document_number ?? 'no reference'}`,
          detail: `outstanding ${(Number(existing.outstanding_minor) / 100).toFixed(2)} → ${(payload.outstanding_minor / 100).toFixed(2)}`,
        });
      }
      await ctx.trx(table).where({ id: existing.id }).update(payload);
      result.updated++;
      continue;
    }

    await ctx.trx(table).insert({ id: newId(), company_id: ctx.companyId, dedupe_key: key, created_at: now, ...payload });
    result.inserted++;
  }

  return result;
}

async function commitCostCentres(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();

  for (const row of dataset.validRows) {
    const name = String(row.values.name).trim();
    const key = normalizeName(name);
    const existing = await ctx.trx('cost_centres').where({ company_id: ctx.companyId, normalized_name: key }).first();

    if (existing) {
      if (ctx.duplicateStrategy === 'update') {
        await ctx.trx('cost_centres').where({ id: existing.id }).update({
          name,
          parent_name: row.values.parentName ?? null,
          external_id: row.values.externalId ?? null,
          updated_at: now,
        });
        result.updated++;
      } else result.skipped++;
      continue;
    }

    await ctx.trx('cost_centres').insert({
      id: newId(),
      company_id: ctx.companyId,
      name,
      normalized_name: key,
      parent_name: row.values.parentName ?? null,
      external_id: row.values.externalId ?? null,
      source_batch_id: ctx.batchId,
      created_at: now,
      updated_at: now,
    });
    result.inserted++;
  }

  return result;
}

async function commitStockItems(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();

  for (const row of dataset.validRows) {
    const name = String(row.values.name).trim();
    const key = normalizeName(name);
    const existing = await ctx.trx('stock_items').where({ company_id: ctx.companyId, normalized_name: key }).first();

    const payload = {
      name,
      unit: row.values.unit ?? null,
      quantity: row.values.quantity ?? null,
      rate_minor: row.values.rate ?? null,
      value_minor: row.values.value ?? null,
      as_of_date: row.values.asOfDate ?? null,
      external_id: row.values.externalId ?? null,
      source_batch_id: ctx.batchId,
      updated_at: now,
    };

    if (existing) {
      if (ctx.duplicateStrategy === 'update') {
        await ctx.trx('stock_items').where({ id: existing.id }).update(payload);
        result.updated++;
      } else result.skipped++;
      continue;
    }

    await ctx.trx('stock_items').insert({ id: newId(), company_id: ctx.companyId, normalized_name: key, created_at: now, ...payload });
    result.inserted++;
  }

  return result;
}

async function commitExpenses(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();
  const cache = new Map<string, string>();

  for (const row of dataset.validRows) {
    const key = row.values.__dedupeKey as string;
    const existing = await ctx.trx('expenses').where({ company_id: ctx.companyId, dedupe_key: key }).first();

    let ledgerId: string | null = null;
    if (row.values.ledgerName) {
      ledgerId = await ensureLedger(ctx, String(row.values.ledgerName), null, result, cache);
    }

    const payload = {
      financial_year_id: ctx.financialYearId,
      expense_date: row.values.expenseDate,
      category: row.values.category ?? null,
      vendor: row.values.vendor ?? null,
      ledger_id: ledgerId,
      amount_minor: row.values.amount ?? 0,
      expense_type: row.values.expenseType ?? 'one_off',
      cost_centre: row.values.costCentre ?? null,
      reference: row.values.reference ?? null,
      notes: row.values.notes ?? null,
      source_batch_id: ctx.batchId,
      updated_at: now,
    };

    if (existing) {
      if (ctx.duplicateStrategy === 'update') {
        await ctx.trx('expenses').where({ id: existing.id }).update(payload);
        result.updated++;
      } else result.skipped++;
      continue;
    }

    await ctx.trx('expenses').insert({
      id: newId(),
      company_id: ctx.companyId,
      dedupe_key: key,
      created_by: ctx.userId,
      created_at: now,
      ...payload,
    });
    result.inserted++;
  }

  return result;
}

async function commitBudgets(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();

  for (const row of dataset.validRows) {
    const existing = await ctx
      .trx('budgets')
      .where({
        company_id: ctx.companyId,
        category: row.values.category,
        period_start: row.values.periodStart,
        period_end: row.values.periodEnd,
      })
      .andWhere((qb) => {
        if (row.values.costCentre) qb.where('cost_centre', row.values.costCentre);
        else qb.whereNull('cost_centre');
      })
      .first();

    const payload = {
      financial_year_id: ctx.financialYearId,
      category: row.values.category,
      period_type: row.values.periodType ?? 'custom',
      period_start: row.values.periodStart,
      period_end: row.values.periodEnd,
      cost_centre: row.values.costCentre ?? null,
      amount_minor: row.values.amount ?? 0,
      notes: row.values.notes ?? null,
      source_batch_id: ctx.batchId,
      updated_at: now,
    };

    if (existing) {
      if (ctx.duplicateStrategy === 'update') {
        if (Number(existing.amount_minor) !== payload.amount_minor) {
          result.changes.push({
            type: 'updated',
            label: `${payload.category} (${payload.period_start} to ${payload.period_end})`,
            detail: `budget ${(Number(existing.amount_minor) / 100).toFixed(2)} → ${(payload.amount_minor / 100).toFixed(2)}`,
          });
        }
        await ctx.trx('budgets').where({ id: existing.id }).update(payload);
        result.updated++;
      } else result.skipped++;
      continue;
    }

    await ctx.trx('budgets').insert({ id: newId(), company_id: ctx.companyId, created_by: ctx.userId, created_at: now, ...payload });
    result.inserted++;
  }

  return result;
}

async function commitRecurringExpenses(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();
  const cache = new Map<string, string>();

  for (const row of dataset.validRows) {
    const existing = await ctx
      .trx('recurring_expenses')
      .where({ company_id: ctx.companyId, name: row.values.name, frequency: row.values.frequency, start_date: row.values.startDate })
      .first();

    let ledgerId: string | null = null;
    if (row.values.ledgerName) {
      ledgerId = await ensureLedger(ctx, String(row.values.ledgerName), null, result, cache);
    }

    const payload = {
      name: row.values.name,
      category: row.values.category ?? null,
      amount_minor: row.values.amount ?? 0,
      frequency: row.values.frequency,
      start_date: row.values.startDate,
      next_due_date: row.values.nextDueDate ?? row.values.startDate,
      end_date: row.values.endDate ?? null,
      ledger_id: ledgerId,
      vendor: row.values.vendor ?? null,
      cost_centre: row.values.costCentre ?? null,
      is_active: row.values.isActive ?? true,
      is_variable: row.values.isVariable ?? false,
      source_batch_id: ctx.batchId,
      updated_at: now,
    };

    if (existing) {
      if (ctx.duplicateStrategy === 'update') {
        await ctx.trx('recurring_expenses').where({ id: existing.id }).update(payload);
        result.updated++;
      } else result.skipped++;
      continue;
    }

    await ctx.trx('recurring_expenses').insert({ id: newId(), company_id: ctx.companyId, created_by: ctx.userId, created_at: now, ...payload });
    result.inserted++;
  }

  return result;
}

async function commitCommitments(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();

  for (const row of dataset.validRows) {
    const existing = await ctx
      .trx('commitments')
      .where({
        company_id: ctx.companyId,
        name: row.values.name,
        expected_date: row.values.expectedDate,
        amount_minor: row.values.amount ?? 0,
      })
      .first();

    if (existing) {
      if (ctx.duplicateStrategy === 'update') {
        await ctx.trx('commitments').where({ id: existing.id }).update({
          direction: row.values.direction,
          confidence: row.values.confidence ?? null,
          notes: row.values.notes ?? null,
          updated_at: now,
        });
        result.updated++;
      } else result.skipped++;
      continue;
    }

    await ctx.trx('commitments').insert({
      id: newId(),
      company_id: ctx.companyId,
      name: row.values.name,
      direction: row.values.direction,
      amount_minor: row.values.amount ?? 0,
      expected_date: row.values.expectedDate,
      confidence: row.values.confidence ?? null,
      notes: row.values.notes ?? null,
      source_batch_id: ctx.batchId,
      created_by: ctx.userId,
      created_at: now,
      updated_at: now,
    });
    result.inserted++;
  }

  return result;
}

async function commitCustomers(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const now = nowIso();

  for (const row of dataset.validRows) {
    const gstin = row.values.gstinValid === false ? null : (row.values.gstin ?? null);
    const name = String(row.values.customerName).trim();

    // Prefer an explicit ledger name, then GSTIN, then the customer name.
    let ledgerId: string | null = null;
    let matchMethod: string | null = null;

    if (row.values.ledgerName) {
      const l = await ctx.trx('ledgers').where({ company_id: ctx.companyId, normalized_name: normalizeName(String(row.values.ledgerName)) }).first();
      if (l) {
        ledgerId = l.id;
        matchMethod = 'manual';
      }
    }
    if (!ledgerId && gstin) {
      const l = await ctx.trx('ledgers').where({ company_id: ctx.companyId, gstin }).first();
      if (l) {
        ledgerId = l.id;
        matchMethod = 'gstin';
      }
    }
    if (!ledgerId) {
      const l = await ctx.trx('ledgers').where({ company_id: ctx.companyId, normalized_name: normalizeName(name) }).first();
      if (l) {
        ledgerId = l.id;
        matchMethod = 'name';
      }
    }

    const existing = gstin
      ? await ctx.trx('crm_links').where({ company_id: ctx.companyId, gstin }).first()
      : await ctx.trx('crm_links').whereRaw('company_id = ? AND LOWER(customer_name) = LOWER(?)', [ctx.companyId, name]).first();

    const payload = {
      ledger_id: ledgerId,
      crm_account_id: row.values.crmAccountId ?? null,
      crm_source: 'excel_import',
      customer_name: name,
      gstin,
      contact_email: row.values.contactEmail ?? null,
      contact_phone: row.values.contactPhone ?? null,
      owner: row.values.owner ? String(row.values.owner).toLowerCase().trim() : null,
      match_method: matchMethod,
      source_batch_id: ctx.batchId,
      updated_at: now,
    };

    if (existing) {
      if (ctx.duplicateStrategy === 'update') {
        await ctx.trx('crm_links').where({ id: existing.id }).update(payload);
        result.updated++;
      } else result.skipped++;
      continue;
    }

    await ctx.trx('crm_links').insert({ id: newId(), company_id: ctx.companyId, created_at: now, ...payload });
    result.inserted++;
  }

  return result;
}

async function commitCompanyDetails(dataset: ParsedDataset, ctx: CommitContext): Promise<CommitResult> {
  const result = emptyResult();
  const row: ParsedRow | undefined = dataset.validRows[0];
  if (!row) return result;

  const company = await ctx.trx('companies').where({ id: ctx.companyId }).first();
  const patch: Record<string, unknown> = { updated_at: nowIso() };

  const assign = (column: string, value: unknown, label: string) => {
    if (value === null || value === undefined || value === '') return;
    if (company[column] !== value) {
      result.changes.push({ type: 'updated', label, detail: `${company[column] ?? '(blank)'} → ${value}` });
      patch[column] = value;
    }
  };

  assign('name', row.values.name, 'Company name');
  assign('legal_name', row.values.legalName, 'Legal name');
  assign('gstin', row.values.gstin, 'GSTIN');
  assign('pan', row.values.pan, 'PAN');
  assign('address', row.values.address, 'Address');
  assign('currency', row.values.currency, 'Currency');

  if (Object.keys(patch).length > 1) {
    await ctx.trx('companies').where({ id: ctx.companyId }).update(patch);
    result.updated = 1;
  } else {
    result.skipped = 1;
  }

  return result;
}

export { dedupeKey };
