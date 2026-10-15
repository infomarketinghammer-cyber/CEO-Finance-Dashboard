import type { Knex } from 'knex';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (env.db.client === 'sqlite3') {
  fs.mkdirSync(path.dirname(env.db.sqliteFile), { recursive: true });
}

const common = {
  migrations: {
    directory: path.join(__dirname, 'migrations'),
    extension: 'ts',
    loadExtensions: ['.ts', '.js'],
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
