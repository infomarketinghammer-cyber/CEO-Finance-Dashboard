# Excel import templates

DHYEYA imports `.xlsx`, `.xls` and `.csv` workbooks. You do **not** have to match these column names exactly — the import wizard maps your own headers onto these fields, remembers the mapping per company and file shape, and lets you review every suggestion before anything is committed. The names below are what the wizard recognises automatically, and what the downloadable templates use.

Download a ready-made template for any category from **Excel Import Center → Templates**, or from the API:

```
GET /api/imports/templates/:categoryKey
```

## How to read these tables

- **Required** fields must be present and readable, or the row is rejected with a reason.
- **Recognised headers** are matched case-insensitively, ignoring spaces and punctuation.
- A column DHYEYA does not recognise is reported as unmapped; it is never imported silently.
- Amounts may use `1,23,456.78`, `123,456.78`, `₹1,000`, `Rs. 1,000`, `(1,234.50)` for negatives, or a `Dr`/`Cr` suffix.
- Dates may be ISO (`2025-04-03`), day-first, month-first, written (`3 Apr 2025`) or Excel serials. 
  Where day/month order is ambiguous, the wizard asks rather than assuming.

---

## Categories

- [Chart of Accounts / Ledger Masters](#chart-of-accounts-ledger-masters) — `chart_of_accounts`
- [Ledger Groups](#ledger-groups) — `ledger_groups`
- [Opening Balances](#opening-balances) — `opening_balances`
- [Vouchers / Transaction Entries](#vouchers-transaction-entries) — `vouchers`
- [Receivables / Outstanding Invoices](#receivables-outstanding-invoices) — `receivables`
- [Payables / Outstanding Bills](#payables-outstanding-bills) — `payables`
- [Cost Centres and Branches](#cost-centres-and-branches) — `cost_centres`
- [Stock and Inventory](#stock-and-inventory) — `stock_items`
- [Expense Records](#expense-records) — `expenses`
- [Budgets](#budgets) — `budgets`
- [Recurring Expense Definitions](#recurring-expense-definitions) — `recurring_expenses`
- [Known Future Commitments](#known-future-commitments) — `commitments`
- [Customer / CRM Data](#customer-crm-data) — `customers`
- [Company Details](#company-details) — `company_details`

---

## Chart of Accounts / Ledger Masters

**Category key:** `chart_of_accounts`

The list of ledger accounts, the group each belongs to, and optionally its opening balance.

**Enables:** Account mapping · Balance Sheet · Profit & Loss · Trial balance reconciliation

**Duplicate detection:** Ledger name (case- and spacing-insensitive)

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Ledger Name** | Yes | string | `ledgername`, `ledger`, `accountname`, `account`, `particulars`, `name`, `ledgeraccount` | The account name exactly as it appears in your books. |
| **Ledger Group** | No | string | `groupname`, `group`, `under`, `parent`, `ledgergroup`, `accountgroup`, `primarygroup` | The Tally group (for example "Sundry Debtors"). Strongly improves automatic category suggestions. |
| **Opening Balance** | No | amount | `openingbalance`, `opening`, `openingbal`, `obalance` |  |
| **Opening Balance Side** | No | enum | `openingside`, `side`, `drcr`, `debitcredit`, `balancetype` | Leave blank if the opening balance column already carries a sign or a Dr/Cr marker. |
| **GSTIN** | No | string | `gstin`, `gstno`, `gstnumber`, `gstidentificationnumber` |  |
| **Source Reference** | No | string | `externalid`, `guid`, `masterid`, `ledgerid`, `alterid`, `code` |  |

**Example row**

| Ledger Name | Ledger Group | Opening Balance | Opening Balance Side |
| --- | --- | --- | --- |
| EXAMPLE — Sales — Domestic | Sales Accounts | 0 | credit |
| EXAMPLE — HDFC Bank Current A/c | Bank Accounts | 1450000 | debit |
| EXAMPLE — Acme Traders | Sundry Debtors | 220000 | debit |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Ledger Groups

**Category key:** `ledger_groups`

The group hierarchy your ledgers sit under. Improves the accuracy of automatic account mapping.

**Enables:** Better mapping suggestions

**Duplicate detection:** Group name

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Group Name** | Yes | string | `groupname`, `group`, `name`, `particulars` |  |
| **Parent Group** | No | string | `parentname`, `parent`, `under`, `parentgroup` |  |
| **Nature** | No | string | `nature`, `primarygroup`, `type`, `category` | Assets, Liabilities, Income or Expenses, as classified in your books. |
| **Source Reference** | No | string | `externalid`, `guid`, `masterid`, `code` |  |

**Example row**

| Group Name | Parent Group | Nature |
| --- | --- | --- |
| EXAMPLE — Sundry Debtors | Current Assets | Assets |
| EXAMPLE — Indirect Expenses | Primary | Expenses |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Opening Balances

**Category key:** `opening_balances`

Ledger balances carried forward at the start of the financial year.

**Enables:** Balance Sheet opening position · Equity statement · Return on equity and assets

**Duplicate detection:** Ledger within the selected financial year

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Ledger Name** | Yes | string | `ledgername`, `ledger`, `account`, `particulars`, `name` |  |
| **Opening Amount** | No | amount | `amount`, `openingbalance`, `opening`, `balance`, `value` |  |
| **Debit** | No | amount | `debit`, `debitamount`, `dr`, `dramount` |  |
| **Credit** | No | amount | `credit`, `creditamount`, `cr`, `cramount` |  |
| **Side** | No | enum | `side`, `drcr`, `debitcredit`, `balancetype`, `type` |  |

> At least one of these must be mapped: an amount (`amount`, `debit`, `credit`).

**Example row**

| Ledger Name | Debit | Credit |
| --- | --- | --- |
| EXAMPLE — HDFC Bank Current A/c | 1450000 |  |
| EXAMPLE — Capital Account |  | 2500000 |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Vouchers / Transaction Entries

**Category key:** `vouchers`

Day book or ledger transactions, one row per debit or credit line. Rows sharing a date, type and voucher number are grouped into a single voucher.

**Enables:** Profit & Loss · Balance Sheet movements · Expense analysis · Drill-down to transactions

**Duplicate detection:** Source reference, or date + voucher type + voucher number + line composition

**Partial import of valid rows:** supported

**Blank continuation cells:** supported. Where the date, voucher type and voucher number are printed once per voucher and left blank on the following lines (as Tally day books do), the blanks are carried down.

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Transaction Date** | Yes | date | `voucherdate`, `date`, `transactiondate`, `entrydate`, `dateofentry`, `vchdate` |  |
| **Voucher Number** | No | string | `vouchernumber`, `voucherno`, `vchno`, `voucher`, `documentno`, `billno`, `referenceno`, `number` | Lines sharing a voucher number are treated as one double-entry voucher. |
| **Voucher Type** | No | string | `vouchertype`, `type`, `vchtype`, `transactiontype` | Sales, Purchase, Payment, Receipt, Journal, Contra and so on. |
| **Ledger Name** | Yes | string | `ledgername`, `ledger`, `account`, `particulars`, `accountname` |  |
| **Debit** | No | amount | `debit`, `debitamount`, `dr`, `dramount`, `debitvalue` |  |
| **Credit** | No | amount | `credit`, `creditamount`, `cr`, `cramount`, `creditvalue` |  |
| **Amount (signed)** | No | amount | `amount`, `value`, `netamount`, `transactionamount` | Use when your export has a single signed amount column instead of separate debit and credit columns. |
| **Narration** | No | string | `narration`, `description`, `remarks`, `particularsdetail`, `note`, `notes` |  |
| **Reference** | No | string | `reference`, `ref`, `refno`, `billreference`, `chequeno` |  |
| **Cost Centre** | No | string | `costcentre`, `costcenter`, `branch`, `department`, `division`, `location` |  |
| **Source Reference** | No | string | `externalid`, `guid`, `vchguid`, `voucherguid`, `alterid` |  |

> At least one of these must be mapped: a debit, credit or signed amount column (`debit`, `credit`, `amount`).

**Example row**

| Transaction Date | Voucher Type | Voucher Number | Ledger Name | Debit | Credit | Narration |
| --- | --- | --- | --- | --- | --- | --- |
| 2025-04-05 | Sales | INV-0001 | EXAMPLE — Acme Traders | 118000 |  | Invoice 0001 |
|  |  |  | EXAMPLE — Sales — Domestic |  | 100000 |  |
|  |  |  | EXAMPLE — Output GST |  | 18000 |  |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Receivables / Outstanding Invoices

**Category key:** `receivables`

Unpaid customer invoices with their due dates.

**Enables:** Receivables ageing · DSO · Cash flow forecast inflows · Overdue alerts

**Duplicate detection:** Source reference, or party + invoice number + invoice date

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Customer** | Yes | string | `partyname`, `customer`, `customername`, `party`, `ledgername`, `ledger`, `debtor`, `account` |  |
| **Invoice Number** | No | string | `documentnumber`, `invoiceno`, `invoicenumber`, `billno`, `billnumber`, `refno`, `reference`, `documentno` |  |
| **Invoice Date** | No | date | `documentdate`, `invoicedate`, `billdate`, `date`, `vchdate` |  |
| **Due Date** | No | date | `duedate`, `due`, `dateofdue`, `maturitydate`, `duedateon` | Left blank where your export does not supply it — never inferred. |
| **Invoice Amount** | No | amount | `amount`, `invoiceamount`, `billamount`, `grossamount`, `totalamount`, `value`, `openingamount` |  |
| **Amount Received** | No | amount | `paid`, `amountpaid`, `received`, `amountreceived`, `settled`, `clearedamount` |  |
| **Outstanding Amount** | No | amount | `outstanding`, `pending`, `balance`, `closingbalance`, `outstandingamount`, `pendingamount`, `balanceamount` |  |
| **Cost Centre** | No | string | `costcentre`, `costcenter`, `branch`, `territory`, `region` |  |
| **Reference** | No | string | `reference`, `ref`, `ordernumber`, `ponumber` |  |
| **Source Reference** | No | string | `externalid`, `guid`, `billid` |  |

> At least one of these must be mapped: an invoice amount or an outstanding amount (`amount`, `outstanding`).

**Example row**

| Customer | Invoice Number | Invoice Date | Due Date | Invoice Amount | Amount Received | Outstanding Amount |
| --- | --- | --- | --- | --- | --- | --- |
| EXAMPLE — Acme Traders | INV-0001 | 2025-04-05 | 2025-05-05 | 118000 | 0 | 118000 |
| EXAMPLE — Vertex Industries | INV-0014 | 2025-05-18 |  | 65000 | 25000 | 40000 |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Payables / Outstanding Bills

**Category key:** `payables`

Unpaid supplier bills with their due dates.

**Enables:** Payables ageing · DPO · Cash flow forecast outflows · Overdue alerts

**Duplicate detection:** Source reference, or supplier + bill number + bill date

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Supplier** | Yes | string | `partyname`, `supplier`, `suppliername`, `vendor`, `vendorname`, `party`, `ledgername`, `ledger` |  |
| **Bill Number** | No | string | `documentnumber`, `billno`, `billnumber`, `invoiceno`, `invoicenumber`, `refno`, `reference`, `documentno` |  |
| **Bill Date** | No | date | `documentdate`, `billdate`, `invoicedate`, `date` |  |
| **Due Date** | No | date | `duedate`, `due`, `maturitydate`, `paymentdue` |  |
| **Bill Amount** | No | amount | `amount`, `billamount`, `invoiceamount`, `grossamount`, `totalamount`, `value`, `openingamount` |  |
| **Amount Paid** | No | amount | `paid`, `amountpaid`, `settled`, `clearedamount` |  |
| **Outstanding Amount** | No | amount | `outstanding`, `pending`, `balance`, `closingbalance`, `outstandingamount`, `pendingamount` |  |
| **Cost Centre** | No | string | `costcentre`, `costcenter`, `branch`, `department` |  |
| **Reference** | No | string | `reference`, `ref`, `ponumber`, `ordernumber` |  |
| **Source Reference** | No | string | `externalid`, `guid`, `billid` |  |

> At least one of these must be mapped: a bill amount or an outstanding amount (`amount`, `outstanding`).

**Example row**

| Supplier | Bill Number | Bill Date | Due Date | Bill Amount | Amount Paid | Outstanding Amount |
| --- | --- | --- | --- | --- | --- | --- |
| EXAMPLE — Nova Supplies | BILL-221 | 2025-04-12 | 2025-05-12 | 86000 | 0 | 86000 |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Cost Centres and Branches

**Category key:** `cost_centres`

The cost centres, branches or departments used to analyse transactions.

**Enables:** Cost centre filters on Profit & Loss and expense reports

**Duplicate detection:** Cost centre name

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Cost Centre** | Yes | string | `name`, `costcentre`, `costcenter`, `branch`, `department`, `division` |  |
| **Parent** | No | string | `parentname`, `parent`, `under`, `parentcostcentre` |  |
| **Source Reference** | No | string | `externalid`, `guid`, `code` |  |

**Example row**

| Cost Centre | Parent |
| --- | --- |
| EXAMPLE — Pune Branch | West Zone |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Stock and Inventory

**Category key:** `stock_items`

Closing stock quantities and values.

**Enables:** Inventory on the Balance Sheet · Quick ratio · Inventory days

**Duplicate detection:** Stock item name

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Item Name** | Yes | string | `name`, `itemname`, `stockitem`, `product`, `particulars`, `description` |  |
| **Unit** | No | string | `unit`, `uom`, `units`, `measure` |  |
| **Quantity** | No | number | `quantity`, `qty`, `closingqty`, `closingquantity`, `stock` |  |
| **Rate** | No | amount | `rate`, `price`, `unitrate`, `closingrate` |  |
| **Value** | No | amount | `value`, `amount`, `closingvalue`, `stockvalue`, `totalvalue` |  |
| **As at** | No | date | `asofdate`, `asat`, `date`, `valuationdate` |  |
| **Source Reference** | No | string | `externalid`, `guid`, `itemcode`, `sku`, `code` |  |

> At least one of these must be mapped: a value or a quantity (`value`, `quantity`).

**Example row**

| Item Name | Unit | Quantity | Rate | Value | As at |
| --- | --- | --- | --- | --- | --- |
| EXAMPLE — Widget A | Nos | 320 | 450 | 144000 | 2026-03-31 |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Expense Records

**Category key:** `expenses`

Individual expense entries for analysis against budget.

**Enables:** Expense analysis · Budget variance · Expense anomaly warnings

**Duplicate detection:** Date + category + vendor + amount + reference

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Date** | Yes | date | `expensedate`, `date`, `transactiondate`, `paymentdate`, `billdate` |  |
| **Category** | Yes | string | `category`, `expensecategory`, `head`, `expensehead`, `type`, `group` |  |
| **Vendor** | No | string | `vendor`, `supplier`, `payee`, `partyname`, `paidto`, `party` |  |
| **Ledger** | No | string | `ledgername`, `ledger`, `account`, `accountname` |  |
| **Amount** | Yes | amount | `amount`, `value`, `expenseamount`, `totalamount`, `debit`, `paid` |  |
| **Expense Type** | No | enum | `expensetype`, `type`, `nature`, `classification` | Fixed, recurring-variable (such as electricity) or one-off. |
| **Cost Centre** | No | string | `costcentre`, `costcenter`, `branch`, `department` |  |
| **Reference** | No | string | `reference`, `ref`, `voucherno`, `billno`, `invoiceno` |  |
| **Notes** | No | string | `notes`, `narration`, `remarks`, `description` |  |

**Example row**

| Date | Category | Vendor | Amount | Expense Type | Reference |
| --- | --- | --- | --- | --- | --- |
| 2025-04-30 | EXAMPLE — Rent | EXAMPLE — Landlord | 85000 | fixed | PAY-0012 |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Budgets

**Category key:** `budgets`

Budgeted amounts by category and period.

**Enables:** Budget utilisation KPI · Budget variance report · Overrun alerts

**Duplicate detection:** Category + period + cost centre

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Category** | Yes | string | `category`, `expensecategory`, `head`, `budgethead`, `group` |  |
| **Period Start** | Yes | date | `periodstart`, `startdate`, `from`, `fromdate`, `start` |  |
| **Period End** | Yes | date | `periodend`, `enddate`, `to`, `todate`, `end` |  |
| **Budget Amount** | Yes | amount | `amount`, `budget`, `budgetamount`, `budgeted`, `value`, `allocation` |  |
| **Period Type** | No | enum | `periodtype`, `frequency`, `periodicity` |  |
| **Cost Centre** | No | string | `costcentre`, `costcenter`, `branch`, `department` |  |
| **Notes** | No | string | `notes`, `remarks`, `description` |  |

**Example row**

| Category | Period Start | Period End | Budget Amount | Period Type |
| --- | --- | --- | --- | --- |
| EXAMPLE — Rent | 2025-04-01 | 2026-03-31 | 1020000 | year |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Recurring Expense Definitions

**Category key:** `recurring_expenses`

Expenses that repeat on a schedule, such as rent, salaries, subscriptions and loan instalments.

**Enables:** Upcoming payments calendar · Cash flow forecast outflows · Missed payment warnings

**Duplicate detection:** Name + frequency + start date

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Expense Name** | Yes | string | `name`, `expensename`, `description`, `particulars`, `title` |  |
| **Category** | No | string | `category`, `expensecategory`, `head`, `group` |  |
| **Amount** | Yes | amount | `amount`, `value`, `instalment`, `installment`, `emi`, `monthlyamount` |  |
| **Frequency** | Yes | enum | `frequency`, `periodicity`, `recurrence`, `cycle`, `interval` |  |
| **Start Date** | Yes | date | `startdate`, `start`, `from`, `effectivefrom`, `commencement` |  |
| **Next Due Date** | No | date | `nextduedate`, `nextdue`, `duedate`, `nextpayment` |  |
| **End Date** | No | date | `enddate`, `end`, `to`, `validtill`, `expiry` |  |
| **Vendor** | No | string | `vendor`, `supplier`, `payee`, `party` |  |
| **Ledger** | No | string | `ledgername`, `ledger`, `account` |  |
| **Cost Centre** | No | string | `costcentre`, `costcenter`, `branch`, `department` |  |
| **Amount Varies** | No | boolean | `isvariable`, `variable`, `amountvaries`, `recurringvariable` |  |
| **Active** | No | boolean | `isactive`, `active`, `status`, `enabled` |  |

**Example row**

| Expense Name | Category | Amount | Frequency | Start Date | Next Due Date | Amount Varies |
| --- | --- | --- | --- | --- | --- | --- |
| EXAMPLE — Office Rent | Rent | 85000 | monthly | 2025-04-01 | 2026-11-01 | No |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Known Future Commitments

**Category key:** `commitments`

One-off inflows or outflows you already know about, such as an advance tax payment or a confirmed receipt.

**Enables:** Cash flow forecast accuracy

**Duplicate detection:** Name + expected date + amount

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Description** | Yes | string | `name`, `description`, `particulars`, `title`, `commitment` |  |
| **Direction** | Yes | enum | `direction`, `type`, `flow`, `inout`, `nature` |  |
| **Amount** | Yes | amount | `amount`, `value`, `expectedamount` |  |
| **Expected Date** | Yes | date | `expecteddate`, `date`, `duedate`, `expectedon` |  |
| **Confidence** | No | enum | `confidence`, `certainty`, `likelihood`, `probability` |  |
| **Notes** | No | string | `notes`, `remarks`, `description2` |  |

**Example row**

| Description | Direction | Amount | Expected Date | Confidence |
| --- | --- | --- | --- | --- |
| EXAMPLE — Advance tax instalment | outflow | 350000 | 2026-12-15 | high |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Customer / CRM Data

**Category key:** `customers`

Customer records that can be linked to accounting ledgers by GSTIN or name.

**Enables:** Customer view alongside outstanding balances · Sales-role access scoping

**Duplicate detection:** GSTIN where present, otherwise customer name

**Partial import of valid rows:** supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Customer Name** | Yes | string | `customername`, `customer`, `accountname`, `name`, `party`, `partyname`, `company` |  |
| **GSTIN** | No | string | `gstin`, `gstno`, `gstnumber`, `taxid` |  |
| **Accounting Ledger** | No | string | `ledgername`, `ledger`, `account`, `tallyledger` | Where supplied, links the customer directly to its ledger. Otherwise matching is attempted on GSTIN, then name. |
| **Contact Email** | No | string | `contactemail`, `email`, `emailid`, `mail` |  |
| **Contact Phone** | No | string | `contactphone`, `phone`, `mobile`, `contactnumber`, `telephone` |  |
| **Account Owner** | No | string | `owner`, `accountowner`, `salesperson`, `assignedto`, `relationshipmanager`, `owneremail` | A sales user's email here restricts that user to this customer's records. |
| **CRM Account ID** | No | string | `crmaccountid`, `accountid`, `crmid`, `externalid`, `recordid` |  |

**Example row**

| Customer Name | GSTIN | Contact Email | Account Owner |
| --- | --- | --- | --- |
| EXAMPLE — Acme Traders | 27AAAPA1234A1Z5 | accounts@example.com | sales@yourcompany.com |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Company Details

**Category key:** `company_details`

Updates the selected company profile from a workbook row.

**Enables:** Company profile fields on reports and exports

**Duplicate detection:** Updates the selected company — only the first data row is read

**Partial import of valid rows:** not supported

| Field | Required | Type | Recognised headers | Notes |
| --- | --- | --- | --- | --- |
| **Company Name** | Yes | string | `name`, `companyname`, `company`, `organisation`, `organization` |  |
| **Legal Name** | No | string | `legalname`, `registeredname`, `fullname` |  |
| **Entity Type** | No | string | `entitytype`, `type`, `constitution`, `organisationtype` |  |
| **GSTIN** | No | string | `gstin`, `gstno`, `gstnumber` |  |
| **PAN** | No | string | `pan`, `panno`, `pannumber`, `incometaxno` |  |
| **Address** | No | string | `address`, `registeredaddress`, `location` |  |
| **Currency** | No | string | `currency`, `reportingcurrency`, `basecurrency` |  |

**Example row**

| Company Name | Entity Type | GSTIN | PAN | Currency |
| --- | --- | --- | --- | --- |
| EXAMPLE — Dhyeya Industries Pvt Ltd | private_limited | 27AAAPA1234A1Z5 | AAAPA1234A | INR |

Sample values in the downloadable templates are prefixed `EXAMPLE —` and must be deleted before import.

---

## Minimum to get started

A useful dashboard needs, in this order:

1. **Chart of Accounts** — so ledgers exist and can be classified.
2. **Opening Balances** — so the Balance Sheet starts from the right position.
3. **Vouchers** — so the Profit & Loss and all movement have something to report.

Receivables, payables, expenses and budgets each unlock their own modules and can be added at any time.

<sub>Generated from `server/src/modules/imports/categories.ts`. Do not edit by hand.</sub>
