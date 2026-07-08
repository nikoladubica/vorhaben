import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('fx_rates', (table) => {
    // No user_id: FX rates are GLOBAL reference data (per §6). An EUR/USD rate is a fact about
    // the world, not personal data, so rows are shared across all tenants.
    table.specificType('currency', 'char(3)').notNullable();
    table.specificType('base_currency', 'char(3)').notNullable();
    // rate: 1 unit of `currency` = `rate` units of `base_currency`. Wider than the money
    // columns (decimal(14,2)) on purpose — JPY-per-BTC magnitudes plus sub-cent precision.
    table.decimal('rate', 18, 8).notNullable();
    table.date('as_of').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    // One rate per pair per day; conversion picks the latest as_of at-or-before a given date.
    table.primary(['currency', 'base_currency', 'as_of']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('fx_rates');
}
