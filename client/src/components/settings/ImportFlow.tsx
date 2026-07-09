// Reusable import flow: file staging + validate/import state machine + row-precise report table.
// Shared by the Settings "Data" section (with a table picker passed as `extraControl`) and the
// per-project Data block on the project detail page (pinned to income-entries via `projectId`).
//
// It always validates first (a dry run), renders the report, and only lets a clean file be imported
// for real via an explicit confirm. A file with problems stays staged so the user can fix and
// re-validate. Whenever `table` or `projectId` changes, the staged report is dropped (it was
// validated against a different target) — the picked file is kept so the user can just re-validate.

import { useEffect, useState } from 'react';
import { ApiError } from '../../api';
import {
  type ImportReport,
  type ImportTable,
  dryRunImport,
  runImport,
} from '../../api/exportImport';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Phase = 'idle' | 'validating' | 'validated' | 'importing' | 'done';

interface ImportFlowProps {
  // The table to import into. When `projectId` is set this is pinned to 'income-entries'.
  table: ImportTable;
  // Targeted import: pin every row to this project (income-entries only).
  projectId?: number;
  // Optional control rendered first in the controls row (the Settings table picker).
  extraControl?: React.ReactNode;
}

export function ImportFlow({ table, projectId, extraControl }: ImportFlowProps) {
  const [file, setFile] = useState<File | null>(null);
  // Bumped to force-remount (and clear) the file input after a completed import.
  const [inputKey, setInputKey] = useState(0);

  const [phase, setPhase] = useState<Phase>('idle');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A staged report belongs to a specific (table, projectId); when either changes, drop it so the
  // user re-validates against the new target. The file stays staged.
  useEffect(() => {
    setReport(null);
    setError(null);
    setPhase('idle');
  }, [table, projectId]);

  function onFile(next: File | null) {
    setReport(null);
    setError(null);
    setPhase('idle');
    setFile(next);
  }

  async function onValidate() {
    if (file === null) return;
    setPhase('validating');
    setError(null);
    try {
      const r = await dryRunImport(table, file, projectId);
      setReport(r);
      setPhase('validated');
    } catch (err) {
      setPhase('idle');
      if (err instanceof ApiError && err.status === 413) {
        setError('That file is too large (limit 10 MB).');
      } else if (err instanceof ApiError) {
        setError('That file could not be read. Check the header row and format, then try again.');
      } else {
        setError('Could not validate the file. Please try again.');
      }
    }
  }

  async function onImport() {
    if (file === null) return;
    setPhase('importing');
    setError(null);
    try {
      const r = await runImport(table, file, projectId);
      setReport(r);
      setPhase('done');
      // Clear the staged file — a successful import is a clean slate.
      setFile(null);
      setInputKey((k) => k + 1);
    } catch (err) {
      setPhase('validated');
      if (err instanceof ApiError) {
        setError('Import failed — nothing was written. Re-validate and try again.');
      } else {
        setError('Could not import the file. Please try again.');
      }
    }
  }

  const hasErrors = report !== null && report.errors.length > 0;
  const canImport =
    phase === 'validated' && report !== null && !hasErrors && report.insert_rows > 0;

  return (
    <>
      <div className="import-controls">
        {extraControl}

        <label className="import-field">
          <span className="import-label">File</span>
          <input
            key={inputKey}
            type="file"
            accept={`.csv,.xlsx,text/csv,${XLSX_MIME}`}
            aria-label="CSV or XLSX file to import"
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          />
        </label>

        <button
          type="button"
          className="btn sm"
          disabled={file === null || phase === 'validating'}
          onClick={onValidate}
        >
          {phase === 'validating' ? 'Checking…' : 'Validate'}
        </button>
      </div>

      {file !== null && <p className="import-note num">Staged: {file.name}</p>}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {phase === 'done' && report !== null && (
        <p className="import-ok" role="status">
          Imported {report.insert_rows} row{report.insert_rows === 1 ? '' : 's'}
          {report.skip_rows > 0 && ` — ${report.skip_rows} already present, skipped`}.
        </p>
      )}

      {phase !== 'done' && report !== null && hasErrors && (
        <div className="import-errors">
          <p className="form-error" role="alert">
            {report.errors.length} problem{report.errors.length === 1 ? '' : 's'} found — nothing has
            been imported. Fix the file and validate again.
          </p>
          <div className="table-scroll">
            <table className="projects">
              <thead>
                <tr>
                  <th className="num">Row</th>
                  <th>Field</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {report.errors.map((e, i) => (
                  <tr key={`${e.row}-${e.field}-${i}`}>
                    <td className="num">{e.row}</td>
                    <td>{e.field}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {phase !== 'done' && report !== null && !hasErrors && (
        <div className="import-ready">
          {report.insert_rows > 0 ? (
            <>
              <p className="import-ok" role="status">
                {report.insert_rows} row{report.insert_rows === 1 ? '' : 's'} ready to import
                {report.skip_rows > 0 && ` (${report.skip_rows} already present, will be skipped)`}.
              </p>
              <button
                type="button"
                className="btn primary sm"
                disabled={!canImport}
                onClick={onImport}
              >
                {phase === 'importing'
                  ? 'Importing…'
                  : `Import ${report.insert_rows} row${report.insert_rows === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <p className="import-note">
              Nothing new to import — all {report.skip_rows} row
              {report.skip_rows === 1 ? '' : 's'} are already present.
            </p>
          )}
        </div>
      )}
    </>
  );
}
