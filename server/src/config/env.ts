import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(serverRoot, '.env') });

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

const dbClient = (process.env.DB_CLIENT ?? 'sqlite3') as 'sqlite3' | 'pg';
if (dbClient !== 'sqlite3' && dbClient !== 'pg') {
  throw new Error(`DB_CLIENT must be "sqlite3" or "pg", received "${dbClient}"`);
}

const isProd = process.env.NODE_ENV === 'production';

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd,
  port: Number(process.env.PORT ?? 4000),
  serverRoot,

  /** Signing secret for session tokens. A weak default is refused in production. */
  jwtSecret: (() => {
    const s = process.env.JWT_SECRET ?? 'dhyeya-development-secret-change-me';
    if (isProd && s === 'dhyeya-development-secret-change-me') {
      throw new Error('JWT_SECRET must be set to a strong unique value in production.');
    }
    return s;
  })(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',

  db: {
    client: dbClient,
    sqliteFile: process.env.SQLITE_FILE ?? path.join(serverRoot, 'data', 'dhyeya.sqlite'),
    pg: {
      host: process.env.PGHOST ?? 'localhost',
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? 'dhyeya',
      password: process.env.PGPASSWORD ?? '',
      database: process.env.PGDATABASE ?? 'dhyeya',
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    },
  },

  /** Uploaded workbooks are written here. Never served over a public static route. */
  uploadDir: process.env.UPLOAD_DIR ?? path.join(serverRoot, 'storage', 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),

  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',

  /**
   * Optional external integrations. Absent configuration is reported honestly to
   * the UI as "not configured" — never as a connected or successful state.
   */
  integrations: {
    aiProvider: process.env.AI_PROVIDER ?? null,
    aiApiKey: process.env.AI_API_KEY ?? null,
    crmProvider: process.env.CRM_PROVIDER ?? null,
    crmApiKey: process.env.CRM_API_KEY ?? null,
    crmBaseUrl: process.env.CRM_BASE_URL ?? null,
    smtpUrl: process.env.SMTP_URL ?? null,
    tally: null as null, // Reserved. No Tally connector exists in this version.
  },
};

export { required };
