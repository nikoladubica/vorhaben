import type { Knex } from 'knex';
import { hashPassword } from '../../auth/password.js';

// ---------------------------------------------------------------------------
// Development sample data (run manually: `npm run seed --workspace server`)
// ---------------------------------------------------------------------------
//
// LOGIN CREDENTIALS for the seeded account:
//     email:    demo@vorhaben.test
//     password: password123
// The password is bcrypt-hashed here (cost 12) exactly like auth/password.ts, so you can log in
// through the normal /api/auth/login flow.
//
// This seed is IDEMPOTENT and SCOPED: it resets ONLY the demo user's own rows (found by the seed
// email) and re-inserts them, then UPSERTs the GLOBAL fx_rates it needs. It NEVER truncates a
// table and NEVER deletes another user's data — honoring the project's "never hard-delete user
// data / never truncate" constraints while still giving a clean, repeatable dev dataset.
//
// The dataset is built so the two dashboard best-performer rankings genuinely DISAGREE (that
// disagreement is the product's core insight) and so every dashboard branch is exercised:
//   A freelance_client / hourly / EUR — big income, MANY hours  → tops by_monthly_revenue, low rate
//   B freelance_gig    / hourly / EUR — modest income, FEW hours → tops by_hourly_rate, low revenue
//   C product          / variable / EUR — entries but NO hours   → in revenue ranking, absent from rate
//   D contract         / fixed / USD    — foreign currency + fixed amortization (fx exercised)
//   E job              / salary_monthly / EUR, status ended      → excluded from rankings, in trend/timeline
//   F freelance_gig    / hourly / GBP    — GBP entry, NO GBP rate → surfaces in warnings.missing_rates
//   G project          / variable / EUR, status idea, no entries → confirms idea/no-data exclusion
//
// Dates are computed RELATIVE TO TODAY at run time, so the seed stays valid whenever it runs:
// the "recent" entries land inside the trailing-3-month ranking window, the "older" ones inside
// the 6-month trend range but outside the ranking window.

const SEED_EMAIL = 'demo@vorhaben.test';
const SEED_PASSWORD = 'password123';

// --- Date helpers (UTC-anchored 'YYYY-MM-DD') ------------------------------

const TODAY = new Date();

function daysAgo(n: number): string {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function monthsAgo(n: number): string {
  const d = new Date(TODAY);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

interface SeedProject {
  name: string;
  type: string;
  status: 'idea' | 'active' | 'paused' | 'ended';
  start_date: string;
  end_date: string | null;
  compensation_model: string;
  rate_amount: string | null;
  rate_currency: string | null;
  entries: Array<{ date: string; amount: string; currency: string }>;
  timeLogs: Array<{ date: string; hours: string }>;
}

export async function seed(knex: Knex): Promise<void> {
  // 1. Scoped reset: remove ONLY this demo user's data (if a prior run created it).
  const existing = await knex('users').where({ email: SEED_EMAIL }).first('id');
  if (existing) {
    const userId = (existing as { id: number }).id;
    const projectIds = (
      await knex('projects').where({ user_id: userId }).select('id')
    ).map((r: { id: number }) => r.id);

    if (projectIds.length > 0) {
      await knex('income_entries').whereIn('project_id', projectIds).del();
      await knex('time_logs').whereIn('project_id', projectIds).del();
      await knex('notes').whereIn('project_id', projectIds).del();
      await knex('project_tags').whereIn('project_id', projectIds).del();
    }
    await knex('projects').where({ user_id: userId }).del();
    await knex('tags').where({ user_id: userId }).del();
    await knex('users').where({ id: userId }).del();
  }

  // 2. The demo user (base currency EUR).
  const password_hash = await hashPassword(SEED_PASSWORD);
  const [userId] = await knex('users').insert({
    email: SEED_EMAIL,
    password_hash,
    base_currency: 'EUR',
  });
  const demoUserId = Number(userId);

  // 3. Global fx_rates (UPSERT, never truncate). USD and CHF against EUR; deliberately NO GBP so
  //    project F's GBP entry stays unconverted and surfaces in warnings.missing_rates.
  const rateAsOf = daysAgo(400); // safely before every seeded entry
  await knex('fx_rates')
    .insert([
      { currency: 'USD', base_currency: 'EUR', rate: '0.92000000', as_of: rateAsOf },
      { currency: 'CHF', base_currency: 'EUR', rate: '1.03000000', as_of: rateAsOf },
    ])
    .onConflict(['currency', 'base_currency', 'as_of'])
    .merge();

  // 4. Projects + their entries and time logs.
  const projects: SeedProject[] = [
    {
      // A — high revenue, LOW hourly rate (big income spread over many logged hours).
      name: 'Acme Corp Retainer',
      type: 'freelance_client',
      status: 'active',
      start_date: monthsAgo(10),
      end_date: null,
      compensation_model: 'hourly',
      rate_amount: '90.00',
      rate_currency: 'EUR',
      entries: [
        { date: daysAgo(7), amount: '4000.00', currency: 'EUR' },
        { date: daysAgo(30), amount: '4000.00', currency: 'EUR' },
        { date: daysAgo(60), amount: '4000.00', currency: 'EUR' },
        { date: daysAgo(100), amount: '3800.00', currency: 'EUR' },
        { date: daysAgo(125), amount: '3800.00', currency: 'EUR' },
        { date: daysAgo(145), amount: '3800.00', currency: 'EUR' },
      ],
      timeLogs: [
        { date: daysAgo(7), hours: '60.00' },
        { date: daysAgo(15), hours: '60.00' },
        { date: daysAgo(30), hours: '60.00' },
        { date: daysAgo(45), hours: '60.00' },
        { date: daysAgo(60), hours: '60.00' },
      ],
    },
    {
      // B — modest revenue, HIGH hourly rate (few logged hours).
      name: 'Logo Sprint',
      type: 'freelance_gig',
      status: 'active',
      start_date: monthsAgo(10),
      end_date: null,
      compensation_model: 'hourly',
      rate_amount: '150.00',
      rate_currency: 'EUR',
      entries: [
        { date: daysAgo(7), amount: '800.00', currency: 'EUR' },
        { date: daysAgo(35), amount: '800.00', currency: 'EUR' },
        { date: daysAgo(65), amount: '800.00', currency: 'EUR' },
        { date: daysAgo(105), amount: '700.00', currency: 'EUR' },
        { date: daysAgo(140), amount: '700.00', currency: 'EUR' },
      ],
      timeLogs: [
        { date: daysAgo(10), hours: '5.00' },
        { date: daysAgo(40), hours: '5.00' },
        { date: daysAgo(70), hours: '5.00' },
      ],
    },
    {
      // C — entries but NO time logs → in revenue ranking, absent from the hourly ranking.
      name: 'Notion Template Pack',
      type: 'product',
      status: 'active',
      start_date: monthsAgo(8),
      end_date: null,
      compensation_model: 'variable',
      rate_amount: null,
      rate_currency: null,
      entries: [
        { date: daysAgo(20), amount: '1500.00', currency: 'EUR' },
        { date: daysAgo(50), amount: '1500.00', currency: 'EUR' },
        { date: daysAgo(80), amount: '1500.00', currency: 'EUR' },
        { date: daysAgo(110), amount: '1400.00', currency: 'EUR' },
      ],
      timeLogs: [],
    },
    {
      // D — foreign currency + fixed amortization (total ÷ full duration).
      name: 'Platform Rebuild (Fixed Bid)',
      type: 'contract',
      status: 'active',
      start_date: monthsAgo(12),
      end_date: null,
      compensation_model: 'fixed',
      rate_amount: '30000.00',
      rate_currency: 'USD',
      entries: [{ date: daysAgo(30), amount: '30000.00', currency: 'USD' }],
      timeLogs: [],
    },
    {
      // E — ended salaried job: excluded from rankings, present in trend + timeline.
      name: 'Day Job (former)',
      type: 'job',
      status: 'ended',
      start_date: monthsAgo(8),
      end_date: daysAgo(15),
      compensation_model: 'salary_monthly',
      rate_amount: '3000.00',
      rate_currency: 'EUR',
      entries: [
        { date: daysAgo(30), amount: '3000.00', currency: 'EUR' },
        { date: daysAgo(60), amount: '3000.00', currency: 'EUR' },
        { date: daysAgo(90), amount: '3000.00', currency: 'EUR' },
      ],
      timeLogs: [],
    },
    {
      // F — GBP entry with NO GBP rate seeded → surfaces in warnings.missing_rates.
      name: 'UK Zine Cover',
      type: 'freelance_gig',
      status: 'active',
      start_date: monthsAgo(6),
      end_date: null,
      compensation_model: 'hourly',
      rate_amount: '120.00',
      rate_currency: 'GBP',
      entries: [{ date: daysAgo(30), amount: '500.00', currency: 'GBP' }],
      timeLogs: [],
    },
    {
      // G — idea project, no entries: confirms exclusion from rankings (appears only in timeline).
      name: 'Course Idea (unstarted)',
      type: 'project',
      status: 'idea',
      start_date: monthsAgo(1),
      end_date: null,
      compensation_model: 'variable',
      rate_amount: null,
      rate_currency: null,
      entries: [],
      timeLogs: [],
    },
  ];

  for (const p of projects) {
    const [projectId] = await knex('projects').insert({
      user_id: demoUserId,
      name: p.name,
      type: p.type,
      status: p.status,
      start_date: p.start_date,
      end_date: p.end_date,
      compensation_model: p.compensation_model,
      rate_amount: p.rate_amount,
      rate_currency: p.rate_currency,
    });
    const pid = Number(projectId);

    if (p.entries.length > 0) {
      await knex('income_entries').insert(
        p.entries.map((e) => ({
          project_id: pid,
          date: e.date,
          amount: e.amount,
          currency: e.currency,
        })),
      );
    }
    if (p.timeLogs.length > 0) {
      await knex('time_logs').insert(
        p.timeLogs.map((t) => ({
          project_id: pid,
          date: t.date,
          hours: t.hours,
        })),
      );
    }
  }
}
