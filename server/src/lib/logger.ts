import { env } from '../config/env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? (env.isProd ? 'info' : 'debug')] ?? 20;

/**
 * Keys whose values are never written to logs. Financial amounts are not secret in
 * themselves, but ledger-level detail in a shared log stream is an avoidable
 * disclosure, so row payloads are summarised by count rather than echoed.
 */
const REDACT = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'apiKey',
  'api_key',
  'secret',
  'cookie',
]);

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limited]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.length > 20 ? `[array:${value.length}]` : value.map((v) => scrub(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.has(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ? (scrub(meta) as Record<string, unknown>) : {}),
  };
  const text = env.isProd ? JSON.stringify(line) : `${line.ts} ${level.toUpperCase().padEnd(5)} ${msg}${meta ? ' ' + JSON.stringify(scrub(meta)) : ''}`;
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
