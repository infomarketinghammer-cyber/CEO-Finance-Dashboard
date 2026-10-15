/**
 * Capability model.
 *
 * Routes assert capabilities, never role names, so adding a role is a change to one
 * table rather than a search across the codebase. Every capability is checked on
 * the server; the client uses the same list only to decide what to render, and
 * hiding a menu item is never the control that protects data.
 */

export type Role = 'admin' | 'finance' | 'executive' | 'sales';

export const ROLES: Role[] = ['admin', 'finance', 'executive', 'sales'];

export const CAPABILITIES = [
  'dashboard.view',
  'companies.view',
  'companies.manage',
  'imports.view',
  'imports.create',
  'mapping.view',
  'mapping.manage',
  'statements.view',
  'cash.view',
  'receivables.view',
  'receivables.view.assigned', // restricted slice for sales
  'payables.view',
  'forecast.view',
  'forecast.manage',
  'expenses.view',
  'expenses.manage',
  'budgets.view',
  'budgets.manage',
  'ratios.view',
  'ratios.manage',
  'reports.view',
  'reports.export',
  'alerts.view',
  'alerts.manage',
  'reconciliation.view',
  'reconciliation.manage',
  'crm.view',
  'crm.manage',
  'users.manage',
  'audit.view',
  'settings.view',
  'settings.manage',
  'ai.use',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const EXECUTIVE: Capability[] = [
  'dashboard.view',
  'companies.view',
  'imports.view',
  'mapping.view',
  'statements.view',
  'cash.view',
  'receivables.view',
  'payables.view',
  'forecast.view',
  'expenses.view',
  'budgets.view',
  'ratios.view',
  'reports.view',
  'reports.export',
  'alerts.view',
  'reconciliation.view',
  'crm.view',
  'settings.view',
  'ai.use',
];

const FINANCE: Capability[] = [
  ...EXECUTIVE,
  'companies.manage',
  'imports.create',
  'mapping.manage',
  'forecast.manage',
  'expenses.manage',
  'budgets.manage',
  'ratios.manage',
  'alerts.manage',
  'reconciliation.manage',
  'crm.manage',
  'settings.manage',
  'audit.view',
];

/**
 * Sales deliberately receives neither 'dashboard.view' nor 'statements.view'.
 * Their receivables access is the '.assigned' variant, which the query layer
 * narrows to parties linked to them in the customer records.
 */
const SALES: Capability[] = ['companies.view', 'receivables.view.assigned', 'crm.view'];

const ADMIN: Capability[] = [...CAPABILITIES];

export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  admin: ADMIN,
  finance: FINANCE,
  executive: EXECUTIVE,
  sales: SALES,
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  finance: 'Finance',
  executive: 'Executive',
  sales: 'Sales',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Full access, including user management, company configuration and system settings.',
  finance: 'Imports data, manages account mappings, budgets and recurring expenses, and generates every report.',
  executive: 'Reads the dashboard, financial statements, forecasts and alerts for permitted companies, and exports reports.',
  sales: 'Sees only the outstanding and payment status of customers assigned to them. No company-wide financial access.',
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

export function capabilitiesFor(role: Role): Capability[] {
  return ROLE_CAPABILITIES[role] ?? [];
}
