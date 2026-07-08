import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('income_entries', (table) => {
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
    // Original amount + currency, stored exactly as entered and never overwritten;
    // conversion to the base currency happens at read time via fx_rates (ticket 06).
    table.decimal('amount', 14, 2).notNullable();
    table.specificType('currency', 'char(3)').notNullable();
    table.string('note', 500).nullable();
    // 'expected' is unused until auto-generated salaried entries (ticket 17); adding it now
    // avoids a second migration on a hot table.
    table.enu('source', ['manual', 'expected']).notNullable().defaultTo('manual');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    // Every dashboard query is a ranged scan of one project's entries by date. The
    // project_id-leading composite index also serves plain project_id lookups (and the FK),
    // so no separate single-column index is needed.
    table.index(['project_id', 'date'], 'income_entries_project_id_date_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('income_entries');
}
