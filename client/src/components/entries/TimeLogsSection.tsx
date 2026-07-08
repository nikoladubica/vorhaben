// Time-log panel for the project-detail screen. Same keyboard-first quick-add as income entries
// (Enter submits, Escape clears, focus returns to the hours field), plus a running hours total
// for the visible range in the panel header. `hours` stays a STRING end to end so "7.5"
// round-trips exactly; the client checks 0 < h <= 168 lightly and lets the server be authority.

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import type { TimeLog } from '../../types';
import {
  createTimeLog,
  deleteTimeLog,
  listTimeLogs,
  updateTimeLog,
} from '../../api/timeLogs';
import { formatDayMonth, formatHours, todayString } from '../../domain/format';

interface TimeLogsSectionProps {
  projectId: number;
  from: string;
  to: string;
}

interface LogDraft {
  date: string;
  note: string;
  hours: string;
}

// Newest first: date desc, then created_at desc (optimistic row to the top of its day), then id
// desc as a stable tiebreak — mirrors the server's ordering.
function byNewest(a: TimeLog, b: TimeLog): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return b.id - a.id;
}

function hoursValid(raw: string): boolean {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 168;
}

function fieldMessage(field: string, code: string): string {
  if (field === 'hours') return 'Enter hours between 0 and 168.';
  if (code === 'required') return 'Required.';
  if (code === 'too_long') return 'This note is too long.';
  return 'Not valid.';
}

function firstError(errors: Record<string, string>): string | null {
  const [field, code] = Object.entries(errors)[0] ?? [];
  return field ? fieldMessage(field, code) : null;
}

export function TimeLogsSection({ projectId, from, to }: TimeLogsSectionProps) {
  const [logs, setLogs] = useState<TimeLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [qDate, setQDate] = useState(todayString());
  const [qNote, setQNote] = useState('');
  const [qHours, setQHours] = useState('');
  const [adding, setAdding] = useState(false);
  const [addErrors, setAddErrors] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<string | null>(null);
  const hoursRef = useRef<HTMLInputElement>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<LogDraft | null>(null);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const tempIdRef = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listTimeLogs(projectId, { from, to })
      .then((rows) => {
        if (!cancelled) setLogs([...rows].sort(byNewest));
      })
      .catch(() => {
        if (!cancelled) setError('Could not load time logs.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, from, to]);

  function validateAdd(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (qDate.trim() === '') errs.date = 'required';
    if (!hoursValid(qHours.trim())) errs.hours = 'invalid';
    return errs;
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (adding) return;
    setAddError(null);
    const errs = validateAdd();
    if (Object.keys(errs).length > 0) {
      setAddErrors(errs);
      return;
    }
    setAddErrors({});
    setAdding(true);

    const hours = qHours.trim();
    const note = qNote.trim() === '' ? null : qNote.trim();
    const tempId = tempIdRef.current--;
    const optimistic: TimeLog = {
      id: tempId,
      project_id: projectId,
      date: qDate,
      hours,
      note,
      created_at: new Date().toISOString(),
    };
    setLogs((prev) => [optimistic, ...prev].sort(byNewest));

    try {
      const created = await createTimeLog(projectId, { date: qDate, hours, note });
      setLogs((prev) =>
        prev.map((row) => (row.id === tempId ? created : row)).sort(byNewest),
      );
      // Clear note + hours, keep date, and return focus to the hours field.
      setQNote('');
      setQHours('');
      hoursRef.current?.focus();
    } catch (err) {
      setLogs((prev) => prev.filter((row) => row.id !== tempId));
      if (err instanceof ApiError && err.fields) setAddErrors(err.fields);
      else setAddError('Could not add this time log. Please try again.');
    } finally {
      setAdding(false);
    }
  }

  function clearQuickAdd() {
    setQDate(todayString());
    setQNote('');
    setQHours('');
    setAddErrors({});
    setAddError(null);
  }

  function onFormKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      clearQuickAdd();
      hoursRef.current?.focus();
    }
  }

  function startEdit(log: TimeLog) {
    if (log.id < 0) return;
    setConfirmId(null);
    setEditErrors({});
    setEditingId(log.id);
    setDraft({ date: log.date, note: log.note ?? '', hours: log.hours });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setEditErrors({});
  }

  async function saveEdit() {
    if (editingId === null || draft === null || savingEdit) return;
    const errs: Record<string, string> = {};
    if (draft.date.trim() === '') errs.date = 'required';
    if (!hoursValid(draft.hours.trim())) errs.hours = 'invalid';
    if (Object.keys(errs).length > 0) {
      setEditErrors(errs);
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await updateTimeLog(editingId, {
        date: draft.date,
        hours: draft.hours.trim(),
        note: draft.note.trim() === '' ? null : draft.note.trim(),
      });
      setLogs((prev) =>
        prev.map((row) => (row.id === editingId ? updated : row)).sort(byNewest),
      );
      cancelEdit();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setEditErrors(err.fields);
      else setEditErrors({ hours: 'invalid' });
    } finally {
      setSavingEdit(false);
    }
  }

  function onEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  async function onDelete(id: number) {
    const removed = logs.find((row) => row.id === id);
    setConfirmId(null);
    setLogs((prev) => prev.filter((row) => row.id !== id));
    try {
      await deleteTimeLog(id);
    } catch {
      if (removed) setLogs((prev) => [removed, ...prev].sort(byNewest));
      setError('Could not delete this time log. Please try again.');
    }
  }

  const totalHours = logs.reduce((sum, log) => {
    const n = Number(log.hours);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
  const count = logs.length;
  const summary = `${count} ${count === 1 ? 'log' : 'logs'} · ${formatHours(String(totalHours))} h`;
  const addMessage = addError ?? firstError(addErrors);

  return (
    <div className="panel" style={{ marginTop: 24 }}>
      <div className="panel-h">
        <span className="t">Time logged</span>
        <span className="s num">{summary}</span>
      </div>
      <div className="panel-b" style={{ paddingTop: 14 }}>
        <form className="entry-add" onSubmit={onAdd} onKeyDown={onFormKeyDown}>
          <input
            type="date"
            value={qDate}
            onChange={(e) => setQDate(e.target.value)}
            aria-label="Log date"
            aria-invalid={addErrors.date ? true : undefined}
          />
          <input
            type="text"
            value={qNote}
            placeholder="Note — e.g. sprint 14, on-site"
            onChange={(e) => setQNote(e.target.value)}
            aria-label="Log note"
          />
          <input
            ref={hoursRef}
            type="text"
            inputMode="decimal"
            value={qHours}
            placeholder="Hours"
            onChange={(e) => setQHours(e.target.value)}
            aria-label="Hours"
            aria-invalid={addErrors.hours ? true : undefined}
            style={{ textAlign: 'right' }}
          />
          <button className="btn primary sm" type="submit" disabled={adding}>
            Add
          </button>
        </form>
        {addMessage && (
          <p className="field-error quick-add-error" role="alert">
            {addMessage}
          </p>
        )}

        <div className="table-scroll">
          <table className="projects">
            <thead>
              <tr>
                <th>Date</th>
                <th>Note</th>
                <th className="r">Hours</th>
                <th className="r" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="table-empty">
                    Loading…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={4} className="form-error" role="alert">
                    {error}
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="table-empty">
                    No time logged in this range yet.
                  </td>
                </tr>
              ) : (
                logs.map((log) =>
                  editingId === log.id && draft ? (
                    <tr key={log.id}>
                      <td>
                        <input
                          className="cell-input"
                          type="date"
                          value={draft.date}
                          onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                          onKeyDown={onEditKeyDown}
                          aria-label="Log date"
                          aria-invalid={editErrors.date ? true : undefined}
                        />
                      </td>
                      <td>
                        <input
                          className="cell-input"
                          type="text"
                          value={draft.note}
                          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                          onKeyDown={onEditKeyDown}
                          aria-label="Log note"
                        />
                      </td>
                      <td className="r">
                        <input
                          className="cell-input"
                          type="text"
                          inputMode="decimal"
                          value={draft.hours}
                          autoFocus
                          onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
                          onKeyDown={onEditKeyDown}
                          aria-label="Hours"
                          aria-invalid={editErrors.hours ? true : undefined}
                          style={{ textAlign: 'right' }}
                        />
                      </td>
                      <td className="r">
                        <span className="row-actions">
                          <button
                            type="button"
                            className="row-btn"
                            onClick={saveEdit}
                            disabled={savingEdit}
                          >
                            Save
                          </button>
                          <button type="button" className="row-btn" onClick={cancelEdit}>
                            Cancel
                          </button>
                        </span>
                      </td>
                    </tr>
                  ) : (
                    <tr
                      key={log.id}
                      className="editable"
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit time log from ${formatDayMonth(log.date)}`}
                      onClick={() => startEdit(log)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          startEdit(log);
                        }
                      }}
                    >
                      <td className="num">{formatDayMonth(log.date)}</td>
                      <td>{log.note}</td>
                      <td className="r">{formatHours(log.hours)}</td>
                      <td className="r" onClick={(e) => e.stopPropagation()}>
                        {confirmId === log.id ? (
                          <span className="row-confirm">
                            Delete?
                            <button
                              type="button"
                              className="row-btn danger"
                              onClick={() => onDelete(log.id)}
                            >
                              Yes
                            </button>
                            <button
                              type="button"
                              className="row-btn"
                              onClick={() => setConfirmId(null)}
                            >
                              No
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="row-btn danger"
                            aria-label={`Delete time log from ${formatDayMonth(log.date)}`}
                            onClick={() => setConfirmId(log.id)}
                            disabled={log.id < 0}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ),
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
