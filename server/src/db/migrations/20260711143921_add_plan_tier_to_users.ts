import type { Knex } from 'knex';

// Max-tier entitlement column for the invoice scanner (ticket 14, marketing-strategy §3.6).
//
// Reconciliation note: ticket 13 already added a `plan` column to `users`, but it holds the hosted
// BILLING CADENCE the Assistant settings screen reads back ('monthly' | 'yearly' → $9/mo or $90/yr)
// — not a tier. The scanner introduces a SECOND paid tier (Max, $15/mo), which is an orthogonal
// dimension: a Max subscription is still billed monthly or yearly. Overloading `plan` would break
// ticket 13's normalizePlan display, so the tier lives in its own nullable column. `null` everywhere
// until billing (Stripe) writes it — matching the entitlement stub's default (see
// server/src/domain/entitlements.ts). One additive column; down() drops only what up() added.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    // Closed value set validated in the app layer (a plain string, not a native enum, mirroring
    // `plan` / `compensation_model` / `status`): currently only 'max' is meaningful.
    table.string('plan_tier', 16).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('plan_tier');
  });
}
