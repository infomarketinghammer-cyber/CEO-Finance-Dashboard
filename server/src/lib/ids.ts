import { randomUUID, createHash } from 'node:crypto';

export const newId = (): string => randomUUID();

export const nowIso = (): string => new Date().toISOString();

export const today = (): string => new Date().toISOString().slice(0, 10);

/** Stable sha256 hex digest, truncated to 64 chars (full digest length). */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Build a stable composite identity for a financial record.
 *
 * Deliberately NOT derived from row position: the same voucher exported twice with
 * extra rows above it must produce the same key, otherwise a re-import silently
 * doubles the ledger. Parts are normalised and joined with a separator that cannot
 * appear in the normalised output.
 */
export function dedupeKey(parts: Array<string | number | null | undefined>): string {
  const normalised = parts.map((p) => {
    if (p === null || p === undefined) return '';
    return String(p).trim().toLowerCase().replace(/\s+/g, ' ');
  });
  return sha256(normalised.join('\u0001'));
}

/** Ledger and party names are matched case- and whitespace-insensitively. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,]+$/, '');
}
