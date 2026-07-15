import type { Knex } from 'knex';

// Split the single mood check-in into two prompted questions plus an explicit "didn't touch it"
// (ticket 26; owner decision 2026-07-14, breaktrough.md §4). Rather than a second table, the
// existing mood_events stream gains a `kind` discriminator so the single write path and the
// settling-window invariant in domain/mood.ts keep living in exactly one place:
//   feeling   — "How do you feel about it?" (the original stream; every existing row is one of these)
//   trend     — "How is it going?" (the self-reported projects.trend, promoted to its own stream)
//   untouched — an explicit "I didn't touch it" answer, distinct from silently skipping
//
// Additive only: `kind` defaults to 'feeling', so every existing row becomes a feeling event with
// NO backfill and NO value rewrite (history is the product — grateful/opportunistic/pessimistic
// rows keep their values forever). Plain string column, app-validated against MOOD_KINDS, never a
// DB enum (same reasoning as value/source/compensation_model).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mood_events', (table) => {
    table.string('kind', 16).notNullable().defaultTo('feeling');
    // The new read shape is "this project's stream of ONE kind, newest first" (a per-kind settling
    // lookup and every kind-scoped reader). Covers user_id, project_id, kind, created_at.
    table.index(
      ['user_id', 'project_id', 'kind', 'created_at'],
      'mood_events_user_id_project_id_kind_created_at_index',
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mood_events', (table) => {
    table.dropIndex(
      ['user_id', 'project_id', 'kind', 'created_at'],
      'mood_events_user_id_project_id_kind_created_at_index',
    );
    table.dropColumn('kind');
  });
}
