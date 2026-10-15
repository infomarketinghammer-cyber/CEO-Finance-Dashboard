/**
 * Database CLI:  npm run migrate | rollback | seed
 */
import { db } from './index.js';
import { env } from '../config/env.js';

const command = process.argv[2];

async function main() {
  const target = env.db.client === 'pg' ? `postgres://${env.db.pg.host}:${env.db.pg.port}/${env.db.pg.database}` : env.db.sqliteFile;
  console.log(`DHYEYA database (${env.db.client}) → ${target}`);

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
