import { describe as group, expect, it } from 'vitest';
import {
  assembleStatement,
  isoWeekStart,
  parsePeriod,
  quarterRange,
  type StatementInput,
  type StatementMoodEvent,
  type StatementProjectInput,
} from './statement.js';
import { isoWeekPeriod } from './drift.js';
import type { ProjectMetrics } from './normalization.js';
import type { Feeling } from './constants.js';

// The assembly core is pure, so it is tested with fixtures only — no DB. The quarter is fixed at
// Q2 2026 (2026-04-01 … 2026-06-30); events are dated as absolute UTC timestamps within it. Mirrors
// the house style of moodAnalysis.test.ts.

const Q2 = quarterRange(2026, 2);
const GENERATED = new Date('2026-07-01T09:00:00Z');

function at(dateYmd: string): Date {
  return new Date(`${dateYmd}T12:00:00Z`);
}

function ev(
  value: Feeling | null,
  dateYmd: string,
  extra: { note?: string; transcript?: string } = {},
): StatementMoodEvent {
  return {
    value,
    at: at(dateYmd),
    note: extra.note ?? null,
    transcript: extra.transcript ?? null,
  };
}

function metrics(over: Partial<ProjectMetrics> = {}): ProjectMetrics {
  return {
    totalRevenue: null,
    totalExpenses: null,
    monthlyRevenue: null,
    monthlyExpenses: null,
    monthlyNet: null,
    effectiveHourlyRate: null,
    hoursInWindow: 0,
    entryCount: 0,
    missingRates: false,
    window: { from: Q2.from, to: Q2.to, months: 3 },
    ...over,
  };
}

function project(over: Partial<StatementProjectInput> & { id: number; name: string }): StatementProjectInput {
  return {
    type: 'freelance_gig',
    status: 'active',
    startDate: '2026-01-01',
    endDate: null,
    endingNote: null,
    metrics: metrics(),
    lifetimeHours: 0,
    moodEvents: [],
    ...over,
  };
}

function input(over: Partial<StatementInput> & { projects: StatementProjectInput[] }): StatementInput {
  return {
    range: Q2,
    baseCurrency: 'EUR',
    userEmail: 'dev@example.com',
    generatedAt: GENERATED,
    weeksClosed: 0,
    prevMonthlyNet: null,
    ...over,
  };
}

group('period parsing & quarter bounds', () => {
  it('parses a well-formed period into UTC quarter bounds', () => {
    const r = parsePeriod('2026-Q2');
    expect(r).not.toBeNull();
    expect(r!.from).toBe('2026-04-01');
    expect(r!.to).toBe('2026-06-30');
    expect(r!.label).toBe('Q2 2026');
  });

  it('Q1 and Q4 bounds are correct (leap-safe last day)', () => {
    expect(quarterRange(2024, 1).to).toBe('2024-03-31');
    expect(quarterRange(2026, 4).to).toBe('2026-12-31');
  });

  it('rejects malformed periods', () => {
    expect(parsePeriod('2026-Q5')).toBeNull();
    expect(parsePeriod('2026-6')).toBeNull();
    expect(parsePeriod('nonsense')).toBeNull();
  });
});

group('isoWeekStart is the inverse of drift.isoWeekPeriod', () => {
  it('round-trips a date to its own ISO week Monday', () => {
    const monday = isoWeekStart(isoWeekPeriod(new Date('2026-06-30T12:00:00Z')));
    // 2026-06-30 is a Tuesday; its ISO week starts Monday 2026-06-29.
    expect(monday).toBe('2026-06-29');
  });
});

group('portfolio figures (match the dashboard shape, rounded)', () => {
  it('passes normalization metrics through, rounded to money/hours', () => {
    const s = assembleStatement(
      input({
        projects: [
          project({
            id: 1,
            name: 'Alpha',
            metrics: metrics({
              monthlyRevenue: 1234.567,
              monthlyNet: 1000.005,
              effectiveHourlyRate: 52.349,
              hoursInWindow: 41.27,
              totalRevenue: 9999.9,
            }),
          }),
        ],
      }),
    );
    const row = s.portfolio[0]!;
    expect(row.monthly_revenue).toBe(1234.57);
    expect(row.monthly_net).toBe(1000.01);
    expect(row.effective_hourly_rate).toBe(52.35);
    expect(row.hours).toBe(41.3);
    expect(row.total_revenue).toBe(9999.9);
  });

  it('builds a valence trajectory from in-quarter events only', () => {
    const s = assembleStatement(
      input({
        projects: [
          project({
            id: 1,
            name: 'Alpha',
            moodEvents: [
              ev('happy', '2026-03-20'), // before the quarter — excluded from the line
              ev('happy', '2026-04-10'),
              ev(null, '2026-05-01'), // cleared → a gap (null valence)
              ev('sad', '2026-06-20'),
            ],
          }),
        ],
      }),
    );
    const traj = s.portfolio[0]!.trajectory;
    expect(traj).toHaveLength(3);
    expect(traj[0]!.valence).toBe(2);
    expect(traj[1]!.valence).toBeNull();
    expect(traj[2]!.valence).toBe(-2);
  });
});

group('aggregates', () => {
  it('picks best-by-rate, best-by-revenue and heaviest, and a trend vs the prior quarter', () => {
    const s = assembleStatement(
      input({
        prevMonthlyNet: 800,
        projects: [
          project({
            id: 1,
            name: 'Alpha',
            metrics: metrics({ monthlyNet: 600, effectiveHourlyRate: 90, hoursInWindow: 10 }),
          }),
          project({
            id: 2,
            name: 'Beta',
            metrics: metrics({ monthlyNet: 400, effectiveHourlyRate: 40, hoursInWindow: 55 }),
          }),
        ],
      }),
    );
    expect(s.aggregates.total_monthly_net).toBe(1000);
    expect(s.aggregates.best_by_rate).toEqual({ project_id: 1, name: 'Alpha', value: 90 });
    expect(s.aggregates.best_by_revenue).toEqual({ project_id: 1, name: 'Alpha', value: 600 });
    expect(s.aggregates.heaviest).toEqual({ project_id: 2, name: 'Beta', value: 55 });
    expect(s.aggregates.trend_direction).toBe('up'); // 1000 > 800
  });
});

group('events — ended projects honored, harsh swings, weeks closed', () => {
  it('lists an ended project with lifespan, lifetime totals and its teach-note', () => {
    const s = assembleStatement(
      input({
        weeksClosed: 7,
        projects: [
          project({
            id: 1,
            name: 'Sunset',
            status: 'ended',
            startDate: '2026-01-01',
            endDate: '2026-05-15',
            endingNote: 'Taught me to price fixed-bid work higher.',
            metrics: metrics({ totalRevenue: 4200 }),
            lifetimeHours: 133.4,
          }),
        ],
      }),
    );
    expect(s.events.ended).toHaveLength(1);
    const ended = s.events.ended[0]!;
    expect(ended.name).toBe('Sunset');
    expect(ended.lifespan_days).toBe(134); // 2026-01-01 → 2026-05-15
    expect(ended.lifetime_revenue).toBe(4200);
    expect(ended.lifetime_hours).toBe(133.4);
    expect(ended.ending_note).toBe('Taught me to price fixed-bid work higher.');
    expect(s.events.weeks_closed).toBe(7);
  });
});

group('quotes — the tool quoting you back to yourself', () => {
  it('quotes the note nearest the largest valence turn, verbatim and dated', () => {
    const s = assembleStatement(
      input({
        projects: [
          project({
            id: 1,
            name: 'Corporate',
            moodEvents: [
              ev('happy', '2026-04-15'),
              ev('miserable', '2026-05-10', { note: 'Client moved the deadline again.' }),
              ev('miserable', '2026-06-01'),
            ],
          }),
        ],
      }),
    );
    expect(s.quotes).toHaveLength(1);
    expect(s.quotes[0]).toEqual({
      project_id: 1,
      project_name: 'Corporate',
      date: '2026-05-10',
      text: 'Client moved the deadline again.',
    });
  });

  it('has no quotes section when there are no annotations near a turn (no filler)', () => {
    const s = assembleStatement(
      input({
        projects: [
          project({
            id: 1,
            name: 'Quiet',
            moodEvents: [ev('happy', '2026-04-15'), ev('miserable', '2026-05-10')],
          }),
        ],
      }),
    );
    expect(s.quotes).toEqual([]);
  });
});

group('the one recommendation — drift > harsh swing > concentration', () => {
  // An established, decisively declining stream → feeling drift fires (the top-priority finding).
  const declining: StatementMoodEvent[] = [
    ev('excited', '2026-04-10'),
    ev('opportunistic', '2026-05-15'),
    ev('pessimistic', '2026-06-18'),
    ev('sad', '2026-06-25'),
    ev('miserable', '2026-06-29'),
  ];
  // A harsh oscillation over a short span (not established → no drift possible).
  const harsh: StatementMoodEvent[] = [
    ev('excited', '2026-06-16'),
    ev('miserable', '2026-06-17'),
    ev('excited', '2026-06-20'),
    ev('miserable', '2026-06-21'),
  ];

  it('emits drift when an active project is decisively sliding', () => {
    const s = assembleStatement(input({ projects: [project({ id: 1, name: 'Corporate', moodEvents: declining })] }));
    expect(s.recommendation).not.toBeNull();
    expect(s.recommendation!.kind).toBe('drift');
    expect(s.recommendation!.project_id).toBe(1);
  });

  it('emits harsh-swing when there is no drift but a hard swing', () => {
    const s = assembleStatement(input({ projects: [project({ id: 2, name: 'Whiplash', moodEvents: harsh })] }));
    expect(s.recommendation!.kind).toBe('harsh_swing');
    expect(s.recommendation!.sentence).toContain('Whiplash');
  });

  it('drift outranks harsh swing when both are present', () => {
    const s = assembleStatement(
      input({
        projects: [
          project({ id: 2, name: 'Whiplash', moodEvents: harsh }),
          project({ id: 1, name: 'Corporate', moodEvents: declining }),
        ],
      }),
    );
    expect(s.recommendation!.kind).toBe('drift');
  });

  it('falls back to concentration when one project dominates income', () => {
    const s = assembleStatement(
      input({
        projects: [
          project({ id: 1, name: 'BigClient', metrics: metrics({ monthlyRevenue: 9000 }) }),
          project({ id: 2, name: 'Tiny', metrics: metrics({ monthlyRevenue: 500 }) }),
        ],
      }),
    );
    expect(s.recommendation!.kind).toBe('concentration');
    expect(s.recommendation!.project_id).toBe(1);
    expect(s.recommendation!.sentence).toContain('%');
  });

  it('is null (no filler) for a sparse, balanced quarter with nothing to flag', () => {
    const s = assembleStatement(
      input({
        projects: [
          project({ id: 1, name: 'A', metrics: metrics({ monthlyRevenue: 500 }) }),
          project({ id: 2, name: 'B', metrics: metrics({ monthlyRevenue: 500 }) }),
        ],
      }),
    );
    expect(s.recommendation).toBeNull();
    expect(s.quotes).toEqual([]);
    expect(s.events.ended).toEqual([]);
  });
});
