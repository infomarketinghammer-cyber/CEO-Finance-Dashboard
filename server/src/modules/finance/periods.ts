import { db } from '../../db/index.js';
import { addDays, addMonths, endOfMonth, startOfMonth, daysBetween } from '../../lib/dates.js';
import { badRequest } from '../../lib/errors.js';
import type { PeriodRef } from './engine.js';

export type PeriodType = 'month' | 'quarter' | 'year' | 'financial_year' | 'custom';

export interface ResolvedPeriod {
  period: PeriodRef;
  type: PeriodType;
  financialYearId: string | null;
  financialYearStart: string | null;
  financialYearEnd: string | null;
  /** The immediately preceding period of the same length. */
  previousPeriod: PeriodRef;
  /** The same period one year earlier. */
  samePeriodLastYear: PeriodRef;
}

export interface PeriodQuery {
  companyId: string;
  financialYearId?: string | null;
  periodType?: string;
  from?: string;
  to?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turns the company, financial year and period selectors into concrete dates, plus
 * the two comparison windows. Every statement endpoint resolves its period here so
 * the dashboard, the Profit & Loss and an export of the same view cannot drift
 * apart on dates.
 */
export async function resolvePeriod(q: PeriodQuery): Promise<ResolvedPeriod> {
  let fy = null as Record<string, any> | null;

  if (q.financialYearId) {
    fy = await db('financial_years').where({ id: q.financialYearId, company_id: q.companyId }).first();
    if (!fy) throw badRequest('The selected financial year does not belong to this company.');
  } else {
    fy = (await db('financial_years').where({ company_id: q.companyId }).orderBy('start_date', 'desc').first()) ?? null;
  }

  const type = (q.periodType as PeriodType) ?? 'financial_year';

  let from: string;
  let to: string;

  if (type === 'custom') {
    if (!q.from || !q.to || !ISO.test(q.from) || !ISO.test(q.to)) {
      throw badRequest('A custom period needs a start and end date in the format YYYY-MM-DD.');
    }
    if (q.to < q.from) throw badRequest('The period end date falls before its start date.');
    from = q.from;
    to = q.to;
  } else if (type === 'month') {
    const anchor = q.to && ISO.test(q.to) ? q.to : fy?.end_date ?? new Date().toISOString().slice(0, 10);
    from = startOfMonth(anchor);
    to = endOfMonth(anchor);
  } else if (type === 'quarter') {
    const anchor = q.to && ISO.test(q.to) ? q.to : fy?.end_date ?? new Date().toISOString().slice(0, 10);
    const month = Number(anchor.slice(5, 7));
    // Quarters follow the financial year where one exists, otherwise the calendar.
    const fyStartMonth = fy ? Number(fy.start_date.slice(5, 7)) : 1;
    const offset = (((month - fyStartMonth) % 12) + 12) % 12;
    const quarterIndex = Math.floor(offset / 3);
    const qStartMonthOffset = quarterIndex * 3;
    const base = fy ? fy.start_date : `${anchor.slice(0, 4)}-01-01`;
    from = startOfMonth(addMonths(base, qStartMonthOffset));
    to = endOfMonth(addMonths(from, 2));
  } else if (type === 'year') {
    const year = (q.to ?? fy?.end_date ?? new Date().toISOString().slice(0, 10)).slice(0, 4);
    from = `${year}-01-01`;
    to = `${year}-12-31`;
  } else {
    if (!fy) {
      // No financial year defined yet — fall back to the Indian April-to-March year
      // containing today, and let the caller surface that there is no data.
      const now = new Date();
      const startYear = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
      from = `${startYear}-04-01`;
      to = `${startYear + 1}-03-31`;
    } else {
      from = fy.start_date;
      to = fy.end_date;
    }
  }

  const lengthDays = daysBetween(from, to);

  return {
    period: { from, to, label: describePeriod(type, from, to, fy?.label) },
    type,
    financialYearId: fy?.id ?? null,
    financialYearStart: fy?.start_date ?? null,
    financialYearEnd: fy?.end_date ?? null,
    previousPeriod: {
      from: addDays(from, -(lengthDays + 1)),
      to: addDays(from, -1),
      label: 'Previous period',
    },
    samePeriodLastYear: {
      from: addMonths(from, -12),
      to: addMonths(to, -12),
      label: 'Same period last year',
    },
  };
}

function describePeriod(type: PeriodType, from: string, to: string, fyLabel?: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (iso: string) => `${iso.slice(8, 10)} ${months[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

  switch (type) {
    case 'month':
      return `${months[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
    case 'quarter':
      return `${fmt(from)} to ${fmt(to)}`;
    case 'year':
      return from.slice(0, 4);
    case 'financial_year':
      return fyLabel ?? `${fmt(from)} to ${fmt(to)}`;
    default:
      return `${fmt(from)} to ${fmt(to)}`;
  }
}

/** Monthly buckets across a period, for trend charts. */
export function monthlyBuckets(period: PeriodRef): { key: string; label: string; from: string; to: string }[] {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const buckets: { key: string; label: string; from: string; to: string }[] = [];
  let cursor = startOfMonth(period.from);
  let guard = 0;

  while (cursor <= period.to && guard++ < 120) {
    const end = endOfMonth(cursor);
    buckets.push({
      key: cursor.slice(0, 7),
      label: `${months[Number(cursor.slice(5, 7)) - 1]} ${cursor.slice(2, 4)}`,
      from: cursor < period.from ? period.from : cursor,
      to: end > period.to ? period.to : end,
    });
    cursor = addMonths(cursor, 1);
  }

  return buckets;
}
