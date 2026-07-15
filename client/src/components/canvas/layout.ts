// Pure placement helper for the canvas board — no React, no DOM. Given a desired (already snapped +
// clamped) grid position and the rectangles of the cards already on the board, it returns the
// nearest free grid position so a drop never lands on top of another card. Nothing here mutates or
// moves other cards; the caller decides what to persist.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Matches the board's visual grid (CanvasBoardView's GRID). The search steps by whole grid cells.
const GRID = 24;

// Plain AABB overlap, zero tolerance: touching edges do NOT count as overlap (the 24px grid already
// supplies the visual rhythm — no mandatory gutter).
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Nearest free grid position for `desired` among `occupied`, inside board bounds. Searches grid
// positions ring by ring outward from `desired` (24px steps), nearest ring first; within a ring the
// smallest pointer distance wins. Every candidate is clamped to the board. Returns `desired` itself
// when it is free. Fail open: if no free spot exists within the board (board effectively full),
// return `desired` unchanged — an overlapping card beats a lost card.
export function findFreeSpot(
  desired: Rect,
  occupied: Rect[],
  board: { w: number; h: number },
): { x: number; y: number } {
  const maxX = Math.max(0, board.w - desired.w);
  const maxY = Math.max(0, board.h - desired.h);
  const clampX = (v: number) => Math.max(0, Math.min(v, maxX));
  const clampY = (v: number) => Math.max(0, Math.min(v, maxY));

  const isFree = (x: number, y: number): boolean => {
    const candidate: Rect = { x, y, w: desired.w, h: desired.h };
    return !occupied.some((o) => overlaps(candidate, o));
  };

  const dx = clampX(desired.x);
  const dy = clampY(desired.y);
  if (isFree(dx, dy)) return { x: dx, y: dy };

  // Stop once the ring radius exceeds the board's larger dimension — a full board terminates.
  const maxRing = Math.ceil(Math.max(board.w, board.h) / GRID);

  for (let ring = 1; ring <= maxRing; ring++) {
    let best: { x: number; y: number; dist: number } | null = null;
    for (let gx = -ring; gx <= ring; gx++) {
      for (let gy = -ring; gy <= ring; gy++) {
        // Only the perimeter cells of this ring — inner cells were checked on earlier rings.
        if (Math.max(Math.abs(gx), Math.abs(gy)) !== ring) continue;
        const x = clampX(dx + gx * GRID);
        const y = clampY(dy + gy * GRID);
        if (!isFree(x, y)) continue;
        // Squared pointer distance from the desired position — smallest within the ring wins.
        const ddx = x - dx;
        const ddy = y - dy;
        const dist = ddx * ddx + ddy * ddy;
        if (best === null || dist < best.dist) best = { x, y, dist };
      }
    }
    if (best) return { x: best.x, y: best.y };
  }

  // Board effectively full — fail open to the desired spot.
  return { x: dx, y: dy };
}
