import type { Knex } from 'knex';

// The 12 project types from BUSINESS_LOGIC.md §1.1. Seeded here (not in a Knex seed
// file) because they are reference data the app cannot run without — §1.1 requires
// adding a type later to be a migration, not a refactor.
const PROJECT_TYPES: ReadonlyArray<{ id: string; label: string; sort_order: number }> = [
  { id: 'job', label: 'Job', sort_order: 0 },
  { id: 'freelance_gig', label: 'Freelance Gig', sort_order: 1 },
  { id: 'freelance_client', label: 'Freelance Client', sort_order: 2 },
  { id: 'contract', label: 'Contract', sort_order: 3 },
  { id: 'project', label: 'Project', sort_order: 4 },
  { id: 'commission', label: 'Commission', sort_order: 5 },
  { id: 'margin', label: 'Margin', sort_order: 6 },
  { id: 'loan_interest', label: 'Loan Interest', sort_order: 7 },
  { id: 'stock', label: 'Stock', sort_order: 8 },
  { id: 'dividend', label: 'Dividend', sort_order: 9 },
  { id: 'product', label: 'Product', sort_order: 10 },
  { id: 'other', label: 'Other', sort_order: 11 },
];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (table) => {
    table.increments('id').primary();
    table.string('email', 255).notNullable().unique();
    table.string('password_hash', 255).notNullable();
    table.specificType('base_currency', 'char(3)').notNullable().defaultTo('EUR');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('project_types', (table) => {
    table.string('id', 32).primary();
    table.string('label', 255).notNullable();
    table.integer('sort_order').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('projects', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    table.string('name', 255).notNullable();
    table.string('type', 32).notNullable().references('id').inTable('project_types');
    table.text('description').nullable();
    table.enu('status', ['idea', 'active', 'paused', 'ended']).notNullable().defaultTo('active');
    table.date('start_date').notNullable();
    table.date('end_date').nullable();
    // compensation_model is validated in the app layer against domain/constants.ts,
    // not by a DB enum, so adding a model later touches one file and needs no schema change.
    table.string('compensation_model', 32).notNullable();
    table.decimal('rate_amount', 14, 2).nullable();
    table.specificType('rate_currency', 'char(3)').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    // Every list query filters on both columns (soft-deleted, per-user).
    table.index(['user_id', 'deleted_at'], 'projects_user_id_deleted_at_index');
  });

  await knex.schema.createTable('tags', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users');
    table.string('name', 64).notNullable();
    table.unique(['user_id', 'name']);
  });

  await knex.schema.createTable('project_tags', (table) => {
    table.integer('project_id').unsigned().notNullable().references('id').inTable('projects');
    table.integer('tag_id').unsigned().notNullable().references('id').inTable('tags');
    table.primary(['project_id', 'tag_id']);
  });

  await knex('project_types').insert(PROJECT_TYPES);
}

export async function down(knex: Knex): Promise<void> {
  // Reverse FK order so rollback is clean.
  await knex.schema.dropTableIfExists('project_tags');
  await knex.schema.dropTableIfExists('tags');
  await knex.schema.dropTableIfExists('projects');
  await knex.schema.dropTableIfExists('project_types');
  await knex.schema.dropTableIfExists('users');
}
