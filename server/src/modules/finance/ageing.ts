import { db } from '../../db/index.js';
import { add, type Minor } from '../../lib/money.js';
import { daysBetween } from '../../lib/dates.js';
import { readJson } from '../../lib/json.js';

/**
 * Receivable and payable ageing.
 *
 * Buckets are configurable per company. Documents with no due date are counted in
 * a bucket of their own rather than assumed current or assumed overdue — §14
 * forbids inferring a due date, and silently treating a missing one as "not due"
 * would understate the overdue position.
 */

export interface AgeingBucket {
  key: string;
  label: string;
  /** Inclusive lower bound of days overdue; null for the "not due" bucket. */
  minDays: number | null;
  /** Inclusive upper bound; null means open-ended. */
  maxDays: number | null;
}

export const DEFAULT_BUCKETS: AgeingBucket[] = [
  { key: 'not_due', label: 'Not due', minDays: null, maxDays: null },
  { key: 'd1_30', label: '1–30 days overdue', minDays: 1, maxDays: 30 },
  { key: 'd31_60', label: '31–60 days overdue', minDays: 31, maxDays: 60 },
  { key: 'd61_90', label: '61–90 days overdue', minDays: 61, maxDays: 90 },
  { key: 'd90_plus', label: 'More than 90 days overdue', minDays: 91, maxDays: null },
];

export const NO_DUE_DATE_BUCKET: AgeingBucket = {
  key: 'no_due_date',
  label: 'No due date supplied',
  minDays: null,
  maxDays: null,
};

export async function getAgeingBuckets(companyId: string): Promise<AgeingBucket[]> {
  const row = await db('app_settings').where({ company_id: companyId, key: 'ageing_buckets' }).first();
  if (!row) return DEFAULT_BUCKETS;
  const parsed = readJson<AgeingBucket[]>(row.value, DEFAULT_BUCKETS);
  return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_BUCKETS;
}

export interface OutstandingDocument {
  id: string;
  partyName: string;
  partyLedgerId: string | null;
  documentNumber: string | null;
  documentDate: string | null;
  dueDate: string | null;
  amount: Minor;
  paid: Minor | null;
  outstanding: Minor;
  overdueDays: number | null;
  bucketKey: string;
  bucketLabel: string;
  status: 'not_due' | 'overdue' | 'unknown_due_date' | 'settled';
  costCentre: string | null;
  reference: string | null;
}

export interface AgeingSummary {
  asOfDate: string;
  table: 'receivables' | 'payables';
  buckets: { key: string; label: string; total: Minor; count: number }[];
  total: Minor;
  totalCount: number;
  overdueTotal: Minor;
  overdueCount: number;
  missingDueDateTotal: Minor;
  missingDueDateCount: number;
  topParties: { partyName: string; outstanding: Minor; overdue: Minor; count: number }[];
  warnings: string[];
}

function classify(dueDate: string | null, asOfDate: string, buckets: AgeingBucket[]): { bucket: AgeingBucket; overdueDays: number | null; status: OutstandingDocument['status'] } {
  if (!dueDate) {
    return { bucket: NO_DUE_DATE_BUCKET, overdueDays: null, status: 'unknown_due_date' };
  }
  const overdueDays = daysBetween(dueDate, asOfDate);
  if (overdueDays <= 0) {
    const notDue = buckets.find((b) => b.key === 'not_due') ?? buckets[0];
    return { bucket: notDue, overdueDays, status: 'not_due' };
  }
  const match =
    buckets.find((b) => b.minDays !== null && overdueDays >= b.minDays && (b.maxDays === null || overdueDays <= b.maxDays)) ??
    buckets[buckets.length - 1];
  return { bucket: match, overdueDays, status: 'overdue' };
}

export interface ListOutstandingArgs {
  companyId: string;
  table: 'receivables' | 'payables';
  asOfDate: string;
  search?: string;
  bucketKey?: string;
  partyName?: string;
  includeSettled?: boolean;
  /** Restricts to parties owned by this user — used for the Sales role. */
  restrictToOwnerEmail?: string | null;
  page?: number;
  pageSize?: number;
  sortBy?: 'party' | 'dueDate' | 'outstanding' | 'overdueDays';
  sortDir?: 'asc' | 'desc';
}

export async function listOutstanding(args: ListOutstandingArgs): Promise<{
  documents: OutstandingDocument[];
  total: number;
  summary: AgeingSummary;
}> {
  const buckets = await getAgeingBuckets(args.companyId);
  const page = Math.max(1, args.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, args.pageSize ?? 50));

  let base = db(args.table).where(`${args.table}.company_id`, args.companyId);

  if (!args.includeSettled) base = base.andWhere(`${args.table}.outstanding_minor`, '!=', 0);

  if (args.search) {
    const pattern = `%${args.search.toLowerCase()}%`;
    base = base.andWhere((qb) => {
      qb.whereRaw(`LOWER(${args.table}.party_name) LIKE ?`, [pattern]).orWhereRaw(
        `LOWER(COALESCE(${args.table}.document_number, '')) LIKE ?`,
        [pattern],
      );
    });
  }

  if (args.partyName) base = base.andWhere(`${args.table}.party_name`, args.partyName);

  // Sales users see only parties assigned to them in the customer records.
  if (args.restrictToOwnerEmail) {
    const owned = await db('crm_links')
      .where({ company_id: args.companyId, owner: args.restrictToOwnerEmail.toLowerCase() })
      .select('customer_name', 'ledger_id');
    const names = owned.map((o: { customer_name: string }) => o.customer_name.toLowerCase());
    const ledgerIds = owned.map((o: { ledger_id: string | null }) => o.ledger_id).filter(Boolean);

    if (!names.length && !ledgerIds.length) {
      const emptySummary = buildSummary(args.table, args.asOfDate, [], buckets, []);
      return { documents: [], total: 0, summary: emptySummary };
    }

    base = base.andWhere((qb) => {
      if (names.length) {
        qb.whereRaw(
          `LOWER(${args.table}.party_name) IN (${names.map(() => '?').join(',')})`,
          names,
        );
      }
      if (ledgerIds.length) qb.orWhereIn(`${args.table}.party_ledger_id`, ledgerIds);
    });
  }

  // The full filtered set drives the summary; the page drives the table.
  const allRows = await base.clone().select('*');

  const documents = allRows.map((r: Record<string, any>) => toDocument(r, args.asOfDate, buckets));

  let filtered = documents;
  if (args.bucketKey) filtered = documents.filter((d) => d.bucketKey === args.bucketKey);

  const sortBy = args.sortBy ?? 'overdueDays';
  const dir = args.sortDir === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    switch (sortBy) {
      case 'party':
        return a.partyName.localeCompare(b.partyName) * dir;
      case 'dueDate':
        return ((a.dueDate ?? '9999-12-31') > (b.dueDate ?? '9999-12-31') ? 1 : -1) * dir;
      case 'outstanding':
        return (a.outstanding - b.outstanding) * dir;
      default:
        return ((a.overdueDays ?? -99999) - (b.overdueDays ?? -99999)) * dir;
    }
  });

  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);
  const summary = buildSummary(args.table, args.asOfDate, documents, buckets, []);

  return { documents: paged, total: filtered.length, summary };
}

function toDocument(r: Record<string, any>, asOfDate: string, buckets: AgeingBucket[]): OutstandingDocument {
  const outstanding = Number(r.outstanding_minor);
  const { bucket, overdueDays, status } = classify(r.due_date ?? null, asOfDate, buckets);
  return {
    id: r.id,
    partyName: r.party_name,
    partyLedgerId: r.party_ledger_id ?? null,
    documentNumber: r.document_number ?? null,
    documentDate: r.document_date ?? null,
    dueDate: r.due_date ?? null,
    amount: Number(r.amount_minor),
    paid: r.paid_minor === null || r.paid_minor === undefined ? null : Number(r.paid_minor),
    outstanding,
    overdueDays,
    bucketKey: outstanding === 0 ? 'settled' : bucket.key,
    bucketLabel: outstanding === 0 ? 'Settled' : bucket.label,
    status: outstanding === 0 ? 'settled' : status,
    costCentre: r.cost_centre ?? null,
    reference: r.reference ?? null,
  };
}

function buildSummary(
  table: 'receivables' | 'payables',
  asOfDate: string,
  documents: OutstandingDocument[],
  buckets: AgeingBucket[],
  warnings: string[],
): AgeingSummary {
  const allBuckets = [...buckets, NO_DUE_DATE_BUCKET];
  const totals = new Map<string, { total: Minor; count: number }>();
  for (const b of allBuckets) totals.set(b.key, { total: 0, count: 0 });

  const byParty = new Map<string, { outstanding: Minor; overdue: Minor; count: number }>();

  let total: Minor = 0;
  let overdueTotal: Minor = 0;
  let overdueCount = 0;
  let missingDueDateTotal: Minor = 0;
  let missingDueDateCount = 0;

  for (const d of documents) {
    if (d.outstanding === 0) continue;
    const entry = totals.get(d.bucketKey);
    if (entry) {
      entry.total = add(entry.total, d.outstanding);
      entry.count++;
    }
    total = add(total, d.outstanding);

    if (d.status === 'overdue') {
      overdueTotal = add(overdueTotal, d.outstanding);
      overdueCount++;
    }
    if (d.status === 'unknown_due_date') {
      missingDueDateTotal = add(missingDueDateTotal, d.outstanding);
      missingDueDateCount++;
    }

    const p = byParty.get(d.partyName) ?? { outstanding: 0, overdue: 0, count: 0 };
    p.outstanding = add(p.outstanding, d.outstanding);
    if (d.status === 'overdue') p.overdue = add(p.overdue, d.outstanding);
    p.count++;
    byParty.set(d.partyName, p);
  }

  const resultWarnings = [...warnings];
  if (missingDueDateCount > 0) {
    resultWarnings.push(
      `${missingDueDateCount} document${missingDueDateCount === 1 ? '' : 's'} totalling ${(missingDueDateTotal / 100).toFixed(2)} have no due date in the imported data. They are listed separately and are not counted as overdue, because a due date is never inferred.`,
    );
  }

  return {
    asOfDate,
    table,
    buckets: allBuckets
      .map((b) => ({ key: b.key, label: b.label, total: totals.get(b.key)?.total ?? 0, count: totals.get(b.key)?.count ?? 0 }))
      .filter((b) => b.key !== 'no_due_date' || b.count > 0),
    total,
    totalCount: documents.filter((d) => d.outstanding !== 0).length,
    overdueTotal,
    overdueCount,
    missingDueDateTotal,
    missingDueDateCount,
    topParties: [...byParty.entries()]
      .map(([partyName, v]) => ({ partyName, ...v }))
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 10),
    warnings: resultWarnings,
  };
}

/** Totals only — used by the dashboard without pulling every document. */
export async function outstandingTotals(companyId: string, asOfDate: string): Promise<{
  receivables: AgeingSummary;
  payables: AgeingSummary;
}> {
  const buckets = await getAgeingBuckets(companyId);

  const load = async (table: 'receivables' | 'payables') => {
    const rows = await db(table).where({ company_id: table === 'receivables' ? companyId : companyId }).andWhere('outstanding_minor', '!=', 0);
    const docs = rows.map((r: Record<string, any>) => toDocument(r, asOfDate, buckets));
    return buildSummary(table, asOfDate, docs, buckets, []);
  };

  const [receivables, payables] = await Promise.all([load('receivables'), load('payables')]);
  return { receivables, payables };
}
