import type { Knex } from 'knex';

// Tombstone table for ticket 17. Deleting an auto-generated expected entry must not resurrect
// it on the next lazy generation pass, so a delete records the (project, period-start) here and
// regeneration skips any period listed. Kept separate from income_entries (rather than a
// zero-amount row) so a suppression never counts in dashboard math and the entries table stays
// a table of real amounts only.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('suppressed_expected_entries', (table) => {
    // Ownership flows through the project (no user_id column, per §6), matching income_entries.
    table
      .integer('project_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('projects');
    // The period-start date the expected entry was keyed on (1st of month / Monday / anchor).
    table.date('period_date').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    // One tombstone per period per project; makes re-suppression a no-op via
    // .onConflict(['project_id','period_date']).ignore() (INSERT IGNORE).
    table.unique(['project_id', 'period_date'], 'suppressed_expected_project_period_unique');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('suppressed_expected_entries');
}
