import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, dialect } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { authenticate, signToken } from '../../middleware/auth.js';
import { loginLimiter } from '../../middleware/loginLimiter.js';
import { badRequest, unauthorized, forbidden } from '../../lib/errors.js';
import { capabilitiesFor, ROLE_LABELS, type Role } from './permissions.js';
import { recordAudit } from '../audit/service.js';
import { nowIso } from '../../lib/ids.js';
import { env } from '../../config/env.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const normalised = email.toLowerCase().trim();

    const user = await db('users').where({ email: normalised }).first();

    // Same message and comparable timing whether the account exists or not, so the
    // endpoint cannot be used to enumerate valid email addresses.
    const hash = user?.password_hash ?? '$2a$12$0000000000000000000000000000000000000000000000000000';
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) {
      await recordAudit({
        action: 'auth.login_failed',
        summary: `Failed sign-in attempt for ${normalised}`,
        req,
        userOverride: { email: normalised },
      });
      throw unauthorized('Email or password is incorrect.');
    }

    if (!dialect.bool(user.is_active)) {
      throw forbidden('This account has been deactivated. Contact your administrator.');
    }

    await db('users').where({ id: user.id }).update({ last_login_at: nowIso() });

    const token = signToken({ id: user.id, email: user.email, role: user.role });

    res.cookie('dhyeya_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.isProd,
      maxAge: 12 * 60 * 60 * 1000,
    });

    await recordAudit({ action: 'auth.login', summary: `${user.email} signed in`, req, userOverride: { id: user.id, email: user.email } });

    res.json({
      token,
      user: serialiseUser(user),
    });
  }),
);

authRouter.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    res.clearCookie('dhyeya_token');
    await recordAudit({ action: 'auth.logout', summary: `${req.user!.email} signed out`, req });
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await db('users').where({ id: req.user!.id }).first();
    if (!user) throw unauthorized();

    // Companies this user may select. Admins see all active companies.
    const companies =
      req.user!.role === 'admin'
        ? await db('companies').where({ is_active: true }).orderBy('name')
        : await db('companies')
            .join('user_companies', 'companies.id', 'user_companies.company_id')
            .where('user_companies.user_id', req.user!.id)
            .andWhere('companies.is_active', true)
            .orderBy('companies.name')
            .select('companies.*');

    res.json({
      user: serialiseUser(user),
      companies: companies.map((c: Record<string, unknown>) => ({
        id: c.id,
        name: c.name,
        entityType: c.entity_type,
        currency: c.currency,
        currencyScale: c.currency_scale,
        isDemo: dialect.bool(c.is_demo),
      })),
    });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z
    .string()
    .min(10, 'Use at least 10 characters')
    .regex(/[a-z]/, 'Include a lowercase letter')
    .regex(/[A-Z]/, 'Include an uppercase letter')
    .regex(/[0-9]/, 'Include a number'),
});

authRouter.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await db('users').where({ id: req.user!.id }).first();
    if (!user) throw unauthorized();

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) throw badRequest('Your current password is incorrect.');
    if (currentPassword === newPassword) throw badRequest('The new password must differ from the current one.');

    await db('users')
      .where({ id: user.id })
      .update({
        password_hash: await bcrypt.hash(newPassword, 12),
        must_change_password: false,
        updated_at: nowIso(),
      });

    await recordAudit({ action: 'auth.password_changed', summary: `${user.email} changed their password`, req });
    res.json({ ok: true });
  }),
);

function serialiseUser(row: Record<string, any>) {
  const role = row.role as Role;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    roleLabel: ROLE_LABELS[role] ?? role,
    capabilities: capabilitiesFor(role),
    mustChangePassword: dialect.bool(row.must_change_password),
    lastLoginAt: row.last_login_at ?? null,
  };
}
