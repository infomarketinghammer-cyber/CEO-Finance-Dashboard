<div align="center">
  <img src="client/public/dhyeya-logo.jpeg" alt="DHYEYA" width="220">
  <h1>DHYEYA — Business and Executive Dashboard</h1>
  <p><em>An executive financial intelligence platform that turns accounting exports into traceable financial information.</em></p>
</div>

---

## What this is

DHYEYA imports Excel workbooks exported from Tally (or prepared from the supplied
templates), validates them, maps each ledger to a standard financial category,
and produces an executive dashboard, full financial statements, ratios, ageing
analysis and a cash-flow forecast — with drill-down from any figure to the
vouchers behind it.

**The current data source is Excel import. There is no Tally connection in this
version**, and the product never claims one. The data-source layer is built so a
`TallyDataProvider` can be added later without touching the financial
calculations or the dashboard.

### Principles the code holds to

These are enforced in the implementation, not just aspirations:

| Principle | How it shows up |
| --- | --- |
| Never invent a number | A figure with no source reads **"Data unavailable"**, never `0`. |
| Never force a balance | An out-of-balance Balance Sheet shows the difference and a diagnostic panel of likely causes. |
| Never fake an integration | CRM, AI, email scheduling and Tally all report an honest *not configured* state. |
| Never silently discard a row | Every rejected row is counted, reasoned and downloadable. |
| Never duplicate a transaction | Imports are idempotent on stable composite keys, not row numbers. |
| Money is never a float | All amounts are integer minor units (paise) end to end. |
| Permissions are server-side | Hiding a menu item is not access control; every route asserts a capability. |

---

## Quick start

### Requirements

- **Node.js 20+** (developed on 22)
- No database server needed for local use — SQLite is the default. PostgreSQL is supported.

### Install and run

```bash
# 1. Backend
cd server
npm install
cp .env.example .env          # optional; sensible defaults apply without it
npm run migrate               # creates the schema
npm run seed                  # system categories + one administrator
npm run dev                   # http://localhost:4000

# 2. Frontend, in a second terminal
cd client
npm install
npm run dev                   # http://localhost:5173
```

Open **http://localhost:5173**.

The seed prints a temporary administrator password on first run:

```
admin@dhyeya.local / ChangeMe#2026
```

The account is flagged to force a password change at first sign-in. Set
`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` before seeding to choose
your own.

> The seed creates **no company and no financial data**. A fresh install opens on
> the onboarding screen, which is the correct empty state.

### Production build

```bash
cd client && npm run build     # emits client/dist
cd ../server && npm run build  # emits server/dist
NODE_ENV=production node dist/index.js
```

In production the server also serves `client/dist`, so the whole product runs on
one port. A Dockerfile and Compose files are included — see
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

---

## Importing your first workbook

1. **Sign in** and create a company (*Companies & Years → Add company*): name,
   entity type, reporting currency.
2. **Add a financial year** — April–March is offered by default for Indian
   entities; any range is allowed.
3. Go to **Excel Import Center** and import in this order:

   | Order | Category | Why first |
   | --- | --- | --- |
   | 1 | Chart of Accounts | Creates the ledgers everything else refers to |
   | 2 | Opening Balances | Gives the Balance Sheet its starting position |
   | 3 | Vouchers | Supplies all movement, the P&L and drill-down |
   | 4+ | Receivables, Payables, Expenses, Budgets… | Unlock their own modules |

4. For each file the wizard walks: **data type → upload → map columns →
   review → import**. It shows worksheet names, record counts, detected headers,
   sample rows, detected date and number formats, and anything suspicious,
   *before* anything is written.
5. Open **Account Mapping** and confirm the suggested categories. Suggestions are
   marked *Unconfirmed* until a person approves them, and unmapped balances are
   reported prominently because they distort the statements.
6. The dashboard, statements, ratios and forecast now read from that data.

Don't have a workbook handy? Generate the test fixtures:

```bash
cd server && npm run test:fixtures   # writes tests/fixtures/workbooks/*.xlsx
```

Or download a blank template per category from **Excel Import Center →
Templates**. Column reference: **[docs/EXCEL_TEMPLATES.md](docs/EXCEL_TEMPLATES.md)**.

---

## Architecture

```
dhyeya/
├── server/                      Node + Express + TypeScript (ESM)
│   ├── src/
│   │   ├── db/                  Knex: migrations, seeds, dual SQLite/Postgres config
│   │   ├── lib/                 money (integer minor units), dates, ids, json, errors
│   │   ├── middleware/          authenticate, requireCapability, resolveCompany
│   │   └── modules/
│   │       ├── imports/         workbook reader, column mapper, validator, committer
│   │       ├── mapping/         categories, auto-suggestion, approval
│   │       ├── finance/         engine, statements, ratios, ageing, forecast, backtest
│   │       ├── expenses/        expenses, recurring items, budgets, anomalies
│   │       ├── reconciliation/  imported vs reference trial balance
│   │       ├── reports/         PDF and Excel exporters
│   │       ├── alerts/          threshold evaluation
│   │       ├── crm/ ai/         honest not-configured integration surfaces
│   │       └── admin/ audit/    users, roles, settings, audit trail
│   ├── scripts/                 docs generator
│   └── tests/                   unit/ (vitest) + e2e.ts (live API) + fixtures/
└── client/                      React 18 + TypeScript + Vite + Tailwind
    └── src/
        ├── components/          design system, charts, financial primitives
        ├── layout/              shell, sidebar, topbar, navigation
        ├── pages/               the twenty modules
        └── state/               company, financial year, period, capabilities
```

### The calculation path

Every figure on every screen comes through one path, so a KPI card and a PDF
export can never disagree:

```
import → normalised ledgers, vouchers, voucher_lines
       → engine.loadBalances()      opening + movement, per ledger, per period
       → account_mappings           ledger → standard category
       → statements / ratios / ageing / forecast
       → API → dashboard, statements, exports
```

`loadBalances()` is the single source of balances. Statements, ratios, the
dashboard, exports and the custom ratio builder all consume it; none of them
re-derives a figure of its own.

### Data source abstraction

`ExcelImportProvider` is implemented today. A `TallyDataProvider` would feed the
same normalised model behind the same interface. **No fake Tally adapter exists**,
and no core module depends on one.

---

## Database

Knex migrations target both engines; the schema is deliberately ANSI-ish, with
the three real differences (booleans, case-insensitive LIKE, date comparison)
bridged in `src/db/index.ts`.

```bash
npm run migrate      # apply
npm run rollback     # revert the last batch
npm run seed         # idempotent: system categories + bootstrap admin
```

**29 tables**, covering users and roles, companies, financial years, import
batches and rejections, ledgers and groups, account categories and mappings,
vouchers and voucher lines, opening balances, cost centres, stock, expenses,
recurring expenses, commitments, budgets, forecast scenarios, financial
snapshots, reconciliations, alerts, settings, CRM links and audit events — with
foreign keys, indexes and company-scoped uniqueness throughout.

### Using PostgreSQL

```bash
DB_CLIENT=pg PGHOST=localhost PGDATABASE=dhyeya PGUSER=dhyeya PGPASSWORD=... npm run migrate
```

---

## Environment

Every variable is optional for local development. See `server/.env.example`.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4000` | API port |
| `NODE_ENV` | `development` | `production` also serves `client/dist` |
| `JWT_SECRET` | dev placeholder | **Refused in production if left at the default** |
| `JWT_EXPIRES_IN` | `12h` | Session lifetime |
| `DB_CLIENT` | `sqlite3` | or `pg` |
| `SQLITE_FILE` | `server/data/dhyeya.sqlite` | SQLite path |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` `PGSSL` | — | PostgreSQL connection |
| `UPLOAD_DIR` | `server/storage/uploads` | Never served over a public static route |
| `MAX_UPLOAD_BYTES` | `26214400` (25 MB) | Upload ceiling |
| `CORS_ORIGIN` | `http://localhost:5173` | Dev client origin |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` / `_NAME` | `admin@dhyeya.local` / `ChangeMe#2026` | First administrator |
| `AI_PROVIDER` / `AI_API_KEY` | unset | Unset ⇒ AI reports *not configured* |
| `CRM_PROVIDER` / `CRM_API_KEY` / `CRM_BASE_URL` | unset | Unset ⇒ CRM reports *not connected* |
| `SMTP_URL` | unset | Unset ⇒ scheduled delivery reports *not deployed* |

Uploaded workbooks are stored outside the web root and are only retrievable
through an authenticated, company-scoped route.

---

## Roles

Capabilities are asserted by the server on every route. The sidebar filters on
the same list, but hiding a link is never the control.

| Role | Can |
| --- | --- |
| **Administrator** | Everything, plus users, roles, company configuration and settings |
| **Finance** | Imports, mappings, budgets, recurring expenses, reconciliation, all reports |
| **Executive** | Dashboard, statements, ratios, forecasts, alerts; exports where permitted |
| **Sales** | Only the outstanding and payment status of their assigned customers — no company-wide financial access |

Sensitive actions (imports, mapping changes, exports, permission changes, report
access) are written to an append-only audit trail. Passwords and tokens are
never logged.

---

## Testing

```bash
cd server

npm test                 # 90 unit tests (vitest), no server or database needed
npm run test:fixtures    # regenerate the sample workbooks
npm run test:e2e         # 117 checks against a RUNNING server on :4000
```

`npm test` covers the pure financial core: decimal-safe money, date detection and
parsing, import validation and duplicate keys, the custom ratio formula engine,
and automatic account mapping.

`npm run test:e2e` drives the real HTTP API through the full Definition of Done —
sign in, create a company and financial year, upload each workbook, map columns,
validate, commit, confirm mappings, read every statement, drill down, run
scenarios, reconcile, export every report, and verify role isolation. It needs
the API running (`npm run dev`) and creates its own throwaway company.

See **[docs/TEST_RESULTS.md](docs/TEST_RESULTS.md)** for the latest recorded run.

---

## What is not implemented, and why

Stated plainly rather than stubbed to look finished:

| Area | Status |
| --- | --- |
| **Tally connector** | Not built. Requires the connector deliverable named in the PRD. The provider interface is ready; no fake adapter exists. |
| **CRM integration** | Interface and ledger-linking are built; no CRM API is configured, so it reports *not connected*. Customer data imports from Excel meanwhile. |
| **AI insights** | Module and permission plumbing exist; with no `AI_PROVIDER` it reports *not configured* and answers no questions. All accounting maths is deterministic and independent of it. |
| **Scheduled email / PDF delivery** | No background scheduler is deployed, and the UI says so. Alerts are generated and shown in-app. |
| **Multi-company consolidation** | Out of scope per PRD §9 unless separately approved. Company data is strictly isolated. |
| **Forecast backtesting** | Foundation implemented: runs are recorded and scored against actual cash once their target date passes. A meaningful accuracy record needs several months of real history. |
| **MFA / SSO** | Standard authentication only. |

---

## Reports and exports

PDF and Excel export is available for the Executive Summary, Profit & Loss,
Balance Sheet, Equity Statement, Cash and Bank, Receivables and Payables Ageing,
Expense Analysis, Budget Variance, Cash Flow Forecast, Financial Ratios, Import
History, Reconciliation, and Data Quality.

Every export carries the company, period, filters, generation timestamp, data
source and any data-quality warnings, and is labelled a **management report, not
an audited financial statement**.

---

<sub>Management reports produced from imported accounting data. Not audited financial statements.</sub>
