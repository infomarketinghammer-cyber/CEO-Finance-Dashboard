import { db } from '../../db/index.js';
import { add, sub, type Minor } from '../../lib/money.js';
import { SECTION_LABELS, type Statement } from '../mapping/categories.js';

/**
 * The single source of financial truth.
 *
 * Every KPI card, chart, statement, ratio and export in DHYEYA is derived from the
 * functions in this file. Nothing recomputes a total of its own, so a figure cannot
 * disagree with itself between the dashboard and the Profit & Loss.
 *
 * SIGN CONVENTION
 * Internally every balance is held as a single signed integer in minor units on a
 * DEBIT-POSITIVE basis:
 *
 *     net = (openingDebit − openingCredit) + (periodDebits − periodCredits)
 *
 * A debit-normal account (asset, expense) therefore carries a positive net when it
 * behaves normally, and a credit-normal account (liability, equity, income) carries
 * a negative one. Presentation flips the sign once, at the end, according to the
 * category's `normalSide`. Doing it this way means the accounting equation is a
 * genuine arithmetic check rather than a rule enforced by the presentation layer.
 *
 * MISSING DATA
 * Nothing here substitutes zero for absent data. A total that no record supports
 * is returned as `null` with a reason, and the API surfaces that as
 * "Data unavailable" rather than ₹0.00.
 */

export type MappingStatus = 'confirmed' | 'suggested' | 'unmapped';

export interface LedgerBalance {
  ledgerId: string;
  ledgerName: string;
  groupName: string | null;
  categoryKey: string | null;
  categoryLabel: string | null;
  statement: Statement | null;
  section: string | null;
  normalSide: 'debit' | 'credit' | null;
  mappingStatus: MappingStatus;
  openingDebit: Minor;
  openingCredit: Minor;
  periodDebit: Minor;
  periodCredit: Minor;
  /** Debit-positive signed balance at the end of the period. */
  closingNet: Minor;
  /** Signed for presentation under the category's normal side. */
  presented: Minor;
  transactionCount: number;
}

export interface PeriodRef {
  from: string;
  to: string;
  label?: string;
}

export interface BalanceOptions {
  /** Exclude ledgers whose category is only a suggestion. */
  confirmedOnly?: boolean;
  /** Restrict to a cost centre present on voucher lines. */
  costCentre?: string | null;
  /** Opening balances are read for this financial year. */
  financialYearId?: string | null;
}

export interface DataQuality {
  unmappedLedgerCount: number;
  unmappedNet: Minor;
  suggestedLedgerCount: number;
  suggestedNet: Minor;
  ledgersWithoutOpeningBalance: number;
  warnings: string[];
}

export interface BalanceSet {
  balances: LedgerBalance[];
  period: PeriodRef;
  quality: DataQuality;
  /** True when no voucher line and no opening balance exists at all. */
  isEmpty: boolean;
}

// --------------------------------------------------------------- core loader

interface CategoryRow {
  key: string;
  label: string;
  statement: Statement;
  section: string;
  normal_side: 'debit' | 'credit';
}

async function loadCategories(companyId: string): Promise<Map<string, CategoryRow>> {
  const rows = await db('account_categories')
    .where(function () {
      this.whereNull('company_id').orWhere('company_id', companyId);
    })
    .andWhere('is_active', true)
    .select('key', 'label', 'statement', 'section', 'normal_side', 'company_id');

  // A company-specific category of the same key overrides the system default.
  const map = new Map<string, CategoryRow>();
  for (const r of rows) {
    if (r.company_id === null && map.has(r.key)) continue;
    map.set(r.key, { key: r.key, label: r.label, statement: r.statement, section: r.section, normal_side: r.normal_side });
  }
  return map;
}

/**
 * Loads every ledger with its opening position and its movement across a period.
 *
 * Opening comes from the financial year's opening balances where they exist, plus
 * any voucher movement between the financial-year start and the period start — so
 * asking for a March period on an April-to-March year gives a true opening
 * position, not a blank one.
 */
export async function loadBalances(companyId: string, period: PeriodRef, opts: BalanceOptions = {}): Promise<BalanceSet> {
  const categories = await loadCategories(companyId);

  const ledgers = await db('ledgers')
    .where('ledgers.company_id', companyId)
    .leftJoin('account_mappings', function () {
      this.on('account_mappings.ledger_id', '=', 'ledgers.id').andOn('account_mappings.company_id', '=', 'ledgers.company_id');
    })
    .select(
      'ledgers.id',
      'ledgers.name',
      'ledgers.group_name',
      'ledgers.opening_balance_minor',
      'ledgers.opening_side',
      'account_mappings.category_key',
      'account_mappings.status as mapping_status',
    );

  // Financial-year context for the opening position.
  let fyStart: string | null = null;
  if (opts.financialYearId) {
    const fy = await db('financial_years').where({ id: opts.financialYearId, company_id: companyId }).first();
    fyStart = fy?.start_date ?? null;
  }

  const openingRows = opts.financialYearId
    ? await db('opening_balances').where({ company_id: companyId, financial_year_id: opts.financialYearId })
    : [];
  const openingByLedger = new Map<string, { amount: Minor; side: 'debit' | 'credit' }>();
  for (const r of openingRows) {
    openingByLedger.set(r.ledger_id, { amount: Number(r.amount_minor), side: r.side });
  }

  // Movement within the reporting period.
  const periodMovement = await sumMovement(companyId, period.from, period.to, opts.costCentre);

  // Movement between the financial-year start and the period start, which belongs
  // in the opening position rather than the period.
  const priorMovement =
    fyStart && fyStart < period.from
      ? await sumMovement(companyId, fyStart, previousDay(period.from), opts.costCentre)
      : new Map<string, { debit: Minor; credit: Minor; count: number }>();

  const balances: LedgerBalance[] = [];
  let unmappedNet: Minor = 0;
  let unmappedCount = 0;
  let suggestedNet: Minor = 0;
  let suggestedCount = 0;
  let withoutOpening = 0;
  let anyActivity = false;

  for (const l of ledgers) {
    const declared = openingByLedger.get(l.id);
    const masterOpening =
      l.opening_balance_minor !== null && l.opening_balance_minor !== undefined
        ? { amount: Number(l.opening_balance_minor), side: (l.opening_side ?? 'debit') as 'debit' | 'credit' }
        : null;

    const opening = declared ?? masterOpening;
    if (!opening) withoutOpening++;

    const prior = priorMovement.get(l.id) ?? { debit: 0, credit: 0, count: 0 };
    const movement = periodMovement.get(l.id) ?? { debit: 0, credit: 0, count: 0 };

    const openingDebit = (opening?.side === 'debit' ? opening.amount : 0) + prior.debit;
    const openingCredit = (opening?.side === 'credit' ? opening.amount : 0) + prior.credit;

    const closingNet = add(sub(openingDebit, openingCredit), sub(movement.debit, movement.credit));

    if (opening || movement.count > 0 || prior.count > 0) anyActivity = true;

    const rawStatus = l.mapping_status as string | null;
    const categoryKey = l.category_key as string | null;
    const category = categoryKey ? categories.get(categoryKey) : undefined;

    let status: MappingStatus;
    if (!categoryKey || !category) status = 'unmapped';
    else if (rawStatus === 'confirmed') status = 'confirmed';
    else status = 'suggested';

    if (status === 'unmapped') {
      unmappedCount++;
      unmappedNet = add(unmappedNet, closingNet);
    } else if (status === 'suggested') {
      suggestedCount++;
      suggestedNet = add(suggestedNet, closingNet);
    }

    const include = status === 'confirmed' || (status === 'suggested' && !opts.confirmedOnly);

    balances.push({
      ledgerId: l.id,
      ledgerName: l.name,
      groupName: l.group_name ?? null,
      categoryKey: include ? categoryKey : null,
      categoryLabel: include ? (category?.label ?? null) : null,
      statement: include ? (category?.statement ?? null) : null,
      section: include ? (category?.section ?? null) : null,
      normalSide: include ? (category?.normal_side ?? null) : null,
      mappingStatus: status,
      openingDebit,
      openingCredit,
      periodDebit: movement.debit,
      periodCredit: movement.credit,
      closingNet,
      presented: category && include ? (category.normal_side === 'credit' ? -closingNet : closingNet) : closingNet,
      transactionCount: movement.count,
    });
  }

  const warnings: string[] = [];
  if (unmappedCount > 0) {
    warnings.push(
      `${unmappedCount} ledger${unmappedCount === 1 ? ' has' : 's have'} no financial category. Their balances are excluded from the statements, which will show as a difference on the Balance Sheet.`,
    );
  }
  if (suggestedCount > 0 && !opts.confirmedOnly) {
    warnings.push(
      `${suggestedCount} ledger${suggestedCount === 1 ? "'s category is" : "s' categories are"} an unconfirmed suggestion. Figures include them — approve them in Account Mapping to remove this caveat.`,
    );
  }
  if (withoutOpening > 0 && openingRows.length === 0) {
    warnings.push('No opening balances have been imported for this financial year, so the Balance Sheet reflects transaction movement only.');
  }

  return {
    balances,
    period,
    quality: {
      unmappedLedgerCount: unmappedCount,
      unmappedNet,
      suggestedLedgerCount: suggestedCount,
      suggestedNet,
      ledgersWithoutOpeningBalance: withoutOpening,
      warnings,
    },
    isEmpty: !anyActivity,
  };
}

async function sumMovement(
  companyId: string,
  from: string,
  to: string,
  costCentre?: string | null,
): Promise<Map<string, { debit: Minor; credit: Minor; count: number }>> {
  let q = db('voucher_lines')
    .join('vouchers', 'voucher_lines.voucher_id', 'vouchers.id')
    .where('voucher_lines.company_id', companyId)
    .andWhere('vouchers.voucher_date', '>=', from)
    .andWhere('vouchers.voucher_date', '<=', to);

  if (costCentre) q = q.andWhere('voucher_lines.cost_centre', costCentre);

  const rows = await q
    .groupBy('voucher_lines.ledger_id')
    .select('voucher_lines.ledger_id')
    .sum({ debit: 'voucher_lines.debit_minor' })
    .sum({ credit: 'voucher_lines.credit_minor' })
    .count({ count: 'voucher_lines.id' });

  const map = new Map<string, { debit: Minor; credit: Minor; count: number }>();
  for (const r of rows as Array<Record<string, unknown>>) {
    map.set(String(r.ledger_id), {
      debit: Math.round(Number(r.debit ?? 0)),
      credit: Math.round(Number(r.credit ?? 0)),
      count: Number(r.count ?? 0),
    });
  }
  return map;
}

function previousDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------- aggregations

export interface SectionTotal {
  section: string;
  label: string;
  total: Minor;
  lines: { categoryKey: string; label: string; total: Minor; ledgerCount: number }[];
}

/** Rolls presented balances up by section, then by category within each section. */
export function totalsBySection(balances: LedgerBalance[], statement: Statement, sections?: string[]): SectionTotal[] {
  const bySection = new Map<string, Map<string, { label: string; total: Minor; ledgerCount: number }>>();

  for (const b of balances) {
    if (b.statement !== statement || !b.section || !b.categoryKey) continue;
    if (sections && !sections.includes(b.section)) continue;

    let cats = bySection.get(b.section);
    if (!cats) {
      cats = new Map();
      bySection.set(b.section, cats);
    }
    const entry = cats.get(b.categoryKey) ?? { label: b.categoryLabel ?? b.categoryKey, total: 0, ledgerCount: 0 };
    entry.total = add(entry.total, b.presented);
    entry.ledgerCount++;
    cats.set(b.categoryKey, entry);
  }

  const order = sections ?? [...bySection.keys()];
  return order
    .filter((s) => bySection.has(s))
    .map((section) => {
      const cats = bySection.get(section)!;
      const lines = [...cats.entries()].map(([categoryKey, v]) => ({
        categoryKey,
        label: v.label,
        total: v.total,
        ledgerCount: v.ledgerCount,
      }));
      lines.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      return {
        section,
        label: SECTION_LABELS[section] ?? section,
        total: lines.reduce((acc, l) => add(acc, l.total), 0 as Minor),
        lines,
      };
    });
}

export function sumSections(balances: LedgerBalance[], statement: Statement, sections: readonly string[]): Minor {
  let total: Minor = 0;
  for (const b of balances) {
    if (b.statement !== statement || !b.section) continue;
    if (!sections.includes(b.section)) continue;
    total = add(total, b.presented);
  }
  return total;
}

/** Whether any ledger at all is classified under these sections. */
export function hasSectionData(balances: LedgerBalance[], statement: Statement, sections: readonly string[]): boolean {
  return balances.some(
    (b) => b.statement === statement && b.section && sections.includes(b.section) && (b.closingNet !== 0 || b.transactionCount > 0),
  );
}

/**
 * A value together with whether the data needed to compute it actually exists.
 * The API never ships a bare zero that might mean "nothing imported".
 */
export interface Measure {
  value: Minor | null;
  available: boolean;
  reason?: string;
  basis?: string;
}

export function measure(value: Minor, available: boolean, reason?: string, basis?: string): Measure {
  return available ? { value, available: true, basis } : { value: null, available: false, reason, basis };
}
