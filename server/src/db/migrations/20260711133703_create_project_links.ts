import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // A row in project_links means "these two projects are connected" with a typed relationship,
  // directed from_project_id ▸ to_project_id. Removing a connection on the board is a soft-delete
  // (deleted_at set), never a hard delete — re-linking the same ordered pair revives/updates the
  // same row (see the unique constraint below). `type` is a plain string column validated in the
  // app layer against domain/constants.ts (LINK_TYPES), mirroring how feeling/trend are handled —
  // no DB enum or check.
  await knex.schema.createTable('project_links', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    table.integer('from_project_id').unsigned().notNullable().references('id').inTable('projects');
    table.integer('to_project_id').unsigned().notNullable().references('id').inTable('projects');
    table.string('type', 16).notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    // At most one link row per ordered (from, to) pair per user; re-linking a removed pair revives
    // this row rather than inserting a duplicate.
    table.unique(['user_id', 'from_project_id', 'to_project_id']);
    // The board query filters live links for a user.
    table.index(['user_id', 'deleted_at'], 'project_links_user_id_deleted_at_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('project_links');
}
