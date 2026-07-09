// Data: export every table as CSV or XLSX, and import projects or income entries from either.
// Export links are plain downloads (the cookie rides along); a format toggle switches every link
// between CSV and a single multi-sheet XLSX workbook. The import UI is the shared ImportFlow, given
// the Settings table picker as its `extraControl`; the per-project Data block reuses the same flow.

import { useState } from 'react';
import {
  EXPORT_TABLES,
  IMPORT_TABLES,
  type ExportFormat,
  type ImportTable,
  downloadAllCsv,
  exportAllXlsxUrl,
  exportUrl,
} from '../../api/exportImport';
import { ImportFlow } from './ImportFlow';

const EXPORT_TABLE_IDS = EXPORT_TABLES.map((t) => t.table);

export function DataSection() {
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [table, setTable] = useState<ImportTable>('projects');

  return (
    <div className="set-sec" id="data">
      <h4>Data</h4>
      <p className="desc">
        Export every table — complete and lossless, with your original amounts and currencies, never
        converted. Or import projects and income entries from a spreadsheet; every import is checked
        first and shown to you before anything is written.
      </p>

      <h5 className="data-subhead">Export</h5>
      <p className="desc">One file per table. Soft-deleted projects are included.</p>

      <div className="format-toggle" role="group" aria-label="Export format">
        <button
          type="button"
          className={format === 'csv' ? 'on' : undefined}
          aria-pressed={format === 'csv'}
          onClick={() => setFormat('csv')}
        >
          CSV
        </button>
        <button
          type="button"
          className={format === 'xlsx' ? 'on' : undefined}
          aria-pressed={format === 'xlsx'}
          onClick={() => setFormat('xlsx')}
        >
          Excel (XLSX)
        </button>
      </div>

      <ul className="export-list">
        {EXPORT_TABLES.map((t) => (
          <li key={t.table}>
            <a className="btn ghost sm" href={exportUrl(t.table, format)} download>
              {t.label} {format === 'xlsx' ? 'XLSX' : 'CSV'}
            </a>
          </li>
        ))}
      </ul>

      <p className="export-all">
        {format === 'xlsx' ? (
          <a className="btn ghost sm" href={exportAllXlsxUrl()} download>
            All tables — one workbook
          </a>
        ) : (
          <button type="button" className="btn ghost sm" onClick={() => downloadAllCsv(EXPORT_TABLE_IDS)}>
            All tables — {EXPORT_TABLE_IDS.length} CSV files
          </button>
        )}
      </p>

      <h5 className="data-subhead">Import</h5>
      <p className="desc">
        Projects and income entries only, from a CSV or XLSX file. Re-importing the same file is
        safe: existing projects (by name) and existing entries (by project, date, amount, and note)
        are skipped, never duplicated.
      </p>

      <ImportFlow
        table={table}
        extraControl={
          <label className="import-field">
            <span className="import-label">Into</span>
            <select
              value={table}
              onChange={(e) => setTable(e.target.value as ImportTable)}
              aria-label="Table to import into"
            >
              {IMPORT_TABLES.map((t) => (
                <option key={t.table} value={t.table}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        }
      />
    </div>
  );
}
