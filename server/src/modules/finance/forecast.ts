import { db } from '../../db/index.js';
import { add, sub, mulRatio, type Minor } from '../../lib/money.js';
import { addDays, addMonths, daysBetween } from '../../lib/dates.js';
import { loadBalances, sumSections } from './engine.js';
import { readJson } from '../../lib/json.js';

/**
 * Cash flow forecast.
 *
 * This is a RULE-BASED projection, not a machine-learned prediction, and it says
 * so everywhere it is shown. It assembles dated cash events from records that
 * already exist — outstanding receivables, payables, recurring expense schedules
 * and known commitments — and walks the opening bank balance forward through them.
 *
 * Nothing is invented. A receivable with no due date cannot be placed on a day, so
 * it is excluded from the projection and reported separately as unscheduled, which
 * is also why the forecast carries a data-sufficiency score rather than a
 * confidence interval it has no basis to compute.
 */

export type Scenario = 'best' | 'expected' | 'worst';

export interface ForecastDriver {
  date: string;
  kind: 'receivable' | 'payable' | 'recurring_expense' | 'commitment';
  label: string;
  reference: string | null;
  direction: 'inflow' | 'outflow';
  /** Amount at face value, before scenario adjustment. */
  amount: Minor;
  /** Amount applied in the scenario being computed. */
  applied: Minor;
  sourceId: string | null;
  note?: string;
}

export interface ForecastDay {
  date: string;
  openingBalance: Minor;
  inflow: Minor;
  outflow: Minor;
  closingBalance: Minor;
  belowThreshold: boolean;
}

export interface ScenarioAdjustment {
  id: string;
  type: 'delay_collection' | 'defer_payment' | 'one_off_expense' | 'one_off_inflow' | 'change_collection_date' | 'min_cash_threshold';
  label: string;
  /** Days to shift, for delay/defer adjustments. */
  days?: number;
  /** Amount in minor units, for one-off adjustments. */
  amount?: Minor;
  /** ISO date, for one-off adjustments or a specific new collection date. */
  date?: string;
  /** Targets a specific receivable/payable; omit to apply to all of that kind. */
  targetId?: string;
}

export interface ForecastResult {
  asOfDate: string;
  horizonDays: number;
  openingCash: Minor;
  openingCashAvailable: boolean;
  minCashThreshold: Minor | null;
  scenarios: Record<Scenario, {
    days: ForecastDay[];
    closingBalance: Minor;
    lowestBalance: Minor;
    lowestBalanceDate: string;
    totalInflow: Minor;
    totalOutflow: Minor;
    shortfallDate: string | null;
    breachesThreshold: boolean;
  }>;
  drivers: ForecastDriver[];
  shortfallExplanation: {
    date: string;
    balance: Minor;
    contributors: { label: string; amount: Minor; direction: 'inflow' | 'outflow'; date: string }[];
  } | null;
  dataSufficiency: {
    score: number; // 0–100
    level: 'insufficient' | 'limited' | 'reasonable' | 'good';
    signals: { label: string; present: boolean; detail: string }[];
    unscheduled: {
      receivablesWithoutDueDate: Minor;
      receivablesWithoutDueDateCount: number;
      payablesWithoutDueDate: Minor;
      payablesWithoutDueDateCount: number;
    };
  };
  assumptions: string[];
  method: 'rule_based';
  appliedAdjustments: ScenarioAdjustment[];
}

/** Collection and payment probabilities applied per scenario. Documented, not learned. */
const SCENARIO_RULES: Record<Scenario, { collectionRate: number; overdueCollectionRate: number; collectionDelayDays: number; description: string }> = {
  best: {
    collectionRate: 1,
    overdueCollectionRate: 0.9,
    collectionDelayDays: 0,
    description: 'Customers pay on the due date and almost all overdue balances are recovered within the horizon.',
  },
  expected: {
    collectionRate: 0.9,
    overdueCollectionRate: 0.6,
    collectionDelayDays: 7,
    description: 'Collections run about a week late, nine in ten current invoices are collected, and a little over half of the overdue book is recovered.',
  },
  worst: {
    collectionRate: 0.75,
    overdueCollectionRate: 0.3,
    collectionDelayDays: 21,
    description: 'Collections run three weeks late, a quarter of current invoices slip past the horizon, and most of the overdue book is not recovered.',
  },
};

export async function computeForecast(
  companyId: string,
  asOfDate: string,
  horizonDays: number,
  options: { adjustments?: ScenarioAdjustment[]; minCashThreshold?: Minor | null; financialYearStart?: string | null } = {},
): Promise<ForecastResult> {
  const adjustments = options.adjustments ?? [];
  const horizonEnd = addDays(asOfDate, horizonDays);

  // ---- opening cash from the ledgers mapped to Cash and Bank ----
  const fyStart = options.financialYearStart ?? `${asOfDate.slice(0, 4)}-04-01`;
  const set = await loadBalances(companyId, { from: fyStart, to: asOfDate }, { financialYearId: null });
  const openingCash = sumSections(set.balances, 'BS', ['cash_and_bank']);
  const openingCashAvailable = set.balances.some((b) => b.section === 'cash_and_bank');

  // ---- threshold ----
  let minCashThreshold = options.minCashThreshold ?? null;
  if (minCashThreshold === null || minCashThreshold === undefined) {
    const row = await db('app_settings').where({ company_id: companyId, key: 'min_cash_threshold' }).first();
    if (row) {
      const parsed = readJson<{ amountMinor: number }>(row.value, { amountMinor: 0 });
      minCashThreshold = parsed.amountMinor ?? null;
    }
  }
  const thresholdOverride = adjustments.find((a) => a.type === 'min_cash_threshold');
  if (thresholdOverride?.amount !== undefined) minCashThreshold = thresholdOverride.amount;

  // ---- source records ----
  const receivables = await db('receivables').where({ company_id: companyId }).andWhere('outstanding_minor', '!=', 0);
  const payables = await db('payables').where({ company_id: companyId }).andWhere('outstanding_minor', '!=', 0);
  const recurring = await db('recurring_expenses').where({ company_id: companyId, is_active: true });
  const commitments = await db('commitments')
    .where({ company_id: companyId })
    .andWhere('expected_date', '>=', asOfDate)
    .andWhere('expected_date', '<=', horizonEnd);

  // Payables already carry the amounts a recurring definition would also produce.
  // Counting both would double the outflow, so a recurring instalment landing on a
  // date where a payable of the same vendor and amount exists is skipped.
  const payableFingerprints = new Set(
    payables.map((p: Record<string, any>) => `${(p.party_name ?? '').toLowerCase()}|${p.outstanding_minor}`),
  );

  const unscheduled = {
    receivablesWithoutDueDate: 0 as Minor,
    receivablesWithoutDueDateCount: 0,
    payablesWithoutDueDate: 0 as Minor,
    payablesWithoutDueDateCount: 0,
  };

  for (const r of receivables) {
    if (!r.due_date) {
      unscheduled.receivablesWithoutDueDate = add(unscheduled.receivablesWithoutDueDate, Number(r.outstanding_minor));
      unscheduled.receivablesWithoutDueDateCount++;
    }
  }
  for (const p of payables) {
    if (!p.due_date) {
      unscheduled.payablesWithoutDueDate = add(unscheduled.payablesWithoutDueDate, Number(p.outstanding_minor));
      unscheduled.payablesWithoutDueDateCount++;
    }
  }

  // ---- build the scenarios ----
  const scenarios = {} as ForecastResult['scenarios'];
  let expectedDrivers: ForecastDriver[] = [];

  for (const scenario of ['best', 'expected', 'worst'] as Scenario[]) {
    const drivers = buildDrivers({
      scenario,
      asOfDate,
      horizonEnd,
      receivables,
      payables,
      recurring,
      commitments,
      adjustments,
      payableFingerprints,
    });

    if (scenario === 'expected') expectedDrivers = drivers;

    const days = walk(openingCash, asOfDate, horizonDays, drivers, minCashThreshold);
    const lowest = days.reduce((min, d) => (d.closingBalance < min.closingBalance ? d : min), days[0]);
    const shortfall = days.find((d) => (minCashThreshold !== null ? d.closingBalance < minCashThreshold : d.closingBalance < 0));

    scenarios[scenario] = {
      days,
      closingBalance: days[days.length - 1]?.closingBalance ?? openingCash,
      lowestBalance: lowest?.closingBalance ?? openingCash,
      lowestBalanceDate: lowest?.date ?? asOfDate,
      totalInflow: days.reduce((acc, d) => add(acc, d.inflow), 0 as Minor),
      totalOutflow: days.reduce((acc, d) => add(acc, d.outflow), 0 as Minor),
      shortfallDate: shortfall?.date ?? null,
      breachesThreshold: Boolean(shortfall),
    };
  }

  // ---- explain the expected-case shortfall ----
  let shortfallExplanation: ForecastResult['shortfallExplanation'] = null;
  const expected = scenarios.expected;
  if (expected.shortfallDate) {
    const upTo = expected.shortfallDate;
    const contributors = expectedDrivers
      .filter((d) => d.date <= upTo && d.applied !== 0)
      .sort((a, b) => Math.abs(b.applied) - Math.abs(a.applied))
      .slice(0, 8)
      .map((d) => ({ label: d.label, amount: d.applied, direction: d.direction, date: d.date }));

    const dayAt = expected.days.find((d) => d.date === upTo);
    shortfallExplanation = {
      date: upTo,
      balance: dayAt?.closingBalance ?? 0,
      contributors,
    };
  }

  // ---- data sufficiency ----
  const signals = [
    {
      label: 'Cash and bank balance',
      present: openingCashAvailable,
      detail: openingCashAvailable
        ? 'A ledger is categorised as Cash and Bank, so the forecast starts from a real opening balance.'
        : 'No ledger is categorised as Cash and Bank. The forecast starts from zero, which makes every projected balance meaningless until that is fixed.',
    },
    {
      label: 'Receivables with due dates',
      present: receivables.length > 0 && unscheduled.receivablesWithoutDueDateCount < receivables.length,
      detail: receivables.length
        ? `${receivables.length - unscheduled.receivablesWithoutDueDateCount} of ${receivables.length} outstanding invoices carry a due date and can be placed on the timeline.`
        : 'No outstanding receivables have been imported, so no collections are projected.',
    },
    {
      label: 'Payables with due dates',
      present: payables.length > 0 && unscheduled.payablesWithoutDueDateCount < payables.length,
      detail: payables.length
        ? `${payables.length - unscheduled.payablesWithoutDueDateCount} of ${payables.length} outstanding bills carry a due date.`
        : 'No outstanding payables have been imported, so no supplier payments are projected.',
    },
    {
      label: 'Recurring expense schedule',
      present: recurring.length > 0,
      detail: recurring.length
        ? `${recurring.length} active recurring expense${recurring.length === 1 ? '' : 's'} feed scheduled outflows.`
        : 'No recurring expenses are defined, so rent, salaries and similar fixed outflows are missing from the projection.',
    },
    {
      label: 'Known commitments',
      present: commitments.length > 0,
      detail: commitments.length
        ? `${commitments.length} known commitment${commitments.length === 1 ? '' : 's'} fall inside the horizon.`
        : 'No one-off commitments have been recorded for this period.',
    },
  ];

  const score = Math.round((signals.filter((s) => s.present).length / signals.length) * 100);
  const level: ForecastResult['dataSufficiency']['level'] =
    score >= 80 ? 'good' : score >= 60 ? 'reasonable' : score >= 40 ? 'limited' : 'insufficient';

  const assumptions = [
    'This is a rule-based projection built from records already imported. It is not a statistical or machine-learned prediction, and it carries no forecast accuracy guarantee.',
    `Expected case: ${SCENARIO_RULES.expected.description}`,
    `Best case: ${SCENARIO_RULES.best.description}`,
    `Worst case: ${SCENARIO_RULES.worst.description}`,
    'Payables and recurring expenses are reconciled against each other so a scheduled instalment that already exists as an outstanding bill is not counted twice.',
    'Documents without a due date cannot be placed on a day and are excluded from the projection. Their totals are reported separately.',
    'No seasonality adjustment is applied. Doing so needs several years of history, which rule-based forecasting from a single import cannot supply.',
  ];

  return {
    asOfDate,
    horizonDays,
    openingCash,
    openingCashAvailable,
    minCashThreshold,
    scenarios,
    drivers: expectedDrivers,
    shortfallExplanation,
    dataSufficiency: { score, level, signals, unscheduled },
    assumptions,
    method: 'rule_based',
    appliedAdjustments: adjustments,
  };
}

interface BuildArgs {
  scenario: Scenario;
  asOfDate: string;
  horizonEnd: string;
  receivables: Record<string, any>[];
  payables: Record<string, any>[];
  recurring: Record<string, any>[];
  commitments: Record<string, any>[];
  adjustments: ScenarioAdjustment[];
  payableFingerprints: Set<string>;
}

function buildDrivers(args: BuildArgs): ForecastDriver[] {
  const rules = SCENARIO_RULES[args.scenario];
  const drivers: ForecastDriver[] = [];

  const delayAll = args.adjustments.filter((a) => a.type === 'delay_collection' && !a.targetId);
  const deferAll = args.adjustments.filter((a) => a.type === 'defer_payment' && !a.targetId);

  // ---- receivables ----
  for (const r of args.receivables) {
    if (!r.due_date) continue;

    const outstanding = Number(r.outstanding_minor);
    const isOverdue = r.due_date < args.asOfDate;

    let date = r.due_date as string;

    // An already-overdue invoice is projected from today plus the scenario delay,
    // not from a due date that has already passed.
    if (isOverdue) date = addDays(args.asOfDate, rules.collectionDelayDays);
    else date = addDays(date, rules.collectionDelayDays);

    const targeted = args.adjustments.find((a) => a.targetId === r.id);
    if (targeted?.type === 'change_collection_date' && targeted.date) date = targeted.date;
    else if (targeted?.type === 'delay_collection' && targeted.days) date = addDays(date, targeted.days);
    else {
      for (const a of delayAll) if (a.days) date = addDays(date, a.days);
    }

    if (date < args.asOfDate) date = args.asOfDate;
    if (date > args.horizonEnd) continue;

    const rate = isOverdue ? rules.overdueCollectionRate : rules.collectionRate;
    const applied = mulRatio(outstanding, rate);

    drivers.push({
      date,
      kind: 'receivable',
      label: `${r.party_name}${r.document_number ? ` — ${r.document_number}` : ''}`,
      reference: r.document_number ?? null,
      direction: 'inflow',
      amount: outstanding,
      applied,
      sourceId: r.id,
      note: isOverdue
        ? `Already ${daysBetween(r.due_date, args.asOfDate)} days overdue; ${Math.round(rate * 100)}% assumed recoverable in this scenario.`
        : `${Math.round(rate * 100)}% assumed collected, ${rules.collectionDelayDays} days after the due date.`,
    });
  }

  // ---- payables ----
  for (const p of args.payables) {
    if (!p.due_date) continue;

    let date = p.due_date as string;
    if (date < args.asOfDate) date = args.asOfDate; // overdue bills are assumed payable now

    const targeted = args.adjustments.find((a) => a.targetId === p.id);
    if (targeted?.type === 'defer_payment' && targeted.days) date = addDays(date, targeted.days);
    else {
      for (const a of deferAll) if (a.days) date = addDays(date, a.days);
    }

    if (date > args.horizonEnd) continue;

    const outstanding = Number(p.outstanding_minor);
    drivers.push({
      date,
      kind: 'payable',
      label: `${p.party_name}${p.document_number ? ` — ${p.document_number}` : ''}`,
      reference: p.document_number ?? null,
      direction: 'outflow',
      amount: outstanding,
      applied: outstanding,
      sourceId: p.id,
      note: p.due_date < args.asOfDate ? `Overdue since ${p.due_date}; assumed settled immediately.` : undefined,
    });
  }

  // ---- recurring expenses ----
  for (const rec of args.recurring) {
    const occurrences = expandRecurrence(
      rec.next_due_date ?? rec.start_date,
      rec.frequency,
      args.asOfDate,
      args.horizonEnd,
      rec.end_date ?? null,
    );
    const amount = Number(rec.amount_minor);
    const fingerprint = `${(rec.vendor ?? '').toLowerCase()}|${amount}`;

    for (const date of occurrences) {
      if (args.payableFingerprints.has(fingerprint)) {
        drivers.push({
          date,
          kind: 'recurring_expense',
          label: rec.name,
          reference: null,
          direction: 'outflow',
          amount,
          applied: 0,
          sourceId: rec.id,
          note: 'Excluded: an outstanding bill for the same vendor and amount is already in the projection, and counting both would overstate the outflow.',
        });
        continue;
      }

      drivers.push({
        date,
        kind: 'recurring_expense',
        label: rec.name,
        reference: null,
        direction: 'outflow',
        amount,
        applied: amount,
        sourceId: rec.id,
        note: rec.is_variable ? 'Amount varies between periods; the last known amount is used.' : undefined,
      });
    }
  }

  // ---- commitments ----
  for (const c of args.commitments) {
    const amount = Number(c.amount_minor);
    // A low-confidence inflow is discounted in the worst case; outflows never are.
    let applied = amount;
    if (c.direction === 'inflow') {
      const factor = args.scenario === 'worst' ? (c.confidence === 'high' ? 0.8 : c.confidence === 'medium' ? 0.5 : 0.2) : args.scenario === 'expected' ? (c.confidence === 'low' ? 0.6 : 1) : 1;
      applied = mulRatio(amount, factor);
    }

    drivers.push({
      date: c.expected_date,
      kind: 'commitment',
      label: c.name,
      reference: null,
      direction: c.direction,
      amount,
      applied,
      sourceId: c.id,
      note: c.confidence ? `Recorded confidence: ${c.confidence}.` : undefined,
    });
  }

  // ---- one-off what-if adjustments ----
  for (const a of args.adjustments) {
    if (a.type === 'one_off_expense' && a.amount && a.date) {
      drivers.push({
        date: a.date,
        kind: 'commitment',
        label: a.label || 'One-off expense (scenario)',
        reference: null,
        direction: 'outflow',
        amount: a.amount,
        applied: a.amount,
        sourceId: null,
        note: 'Added by a what-if scenario; not an imported record.',
      });
    }
    if (a.type === 'one_off_inflow' && a.amount && a.date) {
      drivers.push({
        date: a.date,
        kind: 'commitment',
        label: a.label || 'One-off inflow (scenario)',
        reference: null,
        direction: 'inflow',
        amount: a.amount,
        applied: a.amount,
        sourceId: null,
        note: 'Added by a what-if scenario; not an imported record.',
      });
    }
  }

  drivers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return drivers;
}

function expandRecurrence(
  startFrom: string,
  frequency: string,
  windowStart: string,
  windowEnd: string,
  endDate: string | null,
): string[] {
  const dates: string[] = [];
  let cursor = startFrom;
  let guard = 0;

  // Fast-forward to the window without iterating a day at a time.
  while (cursor < windowStart && guard++ < 500) {
    cursor = advance(cursor, frequency);
  }

  guard = 0;
  while (cursor <= windowEnd && guard++ < 500) {
    if (endDate && cursor > endDate) break;
    if (cursor >= windowStart) dates.push(cursor);
    cursor = advance(cursor, frequency);
  }

  return dates;
}

function advance(iso: string, frequency: string): string {
  switch (frequency) {
    case 'weekly':
      return addDays(iso, 7);
    case 'quarterly':
      return addMonths(iso, 3);
    case 'half_yearly':
      return addMonths(iso, 6);
    case 'yearly':
      return addMonths(iso, 12);
    case 'monthly':
    default:
      return addMonths(iso, 1);
  }
}

function walk(
  openingCash: Minor,
  asOfDate: string,
  horizonDays: number,
  drivers: ForecastDriver[],
  threshold: Minor | null,
): ForecastDay[] {
  const byDate = new Map<string, { inflow: Minor; outflow: Minor }>();
  for (const d of drivers) {
    if (d.applied === 0) continue;
    const entry = byDate.get(d.date) ?? { inflow: 0, outflow: 0 };
    if (d.direction === 'inflow') entry.inflow = add(entry.inflow, d.applied);
    else entry.outflow = add(entry.outflow, d.applied);
    byDate.set(d.date, entry);
  }

  const days: ForecastDay[] = [];
  let balance = openingCash;

  for (let i = 0; i <= horizonDays; i++) {
    const date = addDays(asOfDate, i);
    const movement = byDate.get(date) ?? { inflow: 0, outflow: 0 };
    const opening = balance;
    balance = sub(add(balance, movement.inflow), movement.outflow);

    days.push({
      date,
      openingBalance: opening,
      inflow: movement.inflow,
      outflow: movement.outflow,
      closingBalance: balance,
      belowThreshold: threshold !== null ? balance < threshold : balance < 0,
    });
  }

  return days;
}

/** Upcoming scheduled payments, used by the expense calendar. */
export async function upcomingPayments(companyId: string, fromDate: string, days: number) {
  const to = addDays(fromDate, days);

  const payables = await db('payables')
    .where({ company_id: companyId })
    .andWhere('outstanding_minor', '!=', 0)
    .whereNotNull('due_date')
    .andWhere('due_date', '<=', to)
    .orderBy('due_date');

  const recurring = await db('recurring_expenses').where({ company_id: companyId, is_active: true });

  const items: { date: string; label: string; amount: Minor; kind: string; overdue: boolean; sourceId: string }[] = [];

  for (const p of payables) {
    items.push({
      date: p.due_date,
      label: `${p.party_name}${p.document_number ? ` — ${p.document_number}` : ''}`,
      amount: Number(p.outstanding_minor),
      kind: 'Supplier bill',
      overdue: p.due_date < fromDate,
      sourceId: p.id,
    });
  }

  for (const r of recurring) {
    for (const date of expandRecurrence(r.next_due_date ?? r.start_date, r.frequency, fromDate, to, r.end_date ?? null)) {
      items.push({
        date,
        label: r.name,
        amount: Number(r.amount_minor),
        kind: r.is_variable ? 'Recurring (variable)' : 'Recurring',
        overdue: date < fromDate,
        sourceId: r.id,
      });
    }
  }

  items.sort((a, b) => (a.date < b.date ? -1 : 1));
  return items;
}
