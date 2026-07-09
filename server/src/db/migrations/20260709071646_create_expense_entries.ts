import type { Knex } from 'knex';

// expense_entries mirrors income_entries exactly, MINUS `source`: there are no auto-generated
// "expected" expenses, so every row is user-entered and needs no source/confirm/suppression
// machinery. Positive amounts mean money OUT (BUSINESS_LOGIC.md §8). Turning revenue into profit
// is the whole point — a margin project earning €500/mo on €400 of purchases nets ~€100.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('expense_entries', (table) => {
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
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    // Same access pattern as income_entries: ranged scans of one project's rows by date. The
    // project_id-leading composite index also serves plain project_id lookups (and the FK).
    table.index(['project_id', 'date'], 'expense_entries_project_id_date_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('expense_entries');
}
