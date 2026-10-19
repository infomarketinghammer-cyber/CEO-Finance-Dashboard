import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { AppProvider, useApp } from '@/state/AppContext';
import { AppShell } from '@/layout/AppShell';
import { Button, Card, EmptyState, LoadingPane } from '@/components/ui';
import { LogoFull } from '@/components/Logo';

import { LoginPage } from '@/pages/Login';
import { DashboardPage } from '@/pages/Dashboard';
import { ImportPage } from '@/pages/Import';
import { CompaniesPage } from '@/pages/Companies';
import { AccountMappingPage } from '@/pages/AccountMapping';
import { ProfitAndLossPage, BalanceSheetPage, EquityPage } from '@/pages/Statements';
import { RatiosPage } from '@/pages/Ratios';
import { OutstandingPage, MyCustomersPage } from '@/pages/Outstanding';
import { ForecastPage } from '@/pages/Forecast';
import { ExpensesPage, BudgetsPage } from '@/pages/Spending';
import { CashAndBankPage, ReportsPage, AlertsPage, ReconciliationPage, CrmPage } from '@/pages/Operations';
import { UsersPage, AuditPage, SettingsPage, ProfilePage } from '@/pages/Admin';

/** A route the signed-in user's role is not permitted to reach. */
function Guarded({ capability, children }: { capability: string; children: JSX.Element }) {
  const { can, user } = useApp();
  const location = useLocation();

  if (!can(capability)) {
    return (
      <Card>
        <EmptyState
          icon={<ShieldAlert className="w-5 h-5" />}
          title="This module is not available to your role"
          description={`Your role (${user?.roleLabel}) does not include access to ${location.pathname}. The server enforces this independently, so the page would not load its data either.`}
          action={
            <Button variant="primary" onClick={() => window.history.back()}>
              Go back
            </Button>
          }
        />
      </Card>
    );
  }

  return children;
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useApp();

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-page">
        <div className="flex flex-col items-center gap-4">
          <LogoFull width={120} />
          <LoadingPane label="Loading your workspace…" />
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return children;
}

/** Sales users have no dashboard; send them to the module they do have. */
function RootRedirect() {
  const { can } = useApp();
  if (can('dashboard.view')) return <DashboardPage />;
  if (can('receivables.view.assigned')) return <Navigate to="/my-customers" replace />;
  return <Navigate to="/companies" replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<RootRedirect />} />

        <Route path="companies" element={<Guarded capability="companies.view"><CompaniesPage /></Guarded>} />
        <Route path="import" element={<Guarded capability="imports.view"><ImportPage /></Guarded>} />
        <Route path="account-mapping" element={<Guarded capability="mapping.view"><AccountMappingPage /></Guarded>} />
        <Route path="reconciliation" element={<Guarded capability="reconciliation.view"><ReconciliationPage /></Guarded>} />

        <Route path="cash-and-bank" element={<Guarded capability="cash.view"><CashAndBankPage /></Guarded>} />
        <Route path="receivables" element={<Guarded capability="receivables.view"><OutstandingPage table="receivables" /></Guarded>} />
        <Route path="payables" element={<Guarded capability="payables.view"><OutstandingPage table="payables" /></Guarded>} />
        <Route path="cash-flow-forecast" element={<Guarded capability="forecast.view"><ForecastPage /></Guarded>} />

        <Route path="expenses" element={<Guarded capability="expenses.view"><ExpensesPage /></Guarded>} />
        <Route path="budgets" element={<Guarded capability="budgets.view"><BudgetsPage /></Guarded>} />

        <Route path="profit-and-loss" element={<Guarded capability="statements.view"><ProfitAndLossPage /></Guarded>} />
        <Route path="balance-sheet" element={<Guarded capability="statements.view"><BalanceSheetPage /></Guarded>} />
        <Route path="equity" element={<Guarded capability="statements.view"><EquityPage /></Guarded>} />
        <Route path="ratios" element={<Guarded capability="ratios.view"><RatiosPage /></Guarded>} />

        <Route path="reports" element={<Guarded capability="reports.view"><ReportsPage /></Guarded>} />
        <Route path="alerts" element={<Guarded capability="alerts.view"><AlertsPage /></Guarded>} />

        <Route path="crm" element={<Guarded capability="crm.view"><CrmPage /></Guarded>} />
        <Route path="my-customers" element={<Guarded capability="receivables.view.assigned"><MyCustomersPage /></Guarded>} />
        <Route path="users" element={<Guarded capability="users.manage"><UsersPage /></Guarded>} />
        <Route path="audit" element={<Guarded capability="audit.view"><AuditPage /></Guarded>} />
        <Route path="settings" element={<Guarded capability="settings.view"><SettingsPage /></Guarded>} />
        <Route path="profile" element={<ProfilePage />} />

        <Route
          path="*"
          element={
            <Card>
              <EmptyState
                title="Page not found"
                description="That address does not match a module in ArthSetu."
                action={
                  <Button variant="primary" onClick={() => (window.location.href = '/')}>
                    Back to the dashboard
                  </Button>
                }
              />
            </Card>
          }
        />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Router>
        <AppRoutes />
      </Router>
    </AppProvider>
  );
}
