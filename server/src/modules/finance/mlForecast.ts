/**
 * Learned cash-flow model.
 *
 * Replaces the fixed collection assumptions of the rule-based forecast with
 * behaviour learned from the company's own books. Three techniques, each chosen
 * because it works with the small histories a single Excel import provides:
 *
 *  1. SURVIVAL ANALYSIS (Kaplan–Meier, right-censored) of days-to-pay. Every
 *     invoice raised in the ledgers is an observation: paid invoices are events,
 *     unpaid ones are censored at their current age. Each customer's curve is
 *     shrunk towards the company-wide curve (empirical-Bayes style weighting), so a
 *     customer with two invoices borrows strength and one with fifty speaks for
 *     itself. Open invoices are then projected from the conditional distribution
 *     "given it is still unpaid at its current age".
 *  2. MONTE CARLO over a bootstrap of the fitted curves. This produces genuine
 *     percentile bands (P10 / P50 / P90 of the cash balance) in place of three
 *     hand-picked scenarios, and the bootstrap carries the uncertainty of fitting
 *     on a small history into the width of the band.
 *  3. SIMPLE EXPONENTIAL SMOOTHING for variable recurring costs (electricity,
 *     marketing…), with the smoothing constant chosen by minimising one-step-ahead
 *     error, and the residual spread feeding the simulation.
 *
 * It is validated before it is trusted: the model is re-fitted at earlier dates
 * and scored against what then actually happened, alongside the old rule-based
 * assumptions. If the rules were clearly more accurate, the caller keeps the rules.
 *
 * Pure TypeScript — no native modules — so it runs wherever the server does.
 */
import { db } from '../../db/index.js';
import { normalizeName } from '../../lib/ids.js';
import type { Minor } from '../../lib/money.js';
import type { ForecastDay, ForecastDriver, Scenario, ScenarioAdjustment } from './forecast.js';

/* ---------------------------------------------------------------- utilities */

const dn = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const iso = (n: number): string => new Date(n * 86400000).toISOString().slice(0, 10);

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG, so the same data always gives the same forecast. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function quantile(sortedAsc: Float64Array | number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/* ------------------------------------------------------- survival analysis */

/**
 * One observation is a slice of an invoice: the rupees settled on a given day
 * (an event) or the rupees still unpaid today (censored). Weighting by amount
 * means a 60% part-payment counts as 60% paid, not as "never paid".
 */
interface Obs {
  party: string;
  days: number;
  event: boolean;
  w: number;
}
interface Survival {
  times: number[];
  surv: number[];
}

function kaplanMeier(obs: { days: number; event: boolean; w: number }[]): Survival {
  const sorted = [...obs].sort((a, b) => a.days - b.days);
  let atRisk = sorted.reduce((s, o) => s + o.w, 0);
  const times: number[] = [];
  const surv: number[] = [];
  let s = 1;
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i].days;
    let d = 0;
    let c = 0;
    let j = i;
    while (j < sorted.length && sorted[j].days === t) {
      if (sorted[j].event) d += sorted[j].w;
      else c += sorted[j].w;
      j++;
    }
    if (d > 0 && atRisk > 0) {
      s *= 1 - d / atRisk;
      times.push(t);
      surv.push(s);
    }
    atRisk -= d + c;
    i = j;
  }
  return { times, surv };
}

/** S(t): probability a document is still unpaid after t days. */
function survAt(km: Survival, t: number): number {
  let lo = 0;
  let hi = km.times.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (km.times[mid] <= t) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return idx < 0 ? 1 : km.surv[idx];
}

const SHRINK_K = 6;

/** Per-party curve, shrunk towards everyone else's in proportion to how little data the party has. */
function makeProfiler(all: Obs[]) {
  const byParty = new Map<string, Obs[]>();
  for (const o of all) {
    const list = byParty.get(o.party) ?? [];
    list.push(o);
    byParty.set(o.party, list);
  }
  // Weights are rescaled so an average slice counts as 1, keeping the shrinkage
  // constant meaningful as "about K typical invoices of evidence".
  const meanW = all.length ? all.reduce((s, o) => s + o.w, 0) / all.length : 1;
  const nw = (o: Obs) => (meanW > 0 ? o.w / meanW : 1);
  const globalKm = kaplanMeier(all.map((o) => ({ days: o.days, event: o.event, w: nw(o) })));
  const cache = new Map<string, Survival>();

  return {
    global: globalKm,
    ownCount: (party: string) => byParty.get(party)?.length ?? 0,
    curve(party: string): Survival {
      const hit = cache.get(party);
      if (hit) return hit;
      const own = byParty.get(party) ?? [];
      let km: Survival;
      if (!own.length) km = globalKm;
      else {
        const lambda = SHRINK_K / (own.length + SHRINK_K);
        const mix: { days: number; event: boolean; w: number }[] = [];
        for (const o of all) mix.push({ days: o.days, event: o.event, w: nw(o) * (o.party === party ? 1 : lambda) });
        km = kaplanMeier(mix);
      }
      cache.set(party, km);
      return km;
    },
  };
}

/**
 * Cumulative probability, for each day t = 0..H after today, that a document of
 * the given age is paid by then — conditional on it being unpaid today.
 * Returns null when the document is older than anything in the history.
 */
function conditionalCdf(km: Survival, age: number, H: number, normaliseWithinSupport: boolean): Float64Array | null {
  const sA = survAt(km, age);
  if (sA <= 1e-9) return null;

  const cdf = new Float64Array(H + 1);
  for (let t = 1; t <= H; t++) cdf[t] = Math.min(1, (sA - survAt(km, age + t)) / sA);

  if (normaliseWithinSupport) {
    // Bills are paid eventually: treat all remaining observed mass as certain.
    const sEnd = km.surv.length ? km.surv[km.surv.length - 1] : 1;
    const support = (sA - Math.min(sA, sEnd)) / sA;
    if (support <= 1e-9) return null;
    for (let t = 1; t <= H; t++) cdf[t] = Math.min(1, cdf[t] / support);
  }
  return cdf;
}

/** P(paid exactly k days after being raised), for a brand-new document. */
function lagPmf(km: Survival, H: number, normalise: boolean): Float64Array {
  const p = new Float64Array(H + 1);
  let prev = 1;
  for (let k = 0; k <= H; k++) {
    const s = survAt(km, k);
    p[k] = prev - s;
    prev = s;
  }
  if (normalise) {
    const sEnd = km.surv.length ? km.surv[km.surv.length - 1] : 1;
    const support = 1 - sEnd;
    if (support > 1e-9) for (let k = 0; k <= H; k++) p[k] /= support;
    else {
      p.fill(0);
      p[Math.min(H, 30)] = 1;
    }
  }
  return p;
}

function sampleDay(cdf: Float64Array, u: number): number {
  const H = cdf.length - 1;
  if (u >= cdf[H]) return -1; // not paid inside the horizon
  let lo = 1;
  let hi = H;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] > u) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/* ------------------------------------------------------------ ledger history */

export interface PartyEvents {
  name: string;
  opening: number;
  invoices: { day: number; amount: number; ref: string | null }[];
  settlements: { day: number; amount: number; ref: string | null }[];
}

export interface Allocated {
  day: number | null;
  amount: number;
  remaining: number;
  settledDay: number | null;
  ref: string | null;
  opening: boolean;
  /** Each settlement applied to this invoice, in order. */
  payments: { day: number; amount: number }[];
}

const chunk = <T,>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

async function loadPartyHistory(
  companyId: string,
  asOfDay: number,
  kind: 'receivable' | 'payable',
  partyNames: string[],
): Promise<Map<string, PartyEvents>> {
  const groupWords = kind === 'receivable' ? ['debtor', 'receivable'] : ['creditor', 'payable'];
  const wanted = new Set(partyNames.map(normalizeName));

  const ledgers: Record<string, any>[] = await db('ledgers')
    .where({ company_id: companyId })
    .select('id', 'name', 'normalized_name', 'group_name', 'opening_balance_minor', 'opening_side');

  const chosen = ledgers.filter((l) => {
    const g = String(l.group_name ?? '').toLowerCase();
    return groupWords.some((w) => g.includes(w)) || wanted.has(l.normalized_name);
  });
  const result = new Map<string, PartyEvents>();
  if (!chosen.length) return result;

  const byId = new Map(chosen.map((l) => [l.id as string, l]));
  const openingRows: Record<string, any>[] = [];
  for (const ids of chunk([...byId.keys()], 400)) {
    openingRows.push(
      ...(await db('opening_balances').where({ company_id: companyId }).whereIn('ledger_id', ids).orderBy('created_at', 'asc')),
    );
  }
  const openingByLedger = new Map<string, number>();
  for (const o of openingRows) {
    if (openingByLedger.has(o.ledger_id)) continue;
    const natural = kind === 'receivable' ? 'debit' : 'credit';
    openingByLedger.set(o.ledger_id, o.side === natural ? Number(o.amount_minor) : 0);
  }

  for (const l of chosen) {
    let opening = openingByLedger.get(l.id);
    if (opening === undefined) {
      const natural = kind === 'receivable' ? 'debit' : 'credit';
      opening = l.opening_balance_minor != null && l.opening_side === natural ? Number(l.opening_balance_minor) : 0;
    }
    result.set(l.id, { name: l.normalized_name, opening, invoices: [], settlements: [] });
  }

  for (const ids of chunk([...byId.keys()], 400)) {
    const lines: Record<string, any>[] = await db('voucher_lines as vl')
      .join('vouchers as v', 'v.id', 'vl.voucher_id')
      .where('vl.company_id', companyId)
      .whereIn('vl.ledger_id', ids)
      .andWhere('v.voucher_date', '<=', iso(asOfDay))
      .select('vl.ledger_id', 'vl.debit_minor', 'vl.credit_minor', 'v.voucher_date', 'v.voucher_number', 'v.reference');

    for (const line of lines) {
      const ev = result.get(line.ledger_id);
      if (!ev) continue;
      const debit = Number(line.debit_minor);
      const credit = Number(line.credit_minor);
      const day = dn(line.voucher_date);
      const raised = kind === 'receivable' ? debit : credit; // invoice / bill
      const settled = kind === 'receivable' ? credit : debit; // receipt / payment
      if (raised > 0) ev.invoices.push({ day, amount: raised, ref: (line.reference ?? line.voucher_number ?? null) || null });
      if (settled > 0) ev.settlements.push({ day, amount: settled, ref: line.reference || null });
    }
  }
  return result;
}

/**
 * Allocates settlements to invoices — to the invoice they reference when one
 * matches, otherwise oldest first (standard FIFO), considering events up to `upTo`.
 */
export function allocate(ev: PartyEvents, upTo: number): Allocated[] {
  const queue: Allocated[] = [];
  if (ev.opening > 0) queue.push({ day: null, amount: ev.opening, remaining: ev.opening, settledDay: null, ref: null, opening: true, payments: [] });

  const items = [
    ...ev.invoices.filter((i) => i.day <= upTo).map((i) => ({ ...i, kind: 0 as const })),
    ...ev.settlements.filter((s) => s.day <= upTo).map((s) => ({ ...s, kind: 1 as const })),
  ].sort((a, b) => a.day - b.day || a.kind - b.kind);

  for (const it of items) {
    if (it.kind === 0) {
      queue.push({ day: it.day, amount: it.amount, remaining: it.amount, settledDay: null, ref: it.ref, opening: false, payments: [] });
      continue;
    }
    let left = it.amount;
    const apply = (q: Allocated) => {
      const take = Math.min(left, q.remaining);
      q.remaining -= take;
      left -= take;
      if (take > 0) q.payments.push({ day: it.day, amount: take });
      if (q.remaining === 0) q.settledDay = it.day;
    };
    if (it.ref) {
      const key = it.ref.toLowerCase();
      const match = queue.find((q) => q.remaining > 0 && q.ref && q.ref.toLowerCase() === key);
      if (match) apply(match);
    }
    for (const q of queue) {
      if (left <= 0) break;
      if (q.remaining > 0) apply(q);
    }
  }
  return queue;
}

function observations(history: Map<string, PartyEvents>, upTo: number): { obs: Obs[]; open: { party: string; remaining: number; age: number; day: number }[] } {
  const obs: Obs[] = [];
  const open: { party: string; remaining: number; age: number; day: number }[] = [];
  for (const ev of history.values()) {
    for (const a of allocate(ev, upTo)) {
      if (a.opening || a.day === null) continue;
      for (const p of a.payments) obs.push({ party: ev.name, days: Math.max(0, p.day - a.day), event: true, w: p.amount });
      if (a.remaining > 0) {
        const age = upTo - a.day;
        if (age >= 0) {
          obs.push({ party: ev.name, days: age, event: false, w: a.remaining });
          open.push({ party: ev.name, remaining: a.remaining, age, day: a.day });
        }
      }
    }
  }
  return { obs, open };
}

/* --------------------------------------------------- exponential smoothing */

export interface SmoothingFit {
  alpha: number;
  forecast: number;
  sd: number;
  points: number;
}

/** SES with alpha chosen to minimise one-step-ahead squared error. */
export function fitSmoothing(history: number[]): SmoothingFit | null {
  if (history.length < 4) return null;
  let best: { alpha: number; sse: number; level: number } | null = null;
  for (let a = 0.1; a <= 0.91; a += 0.1) {
    let level = history[0];
    let sse = 0;
    for (let t = 1; t < history.length; t++) {
      const err = history[t] - level;
      sse += err * err;
      level = a * history[t] + (1 - a) * level;
    }
    if (!best || sse < best.sse) best = { alpha: Math.round(a * 10) / 10, sse, level };
  }
  if (!best) return null;
  return { alpha: best.alpha, forecast: best.level, sd: Math.sqrt(best.sse / (history.length - 1)), points: history.length };
}

export interface SeriesFit {
  model: 'ses' | 'holt';
  alpha: number;
  points: number;
  sd: number;
  /** Mean forecast h months ahead (h ≥ 1). */
  at: (h: number) => number;
}

const PHI = 0.8;

/**
 * Monthly-series forecaster: simple exponential smoothing, or damped-trend Holt
 * when a trend clearly earns its extra parameters (≥6 months and ≥20% lower
 * one-step error). Parameters are chosen by grid search on one-step-ahead error.
 */
export function fitSeries(h: number[]): SeriesFit | null {
  if (h.length < 4) return null;
  const n = h.length;

  let bestSes: { a: number; sse: number; level: number } | null = null;
  for (let a = 0.1; a <= 0.91; a += 0.1) {
    let level = h[0];
    let sse = 0;
    for (let t = 1; t < n; t++) {
      const e = h[t] - level;
      sse += e * e;
      level = a * h[t] + (1 - a) * level;
    }
    if (!bestSes || sse < bestSes.sse) bestSes = { a, sse, level };
  }

  let bestHolt: { a: number; b: number; sse: number; level: number; trend: number } | null = null;
  if (n >= 6) {
    for (let a = 0.1; a <= 0.91; a += 0.2) {
      for (let b = 0.1; b <= 0.51; b += 0.2) {
        let level = h[0];
        let trend = h[1] - h[0];
        let sse = 0;
        for (let t = 1; t < n; t++) {
          const fc = level + PHI * trend;
          const e = h[t] - fc;
          sse += e * e;
          const nl = a * h[t] + (1 - a) * fc;
          trend = b * (nl - level) + (1 - b) * PHI * trend;
          level = nl;
        }
        if (!bestHolt || sse < bestHolt.sse) bestHolt = { a, b, sse, level, trend };
      }
    }
  }

  const ses = bestSes!;
  if (bestHolt && bestHolt.sse < ses.sse * 0.8) {
    const hl = bestHolt;
    return {
      model: 'holt',
      alpha: Math.round(hl.a * 10) / 10,
      points: n,
      sd: Math.sqrt(hl.sse / (n - 1)),
      at: (k) => {
        let damp = 0;
        for (let i = 1; i <= k; i++) damp += Math.pow(PHI, i);
        return Math.max(0, hl.level + hl.trend * damp);
      },
    };
  }
  return { model: 'ses', alpha: Math.round(ses.a * 10) / 10, points: n, sd: Math.sqrt(ses.sse / (n - 1)), at: () => Math.max(0, ses.level) };
}

/** Sum raised per complete calendar month before today (oldest first, at most 12). */
function monthlyRaised(history: Map<string, PartyEvents>, asOfDay: number): number[] {
  const byMonth = new Map<string, number>();
  let first = Infinity;
  for (const ev of history.values()) {
    for (const inv of ev.invoices) {
      if (inv.day > asOfDay) continue;
      first = Math.min(first, inv.day);
      const k = iso(inv.day).slice(0, 7);
      byMonth.set(k, (byMonth.get(k) ?? 0) + inv.amount);
    }
  }
  const current = iso(asOfDay).slice(0, 7);
  let keys = [...byMonth.keys()].filter((k) => k < current).sort();
  // A history that starts mid-month would understate its first month.
  if (Number.isFinite(first) && Number(iso(first).slice(8, 10)) > 7) keys = keys.filter((k) => k !== iso(first).slice(0, 7));
  return keys.slice(-12).map((k) => byMonth.get(k)!);
}

/** Expense categories no recurring definition already covers, with their monthly history. */
async function uncoveredCostHistory(
  companyId: string,
  recurring: Record<string, any>[],
  asOfDate: string,
): Promise<{ name: string; history: number[] }[]> {
  const rows: { expense_date: string; category: string | null; ledger_id: string | null; amount_minor: number }[] = await db('expenses')
    .where({ company_id: companyId })
    .andWhere('expense_date', '<', `${asOfDate.slice(0, 7)}-01`)
    .select('expense_date', 'category', 'ledger_id', 'amount_minor');

  const coveredCats = new Set(recurring.map((r) => String(r.category ?? '').toLowerCase()).filter(Boolean));
  const coveredLedgers = new Set(recurring.map((r) => r.ledger_id).filter(Boolean));
  const byCat = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const cat = r.category ?? 'Uncategorised';
    if (coveredCats.has(cat.toLowerCase()) || (r.ledger_id && coveredLedgers.has(r.ledger_id))) continue;
    const months = byCat.get(cat) ?? new Map<string, number>();
    months.set(r.expense_date.slice(0, 7), (months.get(r.expense_date.slice(0, 7)) ?? 0) + Number(r.amount_minor));
    byCat.set(cat, months);
  }
  // Months with no spend are zeros, not gaps: a quarterly bill is a third of a month's run-rate.
  const allKeys = rows.map((r) => r.expense_date.slice(0, 7)).sort();
  if (!allKeys.length) return [];
  const months: string[] = [];
  for (let [y, m] = allKeys[0].split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` < asOfDate.slice(0, 7); m === 12 ? ((m = 1), y++) : m++) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return [...byCat.entries()].map(([name, m]) => ({ name, history: months.slice(-12).map((k) => m.get(k) ?? 0) }));
}

async function variableExpenseModels(
  companyId: string,
  recurring: Record<string, any>[],
  asOfDate: string,
): Promise<Map<string, SmoothingFit & { name: string }>> {
  const out = new Map<string, SmoothingFit & { name: string }>();
  const monthKey = asOfDate.slice(0, 7);

  for (const rec of recurring) {
    if (!rec.is_variable || rec.frequency !== 'monthly') continue;
    let q = db('expenses').where({ company_id: companyId }).andWhere('expense_date', '<', `${monthKey}-01`);
    if (rec.ledger_id) q = q.andWhere('ledger_id', rec.ledger_id);
    else if (rec.category) q = q.whereRaw('LOWER(category) = ?', [String(rec.category).toLowerCase()]);
    else continue;

    const rows: { expense_date: string; amount_minor: number }[] = await q.select('expense_date', 'amount_minor');
    const byMonth = new Map<string, number>();
    for (const r of rows) byMonth.set(r.expense_date.slice(0, 7), (byMonth.get(r.expense_date.slice(0, 7)) ?? 0) + Number(r.amount_minor));
    const months = [...byMonth.keys()].sort().slice(-12);
    const fit = fitSmoothing(months.map((m) => byMonth.get(m)!));
    if (fit) out.set(rec.id, { ...fit, name: rec.name });
  }
  return out;
}

/* --------------------------------------------------------------- validation */

export interface ValidationWindow {
  cutoff: string;
  windowDays: number;
  openInvoices: number;
  learnedEvents: number;
  actualCollected: Minor;
  mlPredicted: Minor;
  rulePredicted: Minor;
  mlErrorPct: number | null;
  ruleErrorPct: number | null;
}

export interface Validation {
  windows: ValidationWindow[];
  mlMeanErrorPct: number | null;
  ruleMeanErrorPct: number | null;
  verdict: 'ml_better' | 'rules_better' | 'similar' | 'insufficient_history';
  detail: string;
}

const WINDOW = 30;
const RULE_TERMS = 30;

/** Re-fits at earlier dates and scores both approaches on what really happened next. */
function validate(history: Map<string, PartyEvents>, asOfDay: number): Validation {
  const windows: ValidationWindow[] = [];

  for (const back of [30, 60, 90]) {
    const cutoff = asOfDay - back;
    const end = Math.min(cutoff + WINDOW, asOfDay);
    const fit = observations(history, cutoff);
    const learned = fit.obs.filter((o) => o.event).length;
    if (learned < 8 || fit.open.length === 0) continue;

    const profiler = makeProfiler(fit.obs);
    const H = end - cutoff;

    let actual = 0;
    let ml = 0;
    let rule = 0;
    let count = 0;

    for (const [, ev] of history) {
      // Both lists hold the same invoices in the same order; the later one just has more appended.
      const atCut = allocate(ev, cutoff);
      const atEnd = allocate(ev, end);
      for (let i = 0; i < atCut.length; i++) {
        const a = atCut[i];
        if (a.opening || a.day === null || a.remaining <= 0) continue;
        actual += a.remaining - atEnd[i].remaining;
        count++;

        const age = cutoff - (a.day as number);
        const cdf = conditionalCdf(profiler.curve(ev.name), age, H, false);
        ml += cdf ? a.remaining * cdf[H] : 0;

        const due = (a.day as number) + RULE_TERMS;
        const payDay = due < cutoff ? cutoff + 7 : due + 7;
        const rate = due < cutoff ? 0.6 : 0.9;
        if (payDay <= end) rule += a.remaining * rate;
      }
    }

    const err = (pred: number) => (actual > 0 ? (Math.abs(pred - actual) / actual) * 100 : null);
    windows.push({
      cutoff: iso(cutoff),
      windowDays: H,
      openInvoices: count,
      learnedEvents: learned,
      actualCollected: Math.round(actual),
      mlPredicted: Math.round(ml),
      rulePredicted: Math.round(rule),
      mlErrorPct: err(ml),
      ruleErrorPct: err(rule),
    });
  }

  const scored = windows.filter((w) => w.mlErrorPct !== null && w.ruleErrorPct !== null);
  if (scored.length === 0) {
    return {
      windows,
      mlMeanErrorPct: null,
      ruleMeanErrorPct: null,
      verdict: 'insufficient_history',
      detail: 'Not enough earlier history to test the model against what actually happened, so it could not be compared with the fixed rules.',
    };
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const mlE = mean(scored.map((w) => w.mlErrorPct as number));
  const ruleE = mean(scored.map((w) => w.ruleErrorPct as number));
  const verdict: Validation['verdict'] = mlE < ruleE * 0.9 ? 'ml_better' : mlE > ruleE * 1.35 && scored.length >= 2 ? 'rules_better' : 'similar';

  return {
    windows,
    mlMeanErrorPct: Math.round(mlE * 10) / 10,
    ruleMeanErrorPct: Math.round(ruleE * 10) / 10,
    verdict,
    detail:
      `Re-fitted on data up to ${scored.length} earlier date${scored.length === 1 ? '' : 's'} and compared with the next ${WINDOW} days of real collections: ` +
      `the learned model was off by ${mlE.toFixed(0)}% on average, the fixed rules by ${ruleE.toFixed(0)}%.`,
  };
}

/* --------------------------------------------------------------- simulation */

export interface LearningSummary {
  method: 'survival_monte_carlo';
  simulations: number;
  bootstraps: number;
  receivables: {
    settledInvoicesLearned: number;
    openObservations: number;
    customersWithOwnHistory: number;
    medianDaysToPay: number | null;
    modelledInvoices: number;
    outsideHistory: number;
  };
  payables: { learned: boolean; settledBillsLearned: number; medianDaysToPay: number | null; modelledBills: number };
  variableExpenses: { name: string; monthlyForecast: Minor; spread: Minor; smoothing: number; months: number }[];
  projections: { label: string; direction: 'inflow' | 'outflow'; monthlyForecast: Minor; spread: Minor; model: 'ses' | 'holt'; months: number }[];
  shortfallProbability: number | null;
  validation: Validation;
}

export interface ScenarioSeries {
  days: ForecastDay[];
  closingBalance: Minor;
  lowestBalance: Minor;
  lowestBalanceDate: string;
  totalInflow: Minor;
  totalOutflow: Minor;
  shortfallDate: string | null;
  breachesThreshold: boolean;
}

export type MlOutcome =
  | { ready: false; reason: string; validation?: Validation }
  | { ready: true; scenarios: Record<Scenario, ScenarioSeries>; drivers: ForecastDriver[]; learning: LearningSummary };

export interface MlInput {
  companyId: string;
  asOfDate: string;
  horizonDays: number;
  openingCash: Minor;
  threshold: Minor | null;
  receivables: Record<string, any>[];
  payables: Record<string, any>[];
  recurring: Record<string, any>[];
  commitments: Record<string, any>[];
  /** Deterministic expected-case drivers: recurring, commitments, what-ifs and, as a fallback, payables. */
  baseDrivers: ForecastDriver[];
  adjustments: ScenarioAdjustment[];
  /** Supplied by tests; production reads the same data from the database. */
  preloaded?: {
    receivable: Map<string, PartyEvents>;
    payable: Map<string, PartyEvents>;
    variableModels: Map<string, SmoothingFit & { name: string }>;
    otherCosts?: { name: string; history: number[] }[];
  };
}

const MIN_EVENTS = 8;
const BOOTSTRAPS = 16;
const SIMS_PER_BOOT = 32;
const COMMITMENT_PROB: Record<string, number> = { high: 0.9, medium: 0.7, low: 0.4 };

export async function runMlForecast(input: MlInput): Promise<MlOutcome> {
  const { companyId, asOfDate, horizonDays: H, threshold } = input;
  const asOfDay = dn(asOfDate);

  const recHistory = input.preloaded?.receivable ?? (await loadPartyHistory(companyId, asOfDay, 'receivable', input.receivables.map((r) => r.party_name)));
  const recFit = observations(recHistory, asOfDay);
  const recEvents = recFit.obs.filter((o) => o.event).length;

  if (recEvents < MIN_EVENTS) {
    return {
      ready: false,
      reason: `Only ${recEvents} paid invoice${recEvents === 1 ? '' : 's'} could be found in the imported transactions; at least ${MIN_EVENTS} are needed to learn payment behaviour. Import vouchers (sales and receipts) to enable the learned model.`,
    };
  }

  const validation = validate(recHistory, asOfDay);
  if (validation.verdict === 'rules_better') {
    return { ready: false, reason: `${validation.detail} The fixed rules were clearly more accurate on this company's data, so they are used instead.`, validation };
  }

  const payHistory = input.preloaded?.payable ?? (await loadPartyHistory(companyId, asOfDay, 'payable', input.payables.map((p) => p.party_name)));
  const payFit = observations(payHistory, asOfDay);
  const payEvents = payFit.obs.filter((o) => o.event).length;
  const learnPayables = payEvents >= 5;

  const varModels = input.preloaded?.variableModels ?? (await variableExpenseModels(companyId, input.recurring, asOfDate));

  /* --------------------- run-rate streams: what has not been invoiced yet */
  interface Stream {
    kind: 'projected_sales' | 'projected_purchases' | 'projected_costs';
    label: string;
    direction: 'inflow' | 'outflow';
    fit: SeriesFit;
    lag: 'receivable' | 'payable' | null;
  }
  const streams: Stream[] = [];
  const salesFit = fitSeries(monthlyRaised(recHistory, asOfDay));
  if (salesFit && salesFit.at(1) > 0) streams.push({ kind: 'projected_sales', label: 'New sales not yet invoiced', direction: 'inflow', fit: salesFit, lag: 'receivable' });
  const purchaseFit = learnPayables ? fitSeries(monthlyRaised(payHistory, asOfDay)) : null;
  if (purchaseFit && purchaseFit.at(1) > 0) streams.push({ kind: 'projected_purchases', label: 'New supplier bills not yet received', direction: 'outflow', fit: purchaseFit, lag: 'payable' });
  const otherCosts = input.preloaded?.otherCosts ?? (await uncoveredCostHistory(companyId, input.recurring, asOfDate));
  for (const c of otherCosts) {
    const fit = fitSeries(c.history);
    if (fit && fit.at(1) > 0) streams.push({ kind: 'projected_costs', label: `${c.name} (run-rate)`, direction: 'outflow', fit, lag: null });
  }
  const MONTHS = Math.ceil(H / 30) + 1;
  const DAYS_PER_MONTH = 30.4;

  /* ------------------------------------------------------- open documents */
  const median = (xs: number[], d: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : d;
  };
  const termsOf = (rows: Record<string, any>[]) =>
    median(rows.filter((r) => r.document_date && r.due_date).map((r) => dn(r.due_date) - dn(r.document_date)), 30);
  const recTerms = termsOf(input.receivables);
  const payTerms = termsOf(input.payables);

  interface Doc {
    id: string;
    party: string;
    label: string;
    reference: string | null;
    outstanding: number;
    age: number;
    due: string | null;
  }
  const toDocs = (rows: Record<string, any>[], terms: number): Doc[] => {
    const docs: Doc[] = [];
    for (const r of rows) {
      const day = r.document_date ? dn(r.document_date) : r.due_date ? dn(r.due_date) - terms : null;
      if (day === null) continue; // cannot be placed: reported as unscheduled by the caller
      docs.push({
        id: r.id,
        party: normalizeName(r.party_name ?? ''),
        label: `${r.party_name}${r.document_number ? ` — ${r.document_number}` : ''}`,
        reference: r.document_number ?? null,
        outstanding: Number(r.outstanding_minor),
        age: Math.max(0, asOfDay - day),
        due: r.due_date ?? null,
      });
    }
    return docs;
  };
  const recDocs = toDocs(input.receivables, recTerms);
  const payDocs = learnPayables ? toDocs(input.payables, payTerms) : [];
  const learnedPayableIds = new Set(payDocs.map((d) => d.id));

  /* ------------------------------------------------ what-if adjustments */
  const delayAll = input.adjustments.filter((a) => a.type === 'delay_collection' && !a.targetId).reduce((s, a) => s + (a.days ?? 0), 0);
  const deferAll = input.adjustments.filter((a) => a.type === 'defer_payment' && !a.targetId).reduce((s, a) => s + (a.days ?? 0), 0);
  const shiftFor = (id: string, kind: 'delay_collection' | 'defer_payment', all: number) => {
    const t = input.adjustments.find((a) => a.targetId === id && a.type === kind);
    return t?.days ?? all;
  };
  const fixedDateFor = (id: string) => input.adjustments.find((a) => a.targetId === id && a.type === 'change_collection_date')?.date ?? null;

  /* ----------------------------------------------- deterministic / random base */
  const commitmentById = new Map(input.commitments.map((c) => [c.id as string, c]));
  const detIn = new Float64Array(H + 1);
  const detOut = new Float64Array(H + 1);
  const randomVar: { day: number; mean: number; sd: number }[] = [];
  const randomInflow: { day: number; amount: number; p: number }[] = [];
  const fixedAddDay = (iso_: string) => Math.min(H, Math.max(0, dn(iso_) - asOfDay));

  for (const d of input.baseDrivers) {
    if (d.kind === 'receivable') continue;
    if (d.kind === 'payable' && learnedPayableIds.size && learnedPayableIds.has(d.sourceId ?? '')) continue;
    if (d.applied === 0 && d.kind !== 'commitment') continue;
    const day = fixedAddDay(d.date);
    if (dn(d.date) - asOfDay > H) continue;

    if (d.kind === 'recurring_expense' && d.sourceId && varModels.has(d.sourceId)) {
      const m = varModels.get(d.sourceId)!;
      randomVar.push({ day, mean: m.forecast, sd: m.sd });
    } else if (d.kind === 'commitment' && d.direction === 'inflow' && d.sourceId && commitmentById.has(d.sourceId)) {
      const c = commitmentById.get(d.sourceId)!;
      randomInflow.push({ day, amount: Number(c.amount_minor), p: COMMITMENT_PROB[c.confidence ?? ''] ?? 0.7 });
    } else if (d.direction === 'inflow') detIn[day] += d.applied;
    else detOut[day] += d.applied;
  }

  /* ------------------------------------------------------------ simulate */
  const rng = mulberry32(hashSeed(`${companyId}|${asOfDate}|${H}`));
  const sims = BOOTSTRAPS * SIMS_PER_BOOT;
  const inflow = new Float64Array(sims * (H + 1));
  const outflow = new Float64Array(sims * (H + 1));
  const stride = H + 1;

  for (let s = 0; s < sims; s++) {
    inflow.set(detIn, s * stride);
    outflow.set(detOut, s * stride);
  }

  let outsideHistory = 0;

  for (let b = 0; b < BOOTSTRAPS; b++) {
    const bootRec = recFit.obs.map(() => recFit.obs[Math.floor(rng() * recFit.obs.length)]);
    const recProfiler = makeProfiler(bootRec);
    const bootPay = payFit.obs.length ? payFit.obs.map(() => payFit.obs[Math.floor(rng() * payFit.obs.length)]) : [];
    const payProfiler = learnPayables ? makeProfiler(bootPay) : null;

    const recLag = lagPmf(recProfiler.global, H, false);
    const payLag = payProfiler ? lagPmf(payProfiler.global, H, true) : null;
    const recCdfs = recDocs.map((d) => ({ d, cdf: conditionalCdf(recProfiler.curve(d.party), d.age, H, false) }));
    const payCdfs = payProfiler ? payDocs.map((d) => ({ d, cdf: conditionalCdf(payProfiler.curve(d.party), d.age, H, true) })) : [];
    if (b === 0) outsideHistory = recCdfs.filter((x) => !x.cdf).length;

    for (let k = 0; k < SIMS_PER_BOOT; k++) {
      const base = (b * SIMS_PER_BOOT + k) * stride;

      for (const { d, cdf } of recCdfs) {
        if (!cdf) continue;
        let day = sampleDay(cdf, rng());
        if (day < 0) continue;
        const fixed = fixedDateFor(d.id);
        if (fixed) day = Math.max(1, Math.min(H, dn(fixed) - asOfDay));
        else day += shiftFor(d.id, 'delay_collection', delayAll);
        if (day <= H) inflow[base + Math.max(0, day)] += d.outstanding;
      }
      for (const { d, cdf } of payCdfs) {
        let day = cdf ? sampleDay(cdf, rng()) : 1;
        if (day < 0) continue;
        day += shiftFor(d.id, 'defer_payment', deferAll);
        if (day <= H) outflow[base + Math.max(0, day)] += d.outstanding;
      }
      for (const v of randomVar) outflow[base + v.day] += Math.max(0, v.mean + normal(rng) * v.sd);
      for (const c of randomInflow) if (rng() < c.p) inflow[base + c.day] += c.amount;

      for (const st of streams) {
        const lag = st.lag === 'receivable' ? recLag : st.lag === 'payable' ? payLag : null;
        if (st.lag && !lag) continue;
        const target = st.direction === 'inflow' ? inflow : outflow;
        const levels: number[] = [];
        for (let m = 0; m < MONTHS; m++) levels.push(Math.max(0, st.fit.at(m + 1) + normal(rng) * st.fit.sd));
        for (let d = 1; d <= H; d++) {
          const amt = levels[Math.floor((d - 1) / 30)] / DAYS_PER_MONTH;
          if (amt <= 0) continue;
          if (lag) for (let j = 0; d + j <= H; j++) target[base + d + j] += amt * lag[j];
          else target[base + d] += amt;
        }
      }
    }
  }

  /* ------------------------------------------------------------ aggregate */
  const closing: Float64Array[] = [];
  const mins = new Float64Array(sims);
  const meanIn = new Float64Array(H + 1);
  const meanOut = new Float64Array(H + 1);
  const dayCols: Float64Array[] = Array.from({ length: H + 1 }, () => new Float64Array(sims));

  for (let s = 0; s < sims; s++) {
    let bal = input.openingCash;
    let min = Infinity;
    for (let d = 0; d <= H; d++) {
      const i = inflow[s * stride + d];
      const o = outflow[s * stride + d];
      meanIn[d] += i / sims;
      meanOut[d] += o / sims;
      bal += i - o;
      dayCols[d][s] = bal;
      if (bal < min) min = bal;
    }
    mins[s] = min;
  }
  for (let d = 0; d <= H; d++) {
    dayCols[d].sort();
    closing.push(dayCols[d]);
  }

  const limit = threshold ?? 0;
  const shortfallProbability = mins.reduce((c, m) => c + (m < limit ? 1 : 0), 0) / sims;

  const build = (q: number): ScenarioSeries => {
    const days: ForecastDay[] = [];
    let prev = input.openingCash;
    let tin = 0;
    let tout = 0;
    for (let d = 0; d <= H; d++) {
      const close = Math.round(quantile(closing[d], q));
      const net = close - prev;
      const inf = Math.max(0, Math.round(net + meanOut[d]));
      const outf = inf - net;
      tin += inf;
      tout += outf;
      days.push({ date: iso(asOfDay + d), openingBalance: prev, inflow: inf, outflow: outf, closingBalance: close, belowThreshold: close < limit });
      prev = close;
    }
    const lowest = days.reduce((m, x) => (x.closingBalance < m.closingBalance ? x : m), days[0]);
    const short = days.find((x) => x.closingBalance < limit);
    return {
      days,
      closingBalance: days[days.length - 1].closingBalance,
      lowestBalance: lowest.closingBalance,
      lowestBalanceDate: lowest.date,
      totalInflow: tin,
      totalOutflow: tout,
      shortfallDate: short?.date ?? null,
      breachesThreshold: Boolean(short),
    };
  };

  /* ------------------------------------------------ explained drivers */
  const fullRec = makeProfiler(recFit.obs);
  const fullPay = learnPayables ? makeProfiler(payFit.obs) : null;
  const drivers: ForecastDriver[] = input.baseDrivers.filter(
    (d) => d.kind !== 'receivable' && !(d.kind === 'payable' && learnedPayableIds.has(d.sourceId ?? '')),
  );

  const medianPay = (km: Survival): number | null => {
    const i = km.surv.findIndex((s) => s <= 0.5);
    return i >= 0 ? km.times[i] : null;
  };

  for (const d of recDocs) {
    const km = fullRec.curve(d.party);
    const cdf = conditionalCdf(km, d.age, H, false);
    const own = fullRec.ownCount(d.party);
    if (!cdf) {
      drivers.push({ date: asOfDate, kind: 'receivable', label: d.label, reference: d.reference, direction: 'inflow', amount: d.outstanding, applied: 0, sourceId: d.id,
        note: `Unpaid for ${d.age} days — longer than any invoice in the history, so no collection is expected inside the horizon.` });
      continue;
    }
    const p = cdf[H];
    if (p < 0.01) {
      drivers.push({ date: asOfDate, kind: 'receivable', label: d.label, reference: d.reference, direction: 'inflow', amount: d.outstanding, applied: 0, sourceId: d.id,
        note: `Unpaid for ${d.age} days. Nothing in the history suggests it will be paid within ${H} days, so no collection is counted. Chase it or write it off.` });
      continue;
    }
    let day = 0;
    for (let t = 1; t <= H; t++) if (cdf[t] >= p / 2) { day = t; break; }
    drivers.push({
      date: iso(asOfDay + day),
      kind: 'receivable',
      label: d.label,
      reference: d.reference,
      direction: 'inflow',
      amount: d.outstanding,
      applied: Math.round(d.outstanding * p),
      sourceId: d.id,
      note: `Learned from ${own ? `${own} past invoice${own === 1 ? '' : 's'} of this customer, blended with the company average` : 'the company average (no history for this customer)'}: ${Math.round(p * 100)}% likely to be paid within ${H} days, most likely around day ${day}.`,
    });
  }
  if (fullPay) {
    for (const d of payDocs) {
      const cdf = conditionalCdf(fullPay.curve(d.party), d.age, H, true);
      let day = 1;
      if (cdf) for (let t = 1; t <= H; t++) if (cdf[t] >= Math.min(0.5, cdf[H])) { day = t; break; }
      if (day + shiftFor(d.id, 'defer_payment', deferAll) > H) continue;
      drivers.push({
        date: iso(asOfDay + day + shiftFor(d.id, 'defer_payment', deferAll)),
        kind: 'payable',
        label: d.label,
        reference: d.reference,
        direction: 'outflow',
        amount: d.outstanding,
        applied: d.outstanding,
        sourceId: d.id,
        note: 'Payment date learned from how this supplier has been paid in the past.',
      });
    }
  }
  // One expected-value line per 30-day block for each run-rate stream.
  const recLagFull = lagPmf(fullRec.global, H, false);
  const payLagFull = fullPay ? lagPmf(fullPay.global, H, true) : null;
  for (const st of streams) {
    const lag = st.lag === 'receivable' ? recLagFull : st.lag === 'payable' ? payLagFull : null;
    for (let m = 0; m * 30 < H; m++) {
      let expected = 0;
      for (let d = m * 30 + 1; d <= Math.min(H, (m + 1) * 30); d++) {
        const amt = st.fit.at(m + 1) / DAYS_PER_MONTH;
        if (lag) for (let j = 0; d + j <= H; j++) expected += amt * lag[j];
        else expected += amt;
      }
      if (expected < 1) continue;
      drivers.push({
        date: iso(asOfDay + Math.min(H, m * 30 + 15)),
        kind: st.kind,
        label: `${st.label} — days ${m * 30 + 1}–${Math.min(H, (m + 1) * 30)}`,
        reference: null,
        direction: st.direction,
        amount: Math.round(expected),
        applied: Math.round(expected),
        sourceId: null,
        note: `Statistical run-rate of about ${Math.round(st.fit.at(m + 1)).toLocaleString('en-IN')} a month (${st.fit.model === 'holt' ? 'damped trend' : 'exponential smoothing'} over ${st.fit.points} months)${st.lag ? '; timing of cash follows how documents have actually been settled' : ''}. This is an estimate, not an imported record.`,
      });
    }
  }
  drivers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    ready: true,
    scenarios: { best: build(0.9), expected: build(0.5), worst: build(0.1) },
    drivers,
    learning: {
      method: 'survival_monte_carlo',
      simulations: sims,
      bootstraps: BOOTSTRAPS,
      receivables: {
        settledInvoicesLearned: recEvents,
        openObservations: recFit.obs.length - recEvents,
        customersWithOwnHistory: new Set(recFit.obs.map((o) => o.party)).size,
        medianDaysToPay: medianPay(fullRec.global),
        modelledInvoices: recDocs.length,
        outsideHistory,
      },
      payables: {
        learned: learnPayables,
        settledBillsLearned: payEvents,
        medianDaysToPay: fullPay ? medianPay(fullPay.global) : null,
        modelledBills: payDocs.length,
      },
      variableExpenses: [...varModels.values()].map((m) => ({
        name: m.name,
        monthlyForecast: Math.round(m.forecast),
        spread: Math.round(m.sd),
        smoothing: m.alpha,
        months: m.points,
      })),
      projections: streams.map((s) => ({
        label: s.label,
        direction: s.direction,
        monthlyForecast: Math.round(s.fit.at(1)),
        spread: Math.round(s.fit.sd),
        model: s.fit.model,
        months: s.fit.points,
      })),
      shortfallProbability: Math.round(shortfallProbability * 1000) / 10,
      validation,
    },
  };
}
