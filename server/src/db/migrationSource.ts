import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Knex } from 'knex';

// Knex writes each applied migration into `knex_migrations` under the name its migration source
// reports, and on every later run it cross-checks those recorded names against the files it finds on
// disk. A recorded name with no matching file is, to knex, a corrupt migration directory — it
// refuses to run at all.
//
// That check collides with this repo's two run modes. The same migration is a `.ts` file in dev
// (tsx, from src/) and a compiled `.js` file in the production image (node, from dist/). Under
// knex's default file-based source the recorded name carries the extension, so dev records
// `20260708120000_create_core_tables.ts` while the container records the exact same migration as
// `…​.js`. Either database is then unusable by the other run mode: point the container at a
// database that was migrated from source and it crash-loops on boot, reporting every migration as
// missing.
//
// So this source decouples the two: it LOADS whichever extension is actually on disk, but always
// REPORTS a migration under its canonical `.ts` name — the name of the file it was authored as.
// One identity per migration across both modes, so a database moves freely between them.
//
// Dev behavior is unchanged (it already loaded and recorded `.ts`); only the production image's
// bookkeeping is brought into line with it, which is why no existing `knex_migrations` row needs
// rewriting.

// The extension a migration is authored in, and therefore the one it is always recorded under.
const CANONICAL_EXT = '.ts';

export class CanonicalMigrationSource implements Knex.MigrationSource<string> {
  // `directory` is absolute (resolved from the knexfile's own location, not the cwd). `extension` is
  // what exists on disk in this run mode: '.ts' from src via tsx, '.js' from dist in the container.
  constructor(
    private readonly directory: string,
    private readonly extension: '.ts' | '.js',
  ) {}

  // Every migration file in the directory, sorted — knex relies on the order to decide what is
  // pending. `.d.ts` declaration files sit alongside the sources in some tsc layouts and are not
  // migrations, so they are filtered out explicitly.
  async getMigrations(): Promise<string[]> {
    const entries = await fs.readdir(this.directory);
    return entries
      .filter((file) => file.endsWith(this.extension) && !file.endsWith('.d.ts'))
      .sort();
  }

  // The identity persisted to knex_migrations. Always the canonical `.ts` name, whatever the file on
  // disk is called — this is the whole point of the class.
  getMigrationName(file: string): string {
    return `${path.basename(file, this.extension)}${CANONICAL_EXT}`;
  }

  // Import the actual file. A file:// URL is required: an absolute POSIX path happens to work for
  // ESM import on Linux/macOS but is not portable, and on Windows it is not a valid specifier.
  async getMigration(file: string): Promise<Knex.Migration> {
    const url = pathToFileURL(path.join(this.directory, file)).href;
    return (await import(url)) as Knex.Migration;
  }
}
