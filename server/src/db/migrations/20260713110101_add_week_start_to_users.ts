import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // The first day of the user's week (ticket 19 / §2.5). This redefines the Weekly Close window:
  // 0 = Sunday (week runs Sun 00:00 → Sat 23:59), 1 = Monday (week runs Mon 00:00 → Sun 23:59).
  // Default 1 (Monday) preserves today's ISO-8601 behavior so existing users need no backfill and
  // Monday-start period keys stay byte-for-byte identical. It is independent of close_day, which
  // still picks which day within the window the banner opens.
  await knex.schema.alterTable('users', (table) => {
    table.tinyint('week_start').notNullable().defaultTo(1);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('week_start');
  });
}
