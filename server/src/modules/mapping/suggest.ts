import { SYSTEM_CATEGORIES, type CategoryDef } from './categories.js';

export interface MappingSuggestionResult {
  categoryKey: string | null;
  confidence: number;
  reason: string;
}

/**
 * Suggests a standard category for a ledger.
 *
 * The group name is weighted far above the ledger name because it is the
 * classification the bookkeeper already made: "Sundry Debtors" is decisive, while
 * a ledger called "Acme Traders" tells you nothing on its own. A suggestion is
 * always recorded as unconfirmed — §9 forbids silently filing an uncertain account
 * under an arbitrary category, so a weak match produces no suggestion at all and
 * the ledger shows up in the unmapped list for a human to decide.
 */
/**
 * Groups that classify loosely rather than precisely.
 *
 * "Sundry Debtors" names exactly one category and should win outright. "Indirect
 * Expenses" is a catch-all that holds salaries, rent, interest and depreciation
 * alike, so it is capped below a strong name match — otherwise every interest and
 * depreciation ledger in a Tally chart lands in Operating Expenses and EBITDA,
 * EBIT and interest coverage all become wrong.
 */
const BROAD_GROUP_HINTS = new Set([
  'indirect expense',
  'indirect expenses',
  'direct expense',
  'direct expenses',
  'current asset',
  'current assets',
  'current liabilit',
  'administrative expenses',
  'selling',
  'provisions',
]);

const BROAD_GROUP_CEILING = 0.72;

export function suggestCategoryForLedger(
  ledgerName: string,
  groupName: string | null | undefined,
  availableCategories: { key: string }[] = SYSTEM_CATEGORIES,
): MappingSuggestionResult {
  const available = new Set(availableCategories.map((c) => c.key));
  const name = ledgerName.toLowerCase().trim();
  const group = (groupName ?? '').toLowerCase().trim();

  let best: { def: CategoryDef; score: number; reason: string } | null = null;

  for (const def of SYSTEM_CATEGORIES) {
    if (!available.has(def.key)) continue;

    let score = 0;
    let reason = '';

    // --- group evidence ---
    for (const hint of def.groupHints) {
      if (!group) break;
      const broad = BROAD_GROUP_HINTS.has(hint);

      if (group === hint) {
        const s = broad ? BROAD_GROUP_CEILING : 0.97;
        if (s > score) {
          score = s;
          reason = broad
            ? `The ledger group "${groupName}" is a broad category that usually means ${def.label}`
            : `The ledger group "${groupName}" maps directly to ${def.label}`;
        }
      } else if (group.includes(hint)) {
        const coverage = hint.length / group.length;
        const s = broad ? Math.min(BROAD_GROUP_CEILING, 0.68 + coverage * 0.04) : 0.8 + coverage * 0.14;
        if (s > score) {
          score = s;
          reason = `The ledger group "${groupName}" indicates ${def.label}`;
        }
      }
    }

    // --- name evidence ---
    for (const hint of def.nameHints) {
      if (name === hint) {
        const s = 0.92;
        if (s > score) {
          score = s;
          reason = `The ledger name matches "${hint}" exactly`;
        }
      } else if (name.includes(hint)) {
        // Weighted by how much of the name the hint explains, so "Bank Charges"
        // is not classified as Cash and Bank on the strength of "bank". A hint at
        // the START of the name is the ledger's subject rather than a qualifier,
        // so it counts for more: "Interest on Term Loan" is interest, while
        // "Term Loan - HDFC" is a loan.
        const coverage = hint.length / name.length;
        const prefixBonus = name.startsWith(hint) ? 0.08 : 0;
        const s = 0.62 + coverage * 0.26 + prefixBonus;
        if (s > score) {
          score = s;
          reason = `The ledger name ${prefixBonus ? 'begins with' : 'contains'} "${hint}"`;
        }
      }
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { def, score, reason };
    }
  }

  // Below this, a guess would be noise. The ledger is left unmapped on purpose.
  const THRESHOLD = 0.6;

  if (!best || best.score < THRESHOLD) {
    return {
      categoryKey: null,
      confidence: 0,
      reason: groupName
        ? `Neither the ledger name nor the group "${groupName}" matched a standard category. Choose one so this balance is included in reports.`
        : 'No ledger group was supplied and the name did not match a standard category. Choose one so this balance is included in reports.',
    };
  }

  return {
    categoryKey: best.def.key,
    confidence: Math.round(best.score * 100) / 100,
    reason: best.reason,
  };
}

/** Explains the difference a mapping makes, for the impact panel in the UI. */
export function describeImpact(categoryKey: string): string {
  const def = SYSTEM_CATEGORIES.find((c) => c.key === categoryKey);
  if (!def) return 'This category is defined by your organisation.';
  return def.statement === 'PL'
    ? `Balances here appear in the Profit & Loss under ${def.label}.`
    : `Balances here appear on the Balance Sheet under ${def.label}.`;
}
