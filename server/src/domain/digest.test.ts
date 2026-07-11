import { describe, expect, it } from 'vitest';
import {
  assembleDigest,
  monthPeriod,
  parseMonthPeriod,
  previousMonthPeriod,
  type DigestInput,
  type DigestProjectInput,
} from './digest.js';

// Three-project June fixture: nets sum to 6980, matching monthTotals' last element so the pure
// model stays internally consistent (as the DB loader guarantees).
const STUDIO: DigestProjectInput = {
  projectId: 1,
  name: 'Studio K',
  monthlyNet: 2480,
  effectiveHourlyRate: 62,
  prevMonthlyNet: 2400,
};
const ACME: DigestProjectInput = {
  projectId: 2,
  name: 'Acme Corp',
  monthlyNet: 4200,
  effectiveHourlyRate: 26,
  prevMonthlyNet: 4200,
};
const KIOSK: DigestProjectInput = {
  projectId: 3,
  name: 'Kiosk SaaS',
  monthlyNet: 300,
  effectiveHourlyRate: 12,
  prevMonthlyNet: 366, // 300 is ~18% below → a decline
};

function juneInput(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    period: monthPeriod(2026, 6),
    baseCurrency: 'CHF',
    projects: [STUDIO, ACME, KIOSK],
    monthTotals: [5000, 5200, 4800, 6000, 6800, 6980], // Jan..Jun
    topSignal: null,
    ...overrides,
  };
}

describe('period helpers', () => {
  it('builds a month period with labels and bounds', () => {
    const p = monthPeriod(2026, 6);
    expect(p).toMatchObject({ period: '2026-06', label: 'June', longLabel: 'June 2026', from: '2026-06-01', to: '2026-06-30' });
  });

  it('parses valid periods and rejects malformed / out-of-range ones', () => {
    expect(parseMonthPeriod('2026-06')?.month).toBe(6);
    expect(parseMonthPeriod('2026-13')).toBeNull();
    expect(parseMonthPeriod('2026-00')).toBeNull();
    expect(parseMonthPeriod('nope')).toBeNull();
  });

  it('previousMonthPeriod returns the prior full month and wraps January to December', () => {
    expect(previousMonthPeriod(new Date('2026-07-01T00:00:00Z')).period).toBe('2026-06');
    expect(previousMonthPeriod(new Date('2026-01-15T00:00:00Z')).period).toBe('2025-12');
  });
});

describe('assembleDigest', () => {
  it('reports an empty portfolio with no content and all-null figures', () => {
    const model = assembleDigest(juneInput({ projects: [], monthTotals: [null, null, null, null, null, null] }));
    expect(model.has_content).toBe(false);
    expect(model.monthly_equivalent).toBeNull();
    expect(model.best_by_rate).toBeNull();
    expect(model.biggest_earner).toBeNull();
    expect(model.needs_attention).toBeNull();
    expect(model.suggestion).toBeNull();
    expect(model.is_best_month).toBe(false);
  });

  it('computes the portfolio total, MoM delta/percent and best-month flag', () => {
    const model = assembleDigest(juneInput());
    expect(model.monthly_equivalent).toBe(6980);
    expect(model.mom_delta).toBe(180); // 6980 − 6800
    expect(model.mom_percent).toBe(2.6); // 180 / 6800
    expect(model.is_best_month).toBe(true); // 6980 ≥ every earlier month
    expect(model.has_content).toBe(true);
  });

  it('does not crown a month that is not the year high', () => {
    const model = assembleDigest(juneInput({ monthTotals: [5000, 5200, 4800, 6000, 9999, 6980] }));
    expect(model.is_best_month).toBe(false);
  });

  it('picks the best effective rate and the biggest earner', () => {
    const model = assembleDigest(juneInput());
    expect(model.best_by_rate).toMatchObject({ name: 'Studio K', value: 62 });
    expect(model.biggest_earner).toMatchObject({ name: 'Acme Corp', value: 4200 });
  });

  it('falls back to the sharpest revenue decline for needs-attention when no mood signal', () => {
    const model = assembleDigest(juneInput());
    expect(model.needs_attention).toMatchObject({ name: 'Kiosk SaaS', detail: '-18% vs May' });
    expect(model.suggestion).toBe(
      'Kiosk SaaS brought in 18% less than May — worth a look before you put more time into it.',
    );
  });

  it('prefers the mood engine top finding for needs-attention and reuses its sentence verbatim', () => {
    const sentence = 'Kiosk SaaS has been sliding for 3 weeks. Worth a decision before you put in more effort.';
    const model = assembleDigest(
      juneInput({ topSignal: { projectId: 3, name: 'Kiosk SaaS', sentence } }),
    );
    expect(model.needs_attention).toMatchObject({ project_id: 3, name: 'Kiosk SaaS', detail: '-18% vs May' });
    expect(model.suggestion).toBe(sentence); // verbatim, never re-authored
  });

  it('shows "worth a look" when the mood-flagged project has no revenue decline', () => {
    const model = assembleDigest(
      juneInput({ topSignal: { projectId: 1, name: 'Studio K', sentence: 'Studio K is wearing on you.' } }),
    );
    expect(model.needs_attention).toMatchObject({ name: 'Studio K', detail: 'worth a look' });
  });
});
