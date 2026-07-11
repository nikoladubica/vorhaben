// The reusable canvas board + tray (design screen 14). Presentational: it owns the Pointer-Events
// drag mechanics (a placed card follows the pointer and snaps to the 24px grid on release; a tray
// item drags a floating ghost onto the board and is placed on drop) but NO persistence — every
// change is forwarded up via onPlace/onRemove/onFeeling/onTrend/onDropMarkdown. The authenticated
// Canvas page wires these to the API; the public demo wires them to localStorage. The board pieces
// (CanvasCard + the pickers) stay prop-driven so both hosts share the exact same interaction.
//
// Connections (ticket 09): typed project-to-project links are drawn as lines in an SVG layer BENEATH
// the cards; dragging a card's edge handle onto another card opens a type picker that creates a real
// project_links row. A view-only "Show notes" switch fans each placed card's notes out as read-only
// satellite chips. Every link/notes prop is OPTIONAL, so the public TryCanvasPage compiles and
// behaves exactly as before — no handle, no line layer, no switch. No red anywhere in this feature.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CanvasItem, Feeling, LinkType, NoteListItem, ProjectLink, Trend } from '../../types';
import { CanvasCard } from './CanvasCard';
import { LinkPopover } from './LinkPopover';
import { findFreeSpot } from './layout';
import type { Rect } from './layout';

const GRID = 24;
const CARD_W = 216;
// Fallback height for clamping a freshly-dropped tray card (its real height is unknown until it
// renders); the board clips any overflow, so a rough value is fine.
const CARD_H_EST = 150;

// Notes overlay: at most 6 satellite chips per card, fanned around it (top, then clockwise). The
// last slot collapses into "+N more" when a card carries more than 6 notes. The nominal chip box is
// used only for the "stays on the board" bounds test — real chip width varies with the title.
const SAT_MAX = 6;
const SAT_W = 152;
const SAT_H = 22;
const SAT_TITLE_MAX = 24;
const SAT_ANGLES = [-90, -35, 35, 90, 145, -145]; // degrees: top, upper-right … upper-left

const snap = (v: number) => Math.round(v / GRID) * GRID;
const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function typeLabel(type: LinkType): string {
  return type === 'parent' ? 'PARENT' : 'BLOCKS';
}

// Ghost that follows the pointer while dragging a tray item onto the board.
interface TrayGhost {
  item: CanvasItem;
  left: number;
  top: number;
}

// In-progress link drag from a card's edge handle: the source project plus the pointer position in
// board-space px.
interface LinkDrag {
  fromId: number;
  x: number;
  y: number;
}

// The type picker shown after dropping the link on a target card (create flow).
interface LinkPicker {
  fromId: number;
  toId: number;
  x: number;
  y: number;
}

// The edit popover shown when the midpoint label of an existing link is clicked.
interface LinkEdit {
  linkId: number;
  x: number;
  y: number;
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

  // ————— connections (ticket 09) — all optional so the demo is untouched —————
  // Live project links; only those whose BOTH endpoints are currently placed are drawn.
  links?: ProjectLink[];
  // Drag A's handle onto B and pick a type → onLinkCreate(A, B, type). Presence of this callback is
  // what turns the edge handles on.
  onLinkCreate?: (fromId: number, toId: number, type: LinkType) => void;
  // Change an existing link's type in place (from the midpoint popover).
  onLinkType?: (linkId: number, type: LinkType) => void;
  // Remove an existing link (from the midpoint popover).
  onLinkRemove?: (linkId: number) => void;

  // ————— notes overlay (ticket 09) — all optional —————
  // When onToggleNotes is provided, the board header renders a "Show notes" switch reflecting
  // showNotes; the host owns the toggle (localStorage) and fetches the notes when it turns on.
  showNotes?: boolean;
  onToggleNotes?: (next: boolean) => void;
  // Notes to fan around each card, keyed by project id. Only read while showNotes is true.
  notesByProject?: Record<number, NoteListItem[]>;
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
  links,
  onLinkCreate,
  onLinkType,
  onLinkRemove,
  showNotes = false,
  onToggleNotes,
  notesByProject,
}: CanvasBoardViewProps) {
  // Board-card drag: which card is moving and where it currently sits (board-space px).
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  // Tray-to-board drag ghost (client-space top-left), or null when idle.
  const [trayGhost, setTrayGhost] = useState<TrayGhost | null>(null);
  // Where the dragged card will actually land (resolved through findFreeSpot), sized to the dragged
  // card. Drawn as a quiet dashed outline during a drag; null when idle.
  const [dropTarget, setDropTarget] = useState<Rect | null>(null);

  // Link drag + the two popovers (create / edit). All null when idle.
  const [linkDrag, setLinkDrag] = useState<LinkDrag | null>(null);
  const [linkTargetId, setLinkTargetId] = useState<number | null>(null);
  const [linkPicker, setLinkPicker] = useState<LinkPicker | null>(null);
  const [linkEdit, setLinkEdit] = useState<LinkEdit | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);
  // Rendered card roots, keyed by project_id — used to measure real sizes for collision, since card
  // heights depend on content (feeling/trend rows, chips) and only the client knows them.
  const cardEls = useRef<Map<number, HTMLDivElement>>(new Map());
  // Measured card sizes mirrored into state so the SVG line layer + satellites re-render as heights
  // settle (a plain ref would not trigger a paint). Kept in sync via a ResizeObserver per card.
  const [cardSizes, setCardSizes] = useState<Record<number, { w: number; h: number }>>({});
  const cardObservers = useRef<Map<number, ResizeObserver>>(new Map());
  // Board pixel size, measured, for the satellite "stays on the board" test and the SVG extent.
  const [boardSize, setBoardSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  function setCardEl(projectId: number, el: HTMLDivElement | null) {
    const prevObserver = cardObservers.current.get(projectId);
    if (prevObserver) {
      prevObserver.disconnect();
      cardObservers.current.delete(projectId);
    }
    if (el) {
      cardEls.current.set(projectId, el);
      const measure = () => {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        setCardSizes((prev) => {
          const cur = prev[projectId];
          if (cur && cur.w === w && cur.h === h) return prev;
          return { ...prev, [projectId]: { w, h } };
        });
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      cardObservers.current.set(projectId, ro);
    } else {
      cardEls.current.delete(projectId);
    }
  }

  // Measure the board once mounted and on resize (responsive breakpoint, window resize).
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const measure = () => setBoardSize({ w: board.clientWidth, h: board.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(board);
    return () => ro.disconnect();
  }, []);

  // ————— geometry helpers (effective position, size, center) —————

  function posOf(item: CanvasItem): { x: number; y: number } {
    if (dragId === item.project_id && dragPos) return dragPos;
    return { x: item.x ?? 0, y: item.y ?? 0 };
  }

  function sizeOf(projectId: number): { w: number; h: number } {
    const s = cardSizes[projectId];
    return { w: s?.w ?? CARD_W, h: s?.h ?? CARD_H_EST };
  }

  function centerOf(item: CanvasItem): { cx: number; cy: number; w: number; h: number } {
    const p = posOf(item);
    const s = sizeOf(item.project_id);
    return { cx: p.x + s.w / 2, cy: p.y + s.h / 2, w: s.w, h: s.h };
  }

  // The board-space rectangles of every placed card except `excludeId` (the one being dragged).
  // Sizes come from the rendered elements; unmeasurable cards fall back to the constants.
  function buildOccupied(excludeId: number): Rect[] {
    const rects: Rect[] = [];
    for (const it of placed) {
      if (it.project_id === excludeId) continue;
      const el = cardEls.current.get(it.project_id);
      rects.push({
        x: it.x ?? 0,
        y: it.y ?? 0,
        w: el?.offsetWidth ?? CARD_W,
        h: el?.offsetHeight ?? CARD_H_EST,
      });
    }
    return rects;
  }

  // The topmost placed card under a board-space point, or null. Used to resolve a link-drag target.
  function cardAt(x: number, y: number, excludeId: number): number | null {
    for (let i = placed.length - 1; i >= 0; i--) {
      const it = placed[i];
      if (it.project_id === excludeId) continue;
      const p = posOf(it);
      const s = sizeOf(it.project_id);
      if (x >= p.x && x <= p.x + s.w && y >= p.y && y <= p.y + s.h) return it.project_id;
    }
    return null;
  }

  // ————— board-card drag (Pointer Events) —————

  function onCardPointerDown(e: ReactPointerEvent<HTMLDivElement>, item: CanvasItem) {
    // Let the pickers, remove control, chip links, connect handle, and open menu keep their own clicks.
    if ((e.target as HTMLElement).closest('button, a, .cv-menu, .cv-handle')) return;
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

    // Occupied rects are stable for the duration of this drag (no other card moves). Memoize the
    // resolved landing spot per snapped grid cell so we don't re-run the search every pointermove.
    const occupied = buildOccupied(item.project_id);
    let lastKey = '';
    let lastFree = { x: startX, y: startY };
    const resolve = (clientX: number, clientY: number) => {
      const snappedX = clamp(snap(clamp(clientX - br.left - dx, maxX)), maxX);
      const snappedY = clamp(snap(clamp(clientY - br.top - dy, maxY)), maxY);
      const key = `${snappedX},${snappedY}`;
      if (key !== lastKey) {
        lastKey = key;
        lastFree = findFreeSpot({ x: snappedX, y: snappedY, w, h }, occupied, {
          w: board.clientWidth,
          h: board.clientHeight,
        });
      }
      return lastFree;
    };

    setDropTarget({ x: startX, y: startY, w, h });

    const move = (ev: PointerEvent) => {
      const x = clamp(ev.clientX - br.left - dx, maxX);
      const y = clamp(ev.clientY - br.top - dy, maxY);
      setDragPos({ x, y });
      const free = resolve(ev.clientX, ev.clientY);
      setDropTarget({ x: free.x, y: free.y, w, h });
    };

    const up = (ev: PointerEvent) => {
      cardEl.removeEventListener('pointermove', move);
      cardEl.removeEventListener('pointerup', up);
      cardEl.removeEventListener('pointercancel', up);
      setDragId(null);
      setDragPos(null);
      setDropTarget(null);

      const free = resolve(ev.clientX, ev.clientY);

      // No real move (against the RESOLVED spot) — don't churn a save.
      if (free.x === startX && free.y === startY) return;
      onPlace(item.project_id, free.x, free.y);
    };

    cardEl.addEventListener('pointermove', move);
    cardEl.addEventListener('pointerup', up);
    cardEl.addEventListener('pointercancel', up);
  }

  // ————— link drag from an edge handle (Pointer Events) —————

  function onHandlePointerDown(e: ReactPointerEvent<HTMLButtonElement>, item: CanvasItem) {
    // The handle lives inside the card; stop the event so grabbing it never starts a card drag.
    e.preventDefault();
    e.stopPropagation();
    const board = boardRef.current;
    if (!board) return;
    const br = board.getBoundingClientRect();
    const handleEl = e.currentTarget;
    const fromId = item.project_id;

    handleEl.setPointerCapture(e.pointerId);
    setLinkDrag({ fromId, x: e.clientX - br.left, y: e.clientY - br.top });
    setLinkTargetId(null);

    const move = (ev: PointerEvent) => {
      const x = ev.clientX - br.left;
      const y = ev.clientY - br.top;
      setLinkDrag({ fromId, x, y });
      setLinkTargetId(cardAt(x, y, fromId));
    };

    const up = (ev: PointerEvent) => {
      handleEl.removeEventListener('pointermove', move);
      handleEl.removeEventListener('pointerup', up);
      handleEl.removeEventListener('pointercancel', up);
      const x = ev.clientX - br.left;
      const y = ev.clientY - br.top;
      const toId = cardAt(x, y, fromId);
      setLinkDrag(null);
      setLinkTargetId(null);
      // Release over another card opens the type picker; over empty board or the source → nothing.
      if (toId !== null && toId !== fromId) setLinkPicker({ fromId, toId, x, y });
    };

    handleEl.addEventListener('pointermove', move);
    handleEl.addEventListener('pointerup', up);
    handleEl.addEventListener('pointercancel', up);
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

    // A tray card has never rendered, so its own size uses the fallbacks (erring small is fine —
    // the next move self-corrects). Resolve returns whether the pointer is over the board plus the
    // collision-free landing spot; occupied is rebuilt per call since it's read only on move/up.
    const resolve = (
      clientX: number,
      clientY: number,
    ): { over: boolean; free: { x: number; y: number } } | null => {
      const board = boardRef.current;
      if (!board) return null;
      const br = board.getBoundingClientRect();
      const over =
        clientX >= br.left && clientX <= br.right && clientY >= br.top && clientY <= br.bottom;
      const maxX = board.clientWidth - CARD_W;
      const maxY = Math.max(0, board.clientHeight - CARD_H_EST);
      const snappedX = clamp(snap(clamp(clientX - dx - br.left, maxX)), maxX);
      const snappedY = clamp(snap(clamp(clientY - dy - br.top, maxY)), maxY);
      const free = findFreeSpot(
        { x: snappedX, y: snappedY, w: CARD_W, h: CARD_H_EST },
        buildOccupied(item.project_id),
        { w: board.clientWidth, h: board.clientHeight },
      );
      return { over, free };
    };

    const move = (ev: PointerEvent) => {
      setTrayGhost({ item, left: ev.clientX - dx, top: ev.clientY - dy });
      const r = resolve(ev.clientX, ev.clientY);
      if (r && r.over) setDropTarget({ x: r.free.x, y: r.free.y, w: CARD_W, h: CARD_H_EST });
      else setDropTarget(null);
    };

    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('drag');
      setTrayGhost(null);
      setDropTarget(null);

      const r = resolve(ev.clientX, ev.clientY);
      if (!r || !r.over) return;
      onPlace(item.project_id, r.free.x, r.free.y);
    };

    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // ————— derive the drawable link lines + notes satellites (render-time, nothing persisted) —————

  const placedById = new Map(placed.map((it) => [it.project_id, it]));
  const linkList = links ?? [];

  const drawnLinks = linkList.flatMap((link) => {
    const from = placedById.get(link.from_project_id);
    const to = placedById.get(link.to_project_id);
    if (!from || !to) return [];
    const a = centerOf(from);
    const b = centerOf(to);
    return [
      {
        link,
        x1: a.cx,
        y1: a.cy,
        x2: b.cx,
        y2: b.cy,
        mx: (a.cx + b.cx) / 2,
        my: (a.cy + b.cy) / 2,
        // Chevron points toward the `to` card; flips when the target sits to the left.
        chevron: b.cx < a.cx ? '◂' : '▸',
      },
    ];
  });

  // Satellite chips + their connector lines, computed from each placed card's ring slots. Nothing
  // here is persisted; the whole set vanishes when the switch is off.
  type Satellite = {
    key: string;
    left: number;
    top: number;
    label: string;
    projectId: number;
    // Connector endpoints (card center → chip center) in board-space px.
    lx1: number;
    ly1: number;
    lx2: number;
    ly2: number;
  };
  const satellites: Satellite[] = [];
  if (showNotes && notesByProject && boardSize.w > 0) {
    for (const item of placed) {
      const notes = notesByProject[item.project_id] ?? [];
      if (notes.length === 0) continue;
      const c = centerOf(item);
      const rx = c.w / 2 + 100;
      const ry = c.h / 2 + 46;
      // ≤6 notes → each is its own chip; more → first 5 chips + a "+N more" chip in the last slot.
      const entries: Array<{ label: string }> =
        notes.length <= SAT_MAX
          ? notes.map((n) => ({ label: truncate(n.title, SAT_TITLE_MAX) }))
          : [
              ...notes
                .slice(0, SAT_MAX - 1)
                .map((n) => ({ label: truncate(n.title, SAT_TITLE_MAX) })),
              { label: `+${notes.length - (SAT_MAX - 1)} more` },
            ];
      entries.forEach((entry, i) => {
        const rad = (SAT_ANGLES[i] * Math.PI) / 180;
        const scx = c.cx + rx * Math.cos(rad);
        const scy = c.cy + ry * Math.sin(rad);
        const left = scx - SAT_W / 2;
        const top = scy - SAT_H / 2;
        // Skip a slot that would push the chip off the board — calm layout, no collision resolution.
        if (left < 0 || top < 0 || left + SAT_W > boardSize.w || top + SAT_H > boardSize.h) return;
        satellites.push({
          key: `${item.project_id}-${i}`,
          left,
          top,
          label: entry.label,
          projectId: item.project_id,
          lx1: c.cx,
          ly1: c.cy,
          lx2: scx,
          ly2: scy,
        });
      });
    }
  }

  const linkSourceCenter =
    linkDrag && placedById.has(linkDrag.fromId) ? centerOf(placedById.get(linkDrag.fromId)!) : null;

  // Popover microcopy needs the two project names.
  const pickerFromName = linkPicker ? (placedById.get(linkPicker.fromId)?.name ?? '') : '';
  const pickerToName = linkPicker ? (placedById.get(linkPicker.toId)?.name ?? '') : '';

  const satHref = (projectId: number): string | null =>
    chipTo === undefined ? `/projects/${projectId}` : chipTo(projectId);

  return (
    <>
      {onToggleNotes && (
        <div className="cv-board-head">
          <button
            type="button"
            role="switch"
            aria-checked={showNotes}
            className={`cv-switch${showNotes ? ' on' : ''}`}
            onClick={() => onToggleNotes(!showNotes)}
          >
            <span className="cv-switch-box" aria-hidden="true" />
            <span className="cv-switch-lbl">Show notes</span>
          </button>
        </div>
      )}

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
          {/* Line layer — beneath the cards (drawn first, pointer-transparent). Project links plus
              the weaker --grid note-satellite connectors and the provisional drag line all live here. */}
          <svg className="cv-links" width="100%" height="100%" aria-hidden="true">
            {satellites.map((s) => (
              <line
                key={`sl-${s.key}`}
                className="cv-sat-line"
                x1={s.lx1}
                y1={s.ly1}
                x2={s.lx2}
                y2={s.ly2}
              />
            ))}
            {drawnLinks.map((d) => (
              <line
                key={`ll-${d.link.id}`}
                className={`cv-link-line ${d.link.type}`}
                x1={d.x1}
                y1={d.y1}
                x2={d.x2}
                y2={d.y2}
              />
            ))}
            {linkDrag && linkSourceCenter && (
              <line
                className="cv-link-line provisional"
                x1={linkSourceCenter.cx}
                y1={linkSourceCenter.cy}
                x2={linkDrag.x}
                y2={linkDrag.y}
              />
            )}
          </svg>

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
                rootRef={(el) => setCardEl(item.project_id, el)}
                onHandlePointerDown={onLinkCreate ? (e) => onHandlePointerDown(e, item) : undefined}
                linkSource={linkDrag?.fromId === item.project_id}
                linkTarget={linkTargetId === item.project_id}
              />
            );
          })}

          {/* Midpoint direction labels — interactive (open the edit popover), so above the svg. */}
          {drawnLinks.map((d) => (
            <button
              key={`lbl-${d.link.id}`}
              type="button"
              className="cv-link-label"
              style={{ left: d.mx, top: d.my } as CSSProperties}
              onClick={() =>
                (onLinkType || onLinkRemove) && setLinkEdit({ linkId: d.link.id, x: d.mx, y: d.my })
              }
            >
              {typeLabel(d.link.type)} {d.chevron}
            </button>
          ))}

          {/* Notes satellites — read-only chips; clicking navigates to the project. */}
          {satellites.map((s) => {
            const href = satHref(s.projectId);
            const style = { left: s.left, top: s.top } as CSSProperties;
            return href === null ? (
              <span key={s.key} className="cv-sat" style={style}>
                {s.label}
              </span>
            ) : (
              <Link key={s.key} className="cv-sat" style={style} to={href}>
                {s.label}
              </Link>
            );
          })}

          {dropTarget && (
            <div
              className="cv-drop-target"
              style={{
                left: dropTarget.x,
                top: dropTarget.y,
                width: dropTarget.w,
                height: dropTarget.h,
              }}
              aria-hidden="true"
            />
          )}

          {/* Create-link type picker (after a handle drop). */}
          {linkPicker && onLinkCreate && (
            <LinkPopover
              title="Connect these projects"
              style={{ left: linkPicker.x, top: linkPicker.y }}
              onDismiss={() => setLinkPicker(null)}
              options={[
                {
                  key: 'parent',
                  label: 'Parent of',
                  hint: `${pickerFromName} is the parent of ${pickerToName}`,
                  onSelect: () => {
                    onLinkCreate(linkPicker.fromId, linkPicker.toId, 'parent');
                    setLinkPicker(null);
                  },
                },
                {
                  key: 'blocks',
                  label: 'Blocks',
                  hint: `${pickerFromName} blocks ${pickerToName}`,
                  onSelect: () => {
                    onLinkCreate(linkPicker.fromId, linkPicker.toId, 'blocks');
                    setLinkPicker(null);
                  },
                },
                {
                  key: 'cancel',
                  label: 'Cancel',
                  separated: true,
                  onSelect: () => setLinkPicker(null),
                },
              ]}
            />
          )}

          {/* Edit-link popover (from a midpoint label). */}
          {linkEdit && (
            <LinkPopover
              title="Connection"
              style={{ left: linkEdit.x, top: linkEdit.y }}
              onDismiss={() => setLinkEdit(null)}
              options={[
                {
                  key: 'parent',
                  label: 'Parent of',
                  onSelect: () => {
                    onLinkType?.(linkEdit.linkId, 'parent');
                    setLinkEdit(null);
                  },
                },
                {
                  key: 'blocks',
                  label: 'Blocks',
                  onSelect: () => {
                    onLinkType?.(linkEdit.linkId, 'blocks');
                    setLinkEdit(null);
                  },
                },
                {
                  key: 'remove',
                  label: 'Remove connection',
                  separated: true,
                  onSelect: () => {
                    onLinkRemove?.(linkEdit.linkId);
                    setLinkEdit(null);
                  },
                },
              ]}
            />
          )}
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
