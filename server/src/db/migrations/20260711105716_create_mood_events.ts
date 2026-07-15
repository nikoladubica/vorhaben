import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Mood stream (breaktrough.md §2.2). Today a project's mood is a single overwritten value on
  // projects.feeling; this table turns it into an append-only, timestamped ledger — one balance on
  // top (projects.feeling stays the denormalized current value, no read path changes), the full
  // transaction history below. Every mood change is appended here; the ONLY sanctioned mutation of
  // an existing row is the 15-minute settling-window edit in domain/mood.ts (a mis-tap was never
  // data). Multi-tenant from day one (user_id) and soft-delete like every user-authored table.
  await knex.schema.createTable('mood_events', (table) => {
    table.increments('id').primary();
    // Multi-tenant scoping. notNull — every event belongs to a user (unlike the voice-capture
    // tables, project_id is also notNull here: a mood is always about a specific project).
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    table.integer('project_id').unsigned().notNullable().references('id').inTable('projects');
    // The feeling at this point in time. Nullable — null means the feeling was cleared (the ledger
    // records what the user saw). App-validated against FEELINGS exactly like projects.feeling;
    // never a DB enum (same reasoning as compensation_model / feeling / trend / status).
    table.string('value', 24).nullable();
    // Optional one-line "why?" note attached to the change.
    table.string('note', 1000).nullable();
    // Verbatim dictation when the note came from voice — mirrors the checklists/reminders/notes
    // source_transcript pattern (store the original, never rewrite the user's words).
    table.text('source_transcript').nullable();
    // Which flow produced this event: manual | nudge | weekly_close. App-validated closed list,
    // plain string not a native enum. Defaulted so a bare insert is well-formed.
    table.string('source', 16).notNullable().defaultTo('manual');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    // Every read is "this project's stream, newest first" — scoped by user, filtered by project,
    // ordered by created_at.
    table.index(
      ['user_id', 'project_id', 'created_at'],
      'mood_events_user_id_project_id_created_at_index',
    );
  });

  // Backfill: seed one event per live project that already has a feeling, so history starts today
  // rather than empty. NOTE: created_at here is the migration date (NOW()), NOT the true moment the
  // feeling was originally set — that information was never recorded before this table existed.
  const projects = await knex('projects')
    .whereNull('deleted_at')
    .whereNotNull('feeling')
    .select('user_id', 'id', 'feeling');

  if (projects.length > 0) {
    await knex('mood_events').insert(
      projects.map((p: { user_id: number; id: number; feeling: string }) => ({
        user_id: p.user_id,
        project_id: p.id,
        value: p.feeling,
        source: 'manual',
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      })),
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('mood_events');
}
