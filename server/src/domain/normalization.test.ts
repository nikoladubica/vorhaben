import { describe, expect, it } from 'vitest';
import {
  computeProjectMetrics,
  type MetricsEntry,
  type MetricsProject,
  type MetricsTimeLog,
  type NormalizationOptions,
} from './normalization.js';

// The pure layer is tested with fixtures only — no DB. All amounts here are already
// "converted" (base-currency numbers), exactly as metrics.ts feeds them.

const DAYS_PER_MONTH = 30.44;
const ASOF = '2026-07-08';

function entry(date: string, converted: number, missingRate = false): MetricsEntry {
  return { date, converted, missingRate };
}

function log(date: string, hours: number): MetricsTimeLog {
  return { date, hours };
}

function project(
  compensationModel: MetricsProject['compensationModel'],
  startDate: string,
  endDate: string | null = null,
): MetricsProject {
  return { compensationModel, startDate, endDate };
}

// Add whole days to a 'YYYY-MM-DD' date (UTC), for generating recurring-entry fixtures.
function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

describe('computeProjectMetrics — windowing & month arithmetic', () => {
  it('uses the trailing 3-calendar-month window ending at asOf (~2.99 months)', () => {
    const m = computeProjectMetrics(project('variable', '2024-01-01'), [], [], { asOf: ASOF });
    expect(m.window.from).toBe('2026-04-08');
    expect(m.window.to).toBe('2026-07-08');
    // 91 days / 30.44 ≈ 2.99.
    expect(m.window.months).toBeCloseTo(91 / DAYS_PER_MONTH, 6);
  });

  it('shortens the window to the project start for a 45-day-old project (~1.478 months)', () => {
    const start = addDays(ASOF, -45); // 2026-05-24
    const entries = [entry(start, 1000)];
    const m = computeProjectMetrics(project('hourly', start), entries, [], { asOf: ASOF });

    expect(m.window.from).toBe(start);
    expect(m.window.months).toBeCloseTo(45 / DAYS_PER_MONTH, 6);
    // Revenue divides by the shortened ~1.478 months, not a full quarter.
    expect(m.monthlyRevenue).toBeCloseTo(1000 / (45 / DAYS_PER_MONTH), 6);
  });
});

describe('computeProjectMetrics — salaried factors verified through entry sums', () => {
  // A full-year custom window; the ×26÷12 / ×52÷12 / as-is factors emerge purely from how many
  // entries land in the year, since salaried models have no special code path.
  const window = { from: '2025-07-08', to: '2026-07-08' };
  const opts: NormalizationOptions = { asOf: ASOF, window };
  const start = '2025-01-01'; // older than the window, so no shortening

  it('salary_monthly: 12 monthly entries → the monthly amount as-is', () => {
    const amount = 4000;
    const entries: MetricsEntry[] = [];
    for (let i = 0; i < 12; i++) entries.push(entry(addDays('2025-07-15', i * 30), amount));
    const m = computeProjectMetrics(project('salary_monthly', start), entries, [], opts);

    // 12 * amount / ~12 months ≈ amount (within the 30.44 approximation).
    expect(relErr(m.monthlyRevenue, amount)).toBeLessThan(0.005);
  });

  it('salary_biweekly: 26 entries per year → amount × 26 ÷ 12', () => {
    const amount = 2000;
    const entries: MetricsEntry[] = [];
    for (let i = 0; i < 26; i++) entries.push(entry(addDays('2025-07-14', i * 14), amount));
    const m = computeProjectMetrics(project('salary_biweekly', start), entries, [], opts);

    expect(m.entryCount).toBe(26);
    expect(relErr(m.monthlyRevenue, (amount * 26) / 12)).toBeLessThan(0.005);
  });

  it('salary_weekly: 52 entries per year → amount × 52 ÷ 12', () => {
    const amount = 1000;
    const entries: MetricsEntry[] = [];
    for (let i = 0; i < 52; i++) entries.push(entry(addDays('2025-07-10', i * 7), amount));
    const m = computeProjectMetrics(project('salary_weekly', start), entries, [], opts);

    expect(m.entryCount).toBe(52);
    expect(relErr(m.monthlyRevenue, (amount * 52) / 12)).toBeLessThan(0.005);
  });
});

describe('computeProjectMetrics — fixed amortization', () => {
  it('amortizes an ended fixed project over its start→end span, ignoring the window', () => {
    // 90-day engagement, single 9000 payment. Entry is BEFORE the trailing window, proving the
    // fixed path uses all entries / full duration rather than windowed revenue.
    const m = computeProjectMetrics(
      project('fixed', '2026-01-01', '2026-04-01'),
      [entry('2026-02-01', 9000)],
      [],
      { asOf: ASOF },
    );

    const durationMonths = 90 / DAYS_PER_MONTH;
    expect(m.monthlyRevenue).toBeCloseTo(9000 / durationMonths, 6);
    expect(m.entryCount).toBe(1); // all entries count for fixed, even out-of-window ones
    // No windowed hours and no windowed revenue → effective rate is null, not the monthly figure.
    expect(m.effectiveHourlyRate).toBeNull();
  });

  it('amortizes an ongoing fixed project over start→asOf (span grows to today)', () => {
    const m = computeProjectMetrics(
      project('fixed', '2026-04-01', null),
      [entry('2026-04-15', 12000)],
      [],
      { asOf: ASOF },
    );

    // 2026-04-01 → 2026-07-08 = 98 days.
    const durationMonths = 98 / DAYS_PER_MONTH;
    expect(m.monthlyRevenue).toBeCloseTo(12000 / durationMonths, 6);
  });
});

describe('computeProjectMetrics — effective hourly rate null cases', () => {
  it('is null when the window has zero logged hours (entries present)', () => {
    const m = computeProjectMetrics(
      project('hourly', '2026-01-01'),
      [entry('2026-06-01', 2000)],
      [],
      { asOf: ASOF },
    );
    expect(m.effectiveHourlyRate).toBeNull();
    expect(m.monthlyRevenue).not.toBeNull();
  });

  it('is null (and revenue null) when there are no entries at all', () => {
    const m = computeProjectMetrics(project('hourly', '2026-01-01'), [], [log('2026-06-01', 10)], {
      asOf: ASOF,
    });
    expect(m.monthlyRevenue).toBeNull();
    expect(m.effectiveHourlyRate).not.toBeNull(); // hours exist, but revenue is 0
    expect(m.entryCount).toBe(0);
  });

  it('is null for a project younger than the window with no logged hours', () => {
    const start = addDays(ASOF, -20);
    const m = computeProjectMetrics(project('hourly', start), [entry(start, 500)], [], {
      asOf: ASOF,
    });
    expect(m.window.from).toBe(start); // shortened
    expect(m.effectiveHourlyRate).toBeNull();
  });

  it('divides windowed revenue by windowed hours when hours exist', () => {
    const m = computeProjectMetrics(
      project('hourly', '2026-01-01'),
      [entry('2026-06-01', 2000)],
      [log('2026-06-01', 40)],
      { asOf: ASOF },
    );
    expect(m.hoursInWindow).toBe(40);
    expect(m.effectiveHourlyRate).toBeCloseTo(50, 6);
  });
});

describe('computeProjectMetrics — missingRates propagation', () => {
  it('sets missingRates when a contributing entry came back unconverted', () => {
    const m = computeProjectMetrics(
      project('variable', '2026-01-01'),
      [entry('2026-06-01', 100, false), entry('2026-06-02', 200, true)],
      [],
      { asOf: ASOF },
    );
    expect(m.missingRates).toBe(true);
  });

  it('does not flag missingRates when the only missing entry is outside the window', () => {
    // A non-fixed project: the out-of-window entry does not contribute, so it does not flag.
    const m = computeProjectMetrics(
      project('variable', '2026-01-01'),
      [entry('2026-01-15', 500, true), entry('2026-06-01', 100, false)],
      [],
      { asOf: ASOF },
    );
    expect(m.missingRates).toBe(false);
  });
});

describe('computeProjectMetrics — headline ranking (acceptance)', () => {
  it('ranks a €50/h gig, a €4,000/mo job and a €300/mo product so the two rankings disagree', () => {
    const opts: NormalizationOptions = { asOf: ASOF };

    // €50/h gig: 40 hours logged, €2,000 revenue, all inside the window.
    const gig = computeProjectMetrics(
      project('hourly', '2026-01-01'),
      [entry('2026-06-15', 2000)],
      [log('2026-06-15', 40)],
      opts,
    );

    // €4,000/month job: three monthly entries in the window, plus enough hours to yield €25/h.
    const job = computeProjectMetrics(
      project('salary_monthly', '2025-01-01'),
      [entry('2026-05-01', 4000), entry('2026-06-01', 4000), entry('2026-07-01', 4000)],
      [log('2026-05-01', 160), log('2026-06-01', 160), log('2026-07-01', 160)],
      opts,
    );

    // €300/month product: three monthly entries, no hours logged (a product sells via free
    // `variable` entries — `product` is a project TYPE, not a compensation model).
    const product = computeProjectMetrics(
      project('variable', '2025-01-01'),
      [entry('2026-05-10', 300), entry('2026-06-10', 300), entry('2026-07-05', 300)],
      [],
      opts,
    );

    // Sanity on the raw figures.
    expect(gig.effectiveHourlyRate).toBeCloseTo(50, 6);
    expect(job.effectiveHourlyRate).toBeCloseTo(25, 6);
    expect(product.effectiveHourlyRate).toBeNull();

    // Ranking by monthly revenue: job > gig, and job > product.
    expect(job.monthlyRevenue).not.toBeNull();
    expect(gig.monthlyRevenue).not.toBeNull();
    expect(job.monthlyRevenue!).toBeGreaterThan(gig.monthlyRevenue!);
    expect(job.monthlyRevenue!).toBeGreaterThan(product.monthlyRevenue!);

    // Ranking by effective hourly rate: the small gig outranks the big job.
    expect(gig.effectiveHourlyRate!).toBeGreaterThan(job.effectiveHourlyRate!);

    // The disagreement, stated directly: gig beats job on hourly rate but loses on monthly revenue.
    const gigBeatsJobOnRate = gig.effectiveHourlyRate! > job.effectiveHourlyRate!;
    const gigBeatsJobOnRevenue = gig.monthlyRevenue! > job.monthlyRevenue!;
    expect(gigBeatsJobOnRate).toBe(true);
    expect(gigBeatsJobOnRevenue).toBe(false);
  });
});

describe('computeProjectMetrics — expenses & net (§8)', () => {
  const opts: NormalizationOptions = { asOf: ASOF };
  const start = '2025-01-01'; // older than the window, so no shortening

  // Three monthly income entries (€500) and three monthly expense entries (€400) inside the
  // trailing window; both streams normalize over the same ~2.99-month window.
  const income = [entry('2026-05-10', 500), entry('2026-06-10', 500), entry('2026-07-05', 500)];
  const expenses = [entry('2026-05-12', 400), entry('2026-06-12', 400), entry('2026-07-06', 400)];

  it('a margin project ranks by net (~revenue − expenses) and rates by net ÷ hours', () => {
    const hours = [log('2026-06-10', 30)]; // 30 windowed hours
    const m = computeProjectMetrics(project('variable', start), income, hours, opts, expenses);

    // Net is revenue minus expenses; with €500/mo in and €400/mo out it lands near €100/mo.
    expect(m.monthlyRevenue).not.toBeNull();
    expect(m.monthlyExpenses).not.toBeNull();
    expect(m.monthlyNet).toBeCloseTo(m.monthlyRevenue! - m.monthlyExpenses!, 6);
    expect(m.monthlyNet!).toBeGreaterThan(0);
    expect(m.monthlyNet!).toBeLessThan(m.monthlyRevenue!);

    // Effective hourly rate uses WINDOWED net (1500 − 1200 = 300) over 30 hours = €10/h — NOT the
    // gross €50/h that windowed revenue alone would give.
    expect(m.effectiveHourlyRate).toBeCloseTo((1500 - 1200) / 30, 6);
  });

  it('a project with zero expenses is byte-identical to the no-expense computation', () => {
    const hours = [log('2026-06-10', 40)];
    const withoutArg = computeProjectMetrics(project('variable', start), income, hours, opts);
    const withEmpty = computeProjectMetrics(project('variable', start), income, hours, opts, []);

    // monthly_net collapses to monthly_revenue and expenses are null; nothing else moves.
    expect(withoutArg.monthlyExpenses).toBeNull();
    expect(withoutArg.monthlyNet).toBe(withoutArg.monthlyRevenue);
    expect(withoutArg.effectiveHourlyRate).toBeCloseTo(1500 / 40, 6);
    expect(withEmpty).toEqual(withoutArg);
  });

  it('expenses with no income yield null revenue and a negative net', () => {
    const m = computeProjectMetrics(project('variable', start), [], [], opts, expenses);
    expect(m.monthlyRevenue).toBeNull();
    expect(m.monthlyExpenses).not.toBeNull();
    expect(m.monthlyNet).toBeCloseTo(-m.monthlyExpenses!, 6);
    expect(m.monthlyNet!).toBeLessThan(0);
  });

  it('null revenue AND null expenses give a null net', () => {
    const m = computeProjectMetrics(project('variable', start), [], [], opts, []);
    expect(m.monthlyRevenue).toBeNull();
    expect(m.monthlyExpenses).toBeNull();
    expect(m.monthlyNet).toBeNull();
  });

  it('the fixed model amortizes expenses over the engagement, like revenue', () => {
    // 90-day fixed engagement: a single 9000 payment and a single 3000 purchase, both BEFORE the
    // trailing window — proving expenses take the same all-entries / full-duration path.
    const m = computeProjectMetrics(
      project('fixed', '2026-01-01', '2026-04-01'),
      [entry('2026-02-01', 9000)],
      [],
      { asOf: ASOF },
      [entry('2026-02-10', 3000)],
    );
    const durationMonths = 90 / DAYS_PER_MONTH;
    expect(m.monthlyRevenue).toBeCloseTo(9000 / durationMonths, 6);
    expect(m.monthlyExpenses).toBeCloseTo(3000 / durationMonths, 6);
    expect(m.monthlyNet).toBeCloseTo((9000 - 3000) / durationMonths, 6);
  });

  it('flags missingRates when only an expense entry came back unconverted', () => {
    const m = computeProjectMetrics(
      project('variable', start),
      [entry('2026-06-01', 500)],
      [],
      opts,
      [entry('2026-06-02', 400, true)],
    );
    expect(m.missingRates).toBe(true);
  });
});

describe('computeProjectMetrics — multi-day time logs (hours prorated by window overlap)', () => {
  it('a range log half inside the window contributes half its hours', () => {
    // Window is 2026-04-08 → 2026-07-08. A 10-day log 2026-04-03 → 2026-04-12 (40 h total) has
    // 5 of its 10 days inside → 20 h. Plus a plain single-day 4 h log → 24 h in window.
    const m = computeProjectMetrics(
      project('variable', '2025-01-01'),
      [entry('2026-06-01', 1200)],
      [
        { date: '2026-04-03', endDate: '2026-04-12', hours: 40 },
        log('2026-06-10', 4),
      ],
      { asOf: ASOF },
    );
    expect(m.hoursInWindow).toBeCloseTo(24, 6);
    expect(m.effectiveHourlyRate).toBeCloseTo(1200 / 24, 6);
  });

  it('a range log entirely outside the window contributes nothing', () => {
    const m = computeProjectMetrics(
      project('variable', '2025-01-01'),
      [],
      [{ date: '2026-01-01', endDate: '2026-01-31', hours: 100 }],
      { asOf: ASOF },
    );
    expect(m.hoursInWindow).toBe(0);
  });
});

describe('computeProjectMetrics — all-time total revenue', () => {
  it('sums EVERY income entry regardless of window, model, or expenses', () => {
    // One entry inside the trailing window, one far before it: monthlyRevenue only sees the
    // windowed 2203, but totalRevenue is the raw all-time sum. Expenses never touch it.
    const m = computeProjectMetrics(
      project('variable', '2025-01-01'),
      [entry('2026-07-01', 2203), entry('2025-02-01', 1000)],
      [],
      { asOf: ASOF },
      [entry('2026-06-15', 300)],
    );
    expect(m.totalRevenue).toBeCloseTo(3203, 6);
    expect(m.monthlyRevenue).toBeCloseTo(2203 / (91 / DAYS_PER_MONTH), 6);
  });

  it('is null when the project has no income entries at all', () => {
    const m = computeProjectMetrics(project('variable', '2025-01-01'), [], [], { asOf: ASOF });
    expect(m.totalRevenue).toBeNull();
  });
});

// Relative error helper for the salaried-factor approximations (30.44-day month vs an exact 12).
function relErr(actual: number | null, expected: number): number {
  if (actual === null) return Number.POSITIVE_INFINITY;
  return Math.abs(actual - expected) / Math.abs(expected);
}
