import type { Knex } from 'knex';

// Onboarding preference (design screen "03"): whether this user tracks hours (effective hourly
// rate is meaningful) or only revenue. Defaults to true so existing rows — and anyone who skips
// the wizard — keep the current hour-tracking behaviour. One additive column; down() drops only
// what up() added.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.boolean('track_hours').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('track_hours');
  });
}
