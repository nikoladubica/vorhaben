// Markdown journal panel for the project-detail screen (§3). Every project keeps a set of
// timestamped notes rendered safely via <Markdown> (the client's single security boundary). The
// panel lists notes newest-touched first, opens an inline editor for create/edit (one at a time),
// and hard-deletes behind an inline confirm — notes are user documents, so delete is real, not a
// soft-delete like projects.

import { useEffect, useState } from 'react';
import type { Note } from '../../types';
import { deleteNote, listNotes } from '../../api/notes';
import { Markdown } from '../markdown/Markdown';
import { NoteEditor } from './NoteEditor';

interface NotesSectionProps {
  projectId: number;
}

// A body longer than this collapses behind an Expand toggle; shorter notes render in full.
const LONG_BODY_CHARS = 280;

// Newest-touched first: updated_at desc, id desc as a stable tiebreak — mirrors the server's
// ordering so a create/edit re-sorts locally without a refetch.
function byUpdated(a: Note, b: Note): number {
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return b.id - a.id;
}

// Editor target: 'new' = create a note; a number = edit that note; null = editor closed.
type Editing = 'new' | number | null;

export function NotesSection({ projectId }: NotesSectionProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Editing>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [confirmId, setConfirmId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listNotes(projectId)
      .then((rows) => {
        if (!cancelled) setNotes([...rows].sort(byUpdated));
      })
      .catch(() => {
        if (!cancelled) setError('Could not load notes.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // A saved note (create or edit) merges into the list and re-sorts; the editor then closes.
  function onSaved(saved: Note) {
    setNotes((prev) => {
      const without = prev.filter((n) => n.id !== saved.id);
      return [saved, ...without].sort(byUpdated);
    });
    setEditing(null);
  }

  async function onDelete(id: number) {
    const removed = notes.find((n) => n.id === id);
    setConfirmId(null);
    setNotes((prev) => prev.filter((n) => n.id !== id));
    if (editing === id) setEditing(null);
    try {
      await deleteNote(id);
    } catch {
      // Roll the note back into place on failure.
      if (removed) setNotes((prev) => [removed, ...prev].sort(byUpdated));
      setError('Could not delete this note. Please try again.');
    }
  }

  const summary = `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;

  return (
    <div className="panel notes-panel">
      <div className="panel-h">
        <span className="t">Notes</span>
        <span className="nc-head-r">
          <span className="s num">{summary}</span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setEditing('new')}
            disabled={editing === 'new'}
          >
            New note
          </button>
        </span>
      </div>
      <div className="panel-b" style={{ paddingTop: 14 }}>
        {editing === 'new' && (
          <div className="note-editor-wrap">
            <NoteEditor
              projectId={projectId}
              onSaved={onSaved}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}

        {loading ? (
          <p className="table-empty">Loading…</p>
        ) : error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : notes.length === 0 && editing !== 'new' ? (
          <p className="table-empty">No notes yet. Start a journal for this project.</p>
        ) : (
          <div className="note-list">
            {notes.map((note) =>
              editing === note.id ? (
                <div key={note.id} className="note-editor-wrap">
                  <NoteEditor
                    projectId={projectId}
                    note={note}
                    onSaved={onSaved}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : (
                <article key={note.id} className="note-card">
                  <div className="nc-h">
                    <span className="nc-t">{note.title}</span>
                    <span className="nc-d">{new Date(note.updated_at).toLocaleString()}</span>
                  </div>
                  <div
                    className={
                      note.body_md.length > LONG_BODY_CHARS && !expanded.has(note.id)
                        ? 'md-clamp'
                        : undefined
                    }
                  >
                    <Markdown source={note.body_md} />
                  </div>
                  <div className="nc-actions">
                    {note.body_md.length > LONG_BODY_CHARS && (
                      <button
                        type="button"
                        className="row-btn"
                        aria-expanded={expanded.has(note.id)}
                        onClick={() => toggleExpanded(note.id)}
                      >
                        {expanded.has(note.id) ? 'Collapse' : 'Expand'}
                      </button>
                    )}
                    <span className="nc-actions-end">
                      <button
                        type="button"
                        className="row-btn"
                        onClick={() => {
                          setConfirmId(null);
                          setEditing(note.id);
                        }}
                      >
                        Edit
                      </button>
                      {confirmId === note.id ? (
                        <span className="row-confirm">
                          Delete “{note.title}”?
                          <button
                            type="button"
                            className="row-btn danger"
                            onClick={() => onDelete(note.id)}
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
                          aria-label={`Delete note “${note.title}”`}
                          onClick={() => setConfirmId(note.id)}
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  </div>
                </article>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
