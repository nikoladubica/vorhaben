// A single card on the canvas board (screen 14). Presentational + prop-driven — it holds no app
// state and makes no API calls; the page passes data and handlers. It renders the header (type +
// name + normalized money line), the feeling/trend pickers, the attached-note chips, a remove
// control, and native HTML5 file-drop handlers for attaching a Markdown note. Pointer dragging is
// owned by the page: onPointerDown is forwarded to the root and the page decides what to move.

import { useState } from 'react';
import type { CSSProperties, DragEvent, PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CanvasItem, Feeling, Trend } from '../../types';
import { formatMoney } from '../../domain/format';
import { FeelingPicker } from './FeelingPicker';
import { TrendPicker } from './TrendPicker';

interface Props {
  item: CanvasItem;
  // Absolute board position (left/top) — the page owns the coordinates.
  style?: CSSProperties;
  // True while this card is the one being pointer-dragged (adds the .drag treatment).
  dragging: boolean;
  // Names of notes attached THIS session (dropped .md files); shown as named chips.
  fileChips: string[];
  // Inline per-card message for a rejected (non-Markdown) drop, or null.
  fileError: string | null;
  // When true, omit the normalized money line (demo cards carry no real metrics).
  hideValue?: boolean;
  // Chip target: a string renders chips as <Link>; null renders them as plain <span> (demo, no
  // project route). undefined falls back to the project detail route (the authed default).
  chipHref?: string | null;
  onFeeling: (feeling: Feeling | null) => void;
  onTrend: (trend: Trend | null) => void;
  onRemove: () => void;
  onDropMarkdown: (file: File) => void;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  // Callback ref to the card's root element, so the board can measure real rendered sizes for
  // collision (heights vary with content). Optional — hosts that don't need measuring omit it.
  rootRef?: (el: HTMLDivElement | null) => void;
}

// The normalized headline line — "CHF 2'480 monthly-eq · 62/h", with an em dash for any figure the
// server could not compute ("CHF — monthly-eq · —/h").
function moneyLine(item: CanvasItem): string {
  const money =
    item.monthly_revenue == null
      ? `${item.base_currency} —`
      : formatMoney(String(item.monthly_revenue), item.base_currency);
  const rate = item.effective_hourly_rate == null ? '—' : String(item.effective_hourly_rate);
  return `${money} monthly-eq · ${rate}/h`;
}

export function CanvasCard({
  item,
  style,
  dragging,
  fileChips,
  fileError,
  hideValue = false,
  chipHref,
  onFeeling,
  onTrend,
  onRemove,
  onDropMarkdown,
  onPointerDown,
  rootRef,
}: Props) {
  // A file is hovering over the card — draws the --ink border (matches the .drag treatment; never red).
  const [over, setOver] = useState(false);

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(true);
  }
  function onDragLeave() {
    setOver(false);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onDropMarkdown(file);
  }

  // Prior notes have a count from the API but no titles — represent them with a single count chip.
  const priorCount = Math.max(0, item.note_count - fileChips.length);
  // undefined → authed default route; a string → that route; null → chips render as plain spans.
  const href = chipHref === undefined ? `/projects/${item.project_id}` : chipHref;

  return (
    <div
      ref={rootRef}
      className={`cv-card${dragging ? ' drag' : ''}${over ? ' over' : ''}`}
      style={style}
      onPointerDown={onPointerDown}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="hd">
        <button
          type="button"
          className="cv-remove"
          aria-label={`Remove ${item.name} from the board`}
          onClick={onRemove}
        >
          ×
        </button>
        <span className="typ">{item.type_label}</span>
        <h6>{item.name}</h6>
        {!hideValue && <span className="val num">{moneyLine(item)}</span>}
      </div>

      <div className="cv-tags">
        <FeelingPicker value={item.feeling} onChange={onFeeling} />
        <TrendPicker value={item.trend} onChange={onTrend} />
      </div>

      {(fileChips.length > 0 || priorCount > 0) && (
        <div className="cv-files">
          {fileChips.map((name) =>
            href === null ? (
              <span key={name} className="cv-file">
                ▤ {name}
              </span>
            ) : (
              <Link key={name} className="cv-file" to={href}>
                ▤ {name}
              </Link>
            ),
          )}
          {priorCount > 0 &&
            (href === null ? (
              <span className="cv-file">
                ▤ {priorCount} earlier {priorCount === 1 ? 'note' : 'notes'}
              </span>
            ) : (
              <Link className="cv-file" to={href}>
                ▤ {priorCount} earlier {priorCount === 1 ? 'note' : 'notes'}
              </Link>
            ))}
        </div>
      )}

      {fileError && (
        <div className="cv-file-err" role="alert">
          {fileError}
        </div>
      )}
    </div>
  );
}
