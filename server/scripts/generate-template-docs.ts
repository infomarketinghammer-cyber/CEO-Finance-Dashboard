/**
 * Generates docs/EXCEL_TEMPLATES.md from the live category definitions.
 *
 * The column reference is generated rather than hand-written so it cannot drift
 * from what the importer actually accepts. Re-run after changing categories.ts:
 *   npx tsx scripts/generate-template-docs.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPORT_CATEGORIES } from '../src/modules/imports/categories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '../../docs/EXCEL_TEMPLATES.md');

const lines: string[] = [];

lines.push('# Excel import templates');
lines.push('');
lines.push(
  'DHYEYA imports `.xlsx`, `.xls` and `.csv` workbooks. You do **not** have to match these column names exactly — ' +
    'the import wizard maps your own headers onto these fields, remembers the mapping per company and file shape, and ' +
    'lets you review every suggestion before anything is committed. The names below are what the wizard recognises ' +
    'automatically, and what the downloadable templates use.',
);
lines.push('');
lines.push('Download a ready-made template for any category from **Excel Import Center → Templates**, or from the API:');
lines.push('');
lines.push('```');
lines.push('GET /api/imports/templates/:categoryKey');
lines.push('```');
lines.push('');
lines.push('## How to read these tables');
lines.push('');
lines.push('- **Required** fields must be present and readable, or the row is rejected with a reason.');
lines.push('- **Recognised headers** are matched case-insensitively, ignoring spaces and punctuation.');
lines.push('- A column DHYEYA does not recognise is reported as unmapped; it is never imported silently.');
lines.push('- Amounts may use `1,23,456.78`, `123,456.78`, `₹1,000`, `Rs. 1,000`, `(1,234.50)` for negatives, or a `Dr`/`Cr` suffix.');
lines.push('- Dates may be ISO (`2025-04-03`), day-first, month-first, written (`3 Apr 2025`) or Excel serials. ');
lines.push('  Where day/month order is ambiguous, the wizard asks rather than assuming.');
lines.push('');
lines.push('---');
lines.push('');

// Contents
lines.push('## Categories');
lines.push('');
for (const c of IMPORT_CATEGORIES) {
  lines.push(`- [${c.label}](#${slug(c.label)}) — \`${c.key}\``);
}
lines.push('');
lines.push('---');
lines.push('');

for (const c of IMPORT_CATEGORIES) {
  lines.push(`## ${c.label}`);
  lines.push('');
  lines.push(`**Category key:** \`${c.key}\``);
  lines.push('');
  lines.push(c.description);
  lines.push('');

  if (c.enables?.length) {
    lines.push(`**Enables:** ${c.enables.join(' · ')}`);
    lines.push('');
  }

  lines.push(`**Duplicate detection:** ${c.duplicateBasis ?? 'Not applicable'}`);
  lines.push('');
  lines.push(`**Partial import of valid rows:** ${c.supportsPartialImport ? 'supported' : 'not supported'}`);
  if (c.supportsForwardFill) {
    lines.push('');
    lines.push(
      '**Blank continuation cells:** supported. Where the date, voucher type and voucher number are printed once ' +
        'per voucher and left blank on the following lines (as Tally day books do), the blanks are carried down.',
    );
  }
  lines.push('');

  lines.push('| Field | Required | Type | Recognised headers | Notes |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const f of c.fields) {
    const aliases = (f.aliases ?? []).slice(0, 8).map((a) => `\`${a}\``).join(', ');
    lines.push(
      `| **${f.label}** | ${f.required ? 'Yes' : 'No'} | ${f.type} | ${aliases || '—'} | ${(f.help ?? '').replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');

  if (c.anyOf?.length) {
    for (const a of c.anyOf) {
      lines.push(`> At least one of these must be mapped: ${a.label} (\`${a.keys.join('`, `')}\`).`);
      lines.push('');
    }
  }

  if (c.sampleRows?.length) {
    const sample = c.sampleRows[0];
    lines.push('**Example row**');
    lines.push('');
    const keys = Object.keys(sample);
    lines.push(`| ${keys.join(' | ')} |`);
    lines.push(`| ${keys.map(() => '---').join(' | ')} |`);
    for (const row of c.sampleRows) {
      lines.push(`| ${keys.map((k) => String((row as Record<string, unknown>)[k] ?? '')).join(' | ')} |`);
    }
    lines.push('');
    lines.push('Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
}

lines.push('## Minimum to get started');
lines.push('');
lines.push('A useful dashboard needs, in this order:');
lines.push('');
lines.push('1. **Chart of Accounts** — so ledgers exist and can be classified.');
lines.push('2. **Opening Balances** — so the Balance Sheet starts from the right position.');
lines.push('3. **Vouchers** — so the Profit & Loss and all movement have something to report.');
lines.push('');
lines.push('Receivables, payables, expenses and budgets each unlock their own modules and can be added at any time.');
lines.push('');
lines.push(`<sub>Generated from \`server/src/modules/imports/categories.ts\`. Do not edit by hand.</sub>`);
lines.push('');

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'));
// eslint-disable-next-line no-console
console.log(`Wrote ${outPath} (${IMPORT_CATEGORIES.length} categories)`);
