import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Hosted-assistant token meter (ticket 12, marketing-strategy §3.5). Every server-side LLM call
  // made with OUR platform key routes through server/src/llm/gateway.ts, which writes one row here
  // per call recording response.usage. This is an APPEND-ONLY LOG, not user-authored data: like
  // nudge_log (ticket 06) it carries NO updated_at and NO deleted_at — there is nothing to edit and
  // nothing to soft-delete, it is a running meter. Multi-tenant from day one (user_id). Monthly
  // totals are computed by SUMming the four token columns within the billing window (created_at ≥
  // first-of-month). Raw token counts never leave the server — the usage endpoint exposes a
  // percentage only. BYOK calls (a user's own key) are never metered, so they write nothing here.
  await knex.schema.createTable('llm_usage', (table) => {
    table.increments('id').primary();
    // Multi-tenant scoping. notNull — every metered call belongs to a user. Indexed together with
    // created_at below so the month-to-date sum is a single indexed range scan per user.
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    // Which pipeline consumed the tokens: voice_parse | chat | digest. App-validated closed list
    // (server/src/llm/gateway.ts), a plain string not a native enum — same reasoning as
    // compensation_model / status: adding a feature later must not be an ALTER of a native enum.
    table.string('feature', 16).notNullable();
    // The model the call actually hit (e.g. claude-haiku-4-5). Kept for cost attribution/auditing;
    // never exposed to the client.
    table.string('model', 64).notNullable();
    // response.usage, at face value (open question 4 — cache reads counted at face value in v1).
    table.integer('input_tokens').notNullable().defaultTo(0);
    table.integer('output_tokens').notNullable().defaultTo(0);
    table.integer('cache_read_tokens').notNullable().defaultTo(0);
    table.integer('cache_creation_tokens').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    // The meter's read path: sum tokens for one user since the start of the billing window.
    table.index(['user_id', 'created_at'], 'llm_usage_user_id_created_at_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  // down() drops only what up() added.
  await knex.schema.dropTableIfExists('llm_usage');
}
