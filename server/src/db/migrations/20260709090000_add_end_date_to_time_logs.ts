import type { Knex } from 'knex';

// A time log can now cover a RANGE of days: `date` (start) … `end_date`, with `hours` holding
// the TOTAL for the whole range. `end_date` stays NULL for the common single-day log, so every
// existing row keeps its exact meaning without a backfill.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('time_logs', (table) => {
    table.date('end_date').nullable().after('date');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('time_logs', (table) => {
    table.dropColumn('end_date');
  });
}
