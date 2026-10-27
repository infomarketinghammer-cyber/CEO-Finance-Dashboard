import {
  Activity,
  BadgeIndianRupee,
  Banknote,
  Building2,
  CalendarClock,
  ClipboardList,
  Coins,
  Contact,
  Download,
  FileSpreadsheet,
  FileText,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Percent,
  Receipt,
  Scale,
  Settings,
  ShieldCheck,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** The capability required to see and reach this module. */
  capability: string;
  description: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The twenty modules, grouped so the sidebar reads as a workflow rather than an
 * alphabetical list. Each item declares the capability that gates it; the sidebar
 * filters on that, and the server enforces the same capability independently.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        path: '/',
        label: 'Executive Overview',
        icon: LayoutDashboard,
        capability: 'dashboard.view',
        description: 'Headline financial position and trends',
      },
    ],
  },
  {
    label: 'Data',
    items: [
      {
        path: '/companies',
        label: 'Companies & Years',
        icon: Building2,
        capability: 'companies.view',
        description: 'Company profiles and financial years',
      },
      {
        path: '/import',
        label: 'Excel Import Center',
        icon: FileSpreadsheet,
        capability: 'imports.view',
        description: 'Upload, map and validate workbooks',
      },
      {
        path: '/account-mapping',
        label: 'Account Mapping',
        icon: ListChecks,
        capability: 'mapping.view',
        description: 'Classify ledgers into financial categories',
      },
      {
        path: '/reconciliation',
        label: 'Data Reconciliation',
        icon: ShieldCheck,
        capability: 'reconciliation.view',
        description: 'Compare imported balances with a reference report',
      },
    ],
  },
  {
    label: 'Position',
    items: [
      { path: '/cash-and-bank', label: 'Cash and Bank', icon: Wallet, capability: 'cash.view', description: 'Balances and movement per account' },
      {
        path: '/receivables',
        label: 'Receivables',
        icon: BadgeIndianRupee,
        capability: 'receivables.view',
        description: 'Customer invoices and ageing',
      },
      { path: '/payables', label: 'Payables', icon: Receipt, capability: 'payables.view', description: 'Supplier bills and ageing' },
      {
        path: '/cash-flow-forecast',
        label: 'Cash Flow Forecast',
        icon: TrendingUp,
        capability: 'forecast.view',
        description: 'Learned 30/60/90-day projection',
      },
    ],
  },
  {
    label: 'Spending',
    items: [
      { path: '/expenses', label: 'Expense Management', icon: Coins, capability: 'expenses.view', description: 'Expenses, recurring items and anomalies' },
      { path: '/budgets', label: 'Budget Management', icon: CalendarClock, capability: 'budgets.view', description: 'Budgets and variance against actuals' },
    ],
  },
  {
    label: 'Statements',
    items: [
      { path: '/profit-and-loss', label: 'Profit & Loss', icon: FileText, capability: 'statements.view', description: 'Revenue through to net profit' },
      { path: '/balance-sheet', label: 'Balance Sheet', icon: Scale, capability: 'statements.view', description: 'Assets, liabilities and equity' },
      { path: '/equity', label: 'Equity Statement', icon: Landmark, capability: 'statements.view', description: 'Movement in equity across the period' },
      { path: '/ratios', label: 'Financial Ratios', icon: Percent, capability: 'ratios.view', description: 'Liquidity, profitability, efficiency, leverage' },
    ],
  },
  {
    label: 'Output',
    items: [
      { path: '/reports', label: 'Reports & Exports', icon: Download, capability: 'reports.view', description: 'PDF and Excel exports of every report' },
      { path: '/alerts', label: 'Alerts', icon: Activity, capability: 'alerts.view', description: 'Exceptions needing attention' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { path: '/crm', label: 'CRM Integration', icon: Contact, capability: 'crm.view', description: 'Customer records and ledger links' },
      { path: '/users', label: 'Users & Roles', icon: Users, capability: 'users.manage', description: 'Accounts, roles and company access' },
      { path: '/audit', label: 'Audit Logs', icon: ClipboardList, capability: 'audit.view', description: 'Record of sensitive actions' },
      { path: '/settings', label: 'Settings', icon: Settings, capability: 'settings.view', description: 'Thresholds, buckets and integrations' },
    ],
  },
];

/** Sales users get a module of their own; they never see the finance navigation. */
export const SALES_NAV: NavGroup[] = [
  {
    label: 'My customers',
    items: [
      {
        path: '/my-customers',
        label: 'My Customers',
        icon: Contact,
        capability: 'receivables.view.assigned',
        description: 'Outstanding and payment status for your accounts',
      },
    ],
  },
];

export function visibleGroups(capabilities: string[]): NavGroup[] {
  const source = capabilities.includes('receivables.view.assigned') && !capabilities.includes('dashboard.view') ? SALES_NAV : NAV_GROUPS;

  return source
    .map((g) => ({ ...g, items: g.items.filter((i) => capabilities.includes(i.capability)) }))
    .filter((g) => g.items.length > 0);
}

export function findNavItem(path: string): NavItem | undefined {
  for (const g of [...NAV_GROUPS, ...SALES_NAV]) {
    const found = g.items.find((i) => i.path === path);
    if (found) return found;
  }
  return undefined;
}

export const ICONS = { Banknote };
