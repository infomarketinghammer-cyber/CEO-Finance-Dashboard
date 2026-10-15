/**
 * Import category catalogue.
 *
 * Each category declares the application fields a workbook can supply, the aliases
 * that let a column be recognised automatically, and the rules that decide whether
 * a row is usable. Nothing here assumes a single spreadsheet layout: aliases cover
 * the common Tally export headings alongside plain-English alternatives, and any
 * column the user maps by hand overrides the guess.
 */

export type FieldType = 'string' | 'date' | 'amount' | 'number' | 'enum' | 'boolean';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Lowercase alphanumeric-only forms matched against the workbook header. */
  aliases: string[];
  enumValues?: readonly string[];
  help?: string;
}

export interface CategoryDef {
  key: string;
  label: string;
  description: string;
  /** What this data unlocks, shown in the import wizard. */
  enables: string[];
  fields: FieldDef[];
  /** At least one field from each listed group must be mapped. */
  anyOf?: { label: string; keys: string[] }[];
  /** Blank leading cells inherit the previous row — Tally's merged-cell export style. */
  supportsForwardFill?: boolean;
  supportsPartialImport: boolean;
  duplicateBasis: string;
  sampleRows: Record<string, string | number>[];
}

const S = (key: string, label: string, aliases: string[], extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  label,
  type: 'string',
  aliases,
  ...extra,
});

export const IMPORT_CATEGORIES: CategoryDef[] = [
  // ----------------------------------------------------------------- masters
  {
    key: 'chart_of_accounts',
    label: 'Chart of Accounts / Ledger Masters',
    description: 'The list of ledger accounts, the group each belongs to, and optionally its opening balance.',
    enables: ['Account mapping', 'Balance Sheet', 'Profit & Loss', 'Trial balance reconciliation'],
    supportsPartialImport: true,
    duplicateBasis: 'Ledger name (case- and spacing-insensitive)',
    fields: [
      S('ledgerName', 'Ledger Name', ['ledgername', 'ledger', 'accountname', 'account', 'particulars', 'name', 'ledgeraccount'], {
        required: true,
        help: 'The account name exactly as it appears in your books.',
      }),
      S('groupName', 'Ledger Group', ['groupname', 'group', 'under', 'parent', 'ledgergroup', 'accountgroup', 'primarygroup'], {
        help: 'The Tally group (for example "Sundry Debtors"). Strongly improves automatic category suggestions.',
      }),
      { key: 'openingBalance', label: 'Opening Balance', type: 'amount', aliases: ['openingbalance', 'opening', 'openingbal', 'obalance'] },
      {
        key: 'openingSide',
        label: 'Opening Balance Side',
        type: 'enum',
        aliases: ['openingside', 'side', 'drcr', 'debitcredit', 'balancetype'],
        enumValues: ['debit', 'credit'],
        help: 'Leave blank if the opening balance column already carries a sign or a Dr/Cr marker.',
      },
      S('gstin', 'GSTIN', ['gstin', 'gstno', 'gstnumber', 'gstidentificationnumber']),
      S('externalId', 'Source Reference', ['externalid', 'guid', 'masterid', 'ledgerid', 'alterid', 'code']),
    ],
    sampleRows: [
      { 'Ledger Name': 'EXAMPLE — Sales — Domestic', 'Ledger Group': 'Sales Accounts', 'Opening Balance': 0, 'Opening Balance Side': 'credit' },
      { 'Ledger Name': 'EXAMPLE — HDFC Bank Current A/c', 'Ledger Group': 'Bank Accounts', 'Opening Balance': 1450000, 'Opening Balance Side': 'debit' },
      { 'Ledger Name': 'EXAMPLE — Acme Traders', 'Ledger Group': 'Sundry Debtors', 'Opening Balance': 220000, 'Opening Balance Side': 'debit' },
    ],
  },
  {
    key: 'ledger_groups',
    label: 'Ledger Groups',
    description: 'The group hierarchy your ledgers sit under. Improves the accuracy of automatic account mapping.',
    enables: ['Better mapping suggestions'],
    supportsPartialImport: true,
    duplicateBasis: 'Group name',
    fields: [
      S('groupName', 'Group Name', ['groupname', 'group', 'name', 'particulars'], { required: true }),
      S('parentName', 'Parent Group', ['parentname', 'parent', 'under', 'parentgroup']),
      S('nature', 'Nature', ['nature', 'primarygroup', 'type', 'category'], {
        help: 'Assets, Liabilities, Income or Expenses, as classified in your books.',
      }),
      S('externalId', 'Source Reference', ['externalid', 'guid', 'masterid', 'code']),
    ],
    sampleRows: [
      { 'Group Name': 'EXAMPLE — Sundry Debtors', 'Parent Group': 'Current Assets', Nature: 'Assets' },
      { 'Group Name': 'EXAMPLE — Indirect Expenses', 'Parent Group': 'Primary', Nature: 'Expenses' },
    ],
  },
  {
    key: 'opening_balances',
    label: 'Opening Balances',
    description: 'Ledger balances carried forward at the start of the financial year.',
    enables: ['Balance Sheet opening position', 'Equity statement', 'Return on equity and assets'],
    supportsPartialImport: true,
    duplicateBasis: 'Ledger within the selected financial year',
    fields: [
      S('ledgerName', 'Ledger Name', ['ledgername', 'ledger', 'account', 'particulars', 'name'], { required: true }),
      { key: 'amount', label: 'Opening Amount', type: 'amount', aliases: ['amount', 'openingbalance', 'opening', 'balance', 'value'] },
      { key: 'debit', label: 'Debit', type: 'amount', aliases: ['debit', 'debitamount', 'dr', 'dramount'] },
      { key: 'credit', label: 'Credit', type: 'amount', aliases: ['credit', 'creditamount', 'cr', 'cramount'] },
      {
        key: 'side',
        label: 'Side',
        type: 'enum',
        aliases: ['side', 'drcr', 'debitcredit', 'balancetype', 'type'],
        enumValues: ['debit', 'credit'],
      },
    ],
    anyOf: [{ label: 'an amount', keys: ['amount', 'debit', 'credit'] }],
    sampleRows: [
      { 'Ledger Name': 'EXAMPLE — HDFC Bank Current A/c', Debit: 1450000, Credit: '' },
      { 'Ledger Name': 'EXAMPLE — Capital Account', Debit: '', Credit: 2500000 },
    ],
  },

  // ------------------------------------------------------------ transactions
  {
    key: 'vouchers',
    label: 'Vouchers / Transaction Entries',
    description:
      'Day book or ledger transactions, one row per debit or credit line. Rows sharing a date, type and voucher number are grouped into a single voucher.',
    enables: ['Profit & Loss', 'Balance Sheet movements', 'Expense analysis', 'Drill-down to transactions'],
    supportsForwardFill: true,
    supportsPartialImport: true,
    duplicateBasis: 'Source reference, or date + voucher type + voucher number + line composition',
    fields: [
      { key: 'voucherDate', label: 'Transaction Date', type: 'date', required: true, aliases: ['voucherdate', 'date', 'transactiondate', 'entrydate', 'dateofentry', 'vchdate'] },
      S('voucherNumber', 'Voucher Number', ['vouchernumber', 'voucherno', 'vchno', 'voucher', 'documentno', 'billno', 'referenceno', 'number'], {
        help: 'Lines sharing a voucher number are treated as one double-entry voucher.',
      }),
      S('voucherType', 'Voucher Type', ['vouchertype', 'type', 'vchtype', 'transactiontype'], {
        help: 'Sales, Purchase, Payment, Receipt, Journal, Contra and so on.',
      }),
      S('ledgerName', 'Ledger Name', ['ledgername', 'ledger', 'account', 'particulars', 'accountname'], { required: true }),
      { key: 'debit', label: 'Debit', type: 'amount', aliases: ['debit', 'debitamount', 'dr', 'dramount', 'debitvalue'] },
      { key: 'credit', label: 'Credit', type: 'amount', aliases: ['credit', 'creditamount', 'cr', 'cramount', 'creditvalue'] },
      { key: 'amount', label: 'Amount (signed)', type: 'amount', aliases: ['amount', 'value', 'netamount', 'transactionamount'], help: 'Use when your export has a single signed amount column instead of separate debit and credit columns.' },
      S('narration', 'Narration', ['narration', 'description', 'remarks', 'particularsdetail', 'note', 'notes']),
      S('reference', 'Reference', ['reference', 'ref', 'refno', 'billreference', 'chequeno']),
      S('costCentre', 'Cost Centre', ['costcentre', 'costcenter', 'branch', 'department', 'division', 'location']),
      S('externalId', 'Source Reference', ['externalid', 'guid', 'vchguid', 'voucherguid', 'alterid']),
    ],
    anyOf: [{ label: 'a debit, credit or signed amount column', keys: ['debit', 'credit', 'amount'] }],
    sampleRows: [
      { 'Transaction Date': '2025-04-05', 'Voucher Type': 'Sales', 'Voucher Number': 'INV-0001', 'Ledger Name': 'EXAMPLE — Acme Traders', Debit: 118000, Credit: '', Narration: 'Invoice 0001' },
      { 'Transaction Date': '', 'Voucher Type': '', 'Voucher Number': '', 'Ledger Name': 'EXAMPLE — Sales — Domestic', Debit: '', Credit: 100000, Narration: '' },
      { 'Transaction Date': '', 'Voucher Type': '', 'Voucher Number': '', 'Ledger Name': 'EXAMPLE — Output GST', Debit: '', Credit: 18000, Narration: '' },
    ],
  },

  // -------------------------------------------------------------- outstanding
  {
    key: 'receivables',
    label: 'Receivables / Outstanding Invoices',
    description: 'Unpaid customer invoices with their due dates.',
    enables: ['Receivables ageing', 'DSO', 'Cash flow forecast inflows', 'Overdue alerts'],
    supportsPartialImport: true,
    duplicateBasis: 'Source reference, or party + invoice number + invoice date',
    fields: [
      S('partyName', 'Customer', ['partyname', 'customer', 'customername', 'party', 'ledgername', 'ledger', 'debtor', 'account', 'name'], { required: true }),
      S('documentNumber', 'Invoice Number', ['documentnumber', 'invoiceno', 'invoicenumber', 'billno', 'billnumber', 'refno', 'reference', 'documentno', 'vchno']),
      { key: 'documentDate', label: 'Invoice Date', type: 'date', aliases: ['documentdate', 'invoicedate', 'billdate', 'date', 'vchdate'] },
      { key: 'dueDate', label: 'Due Date', type: 'date', aliases: ['duedate', 'due', 'dateofdue', 'maturitydate', 'duedateon'], help: 'Left blank where your export does not supply it — never inferred.' },
      { key: 'amount', label: 'Invoice Amount', type: 'amount', aliases: ['amount', 'invoiceamount', 'billamount', 'grossamount', 'totalamount', 'value', 'openingamount'] },
      { key: 'paidMinor', label: 'Amount Received', type: 'amount', aliases: ['paid', 'amountpaid', 'received', 'amountreceived', 'settled', 'clearedamount'] },
      { key: 'outstanding', label: 'Outstanding Amount', type: 'amount', aliases: ['outstanding', 'pending', 'balance', 'closingbalance', 'outstandingamount', 'pendingamount', 'balanceamount'] },
      S('costCentre', 'Cost Centre', ['costcentre', 'costcenter', 'branch', 'territory', 'region']),
      S('reference', 'Reference', ['reference', 'ref', 'ordernumber', 'ponumber']),
      S('externalId', 'Source Reference', ['externalid', 'guid', 'billid']),
    ],
    anyOf: [{ label: 'an invoice amount or an outstanding amount', keys: ['amount', 'outstanding'] }],
    sampleRows: [
      { Customer: 'EXAMPLE — Acme Traders', 'Invoice Number': 'INV-0001', 'Invoice Date': '2025-04-05', 'Due Date': '2025-05-05', 'Invoice Amount': 118000, 'Amount Received': 0, 'Outstanding Amount': 118000 },
      { Customer: 'EXAMPLE — Vertex Industries', 'Invoice Number': 'INV-0014', 'Invoice Date': '2025-05-18', 'Due Date': '', 'Invoice Amount': 65000, 'Amount Received': 25000, 'Outstanding Amount': 40000 },
    ],
  },
  {
    key: 'payables',
    label: 'Payables / Outstanding Bills',
    description: 'Unpaid supplier bills with their due dates.',
    enables: ['Payables ageing', 'DPO', 'Cash flow forecast outflows', 'Overdue alerts'],
    supportsPartialImport: true,
    duplicateBasis: 'Source reference, or supplier + bill number + bill date',
    fields: [
      S('partyName', 'Supplier', ['partyname', 'supplier', 'suppliername', 'vendor', 'vendorname', 'party', 'ledgername', 'ledger', 'creditor', 'account', 'name'], { required: true }),
      S('documentNumber', 'Bill Number', ['documentnumber', 'billno', 'billnumber', 'invoiceno', 'invoicenumber', 'refno', 'reference', 'documentno']),
      { key: 'documentDate', label: 'Bill Date', type: 'date', aliases: ['documentdate', 'billdate', 'invoicedate', 'date'] },
      { key: 'dueDate', label: 'Due Date', type: 'date', aliases: ['duedate', 'due', 'maturitydate', 'paymentdue'] },
      { key: 'amount', label: 'Bill Amount', type: 'amount', aliases: ['amount', 'billamount', 'invoiceamount', 'grossamount', 'totalamount', 'value', 'openingamount'] },
      { key: 'paidMinor', label: 'Amount Paid', type: 'amount', aliases: ['paid', 'amountpaid', 'settled', 'clearedamount'] },
      { key: 'outstanding', label: 'Outstanding Amount', type: 'amount', aliases: ['outstanding', 'pending', 'balance', 'closingbalance', 'outstandingamount', 'pendingamount'] },
      S('costCentre', 'Cost Centre', ['costcentre', 'costcenter', 'branch', 'department']),
      S('reference', 'Reference', ['reference', 'ref', 'ponumber', 'ordernumber']),
      S('externalId', 'Source Reference', ['externalid', 'guid', 'billid']),
    ],
    anyOf: [{ label: 'a bill amount or an outstanding amount', keys: ['amount', 'outstanding'] }],
    sampleRows: [
      { Supplier: 'EXAMPLE — Nova Supplies', 'Bill Number': 'BILL-221', 'Bill Date': '2025-04-12', 'Due Date': '2025-05-12', 'Bill Amount': 86000, 'Amount Paid': 0, 'Outstanding Amount': 86000 },
    ],
  },

  // ------------------------------------------------------------- dimensions
  {
    key: 'cost_centres',
    label: 'Cost Centres and Branches',
    description: 'The cost centres, branches or departments used to analyse transactions.',
    enables: ['Cost centre filters on Profit & Loss and expense reports'],
    supportsPartialImport: true,
    duplicateBasis: 'Cost centre name',
    fields: [
      S('name', 'Cost Centre', ['name', 'costcentre', 'costcenter', 'branch', 'department', 'division'], { required: true }),
      S('parentName', 'Parent', ['parentname', 'parent', 'under', 'parentcostcentre']),
      S('externalId', 'Source Reference', ['externalid', 'guid', 'code']),
    ],
    sampleRows: [{ 'Cost Centre': 'EXAMPLE — Pune Branch', Parent: 'West Zone' }],
  },
  {
    key: 'stock_items',
    label: 'Stock and Inventory',
    description: 'Closing stock quantities and values.',
    enables: ['Inventory on the Balance Sheet', 'Quick ratio', 'Inventory days'],
    supportsPartialImport: true,
    duplicateBasis: 'Stock item name',
    fields: [
      S('name', 'Item Name', ['name', 'itemname', 'stockitem', 'product', 'particulars', 'description'], { required: true }),
      S('unit', 'Unit', ['unit', 'uom', 'units', 'measure']),
      { key: 'quantity', label: 'Quantity', type: 'number', aliases: ['quantity', 'qty', 'closingqty', 'closingquantity', 'stock'] },
      { key: 'rate', label: 'Rate', type: 'amount', aliases: ['rate', 'price', 'unitrate', 'closingrate'] },
      { key: 'value', label: 'Value', type: 'amount', aliases: ['value', 'amount', 'closingvalue', 'stockvalue', 'totalvalue'] },
      { key: 'asOfDate', label: 'As at', type: 'date', aliases: ['asofdate', 'asat', 'date', 'valuationdate'] },
      S('externalId', 'Source Reference', ['externalid', 'guid', 'itemcode', 'sku', 'code']),
    ],
    anyOf: [{ label: 'a value or a quantity', keys: ['value', 'quantity'] }],
    sampleRows: [{ 'Item Name': 'EXAMPLE — Widget A', Unit: 'Nos', Quantity: 320, Rate: 450, Value: 144000, 'As at': '2026-03-31' }],
  },

  // ---------------------------------------------------- expenses and budgets
  {
    key: 'expenses',
    label: 'Expense Records',
    description: 'Individual expense entries for analysis against budget.',
    enables: ['Expense analysis', 'Budget variance', 'Expense anomaly warnings'],
    supportsPartialImport: true,
    duplicateBasis: 'Date + category + vendor + amount + reference',
    fields: [
      { key: 'expenseDate', label: 'Date', type: 'date', required: true, aliases: ['expensedate', 'date', 'transactiondate', 'paymentdate', 'billdate'] },
      S('category', 'Category', ['category', 'expensecategory', 'head', 'expensehead', 'type', 'group'], { required: true }),
      S('vendor', 'Vendor', ['vendor', 'supplier', 'payee', 'partyname', 'paidto', 'party']),
      S('ledgerName', 'Ledger', ['ledgername', 'ledger', 'account', 'accountname']),
      { key: 'amount', label: 'Amount', type: 'amount', required: true, aliases: ['amount', 'value', 'expenseamount', 'totalamount', 'debit', 'paid'] },
      {
        key: 'expenseType',
        label: 'Expense Type',
        type: 'enum',
        aliases: ['expensetype', 'type', 'nature', 'classification'],
        enumValues: ['fixed', 'recurring_variable', 'one_off'],
        help: 'Fixed, recurring-variable (such as electricity) or one-off.',
      },
      S('costCentre', 'Cost Centre', ['costcentre', 'costcenter', 'branch', 'department']),
      S('reference', 'Reference', ['reference', 'ref', 'voucherno', 'billno', 'invoiceno']),
      S('notes', 'Notes', ['notes', 'narration', 'remarks', 'description']),
    ],
    sampleRows: [
      { Date: '2025-04-30', Category: 'EXAMPLE — Rent', Vendor: 'EXAMPLE — Landlord', Amount: 85000, 'Expense Type': 'fixed', Reference: 'PAY-0012' },
    ],
  },
  {
    key: 'budgets',
    label: 'Budgets',
    description: 'Budgeted amounts by category and period.',
    enables: ['Budget utilisation KPI', 'Budget variance report', 'Overrun alerts'],
    supportsPartialImport: true,
    duplicateBasis: 'Category + period + cost centre',
    fields: [
      S('category', 'Category', ['category', 'expensecategory', 'head', 'budgethead', 'group'], { required: true }),
      { key: 'periodStart', label: 'Period Start', type: 'date', required: true, aliases: ['periodstart', 'startdate', 'from', 'fromdate', 'start'] },
      { key: 'periodEnd', label: 'Period End', type: 'date', required: true, aliases: ['periodend', 'enddate', 'to', 'todate', 'end'] },
      { key: 'amount', label: 'Budget Amount', type: 'amount', required: true, aliases: ['amount', 'budget', 'budgetamount', 'budgeted', 'value', 'allocation'] },
      {
        key: 'periodType',
        label: 'Period Type',
        type: 'enum',
        aliases: ['periodtype', 'frequency', 'periodicity'],
        enumValues: ['month', 'quarter', 'year', 'custom'],
      },
      S('costCentre', 'Cost Centre', ['costcentre', 'costcenter', 'branch', 'department']),
      S('notes', 'Notes', ['notes', 'remarks', 'description']),
    ],
    sampleRows: [
      { Category: 'EXAMPLE — Rent', 'Period Start': '2025-04-01', 'Period End': '2026-03-31', 'Budget Amount': 1020000, 'Period Type': 'year' },
    ],
  },
  {
    key: 'recurring_expenses',
    label: 'Recurring Expense Definitions',
    description: 'Expenses that repeat on a schedule, such as rent, salaries, subscriptions and loan instalments.',
    enables: ['Upcoming payments calendar', 'Cash flow forecast outflows', 'Missed payment warnings'],
    supportsPartialImport: true,
    duplicateBasis: 'Name + frequency + start date',
    fields: [
      S('name', 'Expense Name', ['name', 'expensename', 'description', 'particulars', 'title'], { required: true }),
      S('category', 'Category', ['category', 'expensecategory', 'head', 'group']),
      { key: 'amount', label: 'Amount', type: 'amount', required: true, aliases: ['amount', 'value', 'instalment', 'installment', 'emi', 'monthlyamount'] },
      {
        key: 'frequency',
        label: 'Frequency',
        type: 'enum',
        required: true,
        aliases: ['frequency', 'periodicity', 'recurrence', 'cycle', 'interval'],
        enumValues: ['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly'],
      },
      { key: 'startDate', label: 'Start Date', type: 'date', required: true, aliases: ['startdate', 'start', 'from', 'effectivefrom', 'commencement'] },
      { key: 'nextDueDate', label: 'Next Due Date', type: 'date', aliases: ['nextduedate', 'nextdue', 'duedate', 'nextpayment'] },
      { key: 'endDate', label: 'End Date', type: 'date', aliases: ['enddate', 'end', 'to', 'validtill', 'expiry'] },
      S('vendor', 'Vendor', ['vendor', 'supplier', 'payee', 'party']),
      S('ledgerName', 'Ledger', ['ledgername', 'ledger', 'account']),
      S('costCentre', 'Cost Centre', ['costcentre', 'costcenter', 'branch', 'department']),
      { key: 'isVariable', label: 'Amount Varies', type: 'boolean', aliases: ['isvariable', 'variable', 'amountvaries', 'recurringvariable'] },
      { key: 'isActive', label: 'Active', type: 'boolean', aliases: ['isactive', 'active', 'status', 'enabled'] },
    ],
    sampleRows: [
      { 'Expense Name': 'EXAMPLE — Office Rent', Category: 'Rent', Amount: 85000, Frequency: 'monthly', 'Start Date': '2025-04-01', 'Next Due Date': '2026-11-01', 'Amount Varies': 'No' },
    ],
  },
  {
    key: 'commitments',
    label: 'Known Future Commitments',
    description: 'One-off inflows or outflows you already know about, such as an advance tax payment or a confirmed receipt.',
    enables: ['Cash flow forecast accuracy'],
    supportsPartialImport: true,
    duplicateBasis: 'Name + expected date + amount',
    fields: [
      S('name', 'Description', ['name', 'description', 'particulars', 'title', 'commitment'], { required: true }),
      {
        key: 'direction',
        label: 'Direction',
        type: 'enum',
        required: true,
        aliases: ['direction', 'type', 'flow', 'inout', 'nature'],
        enumValues: ['inflow', 'outflow'],
      },
      { key: 'amount', label: 'Amount', type: 'amount', required: true, aliases: ['amount', 'value', 'expectedamount'] },
      { key: 'expectedDate', label: 'Expected Date', type: 'date', required: true, aliases: ['expecteddate', 'date', 'duedate', 'expectedon'] },
      {
        key: 'confidence',
        label: 'Confidence',
        type: 'enum',
        aliases: ['confidence', 'certainty', 'likelihood', 'probability'],
        enumValues: ['high', 'medium', 'low'],
      },
      S('notes', 'Notes', ['notes', 'remarks', 'description2']),
    ],
    sampleRows: [
      { Description: 'EXAMPLE — Advance tax instalment', Direction: 'outflow', Amount: 350000, 'Expected Date': '2026-12-15', Confidence: 'high' },
    ],
  },

  // -------------------------------------------------------------------- CRM
  {
    key: 'customers',
    label: 'Customer / CRM Data',
    description: 'Customer records that can be linked to accounting ledgers by GSTIN or name.',
    enables: ['Customer view alongside outstanding balances', 'Sales-role access scoping'],
    supportsPartialImport: true,
    duplicateBasis: 'GSTIN where present, otherwise customer name',
    fields: [
      S('customerName', 'Customer Name', ['customername', 'customer', 'accountname', 'name', 'party', 'partyname', 'company'], { required: true }),
      S('gstin', 'GSTIN', ['gstin', 'gstno', 'gstnumber', 'taxid']),
      S('ledgerName', 'Accounting Ledger', ['ledgername', 'ledger', 'account', 'tallyledger'], {
        help: 'Where supplied, links the customer directly to its ledger. Otherwise matching is attempted on GSTIN, then name.',
      }),
      S('contactEmail', 'Contact Email', ['contactemail', 'email', 'emailid', 'mail']),
      S('contactPhone', 'Contact Phone', ['contactphone', 'phone', 'mobile', 'contactnumber', 'telephone']),
      S('owner', 'Account Owner', ['owner', 'accountowner', 'salesperson', 'assignedto', 'relationshipmanager', 'owneremail'], {
        help: "A sales user's email here restricts that user to this customer's records.",
      }),
      S('crmAccountId', 'CRM Account ID', ['crmaccountid', 'accountid', 'crmid', 'externalid', 'recordid']),
    ],
    sampleRows: [
      { 'Customer Name': 'EXAMPLE — Acme Traders', GSTIN: '27AAAPA1234A1Z5', 'Contact Email': 'accounts@example.com', 'Account Owner': 'sales@yourcompany.com' },
    ],
  },

  // ---------------------------------------------------------------- company
  {
    key: 'company_details',
    label: 'Company Details',
    description: 'Updates the selected company profile from a workbook row.',
    enables: ['Company profile fields on reports and exports'],
    supportsPartialImport: false,
    duplicateBasis: 'Updates the selected company — only the first data row is read',
    fields: [
      S('name', 'Company Name', ['name', 'companyname', 'company', 'organisation', 'organization'], { required: true }),
      S('legalName', 'Legal Name', ['legalname', 'registeredname', 'fullname']),
      S('entityType', 'Entity Type', ['entitytype', 'type', 'constitution', 'organisationtype']),
      S('gstin', 'GSTIN', ['gstin', 'gstno', 'gstnumber']),
      S('pan', 'PAN', ['pan', 'panno', 'pannumber', 'incometaxno']),
      S('address', 'Address', ['address', 'registeredaddress', 'location']),
      S('currency', 'Currency', ['currency', 'reportingcurrency', 'basecurrency']),
    ],
    sampleRows: [
      { 'Company Name': 'EXAMPLE — Dhyeya Industries Pvt Ltd', 'Entity Type': 'private_limited', GSTIN: '27AAAPA1234A1Z5', PAN: 'AAAPA1234A', Currency: 'INR' },
    ],
  },
];

export const CATEGORY_MAP = new Map(IMPORT_CATEGORIES.map((c) => [c.key, c]));

export function getCategory(key: string): CategoryDef {
  const c = CATEGORY_MAP.get(key);
  if (!c) throw new Error(`Unknown import category: ${key}`);
  return c;
}

/** Header text reduced to a comparable form: lowercase, alphanumeric only. */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}
