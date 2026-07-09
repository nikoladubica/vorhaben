// Per-project Data panel on the project detail page. Exports this project's child data — income
// entries, expenses, time logs, notes — as CSV per table or one XLSX workbook (all scoped by
// ?project=<id>, reusing the same routes as Settings), and imports income entries INTO this
// project via the shared ImportFlow (pinned with `projectId`, so a row that names a different
// project is rejected rather than silently rerouted). Whole-account export lives in Settings.

import { useState } from 'react';
import {
  type ExportFormat,
  downloadAllCsv,
  exportProjectXlsxUrl,
  exportUrl,
} from '../../api/exportImport';
import { ImportFlow } from '../settings/ImportFlow';

// The child tables a single project owns, in display order (server: PROJECT_SCOPED_TABLES).
const PROJECT_TABLES = [
  { table: 'income-entries', label: 'Income entries' },
  { table: 'expenses', label: 'Expenses' },
  { table: 'time-logs', label: 'Time logs' },
  { table: 'notes', label: 'Notes' },
] as const;

const PROJECT_TABLE_IDS = PROJECT_TABLES.map((t) => t.table);

export function ProjectDataSection({ projectId }: { projectId: number }) {
  const [format, setFormat] = useState<ExportFormat>('csv');

  return (
    <div className="panel">
      <div className="panel-h">
        <span className="t">Data</span>
      </div>
      <div className="panel-b" style={{ paddingTop: 10 }}>
        <h5 className="data-subhead" style={{ marginTop: 0 }}>
          Export
        </h5>
        <p className="desc">This project’s entries, expenses, time logs, and notes.</p>

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
          {PROJECT_TABLES.map((t) => (
            <li key={t.table}>
              <a className="btn ghost sm" href={exportUrl(t.table, format, projectId)} download>
                {t.label} {format === 'xlsx' ? 'XLSX' : 'CSV'}
              </a>
            </li>
          ))}
        </ul>

        <p className="export-all">
          {format === 'xlsx' ? (
            <a className="btn ghost sm" href={exportProjectXlsxUrl(projectId)} download>
              Whole project — one workbook
            </a>
          ) : (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => downloadAllCsv(PROJECT_TABLE_IDS, projectId)}
            >
              Whole project — {PROJECT_TABLE_IDS.length} CSV files
            </button>
          )}
        </p>

        <h5 className="data-subhead">Import</h5>
        <p className="desc">
          Add income entries to this project from a CSV or XLSX file. Re-importing is safe:
          entries already present (by date, amount, and note) are skipped, never duplicated.
        </p>

        <ImportFlow table="income-entries" projectId={projectId} />
      </div>
    </div>
  );
}
