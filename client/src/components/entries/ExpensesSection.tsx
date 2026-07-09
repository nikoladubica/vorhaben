// Expense entries panel for the project-detail screen — identical in construction to
// EntriesSection (inline, keyboard-first quick-add: Enter submits, Escape clears, focus returns
// to the amount) but for money OUT (BUSINESS_LOGIC §8). Expenses have no 'expected' source, so
// there is no confirm action and no source tagging — every row is user-entered. Amounts stay
// STRINGS in state and become a number only at the createExpense/updateExpense boundary.

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import type { ExpenseEntry } from '../../types';
import {
  createExpense,
  deleteExpense,
  listExpenses,
  updateExpense,
} from '../../api/expenses';
import { formatDayMonth, formatMoney, todayString } from '../../domain/format';

interface ExpensesSectionProps {
  projectId: number;
  from: string;
  to: string;
  // Default currency for the quick-add, from the project's rate currency (falls back to CHF).
  currency: string;
  // Called after any change to the loaded set (add/edit/delete/load) so the detail header can
  // refresh its revenue / expenses / net summary.
  onChanged?: () => void;
}

// Editable draft for the inline row editor — every field is a string (amount too, ticket 04).
interface ExpenseDraft {
  date: string;
  note: string;
  amount: string;
  currency: string;
}

// Newest first: date desc, then created_at desc (so an optimistic row sorts to the top of its
// day), then id desc as a stable tiebreak — mirrors the server's ordering.
function byNewest(a: ExpenseEntry, b: ExpenseEntry): number {
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

export function ExpensesSection({
  projectId,
  from,
  to,
  currency,
  onChanged,
}: ExpensesSectionProps) {
  const [expenses, setExpenses] = useState<ExpenseEntry[]>([]);
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
  const [draft, setDraft] = useState<ExpenseDraft | null>(null);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  // Monotonically decreasing temporary id for optimistic rows (never collides with a real id).
  const tempIdRef = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listExpenses(projectId, { from, to })
      .then((rows) => {
        if (!cancelled) {
          setExpenses([...rows].sort(byNewest));
          onChanged?.();
        }
      })
      .catch(() => {
        if (!cancelled) setError('Could not load expenses.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // onChanged is a stable callback from the parent; range/project drive the reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, from, to]);

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
    const optimistic: ExpenseEntry = {
      id: tempId,
      project_id: projectId,
      date: qDate,
      amount,
      currency: cur,
      note,
      created_at: new Date().toISOString(),
    };
    setExpenses((prev) => [optimistic, ...prev].sort(byNewest));

    try {
      const created = await createExpense(projectId, {
        date: qDate,
        amount: Number(amount),
        currency: cur,
        note,
      });
      setExpenses((prev) =>
        prev.map((row) => (row.id === tempId ? created : row)).sort(byNewest),
      );
      onChanged?.();
      // Clear note + amount, keep date + currency, and return focus to the amount.
      setQNote('');
      setQAmount('');
      amountRef.current?.focus();
    } catch (err) {
      setExpenses((prev) => prev.filter((row) => row.id !== tempId));
      if (err instanceof ApiError && err.fields) setAddErrors(err.fields);
      else setAddError('Could not add this expense. Please try again.');
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

  function startEdit(expense: ExpenseEntry) {
    if (expense.id < 0) return; // optimistic row still saving
    setConfirmId(null);
    setEditErrors({});
    setEditingId(expense.id);
    setDraft({
      date: expense.date,
      note: expense.note ?? '',
      amount: expense.amount,
      currency: expense.currency,
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
      const updated = await updateExpense(editingId, {
        date: draft.date,
        amount: Number(draft.amount),
        currency: (draft.currency.trim() || currency).toUpperCase(),
        note: draft.note.trim() === '' ? null : draft.note.trim(),
      });
      setExpenses((prev) =>
        prev.map((row) => (row.id === editingId ? updated : row)).sort(byNewest),
      );
      onChanged?.();
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
    const removed = expenses.find((row) => row.id === id);
    setConfirmId(null);
    setExpenses((prev) => prev.filter((row) => row.id !== id));
    try {
      await deleteExpense(id);
      onChanged?.();
    } catch {
      // Roll the row back into place on failure.
      if (removed) setExpenses((prev) => [removed, ...prev].sort(byNewest));
      setError('Could not delete this expense. Please try again.');
    }
  }

  const summary = `${expenses.length} ${expenses.length === 1 ? 'expense' : 'expenses'}`;
  const addMessage = addError ?? firstError(addErrors);

  return (
    <div className="panel">
      <div className="panel-h">
        <span className="t">Expenses</span>
        <span className="s num">{summary}</span>
      </div>
      <div className="panel-b" style={{ paddingTop: 14 }}>
        <form className="entry-add expense" onSubmit={onAdd} onKeyDown={onFormKeyDown}>
          <input
            type="date"
            value={qDate}
            onChange={(e) => setQDate(e.target.value)}
            aria-label="Expense date"
            aria-invalid={addErrors.date ? true : undefined}
          />
          <input
            type="text"
            value={qNote}
            placeholder="Note — e.g. materials, hosting, fees"
            onChange={(e) => setQNote(e.target.value)}
            aria-label="Expense note"
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
              ) : expenses.length === 0 ? (
                <tr>
                  <td colSpan={4} className="table-empty">
                    No expenses logged in this range yet.
                  </td>
                </tr>
              ) : (
                expenses.map((expense) =>
                  editingId === expense.id && draft ? (
                    <tr key={expense.id}>
                      <td>
                        <input
                          className="cell-input"
                          type="date"
                          value={draft.date}
                          onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                          onKeyDown={onEditKeyDown}
                          aria-label="Expense date"
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
                          aria-label="Expense note"
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
                      key={expense.id}
                      className="editable"
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit expense from ${formatDayMonth(expense.date)}`}
                      onClick={() => startEdit(expense)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          startEdit(expense);
                        }
                      }}
                    >
                      <td className="num">{formatDayMonth(expense.date)}</td>
                      <td>{expense.note}</td>
                      <td className="r">{formatMoney(expense.amount, expense.currency)}</td>
                      <td className="r" onClick={(e) => e.stopPropagation()}>
                        {confirmId === expense.id ? (
                          <span className="row-confirm">
                            Delete?
                            <button
                              type="button"
                              className="row-btn danger"
                              onClick={() => onDelete(expense.id)}
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
                            <button
                              type="button"
                              className="row-btn danger"
                              aria-label={`Delete expense from ${formatDayMonth(expense.date)}`}
                              onClick={() => setConfirmId(expense.id)}
                              disabled={expense.id < 0}
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
