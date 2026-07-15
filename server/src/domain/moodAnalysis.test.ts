import { describe as group, expect, it } from 'vitest';
import {
  analyzeMood,
  analyzeTrendDirection,
  describe,
  describeDivergence,
  type Direction,
  type MoodEventInput,
  type TrendEventInput,
} from './moodAnalysis.js';
import type { Feeling, Trend } from './constants.js';

// The engine is pure, so it is tested with fixtures only — no DB. Every fixture is built relative
// to a fixed `asOf`, and events are constructed OLDEST FIRST (the contract analyzeMood expects).
// See suggestions.test.ts for the house style this mirrors.

const DAY_MS = 24 * 60 * 60 * 1000;
const ASOF = new Date('2026-07-11T12:00:00Z');

// An event `days` days before asOf.
function ev(value: Feeling | null, days: number): MoodEventInput {
  return { value, at: new Date(ASOF.getTime() - days * DAY_MS) };
}

// A trend event `days` days before asOf.
function tev(value: Trend | null, days: number): TrendEventInput {
  return { value, at: new Date(ASOF.getTime() - days * DAY_MS) };
}

const CTX = { name: 'Corporate gig' };

group('analyzeMood — confidence ladder (§2.4 boundaries)', () => {
  it('says nothing below 3 days of span', () => {
    expect(analyzeMood([ev('happy', 2), ev('happy', 0)], ASOF).confidence).toBe('none');
  });

  it('reaches early at exactly 3 days', () => {
    expect(analyzeMood([ev('happy', 3), ev('happy', 0)], ASOF).confidence).toBe('early');
  });

  it('reaches pattern at exactly 14 days', () => {
    expect(analyzeMood([ev('happy', 14), ev('happy', 0)], ASOF).confidence).toBe('pattern');
  });

  it('reaches established at exactly 42 days', () => {
    expect(analyzeMood([ev('happy', 42), ev('happy', 0)], ASOF).confidence).toBe('established');
  });
});

group('analyzeMood — direction on both axes', () => {
  it('reads a valence and energy decline as down/down', () => {
    const a = analyzeMood([ev('excited', 6), ev('opportunistic', 3), ev('pessimistic', 0)], ASOF);
    expect(a.direction).toBe('down');
    expect(a.energyDirection).toBe('down');
    expect(a.trendScore).toBeLessThan(0);
  });

  it('reads a valence rise as up', () => {
    const a = analyzeMood([ev('pessimistic', 6), ev('opportunistic', 3), ev('excited', 0)], ASOF);
    expect(a.direction).toBe('up');
    expect(a.trendScore).toBeGreaterThan(0);
  });

  it('reads steady valence as flat', () => {
    const a = analyzeMood([ev('happy', 6), ev('happy', 3), ev('happy', 0)], ASOF);
    expect(a.direction).toBe('flat');
    expect(a.trendScore).toBe(0);
  });

  it('separates the axes: flat valence but rising energy', () => {
    // grateful/happy/excited all have valence +2 but energy 0/1/2.
    const a = analyzeMood([ev('grateful', 6), ev('happy', 3), ev('excited', 0)], ASOF);
    expect(a.direction).toBe('flat');
    expect(a.energyDirection).toBe('up');
  });

  it('returns null direction with fewer than 2 valued events', () => {
    expect(analyzeMood([ev('happy', 0)], ASOF).direction).toBeNull();
  });
});

group('analyzeMood — streak', () => {
  it('counts a strictly falling run of readings', () => {
    const a = analyzeMood(
      [ev('excited', 6), ev('opportunistic', 4), ev('pessimistic', 2), ev('sad', 0)],
      ASOF,
    );
    expect(a.streak).toBe(4);
  });

  it('is zero when the latest move is not a fall', () => {
    expect(analyzeMood([ev('sad', 4), ev('happy', 0)], ASOF).streak).toBe(0);
  });
});

group('analyzeMood — null-event gaps', () => {
  it('breaks a streak on a cleared feeling and never counts null as a value', () => {
    const a = analyzeMood([ev('excited', 6), ev(null, 4), ev('sad', 0)], ASOF);
    // The null between excited and sad breaks the run — only one falling reading survives → 0.
    expect(a.streak).toBe(0);
    // valenceLevel reflects the sad reading only; the null is a gap, not a value.
    expect(a.valenceLevel).toBe(-2);
    expect(a.direction).toBe('down');
  });
});

group('analyzeMood — swing amplitude', () => {
  it('flags a harsh swing (repeated top-to-bottom jumps within days)', () => {
    const a = analyzeMood(
      [ev('excited', 10), ev('miserable', 9), ev('excited', 6), ev('miserable', 5)],
      ASOF,
    );
    expect(a.swing).toBe('harsh');
  });

  it('flags a mild oscillation (frequent small sign changes, no harsh jump)', () => {
    const a = analyzeMood(
      [
        ev('happy', 13),
        ev('opportunistic', 11),
        ev('happy', 9),
        ev('opportunistic', 7),
        ev('happy', 5),
        ev('opportunistic', 3),
      ],
      ASOF,
    );
    expect(a.swing).toBe('mild');
  });

  it('reports none for a calm steady stream', () => {
    expect(analyzeMood([ev('happy', 6), ev('happy', 3), ev('happy', 0)], ASOF).swing).toBe('none');
  });
});

group('describe — the two signature trajectories (acceptance)', () => {
  it('sustained stressed is STRAIN, never burnout (fire still burning)', () => {
    const a = analyzeMood([ev('stressed', 6), ev('stressed', 3), ev('stressed', 0)], ASOF);
    expect(a.fire).toBe('burning');
    const signal = describe(a, CTX);
    expect(signal?.finding).toBe('strain');
    expect(signal?.finding).not.toBe('burnout');
    expect(signal?.sentence).toContain('strain, not burnout');
  });

  it('a stressed → sad slide is BURNOUT, never strain (the fire going out)', () => {
    const a = analyzeMood([ev('stressed', 6), ev('stressed', 4), ev('sad', 2), ev('sad', 0)], ASOF);
    expect(a.fire).toBe('fading');
    expect(a.energyDirection).toBe('down');
    const signal = describe(a, CTX);
    expect(signal?.finding).toBe('burnout');
    expect(signal?.finding).not.toBe('strain');
    expect(signal?.sentence).toContain('fire is going out');
  });
});

group('describe — the First Signal ladder', () => {
  it('early + down carries the honesty clause and the day count', () => {
    const a = analyzeMood([ev('excited', 3), ev('opportunistic', 1.5), ev('pessimistic', 0)], ASOF);
    expect(a.confidence).toBe('early');
    expect(a.direction).toBe('down');
    const signal = describe(a, { name: 'Corporate gig', isOnlyDown: true });
    expect(signal?.finding).toBe('declining');
    expect(signal?.sentence).toContain('Early signal — 3 days of data');
    expect(signal?.sentence).toContain('only project trending down');
    expect(signal?.sentence).toContain("We'll know more in a week");
  });

  it('established + down + lowest rate is the firm sentence with the pairing clause', () => {
    // A 6-week valence decline (excited → opportunistic) that stays positive in energy, so it
    // reads as a plain slide, not strain or burnout.
    const events = [
      ev('excited', 42),
      ev('excited', 36),
      ev('happy', 30),
      ev('happy', 24),
      ev('happy', 18),
      ev('happy', 12),
      ev('opportunistic', 6),
      ev('opportunistic', 0),
    ];
    const a = analyzeMood(events, ASOF);
    expect(a.confidence).toBe('established');
    expect(a.direction).toBe('down');
    const signal = describe(a, { name: 'Corporate gig', isLowestRate: true });
    expect(signal?.finding).toBe('declining');
    expect(signal?.sentence).toContain('6 weeks');
    expect(signal?.sentence).toContain('lowest hourly rate');
  });

  it('is silent below the early threshold', () => {
    const a = analyzeMood([ev('sad', 2), ev('miserable', 0)], ASOF);
    expect(a.confidence).toBe('none');
    expect(describe(a, CTX)).toBeNull();
  });

  it('ranks a harsh swing above a plain decline', () => {
    const harsh = describe(
      analyzeMood(
        [ev('excited', 10), ev('miserable', 9), ev('excited', 6), ev('miserable', 5)],
        ASOF,
      ),
      CTX,
    );
    const declining = describe(
      analyzeMood([ev('excited', 3), ev('opportunistic', 1.5), ev('pessimistic', 0)], ASOF),
      CTX,
    );
    expect(harsh!.concern).toBeGreaterThan(declining!.concern);
  });
});

// ticket 26 — the check-in split
group('analyzeMood — `fine` is the neutral steady state (ticket 26)', () => {
  it('scores fine at valence 0 / energy 0: a fine run reads flat and steady', () => {
    const a = analyzeMood([ev('fine', 6), ev('fine', 3), ev('fine', 0)], ASOF);
    expect(a.valenceLevel).toBe(0);
    expect(a.direction).toBe('flat');
    expect(a.fire).toBe('steady');
    expect(a.trendScore).toBe(0);
  });

  it('reads a slide from happy into fine as a decline (fine sits below happy)', () => {
    const a = analyzeMood([ev('happy', 6), ev('happy', 3), ev('fine', 0)], ASOF);
    expect(a.direction).toBe('down');
    expect(a.trendScore).toBeLessThan(0);
  });
});

group('analyzeMood — legacy feelings still score (ticket 26)', () => {
  it('grateful/opportunistic/pessimistic remain scorable and read as a valence decline', () => {
    // grateful (+2) → opportunistic (+1) → pessimistic (−1): the whole run is still scored on the
    // valence map exactly as before the writable list shrank, so it reads as a decline.
    const a = analyzeMood([ev('grateful', 6), ev('opportunistic', 3), ev('pessimistic', 0)], ASOF);
    expect(a.direction).toBe('down');
    expect(a.trendScore).toBeLessThan(0);
    // Both axes are still computed for legacy-valued streams (not null → they scored).
    expect(a.valenceLevel).not.toBeNull();
    expect(a.energyDirection).not.toBeNull();
  });
});

group('analyzeTrendDirection — the trend stream direction (ticket 26)', () => {
  it('reads a rising trend (bad → thriving) as up and a falling one as down', () => {
    expect(analyzeTrendDirection([tev('bad', 6), tev('good', 3), tev('thriving', 0)], ASOF)).toBe(
      'up',
    );
    expect(analyzeTrendDirection([tev('thriving', 6), tev('good', 3), tev('bad', 0)], ASOF)).toBe(
      'down',
    );
  });

  it('a steady stable run is flat, and a single reading has no direction', () => {
    expect(analyzeTrendDirection([tev('stable', 6), tev('stable', 0)], ASOF)).toBe('flat');
    expect(analyzeTrendDirection([tev('good', 0)], ASOF)).toBeNull();
  });
});

group('describeDivergence — trend vs feeling (ticket 26)', () => {
  const NAME = { name: 'Corporate gig' };

  it('trend up + feeling down is the burnout tell', () => {
    const d = describeDivergence('down', 'up', NAME);
    expect(d?.finding).toBe('divergence_burnout');
    expect(d?.sentence).toContain('burnout tell');
  });

  it('trend down + feeling up is sunk-cost bias', () => {
    const d = describeDivergence('up', 'down', NAME);
    expect(d?.finding).toBe('divergence_sunk_cost');
    expect(d?.sentence).toContain('sunk-cost bias');
  });

  it('says nothing when the two axes agree, or either direction is unknown', () => {
    expect(describeDivergence('up', 'up', NAME)).toBeNull();
    expect(describeDivergence('down', 'down', NAME)).toBeNull();
    expect(describeDivergence('flat', 'up', NAME)).toBeNull();
    const unknown: Direction | null = null;
    expect(describeDivergence(unknown, 'up', NAME)).toBeNull();
    expect(describeDivergence('down', unknown, NAME)).toBeNull();
  });
});
