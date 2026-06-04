/**
 * lib/cloud/xlsx-from-data.ts — JSON → XLSX (Built-In-Skills, 2026-06-03).
 *
 * Local, N2/N9-compliant Excel generation (NO Anthropic cloud sandbox) for
 * client deliverables: cost ledgers, reports, pricing tables. Used by the
 * `json-to-xlsx` branch in /api/cloud/generate and lands — like the PDF —
 * via uploadArtifact in the workspace cloud + as <surface:document> in the chat.
 *
 * Pure Node (exceljs). Deterministic. N1: cell values verbatim (no slice).
 */

import ExcelJS from 'exceljs';

export interface XlsxSheetInput {
  /** Tab name (Excel limit 31 chars — hard-capped, only the tab name). */
  name?: string;
  /** Column headers (first row, bold). */
  headers: string[];
  /** Data rows — one array per row, parallel to headers. Values verbatim (N1). */
  rows: Array<Array<string | number | boolean | null>>;
}

export interface XlsxInput {
  /** Document title (workbook metadata). */
  title: string;
  /** 1..n sheets. */
  sheets: XlsxSheetInput[];
  /** Optional author for the workbook metadata. */
  creator?: string;
}

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 50_000;
const MAX_COLS = 200;

/** Excel-safe tab name (31 chars, no `[]:*?/\`). */
function safeSheetName(name: string | undefined, idx: number): string {
  const base = (name ?? `Sheet${idx + 1}`).replace(/[[\]:*?/\\]/g, ' ').trim();
  return (base || `Sheet${idx + 1}`).slice(0, 31);
}

/**
 * Builds an XLSX as a buffer. Throws XlsxError on empty/invalid input.
 */
export async function dataToXlsxBuffer(input: XlsxInput): Promise<Buffer> {
  if (!input || !Array.isArray(input.sheets) || input.sheets.length === 0) {
    throw new XlsxError('Kein Sheet übergeben.');
  }
  if (input.sheets.length > MAX_SHEETS) {
    throw new XlsxError(`Zu viele Sheets (max ${MAX_SHEETS}).`);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = input.creator?.slice(0, 120) || 'laz.ing';
  wb.created = new Date(0); // deterministic (no Date.now → reproducible)

  input.sheets.forEach((sheet, idx) => {
    const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
    if (headers.length > MAX_COLS) {
      throw new XlsxError(`Zu viele Spalten in Sheet ${idx + 1} (max ${MAX_COLS}).`);
    }
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    if (rows.length > MAX_ROWS_PER_SHEET) {
      throw new XlsxError(`Zu viele Zeilen in Sheet ${idx + 1} (max ${MAX_ROWS_PER_SHEET}).`);
    }
    const ws = wb.addWorksheet(safeSheetName(sheet.name, idx));
    if (headers.length > 0) {
      const headerRow = ws.addRow(headers);
      headerRow.font = { bold: true };
      headerRow.alignment = { vertical: 'middle' };
      // Auto width roughly from header length (convenience, not exact).
      ws.columns = headers.map((h) => ({
        width: Math.min(60, Math.max(10, String(h).length + 2)),
      }));
    }
    for (const row of rows) {
      ws.addRow((row ?? []).map((v) => (v === null || v === undefined ? '' : v)));
    }
    if (headers.length > 0) {
      ws.views = [{ state: 'frozen', ySplit: 1 }]; // freeze the header row
    }
  });

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
