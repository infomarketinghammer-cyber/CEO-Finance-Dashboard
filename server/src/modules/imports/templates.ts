import ExcelJS from 'exceljs';
import { getCategory } from './categories.js';

const BRAND = {
  navy: 'FF10264A',
  blue: 'FF0878F9',
  light: 'FFF6F8FC',
  border: 'FFE4EAF2',
  amber: 'FFB45309',
};

/**
 * Builds a downloadable template for an import category.
 *
 * Every sample value is prefixed "EXAMPLE —" and the sheet says plainly that the
 * rows must be deleted before use. §27 forbids demo records leaking into a real
 * company's books, and a template is the easiest way for that to happen by
 * accident.
 */
export async function buildTemplate(categoryKey: string): Promise<Buffer> {
  const category = getCategory(categoryKey);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ArthSetu - CEO Finance Dashboard';
  wb.created = new Date();

  // ---------------------------------------------------------------- data sheet
  const sheet = wb.addWorksheet('Data', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const headers = category.fields.map((f) => f.label);
  sheet.addRow(headers);

  const headerRow = sheet.getRow(1);
  headerRow.height = 22;
  headerRow.eachCell((cell, col) => {
    const field = category.fields[col - 1];
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: field?.required ? BRAND.navy : BRAND.blue } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: BRAND.border } } };
    if (field) {
      const parts = [
        field.required ? 'Required.' : 'Optional.',
        typeLabel(field.type),
        field.enumValues ? `One of: ${field.enumValues.join(', ')}.` : '',
        field.help ?? '',
      ].filter(Boolean);
      cell.note = parts.join(' ');
    }
  });

  for (const sample of category.sampleRows) {
    sheet.addRow(headers.map((h) => sample[h] ?? ''));
  }

  const sampleCount = category.sampleRows.length;
  for (let i = 2; i <= sampleCount + 1; i++) {
    sheet.getRow(i).eachCell((cell) => {
      cell.font = { italic: true, color: { argb: BRAND.amber } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF6E7' } };
    });
  }

  const warnRow = sheet.addRow([]);
  warnRow.getCell(1).value = '↑ The rows above are EXAMPLES. Delete them before entering your own data.';
  warnRow.getCell(1).font = { bold: true, color: { argb: BRAND.amber } };
  sheet.mergeCells(warnRow.number, 1, warnRow.number, Math.max(headers.length, 1));

  category.fields.forEach((f, i) => {
    sheet.getColumn(i + 1).width = Math.max(16, Math.min(32, f.label.length + 8));
    if (f.type === 'amount' || f.type === 'number') {
      sheet.getColumn(i + 1).numFmt = '#,##0.00';
    } else if (f.type === 'date') {
      sheet.getColumn(i + 1).numFmt = 'dd-mmm-yyyy';
    }
  });

  // ------------------------------------------------------------- guide sheet
  const guide = wb.addWorksheet('How to use');
  guide.columns = [
    { header: 'Column', key: 'col', width: 28 },
    { header: 'Required', key: 'req', width: 12 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Accepted values / notes', key: 'notes', width: 78 },
  ];

  guide.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.navy } };
  });

  for (const f of category.fields) {
    guide.addRow({
      col: f.label,
      req: f.required ? 'Yes' : 'No',
      type: typeLabel(f.type),
      notes: [f.enumValues ? `One of: ${f.enumValues.join(', ')}.` : '', f.help ?? '', `Also recognised as: ${f.aliases.slice(0, 6).join(', ')}`]
        .filter(Boolean)
        .join(' '),
    });
  }

  guide.addRow({});
  const notes: [string, string][] = [
    ['About this template', category.description],
    ['What it unlocks', category.enables.join(', ')],
    ['Duplicate detection', category.duplicateBasis],
    ['Partial imports', category.supportsPartialImport ? 'Supported — you may choose to import only the valid rows.' : 'Not supported — every row must be valid.'],
    ['Column order', 'Does not matter. You map your own columns during import, so you can also use a different file layout entirely.'],
    ['Dates', 'Any common format works (DD/MM/YYYY, YYYY-MM-DD, 05-Apr-2025). The format is detected per column and confirmed with you during import.'],
    ['Amounts', 'Plain numbers are best. Currency symbols, thousand separators, (brackets) for negatives, and Dr/Cr suffixes are all understood.'],
    ['Blank cells', 'A blank optional cell is stored as "not supplied" and is never replaced with zero.'],
  ];
  if (category.supportsForwardFill) {
    notes.push([
      'Multi-line vouchers',
      'Leave the date, voucher type and voucher number blank on continuation lines. Blank cells inherit the row above, matching how most accounting software exports vouchers.',
    ]);
  }

  for (const [k, v] of notes) {
    const r = guide.addRow({ col: k, notes: v });
    r.getCell(1).font = { bold: true };
    r.getCell(4).alignment = { wrapText: true, vertical: 'top' };
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** An Excel file listing the rejected rows with the reason each one failed. */
export async function buildRejectionReport(
  categoryLabel: string,
  companyName: string,
  fileName: string,
  rejections: { rowNumber: number; raw: Record<string, unknown>; errors: { message: string }[] }[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ArthSetu - CEO Finance Dashboard';
  const sheet = wb.addWorksheet('Rejected rows');

  const title = sheet.addRow([`Rejected rows — ${categoryLabel}`]);
  title.getCell(1).font = { bold: true, size: 14, color: { argb: BRAND.navy } };
  sheet.addRow([`Company: ${companyName}`]);
  sheet.addRow([`Source file: ${fileName}`]);
  sheet.addRow([`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`]);
  sheet.addRow([]);

  const sourceHeaders = [...new Set(rejections.flatMap((r) => Object.keys(r.raw)))];
  const headerRow = sheet.addRow(['Spreadsheet row', 'Why it was rejected', ...sourceHeaders]);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.navy } };
  });

  for (const r of rejections) {
    sheet.addRow([
      r.rowNumber,
      r.errors.map((e) => e.message).join(' • '),
      ...sourceHeaders.map((h) => {
        const v = r.raw[h];
        if (v === null || v === undefined) return '';
        return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      }),
    ]);
  }

  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 60;
  sheet.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  sourceHeaders.forEach((h, i) => {
    sheet.getColumn(i + 3).width = Math.max(14, Math.min(30, h.length + 4));
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function typeLabel(type: string): string {
  switch (type) {
    case 'amount':
      return 'Amount';
    case 'number':
      return 'Number';
    case 'date':
      return 'Date';
    case 'boolean':
      return 'Yes / No';
    case 'enum':
      return 'Choice';
    default:
      return 'Text';
  }
}
