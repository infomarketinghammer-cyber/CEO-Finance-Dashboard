import { env } from '../config/env.js';

/**
 * Postgres `jsonb` columns come back as parsed objects; SQLite text columns come
 * back as strings. Every read of a json column goes through here so callers never
 * have to care which engine is behind them.
 */
export function readJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value === 'string') {
    if (value === '') return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** Writes go in as a string on SQLite and as an object on Postgres. */
export function writeJson(value: unknown): string | unknown {
  if (value === null || value === undefined) return null;
  return env.db.client === 'pg' ? JSON.stringify(value) : JSON.stringify(value);
}
