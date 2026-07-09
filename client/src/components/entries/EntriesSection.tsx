// Income entries panel for the project-detail screen. The heart of data entry: an inline,
// keyboard-first quick-add (Enter submits, Escape clears, focus returns to the amount so a
// second entry is one keystroke away — BUSINESS_LOGIC §8, <10s to log) followed by the list.
// Amounts stay STRINGS in state and become a number only at the createEntry/updateEntry boundary.

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import type { IncomeEntry } from '../../types';
import {
  confirmEntry,
  createEntry,
  deleteEntry,
  listEntries,
  updateEntry,
} from '../../api/entries';
import { formatDayMonth, formatMoney, todayString } from '../../domain/format';

interface EntriesSectionProps {
  projectId: number;
  from: string;
  to: string;
  // Default currency for the quick-add, from the project's rate currency (falls back to CHF).
  currency: string;
}

// Editable draft for the inline row editor — every field is a string (amount too, ticket 04).
interface EntryDraft {
  date: string;
  note: string;
  amount: string;
  currency: string;
}

// Newest first: date desc, then created_at desc (so an optimistic row sorts to the top of its
// day), then id desc as a stable tiebreak — mirrors the server's ordering.
function byNewest(a: IncomeEntry, b: IncomeEntry): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return b.id - a.id;
}

// Translate a server/client field-error code into gentle inline copy.
function fieldMessage(field: string, code: string): string {
  if (code === 'required') return field === 'amount' ? 'Enter an amount.' : 'Required.';
  if (code === 'too_long') return 'This note is too long.';
  return field === 'amount' ? 'Enter a valid amount.' : 'Not valid.';
}

function firstError(errors: Record<string, string>): string | null {
  const [field, code] = Object.entries(errors)[0] ?? [];
  return field ? fieldMessage(field, code) : null;
}

export function EntriesSection({ projectId, from, to, currency }: EntriesSectionProps) {
  const [entries, setEntries] = useState<IncomeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Quick-add row. Date + currency persist between adds; note + amount clear on success.
  const [qDate, setQDate] = useState(todayString());
  const [qNote, setQNote] = useState('');
  const [qAmount, setQAmount] = useState('');
  const [qCurrency, setQCurrency] = useState(currency);
  const [adding, setAdding] = useState(false);
  const [addErrors, setAddErrors] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // Inline edit + one-time delete confirm.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  // Id of the expected row whose Confirm request is in flight (disables the buttons meanwhile).
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  // Monotonically decreasing temporary id for optimistic rows (never collides with a real id).
  const tempIdRef = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listEntries(projectId, { from, to })
      .then((rows) => {
        if (!cancelled) setEntries([...rows].sort(byNewest));
      })
      .catch(() => {
        if (!cancelled) setError('Could not load income entries.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, from, to]);

  // Autofocus the amount on mount — this is the fast path into logging income.
  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  function validateAdd(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (qDate.trim() === '') errs.date = 'required';
    const amount = qAmount.trim();
    if (amount === '') errs.amount = 'required';
    else if (!Number.isFinite(Number(amount))) errs.amount = 'invalid';
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

    const amount = qAmount.trim();
    const cur = (qCurrency.trim() || currency).toUpperCase();
    const note = qNote.trim() === '' ? null : qNote.trim();
    const tempId = tempIdRef.current--;
    const optimistic: IncomeEntry = {
      id: tempId,
      project_id: projectId,
      date: qDate,
      amount,
      currency: cur,
      note,
      source: 'manual',
      created_at: new Date().toISOString(),
    };
    setEntries((prev) => [optimistic, ...prev].sort(byNewest));

    try {
      const created = await createEntry(projectId, {
        date: qDate,
        amount: Number(amount),
        currency: cur,
        note,
      });
      setEntries((prev) =>
        prev.map((row) => (row.id === tempId ? created : row)).sort(byNewest),
      );
      // Clear note + amount, keep date + currency, and return focus to the amount.
      setQNote('');
      setQAmount('');
      amountRef.current?.focus();
    } catch (err) {
      setEntries((prev) => prev.filter((row) => row.id !== tempId));
      if (err instanceof ApiError && err.fields) setAddErrors(err.fields);
      else setAddError('Could not add this entry. Please try again.');
    } finally {
      setAdding(false);
    }
  }

  function clearQuickAdd() {
    setQDate(todayString());
    setQNote('');
    setQAmount('');
    setQCurrency(currency);
    setAddErrors({});
    setAddError(null);
  }

  function onFormKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      clearQuickAdd();
      amountRef.current?.focus();
    }
  }

  function startEdit(entry: IncomeEntry) {
    if (entry.id < 0) return; // optimistic row still saving
    setConfirmId(null);
    setEditErrors({});
    setEditingId(entry.id);
    setDraft({
      date: entry.date,
      note: entry.note ?? '',
      amount: entry.amount,
      currency: entry.currency,
    });
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
    if (draft.amount.trim() === '' || !Number.isFinite(Number(draft.amount)))
      errs.amount = 'invalid';
    if (Object.keys(errs).length > 0) {
      setEditErrors(errs);
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await updateEntry(editingId, {
        date: draft.date,
        amount: Number(draft.amount),
        currency: (draft.currency.trim() || currency).toUpperCase(),
        note: draft.note.trim() === '' ? null : draft.note.trim(),
      });
      setEntries((prev) =>
        prev.map((row) => (row.id === editingId ? updated : row)).sort(byNewest),
      );
      cancelEdit();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setEditErrors(err.fields);
      else setEditErrors({ amount: 'invalid' });
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
    const removed = entries.find((row) => row.id === id);
    setConfirmId(null);
    setEntries((prev) => prev.filter((row) => row.id !== id));
    try {
      await deleteEntry(id);
    } catch {
      // Roll the row back into place on failure.
      if (removed) setEntries((prev) => [removed, ...prev].sort(byNewest));
      setError('Could not delete this entry. Please try again.');
    }
  }

  // Confirm an auto-generated expected entry: the server flips it to source:'manual' and returns
  // the updated row, which replaces the pending one in place (disabled-button while in flight).
  async function onConfirm(id: number) {
    if (id < 0 || confirmingId !== null) return;
    setConfirmingId(id);
    setError(null);
    try {
      const updated = await confirmEntry(id);
      setEntries((prev) =>
        prev.map((row) => (row.id === id ? updated : row)).sort(byNewest),
      );
    } catch {
      setError('Could not confirm this entry. Please try again.');
    } finally {
      setConfirmingId(null);
    }
  }

  const summary = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
  const addMessage = addError ?? firstError(addErrors);

  return (
    <div className="panel">
      <div className="panel-h">
        <span className="t">Income entries</span>
        <span className="s num">{summary}</span>
      </div>
      <div className="panel-b" style={{ paddingTop: 14 }}>
        <form className="entry-add income" onSubmit={onAdd} onKeyDown={onFormKeyDown}>
          <input
            type="date"
            value={qDate}
            onChange={(e) => setQDate(e.target.value)}
            aria-label="Entry date"
            aria-invalid={addErrors.date ? true : undefined}
          />
          <input
            type="text"
            value={qNote}
            placeholder="Note — e.g. sprint 14, invoice #23"
            onChange={(e) => setQNote(e.target.value)}
            aria-label="Entry note"
          />
          <input
            ref={amountRef}
            type="text"
            inputMode="decimal"
            value={qAmount}
            placeholder="0"
            onChange={(e) => setQAmount(e.target.value)}
            aria-label="Amount"
            aria-invalid={addErrors.amount ? true : undefined}
            style={{ textAlign: 'right' }}
          />
          <input
            type="text"
            value={qCurrency}
            onChange={(e) => setQCurrency(e.target.value)}
            aria-label="Currency"
            aria-invalid={addErrors.currency ? true : undefined}
            maxLength={3}
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
                <th className="r">Amount</th>
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
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="table-empty">
                    No income logged in this range yet.
                  </td>
                </tr>
              ) : (
                entries.map((entry) =>
                  editingId === entry.id && draft ? (
                    <tr key={entry.id}>
                      <td>
                        <input
                          className="cell-input"
                          type="date"
                          value={draft.date}
                          onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                          onKeyDown={onEditKeyDown}
                          aria-label="Entry date"
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
                          aria-label="Entry note"
                        />
                      </td>
                      <td className="r">
                        <input
                          className="cell-input"
                          type="text"
                          inputMode="decimal"
                          value={draft.amount}
                          autoFocus
                          onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                          onKeyDown={onEditKeyDown}
                          aria-label="Amount"
                          aria-invalid={editErrors.amount ? true : undefined}
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
                      key={entry.id}
                      className={
                        entry.source === 'expected' ? 'editable expected' : 'editable'
                      }
                      role="button"
                      tabIndex={0}
                      aria-label={
                        entry.source === 'expected'
                          ? `Edit expected entry from ${formatDayMonth(entry.date)}`
                          : `Edit entry from ${formatDayMonth(entry.date)}`
                      }
                      onClick={() => startEdit(entry)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          startEdit(entry);
                        }
                      }}
                    >
                      <td className="num">{formatDayMonth(entry.date)}</td>
                      <td>
                        {entry.source === 'expected' && (
                          <span className="entry-tag">Expected</span>
                        )}
                        {entry.note}
                      </td>
                      <td className="r">{formatMoney(entry.amount, entry.currency)}</td>
                      <td className="r" onClick={(e) => e.stopPropagation()}>
                        {confirmId === entry.id ? (
                          <span className="row-confirm">
                            Delete?
                            <button
                              type="button"
                              className="row-btn danger"
                              onClick={() => onDelete(entry.id)}
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
                          <span className="row-actions">
                            {entry.source === 'expected' && (
                              <button
                                type="button"
                                className="row-btn confirm"
                                aria-label={`Confirm expected entry from ${formatDayMonth(entry.date)}`}
                                onClick={() => onConfirm(entry.id)}
                                disabled={entry.id < 0 || confirmingId !== null}
                              >
                                Confirm
                              </button>
                            )}
                            <button
                              type="button"
                              className="row-btn danger"
                              aria-label={`Delete entry from ${formatDayMonth(entry.date)}`}
                              onClick={() => setConfirmId(entry.id)}
                              disabled={entry.id < 0}
                            >
                              Remove
                            </button>
                          </span>
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
