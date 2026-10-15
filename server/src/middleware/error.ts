import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.path}` },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const details = err.errors.map((e) => ({ path: e.path.join('.'), message: e.message }));
    return res.status(400).json({
      error: { code: 'VALIDATION_FAILED', message: 'Some fields need attention.', details },
    });
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error(err.message, { code: err.code, path: req.path });
    }
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  const message = err instanceof Error ? err.message : 'Unexpected error';

  // Multer's own file-size rejection surfaces as a plain Error.
  if (message.includes('File too large')) {
    return res.status(413).json({
      error: {
        code: 'FILE_TOO_LARGE',
        message: `That file exceeds the ${(env.maxUploadBytes / (1024 * 1024)).toFixed(0)} MB upload limit.`,
      },
    });
  }

  logger.error('Unhandled error', { message, path: req.path, stack: err instanceof Error ? err.stack : undefined });

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: env.isProd ? 'Something went wrong. The error has been logged.' : message,
    },
  });
}

/** Wraps an async handler so rejected promises reach the error handler. */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
