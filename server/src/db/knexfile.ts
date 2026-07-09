import type { Knex } from 'knex';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';

// Resolve migration/seed dirs relative to this file (not the cwd) so the same
// config works whether run via tsx from src (dev) or as compiled JS in dist
// (production Docker). In production only the compiled `.js` files exist.
const here = path.dirname(fileURLToPath(import.meta.url));
const isProd = env.nodeEnv === 'production';

const config: Knex.Config = {
  client: 'mysql2',
  connection: {
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
  },
  migrations: {
    directory: path.join(here, 'migrations'),
    extension: 'ts',
    loadExtensions: [isProd ? '.js' : '.ts'],
  },
  seeds: {
    directory: path.join(here, 'seeds'),
    extension: 'ts',
    loadExtensions: [isProd ? '.js' : '.ts'],
  },
};

export default config;
