import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Drift alerts' weekly budget (breaktrough.md §2.7, ticket 06). The tool whispers, never nags:
  // at most one nudge per project per KIND per ISO week. That budget must survive across devices, so
  // it cannot live in localStorage — it is a server-side meter. Like llm_usage (ticket 12) this is
  // an APPEND-ONLY meter, NOT user-authored data: it records that a nudge was shown, so it carries
  // no soft-delete column and is never edited. Multi-tenant from day one (user_id) all the same.
  await knex.schema.createTable('nudge_log', (table) => {
    table.increments('id').primary();
    // Multi-tenant scoping. notNull — every nudge belongs to a user.
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    // The project the nudge was about. notNull — a drift alert is always about one project.
    table.integer('project_id').unsigned().notNullable().references('id').inTable('projects');
    // Which trigger fired: feeling_drift | attention_drift. App-validated closed list (domain/
    // drift.ts), a plain string not a native enum (same reasoning as compensation_model / status).
    table.string('kind', 24).notNullable();
    // The ISO-8601 week the nudge was shown in, e.g. "2026-W28" (8 chars is the widest this reaches).
    // App-computed from the request "now" — the budget key.
    table.string('period', 8).notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    // The budget itself: one row per (user, project, kind, week). A second emit in the same week hits
    // this constraint and is skipped, so the meter enforces "one nudge per project per kind per week".
    table.unique(
      ['user_id', 'project_id', 'kind', 'period'],
      'nudge_log_user_id_project_id_kind_period_unique',
    );
  });

  // The ending ritual's one optional field — "what did it teach you?" (breaktrough.md §2.7 step 2).
  // Nullable free text on the project itself: filed alongside the project so the graveyard reads it
  // back with the rest of the project's lifetime figures. Not user PII beyond what projects already
  // hold; soft-delete on projects covers it.
  await knex.schema.alterTable('projects', (table) => {
    table.text('ending_note').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  // Reverse order: drop the added column first, then the meter table.
  await knex.schema.alterTable('projects', (table) => {
    table.dropColumn('ending_note');
  });
  await knex.schema.dropTableIfExists('nudge_log');
}
