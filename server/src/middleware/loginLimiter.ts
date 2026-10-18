import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';

/**
 * In-memory sign-in throttle: at most MAX_FAILURES failed attempts per
 * IP + email within WINDOW_MS, after which further attempts are refused until the
 * window passes. A successful sign-in clears the counter. State is per process;
 * behind several replicas, add a shared limiter at the proxy as well.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

const failures = new Map<string, { count: number; resetAt: number }>();

const keyOf = (req: Request) =>
  `${req.ip}|${String((req.body as { email?: unknown } | undefined)?.email ?? '').toLowerCase().trim()}`;

export function loginLimiter(req: Request, res: Response, next: NextFunction) {
  const key = keyOf(req);
  const now = Date.now();
  const entry = failures.get(key);

  if (entry && entry.resetAt <= now) failures.delete(key);

  const current = failures.get(key);
  if (current && current.count >= MAX_FAILURES) {
    res.setHeader('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
    return next(new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again in a few minutes.'));
  }

  res.on('finish', () => {
    if (res.statusCode === 401) {
      const e = failures.get(key);
      if (e && e.resetAt > Date.now()) e.count += 1;
      else failures.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
    } else if (res.statusCode < 400) {
      failures.delete(key);
    }
  });

  next();
}

// Keep the map from growing without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
}, WINDOW_MS).unref();
