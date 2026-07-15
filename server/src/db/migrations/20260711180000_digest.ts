import type { Knex } from 'knex';
import { randomBytes } from 'node:crypto';

// Monthly email digest (ticket 16; BUSINESS_LOGIC §7/§8). Two additive changes — no data is
// dropped or rewritten, so this is a NON-destructive migration.
//
// 1. Two columns on `users`:
//    - `digest_opt_in` — the proactive touchpoint is OPT-IN, default FALSE. Nobody is emailed until
//      they turn it on (§7: "opt-in and cost-transparent").
//    - `digest_unsub_token` — an unguessable per-user token that the public unsubscribe link carries
//      so the recipient can turn the digest off WITHOUT logging in. Nullable + unique: MySQL/MariaDB
//      allow many NULLs under a UNIQUE index, so users who never opt in simply carry no token; the
//      job generates one lazily before the first send. Existing rows are backfilled here so every
//      current user already has one.
//
// 2. `digest_runs` — an APPEND-ONLY send ledger (like nudge_log / llm_usage): one row per user per
//    period recording that the month's digest went out. The UNIQUE (user_id, period) constraint is
//    the idempotency guard — a second run in the same month hits it and is skipped, so a user can
//    never be emailed twice for one period. Not user-authored data, so no soft-delete column.
//    Multi-tenant from day one (user_id) all the same.

// A URL-safe, unguessable token. 32 random bytes → 43 base64url chars; fits char(64) with headroom.
function unsubToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.boolean('digest_opt_in').notNullable().defaultTo(false);
    // char(64): the token is fixed-shape reference data, not free text. Unique across the table.
    table.specificType('digest_unsub_token', 'char(64)').nullable().unique();
  });

  // Backfill a token for every existing user so opting in never blocks on token generation. One
  // UPDATE per row — the user table is small and this runs once.
  const users = await knex('users').select<Array<{ id: number }>>('id');
  for (const user of users) {
    await knex('users').where('id', user.id).update({ digest_unsub_token: unsubToken() });
  }

  await knex.schema.createTable('digest_runs', (table) => {
    table.increments('id').primary();
    // Multi-tenant scoping. notNull — a run always belongs to a user.
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    // The billing/period key the digest covers, e.g. "2026-06" (7 chars). App-computed.
    table.specificType('period', 'char(7)').notNullable();
    table.timestamp('sent_at').notNullable().defaultTo(knex.fn.now());
    // The idempotency guard: exactly one send per user per period.
    table.unique(['user_id', 'period'], 'digest_runs_user_id_period_unique');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('digest_runs');
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('digest_unsub_token');
    table.dropColumn('digest_opt_in');
  });
}
