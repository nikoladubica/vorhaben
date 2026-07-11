import { describe as group, expect, it } from 'vitest';
import {
  ATTENTION_DRIFT_DAYS,
  budgetKey,
  evaluateAttentionDrift,
  evaluateFeelingDrift,
  isoWeekPeriod,
  shouldEmit,
  type DriftKind,
} from './drift.js';
import type { MoodAnalysis } from './moodAnalysis.js';

// The drift rules are pure, so they are tested with fixtures only — no DB. The DB-facing budget
// (nudge_log) is exercised through its pure decision helpers (isoWeekPeriod / budgetKey /
// shouldEmit), which are the whole of the "one per project per kind per week" rule.

const DAY_MS = 24 * 60 * 60 * 1000;
const ASOF = new Date('2026-07-11T12:00:00Z');

// A neutral established analysis; override just the fields a case is about.
function analysis(over: Partial<MoodAnalysis> = {}): MoodAnalysis {
  return {
    confidence: 'established',
    direction: 'flat',
    energyDirection: 'flat',
    fire: 'steady',
    streak: 0,
    swing: 'none',
    trendScore: 0,
    spanDays: 60,
    valenceLevel: 0,
    ...over,
  };
}

group('evaluateFeelingDrift — established-only gating', () => {
  it('says nothing below established confidence, even with a strong decline', () => {
    const strong = { direction: 'down' as const, streak: 6, trendScore: -2 };
    expect(evaluateFeelingDrift(analysis({ confidence: 'pattern', ...strong }), { name: 'X' })).toBeNull();
    expect(evaluateFeelingDrift(analysis({ confidence: 'early', ...strong }), { name: 'X' })).toBeNull();
  });

  it('fires once established with the same decline', () => {
    const finding = evaluateFeelingDrift(
      analysis({ direction: 'down', streak: 5, fire: 'burning' }),
      { name: 'X' },
    );
    expect(finding?.kind).toBe('feeling_drift');
  });
});

group('evaluateFeelingDrift — streak threshold', () => {
  it('does not fire below the minimum streak (and no other trigger)', () => {
    // streak 3 (< 4), trend flat (> -1), fire steady → nothing to say.
    expect(evaluateFeelingDrift(analysis({ direction: 'down', streak: 3 }), { name: 'X' })).toBeNull();
  });

  it('fires at exactly the minimum streak', () => {
    const finding = evaluateFeelingDrift(analysis({ direction: 'down', streak: 4 }), { name: 'X' });
    expect(finding?.kind).toBe('feeling_drift');
  });

  it('fires on a decisive trend even without a clean streak', () => {
    // No streak, but the valence slope is a full point down → the trend path.
    const finding = evaluateFeelingDrift(analysis({ streak: 0, trendScore: -1.4 }), { name: 'X' });
    expect(finding?.kind).toBe('feeling_drift');
  });
});

group('evaluateFeelingDrift — strain vs. checked-out framing split', () => {
  it('valence-down while the fire still burns reads as STRAIN', () => {
    const finding = evaluateFeelingDrift(
      analysis({ direction: 'down', streak: 4, fire: 'burning' }),
      { name: 'Corporate gig' },
    );
    expect(finding?.framing).toBe('strain');
    expect(finding?.sentence).toContain("that's strain");
    expect(finding?.sentence).toContain('raise the rate');
    expect(finding?.sentence).not.toContain('the fire is going out');
  });

  it('a fading fire reads as CHECKED-OUT (an ending is on the table)', () => {
    const finding = evaluateFeelingDrift(
      analysis({ energyDirection: 'down', fire: 'fading' }),
      { name: 'Corporate gig' },
    );
    expect(finding?.framing).toBe('checked_out');
    expect(finding?.sentence).toContain('the fire is going out');
    expect(finding?.sentence).toContain('maybe an ending');
    expect(finding?.sentence).not.toContain('raise the rate');
  });
});

group('evaluateFeelingDrift — rate pairing clause', () => {
  it('includes the lowest-rate clause only in the bottom rate half', () => {
    const down = analysis({ direction: 'down', streak: 4, fire: 'burning' });
    const withRate = evaluateFeelingDrift(down, { name: 'X', isBottomRateHalf: true });
    const withoutRate = evaluateFeelingDrift(down, { name: 'X', isBottomRateHalf: false });
    expect(withRate?.sentence).toContain('lowest hourly rates');
    expect(withoutRate?.sentence).not.toContain('lowest hourly rates');
  });
});

group('evaluateAttentionDrift — the 45-day boundary', () => {
  const at = (days: number) => new Date(ASOF.getTime() - days * DAY_MS);

  it('stays silent one day inside the window', () => {
    expect(
      evaluateAttentionDrift({ name: 'X', lastActivityAt: at(ATTENTION_DRIFT_DAYS - 1), asOf: ASOF }),
    ).toBeNull();
  });

  it('fires at exactly the boundary with the guilt-free copy', () => {
    const finding = evaluateAttentionDrift({
      name: 'Old client',
      lastActivityAt: at(ATTENTION_DRIFT_DAYS),
      asOf: ASOF,
    });
    expect(finding?.kind).toBe('attention_drift');
    expect(finding?.sentence).toContain('guilt-free');
    expect(finding?.sentence).toContain('stays in your history');
  });
});

group('the weekly budget (pure decision)', () => {
  const K: DriftKind = 'feeling_drift';

  it('computes a known ISO week and rolls to the next', () => {
    expect(isoWeekPeriod(ASOF)).toBe('2026-W28');
    expect(isoWeekPeriod(new Date('2026-07-18T12:00:00Z'))).toBe('2026-W29');
  });

  it('suppresses a second emit the same week, then allows the next week', () => {
    const week1 = isoWeekPeriod(ASOF);
    const week2 = isoWeekPeriod(new Date('2026-07-18T12:00:00Z'));
    const shown = new Set<string>();

    // First request this week: emit, and record the budget row.
    expect(shouldEmit(shown, 42, K, week1)).toBe(true);
    shown.add(budgetKey(42, K, week1));

    // Second request the same week: suppressed.
    expect(shouldEmit(shown, 42, K, week1)).toBe(false);

    // Next week: a fresh key, so it fires again.
    expect(shouldEmit(shown, 42, K, week2)).toBe(true);
  });

  it('keys are independent per project and per kind', () => {
    const week1 = isoWeekPeriod(ASOF);
    const shown = new Set<string>([budgetKey(42, 'feeling_drift', week1)]);
    // Same week, same project, but a different kind → its own budget.
    expect(shouldEmit(shown, 42, 'attention_drift', week1)).toBe(true);
    // A different project, same kind → its own budget.
    expect(shouldEmit(shown, 43, 'feeling_drift', week1)).toBe(true);
  });
});
