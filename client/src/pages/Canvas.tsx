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
import type { CanvasItem, Feeling, Trend } from '../types';
import { getCanvas, placeProject, removeFromBoard } from '../api/canvas';
import { setProjectFeeling, setProjectTrend } from '../api/projects';
import { createNote } from '../api/notes';
import { CanvasBoardView } from '../components/canvas/CanvasBoardView';
import './canvas.css';

export function Canvas() {
  const [placed, setPlaced] = useState<CanvasItem[]>([]);
  const [tray, setTray] = useState<CanvasItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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
          />
        )}
      </div>
    </div>
  );
}
