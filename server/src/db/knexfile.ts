import type { Knex } from 'knex';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';
import { CanonicalMigrationSource } from './migrationSource.js';

// Resolve migration/seed dirs relative to this file (not the cwd) so the same
// config works whether run via tsx from src (dev) or as compiled JS in dist
// (production Docker). In production only the compiled `.js` files exist.
const here = path.dirname(fileURLToPath(import.meta.url));
const isProd = env.nodeEnv === 'production';
const migrationsDir = path.join(here, 'migrations');

const config: Knex.Config = {
  client: 'mysql2',
  connection: {
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    // The database runs in UTC (the container clock is UTC and CURRENT_TIMESTAMP
    // stores UTC wall-clock). Without this, mysql2 defaults to 'local' and
    // reinterprets those UTC datetimes as the Node process's local timezone,
    // shifting every timestamp by the server's UTC offset on the way out — a
    // just-created row reads back as "N hours ago". 'Z' makes reads (and writes
    // of JS Date instants) round-trip as true UTC.
    timezone: 'Z',
  },
  migrations: {
    // The source decides what runs and, crucially, what name each migration is recorded under: the
    // compiled `.js` in the container is still recorded as its canonical `.ts`, so one database
    // works in both run modes. See migrationSource.ts.
    //
    // `directory` must NOT be set here. Knex treats any FS-related migration option (directory,
    // loadExtensions, sortDirsSeparately) as a declaration that you want its own file-based source,
    // and silently discards migrationSource when it sees one — so setting it would quietly restore
    // the exact `.ts`/`.js` split this source exists to remove. `migrate:make`, which needs a
    // directory to write into, gets it from --migrations-directory on the CLI instead (see
    // server/package.json); `extension` is safe to keep, and tells the generator what to write.
    migrationSource: new CanonicalMigrationSource(migrationsDir, isProd ? '.js' : '.ts'),
    extension: 'ts',
  },
  seeds: {
    directory: path.join(here, 'seeds'),
    extension: 'ts',
    loadExtensions: [isProd ? '.js' : '.ts'],
  },
};

export default config;
