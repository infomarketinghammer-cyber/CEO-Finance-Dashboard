import fs from 'node:fs';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { db, closeDb, normalizeMigrationNames } from './db/index.js';
import { logger } from './lib/logger.js';

async function main() {
  // The upload directory holds financial source documents. 0700 keeps it readable
  // only by the account running the server.
  fs.mkdirSync(env.uploadDir, { recursive: true, mode: 0o700 });

  // Refuse to start on an un-migrated database rather than failing later on the
  // first query a user happens to make.
  try {
    // Lets a database migrated by the TypeScript sources be served by the
    // compiled build, and vice versa. No-op once normalised.
    const renamed = await normalizeMigrationNames();
    if (renamed > 0) {
      logger.info(`Normalised ${renamed} migration record(s) to extensionless names.`);
    }

    const [completed, pending] = await db.migrate.list();
    if (pending.length > 0) {
      logger.error(
        `The database has ${pending.length} pending migration(s). Run "npm run migrate" in the server directory before starting.`,
        { pending: pending.map((p: { file?: string } | string) => (typeof p === 'string' ? p : p.file)) },
      );
      process.exit(1);
    }
    logger.info(`Database ready (${env.db.client}, ${completed.length} migration(s) applied)`);
  } catch (err) {
    logger.error('Could not reach the database.', { reason: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  const app = createApp();

  const server = app.listen(env.port, () => {
    logger.info(`ArthSetu API listening on http://localhost:${env.port}`, {
      env: env.nodeEnv,
      database: env.db.client,
      dataSource: 'excel_import',
    });
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down.`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    // Force exit if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
