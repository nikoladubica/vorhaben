// The reusable canvas board + tray (design screen 14). Presentational: it owns the Pointer-Events
// drag mechanics (a placed card follows the pointer and snaps to the 24px grid on release; a tray
// item drags a floating ghost onto the board and is placed on drop) but NO persistence — every
// change is forwarded up via onPlace/onRemove/onFeeling/onTrend/onDropMarkdown. The authenticated
// Canvas page wires these to the API; the public demo wires them to localStorage. The board pieces
// (CanvasCard + the pickers) stay prop-driven so both hosts share the exact same interaction.

import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { CanvasItem, Feeling, Trend } from '../../types';
import { CanvasCard } from './CanvasCard';

const GRID = 24;
const CARD_W = 216;
// Fallback height for clamping a freshly-dropped tray card (its real height is unknown until it
// renders); the board clips any overflow, so a rough value is fine.
const CARD_H_EST = 150;

const snap = (v: number) => Math.round(v / GRID) * GRID;
const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));

// Ghost that follows the pointer while dragging a tray item onto the board.
interface TrayGhost {
  item: CanvasItem;
  left: number;
  top: number;
}

interface CanvasBoardViewProps {
  placed: CanvasItem[];
  tray: CanvasItem[];
  // Called on drop only (a board-card move OR a tray→board placement), with the snapped position.
  onPlace: (projectId: number, x: number, y: number) => void;
  onRemove: (projectId: number) => void;
  onFeeling: (projectId: number, feeling: Feeling | null) => void;
  onTrend: (projectId: number, trend: Trend | null) => void;
  onDropMarkdown: (projectId: number, file: File) => void;
  // Names of notes attached this session, per project — shown as named chips.
  fileChips: Record<number, string[]>;
  // Inline per-card message (rejected drop or a failed update), per project.
  cardErrors: Record<number, string | null>;
  // Demo cards have no real metrics → hide the money line.
  hideValue?: boolean;
  // Chip target per project. Returns a string → chips are links; null → plain spans (demo, no route).
  // Omitted → CanvasCard falls back to /projects/:id.
  chipTo?: (projectId: number) => string | null;
}

export function CanvasBoardView({
  placed,
  tray,
  onPlace,
  onRemove,
  onFeeling,
  onTrend,
  onDropMarkdown,
  fileChips,
  cardErrors,
  hideValue = false,
  chipTo,
}: CanvasBoardViewProps) {
  // Board-card drag: which card is moving and where it currently sits (board-space px).
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  // Tray-to-board drag ghost (client-space top-left), or null when idle.
  const [trayGhost, setTrayGhost] = useState<TrayGhost | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);

  // ————— board-card drag (Pointer Events) —————

  function onCardPointerDown(e: ReactPointerEvent<HTMLDivElement>, item: CanvasItem) {
    // Let the pickers, remove control, chip links, and open menu keep their own clicks.
    if ((e.target as HTMLElement).closest('button, a, .cv-menu')) return;
    const board = boardRef.current;
    if (!board) return;
    e.preventDefault();

    const br = board.getBoundingClientRect();
    const cardEl = e.currentTarget;
    const w = cardEl.offsetWidth;
    const h = cardEl.offsetHeight;
    const startX = item.x ?? 0;
    const startY = item.y ?? 0;
    // Pointer offset within the card, so the grab point stays under the pointer.
    const dx = e.clientX - br.left - startX;
    const dy = e.clientY - br.top - startY;
    const maxX = board.clientWidth - w;
    const maxY = board.clientHeight - h;

    cardEl.setPointerCapture(e.pointerId);
    setDragId(item.project_id);
    setDragPos({ x: startX, y: startY });

    const move = (ev: PointerEvent) => {
      const x = clamp(ev.clientX - br.left - dx, maxX);
      const y = clamp(ev.clientY - br.top - dy, maxY);
      setDragPos({ x, y });
    };

    const up = (ev: PointerEvent) => {
      cardEl.removeEventListener('pointermove', move);
      cardEl.removeEventListener('pointerup', up);
      cardEl.removeEventListener('pointercancel', up);
      setDragId(null);
      setDragPos(null);

      const movedX = clamp(ev.clientX - br.left - dx, maxX);
      const movedY = clamp(ev.clientY - br.top - dy, maxY);
      const x = clamp(snap(movedX), maxX);
      const y = clamp(snap(movedY), maxY);

      // No real move — don't churn a save.
      if (x === startX && y === startY) return;
      onPlace(item.project_id, x, y);
    };

    cardEl.addEventListener('pointermove', move);
    cardEl.addEventListener('pointerup', up);
    cardEl.addEventListener('pointercancel', up);
  }

  // ————— tray-to-board drag (Pointer Events) —————

  function onTrayPointerDown(e: ReactPointerEvent<HTMLDivElement>, item: CanvasItem) {
    e.preventDefault();
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;

    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    setTrayGhost({ item, left: e.clientX - dx, top: e.clientY - dy });

    const move = (ev: PointerEvent) => {
      setTrayGhost({ item, left: ev.clientX - dx, top: ev.clientY - dy });
    };

    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('drag');
      setTrayGhost(null);

      const board = boardRef.current;
      if (!board) return;
      const br = board.getBoundingClientRect();
      const over =
        ev.clientX >= br.left &&
        ev.clientX <= br.right &&
        ev.clientY >= br.top &&
        ev.clientY <= br.bottom;
      if (!over) return;

      const maxX = board.clientWidth - CARD_W;
      const maxY = Math.max(0, board.clientHeight - CARD_H_EST);
      const x = clamp(snap(clamp(ev.clientX - dx - br.left, maxX)), maxX);
      const y = clamp(snap(clamp(ev.clientY - dy - br.top, maxY)), maxY);

      onPlace(item.project_id, x, y);
    };

    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  return (
    <>
      <div className="cv-body">
        <aside className="cv-tray">
          <span className="t">Not on the board</span>
          <p className="hint">
            Drag a project onto the squares. Drop an .md file on a card to attach it as a note.
          </p>
          {tray.length === 0 ? (
            <p className="empty">Every project is on the board.</p>
          ) : (
            tray.map((item) => (
              <div
                key={item.project_id}
                className="tray-item"
                onPointerDown={(e) => onTrayPointerDown(e, item)}
              >
                <b>{item.name}</b>
                <small>
                  {item.type_label}
                  {item.status !== 'active' ? ` · ${item.status}` : ''}
                </small>
              </div>
            ))
          )}
        </aside>

        <div className="cv-board" ref={boardRef} aria-label="Project canvas">
          {placed.length === 0 && (
            <p className="board-empty">Drag a project from the left onto the squares.</p>
          )}
          {placed.map((item) => {
            const dragging = dragId === item.project_id;
            const x = dragging && dragPos ? dragPos.x : (item.x ?? 0);
            const y = dragging && dragPos ? dragPos.y : (item.y ?? 0);
            return (
              <CanvasCard
                key={item.project_id}
                item={item}
                style={{ left: x, top: y }}
                dragging={dragging}
                hideValue={hideValue}
                chipHref={chipTo ? chipTo(item.project_id) : undefined}
                fileChips={fileChips[item.project_id] ?? []}
                fileError={cardErrors[item.project_id] ?? null}
                onFeeling={(f) => onFeeling(item.project_id, f)}
                onTrend={(t) => onTrend(item.project_id, t)}
                onRemove={() => onRemove(item.project_id)}
                onDropMarkdown={(file) => onDropMarkdown(item.project_id, file)}
                onPointerDown={(e) => onCardPointerDown(e, item)}
              />
            );
          })}
        </div>
      </div>

      {trayGhost && (
        <div
          className="cv-tray-ghost tray-item"
          style={{ left: trayGhost.left, top: trayGhost.top }}
          aria-hidden="true"
        >
          <b>{trayGhost.item.name}</b>
          <small>{trayGhost.item.type_label}</small>
        </div>
      )}
    </>
  );
}
