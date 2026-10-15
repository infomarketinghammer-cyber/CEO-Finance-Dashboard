import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setAuthToken, setActiveCompanyId, getAuthToken, getActiveCompanyId, ApiError } from '@/lib/api';
import type { CurrencyConfig } from '@/lib/format';

export type Role = 'admin' | 'finance' | 'executive' | 'sales';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  roleLabel: string;
  capabilities: string[];
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

export interface Company {
  id: string;
  name: string;
  entityType: string;
  entityLabel?: string;
  currency: string;
  currencyScale: number;
  isDemo: boolean;
  gstin?: string | null;
}

export interface FinancialYear {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
}

export type PeriodType = 'financial_year' | 'quarter' | 'month' | 'custom';

export interface PeriodSelection {
  type: PeriodType;
  from?: string;
  to?: string;
}

interface AppState {
  user: User | null;
  companies: Company[];
  company: Company | null;
  financialYears: FinancialYear[];
  financialYear: FinancialYear | null;
  period: PeriodSelection;
  currency: CurrencyConfig;
  loading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectCompany: (id: string) => void;
  selectFinancialYear: (id: string) => void;
  setPeriod: (p: PeriodSelection) => void;
  refreshCompanies: () => Promise<void>;
  refreshUser: () => Promise<void>;
  can: (capability: string) => boolean;
  /** Query parameters every scoped page passes to the API. */
  scopeQuery: Record<string, string | undefined>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  const [financialYears, setFinancialYears] = useState<FinancialYear[]>([]);
  const [financialYear, setFinancialYear] = useState<FinancialYear | null>(null);
  const [period, setPeriodState] = useState<PeriodSelection>({ type: 'financial_year' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    if (!getAuthToken()) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.get<{ user: User; companies: Company[] }>('/auth/me', undefined, { noCompany: true });
      setUser(res.user);
      setCompanies(res.companies);

      const stored = getActiveCompanyId();
      const chosen = res.companies.find((c) => c.id === stored) ?? res.companies[0] ?? null;
      setCompany(chosen);
      setActiveCompanyId(chosen?.id ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuthToken(null);
        setUser(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not load your session.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Financial years follow the selected company.
  useEffect(() => {
    if (!company) {
      setFinancialYears([]);
      setFinancialYear(null);
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const res = await api.get<{ financialYears: FinancialYear[] }>(
          `/companies/${company.id}/financial-years`,
          { companyId: company.id },
        );
        if (cancelled) return;

        setFinancialYears(res.financialYears);

        // Prefer the year containing today, then the most recent.
        const today = new Date().toISOString().slice(0, 10);
        const current = res.financialYears.find((f) => f.startDate <= today && f.endDate >= today);
        setFinancialYear(current ?? res.financialYears[0] ?? null);
      } catch {
        if (!cancelled) {
          setFinancialYears([]);
          setFinancialYear(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [company]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
    setAuthToken(res.token);
    setUser(res.user);

    const me = await api.get<{ user: User; companies: Company[] }>('/auth/me', undefined, { noCompany: true });
    setCompanies(me.companies);
    const chosen = me.companies[0] ?? null;
    setCompany(chosen);
    setActiveCompanyId(chosen?.id ?? null);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* signing out locally matters more than the round trip succeeding */
    }
    setAuthToken(null);
    setActiveCompanyId(null);
    setUser(null);
    setCompanies([]);
    setCompany(null);
  }, []);

  const selectCompany = useCallback(
    (id: string) => {
      const next = companies.find((c) => c.id === id);
      if (!next) return;
      setCompany(next);
      setActiveCompanyId(next.id);
      // A period chosen for another company's year would silently mislead.
      setPeriodState({ type: 'financial_year' });
    },
    [companies],
  );

  const selectFinancialYear = useCallback(
    (id: string) => {
      const next = financialYears.find((f) => f.id === id);
      if (next) {
        setFinancialYear(next);
        setPeriodState({ type: 'financial_year' });
      }
    },
    [financialYears],
  );

  const refreshCompanies = useCallback(async () => {
    const me = await api.get<{ user: User; companies: Company[] }>('/auth/me', undefined, { noCompany: true });
    setCompanies(me.companies);
    if (!me.companies.find((c) => c.id === company?.id)) {
      const next = me.companies[0] ?? null;
      setCompany(next);
      setActiveCompanyId(next?.id ?? null);
    }
  }, [company?.id]);

  const refreshUser = useCallback(async () => {
    const me = await api.get<{ user: User; companies: Company[] }>('/auth/me', undefined, { noCompany: true });
    setUser(me.user);
  }, []);

  const can = useCallback((capability: string) => Boolean(user?.capabilities.includes(capability)), [user]);

  const value = useMemo<AppState>(
    () => ({
      user,
      companies,
      company,
      financialYears,
      financialYear,
      period,
      currency: { currency: company?.currency ?? 'INR', scale: company?.currencyScale ?? 2 },
      loading,
      error,
      login,
      logout,
      selectCompany,
      selectFinancialYear,
      setPeriod: setPeriodState,
      refreshCompanies,
      refreshUser,
      can,
      scopeQuery: {
        companyId: company?.id,
        financialYearId: financialYear?.id,
        periodType: period.type,
        from: period.from,
        to: period.to,
      },
    }),
    [
      user, companies, company, financialYears, financialYear, period, loading, error,
      login, logout, selectCompany, selectFinancialYear, refreshCompanies, refreshUser, can,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
