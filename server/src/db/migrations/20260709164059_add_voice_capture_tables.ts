import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Voice capture (§ voice-capture). Four self-authored capture kinds plus a source_transcript
  // column on the existing notes table. Every top-level capture table follows the
  // canvas_positions precedent: user_id (FK users, notNull) for multi-tenant scoping + a NULLABLE
  // project_id (FK projects) because a capture may be filed against a project or left unassigned
  // ("remind me to invoice" with no project is legal) + deleted_at soft-delete + a
  // (user_id, deleted_at) index for the per-user live-rows list query. status is validated in the
  // app layer against a closed list, never a DB enum — adding a status later must not be an ALTER
  // of a native enum (same reasoning as compensation_model / feeling / trend).

  // A titled list of check/uncheck items. The raw dictation that produced it is kept verbatim in
  // source_transcript (nullable — a checklist created by hand carries none), mirroring the project
  // rule of preserving originals rather than overwriting them.
  await knex.schema.createTable('checklists', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    // Nullable: a checklist may stay unassigned (project_id IS NULL) or be filed against a project.
    table.integer('project_id').unsigned().nullable().references('id').inTable('projects');
    table.string('title', 255).notNullable();
    table.text('source_transcript').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    // The list query filters live checklists for a user.
    table.index(['user_id', 'deleted_at'], 'checklists_user_id_deleted_at_index');
  });

  // Items belonging to a checklist. Ownership flows through the parent checklist (which carries
  // user_id), so no user_id/deleted_at here — an item's lifecycle is the checklist's. position is
  // the array order captured at create time; checked is the check/uncheck state.
  await knex.schema.createTable('checklist_items', (table) => {
    table.increments('id').primary();
    table.integer('checklist_id').unsigned().notNullable().references('id').inTable('checklists');
    table.string('text', 255).notNullable();
    table.boolean('checked').notNullable().defaultTo(false);
    table.integer('position').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    // The list route scans one checklist's items ordered by position.
    table.index(['checklist_id'], 'checklist_items_checklist_id_index');
  });

  // A dated (or undated) reminder with a done/dismiss lifecycle. remind_at is nullable — an
  // undated reminder is legal. status is a plain string checked in the app against
  // pending|done|dismissed (default 'pending'), NOT a DB enum. One table + one POST endpoint serve
  // both the voice flow (sends source_transcript) and the manual form (leaves it NULL).
  await knex.schema.createTable('reminders', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    table.integer('project_id').unsigned().nullable().references('id').inTable('projects');
    table.string('text', 1000).notNullable();
    table.datetime('remind_at').nullable();
    table.string('status', 16).notNullable().defaultTo('pending');
    table.text('source_transcript').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    table.index(['user_id', 'deleted_at'], 'reminders_user_id_deleted_at_index');
  });

  // A titled entry at a specific point in time. Unlike reminders, starts_at is NOT NULL — an event
  // without a time is not an event (the review UI blocks the save).
  await knex.schema.createTable('events', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    table.integer('project_id').unsigned().nullable().references('id').inTable('projects');
    table.string('title', 255).notNullable();
    table.datetime('starts_at').notNullable();
    table.text('source_transcript').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    table.index(['user_id', 'deleted_at'], 'events_user_id_deleted_at_index');
  });

  // notes already exists (project-scoped, hard-delete, no user_id/deleted_at). Only ADD the
  // nullable source_transcript column so a note saved from a voice capture keeps its raw
  // dictation; a hand-typed note leaves it NULL. Ownership/delete model of notes is untouched.
  await knex.schema.alterTable('notes', (table) => {
    table.text('source_transcript').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  // Drop only the source_transcript column this migration added to notes; leave the rest untouched.
  await knex.schema.alterTable('notes', (table) => {
    table.dropColumn('source_transcript');
  });
  // Reverse FK order so rollback is clean: checklist_items references checklists.
  await knex.schema.dropTableIfExists('events');
  await knex.schema.dropTableIfExists('reminders');
  await knex.schema.dropTableIfExists('checklist_items');
  await knex.schema.dropTableIfExists('checklists');
}
