import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notes', (table) => {
    table.increments('id').primary();
    // Ownership flows through the project (no user_id column, per §6). Every query joins
    // projects and scopes by projects.user_id.
    table
      .integer('project_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('projects');
    table.string('title', 255).notNullable();
    // Raw Markdown, stored exactly as sent and never sanitized or parsed here — safe rendering
    // is a client concern (§3). mediumtext (16MB) because long-running project journals outgrow
    // the 64KB `text` limit.
    table.text('body_md', 'mediumtext').notNullable().defaultTo('');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    // updated_at is set explicitly in the PATCH route (not ON UPDATE CURRENT_TIMESTAMP) so we
    // fully control the "updated_at bumps on change, created_at never moves" behavior.
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    // The list route scans one project's notes and orders by updated_at desc; a single-column
    // project_id index covers the scan (and the FK). updated_at is left unindexed — a project's
    // note set is small enough that the sort is cheap.
    table.index(['project_id'], 'notes_project_id_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notes');
}
