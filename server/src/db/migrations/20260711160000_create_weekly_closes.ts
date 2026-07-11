import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Weekly Close ritual (breaktrough.md §2.5). One row per user per ISO week records that the
  // week was closed, so the Quarterly Statement can cite completions ("11 of 13 weeks closed")
  // and drift alerts can lean on close-to-close mood readings — neither of which a localStorage
  // flag could do. Multi-tenant from day one (user_id) and soft-delete like every user-authored
  // table; re-running a close revives/updates the single row rather than inserting a duplicate,
  // which the unique(user_id, period) constraint enforces.
  await knex.schema.createTable('weekly_closes', (table) => {
    table.increments('id').primary();
    // Multi-tenant scoping. notNull — every close belongs to a user.
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    // ISO-8601 week the close covers, e.g. "2026-W28". App-computed (routes/closes.ts); an 8-char
    // string ("YYYY-Www") is the widest this format reaches.
    table.string('period', 8).notNullable();
    // When the close was completed. Updated on a re-close (idempotent), so it always reflects the
    // most recent completion for the week.
    table.timestamp('completed_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    // One close per week per user. A soft-deleted row is revived in place rather than replaced, so
    // this stays a single row across the row's whole lifetime.
    table.unique(['user_id', 'period'], 'weekly_closes_user_id_period_unique');
  });

  // The day of the week (0 = Sunday … 6 = Saturday, matching JS getDay) from which the "close the
  // week" banner opens. Defaulted to Sunday so an existing user's window is well-defined without a
  // backfill.
  await knex.schema.alterTable('users', (table) => {
    table.tinyint('close_day').notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  // Reverse order: drop the added column first, then the table.
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('close_day');
  });
  await knex.schema.dropTableIfExists('weekly_closes');
}
