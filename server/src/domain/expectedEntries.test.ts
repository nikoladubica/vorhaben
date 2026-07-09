import { describe, expect, it } from 'vitest';
import { expectedPeriods } from './expectedEntries.js';
import type { CompensationModel } from './constants.js';

// Only the PURE period math (expectedPeriods) is tested here — no DB, mirroring
// normalization.test.ts. ensureExpectedEntries needs a live connection and is exercised at
// runtime per the ticket's acceptance criteria.

const RATE = '4000.00';
const CUR = 'EUR';

// The period-start dates expectedPeriods emits, dropping amount/currency for concise assertions.
function dates(
  model: CompensationModel,
  start: string,
  end: string | null,
  today: string,
): string[] {
  return expectedPeriods(model, start, end, today, RATE, CUR).map((p) => p.date);
}

// getUTCDay: 1 === Monday. Used to prove weekly/biweekly output lands on Mondays.
function isMonday(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
}

describe('expectedPeriods — salary_monthly', () => {
  it('emits the 1st of each elapsed month between start and today', () => {
    // start 2026-04-09 (past the 1st) → first period is the NEXT month-1st, 2026-05-01.
    expect(dates('salary_monthly', '2026-04-09', null, '2026-07-09')).toEqual([
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
    ]);
  });

  it('includes the start month when the project starts on the 1st', () => {
    expect(dates('salary_monthly', '2026-05-01', null, '2026-07-09')).toEqual([
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
    ]);
  });

  it('carries the rate amount and currency verbatim on every element', () => {
    const periods = expectedPeriods('salary_monthly', '2026-04-09', null, '2026-07-09', RATE, CUR);
    expect(periods).toHaveLength(3);
    for (const p of periods) {
      expect(p.amount).toBe(RATE);
      expect(p.currency).toBe(CUR);
    }
  });

  it('emits a period whose start falls on/before end even though the period runs past it', () => {
    // Ends 2026-07-15, mid-July: the 2026-07-01 period start is ≤ end, so it still generates.
    const out = dates('salary_monthly', '2026-04-09', '2026-07-15', '2026-09-01');
    expect(out).toEqual(['2026-05-01', '2026-06-01', '2026-07-01']);
  });

  it('generates nothing for a future start date', () => {
    expect(dates('salary_monthly', '2026-08-01', null, '2026-07-09')).toEqual([]);
  });
});

describe('expectedPeriods — salary_weekly', () => {
  it('emits each Monday from the first Monday on/after start', () => {
    // start 2026-01-06 (a Tuesday) → first Monday is 2026-01-12, then +7 each.
    const out = dates('salary_weekly', '2026-01-06', null, '2026-01-27');
    expect(out).toEqual(['2026-01-12', '2026-01-19', '2026-01-26']);
    expect(out.every(isMonday)).toBe(true);
  });

  it('includes start when start itself is a Monday', () => {
    // 2026-01-05 is a Monday.
    const out = dates('salary_weekly', '2026-01-05', null, '2026-01-19');
    expect(out).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
  });
});

describe('expectedPeriods — salary_biweekly', () => {
  it('steps 14 days from the anchoring first Monday (fixed phase)', () => {
    // Anchor = first Monday ≥ 2026-01-06 = 2026-01-12; +14 → 01-26, 02-09.
    const out = dates('salary_biweekly', '2026-01-06', null, '2026-02-16');
    expect(out).toEqual(['2026-01-12', '2026-01-26', '2026-02-09']);
    expect(out.every(isMonday)).toBe(true);
    // Every gap is exactly two weeks.
    for (let i = 1; i < out.length; i++) {
      const gap =
        (Date.parse(`${out[i]}T00:00:00Z`) - Date.parse(`${out[i - 1]}T00:00:00Z`)) / 86_400_000;
      expect(gap).toBe(14);
    }
  });
});

describe('expectedPeriods — non-salaried models generate nothing', () => {
  const nonSalaried: CompensationModel[] = ['hourly', 'fixed', 'commission', 'variable'];
  for (const model of nonSalaried) {
    it(`returns [] for ${model}`, () => {
      expect(dates(model, '2026-01-01', null, '2026-07-09')).toEqual([]);
    });
  }
});
