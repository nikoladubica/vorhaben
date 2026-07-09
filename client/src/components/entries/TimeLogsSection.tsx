// Time-log panel for the project-detail screen. Same keyboard-first quick-add as income entries
// (Enter submits, Escape clears, focus returns to the hours field), plus a running hours total
// for the visible range in the panel header. `hours` stays a STRING end to end so "7.5"
// round-trips exactly; the client checks 0 < h <= 168 lightly and lets the server be authority.
//
// Time is tracking-only — it NEVER becomes revenue by itself (the panel says so). The bridge to
// money is explicit: select logs via the checkbox column and "Create income entry" combines them
// into one prefilled entry (hours × the project's hourly rate when there is one). The quick-add
// date is a range: leave "to" empty for a single-day log; with an end date, ONE log row covers
// the whole range with the entered hours as its total (end_date on the row — no per-day
// splitting). Picking a start date auto-fills the end date with it and opens its picker.

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import type { TimeLog } from '../../types';
import {
  createTimeLog,
  deleteTimeLog,
  listTimeLogs,
  updateTimeLog,
} from '../../api/timeLogs';
import { createEntry } from '../../api/entries';
import { formatDayMonth, formatHours, todayString } from '../../domain/format';

interface TimeLogsSectionProps {
  projectId: number;
  from: string;
  to: string;
  // Base for invoice prefills: the project's currency, and its rate when the model is hourly
  // (null otherwise — the amount is then left for the user to type).
  currency: string;
  hourlyRate: string | null;
  // Called after "Create income entry" succeeds so the page can reload the income panel.
  onInvoiced?: () => void;
}

interface LogDraft {
  date: string;
  endDate: string; // '' = single-day
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

// Whole days covered by `from` … `to` inclusive (UTC ms math, no DST drift).
function coveredDays(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}

// Mirrors the server cap: > 0 and at most max(168, 24 h × covered days).
function hoursValid(raw: string, days: number): boolean {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= Math.max(168, 24 * days);
}

function fieldMessage(field: string, code: string): string {
  if (field === 'hours') return 'Enter hours above 0 (at most 24 per covered day).';
  if (field === 'end_date') return 'The end date must not be before the start date.';
  if (code === 'required') return 'Required.';
  if (code === 'too_long') return 'This note is too long.';
  return 'Not valid.';
}

function firstError(errors: Record<string, string>): string | null {
  const [field, code] = Object.entries(errors)[0] ?? [];
  return field ? fieldMessage(field, code) : null;
}

// "01.07." for a single day, "01.07. – 05.07." for a range.
function formatLogDates(log: { date: string; end_date: string | null }): string {
  if (log.end_date === null || log.end_date === log.date) return formatDayMonth(log.date);
  return `${formatDayMonth(log.date)} – ${formatDayMonth(log.end_date)}`;
}

export function TimeLogsSection({
  projectId,
  from,
  to,
  currency,
  hourlyRate,
  onInvoiced,
}: TimeLogsSectionProps) {
  const [logs, setLogs] = useState<TimeLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [qDate, setQDate] = useState(todayString());
  const [qDateTo, setQDateTo] = useState(''); // empty = single-day log
  const [qNote, setQNote] = useState('');
  const [qHours, setQHours] = useState('');
  const [adding, setAdding] = useState(false);
  const [addErrors, setAddErrors] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<string | null>(null);
  const hoursRef = useRef<HTMLInputElement>(null);
  const endDateRef = useRef<HTMLInputElement>(null);

  // Checkbox selection (real ids only) feeding the "combine into an income entry" flow.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [invDate, setInvDate] = useState(todayString());
  const [invAmount, setInvAmount] = useState('');
  const [invNote, setInvNote] = useState('');
  const [invoiceSaving, setInvoiceSaving] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);

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
        if (!cancelled) {
          setLogs([...rows].sort(byNewest));
          // A new range may hide selected rows — start the selection over.
          setSelected(new Set());
          setInvoiceOpen(false);
        }
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

  function validateAdd(endDate: string | null): Record<string, string> {
    const errs: Record<string, string> = {};
    if (qDate.trim() === '') errs.date = 'required';
    if (endDate !== null && endDate < qDate) errs.end_date = 'invalid';
    const days = endDate !== null && endDate >= qDate ? coveredDays(qDate, endDate) : 1;
    if (!hoursValid(qHours.trim(), days)) errs.hours = 'invalid';
    return errs;
  }

  // When the user picks a start date, pull the end date along (it can never precede the start)
  // and open its picker so a range is one gesture away — Escape or leaving it equal keeps a
  // single-day log.
  function onStartDateChange(value: string) {
    setQDate(value);
    if (value !== '' && (qDateTo === '' || qDateTo < value)) setQDateTo(value);
    const end = endDateRef.current;
    if (end && value !== '') {
      end.focus();
      // showPicker needs a user gesture and is missing in some browsers — best effort only.
      try {
        end.showPicker?.();
      } catch {
        // fine — the field is focused, the user can open it themselves
      }
    }
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (adding) return;
    setAddError(null);

    // A "to" date equal to the start (or empty) is a plain single-day log.
    const endDate = qDateTo.trim() !== '' && qDateTo !== qDate ? qDateTo : null;
    const errs = validateAdd(endDate);
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
      end_date: endDate,
      hours,
      note,
      created_at: new Date().toISOString(),
    };
    setLogs((prev) => [optimistic, ...prev].sort(byNewest));

    try {
      const created = await createTimeLog(projectId, {
        date: qDate,
        end_date: endDate,
        hours,
        note,
      });
      setLogs((prev) =>
        prev.map((row) => (row.id === tempId ? created : row)).sort(byNewest),
      );
      // Clear note + hours + end date, keep the start date, and refocus the hours field.
      setQNote('');
      setQHours('');
      setQDateTo('');
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
    setQDateTo('');
    setQNote('');
    setQHours('');
    setAddErrors({});
    setAddError(null);
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedLogs = logs.filter((log) => selected.has(log.id));
  // Rounded back to 2dp so float drift from summing (8.1 + 8.2 → 16.299999…) never shows.
  const selectedHours =
    Math.round(
      selectedLogs.reduce((sum, log) => {
        const n = Number(log.hours);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0) * 100,
    ) / 100;

  // Prefill the combined income entry: today's date, hours × rate when the project is hourly
  // (left blank otherwise), and a note naming the hours and the days they cover.
  function openInvoice() {
    const starts = selectedLogs.map((log) => log.date).sort();
    const ends = selectedLogs.map((log) => log.end_date ?? log.date).sort();
    const first = starts[0];
    const last = ends[ends.length - 1];
    const range =
      first === last
        ? formatDayMonth(first)
        : `${formatDayMonth(first)} – ${formatDayMonth(last)}`;
    const amount = hourlyRate === null ? null : selectedHours * Number(hourlyRate);
    setInvAmount(amount !== null && Number.isFinite(amount) ? amount.toFixed(2) : '');
    setInvDate(todayString());
    setInvNote(`Invoice — ${formatHours(String(selectedHours))} h (${range})`);
    setInvoiceError(null);
    setInvoiceOpen(true);
  }

  async function submitInvoice(e: React.FormEvent) {
    e.preventDefault();
    if (invoiceSaving) return;
    const amount = Number(invAmount.trim());
    if (invAmount.trim() === '' || !Number.isFinite(amount) || amount <= 0) {
      setInvoiceError('Enter a positive amount.');
      return;
    }
    if (invDate.trim() === '') {
      setInvoiceError('Enter a date.');
      return;
    }
    setInvoiceSaving(true);
    setInvoiceError(null);
    try {
      await createEntry(projectId, {
        date: invDate,
        amount,
        currency,
        note: invNote.trim() === '' ? null : invNote.trim(),
      });
      setInvoiceOpen(false);
      setSelected(new Set());
      onInvoiced?.();
    } catch {
      setInvoiceError('Could not create the income entry. Please try again.');
    } finally {
      setInvoiceSaving(false);
    }
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
    setDraft({
      date: log.date,
      endDate: log.end_date ?? '',
      note: log.note ?? '',
      hours: log.hours,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setEditErrors({});
  }

  async function saveEdit() {
    if (editingId === null || draft === null || savingEdit) return;
    const endDate =
      draft.endDate.trim() !== '' && draft.endDate !== draft.date ? draft.endDate : null;
    const errs: Record<string, string> = {};
    if (draft.date.trim() === '') errs.date = 'required';
    if (endDate !== null && endDate < draft.date) errs.end_date = 'invalid';
    const days = endDate !== null && endDate >= draft.date ? coveredDays(draft.date, endDate) : 1;
    if (!hoursValid(draft.hours.trim(), days)) errs.hours = 'invalid';
    if (Object.keys(errs).length > 0) {
      setEditErrors(errs);
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await updateTimeLog(editingId, {
        date: draft.date,
        end_date: endDate,
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
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setLogs((prev) => prev.filter((row) => row.id !== id));
    try {
      await deleteTimeLog(id);
    } catch {
      if (removed) setLogs((prev) => [removed, ...prev].sort(byNewest));
      setError('Could not delete this time log. Please try again.');
    }
  }

  const totalHours =
    Math.round(
      logs.reduce((sum, log) => {
        const n = Number(log.hours);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0) * 100,
    ) / 100;
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
        <p className="panel-note">
          Time is for tracking and personal stats only — it never counts toward revenue. To bill
          logged hours, select them below and create an income entry.
        </p>
        <form className="entry-add timelog" onSubmit={onAdd} onKeyDown={onFormKeyDown}>
          <input
            type="date"
            value={qDate}
            onChange={(e) => onStartDateChange(e.target.value)}
            aria-label="Log start date"
            aria-invalid={addErrors.date ? true : undefined}
          />
          <input
            ref={endDateRef}
            type="date"
            value={qDateTo}
            min={qDate}
            onChange={(e) => setQDateTo(e.target.value)}
            aria-label="Log end date — same or empty for a single day"
            aria-invalid={addErrors.end_date ? true : undefined}
            title="End date: one log covers the whole range with the total hours"
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
            placeholder={qDateTo && qDateTo !== qDate ? 'Total hours' : 'Hours'}
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

        {selected.size > 0 && (
          <div className="select-bar num">
            <span>
              {selected.size} {selected.size === 1 ? 'log' : 'logs'} ·{' '}
              {formatHours(String(selectedHours))} h selected
            </span>
            {!invoiceOpen && (
              <button type="button" className="btn ghost sm" onClick={openInvoice}>
                Create income entry
              </button>
            )}
            <button
              type="button"
              className="row-btn"
              onClick={() => {
                setSelected(new Set());
                setInvoiceOpen(false);
              }}
            >
              Clear
            </button>
          </div>
        )}
        {invoiceOpen && selected.size > 0 && (
          <form className="entry-add invoice" onSubmit={submitInvoice}>
            <input
              type="date"
              value={invDate}
              onChange={(e) => setInvDate(e.target.value)}
              aria-label="Income entry date"
            />
            <input
              type="text"
              value={invNote}
              onChange={(e) => setInvNote(e.target.value)}
              aria-label="Income entry note"
            />
            <input
              type="text"
              inputMode="decimal"
              value={invAmount}
              placeholder="Amount"
              autoFocus
              onChange={(e) => setInvAmount(e.target.value)}
              aria-label="Income entry amount"
              style={{ textAlign: 'right' }}
            />
            <span className="cur num">{currency}</span>
            <button className="btn primary sm" type="submit" disabled={invoiceSaving}>
              Create
            </button>
          </form>
        )}
        {invoiceError && (
          <p className="field-error quick-add-error" role="alert">
            {invoiceError}
          </p>
        )}

        <div className="table-scroll">
          <table className="projects">
            <thead>
              <tr>
                <th className="sel" aria-label="Select logs" />
                <th>Date</th>
                <th>Note</th>
                <th className="r">Hours</th>
                <th className="r" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="table-empty">
                    Loading…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={5} className="form-error" role="alert">
                    {error}
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="table-empty">
                    No time logged in this range yet.
                  </td>
                </tr>
              ) : (
                logs.map((log) =>
                  editingId === log.id && draft ? (
                    <tr key={log.id}>
                      <td className="sel" />
                      <td>
                        <span className="cell-dates">
                          <input
                            className="cell-input"
                            type="date"
                            value={draft.date}
                            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                            onKeyDown={onEditKeyDown}
                            aria-label="Log start date"
                            aria-invalid={editErrors.date ? true : undefined}
                          />
                          <input
                            className="cell-input"
                            type="date"
                            value={draft.endDate}
                            min={draft.date}
                            onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
                            onKeyDown={onEditKeyDown}
                            aria-label="Log end date — same or empty for a single day"
                            aria-invalid={editErrors.end_date ? true : undefined}
                          />
                        </span>
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
                      <td className="sel" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(log.id)}
                          disabled={log.id < 0}
                          onChange={() => toggleSelect(log.id)}
                          aria-label={`Select the ${formatHours(log.hours)} h logged on ${formatLogDates(log)}`}
                        />
                      </td>
                      <td className="num">{formatLogDates(log)}</td>
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
