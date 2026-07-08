// Inline note editor for the journal panel — a compact title + Markdown-textarea form with a
// Write / Preview two-tab toggle (only one pane visible at a time; this is the panel editor, not
// the split-pane screen-10 layout). Preview renders through the SAME <Markdown> component the
// saved card uses, so what you preview is exactly what you get. `note` undefined = create mode.
//
// Text is sent verbatim: title/body_md go to the server untouched. Server field errors map to
// inline copy (422 title invalid, 413 body_md too_long). A dirty draft guards against loss —
// Cancel confirms and a beforeunload listener catches tab close/reload.

import { useEffect, useState } from 'react';
import { ApiError } from '../../api';
import type { Note, NoteInput } from '../../types';
import { createNote, updateNote } from '../../api/notes';
import { Markdown } from '../markdown/Markdown';

interface NoteEditorProps {
  projectId: number;
  // Undefined → create a new note; otherwise edit this one.
  note?: Note;
  onSaved: (note: Note) => void;
  onCancel: () => void;
}

type Tab = 'write' | 'preview';

// Translate a server field-error code into gentle inline copy (mirrors EntriesSection.fieldMessage).
function fieldMessage(field: string, code: string): string {
  if (field === 'title') return 'Enter a title.';
  if (field === 'body_md') return code === 'too_long' ? 'This note is too long.' : 'Not valid.';
  return 'Not valid.';
}

function firstError(errors: Record<string, string>): string | null {
  const [field, code] = Object.entries(errors)[0] ?? [];
  return field ? fieldMessage(field, code) : null;
}

export function NoteEditor({ projectId, note, onSaved, onCancel }: NoteEditorProps) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body_md ?? '');
  const [tab, setTab] = useState<Tab>('write');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Dirty = draft diverges from the initial values (empty strings in create mode).
  const dirty = title !== (note?.title ?? '') || body !== (note?.body_md ?? '');

  // Warn on tab close / reload while there are unsaved changes; cleaned up when clean or unmounted.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    // Client-side guard for the one required field; the server is still the authority.
    if (title.trim() === '') {
      setErrors({ title: 'required' });
      return;
    }
    setErrors({});
    setSaving(true);

    // Sent verbatim — server trims the title and stores body_md byte-for-byte.
    const payload: NoteInput = { title, body_md: body };
    try {
      const saved = note
        ? await updateNote(note.id, payload)
        : await createNote(projectId, payload);
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      else setError('Could not save this note. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function onCancelClick() {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    onCancel();
  }

  const message = error ?? firstError(errors);

  return (
    <form className="note-editor" onSubmit={onSave}>
      <input
        className="ne-title"
        type="text"
        value={title}
        placeholder="Note title — e.g. Rate review"
        onChange={(e) => setTitle(e.target.value)}
        aria-label="Note title"
        aria-invalid={errors.title ? true : undefined}
        autoFocus
      />

      <div className="ne-tabs" role="tablist" aria-label="Editor mode">
        <button
          type="button"
          className="btn ghost sm"
          role="tab"
          aria-selected={tab === 'write'}
          data-on={tab === 'write' ? true : undefined}
          onClick={() => setTab('write')}
        >
          Write
        </button>
        <button
          type="button"
          className="btn ghost sm"
          role="tab"
          aria-selected={tab === 'preview'}
          data-on={tab === 'preview' ? true : undefined}
          onClick={() => setTab('preview')}
        >
          Preview
        </button>
      </div>

      {tab === 'write' ? (
        <textarea
          className="ne-src"
          value={body}
          placeholder="Write in Markdown — headings, lists, tables, `code`, [links](https://…)"
          onChange={(e) => setBody(e.target.value)}
          aria-label="Note body (Markdown)"
          aria-invalid={errors.body_md ? true : undefined}
        />
      ) : body.trim() === '' ? (
        <p className="ne-empty">Nothing to preview yet.</p>
      ) : (
        <Markdown source={body} />
      )}

      {message && (
        <p className="field-error" role="alert">
          {message}
        </p>
      )}

      <div className="ne-actions">
        <button className="btn primary sm" type="submit" disabled={saving}>
          {note ? 'Save changes' : 'Save note'}
        </button>
        <button className="btn ghost sm" type="button" onClick={onCancelClick}>
          Cancel
        </button>
      </div>
    </form>
  );
}
