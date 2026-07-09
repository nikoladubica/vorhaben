// XLSX (OOXML) serializer + parser (BUSINESS_LOGIC.md §8, ticket 23). The format-specific twin of
// csv.ts: it converts to/from the SAME flat `string[][]` shape (header + rows of strings) that
// `parseCsv` produces and the import prepare functions consume, so all validation, dedup, and
// insert logic in routes/exportImport.ts is reused unchanged — this module only speaks the wire
// format. Built on exceljs (an approved dependency).

import ExcelJS from 'exceljs';
import { escapeFormulaText } from './csv.js';

export interface XlsxSheet {
  name: string;
  columns: readonly string[];
  rows: ReadonlyArray<Record<string, unknown>>;
}

// exceljs caps a worksheet name at 31 chars and forbids a handful of characters; our table keys are
// all short and safe, but sanitize defensively so a caller can never produce an invalid workbook.
function safeSheetName(name: string): string {
  return name.replace(/[*?:\\/[\]]/g, '_').slice(0, 31) || 'Sheet';
}

/**
 * Build a single workbook with one worksheet per entry. The header row is `columns`; each data row
 * is looked up by column name exactly as serializeCsv reads it. Every cell is written as a STRING
 * (matching the all-strings model of the CSV path) so numbers and dates round-trip byte-for-byte
 * with no locale reformatting, and user-authored text is run through the shared formula-injection
 * guard so a leading =/+/-/@ can never execute on open. Returns the .xlsx bytes as a Buffer.
 */
export async function serializeXlsxWorkbook(sheets: readonly XlsxSheet[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(safeSheetName(sheet.name));
    ws.addRow(sheet.columns as string[]);
    for (const row of sheet.rows) {
      ws.addRow(
        sheet.columns.map((c) => {
          const guarded = escapeFormulaText(row[c]);
          // Coerce to a string cell (or '' for null/undefined). A string value is stored as an
          // OOXML text cell, which is never evaluated as a formula; the guard's leading quote is a
          // second, format-independent line of defense.
          return guarded === null || guarded === undefined ? '' : String(guarded);
        }),
      );
    }
  }

  // writeBuffer returns an ArrayBuffer-like/Node Buffer depending on the environment; normalize to
  // a Node Buffer for the route to send.
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

// Coerce one exceljs cell value to the plain string the CSV importer expects. exceljs hands back a
// union: null, number, string, boolean, Date, or a rich object (formula/hyperlink/rich text). Our
// own exports are all strings, but a hand-authored .xlsx may carry real numbers/dates — normalize
// those to the same shapes the CSV importer already handles (numbers → plain decimal strings, dates
// → YYYY-MM-DD) so validation is identical regardless of source.
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return numberToPlainString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return dateToYmd(value);

  // Rich object cases.
  const obj = value as unknown as Record<string, unknown>;
  if ('text' in obj && typeof obj.text === 'string') {
    // Hyperlink cell: { text, hyperlink }.
    return obj.text;
  }
  if ('richText' in obj && Array.isArray(obj.richText)) {
    // Rich-text cell: concatenate the runs.
    return (obj.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
  }
  if ('result' in obj) {
    // Formula cell: fall back to the cached result (never the formula expression itself).
    return cellToString(obj.result as ExcelJS.CellValue);
  }
  if ('error' in obj && typeof obj.error === 'string') {
    return obj.error;
  }
  return String(value);
}

// Render a number as a plain decimal string. Amounts are decimal(14,2) and hours decimal(6,2), so
// values stay well within the range where String() is exact and never uses scientific notation.
function numberToPlainString(n: number): string {
  return String(n);
}

// A JS Date from exceljs (dates are stored UTC by default) → YYYY-MM-DD.
function dateToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Parse the FIRST worksheet of an .xlsx buffer into `string[][]` (header row included), one inner
 * array per row, every cell coerced to a string. Ragged rows are fine: the importer maps by header
 * name and treats missing cells as ''. Throws if the buffer is not a readable workbook.
 */
export async function parseXlsxSheet(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's load() is typed against a non-generic Buffer; @types/node's generic Buffer trips the
  // assignability check, so cast through unknown (the value is a real Node Buffer at runtime).
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const ws = workbook.worksheets[0];
  if (!ws) return [];

  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const record: string[] = [];
    // row.cellCount is the 1-based index of the last used cell; read every column up to it so a
    // blank interior cell becomes '' rather than being dropped (which would misalign columns).
    const count = row.cellCount;
    for (let c = 1; c <= count; c++) {
      record.push(cellToString(row.getCell(c).value));
    }
    rows.push(record);
  });

  return rows;
}
