import { describe, expect, it } from 'vitest';
import { buildSuggestions, type Suggestion, type SuggestionProject } from './suggestions.js';

// The rules layer is pure, so it is tested with fixtures only — no DB. All revenue figures are
// already "converted" (base-currency numbers), exactly as the assembler in dashboard.ts feeds them.
//
// asOf is '2026-07-08', so the "last full month" is 2026-06 and the trailing 3-month window is
// [2026-04, 2026-05, 2026-06]; the current partial month (July) is excluded from every comparison.

const ASOF = '2026-07-08';
const BASE = 'EUR';

let nextId = 1;
function proj(overrides: Partial<SuggestionProject> = {}): SuggestionProject {
  return {
    projectId: nextId++,
    name: `Project ${nextId}`,
    status: 'active',
    effectiveHourlyRate: null,
    endMonth: null,
    revenueByMonth: {},
    ...overrides,
  };
}

function byRule(suggestions: Suggestion[], rule: Suggestion['rule']): Suggestion | undefined {
  return suggestions.find((s) => s.rule === rule);
}

describe('buildSuggestions — empty & no-op', () => {
  it('returns an empty array for no projects', () => {
    expect(buildSuggestions([], ASOF, BASE)).toEqual([]);
  });

  it('fires nothing when every project is balanced and steady', () => {
    // Two active projects, flat & equal revenue, no rates, no ended project, no concentration.
    const a = proj({ name: 'Alpha', revenueByMonth: { '2026-04': 500, '2026-05': 500, '2026-06': 500 } });
    const b = proj({ name: 'Beta', revenueByMonth: { '2026-04': 500, '2026-05': 500, '2026-06': 500 } });
    expect(buildSuggestions([a, b], ASOF, BASE)).toEqual([]);
  });
});

describe('buildSuggestions — rule 1: top_hourly', () => {
  it('fires (info) naming the leader and the runner-up multiple', () => {
    const top = proj({ name: 'Design for Acme', effectiveHourlyRate: 100 });
    const runner = proj({ name: 'Day job', effectiveHourlyRate: 40 });
    const suggestions = buildSuggestions([top, runner], ASOF, BASE);

    const hit = byRule(suggestions, 'top_hourly');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('info');
    expect(hit!.project_ids).toEqual([top.projectId, runner.projectId]);
    expect(hit!.message).toContain('Design for Acme');
    expect(hit!.message).toContain('Day job');
    expect(hit!.message).toContain('2.5×'); // 100 / 40
    expect(hit!.message).toContain('€100/h');
  });

  it('is silent with fewer than two rated active projects', () => {
    const rated = proj({ name: 'Only rated', effectiveHourlyRate: 90 });
    const unrated = proj({ name: 'No hours', effectiveHourlyRate: null });
    const suggestions = buildSuggestions([rated, unrated], ASOF, BASE);
    expect(byRule(suggestions, 'top_hourly')).toBeUndefined();
  });

  it('ignores paused and ended projects when ranking hourly rate', () => {
    const active = proj({ name: 'Active', status: 'active', effectiveHourlyRate: 60 });
    const paused = proj({ name: 'Paused', status: 'paused', effectiveHourlyRate: 200 });
    const ended = proj({ name: 'Ended', status: 'ended', effectiveHourlyRate: 300, endMonth: '2026-01' });
    // Only one ACTIVE rated project → not enough for the callout.
    expect(byRule(buildSuggestions([active, paused, ended], ASOF, BASE), 'top_hourly')).toBeUndefined();
  });
});

describe('buildSuggestions — rule 2: declining', () => {
  it('fires (warning) when last full month falls below 70% of the prior two-month average', () => {
    // Prior average 400; last month 100 (25%) → declining. Single project keeps other rules quiet.
    const p = proj({
      name: 'Slipping client',
      revenueByMonth: { '2026-04': 400, '2026-05': 400, '2026-06': 100 },
    });
    const suggestions = buildSuggestions([p], ASOF, BASE);

    const hit = byRule(suggestions, 'declining');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
    expect(hit!.project_ids).toEqual([p.projectId]);
    expect(hit!.message).toContain('Slipping client');
    expect(hit!.message).toContain('€100');
    expect(hit!.message).toContain('€400');
  });

  it('does not fire when the prior average is zero', () => {
    const p = proj({ name: 'Brand new', revenueByMonth: { '2026-06': 100 } });
    expect(byRule(buildSuggestions([p], ASOF, BASE), 'declining')).toBeUndefined();
  });

  it('does not fire on a mild dip above the 70% floor', () => {
    const p = proj({ name: 'Steady', revenueByMonth: { '2026-04': 400, '2026-05': 400, '2026-06': 320 } });
    expect(byRule(buildSuggestions([p], ASOF, BASE), 'declining')).toBeUndefined();
  });
});

describe('buildSuggestions — rule 3: revive', () => {
  it('fires (info) when an ended project out-earned every active one in its final quarter', () => {
    // Ended in March, averaged 3,000/month over Jan–Mar; the only active project earns ~200/month.
    const ended = proj({
      name: 'Old flagship',
      status: 'ended',
      endMonth: '2026-03',
      revenueByMonth: { '2026-01': 3000, '2026-02': 3000, '2026-03': 3000 },
    });
    const active = proj({
      name: 'Current gig',
      status: 'active',
      revenueByMonth: { '2026-04': 200, '2026-05': 200, '2026-06': 200 },
    });
    const suggestions = buildSuggestions([ended, active], ASOF, BASE);

    const hit = byRule(suggestions, 'revive');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('info');
    expect(hit!.project_ids).toEqual([ended.projectId]);
    expect(hit!.message).toContain('Old flagship');
    expect(hit!.message).toContain('€3,000');
    // Concentration must stay quiet: only the active project has income in the last 3 months.
    expect(byRule(suggestions, 'concentration')).toBeUndefined();
  });

  it('is silent when there is no active project to compare against', () => {
    const ended = proj({
      name: 'Solo ended',
      status: 'ended',
      endMonth: '2026-03',
      revenueByMonth: { '2026-01': 3000, '2026-02': 3000, '2026-03': 3000 },
    });
    expect(byRule(buildSuggestions([ended], ASOF, BASE), 'revive')).toBeUndefined();
  });
});

describe('buildSuggestions — rule 4: concentration', () => {
  it('fires (warning) when one project supplies more than 60% of windowed income', () => {
    const dominant = proj({
      name: 'Whale client',
      revenueByMonth: { '2026-04': 900, '2026-05': 900, '2026-06': 900 },
    });
    const minor = proj({ name: 'Side gig', revenueByMonth: { '2026-06': 100 } });
    const suggestions = buildSuggestions([dominant, minor], ASOF, BASE);

    const hit = byRule(suggestions, 'concentration');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
    expect(hit!.project_ids).toEqual([dominant.projectId]);
    expect(hit!.message).toContain('Whale client');
    expect(hit!.message).toContain('96%'); // 2700 / 2800
  });

  it('is silent for a single-project user (no more than one income source)', () => {
    const only = proj({
      name: 'Sole income',
      revenueByMonth: { '2026-04': 900, '2026-05': 900, '2026-06': 900 },
    });
    expect(byRule(buildSuggestions([only], ASOF, BASE), 'concentration')).toBeUndefined();
  });
});

describe('buildSuggestions — ordering', () => {
  it('returns warnings before info', () => {
    // A rated leader (info: top_hourly) and a declining active project (warning: declining).
    const leader = proj({
      name: 'Leader',
      effectiveHourlyRate: 100,
      revenueByMonth: { '2026-04': 400, '2026-05': 400, '2026-06': 100 }, // also declining
    });
    const runner = proj({
      name: 'Runner',
      effectiveHourlyRate: 40,
      revenueByMonth: { '2026-04': 400, '2026-05': 400, '2026-06': 400 },
    });
    const suggestions = buildSuggestions([leader, runner], ASOF, BASE);

    expect(byRule(suggestions, 'declining')).toBeDefined();
    expect(byRule(suggestions, 'top_hourly')).toBeDefined();
    // Concentration would need >60% share; here it is 500/900 → stays quiet, keeping the order test clean.
    expect(suggestions[0]?.severity).toBe('warning');
    expect(suggestions[suggestions.length - 1]?.severity).toBe('info');
  });
});

describe('buildSuggestions — currency formatting', () => {
  it('uses a trailing code for currencies without a known symbol', () => {
    const top = proj({ name: 'A', effectiveHourlyRate: 100 });
    const runner = proj({ name: 'B', effectiveHourlyRate: 40 });
    const hit = byRule(buildSuggestions([top, runner], ASOF, 'SEK'), 'top_hourly');
    expect(hit!.message).toContain('100 SEK/h');
  });
});
