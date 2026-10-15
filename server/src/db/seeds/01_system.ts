import type { Knex } from 'knex';
import bcrypt from 'bcryptjs';
import { SYSTEM_CATEGORIES } from '../../modules/mapping/categories.js';
import { newId, nowIso } from '../../lib/ids.js';

/**
 * Seeds only what the application cannot run without:
 *  - the system account categories every company starts from;
 *  - one administrator account so the first sign-in is possible.
 *
 * It creates NO company and NO financial data. A fresh install opens on the
 * onboarding screen, exactly as §27 requires.
 */
export async function seed(knex: Knex): Promise<void> {
  const now = nowIso();

  // ---- system account categories (idempotent) ----
  const existing = await knex('account_categories').whereNull('company_id').select('key');
  const existingKeys = new Set(existing.map((r: { key: string }) => r.key));

  const toInsert = SYSTEM_CATEGORIES.filter((c) => !existingKeys.has(c.key)).map((c) => ({
    id: newId(),
    company_id: null,
    key: c.key,
    label: c.label,
    statement: c.statement,
    section: c.section,
    normal_side: c.normalSide,
    sort_order: c.sortOrder,
    is_system: true,
    is_active: true,
    description: c.description,
    created_at: now,
    updated_at: now,
  }));

  if (toInsert.length) {
    await knex('account_categories').insert(toInsert);
    // eslint-disable-next-line no-console
    console.log(`  seeded ${toInsert.length} system account categories`);
  }

  // ---- bootstrap administrator ----
  const adminEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@dhyeya.local').toLowerCase();
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'ChangeMe#2026';

  const existingAdmin = await knex('users').where({ email: adminEmail }).first();
  if (!existingAdmin) {
    await knex('users').insert({
      id: newId(),
      email: adminEmail,
      name: process.env.BOOTSTRAP_ADMIN_NAME ?? 'System Administrator',
      password_hash: await bcrypt.hash(adminPassword, 12),
      role: 'admin',
      is_active: true,
      // Forces a password change on first sign-in when the default was used.
      must_change_password: !process.env.BOOTSTRAP_ADMIN_PASSWORD,
      created_at: now,
      updated_at: now,
    });
    // eslint-disable-next-line no-console
    console.log(`  created administrator ${adminEmail}`);
    if (!process.env.BOOTSTRAP_ADMIN_PASSWORD) {
      // eslint-disable-next-line no-console
      console.log(`  temporary password: ${adminPassword}  (change on first sign-in)`);
    }
  }
}
