/**
 * End-to-end exercise of the real HTTP API, following §31's Definition of Done:
 * sign in → create company → create financial year → upload → inspect → map →
 * validate → commit → confirm mappings → read statements → drill down → export.
 *
 * Asserts against the known expected results in the fixture generator. Run with:
 *   npx tsx tests/e2e.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED } from './fixtures/make-workbooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBOOKS = path.join(__dirname, 'fixtures', 'workbooks');
const BASE = process.env.API_BASE ?? 'http://localhost:4000/api';

let token = '';
let companyId = '';
let financialYearId = '';

const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
  results.push({ name, ok: condition, detail });
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${detail && !condition ? ` — ${detail}` : ''}`);
}

function rupees(minor: number): number {
  return minor / 100;
}

async function api(method: string, route: string, body?: unknown, raw = false): Promise<any> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (companyId) headers['x-company-id'] = companyId;

  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${route}`, { method, headers, body: payload });
  if (raw) return res;

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }

  if (!res.ok) {
    const err = new Error(`${method} ${route} → ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
    (err as any).status = res.status;
    (err as any).body = json;
    throw err;
  }
  return json;
}

async function uploadWorkbook(file: string, category: string): Promise<string> {
  const buffer = fs.readFileSync(path.join(WORKBOOKS, file));
  const form = new FormData();
  form.append('file', new Blob([buffer]), file);
  form.append('category', category);
  form.append('companyId', companyId);
  if (financialYearId) form.append('financialYearId', financialYearId);

  const res = await api('POST', '/imports/upload', form);
  return res.batch.id;
}

/** Runs the inspect → validate → commit sequence the wizard performs. */
async function importWorkbook(
  file: string,
  category: string,
  opts: { duplicateStrategy?: string; partial?: boolean; options?: Record<string, unknown> } = {},
) {
  const batchId = await uploadWorkbook(file, category);

  const inspect = await api('GET', `/imports/batches/${batchId}/inspect`);

  const validated = await api('POST', `/imports/batches/${batchId}/validate`, {
    sheetName: inspect.sheet.name,
    headerRowIndex: inspect.sheet.headerRowIndex,
    mapping: inspect.effectiveMapping,
    options: opts.options ?? {},
    rememberMapping: true,
  });

  const committed = await api('POST', `/imports/batches/${batchId}/commit`, {
    duplicateStrategy: opts.duplicateStrategy ?? 'skip',
    partialImport: opts.partial ?? validated.report.invalidRows > 0,
    acknowledgedWarnings: true,
  });

  return { batchId, inspect, validated, committed };
}

async function main() {
  console.log('\n═══ DHYEYA end-to-end test ═══\n');

  // ------------------------------------------------------------- 1. sign in
  console.log('1. Authentication');
  const login = await api('POST', '/auth/login', {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@dhyeya.local',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'ChangeMe#2026',
  });
  token = login.token;
  check('Administrator signs in', Boolean(token));
  check('Capabilities are returned for the role', login.user.capabilities.includes('imports.create'));

  const badLogin = await api('POST', '/auth/login', { email: 'admin@dhyeya.local', password: 'wrong' }, true);
  check('A wrong password is rejected', badLogin.status === 401);

  // ------------------------------------------------- 2. company and FY setup
  console.log('\n2. Company and financial year');
  const suffix = Date.now().toString().slice(-6);
  const company = await api('POST', '/companies', {
    name: `Dhyeya Test Industries ${suffix}`,
    entityType: 'private_limited',
    currency: 'INR',
    currencyScale: 2,
    country: 'India',
    gstin: '27AAAPA1234A1Z5',
  });
  companyId = company.company.id;
  check('Company is created', Boolean(companyId));

  const fy = await api('POST', `/companies/${companyId}/financial-years`, {
    label: 'FY 2025-26',
    startDate: '2025-04-01',
    endDate: '2026-03-31',
  });
  financialYearId = fy.financialYear.id;
  check('Financial year is created', Boolean(financialYearId));

  const overlap = await api(
    'POST',
    `/companies/${companyId}/financial-years`,
    { label: 'Overlapping', startDate: '2025-06-01', endDate: '2026-05-31' },
    true,
  );
  check('An overlapping financial year is refused', overlap.status === 409);

  // --------------------------------------------------- 3. empty-state checks
  console.log('\n3. Empty state before any import');
  const emptyDash = await api('GET', `/finance/dashboard?companyId=${companyId}&financialYearId=${financialYearId}`);
  check('Dashboard reports itself as empty before import', emptyDash.isEmpty === true);
  const revenueKpi = emptyDash.kpis.find((k: any) => k.key === 'revenue');
  check('Revenue KPI is "unavailable", not zero', revenueKpi.available === false && revenueKpi.value === null, JSON.stringify(revenueKpi));

  const emptyRecon = await api('GET', `/reconciliation/status?companyId=${companyId}`);
  check('Reconciliation reports "Reference data not provided"', emptyRecon.status === 'no_reference');

  // ------------------------------------------------------ 4. chart of accounts
  console.log('\n4. Chart of accounts import');
  const coa = await importWorkbook('chart-of-accounts.xlsx', 'chart_of_accounts');
  check(
    `Header row is found below the title block (row index ${coa.inspect.sheet.headerRowIndex})`,
    coa.inspect.sheet.headerRowIndex === 4,
    `got ${coa.inspect.sheet.headerRowIndex}`,
  );
  check('"Under" is auto-mapped to Ledger Group', coa.inspect.effectiveMapping.groupName === 'Under');
  check(
    `All ${EXPECTED.ledgerCount} ledgers import`,
    coa.committed.result.inserted === EXPECTED.ledgerCount,
    `inserted ${coa.committed.result.inserted}`,
  );
  check('Mappings are suggested automatically', coa.committed.result.mappingsSuggested > 10, `${coa.committed.result.mappingsSuggested} suggested`);

  // Re-import the same file — nothing should duplicate.
  const coaAgain = await importWorkbook('chart-of-accounts.xlsx', 'chart_of_accounts');
  check(
    'Re-importing the same file inserts nothing',
    coaAgain.committed.result.inserted === 0 && coaAgain.committed.result.skipped === EXPECTED.ledgerCount,
    `inserted ${coaAgain.committed.result.inserted}, skipped ${coaAgain.committed.result.skipped}`,
  );

  // ------------------------------------------------------- 5. account mapping
  console.log('\n5. Account mapping');
  const ledgers = await api('GET', `/mapping/ledgers?companyId=${companyId}&financialYearId=${financialYearId}`);
  const bankLedger = ledgers.ledgers.find((l: any) => l.ledgerName === 'HDFC Bank Current A/c');
  check('A bank ledger is suggested as Cash and Bank', bankLedger?.categoryKey === 'cash_and_bank', bankLedger?.categoryKey);

  const debtor = ledgers.ledgers.find((l: any) => l.ledgerName === 'Acme Traders');
  check('A Sundry Debtors ledger is suggested as Trade Receivables', debtor?.categoryKey === 'trade_receivables', debtor?.categoryKey);

  const bankCharges = ledgers.ledgers.find((l: any) => l.ledgerName === 'Interest on Term Loan');
  check(
    'An interest ledger is suggested as Finance Costs, not Cash and Bank',
    bankCharges?.categoryKey === 'finance_cost',
    bankCharges?.categoryKey,
  );

  const accepted = await api('POST', '/mapping/accept-suggestions', { companyId, minConfidence: 0.6 });
  check('Suggested mappings can be accepted in bulk', accepted.confirmed > 10, `${accepted.confirmed} confirmed`);

  const afterAccept = await api('GET', `/mapping/ledgers?companyId=${companyId}&financialYearId=${financialYearId}`);
  const stillUnmapped = afterAccept.summary.unmapped + afterAccept.summary.suggested;
  if (stillUnmapped > 0) {
    // Map anything left by hand, as a finance user would.
    for (const l of afterAccept.ledgers.filter((x: any) => x.status !== 'confirmed')) {
      const guess =
        l.ledgerName.includes('GST') ? 'tax_payable' : l.ledgerName.includes('Loan') ? 'loans_borrowings' : 'operating_expenses';
      await api('POST', '/mapping/assign', { companyId, ledgerIds: [l.ledgerId], categoryKey: guess, confirm: true });
    }
  }
  const finalMap = await api('GET', `/mapping/ledgers?companyId=${companyId}&financialYearId=${financialYearId}`);
  check('Every ledger ends up with a confirmed category', finalMap.summary.unmapped === 0 && finalMap.summary.suggested === 0);

  // ------------------------------------------------------ 6. opening balances
  console.log('\n6. Opening balances');
  const ob = await importWorkbook('opening-balances.xlsx', 'opening_balances');
  check('Opening balances import', ob.committed.result.inserted >= 7, `inserted ${ob.committed.result.inserted}`);

  // ------------------------------------------------------------- 7. vouchers
  console.log('\n7. Vouchers');
  const v = await importWorkbook('vouchers.xlsx', 'vouchers', { partial: true });
  check(
    'Blank continuation cells are carried down into multi-line vouchers',
    v.validated.preview.items.some((x: any) => x.lines.length === 3),
    `line counts: ${v.validated.preview.items.map((x: any) => x.lines.length).join(',')}`,
  );
  check(
    `${EXPECTED.voucherCount} vouchers are assembled from the rows`,
    v.validated.preview.totalItems === EXPECTED.voucherCount,
    `got ${v.validated.preview.totalItems}`,
  );
  check(
    'The unreadable amount is rejected rather than treated as zero',
    v.validated.report.invalidRows === EXPECTED.rejectedVoucherRows,
    `${v.validated.report.invalidRows} rejected`,
  );
  check(
    'The deliberately unbalanced voucher is flagged',
    v.validated.report.imbalancedVouchers.some((x: any) => x.voucherNumber === EXPECTED.unbalancedVoucherNumber),
    JSON.stringify(v.validated.report.imbalancedVouchers),
  );
  check('Dates are read as day-first', v.validated.report.dateRange?.from === '2025-04-05', v.validated.report.dateRange?.from);
  check('Vouchers commit', v.committed.result.inserted === EXPECTED.voucherCount, `inserted ${v.committed.result.inserted}`);

  const vAgain = await importWorkbook('vouchers.xlsx', 'vouchers', { partial: true });
  check(
    'Re-importing vouchers does not duplicate financial transactions',
    vAgain.committed.result.inserted === 0,
    `inserted ${vAgain.committed.result.inserted}`,
  );

  // Rejected rows can be downloaded.
  const rejectionRes = await api('GET', `/imports/batches/${v.batchId}/rejections.xlsx`, undefined, true);
  check('The rejected-row report downloads', rejectionRes.status === 200 && Number(rejectionRes.headers.get('content-length')) > 1000);

  // ------------------------------------------------- 8. receivables/payables
  console.log('\n8. Receivables and payables');
  const ar = await importWorkbook('receivables.xlsx', 'receivables');
  check('Receivables import', ar.committed.result.inserted === 5, `inserted ${ar.committed.result.inserted}`);

  await importWorkbook('payables.xlsx', 'payables');

  const arList = await api('GET', `/finance/receivables?companyId=${companyId}&asOfDate=2025-12-31`);
  check(
    `Outstanding receivables total ₹${EXPECTED.receivableOutstanding.toLocaleString('en-IN')}`,
    rupees(arList.summary.total) === EXPECTED.receivableOutstanding,
    `got ₹${rupees(arList.summary.total)}`,
  );
  check(
    'An invoice with no due date is held out of the overdue buckets',
    arList.summary.missingDueDateCount === EXPECTED.receivableWithoutDueDate,
    `${arList.summary.missingDueDateCount}`,
  );
  check('A settled invoice is excluded from the outstanding total', arList.summary.totalCount === 4, `${arList.summary.totalCount}`);

  // ------------------------------------------------- 9. expenses and budgets
  console.log('\n9. Expenses and budgets');
  await importWorkbook('expenses-and-budgets.xlsx', 'expenses');

  const budgetBatch = await uploadWorkbook('expenses-and-budgets.xlsx', 'budgets');
  const budgetInspect = await api('GET', `/imports/batches/${budgetBatch}/inspect?sheet=Budgets`);
  await api('POST', `/imports/batches/${budgetBatch}/validate`, {
    sheetName: 'Budgets',
    headerRowIndex: budgetInspect.sheet.headerRowIndex,
    mapping: budgetInspect.effectiveMapping,
    rememberMapping: true,
  });
  const budgetCommit = await api('POST', `/imports/batches/${budgetBatch}/commit`, { duplicateStrategy: 'skip', partialImport: true });
  check('Budgets import from a second sheet in the same workbook', budgetCommit.result.inserted === 3, `inserted ${budgetCommit.result.inserted}`);

  const budgets = await api('GET', `/expenses/budgets?companyId=${companyId}&financialYearId=${financialYearId}`);
  const travel = budgets.budgets.find((b: any) => b.category === 'Travel');
  check('Budget variance is computed against actual expenses', travel && rupees(travel.actual) === 36000, JSON.stringify(travel));
  check('A budget overrun shows utilisation above 100%', travel && travel.utilisationPercent > 100, `${travel?.utilisationPercent}`);

  const anomalies = await api('GET', `/expenses/anomalies?companyId=${companyId}&financialYearId=${financialYearId}`);
  check(
    'A same-day duplicate payment is detected as confirmed, not heuristic',
    anomalies.findings.some((f: any) => f.kind === 'duplicate_payment' && f.certainty === 'confirmed'),
  );
  check(
    'A salary spike is reported as heuristic',
    anomalies.findings.some((f: any) => f.kind === 'expense_spike' && f.certainty === 'heuristic'),
  );

  // -------------------------------------------------------- 10. Profit & Loss
  console.log('\n10. Profit & Loss');
  const pl = await api(
    'GET',
    `/finance/profit-and-loss?companyId=${companyId}&financialYearId=${financialYearId}&periodType=financial_year`,
  );
  check(`Revenue is ₹${EXPECTED.revenue.toLocaleString('en-IN')}`, rupees(pl.revenue) === EXPECTED.revenue, `got ₹${rupees(pl.revenue)}`);
  check(`Gross profit is ₹${EXPECTED.grossProfit.toLocaleString('en-IN')}`, rupees(pl.grossProfit) === EXPECTED.grossProfit, `got ₹${rupees(pl.grossProfit)}`);
  check(`Net profit is ₹${EXPECTED.netProfit.toLocaleString('en-IN')}`, rupees(pl.netProfit) === EXPECTED.netProfit, `got ₹${rupees(pl.netProfit)}`);
  check('Every line carries its formula', pl.lines.every((l: any) => typeof l.formula === 'string' && l.formula.length > 0));

  // ------------------------------------------------------- 11. Balance Sheet
  console.log('\n11. Balance Sheet');
  const bs = await api(
    'GET',
    `/finance/balance-sheet?companyId=${companyId}&financialYearId=${financialYearId}&asOfDate=2026-03-31&comparison=none`,
  );
  console.log(
    `     assets ₹${rupees(bs.totalAssets)}, liabilities ₹${rupees(bs.totalLiabilities)}, equity ₹${rupees(bs.totalEquity)}, difference ₹${rupees(bs.equationDifference)}`,
  );
  check('The accounting equation check is reported', typeof bs.equationDifference === 'number');
  check(
    'An out-of-balance sheet is not forced to balance, and gets diagnostics',
    bs.balances === true || bs.diagnostics.length > 0,
    `balances=${bs.balances}, diagnostics=${bs.diagnostics.length}`,
  );
  check(
    'The profit for the period is shown inside equity',
    bs.profitForPeriod !== null && rupees(bs.profitForPeriod) === EXPECTED.netProfit,
    `got ₹${rupees(bs.profitForPeriod)}`,
  );

  // ------------------------------------------------------------- 12. equity
  console.log('\n12. Equity statement');
  const eq = await api('GET', `/finance/equity?companyId=${companyId}&financialYearId=${financialYearId}`);
  check(
    `Opening equity is ₹${EXPECTED.openingCapital.toLocaleString('en-IN')}`,
    rupees(eq.openingEquity) === EXPECTED.openingCapital,
    `got ₹${rupees(eq.openingEquity)}`,
  );
  check('The statement is presented for a company (dividends, not drawings)', eq.lines.some((l: any) => l.label === 'Dividends paid'));

  // ------------------------------------------------------------- 13. ratios
  console.log('\n13. Ratios');
  const ratios = await api('GET', `/finance/ratios?companyId=${companyId}&financialYearId=${financialYearId}`);
  const current = ratios.ratios.find((r: any) => r.key === 'current_ratio');
  const grossMargin = ratios.ratios.find((r: any) => r.key === 'gross_margin');
  const interestCover = ratios.ratios.find((r: any) => r.key === 'interest_coverage');
  const dso = ratios.ratios.find((r: any) => r.key === 'dso');

  check('Current ratio computes with its formula shown', current.available && current.formula.includes('÷'));
  check(
    `Gross margin is ${((EXPECTED.grossProfit / EXPECTED.revenue) * 100).toFixed(1)}%`,
    Math.abs(grossMargin.value - (EXPECTED.grossProfit / EXPECTED.revenue) * 100) < 0.01,
    `got ${grossMargin.value}`,
  );
  check(
    'Interest coverage is N/A when there is no finance cost, not Infinity',
    interestCover.available === false && interestCover.value === null && Boolean(interestCover.reason),
    JSON.stringify({ v: interestCover.value, r: interestCover.reason }),
  );
  check('DSO declares its credit-sales limitation', Boolean(dso.limitation && dso.limitation.includes('CREDIT')));

  // ----------------------------------------------------------- 14. dashboard
  console.log('\n14. Executive dashboard');
  const dash = await api('GET', `/finance/dashboard?companyId=${companyId}&financialYearId=${financialYearId}`);
  const dashRevenue = dash.kpis.find((k: any) => k.key === 'revenue');
  const dashNet = dash.kpis.find((k: any) => k.key === 'netProfit');
  check('Dashboard revenue matches the Profit & Loss exactly', rupees(dashRevenue.value) === EXPECTED.revenue, `got ₹${rupees(dashRevenue.value)}`);
  check('Dashboard net profit matches the Profit & Loss exactly', rupees(dashNet.value) === EXPECTED.netProfit, `got ₹${rupees(dashNet.value)}`);
  check('The data source is reported as Excel Import', dash.dataSource.kind === 'excel_import');
  check('The last import timestamp is present', Boolean(dash.dataSource.lastImportAt));
  check('No Tally connection is claimed', JSON.stringify(dash).toLowerCase().includes('tally') === false);

  // ---------------------------------------------------------- 15. drill-down
  console.log('\n15. Drill-down');
  const drill = await api(
    'GET',
    `/finance/drilldown/category/revenue?companyId=${companyId}&financialYearId=${financialYearId}&periodType=financial_year`,
  );
  check('Revenue drills down to its ledgers', drill.ledgers.length === 2, `${drill.ledgers.length} ledgers`);
  check('Drill-down total matches the Profit & Loss revenue', rupees(drill.total) === EXPECTED.revenue);

  const ledgerDrill = await api(
    'GET',
    `/finance/drilldown/ledger/${drill.ledgers[0].ledgerId}?companyId=${companyId}&financialYearId=${financialYearId}&periodType=financial_year`,
  );
  check('A ledger drills down to its transactions', ledgerDrill.transactions.length > 0);

  const voucherDrill = await api('GET', `/finance/drilldown/voucher/${ledgerDrill.transactions[0].voucherId}?companyId=${companyId}`);
  check('A transaction drills through to the full voucher', voucherDrill.lines.length >= 2);
  check('The voucher reports the source import file', Boolean(voucherDrill.source?.fileName));

  // ----------------------------------------------------------- 16. forecast
  console.log('\n16. Cash flow forecast');
  const forecast = await api('GET', `/finance/forecast?companyId=${companyId}&horizonDays=90&asOfDate=2025-12-01`);
  check('The forecast is labelled rule-based', forecast.method === 'rule_based');
  check('Three scenarios are produced', Boolean(forecast.scenarios.best && forecast.scenarios.expected && forecast.scenarios.worst));
  check(
    'The best case is never worse than the worst case',
    forecast.scenarios.best.closingBalance >= forecast.scenarios.worst.closingBalance,
  );
  check('A data-sufficiency score is reported', typeof forecast.dataSufficiency.score === 'number');
  check(
    'Receivables with no due date are reported as unscheduled',
    forecast.dataSufficiency.unscheduled.receivablesWithoutDueDateCount === EXPECTED.receivableWithoutDueDate,
  );

  const scenario = await api('POST', `/finance/forecast/scenario`, {
    companyId,
    asOfDate: '2025-12-01',
    horizonDays: 90,
    adjustments: [{ id: 's1', type: 'one_off_expense', label: 'New machine', amount: 50_000_00, date: '2025-12-15' }],
  });
  check(
    'A one-off expense scenario reduces the projected closing balance by exactly its amount',
    rupees(scenario.impact.closingBalanceChange) === -50000,
    `got ₹${rupees(scenario.impact.closingBalanceChange)}`,
  );

  // ----------------------------------------------------- 17. reconciliation
  console.log('\n17. Reconciliation');
  const refBuffer = fs.readFileSync(path.join(WORKBOOKS, 'reference-trial-balance.xlsx'));
  const refForm = new FormData();
  refForm.append('file', new Blob([refBuffer]), 'reference-trial-balance.xlsx');
  refForm.append('companyId', companyId);
  refForm.append('asOfDate', '2026-03-31');
  refForm.append('financialYearId', financialYearId);

  const recon = await api('POST', '/reconciliation/run', refForm);
  check('Reconciliation runs against a reference report', Boolean(recon.id));
  check('Differences are found and reported by ledger', recon.summary.mismatched > 0, JSON.stringify(recon.summary));
  const plantLine = recon.lines.find((l: any) => l.ledgerName === 'Plant & Machinery');
  check(
    'The deliberate ₹50,000 difference is detected exactly',
    plantLine && Math.abs(rupees(plantLine.difference)) === 50000,
    JSON.stringify(plantLine),
  );

  // ----------------------------------------------------------- 18. exports
  console.log('\n18. Exports');
  for (const [report, format] of [
    ['profit_and_loss', 'pdf'],
    ['profit_and_loss', 'xlsx'],
    ['balance_sheet', 'pdf'],
    ['balance_sheet', 'xlsx'],
    ['financial_ratios', 'xlsx'],
    ['receivables_ageing', 'pdf'],
    ['cash_flow_forecast', 'xlsx'],
    ['import_history', 'xlsx'],
    ['data_quality', 'pdf'],
  ] as const) {
    const res = await api(
      'GET',
      `/reports/${report}/export.${format}?companyId=${companyId}&financialYearId=${financialYearId}`,
      undefined,
      true,
    );
    const size = Number(res.headers.get('content-length') ?? 0) || (await res.arrayBuffer()).byteLength;
    check(`${report}.${format} exports (${(size / 1024).toFixed(0)} KB)`, res.status === 200 && size > 800, `status ${res.status}, ${size} bytes`);
  }

  // ------------------------------------------------- 19. integration honesty
  console.log('\n19. Integration status honesty');
  const crm = await api('GET', `/crm/status?companyId=${companyId}`);
  check('CRM reports not connected', crm.connection.connected === false);

  const ai = await api('GET', '/ai/status');
  check('AI reports not configured', ai.configured === false);

  const ask = await api('POST', '/ai/ask', { companyId, question: 'What is our receivable position?' }, true);
  check('An AI question returns "not configured" rather than a fabricated answer', ask.status === 503);

  const settings = await api('GET', `/admin/settings?companyId=${companyId}`);
  check('Tally is reported as not connected', settings.integrations.tally.connected === false);
  check('The scheduler is reported as not deployed', settings.integrations.scheduler.connected === false);

  const alerts = await api('GET', `/alerts?companyId=${companyId}`);
  check('Alerts are generated from the data', alerts.alerts.length > 0, `${alerts.alerts.length} alerts`);
  check('Alert delivery reports the absence of a scheduler', alerts.delivery.scheduler.configured === false);

  // -------------------------------------------------- 20. role enforcement
  console.log('\n20. Role-based access, enforced on the backend');
  const salesPassword = 'SalesUser#2026';
  const salesEmail = `sales-${suffix}@dhyeya.local`;
  await api('POST', '/admin/users', {
    email: salesEmail,
    name: 'Sales Tester',
    role: 'sales',
    password: salesPassword,
    companyIds: [companyId],
  });

  // ---------------------------------------------- 21. custom ratio builder
  console.log('\n21. Custom ratio builder');

  const badFormula = await api('POST', `/finance/ratios/custom/preview?companyId=${companyId}`, {
    label: 'Broken',
    formula: 'revenue / ',
    unit: 'times',
  });
  check('An incomplete formula is rejected with a readable reason', badFormula.valid === false && typeof badFormula.error === 'string', JSON.stringify(badFormula).slice(0, 120));

  const unknownInput = await api('POST', `/finance/ratios/custom/preview?companyId=${companyId}`, {
    label: 'Unknown input',
    formula: 'revenue / mystery',
    unit: 'times',
  });
  check(
    'An unknown input name is refused rather than treated as zero',
    unknownInput.valid === false && /mystery/.test(unknownInput.error ?? ''),
    JSON.stringify(unknownInput).slice(0, 120),
  );

  const injection = await api('POST', `/finance/ratios/custom/preview?companyId=${companyId}`, {
    label: 'Injection attempt',
    formula: 'process.exit(1)',
    unit: 'times',
  });
  check('A formula is parsed, never evaluated as JavaScript', injection.valid === false, JSON.stringify(injection).slice(0, 120));

  const previewOk = await api('POST', `/finance/ratios/custom/preview?companyId=${companyId}`, {
    label: 'Expense ratio',
    formula: 'operatingExpenses / revenue * 100',
    unit: 'percent',
    group: 'profitability',
  });
  check('A valid formula previews before it is saved', previewOk.valid === true && previewOk.result?.available === true);

  // Operating expenses 90,000 of revenue 3,00,000 → 30%. Cross-checked below
  // against the Profit & Loss so the ratio can never quietly drift from it.
  check(
    'The previewed value is arithmetically correct',
    previewOk.valid && Math.abs((previewOk.result.value ?? 0) - 30) < 0.001,
    `got ${previewOk.result?.value}`,
  );
  // The builder must read the same figures as the statements, not its own copy.
  const revenueInput = previewOk.result.inputs.find((i: any) => i.label === 'Revenue');
  check(
    'A custom ratio reads the same revenue as the Profit & Loss',
    revenueInput?.value === pl.revenue,
    `ratio ${revenueInput?.value}, P&L ${pl.revenue}`,
  );

  const divZero = await api('POST', `/finance/ratios/custom/preview?companyId=${companyId}`, {
    label: 'Divide by nothing',
    formula: 'revenue / (revenue - revenue)',
    unit: 'times',
  });
  check(
    'Division by zero reports N/A instead of Infinity',
    divZero.valid === true && divZero.result.available === false && /zero/i.test(divZero.result.reason ?? ''),
    JSON.stringify(divZero.result).slice(0, 160),
  );

  const created = await api('PUT', `/finance/ratios/custom?companyId=${companyId}`, {
    label: 'Expense ratio',
    formula: 'operatingExpenses / revenue * 100',
    unit: 'percent',
    group: 'profitability',
    explanation: 'Share of revenue consumed by operating expenses.',
  });
  check('A custom ratio saves', Boolean(created.ratio?.key));

  const withCustom = await api('GET', `/finance/ratios?companyId=${companyId}&periodType=financial_year`);
  const customRow = withCustom.ratios.find((r: any) => r.key === created.ratio.key);
  check('The custom ratio appears alongside the standard ones', Boolean(customRow) && customRow.isCustom === true);
  check('It carries its own formula and inputs', customRow?.formula === 'operatingExpenses / revenue * 100' && customRow.inputs.length === 2);

  const inputsCatalogue = await api('GET', `/finance/ratios/inputs?companyId=${companyId}&periodType=financial_year`);
  check('The input catalogue is published for the builder', Array.isArray(inputsCatalogue.groups) && inputsCatalogue.groups.length > 0);
  check('Inputs the data cannot supply are flagged', Array.isArray(inputsCatalogue.unavailable));

  const deleted = await api('DELETE', `/finance/ratios/custom/${created.ratio.key}?companyId=${companyId}`);
  check('A custom ratio can be removed', deleted.deleted === created.ratio.key);

  // ------------------------------------------------ 22. forecast backtesting
  console.log('\n22. Forecast backtesting');

  const emptyBacktest = await api('GET', `/finance/forecast/backtest?companyId=${companyId}`);
  check('Backtesting starts with no recorded runs', Array.isArray(emptyBacktest.runs) && emptyBacktest.runs.length === 0);
  check(
    'No accuracy figure is claimed before anything is scored',
    emptyBacktest.accuracy.mape === null && emptyBacktest.accuracy.scoredCount === 0,
  );

  const futureRun = await api('POST', `/finance/forecast/runs?companyId=${companyId}`, { horizonDays: 90 });
  check('A forecast run is recorded', Boolean(futureRun.run?.id));
  check('It stores the target date it will be scored on', /^\d{4}-\d{2}-\d{2}$/.test(futureRun.run.targetDate));
  check(
    'It stores all three scenario projections',
    typeof futureRun.run.projected.best === 'number' &&
      typeof futureRun.run.projected.expected === 'number' &&
      typeof futureRun.run.projected.worst === 'number',
  );

  const pending = await api('GET', `/finance/forecast/backtest?companyId=${companyId}`);
  const pendingRun = pending.runs.find((r: any) => r.id === futureRun.run.id);
  check('A run whose target date has not arrived is not scored', pendingRun?.status === 'not_yet_due');
  check('It is not given a made-up accuracy figure', pendingRun?.absolutePercentError === null && pendingRun?.actualClosingCash === null);

  // A run dated far enough back that its horizon has already elapsed can be scored.
  const pastRun = await api('POST', `/finance/forecast/runs?companyId=${companyId}`, {
    horizonDays: 30,
    asOfDate: '2025-06-01',
  });
  const scored = await api('GET', `/finance/forecast/backtest?companyId=${companyId}`);
  const scoredRun = scored.runs.find((r: any) => r.id === pastRun.run.id);
  check('A run past its target date is scored against actual cash', scoredRun?.status === 'scored', `status ${scoredRun?.status}`);
  check('The actual closing cash is read from imported data', typeof scoredRun?.actualClosingCash === 'number');
  check('An error percentage is produced', typeof scoredRun?.absolutePercentError === 'number');
  check('Whether the actual fell inside the scenario band is reported', typeof scoredRun?.withinScenarioBand === 'boolean');
  check('The accuracy summary now reports a scored run', scored.accuracy.scoredCount >= 1 && scored.accuracy.mape !== null);

  const adminToken = token;
  const salesLogin = await api('POST', '/auth/login', { email: salesEmail, password: salesPassword });
  token = salesLogin.token;

  const salesDash = await api('GET', `/finance/dashboard?companyId=${companyId}`, undefined, true);
  check('A sales user cannot reach the executive dashboard', salesDash.status === 403, `status ${salesDash.status}`);

  const salesPl = await api('GET', `/finance/profit-and-loss?companyId=${companyId}`, undefined, true);
  check('A sales user cannot reach the Profit & Loss', salesPl.status === 403, `status ${salesPl.status}`);

  const salesAr = await api('GET', `/finance/receivables?companyId=${companyId}`, undefined, true);
  check('A sales user cannot reach company-wide receivables', salesAr.status === 403, `status ${salesAr.status}`);

  const salesOwn = await api('GET', `/finance/my-customers/receivables?companyId=${companyId}`);
  check('A sales user reaches only their assigned customers', salesOwn.scope === 'assigned' && salesOwn.documents.length === 0);

  const salesImport = await api('POST', '/imports/upload', new FormData(), true);
  check('A sales user cannot import', salesImport.status === 403, `status ${salesImport.status}`);

  token = adminToken;

  // Another company's data must be unreachable.
  const other = await api('POST', '/companies', { name: `Isolation Check ${suffix}`, entityType: 'proprietorship' });
  const otherId = other.company.id;
  const otherPl = await api(
    'GET',
    `/finance/profit-and-loss?companyId=${otherId}&periodType=financial_year`,
  );
  check('A second company starts with no financial data of its own', otherPl.isEmpty === true);
  check('The first company’s revenue does not leak into the second', otherPl.revenue === null);

  // --------------------------------------------------------------- summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log(`\n═══ ${passed}/${results.length} checks passed ═══`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('All checks passed.\n');
}

main().catch((err) => {
  console.error('\nE2E run failed:', err instanceof Error ? err.message : err);
  if ((err as any).body) console.error(JSON.stringify((err as any).body, null, 2).slice(0, 2000));
  process.exit(1);
});
