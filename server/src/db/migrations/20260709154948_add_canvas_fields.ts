import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Two self-reported canvas annotations on the project itself. Nullable, no DB enum/check —
  // validated in the app layer against domain/constants.ts (FEELINGS / TRENDS), mirroring how
  // compensation_model is handled. `trend` here is the user's gut feel, NOT the computed
  // 3-month revenue trend.
  await knex.schema.alterTable('projects', (table) => {
    table.string('feeling', 24).nullable();
    table.string('trend', 16).nullable();
  });

  // A row in canvas_positions means "this project is placed on the board" at (x, y). Removing a
  // card from the board is a soft-delete (deleted_at set), never a hard delete — placing again
  // revives/updates the same row (see the unique constraint below).
  await knex.schema.createTable('canvas_positions', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    table.integer('project_id').unsigned().notNullable().references('id').inTable('projects');
    table.integer('x').notNullable();
    table.integer('y').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    // At most one position row per project per user; re-placing a removed card revives this row
    // rather than inserting a duplicate.
    table.unique(['user_id', 'project_id']);
    // The board list query filters live positions for a user.
    table.index(['user_id', 'deleted_at'], 'canvas_positions_user_id_deleted_at_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('canvas_positions');
  // Drop only the two columns this migration added; leave the rest of `projects` untouched.
  await knex.schema.alterTable('projects', (table) => {
    table.dropColumn('feeling');
    table.dropColumn('trend');
  });
}
