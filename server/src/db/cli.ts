/**
 * Database CLI:  npm run migrate | rollback | seed
 */
import { db, normalizeMigrationNames } from './index.js';
import { env } from '../config/env.js';

const command = process.argv[2];

async function main() {
  const target = env.db.client === 'pg' ? `postgres://${env.db.pg.host}:${env.db.pg.port}/${env.db.pg.database}` : env.db.sqliteFile;
  console.log(`ArthSetu database (${env.db.client}) → ${target}`);

  // Keeps a database usable by both the TypeScript sources and the compiled
  // build. No-op after the first run.
  const renamed = await normalizeMigrationNames();
  if (renamed > 0) console.log(`Normalised ${renamed} migration record(s) to extensionless names.`);

  switch (command) {
    case 'migrate': {
      const [batchNo, log] = await db.migrate.latest();
      if (!log.length) console.log('Already up to date — no migrations to run.');
      else console.log(`Batch ${batchNo} applied:\n${log.map((l: string) => '  • ' + l).join('\n')}`);
      break;
    }
    case 'rollback': {
      const [batchNo, log] = await db.migrate.rollback();
      if (!log.length) console.log('Nothing to roll back.');
      else console.log(`Batch ${batchNo} rolled back:\n${log.map((l: string) => '  • ' + l).join('\n')}`);
      break;
    }
    case 'seed': {
      await db.seed.run();
      console.log('Seed complete.');
      break;
    }
    case 'reset-admin': {
      // Recovery: (re)sets the administrator from BOOTSTRAP_ADMIN_EMAIL / _PASSWORD.
      const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').toLowerCase().trim();
      const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
      if (!email || password.length < 8) {
        throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and a BOOTSTRAP_ADMIN_PASSWORD of at least 8 characters.');
      }
      const { default: bcrypt } = await import('bcryptjs');
      const { newId, nowIso } = await import('../lib/ids.js');
      const hash = await bcrypt.hash(password, 12);
      const now = nowIso();
      const existing = await db('users').where({ email }).first();
      if (existing) {
        await db('users').where({ id: existing.id }).update({ password_hash: hash, role: 'admin', is_active: true, must_change_password: false, updated_at: now });
      } else {
        await db('users').insert({ id: newId(), email, name: 'System Administrator', password_hash: hash, role: 'admin', is_active: true, must_change_password: false, created_at: now, updated_at: now });
      }
      console.log(`Administrator ${email} is ready. Remove RESET_ADMIN from the environment now.`);
      break;
    }
    case 'status': {
      const current = await db.migrate.currentVersion();
      console.log(`Current migration version: ${current}`);
      break;
    }
    default:
      console.error('Usage: tsx src/db/cli.ts <migrate|rollback|seed|status>');
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Database command failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
