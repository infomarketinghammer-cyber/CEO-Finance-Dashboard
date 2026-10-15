import knexFactory, { type Knex } from 'knex';
import { config } from './knexfile.js';
import { env } from '../config/env.js';

export const db: Knex = knexFactory(config);

/**
 * Portability helpers. The schema is deliberately ANSI-ish so the same migrations
 * run on SQLite and Postgres, but three differences need bridging in query code.
 */
export const dialect = {
  isPg: env.db.client === 'pg',
  isSqlite: env.db.client === 'sqlite3',

  /** SQLite has no native boolean; knex stores 0/1. Normalise on read. */
  bool(v: unknown): boolean {
    return v === true || v === 1 || v === '1' || v === 't';
  },

  /** Case-insensitive LIKE. */
  ilike(builder: Knex.QueryBuilder, column: string, pattern: string): Knex.QueryBuilder {
    return env.db.client === 'pg'
      ? builder.where(column, 'ilike', pattern)
      : builder.whereRaw(`LOWER(${column}) LIKE LOWER(?)`, [pattern]);
  },

  /** Dates are stored as ISO yyyy-mm-dd strings in both engines for exact comparison. */
  today(): string {
    return new Date().toISOString().slice(0, 10);
  },
};

export type Tx = Knex.Transaction;

/** Run work inside a transaction. Used by every import commit. */
export async function withTransaction<T>(fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

export async function closeDb(): Promise<void> {
  await db.destroy();
}
