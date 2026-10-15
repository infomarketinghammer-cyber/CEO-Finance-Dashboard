import type { Knex } from 'knex';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { env } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (env.db.client === 'sqlite3') {
  fs.mkdirSync(path.dirname(env.db.sqliteFile), { recursive: true });
}

/**
 * Migrations are identified by name WITHOUT the file extension.
 *
 * In development the server runs the TypeScript sources through tsx, so the
 * migration file is `…_initial_schema.ts`. A production build runs the compiled
 * output, where the same migration is `…_initial_schema.js`. Knex records the
 * filename it ran, so with the default source a database migrated in
 * development reports its migrations as "missing" the moment the compiled build
 * starts against it — the schema is fine, only the bookkeeping disagrees.
 *
 * Recording the extensionless name makes a database portable between the two,
 * which is what any real deployment does: migrate once, then run the build.
 */
class ExtensionAgnosticMigrationSource {
  constructor(private readonly directory: string) {}

  async getMigrations(): Promise<{ name: string; file: string }[]> {
    if (!fs.existsSync(this.directory)) return [];

    return fs
      .readdirSync(this.directory)
      .filter((f) => /\.(ts|js|mjs|cjs)$/.test(f) && !/\.d\.ts$/.test(f) && !/\.map$/.test(f))
      .sort()
      .map((f) => ({ name: f.replace(/\.(ts|js|mjs|cjs)$/, ''), file: path.join(this.directory, f) }));
  }

  getMigrationName(migration: { name: string }): string {
    return migration.name;
  }

  async getMigration(migration: { file: string }): Promise<Knex.Migration> {
    // pathToFileURL keeps this working on Windows and under tsx alike.
    return (await import(pathToFileURL(migration.file).href)) as Knex.Migration;
  }
}

const migrationsDir = path.join(__dirname, 'migrations');

const common = {
  migrations: {
    migrationSource: new ExtensionAgnosticMigrationSource(migrationsDir),
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: path.join(__dirname, 'seeds'),
    extension: 'ts',
    loadExtensions: ['.ts', '.js'],
  },
};

export const config: Knex.Config =
  env.db.client === 'pg'
    ? {
        client: 'pg',
        connection: {
          host: env.db.pg.host,
          port: env.db.pg.port,
          user: env.db.pg.user,
          password: env.db.pg.password,
          database: env.db.pg.database,
          ssl: env.db.pg.ssl,
        },
        pool: { min: 2, max: 10 },
        ...common,
      }
    : {
        client: 'better-sqlite3',
        connection: { filename: env.db.sqliteFile },
        useNullAsDefault: true,
        pool: {
          min: 1,
          max: 1,
          afterCreate: (conn: any, done: (err?: Error) => void) => {
            // Foreign keys are OFF by default in SQLite; the schema relies on them.
            conn.pragma('foreign_keys = ON');
            conn.pragma('journal_mode = WAL');
            done();
          },
        },
        ...common,
      };

export default config;
