// CSV / XLSX export + import calls (BUSINESS_LOGIC.md §8, tickets 19 & 23).
//
// Export is a plain download: the browser hits the URL directly (a normal <a download> link), so
// the httpOnly session cookie rides along same-origin — no fetch/blob needed. Import posts the
// picked file's bytes; the shared JSON `api` helper can't send a raw/binary body, so these calls
// use fetch directly but reuse ApiError for consistent error handling. The Content-Type is set from
// the file (text/csv vs the spreadsheet MIME) so the server's two body parsers route it correctly.

import { ApiError } from '../api';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type ExportFormat = 'csv' | 'xlsx';

// The six tables the server can export, in the order they appear in the UI.
export const EXPORT_TABLES = [
  { table: 'projects', label: 'Projects' },
  { table: 'income-entries', label: 'Income entries' },
  { table: 'expenses', label: 'Expenses' },
  { table: 'time-logs', label: 'Time logs' },
  { table: 'notes', label: 'Notes' },
  { table: 'tags', label: 'Tags' },
] as const;

// The two tables the server can import.
export const IMPORT_TABLES = [
  { table: 'projects', label: 'Projects' },
  { table: 'income-entries', label: 'Income entries' },
] as const;

export type ImportTable = (typeof IMPORT_TABLES)[number]['table'];

export interface ImportRowError {
  row: number;
  field: string;
  message: string;
}

export interface ImportReport {
  dry_run: boolean;
  valid_rows: number;
  insert_rows: number;
  skip_rows: number;
  errors: ImportRowError[];
}

// The download URL for one table's export in the given format. Used as an <a href> so the browser
// saves the file with the server-set Content-Disposition filename. An optional `projectId` narrows
// a child table (income-entries, expenses, time-logs, notes) to one project.
export function exportUrl(table: string, format: ExportFormat = 'csv', projectId?: number): string {
  const scope = projectId !== undefined ? `?project=${projectId}` : '';
  return `/api/export/${table}.${format}${scope}`;
}

// The download URL for the whole account as one multi-sheet workbook (XLSX only).
export function exportAllXlsxUrl(): string {
  return '/api/export/all.xlsx';
}

// Trigger a browser download of a URL via a transient <a download> (the session cookie rides along
// same-origin, and the server's Content-Disposition sets the filename).
function triggerDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Download every table's CSV as separate files (CSV has no single-file bundle — that's XLSX's
// "one workbook"). The downloads are staggered slightly so browsers don't drop the later ones; the
// first click is inside the user's gesture. An optional `projectId` scopes child tables to one
// project. Returns the number of files kicked off, for the button label.
export function downloadAllCsv(tables: readonly string[], projectId?: number): number {
  tables.forEach((table, i) => {
    const fire = () => triggerDownload(exportUrl(table, 'csv', projectId));
    if (i === 0) fire();
    else window.setTimeout(fire, i * 250);
  });
  return tables.length;
}

// The download URL for a single project as one workbook (the four child-table sheets, XLSX only).
export function exportProjectXlsxUrl(projectId: number): string {
  return `/api/export/project/${projectId}.xlsx`;
}

// The download URL for a table's import template — the header row the importer expects plus example
// rows to overwrite. The income-entries template comes seeded with the user's own project ids. A
// `projectId` asks for the targeted shape (no project columns, examples from that project), matching
// what a targeted import accepts.
export function importTemplateUrl(
  table: ImportTable,
  format: ExportFormat,
  projectId?: number,
): string {
  const target = projectId !== undefined ? `?project=${projectId}` : '';
  return `/api/export/template/${table}.${format}${target}`;
}

// The download URL for the project-id reference: the user's live projects and the ids to key
// income-entry rows against. The companion to the income-entries template.
export function projectIdsUrl(format: ExportFormat): string {
  return `/api/export/project-ids.${format}`;
}

// Pick the upload Content-Type from the file's extension/MIME, defaulting to CSV. This drives which
// body parser the server uses (spreadsheet MIME → binary/XLSX, everything else → text/CSV).
function contentTypeForFile(file: File): string {
  if (file.name.toLowerCase().endsWith('.xlsx') || file.type === XLSX_MIME) {
    return XLSX_MIME;
  }
  return 'text/csv';
}

async function postImport(
  table: ImportTable,
  file: File,
  dryRun: boolean,
  projectId?: number,
): Promise<ImportReport> {
  // A `projectId` pins every row to that project (income-entries only); the server rejects it for
  // other tables.
  const target = projectId !== undefined ? `&project=${projectId}` : '';
  const res = await fetch(`/api/import/${table}?dry_run=${dryRun}${target}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': contentTypeForFile(file) },
    // A File is a valid fetch body: its raw bytes are streamed as-is (UTF-8 text for CSV, the
    // OOXML zip for XLSX).
    body: file,
  });

  if (!res.ok) {
    let parsed: { error?: string; fields?: Record<string, string> } = {};
    try {
      parsed = await res.json();
    } catch {
      // non-JSON error body; fall through with an empty shape
    }
    throw new ApiError(res.status, parsed.error ?? `request_failed_${res.status}`, parsed.fields);
  }

  return (await res.json()) as ImportReport;
}

// Validate a file without writing anything (dry run). Returns the row-precise report.
export function dryRunImport(
  table: ImportTable,
  file: File,
  projectId?: number,
): Promise<ImportReport> {
  return postImport(table, file, true, projectId);
}

// Perform the real import (requires a clean dry run — the server rejects any errors).
export function runImport(
  table: ImportTable,
  file: File,
  projectId?: number,
): Promise<ImportReport> {
  return postImport(table, file, false, projectId);
}
