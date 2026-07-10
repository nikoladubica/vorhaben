// Checklist rendering shared by two callers (ticket step 8):
//   • review mode  — an editable draft, local state only, nothing persisted (the Capture page owns
//     the items array and passes handlers). Checkboxes toggle locally; text is editable; items can
//     be added/removed.
//   • saved mode   — a persisted checklist from the API; toggling a box PATCHes the item
//     optimistically and reverts with an inline message on failure. Text is read-only, struck
//     through when checked.
// Real <input type="checkbox"> throughout (keyboard-accessible, label-clickable). Square checkboxes
// via token hairlines/accent-color — no custom SVG, no animation beyond the state change.

import { useState } from 'react';
import type { Checklist, ChecklistItem } from '../api/capture';
import { updateChecklistItem } from '../api/capture';

// ————— review (editable draft) —————

interface ReviewProps {
  mode: 'review';
  items: { text: string; checked: boolean }[];
  onChange: (items: { text: string; checked: boolean }[]) => void;
}

function ReviewChecklist({ items, onChange }: ReviewProps) {
  const total = items.length;
  const checked = items.filter((i) => i.checked).length;

  const setItem = (idx: number, patch: Partial<{ text: string; checked: boolean }>) => {
    onChange(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };
  const removeItem = (idx: number) => onChange(items.filter((_, i) => i !== idx));
  const addItem = () => onChange([...items, { text: '', checked: false }]);

  return (
    <div>
      <div className="vc-checks">
        {items.map((it, idx) => (
          <div className="vc-check" key={idx}>
            <input
              type="checkbox"
              checked={it.checked}
              aria-label={it.text || `Item ${idx + 1}`}
              onChange={(e) => setItem(idx, { checked: e.target.checked })}
            />
            <input
              className="txt"
              value={it.text}
              placeholder="Item"
              onChange={(e) => setItem(idx, { text: e.target.value })}
            />
            <button
              type="button"
              className="vc-x"
              aria-label="Remove item"
              onClick={() => removeItem(idx)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="vc-additem" onClick={addItem}>
        + Add item
      </button>
      {total > 0 && (
        <div className="vc-count">
          {checked}/{total} done
        </div>
      )}
    </div>
  );
}

// ————— saved (API-wired) —————

interface SavedProps {
  mode: 'saved';
  checklist: Checklist;
}

function SavedChecklist({ checklist }: SavedProps) {
  const [items, setItems] = useState<ChecklistItem[]>(checklist.items);
  const [error, setError] = useState<string | null>(null);

  const checked = items.filter((i) => i.checked).length;

  async function toggle(item: ChecklistItem) {
    const next = !item.checked;
    // Optimistic — flip locally, revert on failure.
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, checked: next } : it)));
    setError(null);
    try {
      await updateChecklistItem(item.id, { checked: next });
    } catch {
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, checked: !next } : it)));
      setError("Couldn't save that change — try again.");
    }
  }

  return (
    <div className="vc-saved">
      <div className="vc-saved-h">
        <span className="vc-saved-title">{checklist.title}</span>
        <span className="vc-count">
          {checked}/{items.length} done
        </span>
      </div>
      <div className="vc-checks">
        {items.map((it) => (
          <label className={`vc-check saved${it.checked ? ' is-checked' : ''}`} key={it.id}>
            <input type="checkbox" checked={it.checked} onChange={() => toggle(it)} />
            <span className="txt-static">{it.text}</span>
            <span aria-hidden="true" />
          </label>
        ))}
      </div>
      {error && <p className="vc-err">{error}</p>}
    </div>
  );
}

export type ChecklistViewProps = ReviewProps | SavedProps;

export function ChecklistView(props: ChecklistViewProps) {
  return props.mode === 'review' ? (
    <ReviewChecklist {...props} />
  ) : (
    <SavedChecklist {...props} />
  );
}
