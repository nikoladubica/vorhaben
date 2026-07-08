// Small, dependency-free chart helpers shared by the hand-rolled SVG charts. Native Math + Intl
// only (no chart/date library — the Swiss direction and the lean-deps rule both forbid one).

// A "nice" linear y-axis for a column chart: rounds the max up to a clean step (1/2/5 × 10ⁿ) and
// returns the tick values (0 … yMax inclusive). Guards the empty/zero case so a flat dashboard
// still draws a baseline.
export function niceScale(maxValue: number, tickCount = 4): { yMax: number; ticks: number[] } {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { yMax: 1, ticks: [0, 1] };
  }
  const rawStep = maxValue / tickCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = niceNormalized * magnitude;
  const yMax = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= yMax + step / 1000; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  return { yMax, ticks };
}

// 'YYYY-MM' → 'Feb'. Parsed as UTC to avoid a timezone off-by-one (matches domain/format.ts).
export function monthShortLabel(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const d = new Date(Date.UTC(year, month - 1, 1));
  if (Number.isNaN(d.getTime())) return monthKey;
  return d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
}

// The path `d` for one column: a 4px rounded data-end on a square baseline (design file's trend
// script). `h` is the pixel height; sub-4px bars degrade to a plain square so the curve never
// inverts.
export function columnPath(x: number, y: number, w: number, h: number): string {
  if (h < 4) {
    return `M${x},${y} h${w} v${h} h${-w} Z`;
  }
  return `M${x},${y + 4} q0,-4 4,-4 h${w - 8} q4,0 4,4 v${h - 4} h${-w} Z`;
}
