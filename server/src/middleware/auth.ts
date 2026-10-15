import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { db, dialect } from '../db/index.js';
import { forbidden, unauthorized, notFound } from '../lib/errors.js';
import type { Capability, Role } from '../modules/auth/permissions.js';
import { can } from '../modules/auth/permissions.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      companyId?: string;
    }
  }
}

export function signToken(user: { id: string; email: string; role: Role }): string {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
}

function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.dhyeya_token;
  return cookie ?? null;
}

/** Verifies the session token and loads the live user record. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = readToken(req);
    if (!token) throw unauthorized();

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload;
    } catch {
      throw unauthorized('Your session has expired. Please sign in again.');
    }

    // The token is not the source of truth for role or active status — a revoked
    // or re-roled user must lose access immediately, not at token expiry.
    const row = await db('users').where({ id: String(payload.sub) }).first();
    if (!row) throw unauthorized('Account no longer exists.');
    if (!dialect.bool(row.is_active)) throw forbidden('This account has been deactivated.');

    req.user = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role as Role,
      mustChangePassword: dialect.bool(row.must_change_password),
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Asserts a capability on the server for every protected route. */
export function requireCapability(capability: Capability) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!can(req.user.role, capability)) {
      return next(forbidden(`Your role (${req.user.role}) cannot perform this action.`));
    }
    next();
  };
}

/** Passes when the user holds any one of the listed capabilities. */
export function requireAnyCapability(...capabilities: Capability[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!capabilities.some((c) => can(req.user!.role, c))) {
      return next(forbidden(`Your role (${req.user.role}) cannot perform this action.`));
    }
    next();
  };
}

/**
 * Tenant boundary.
 *
 * Resolves `companyId` from the route, query or body and proves the caller is
 * entitled to it before any handler runs. Administrators reach every company;
 * everyone else must hold an explicit assignment. This is the single place that
 * decision is made, so no query can accidentally cross companies.
 */
export async function resolveCompany(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user) throw unauthorized();

    const companyId =
      (req.params.companyId as string | undefined) ??
      (req.query.companyId as string | undefined) ??
      (req.body?.companyId as string | undefined) ??
      (req.headers['x-company-id'] as string | undefined);

    if (!companyId) throw forbidden('A company must be selected for this request.');

    const company = await db('companies').where({ id: companyId }).first();
    if (!company) throw notFound('Company not found.');

    if (req.user.role !== 'admin') {
      const assignment = await db('user_companies')
        .where({ user_id: req.user.id, company_id: companyId })
        .first();
      if (!assignment) throw forbidden('You do not have access to this company.');
    }

    req.companyId = companyId;
    next();
  } catch (err) {
    next(err);
  }
}

/** The set of company ids a user may read. `null` means "every company". */
export async function accessibleCompanyIds(user: AuthUser): Promise<string[] | null> {
  if (user.role === 'admin') return null;
  const rows = await db('user_companies').where({ user_id: user.id }).select('company_id');
  return rows.map((r: { company_id: string }) => r.company_id);
}
