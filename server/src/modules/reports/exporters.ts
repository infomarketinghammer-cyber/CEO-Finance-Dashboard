import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDisplayDate } from '../../lib/dates.js';
import type { Minor } from '../../lib/money.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BRAND = {
  navy: '#10264A',
  blue: '#0878F9',
  cyan: '#13C6D9',
  mint: '#48E6A0',
  page: '#F6F8FC',
  text: '#17243B',
  muted: '#68758A',
  border: '#E4EAF2',
  amber: '#B45309',
  red: '#B91C1C',
};

const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;

/** Resolves the DHYEYA logo asset, which is shared with the web client. */
function logoPath(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../../assets/dhyeya-logo.jpeg'),
    path.resolve(__dirname, '../../../../client/public/dhyeya-logo.jpeg'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export interface ReportMeta {
  companyName: string;
  companyEntity?: string | null;
  gstin?: string | null;
  reportTitle: string;
  periodLabel: string;
  asOfLabel?: string;
  currency: string;
  generatedAt: string;
  generatedBy: string;
  dataSource: string;
  filters?: { label: string; value: string }[];
  warnings?: string[];
}

export interface ReportSection {
  title?: string;
  /** Column definitions. `numeric` columns are right-aligned and money-formatted. */
  columns: { key: string; label: string; numeric?: boolean; width?: number }[];
  rows: Record<string, string | number | null>[];
  /** Keys of rows that should be emphasised as totals. */
  totalRowIndexes?: number[];
  note?: string;
}

const MANAGEMENT_DISCLAIMER =
  'This is a management report produced from imported accounting data. It is not an audited financial statement and has not been reviewed or certified by a chartered accountant or auditor.';

// ---------------------------------------------------------------------- PDF

export async function buildPdf(meta: ReportMeta, sections: ReportSection[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 80;

    // ------------------------------------------------------------- header
    const logo = logoPath();
    let headerBottom = 40;

    if (logo) {
      try {
        doc.image(logo, 40, 36, { fit: [54, 54] });
      } catch {
        /* a missing or unreadable logo must not prevent the export */
      }
    }

    const textX = logo ? 104 : 40;
    doc.fillColor(BRAND.navy).fontSize(18).font('Helvetica-Bold').text('DHYEYA', textX, 40);
    doc.fillColor(BRAND.muted).fontSize(8).font('Helvetica').text('BUSINESS AND EXECUTIVE DASHBOARD', textX, 62, { characterSpacing: 1.2 });

    doc.fillColor(BRAND.text).fontSize(15).font('Helvetica-Bold').text(meta.reportTitle, 40, 100, { width: pageWidth });
    doc.fillColor(BRAND.navy).fontSize(11).font('Helvetica-Bold').text(meta.companyName, 40, 122, { width: pageWidth });

    let y = 140;
    doc.fontSize(8).font('Helvetica').fillColor(BRAND.muted);

    const metaLines = [
      meta.asOfLabel ? `As at: ${meta.asOfLabel}` : `Period: ${meta.periodLabel}`,
      `Currency: ${meta.currency}`,
      `Data source: ${meta.dataSource}`,
      `Generated: ${meta.generatedAt} by ${meta.generatedBy}`,
    ];
    if (meta.companyEntity) metaLines.splice(1, 0, `Entity type: ${meta.companyEntity}`);
    if (meta.gstin) metaLines.splice(1, 0, `GSTIN: ${meta.gstin}`);

    for (const line of metaLines) {
      doc.text(line, 40, y, { width: pageWidth });
      y += 11;
    }

    if (meta.filters?.length) {
      doc.text(`Filters: ${meta.filters.map((f) => `${f.label} — ${f.value}`).join('; ')}`, 40, y, { width: pageWidth });
      y += 11;
    }

    y += 4;
    doc.moveTo(40, y).lineTo(doc.page.width - 40, y).strokeColor(BRAND.border).lineWidth(1).stroke();
    y += 12;
    headerBottom = y;

    // ----------------------------------------------------------- warnings
    if (meta.warnings?.length) {
      const boxHeight = 14 + meta.warnings.length * 11;
      doc.rect(40, y, pageWidth, boxHeight).fillColor('#FEF6E7').fill();
      doc.fillColor(BRAND.amber).fontSize(8).font('Helvetica-Bold').text('Data quality', 48, y + 5);
      let wy = y + 16;
      doc.font('Helvetica').fontSize(7.5);
      for (const w of meta.warnings) {
        doc.text(`• ${w}`, 48, wy, { width: pageWidth - 16 });
        wy += 11;
      }
      y += boxHeight + 12;
    }

    // ----------------------------------------------------------- sections
    for (const section of sections) {
      if (y > doc.page.height - 140) {
        doc.addPage();
        y = 50;
      }

      if (section.title) {
        doc.fillColor(BRAND.navy).fontSize(11).font('Helvetica-Bold').text(section.title, 40, y, { width: pageWidth });
        y += 18;
      }

      const totalWeight = section.columns.reduce((a, c) => a + (c.width ?? 1), 0);
      const colWidths = section.columns.map((c) => ((c.width ?? 1) / totalWeight) * pageWidth);

      // header row
      doc.rect(40, y - 3, pageWidth, 16).fillColor(BRAND.navy).fill();
      let x = 40;
      doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
      section.columns.forEach((c, i) => {
        doc.text(c.label, x + 4, y + 1, { width: colWidths[i] - 8, align: c.numeric ? 'right' : 'left', lineBreak: false });
        x += colWidths[i];
      });
      y += 17;

      // data rows
      doc.font('Helvetica').fontSize(8);
      section.rows.forEach((row, rowIndex) => {
        if (y > doc.page.height - 70) {
          doc.addPage();
          y = 50;
          // repeat the header on the new page
          doc.rect(40, y - 3, pageWidth, 16).fillColor(BRAND.navy).fill();
          let hx = 40;
          doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
          section.columns.forEach((c, i) => {
            doc.text(c.label, hx + 4, y + 1, { width: colWidths[i] - 8, align: c.numeric ? 'right' : 'left', lineBreak: false });
            hx += colWidths[i];
          });
          y += 17;
          doc.font('Helvetica').fontSize(8);
        }

        const isTotal = section.totalRowIndexes?.includes(rowIndex);
        if (rowIndex % 2 === 1 && !isTotal) {
          doc.rect(40, y - 2, pageWidth, 14).fillColor(BRAND.page).fill();
        }
        if (isTotal) {
          doc.rect(40, y - 2, pageWidth, 14).fillColor('#EEF4FF').fill();
        }

        let cx = 40;
        doc.font(isTotal ? 'Helvetica-Bold' : 'Helvetica').fillColor(BRAND.text);
        section.columns.forEach((c, i) => {
          const raw = row[c.key];
          const text = raw === null || raw === undefined ? '—' : String(raw);
          doc.text(text, cx + 4, y + 1, { width: colWidths[i] - 8, align: c.numeric ? 'right' : 'left', lineBreak: false, ellipsis: true });
          cx += colWidths[i];
        });
        y += 14;
      });

      if (section.note) {
        y += 4;
        doc.fillColor(BRAND.muted).fontSize(7).font('Helvetica-Oblique').text(section.note, 40, y, { width: pageWidth });
        y += 16;
      }

      y += 12;
    }

    // ------------------------------------------------------------ footers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const footerY = doc.page.height - 48;
      doc.moveTo(40, footerY).lineTo(doc.page.width - 40, footerY).strokeColor(BRAND.border).lineWidth(0.5).stroke();
      doc
        .fillColor(BRAND.muted)
        .fontSize(6.5)
        .font('Helvetica')
        .text(MANAGEMENT_DISCLAIMER, 40, footerY + 6, { width: pageWidth - 60 });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.width - 100, footerY + 6, { width: 60, align: 'right' });
    }

    doc.end();
  });
}

// -------------------------------------------------------------------- Excel

export async function buildExcel(meta: ReportMeta, sections: ReportSection[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DHYEYA — Business and Executive Dashboard';
  wb.created = new Date();

  // ---- cover sheet carrying the report context ----
  const info = wb.addWorksheet('Report details');
  info.columns = [
    { key: 'k', width: 26 },
    { key: 'v', width: 80 },
  ];

  const title = info.addRow({ k: 'DHYEYA', v: meta.reportTitle });
  title.getCell(1).font = { bold: true, size: 14, color: { argb: argb(BRAND.navy) } };
  title.getCell(2).font = { bold: true, size: 12, color: { argb: argb(BRAND.text) } };
  info.addRow({});

  const details: [string, string][] = [
    ['Company', meta.companyName],
    ...(meta.companyEntity ? ([['Entity type', meta.companyEntity]] as [string, string][]) : []),
    ...(meta.gstin ? ([['GSTIN', meta.gstin]] as [string, string][]) : []),
    [meta.asOfLabel ? 'As at' : 'Period', meta.asOfLabel ?? meta.periodLabel],
    ['Currency', meta.currency],
    ['Data source', meta.dataSource],
    ['Generated at', meta.generatedAt],
    ['Generated by', meta.generatedBy],
  ];

  for (const f of meta.filters ?? []) details.push([`Filter: ${f.label}`, f.value]);

  for (const [k, v] of details) {
    const r = info.addRow({ k, v });
    r.getCell(1).font = { bold: true, color: { argb: argb(BRAND.navy) } };
  }

  if (meta.warnings?.length) {
    info.addRow({});
    const h = info.addRow({ k: 'Data quality warnings', v: '' });
    h.getCell(1).font = { bold: true, color: { argb: argb(BRAND.amber) } };
    for (const w of meta.warnings) {
      const r = info.addRow({ k: '', v: w });
      r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      r.getCell(2).font = { color: { argb: argb(BRAND.amber) } };
    }
  }

  info.addRow({});
  const disc = info.addRow({ k: 'Important', v: MANAGEMENT_DISCLAIMER });
  disc.getCell(1).font = { bold: true };
  disc.getCell(2).alignment = { wrapText: true, vertical: 'top' };

  // ---- one sheet per section ----
  const used = new Set<string>();
  sections.forEach((section, idx) => {
    let name = (section.title ?? `Sheet ${idx + 1}`).replace(/[*?:\\/[\]]/g, '-').slice(0, 28);
    let suffix = 1;
    while (used.has(name)) name = `${name.slice(0, 26)}-${++suffix}`;
    used.add(name);

    const sheet = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });

    sheet.columns = section.columns.map((c) => ({
      header: c.label,
      key: c.key,
      width: Math.max(14, Math.min(42, c.label.length + 6 + (c.numeric ? 4 : 10))),
    }));

    sheet.getRow(1).eachCell((cell, col) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(BRAND.navy) } };
      cell.alignment = { horizontal: section.columns[col - 1]?.numeric ? 'right' : 'left', vertical: 'middle' };
    });
    sheet.getRow(1).height = 20;

    section.rows.forEach((row, rowIndex) => {
      const added = sheet.addRow(row);
      const isTotal = section.totalRowIndexes?.includes(rowIndex);

      added.eachCell((cell, col) => {
        const column = section.columns[col - 1];
        if (column?.numeric) {
          cell.numFmt = '#,##0.00;[Red]-#,##0.00;"—"';
          cell.alignment = { horizontal: 'right' };
        }
        if (isTotal) {
          cell.font = { bold: true };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF4FF' } };
          cell.border = { top: { style: 'thin', color: { argb: argb(BRAND.border) } } };
        }
      });
    });

    if (section.note) {
      sheet.addRow({});
      const noteRow = sheet.addRow({ [section.columns[0].key]: section.note });
      noteRow.getCell(1).font = { italic: true, color: { argb: argb(BRAND.muted) } };
      noteRow.getCell(1).alignment = { wrapText: true };
    }

    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: section.columns.length } };
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Money in minor units → a plain number Excel can total, or null for unavailable. */
export function excelMoney(minor: Minor | null | undefined, scale = 2): number | null {
  if (minor === null || minor === undefined) return null;
  return minor / Math.pow(10, scale);
}

/** Money in minor units → a display string for PDF cells. */
export function pdfMoney(minor: Minor | null | undefined, scale = 2): string {
  if (minor === null || minor === undefined) return 'Data unavailable';
  const value = minor / Math.pow(10, scale);
  const formatted = Math.abs(value).toLocaleString('en-IN', { minimumFractionDigits: scale, maximumFractionDigits: scale });
  return value < 0 ? `(${formatted})` : formatted;
}

export { formatDisplayDate, MANAGEMENT_DISCLAIMER };
