import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('time_logs', (table) => {
    table.increments('id').primary();
    // Ownership flows through the project (no user_id column, per §6). Every query joins
    // projects and scopes by projects.user_id.
    table
      .integer('project_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('projects');
    table.date('date').notNullable();
    // Rough, self-reported hours for a day — no timer, no overlap detection. decimal(6,2) so
    // hours travel as an exact string (no float drift), matching income_entries.amount.
    table.decimal('hours', 6, 2).notNullable();
    table.string('note', 500).nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    // Effective-hourly-rate queries scan one project's logs by date. The project_id-leading
    // composite index also serves plain project_id lookups (and the FK), so no separate
    // single-column index is needed.
    table.index(['project_id', 'date'], 'time_logs_project_id_date_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('time_logs');
}
