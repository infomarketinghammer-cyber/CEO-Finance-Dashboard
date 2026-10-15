# Test results

Recorded run — **15 October 2026**. Node 22.22.0, SQLite, single container.
These are measured figures from the commands shown, not targets.

---

## 1. Unit tests — `npm test`

```
✓ tests/unit/validator.test.ts      (15 tests)
✓ tests/unit/customRatios.test.ts   (22 tests)
✓ tests/unit/money.test.ts          (18 tests)
✓ tests/unit/mappingSuggest.test.ts (17 tests)
✓ tests/unit/dates.test.ts          (18 tests)

Test Files  5 passed (5)
     Tests  90 passed (90)
  Duration  2.26s
```

No server or database is required; the financial core is pure.

| File | Covers |
| --- | --- |
| `money.test.ts` | Minor-unit arithmetic, decimal drift, amount parsing (Indian/Western separators, `₹`, `Rs.`, `INR`, parenthesised negatives, `Dr`/`Cr`), absent vs zero vs unreadable, division guards |
| `dates.test.ts` | Day-first vs month-first parsing, ambiguity detection, Excel serials, month-name formats, invalid dates, date arithmetic across leap days and month ends |
| `validator.test.ts` | Voucher grouping, forward-fill of blank continuation cells, debit/credit imbalance detection, unreadable amounts, missing required fields, date ranges, duplicate keys in-file and against the database |
| `customRatios.test.ts` | Formula grammar, rejection of JavaScript injection, operator precedence, scale independence, null propagation, division by zero, definition validation, input catalogue integrity |
| `mappingSuggest.test.ts` | Ledger classification by group and by name, refusal to guess, confidence bounds, respecting per-company category availability |

### Two source defects found and fixed by these tests

1. **`parseAmount` rejected `Rs. 1,000`.** Only the `₹` symbol was stripped, but
   Tally exports routinely prefix `Rs.`. Leading and trailing currency words are
   now handled (`Rs`, `Rs.`, `INR`, `USD`, `EUR`, `GBP`, `AED`, `SGD`).
2. **Duplicate React keys on the Balance Sheet.** The equity side emitted two
   sections both identified as `equity` — the equity ledgers and the derived
   "Profit for the period". The derived line is now `equity_result`.

---

## 2. End-to-end tests — `npm run test:e2e`

Drives the real HTTP API against a running server, through the full Definition
of Done. **117/117 checks passed.**

| # | Area | Checks |
| --- | --- | --- |
| 1 | Authentication | 3 |
| 2 | Company and financial year | 3 |
| 3 | Empty state before any import | 3 |
| 4 | Chart of accounts import | 5 |
| 5 | Account mapping | 5 |
| 6 | Opening balances | 1 |
| 7 | Vouchers | 7 |
| 8 | Receivables and payables | 4 |
| 9 | Expenses and budgets | 5 |
| 10 | Profit & Loss | 4 |
| 11 | Balance Sheet | 3 |
| 12 | Equity statement | 2 |
| 13 | Ratios | 4 |
| 14 | Executive dashboard | 5 |
| 15 | Drill-down | 5 |
| 16 | Cash flow forecast | 6 |
| 17 | Reconciliation | 3 |
| 18 | Exports (PDF + Excel) | 9 |
| 19 | Integration honesty | 7 |
| 20 | Role-based access | 7 |
| 21 | Custom ratio builder | 13 |
| 22 | Forecast backtesting | 11 |

Checks worth naming, because they encode the product's promises:

- *The unreadable amount is rejected rather than treated as zero.*
- *The deliberately unbalanced voucher is flagged.*
- *Re-importing vouchers does not duplicate financial transactions.*
- *An out-of-balance sheet is not forced to balance, and gets diagnostics.*
- *Interest coverage is N/A when there is no finance cost, not Infinity.*
- *Revenue KPI is "unavailable", not zero* (before any import).
- *An invoice with no due date is held out of the overdue buckets.*
- *A formula is parsed, never evaluated as JavaScript.*
- *A run whose target date has not arrived is not scored.*
- *An AI question returns "not configured" rather than a fabricated answer.*
- *The first company's revenue does not leak into the second.*

---

## 3. Performance at volume

The PRD targets Balance Sheet and Profit & Loss generation **under 10 seconds
for a standard company**. Measured against a generated company of:

- **400 ledgers** across 14 Tally-style groups
- **9,000 vouchers / 24,000 voucher lines** over a full financial year
- 5.7 MB source workbook

### Import pipeline

| Stage | `vouchers.xlsx` (5.7 MB, 24,000 rows) |
| --- | --- |
| Upload | 1.35s |
| Inspect (parse + profile + suggest mapping) | 1.30s |
| Validate | 1.29s |
| Commit (single transaction) | 4.39s |
| **Total** | **8.34s** |

All 24,000 rows valid; 9,000 vouchers inserted; 0 rejected.
Chart of accounts (400 rows): 0.46s total. Opening balances: 0.08s total.

### Statement generation

| Route | Median | Max (7 runs) |
| --- | --- | --- |
| Profit & Loss | **100ms** | 128ms |
| Balance Sheet | **106ms** | 110ms |
| Equity statement | 67ms | 75ms |
| Financial ratios | 152ms | 164ms |
| P&L with prior-year comparison | 98ms | 103ms |
| Cash flow forecast (90 days) | 64ms | 79ms |
| Executive dashboard (12 KPIs + 8 charts) | 1,207ms | 1,382ms |

**Balance Sheet and Profit & Loss generate in roughly a tenth of a second at
24,000 voucher lines — about 100× inside the 10-second target.** The executive
dashboard is the slowest route because it assembles every KPI, trend and chart
in one request; it remains well inside interactive range.

### Export generation

| Export | Size | Time |
| --- | --- | --- |
| Profit & Loss PDF | 171 KB | 0.13s |
| Profit & Loss Excel | 9 KB | 0.15s |
| Balance Sheet PDF | 171 KB | 0.09s |
| Balance Sheet Excel | 11 KB | 0.08s |
| Executive summary PDF | 170 KB | 0.13s |

### Correctness at volume

With 24,000 double-entry lines imported and all ledgers mapped:

```
Total assets          ₹2,58,90,000
Total liabilities    ₹19,23,90,000
Total equity        ₹-16,65,00,000
Equation difference            ₹0     ← Assets = Liabilities + Equity
```

The accounting equation holds exactly. (The negative equity is a property of the
synthetic generator, which books more purchases and payments than sales; the
point of the check is that the equation closes to zero, not the sign.)

---

## 4. Browser verification

Chromium 1194, 1440×1000 desktop and 390×844 mobile, signed in as an
administrator against live imported data.

- Every one of the 20 modules renders with real data, loading and empty states.
- **Zero React console errors or warnings** after the two key fixes.
- The five-step import wizard, the custom ratio builder (with live preview and
  formula validation) and the forecast accuracy tab were each exercised in the
  browser, not only through the API.
- Mobile layout: sidebar collapses to a drawer, KPI cards stack, charts and
  tables scroll horizontally rather than overflowing.

---

## 5. Not verifiable in this environment

Stated rather than silently skipped:

| Acceptance criterion | Why it cannot be verified here |
| --- | --- |
| *Closing-balance match rate with Tally: 100%* | No Tally connector and no sanitized real-company export. The reconciliation module computes per-ledger differences against a supplied reference report, and is tested with a deliberate ₹50,000 difference it detects exactly. |
| *Cash forecast accuracy within ±10% at 30 days* | Needs months of real history. The backtesting foundation is implemented and tested: runs are recorded and scored against actual imported cash once their target date passes. The figure reported today comes from synthetic fixtures. |
| *Ledgers auto-mapped correctly: 90%+* | Measurable only against a real chart of accounts. The suggester is unit-tested on representative Tally group and ledger names. |
| *Time to first dashboard under 30 minutes* | A human-factors measure requiring a pilot user. |
| CRM combined customer view | No CRM API configured; the module reports *not connected* and imports customer data from Excel instead. |
| Scheduled email / PDF delivery | No scheduler deployed; the UI states this rather than showing a delivery status. |

---

## Reproducing

```bash
cd server

npm test                 # unit tests — no server needed

npm run dev              # terminal 1
npm run test:e2e         # terminal 2 — needs the API on :4000
```

The e2e suite creates its own throwaway company and leaves existing data alone.
