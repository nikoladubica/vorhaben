// Standalone notes browser (design screen 10) — a cross-project Markdown journal with a live
// write-left / read-right split. The rail lists every note grouped by project; the right pane is a
// split editor whose preview renders through the SAME <Markdown> component the per-project card
// uses, so the single-sanitization-sink invariant holds (the client's one raw-HTML injection
// point stays in Markdown.tsx).
//
// Persistence is debounced autosave, no Save button: ~700ms after typing stops (and on blur) we
// PATCH the note. A monotonic edit sequence guards against stale/overlapping saves — a response is
// only allowed to flip the indicator to "Saved" when no newer edit has landed since it started.
// A blank "New" draft lives only in memory until it has a project + a title, then it is created.

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { NoteListItem, Project } from '../types';
import { createNote, deleteNote, listAllNotes, updateNote } from '../api/notes';
import { listProjects } from '../api/projects';
import { Markdown } from '../components/markdown/Markdown';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'paused';

// Debounce window for autosave — long enough to coalesce a burst of keystrokes, short enough that
// "Saved" lands while the thought is still fresh.
const SAVE_DELAY_MS = 700;

// Rail date: user-locale calendar date (design shows 28.06.2026). ISO timestamp → Date.
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

// Saved-indicator timestamp: user-locale date + time (design shows 28.06.2026, 14:32).
function formatDateTime(d: Date): string {
  return d.toLocaleString();
}

export function NotesPage() {
  // ————— rail —————
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ————— selection / editor —————
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [newProjectId, setNewProjectId] = useState<number | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  // ————— save indicator —————
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Refs mirror the editor so the debounced closure always reads the latest values (state would be
  // stale inside a setTimeout). currentNoteRef holds the persisted note, null for a fresh draft.
  const titleRef = useRef('');
  const bodyRef = useRef('');
  const projectIdRef = useRef<number | null>(null);
  const isNewRef = useRef(false);
  const currentNoteRef = useRef<NoteListItem | null>(null);

  // Stale-save guard: every edit bumps editSeq; a save snapshots it and may only report "Saved"
  // (and clear the pending flag) when no newer edit has landed. savedSeq marks the last persisted
  // sequence, so editSeq !== savedSeq means there are unsaved edits.
  const editSeqRef = useRef(0);
  const savedSeqRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingAgainRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  // ————— initial load: notes rail + project list for the New selector —————
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    listAllNotes()
      .then((rows) => {
        if (!alive) return;
        setNotes(rows);
        if (rows.length > 0) openNote(rows[0]);
      })
      .catch(() => {
        if (alive) setLoadError('Could not load your notes. Please try again.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    listProjects()
      .then((rows) => {
        if (alive) setProjects(rows);
      })
      .catch(() => {
        /* selector just stays empty; New can't save until a project exists */
      });
    return () => {
      alive = false;
      clearTimer();
    };
    // Mount-only; openNote/clearTimer are stable enough for this one-shot bootstrap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warn on tab close / reload while a save is pending, in flight, or a project-less draft has
  // content — reading refs so the listener never needs re-subscribing (mirrors NoteEditor).
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const pending = editSeqRef.current !== savedSeqRef.current;
      const draftWithContent =
        isNewRef.current &&
        projectIdRef.current == null &&
        (titleRef.current.trim() !== '' || bodyRef.current.trim() !== '');
      if (pending || savingRef.current || draftWithContent) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // ————— editor loaders —————

  // Open a persisted note: a fresh baseline (no unsaved edits), shown as already saved.
  function openNote(note: NoteListItem) {
    clearTimer();
    isNewRef.current = false;
    currentNoteRef.current = note;
    titleRef.current = note.title;
    bodyRef.current = note.body_md;
    projectIdRef.current = null;
    editSeqRef.current += 1;
    savedSeqRef.current = editSeqRef.current;
    setIsNew(false);
    setSelectedId(note.id);
    setTitle(note.title);
    setBody(note.body_md);
    setNewProjectId(null);
    setActionError(null);
    setSaveStatus('saved');
    setSavedAt(new Date(note.updated_at));
  }

  // Open a blank in-memory draft — nothing hits the server until it has a project and a title.
  function openNewDraft() {
    clearTimer();
    isNewRef.current = true;
    currentNoteRef.current = null;
    titleRef.current = '';
    bodyRef.current = '';
    projectIdRef.current = null;
    editSeqRef.current += 1;
    savedSeqRef.current = editSeqRef.current;
    setIsNew(true);
    setSelectedId(null);
    setTitle('');
    setBody('');
    setNewProjectId(null);
    setActionError(null);
    setSaveStatus('paused');
    setSavedAt(null);
  }

  // Clear the pane entirely (e.g. after deleting the last note).
  function clearPane() {
    clearTimer();
    isNewRef.current = false;
    currentNoteRef.current = null;
    titleRef.current = '';
    bodyRef.current = '';
    projectIdRef.current = null;
    editSeqRef.current += 1;
    savedSeqRef.current = editSeqRef.current;
    setIsNew(false);
    setSelectedId(null);
    setTitle('');
    setBody('');
    setNewProjectId(null);
    setSaveStatus('idle');
    setSavedAt(null);
  }

  // Before moving to another note (or a new draft): flush a pending save so nothing is lost, but
  // silently discard a project-less draft — nothing was ever created.
  function leaveCurrent() {
    clearTimer();
    if (isNewRef.current && projectIdRef.current == null) return; // discard blank draft
    if (editSeqRef.current !== savedSeqRef.current) void runSave();
  }

  // ————— autosave —————

  function scheduleSave() {
    clearTimer();
    if (isNewRef.current && projectIdRef.current == null) {
      setSaveStatus('paused');
      return;
    }
    // The server requires a title; without one we keep the draft locally and wait (no failed call).
    if (titleRef.current.trim() === '') {
      setSaveStatus('idle');
      return;
    }
    saveTimerRef.current = setTimeout(() => void runSave(), SAVE_DELAY_MS);
  }

  // Persist the current editor. Serialized via savingRef (no overlapping writes, so a draft is
  // never double-created); a queued follow-up runs once the in-flight save settles.
  async function runSave() {
    clearTimer();
    const seq = editSeqRef.current;
    const nextTitle = titleRef.current;
    const nextBody = bodyRef.current;
    const creating = isNewRef.current;
    const projectId = projectIdRef.current;
    const note = currentNoteRef.current;

    if (creating && projectId == null) {
      setSaveStatus('paused');
      return;
    }
    if (nextTitle.trim() === '') return; // nothing valid to persist yet
    if (savingRef.current) {
      pendingAgainRef.current = true;
      return;
    }

    savingRef.current = true;
    setSaveStatus('saving');
    setActionError(null);
    try {
      if (creating && note == null && projectId != null) {
        const saved = await createNote(projectId, { title: nextTitle, body_md: nextBody });
        // Re-fetch the rail so grouping/order stays authoritative, then adopt the created row.
        const fresh = await listAllNotes();
        setNotes(fresh);
        const created = fresh.find((n) => n.id === saved.id) ?? null;
        // Only swap the pane to the created note if the user is still on this draft; if they moved
        // on mid-save, leave their current view alone (we still refreshed the rail).
        if (created && isNewRef.current && currentNoteRef.current == null) {
          isNewRef.current = false;
          currentNoteRef.current = created;
          projectIdRef.current = null;
          setIsNew(false);
          setSelectedId(saved.id);
          setNewProjectId(null);
          if (seq === editSeqRef.current) {
            savedSeqRef.current = seq;
            setSaveStatus('saved');
            setSavedAt(new Date());
          }
        }
      } else if (note != null) {
        const saved = await updateNote(note.id, { title: nextTitle, body_md: nextBody });
        currentNoteRef.current = { ...note, ...saved };
        // Patch the rail row in place (no re-sort — reordering on every keystroke would be jarring).
        setNotes((prev) =>
          prev.map((n) =>
            n.id === saved.id
              ? { ...n, title: saved.title, body_md: saved.body_md, updated_at: saved.updated_at }
              : n,
          ),
        );
        if (seq === editSeqRef.current) {
          savedSeqRef.current = seq;
          setSaveStatus('saved');
          setSavedAt(new Date());
        }
      }
    } catch {
      // Keep the draft; the pending flag stays set so the next keystroke/blur retries.
      setSaveStatus('error');
    } finally {
      savingRef.current = false;
      if (pendingAgainRef.current) {
        pendingAgainRef.current = false;
        void runSave();
      }
    }
  }

  // ————— edit handlers —————

  function onTitleChange(value: string) {
    titleRef.current = value;
    editSeqRef.current += 1;
    setTitle(value);
    scheduleSave();
  }

  function onBodyChange(value: string) {
    bodyRef.current = value;
    editSeqRef.current += 1;
    setBody(value);
    scheduleSave();
  }

  function onProjectChange(value: string) {
    const id = value ? Number(value) : null;
    projectIdRef.current = id;
    editSeqRef.current += 1;
    setNewProjectId(id);
    scheduleSave();
  }

  function flushNow() {
    if (editSeqRef.current !== savedSeqRef.current) void runSave();
  }

  // ————— rail interactions —————

  function onSelectRow(note: NoteListItem) {
    if (!isNew && note.id === selectedId) return;
    leaveCurrent();
    openNote(note);
  }

  function onNew() {
    leaveCurrent();
    openNewDraft();
  }

  async function onDelete() {
    const note = currentNoteRef.current;
    if (!note || isNew) return;
    if (!window.confirm(`Delete “${note.title || 'Untitled'}”? This can’t be undone.`)) return;

    clearTimer();
    const list = notes;
    const idx = list.findIndex((n) => n.id === note.id);
    const next = list.filter((n) => n.id !== note.id);
    setNotes(next);
    // Select the following note (now at the same index), else the previous, else clear the pane.
    const nextSel = next[idx] ?? next[idx - 1] ?? null;
    if (nextSel) openNote(nextSel);
    else clearPane();

    try {
      await deleteNote(note.id);
    } catch {
      // Roll back the optimistic removal and re-select the note.
      setNotes(list);
      openNote(note);
      setActionError('Could not delete this note. Please try again.');
    }
  }

  // ————— derived render values —————
  const savedText =
    saveStatus === 'saving'
      ? 'Saving…'
      : saveStatus === 'error'
        ? 'Couldn’t save — retrying'
        : saveStatus === 'paused'
          ? 'Pick a project to start saving'
          : saveStatus === 'saved' && savedAt
            ? `Saved · ${formatDateTime(savedAt)}`
            : '';

  const showEditor = isNew || selectedId != null;

  return (
    <div>
      <div className="dash-head">
        <h3>Notes</h3>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="notes-grid">
          <div className="nlist">
            <div className="nl-h">
              <span className="t">All notes</span>
              <button
                className="btn ghost sm"
                type="button"
                style={{ padding: '6px 12px' }}
                onClick={onNew}
              >
                New
              </button>
            </div>

            {loading ? (
              <p className="nl-empty">Loading…</p>
            ) : loadError ? (
              <p className="nl-empty" role="alert">
                {loadError}
              </p>
            ) : notes.length === 0 ? (
              <p className="nl-empty">No notes yet. Start one with New.</p>
            ) : (
              notes.map((n, i) => {
                const showGroup = i === 0 || notes[i - 1].project_name !== n.project_name;
                const on = !isNew && n.id === selectedId;
                return (
                  <Fragment key={n.id}>
                    {showGroup && <div className="nl-group">{n.project_name}</div>}
                    <button
                      type="button"
                      className={on ? 'nl-item on' : 'nl-item'}
                      aria-current={on ? 'true' : undefined}
                      onClick={() => onSelectRow(n)}
                    >
                      <span className="t">{n.title || 'Untitled'}</span>
                      <span className="s">{formatDate(n.updated_at)}</span>
                    </button>
                  </Fragment>
                );
              })
            )}
          </div>

          <div className="ed">
            {!showEditor ? (
              <div className="ed-empty">
                <p>Select a note, or start a new one.</p>
                <button className="btn ghost sm" type="button" onClick={onNew}>
                  New note
                </button>
              </div>
            ) : (
              <>
                <div className="ed-bar">
                  <input
                    className="ed-title"
                    type="text"
                    value={title}
                    placeholder="Note title"
                    aria-label="Note title"
                    onChange={(e) => onTitleChange(e.target.value)}
                    onBlur={flushNow}
                  />
                  {isNew && (
                    <select
                      className="ed-project"
                      value={newProjectId ?? ''}
                      aria-label="Project"
                      required
                      onChange={(e) => onProjectChange(e.target.value)}
                    >
                      <option value="" disabled>
                        Choose a project…
                      </option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <span className="saved" aria-live="polite">
                    {savedText}
                  </span>
                  {!isNew && (
                    <button
                      className="btn ghost sm"
                      type="button"
                      style={{ padding: '6px 14px' }}
                      onClick={onDelete}
                    >
                      Delete
                    </button>
                  )}
                </div>

                {actionError && (
                  <p className="field-error" role="alert" style={{ padding: '8px 20px 0' }}>
                    {actionError}
                  </p>
                )}

                <div className="ed-panes">
                  <textarea
                    className="ed-src"
                    value={body}
                    placeholder="Write in Markdown — headings, lists, tables, `code`, [links](https://…)"
                    aria-label="Markdown source"
                    spellCheck={false}
                    onChange={(e) => onBodyChange(e.target.value)}
                    onBlur={flushNow}
                  />
                  <div className="ed-prev">
                    <div className="plabel">Preview</div>
                    <Markdown source={body} />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
