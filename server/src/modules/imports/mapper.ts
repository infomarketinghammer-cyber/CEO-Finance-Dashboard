import { getCategory, normalizeHeader, type CategoryDef, type FieldDef } from './categories.js';
import type { ColumnProfile } from './workbook.js';
import { sha256 } from '../../lib/ids.js';

export interface MappingSuggestion {
  fieldKey: string;
  header: string | null;
  confidence: number; // 0–1
  reason: string;
  /** Alternatives the user can pick from without hunting through every column. */
  alternatives: { header: string; confidence: number; reason: string }[];
  warning?: string;
}

export interface ColumnMapping {
  /** fieldKey → workbook header. A field absent from the map is not imported. */
  [fieldKey: string]: string | null;
}

/**
 * Scores one header against one field.
 *
 * Exact alias matches win outright. Everything softer is scored so the user sees a
 * ranked list rather than a single take-it-or-leave-it guess, because a wrong
 * mapping accepted silently is how a Debit column ends up in Credit.
 */
function scoreHeaderForField(header: string, field: FieldDef, column?: ColumnProfile): { score: number; reason: string } {
  const h = normalizeHeader(header);
  if (!h) return { score: 0, reason: 'Empty heading' };

  const key = normalizeHeader(field.key);
  const label = normalizeHeader(field.label);
  const aliases = field.aliases.map(normalizeHeader);

  let score = 0;
  let reason = '';

  if (h === key || h === label) {
    score = 1;
    reason = `The heading matches the field name exactly`;
  } else if (aliases.includes(h)) {
    score = 0.96;
    reason = `"${header}" is a recognised heading for this field`;
  } else {
    // Longest alias contained in the header, weighted by how much it covers.
    let bestAlias = '';
    for (const a of [key, label, ...aliases]) {
      if (!a || a.length < 3) continue;
      if (h.includes(a) || a.includes(h)) {
        if (a.length > bestAlias.length) bestAlias = a;
      }
    }
    if (bestAlias) {
      const coverage = bestAlias.length / Math.max(h.length, bestAlias.length);
      score = 0.55 + coverage * 0.3; // 0.55–0.85
      reason = `"${header}" resembles the expected heading`;
    }
  }

  if (score === 0) return { score: 0, reason: 'No resemblance to this field' };

  // The column's actual contents either corroborate the guess or undermine it.
  if (column) {
    const t = column.detectedType;
    const wantsDate = field.type === 'date';
    const wantsNumber = field.type === 'amount' || field.type === 'number';
    const wantsText = field.type === 'string' || field.type === 'enum' || field.type === 'boolean';

    if (wantsDate && t === 'date') {
      score = Math.min(1, score + 0.04);
      reason += ' and the column contains dates';
    } else if (wantsDate && (t === 'text' || t === 'amount')) {
      score *= 0.45;
      reason += `, but the column looks like ${t === 'amount' ? 'numbers' : 'text'} rather than dates`;
    } else if (wantsNumber && t === 'amount') {
      score = Math.min(1, score + 0.04);
      reason += ' and the column contains numbers';
    } else if (wantsNumber && t === 'text') {
      score *= 0.45;
      reason += ', but the column looks like text rather than numbers';
    } else if (wantsNumber && t === 'date') {
      score *= 0.3;
      reason += ', but the column looks like dates';
    } else if (wantsText && t === 'text') {
      score = Math.min(1, score + 0.02);
    }

    if (t === 'empty') {
      score *= 0.2;
      reason += ', but the column is empty';
    }
  }

  return { score: Math.max(0, Math.min(1, score)), reason };
}

/**
 * Proposes a mapping for every field in the category.
 *
 * Each header is used at most once: fields compete for columns and the strongest
 * claim wins, which stops a single "Amount" column being assigned to Debit, Credit
 * and Amount simultaneously.
 */
export function suggestMapping(
  categoryKey: string,
  headers: string[],
  columns: ColumnProfile[] = [],
): { suggestions: MappingSuggestion[]; unrecognisedHeaders: string[] } {
  const category = getCategory(categoryKey);
  const columnByHeader = new Map(columns.map((c) => [c.header, c]));

  type Candidate = { fieldKey: string; header: string; score: number; reason: string };
  const candidates: Candidate[] = [];

  for (const field of category.fields) {
    for (const header of headers) {
      const { score, reason } = scoreHeaderForField(header, field, columnByHeader.get(header));
      if (score >= 0.5) candidates.push({ fieldKey: field.key, header, score, reason });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const takenHeaders = new Set<string>();
  const assigned = new Map<string, Candidate>();

  for (const c of candidates) {
    if (assigned.has(c.fieldKey) || takenHeaders.has(c.header)) continue;
    assigned.set(c.fieldKey, c);
    takenHeaders.add(c.header);
  }

  const suggestions: MappingSuggestion[] = category.fields.map((field) => {
    const chosen = assigned.get(field.key);
    const alternatives = candidates
      .filter((c) => c.fieldKey === field.key && c.header !== chosen?.header)
      .slice(0, 4)
      .map((c) => ({ header: c.header, confidence: round2(c.score), reason: c.reason }));

    let warning: string | undefined;
    if (!chosen && field.required) {
      warning = `${field.label} is required for this import, and no column matched it. Choose the right column before continuing.`;
    } else if (chosen && chosen.score < 0.7) {
      warning = `This match is uncertain — please confirm it is correct.`;
    } else if (chosen) {
      const col = columnByHeader.get(chosen.header);
      if (col?.detectedType === 'mixed') {
        warning = `"${chosen.header}" contains a mixture of value types. Some rows may be rejected.`;
      } else if (col?.dateFormat?.ambiguous && field.type === 'date') {
        warning = `Dates in "${chosen.header}" could be read as either day-first or month-first. Day-first (DD/MM) will be used — change it in the options below if that is wrong.`;
      }
    }

    return {
      fieldKey: field.key,
      header: chosen?.header ?? null,
      confidence: chosen ? round2(chosen.score) : 0,
      reason: chosen?.reason ?? 'No matching column found',
      alternatives,
      warning,
    };
  });

  const unrecognisedHeaders = headers.filter((h) => !takenHeaders.has(h));

  return { suggestions, unrecognisedHeaders };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A stable fingerprint of a sheet's column set, so a repeat upload of the same
 * export format can recall the mapping the user approved last time.
 */
export function headerSignature(headers: string[]): string {
  return sha256(
    headers
      .map(normalizeHeader)
      .filter(Boolean)
      .sort()
      .join('|'),
  );
}

export interface MappingValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Checks a user-supplied mapping against the category's rules before any parsing. */
export function validateMapping(categoryKey: string, mapping: ColumnMapping, headers: string[]): MappingValidation {
  const category: CategoryDef = getCategory(categoryKey);
  const errors: string[] = [];
  const warnings: string[] = [];

  const headerSet = new Set(headers);

  for (const [fieldKey, header] of Object.entries(mapping)) {
    if (header === null || header === undefined || header === '') continue;
    if (!category.fields.some((f) => f.key === fieldKey)) {
      warnings.push(`"${fieldKey}" is not a field of this import type and will be ignored.`);
      continue;
    }
    if (!headerSet.has(header)) {
      errors.push(`The column "${header}" mapped to ${fieldKey} is not present in the selected sheet.`);
    }
  }

  for (const field of category.fields) {
    if (field.required && !mapping[field.key]) {
      errors.push(`${field.label} is required. Choose the column that holds it.`);
    }
  }

  for (const group of category.anyOf ?? []) {
    const satisfied = group.keys.some((k) => mapping[k]);
    if (!satisfied) {
      errors.push(`This import needs ${group.label}. Map at least one of: ${group.keys.join(', ')}.`);
    }
  }

  // One column serving two fields is almost always a mistake.
  const used = new Map<string, string[]>();
  for (const [fieldKey, header] of Object.entries(mapping)) {
    if (!header) continue;
    const list = used.get(header) ?? [];
    list.push(fieldKey);
    used.set(header, list);
  }
  for (const [header, fields] of used) {
    if (fields.length > 1) {
      warnings.push(`The column "${header}" is mapped to more than one field (${fields.join(', ')}). Check that this is intended.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
