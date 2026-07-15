// Display metadata for the 5 trend values, shared by the TrendPicker (its trigger + menu) and the
// mood stream (labelling trend events). Kept in its own module so the component files export only
// components (fast-refresh friendly). Semantic colour only — never the red accent: thriving/good
// read positive (--good), stable is neutral (--ink-3), bad/failing are plain ink (information, not
// an alarm).

import type { Trend } from '../../types';

// Glyph + label per trend, matching the design's "fire" run: thriving ▲▲ … failing ▼▼.
export const TREND_LABEL: Record<Trend, string> = {
  thriving: '▲▲ Thriving',
  good: '▲ Good',
  stable: '▬ Stable',
  bad: '▼ Bad',
  failing: '▼▼ Failing',
};

// Semantic colour class per trend — .t-good (green), .t-stable (muted), .t-bad (ink). Never red.
export const TREND_CLASS: Record<Trend, string> = {
  thriving: 't-good',
  good: 't-good',
  stable: 't-stable',
  bad: 't-bad',
  failing: 't-bad',
};
