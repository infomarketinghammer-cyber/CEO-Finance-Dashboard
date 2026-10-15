import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config/env.js';
import { db } from './db/index.js';
import { errorHandler, notFoundHandler, asyncHandler } from './middleware/error.js';
import { logger } from './lib/logger.js';

import { authRouter } from './modules/auth/routes.js';
import { companiesRouter } from './modules/companies/routes.js';
import { importsRouter } from './modules/imports/routes.js';
import { mappingRouter } from './modules/mapping/routes.js';
import { financeRouter } from './modules/finance/routes.js';
import { expensesRouter } from './modules/expenses/routes.js';
import { alertsRouter } from './modules/alerts/routes.js';
import { reconciliationRouter } from './modules/reconciliation/routes.js';
import { crmRouter } from './modules/crm/routes.js';
import { adminRouter } from './modules/admin/routes.js';
import { reportsRouter } from './modules/reports/routes.js';
import { aiRouter } from './modules/ai/routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: env.isProd ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: env.corsOrigin.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  // Lightweight request log. Never records bodies — they carry financial detail.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path === '/api/health') return;
      logger.debug(`${req.method} ${req.path}`, { status: res.statusCode, ms: Date.now() - started });
    });
    next();
  });

  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      let database = 'unknown';
      try {
        await db.raw('select 1');
        database = 'ok';
      } catch (err) {
        database = `error: ${err instanceof Error ? err.message : String(err)}`;
      }

      res.json({
        status: database === 'ok' ? 'ok' : 'degraded',
        database: { client: env.db.client, status: database },
        dataSource: 'excel_import',
        version: '1.0.0',
        time: new Date().toISOString(),
      });
    }),
  );

  app.use('/api/auth', authRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api/imports', importsRouter);
  app.use('/api/mapping', mappingRouter);
  app.use('/api/finance', financeRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/reconciliation', reconciliationRouter);
  app.use('/api/crm', crmRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/ai', aiRouter);

  // In production the built client is served from the same origin. Uploaded
  // workbooks live outside this tree and are never exposed over a static route.
  const clientDist = path.resolve(env.serverRoot, '../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}
