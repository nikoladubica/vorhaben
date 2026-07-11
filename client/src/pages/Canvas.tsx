// Canvas board (design screen 14). A spatial layer over the projects: lay cards out like paper,
// annotate each with a feeling and a trend, and attach Markdown notes by dropping .md files — none
// of which ever changes the project's numbers. This page owns ALL state and API calls; the board
// itself lives in CanvasBoardView (shared with the public localStorage demo) and stays presentational
// and prop-driven.
//
// Dragging is Pointer Events only (no DnD library) and is owned by CanvasBoardView: a placed card
// follows the pointer and, on release, snaps to the 24px grid; a tray item drags a ghost onto the
// board and, on release over it, is placed. Both call back into onPlace here, which PUTs the position
// once and rolls back on error. Feeling/trend/placement/removal all update state optimistically.

import { useEffect, useState } from 'react';
import type { CanvasItem, Feeling, LinkType, NoteListItem, ProjectLink, Trend } from '../types';
import {
  createLink,
  deleteLink,
  getCanvas,
  placeProject,
  removeFromBoard,
  updateLinkType,
} from '../api/canvas';
import { setProjectFeeling, setProjectTrend } from '../api/projects';
import { createNote, listAllNotes } from '../api/notes';
import { ApiError } from '../api';
import { CanvasBoardView } from '../components/canvas/CanvasBoardView';
import { useAuth } from '../auth/useAuth';
import { clearCanvasHint, isCanvasHintPending } from '../onboarding';
import './canvas.css';

// localStorage key for the view-only "Show notes" overlay preference (nothing is written server-side).
const SHOW_NOTES_KEY = 'vorhaben:canvas:show-notes';

export function Canvas() {
  const auth = useAuth();
  const userId = auth.status === 'user' ? auth.user.id : null;

  const [placed, setPlaced] = useState<CanvasItem[]>([]);
  const [tray, setTray] = useState<CanvasItem[]>([]);
  const [links, setLinks] = useState<ProjectLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Notes overlay (view-only): the switch state sticks in localStorage; the notes themselves are
  // fetched once, lazily, the first time the overlay is turned on (or on load if it was left on).
  const [showNotes, setShowNotes] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_NOTES_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [notesByProject, setNotesByProject] = useState<Record<number, NoteListItem[]>>({});
  const [notesLoaded, setNotesLoaded] = useState(false);

  // One-time "set today's mood" hint (ticket 03), armed when the first project is created via the
  // welcome flow. Shown once, retired on dismiss — never animated, never resurrected.
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    if (userId !== null && isCanvasHintPending(userId)) setShowHint(true);
  }, [userId]);

  function dismissHint() {
    if (userId !== null) clearCanvasHint(userId);
    setShowHint(false);
  }

  // Names of notes attached this session, per project — shown as named chips.
  const [fileChips, setFileChips] = useState<Record<number, string[]>>({});
  // Inline per-card message (rejected drop or a failed optimistic update), per project.
  const [cardErrors, setCardErrors] = useState<Record<number, string | null>>({});

  // ————— initial load —————
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    getCanvas()
      .then((board) => {
        if (!alive) return;
        setPlaced(board.placed);
        setTray(board.tray);
        setLinks(board.links);
      })
      .catch(() => {
        if (alive) setLoadError('Could not load your canvas. Please try again.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Fetch the cross-project notes once, lazily — the first time the overlay is on (either toggled
  // now or restored on from a previous session). A pure view toggle: nothing is written server-side.
  useEffect(() => {
    if (!showNotes || notesLoaded) return;
    let alive = true;
    listAllNotes()
      .then((all) => {
        if (!alive) return;
        const grouped: Record<number, NoteListItem[]> = {};
        for (const note of all) {
          (grouped[note.project_id] ??= []).push(note);
        }
        setNotesByProject(grouped);
        setNotesLoaded(true);
      })
      .catch(() => {
        // Leave the overlay empty on failure — the switch still works, just no chips appear.
      });
    return () => {
      alive = false;
    };
  }, [showNotes, notesLoaded]);

  function handleToggleNotes(next: boolean) {
    setShowNotes(next);
    try {
      localStorage.setItem(SHOW_NOTES_KEY, next ? '1' : '0');
    } catch {
      // Storage unavailable — the toggle still works this session, it just won't persist.
    }
  }

  // ————— state helpers —————

  function patchItem(id: number, patch: Partial<CanvasItem>) {
    setPlaced((prev) => prev.map((it) => (it.project_id === id ? { ...it, ...patch } : it)));
    setTray((prev) => prev.map((it) => (it.project_id === id ? { ...it, ...patch } : it)));
  }

  function moveToBoard(item: CanvasItem, x: number, y: number) {
    setTray((prev) => prev.filter((it) => it.project_id !== item.project_id));
    setPlaced((prev) => [
      ...prev.filter((it) => it.project_id !== item.project_id),
      { ...item, x, y },
    ]);
  }

  function moveToTray(item: CanvasItem) {
    setPlaced((prev) => prev.filter((it) => it.project_id !== item.project_id));
    setTray((prev) => [
      ...prev.filter((it) => it.project_id !== item.project_id),
      { ...item, x: undefined, y: undefined },
    ]);
  }

  function setCardError(id: number, message: string | null) {
    setCardErrors((prev) => ({ ...prev, [id]: message }));
  }

  function findItem(id: number): CanvasItem | undefined {
    return placed.find((it) => it.project_id === id) ?? tray.find((it) => it.project_id === id);
  }

  // ————— placement (board move OR tray→board), optimistic —————

  function handlePlace(id: number, x: number, y: number) {
    const item = findItem(id);
    if (!item) return;
    const fromTray = tray.some((it) => it.project_id === id);
    const startX = item.x ?? 0;
    const startY = item.y ?? 0;

    if (fromTray) {
      moveToBoard(item, x, y);
      placeProject(id, x, y).catch(() => {
        moveToTray(item);
        setCardError(id, 'Could not place this project. Please try again.');
      });
    } else {
      patchItem(id, { x, y });
      placeProject(id, x, y).catch(() => {
        patchItem(id, { x: startX, y: startY });
        setCardError(id, 'Could not save the new position. Please try again.');
      });
    }
  }

  // ————— feeling / trend (optimistic) —————

  function handleFeeling(id: number, feeling: Feeling | null) {
    const item = findItem(id);
    if (!item) return;
    const prev = item.feeling;
    if (prev === feeling) return;
    patchItem(id, { feeling });
    setCardError(id, null);
    setProjectFeeling(id, feeling).catch(() => {
      patchItem(id, { feeling: prev });
      setCardError(id, 'Could not save the feeling. Please try again.');
    });
  }

  function handleTrend(id: number, trend: Trend | null) {
    const item = findItem(id);
    if (!item) return;
    const prev = item.trend;
    if (prev === trend) return;
    patchItem(id, { trend });
    setCardError(id, null);
    setProjectTrend(id, trend).catch(() => {
      patchItem(id, { trend: prev });
      setCardError(id, 'Could not save the trend. Please try again.');
    });
  }

  // ————— remove (optimistic) —————

  function handleRemove(id: number) {
    const item = findItem(id);
    if (!item) return;
    const startX = item.x ?? 0;
    const startY = item.y ?? 0;
    moveToTray(item);
    removeFromBoard(id).catch(() => {
      moveToBoard(item, startX, startY);
      setCardError(id, 'Could not remove this card. Please try again.');
    });
  }

  // ————— connections (links) —————

  // Create: POST first (the id is the server's), then append. The source card carries the inline
  // error on a rejection so the user sees why the line did not appear.
  function handleLinkCreate(fromId: number, toId: number, type: LinkType) {
    setCardError(fromId, null);
    createLink(fromId, toId, type)
      .then((link) => {
        setLinks((prev) => [...prev, link]);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 409) {
          setCardError(fromId, 'These projects are already connected.');
        } else if (
          err instanceof ApiError &&
          err.status === 422 &&
          err.fields?.to_project_id === 'cycle'
        ) {
          setCardError(fromId, 'That would make a project its own ancestor.');
        } else {
          setCardError(fromId, 'Could not connect these projects. Please try again.');
        }
      });
  }

  // Change type in place, optimistic with rollback (like feeling/trend).
  function handleLinkType(linkId: number, type: LinkType) {
    const prev = links.find((l) => l.id === linkId);
    if (!prev || prev.type === type) return;
    setLinks((ls) => ls.map((l) => (l.id === linkId ? { ...l, type } : l)));
    updateLinkType(linkId, type).catch((err) => {
      setLinks((ls) => ls.map((l) => (l.id === linkId ? prev : l)));
      const cycle =
        err instanceof ApiError && err.status === 422 && err.fields?.to_project_id === 'cycle';
      setCardError(
        prev.from_project_id,
        cycle
          ? 'That would make a project its own ancestor.'
          : 'Could not change the connection. Please try again.',
      );
    });
  }

  // Remove, optimistic with rollback. The row is soft-deleted server-side, not destroyed.
  function handleLinkRemove(linkId: number) {
    const prev = links.find((l) => l.id === linkId);
    if (!prev) return;
    setLinks((ls) => ls.filter((l) => l.id !== linkId));
    deleteLink(linkId).catch(() => {
      setLinks((ls) => [...ls, prev]);
      setCardError(prev.from_project_id, 'Could not remove the connection. Please try again.');
    });
  }

  // ————— Markdown drop —————

  function handleDropMarkdown(id: number, file: File) {
    const item = findItem(id);
    if (!item) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.md') && !lower.endsWith('.markdown')) {
      setCardError(id, 'Only Markdown files can be attached.');
      return;
    }
    setCardError(id, null);

    const reader = new FileReader();
    reader.onload = () => {
      const body = typeof reader.result === 'string' ? reader.result : '';
      const title = file.name.replace(/\.(md|markdown)$/i, '');
      createNote(id, { title, body_md: body })
        .then(() => {
          setFileChips((prev) => ({
            ...prev,
            [id]: [...(prev[id] ?? []), file.name],
          }));
          patchItem(id, { note_count: item.note_count + 1 });
        })
        .catch(() => {
          setCardError(id, 'Could not attach this note. Please try again.');
        });
    };
    reader.onerror = () => {
      setCardError(id, 'Could not read that file. Please try again.');
    };
    reader.readAsText(file);
  }

  // ————— render —————

  return (
    <div>
      <div className="dash-head">
        <h3>Canvas</h3>
      </div>

      {showHint && (
        <div className="canvas-hint" role="note">
          <div className="ch-body">
            <p className="ch-k">Start here</p>
            <p className="ch-t">
              Set today’s mood for this project. Change it any time it changes — every change is
              kept.
            </p>
          </div>
          <button type="button" className="ch-x" aria-label="Dismiss hint" onClick={dismissHint}>
            ×
          </button>
        </div>
      )}

      <div className="panel">
        <div className="cv-promo">
          <span className="k">Try our canvas tool</span>
          <p>
            Lay your projects out like paper. Feeling is how it feels, trend is how it’s going — the
            canvas never changes your numbers.
          </p>
        </div>

        {loading ? (
          <p style={{ padding: 24, fontSize: 13, color: 'var(--ink-2)' }}>Loading…</p>
        ) : loadError ? (
          <p role="alert" style={{ padding: 24, fontSize: 13, color: 'var(--ink)' }}>
            {loadError}
          </p>
        ) : (
          <CanvasBoardView
            placed={placed}
            tray={tray}
            hideValue={false}
            chipTo={(id) => `/projects/${id}`}
            fileChips={fileChips}
            cardErrors={cardErrors}
            onPlace={handlePlace}
            onRemove={handleRemove}
            onFeeling={handleFeeling}
            onTrend={handleTrend}
            onDropMarkdown={handleDropMarkdown}
            links={links}
            onLinkCreate={handleLinkCreate}
            onLinkType={handleLinkType}
            onLinkRemove={handleLinkRemove}
            showNotes={showNotes}
            onToggleNotes={handleToggleNotes}
            notesByProject={notesByProject}
          />
        )}
      </div>
    </div>
  );
}
