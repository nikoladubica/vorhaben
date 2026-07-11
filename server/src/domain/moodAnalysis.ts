// ---------------------------------------------------------------------------
// Mood analysis engine + First Signal (breaktrough.md §2.3–§2.4) — PURE heuristics
// ---------------------------------------------------------------------------
//
// This module reads a project's live mood-event stream (ticket 01) and answers the three
// questions of §2.3 — is it swinging, which way is it going, how does it compare — plus the
// First Signal confidence ladder of §2.4. Like domain/suggestions.ts it is a PURE module: plain
// data in, plain data out, no Knex, no Express, no clock beyond the `asOf` the caller passes. The
// DB-facing assembler (buildSignalsForUser in domain/signals.ts) loads each project's stream and
// its effective hourly rate and hands them over; this module only decides what the numbers mean
// and phrases them. Because it is pure it is fully exercised by moodAnalysis.test.ts with
// fixtures alone, and — per BUSINESS_LOGIC §7 — it works identically self-hosted and hosted: the
// LLM assistant may later NARRATE these findings, it is never required to PRODUCE them.
//
// The feeling mapping (confirmed 2026-07-11, do not re-litigate — breaktrough.md §2.4): FEELINGS
// is a closed list of 8 labels, not a scale. A single good↔bad number would score `stressed` and
// `sad` the same and destroy the one distinction this product exists for ("close to burnout" vs.
// "still have the fire"). So every feeling scores on TWO internal axes, each −2…+2 (valence ×
// arousal from emotion research): valence drives direction/streaks/swings; energy drives the
// burnout signal. These numbers are INTERNAL — never persisted, never shown to the user as
// values (trend_score travels in the API for the future Worth-It Matrix, but the UI renders
// sentences and words only).

import type { Feeling } from './constants.js';

// --- The two-axis feeling map (breaktrough.md §2.4 table) ------------------

// Valence: feels good (+2) ↔ feels bad (−2). Drives direction, streaks, swings, trend_score.
const VALENCE: Record<Feeling, number> = {
  excited: 2,
  happy: 2,
  grateful: 2,
  opportunistic: 1,
  pessimistic: -1,
  stressed: -1,
  sad: -2,
  miserable: -2,
};

/**
 * The internal valence score (−2…+2) for a feeling — the good↔bad axis that drives direction,
 * streaks, swings and trend_score. Exposed for the Quarterly Statement's mood TRAJECTORY line
 * (ticket 07): a sparkline is a shape, not a user-visible number (same rationale trend_score
 * already travels in the matrix/signals APIs). Keeping the map's single source of truth here means
 * the statement never re-derives the mapping. `null` in ⇒ `null` out (a cleared feeling is a gap).
 */
export function valenceOf(feeling: Feeling | null): number | null {
  return feeling === null ? null : VALENCE[feeling];
}

// Energy: fire at full burn (+2) ↔ drained (−2). Drives the burnout axis (strain vs. burnout).
// The whole point of this axis: stressed (−1, +1) is negative but STILL burning; sad (−2, −1) is
// the fire dimming. A stressed→sad slide barely moves valence but crosses energy from + to − —
// and that crossing is the "fire going out" finding, caught earlier than any valence dip.
const ENERGY: Record<Feeling, number> = {
  excited: 2,
  happy: 1,
  grateful: 0,
  opportunistic: 2,
  pessimistic: -1,
  stressed: 1,
  sad: -1,
  miserable: -2,
};

// --- Named thresholds (each explainable in one sentence, per §2.3) ---------

const DAY_MS = 24 * 60 * 60 * 1000;

// Confidence ladder by data span (span = last event − first event, in days). Below EARLY we say
// nothing; the First Signal speaks at EARLY so a 3-day logger hears back before they quit (§2.4).
const EARLY_DAYS = 3;
const PATTERN_DAYS = 14;
const ESTABLISHED_DAYS = 42;

// Direction: compare the mean of the last 7 days against the 7 before; a mean move of at least
// this much (on the −2…+2 scale) calls up/down, otherwise flat. Same method on both axes.
const DIRECTION_WINDOW_DAYS = 7;
const DIRECTION_THRESHOLD = 0.5;

// Fire (energy-state summary): mean energy of the recent window at or above BURNING is `burning`,
// at or below FADING is `fading`, else `steady`.
const FIRE_BURNING = 0.5;
const FIRE_FADING = -0.5;

// Harsh swing: a valence jump of at least this size between consecutive readings no more than
// HARSH_MAX_GAP_DAYS apart (loved one day, heavy the next), seen at least HARSH_MIN_COUNT times in
// the last SWING_WINDOW_DAYS. Mild: the valence delta changes sign at least MILD_MIN_FLIPS times
// in the window (oscillation) without any harsh jump. Else none.
const SWING_WINDOW_DAYS = 14;
const HARSH_DELTA = 3;
const HARSH_MAX_GAP_DAYS = 3;
const HARSH_MIN_COUNT = 2;
const MILD_MIN_FLIPS = 3;

// A streak needs at least this many consecutive falling readings to count as a decline (a single
// reading is not a slide).
const MIN_STREAK = 2;

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

// One live mood event, oldest first. `value` is a FEELINGS member or null (feeling cleared — a
// gap that breaks streaks but is never counted as a value). `at` is its created_at timestamp.
export interface MoodEventInput {
  value: Feeling | null;
  at: Date;
}

export type Direction = 'up' | 'down' | 'flat';
export type Fire = 'burning' | 'steady' | 'fading';
export type Swing = 'none' | 'mild' | 'harsh';
export type Confidence = 'none' | 'early' | 'pattern' | 'established';

export interface MoodAnalysis {
  // First Signal confidence by data span: <3d none / ≥3d early / ≥14d pattern / ≥42d established.
  confidence: Confidence;
  // Valence axis direction; null when fewer than 2 valued events (can't compute a move).
  direction: Direction | null;
  // Energy axis direction, same method — the burnout-trajectory axis.
  energyDirection: Direction | null;
  // Energy-state summary (the burnout axis); null when there is no valued event to read.
  fire: Fire | null;
  // Consecutive most-recent readings with strictly falling valence (a null gap breaks it); 0 when
  // the latest move is not a fall or fewer than MIN_STREAK readings decline.
  streak: number;
  // Valence amplitude over the last 14 days.
  swing: Swing;
  // Valence slope = recent-window mean minus prior-window mean (roughly −5…+5) — the Y axis of the
  // future Worth-It Matrix (ticket 05). 0 when it can't be computed.
  trendScore: number;
  // Data span (last − first event) in days — powers the confidence ladder and the "N weeks"/"N
  // days of data" phrasing. Exposed so the API/eyebrow need not re-derive it.
  spanDays: number;
  // Recent-window mean valence — the CURRENT emotional level (not its slope). Strain reads this
  // (negative level while the fire still burns); null when there is no valued event.
  valenceLevel: number | null;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a project's live mood stream.
 *
 * @param events oldest-first live mood events (deleted rows already excluded by the caller).
 * @param asOf   reference "now"; every rolling window is measured back from here.
 */
export function analyzeMood(events: MoodEventInput[], asOf: Date): MoodAnalysis {
  const spanDays = dataSpanDays(events);
  const confidence = confidenceFor(spanDays);

  const vSplit = splitAxis(events, asOf, VALENCE);
  const eSplit = splitAxis(events, asOf, ENERGY);

  const valenceDelta = deltaOf(vSplit);
  const energyDelta = deltaOf(eSplit);

  return {
    confidence,
    direction: valenceDelta === null ? null : directionOf(valenceDelta),
    energyDirection: energyDelta === null ? null : directionOf(energyDelta),
    fire: eSplit === null ? null : fireOf(eSplit.recentMean),
    streak: streakOf(events),
    swing: swingOf(events, asOf),
    trendScore: valenceDelta === null ? 0 : round1(valenceDelta),
    spanDays,
    valenceLevel: vSplit === null ? null : round1(vSplit.recentMean),
  };
}

// --- Span & confidence -----------------------------------------------------

function dataSpanDays(events: MoodEventInput[]): number {
  if (events.length < 2) return 0;
  const first = events[0]!.at.getTime();
  const last = events[events.length - 1]!.at.getTime();
  return Math.max(0, (last - first) / DAY_MS);
}

function confidenceFor(spanDays: number): Confidence {
  if (spanDays >= ESTABLISHED_DAYS) return 'established';
  if (spanDays >= PATTERN_DAYS) return 'pattern';
  if (spanDays >= EARLY_DAYS) return 'early';
  return 'none';
}

// --- Direction / fire on an axis -------------------------------------------

interface Valued {
  at: Date;
  score: number;
}

interface AxisSplit {
  // Mean of the recent window (last 7 days; falls back to the newer half when the span is short).
  recentMean: number;
  // Mean of the prior window; null when there is only one valued reading (no prior to compare).
  priorMean: number | null;
}

// Map an event stream to the valued readings on one axis (nulls dropped — they are gaps).
function valuedOn(events: MoodEventInput[], axis: Record<Feeling, number>): Valued[] {
  const out: Valued[] = [];
  for (const e of events) {
    if (e.value === null) continue;
    out.push({ at: e.at, score: axis[e.value] });
  }
  return out;
}

// Recent vs. prior means on one axis. Prefer the true last-7-days / previous-7-days windows; when
// the span is too short for two full windows (the common First-Signal case), fall back to the
// newer half vs. the older half of whatever readings exist. null when there is no reading at all.
function splitAxis(
  events: MoodEventInput[],
  asOf: Date,
  axis: Record<Feeling, number>,
): AxisSplit | null {
  const valued = valuedOn(events, axis);
  if (valued.length === 0) return null;

  const now = asOf.getTime();
  const recentCut = now - DIRECTION_WINDOW_DAYS * DAY_MS;
  const priorCut = now - 2 * DIRECTION_WINDOW_DAYS * DAY_MS;
  const recent = valued.filter((v) => v.at.getTime() >= recentCut);
  const prior = valued.filter((v) => v.at.getTime() >= priorCut && v.at.getTime() < recentCut);

  if (recent.length > 0 && prior.length > 0) {
    return { recentMean: mean(recent), priorMean: mean(prior) };
  }

  // Fall back to halves of the available span.
  if (valued.length < 2) {
    return { recentMean: valued[0]!.score, priorMean: null };
  }
  const mid = Math.floor(valued.length / 2);
  return { recentMean: mean(valued.slice(mid)), priorMean: mean(valued.slice(0, mid)) };
}

function deltaOf(split: AxisSplit | null): number | null {
  if (split === null || split.priorMean === null) return null;
  return split.recentMean - split.priorMean;
}

function directionOf(delta: number): Direction {
  if (delta >= DIRECTION_THRESHOLD) return 'up';
  if (delta <= -DIRECTION_THRESHOLD) return 'down';
  return 'flat';
}

function fireOf(recentEnergy: number): Fire {
  if (recentEnergy >= FIRE_BURNING) return 'burning';
  if (recentEnergy <= FIRE_FADING) return 'fading';
  return 'steady';
}

function mean(values: Valued[]): number {
  let sum = 0;
  for (const v of values) sum += v.score;
  return sum / values.length;
}

// --- Streak ----------------------------------------------------------------

// Count consecutive most-recent readings with strictly falling valence. Walk newest→oldest: each
// older reading with a strictly HIGHER valence means the step forward in time fell, so it extends
// the streak; a null (cleared feeling) or a non-falling step stops it. Fewer than MIN_STREAK
// falling readings is not a slide (returns 0).
function streakOf(events: MoodEventInput[]): number {
  let count = 0;
  let newer: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.value === null) break;
    const score = VALENCE[e.value];
    if (newer === null) {
      newer = score;
      count = 1;
    } else if (score > newer) {
      count++;
      newer = score;
    } else {
      break;
    }
  }
  return count >= MIN_STREAK ? count : 0;
}

// --- Swing -----------------------------------------------------------------

// Classify valence amplitude over the last SWING_WINDOW_DAYS. Deltas are taken between consecutive
// VALUED readings in the window (nulls are gaps and simply don't produce a value). Harsh: at least
// HARSH_MIN_COUNT jumps of |Δ| ≥ HARSH_DELTA no more than HARSH_MAX_GAP_DAYS apart. Mild: the delta
// sign flips at least MILD_MIN_FLIPS times (oscillation) with no harsh jump. Else none.
function swingOf(events: MoodEventInput[], asOf: Date): Swing {
  const windowCut = asOf.getTime() - SWING_WINDOW_DAYS * DAY_MS;
  const valued = valuedOn(events, VALENCE).filter((v) => v.at.getTime() >= windowCut);
  if (valued.length < 2) return 'none';

  let harshCount = 0;
  let flips = 0;
  let prevSign = 0;
  for (let i = 1; i < valued.length; i++) {
    const prev = valued[i - 1]!;
    const curr = valued[i]!;
    const delta = curr.score - prev.score;
    const gapDays = (curr.at.getTime() - prev.at.getTime()) / DAY_MS;

    if (Math.abs(delta) >= HARSH_DELTA && gapDays <= HARSH_MAX_GAP_DAYS) harshCount++;

    const sign = Math.sign(delta);
    if (sign !== 0) {
      if (prevSign !== 0 && sign !== prevSign) flips++;
      prevSign = sign;
    }
  }

  if (harshCount >= HARSH_MIN_COUNT) return 'harsh';
  if (flips >= MILD_MIN_FLIPS) return 'mild';
  return 'none';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// The First Signal — one finding sentence + one suggestion (breaktrough.md §2.4)
// ---------------------------------------------------------------------------
//
// describe() turns an analysis into at most ONE plain sentence, read NEXT TO the pairing data the
// caller supplies (effective hourly rate rank, whether it's the only project trending down). Tone:
// one finding, one suggestion; plain, warm, direct — "consider chilling out on the corporate
// project" energy, but Swiss. Findings are observations, not predictions (§7). Templates, never
// LLM calls. Returns null when there is nothing worth saying (the caller omits the project).
//
// Priority (most concerning first): burnout trajectory → harsh swing → strain → declining →
// improving. The `concern` number lets the assembler order projects across a portfolio.

export interface SignalContext {
  name: string;
  // This project has the portfolio's lowest effective hourly rate (≥2 rated projects). Unlocks the
  // "and it's your lowest hourly rate" clause — a decline on your worst earner is a harder line.
  isLowestRate?: boolean;
  // It is the ONLY project currently trending down — the §2.4 "your only one trending down" line.
  isOnlyDown?: boolean;
}

export type Finding = 'burnout' | 'harsh_swing' | 'strain' | 'declining' | 'improving';

export interface MoodSignal {
  finding: Finding;
  sentence: string;
  // Higher = list earlier. Established outranks early on the same finding (§ acceptance: "down +
  // established outranks flat + early").
  concern: number;
}

// A negative recent valence level while the fire still burns is strain, not burnout.
const STRAIN_VALENCE_MAX = 0;

/**
 * Render the one-line First Signal for an analysis, or null when there is nothing to say. Silent
 * whenever confidence is 'none' (fewer than 3 days of data) — the engine does not guess early.
 */
export function describe(analysis: MoodAnalysis, context: SignalContext): MoodSignal | null {
  if (analysis.confidence === 'none') return null;

  const name = context.name;
  const weeks = Math.max(1, Math.round(analysis.spanDays / 7));
  const days = Math.max(EARLY_DAYS, Math.round(analysis.spanDays));

  // 1. Burnout trajectory — energy crossing down into a fading fire (the stressed→sad slide).
  if (analysis.energyDirection === 'down' && analysis.fire === 'fading') {
    return {
      finding: 'burnout',
      sentence:
        `${name} has slid toward a lower gear — the fire is going out. ` +
        `Consider stepping back before it costs you.`,
      concern: 100,
    };
  }

  // 2. Harsh swing — loved one day, heavy the next.
  if (analysis.swing === 'harsh') {
    return {
      finding: 'harsh_swing',
      sentence:
        `${name} swings hard — loved one day, heavy the next. ` +
        `Worth a note next time it flips.`,
      concern: 80,
    };
  }

  // 3. Strain — negative valence level while the fire is still burning/steady (it's burning YOU).
  if (
    analysis.valenceLevel !== null &&
    analysis.valenceLevel < STRAIN_VALENCE_MAX &&
    (analysis.fire === 'burning' || analysis.fire === 'steady')
  ) {
    return {
      finding: 'strain',
      sentence:
        `${name} is wearing on you, but the fire's still burning — that's strain, not burnout. ` +
        `Contain it before it turns.`,
      concern: 70,
    };
  }

  // 4. Declining — valence trending down. The First Signal's headline case.
  if (analysis.direction === 'down') {
    return { finding: 'declining', sentence: decliningSentence(analysis, context, weeks, days), concern: decliningConcern(analysis, context) };
  }

  // 5. Improving — a quiet, warm positive. Listed last; only worth saying past the early stage.
  if (analysis.direction === 'up' && analysis.confidence !== 'early') {
    return {
      finding: 'improving',
      sentence: `${name} is trending up — whatever you're doing there, keep it going.`,
      concern: 10,
    };
  }

  return null;
}

function decliningSentence(
  analysis: MoodAnalysis,
  context: SignalContext,
  weeks: number,
  days: number,
): string {
  const name = context.name;

  // Early: honest, hedged, with the retention clause that earns the next log.
  if (analysis.confidence === 'early') {
    const finding = context.isOnlyDown
      ? `${name} is the only project trending down`
      : `${name} is trending down`;
    return `Early signal — ${days} days of data: ${finding}. Consider chilling out on it. We'll know more in a week.`;
  }

  // Pattern / established: a plain, firmer statement, with the rate pairing when it's the worst earner.
  if (context.isLowestRate) {
    return `${name} has been sliding for ${weeks} weeks — and it's your lowest hourly rate. Time for a decision, not more effort.`;
  }
  return `${name} has been sliding for ${weeks} weeks. Worth a decision before you put in more effort.`;
}

// Declining projects rank between strain (70) and improving (10). Established outranks pattern
// outranks early; the lowest-rate pairing nudges it up a touch (a decline on your worst earner is
// the more actionable one).
function decliningConcern(analysis: MoodAnalysis, context: SignalContext): number {
  let concern = 40;
  if (analysis.confidence === 'established') concern += 20;
  else if (analysis.confidence === 'pattern') concern += 10;
  if (context.isLowestRate) concern += 5;
  return concern;
}
