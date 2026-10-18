# DHYEYA demo data — Dhyeya Demo Industries Pvt Ltd

Fictional company: a Nashik-based manufacturer/trader with 4 cost centres, 7 customers and 4 suppliers.
Financial year **2026-27 (1 Apr 2026 – 31 Mar 2027)**, transactions **1 Apr – 17 Oct 2026**. All names, GSTINs and e-mails are made up.

## Setup in the app
1. **Companies & Years → Add company**: name `Dhyeya Demo Industries`, entity type Private Limited, currency INR.
2. **Add financial year**: 2026-04-01 to 2027-03-31.
3. **Excel Import Center** – import in this order (wizard: type → upload → map → review → import):

| # | File | Category | What it feeds |
|---|------|----------|---------------|
| 1 | 01_Company_Details | Company Details | Company profile on reports |
| 2 | 02_Ledger_Groups | Ledger Groups | Better auto-mapping |
| 3 | 05_Cost_Centres | Cost Centres | Branch filters |
| 4 | 03_Chart_of_Accounts | Chart of Accounts | 45 ledgers |
| 5 | 04_Opening_Balances | Opening Balances | Balance Sheet starting position (Dr = Cr = ₹1,07,30,000) |
| 6 | 06_Vouchers_Apr-Oct_2026 | Vouchers | 271 balanced vouchers (664 lines): P&L, movement, drill-down |
| 7 | 07_Receivables | Receivables | Ageing, DSO, forecast inflows |
| 8 | 08_Payables | Payables | Ageing, DPO, forecast outflows |
| 9 | 09_Stock_Items | Stock Items | Inventory (totals ₹19,50,000, same as the Closing Stock ledger) |
| 10 | 10_Expenses | Expenses | Expense analysis, anomalies |
| 11 | 11_Budgets_FY2026-27 | Budgets | Budget utilisation / variance |
| 12 | 12_Recurring_Expenses | Recurring Expenses | Upcoming payments, forecast |
| 13 | 13_Commitments | Commitments | Known one-off cash events |
| 14 | 14_Customers | Customers | Customer view, sales-role scoping |

4. Open **Account Mapping**, review the suggested categories and approve them. The statements read from approved mappings.

## Stories planted in the data (what to look for)
- **Data flow:** the same ledgers run through opening balances → vouchers → trial balance → P&L / Balance Sheet → ratios. Click any figure to drill down to its vouchers.
- **Balance Sheet balances:** every voucher and the opening position are double-entry balanced.
- **Receivables ageing:** Bluewave Distributors' ₹95,000 invoice (Jan 2026) is never collected (90+ days). Kiran Enterprises has been paying nothing since May, and several customers sit in the 1–30 and 31–60 day buckets.
- **Payables:** a handful of open supplier bills of different ages.
- **Expense anomaly:** August electricity is ₹1,18,000 against a normal ₹38–52k.
- **Budget overrun risk:** Marketing has used ~83% of its annual budget (₹4.98L of ₹6L) in 6.5 months.
- **Forecast:** recurring items (rent, payroll, EMI, insurance) plus commitments — advance tax (15 Dec), a customer advance (inflow), a machine instalment (Jan 2027) and a low-confidence GST refund.
- **Export sale:** Lumina Exports GmbH invoices carry no GST; domestic sales carry 18%.
- **Cost centres:** sales and expenses are tagged to Mumbai HQ, Pune, Delhi and the Nashik factory.

Regenerating: the files were produced by a seeded script, so the numbers are reproducible.
