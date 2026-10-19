import type { Knex } from 'knex';

/**
 * ArthSetu initial schema.
 *
 * Portability notes:
 *  - Identifiers are text UUIDs generated in application code, so no engine-specific
 *    default expressions are needed.
 *  - Money is `bigInteger` holding INTEGER MINOR UNITS (paise). Never a float.
 *  - Dates are ISO `YYYY-MM-DD` text; timestamps are ISO-8601 UTC text. Both sort
 *    lexically, which keeps range queries identical on SQLite and Postgres.
 *  - `.json()` maps to jsonb on Postgres and text on SQLite; read through
 *    `readJson()` in src/lib/json.ts, which handles both.
 *  - Every financial table carries `company_id` so tenant isolation can be enforced
 *    in the query layer rather than hoped for.
 */

const isPg = (knex: Knex) => knex.client.config.client === 'pg';

function timestamps(t: Knex.CreateTableBuilder) {
  t.string('created_at', 32).notNullable();
  t.string('updated_at', 32).nullable();
}

export async function up(knex: Knex): Promise<void> {
  if (isPg(knex)) {
    await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  }

  // ---------------------------------------------------------------- identity
  await knex.schema.createTable('users', (t) => {
    t.string('id', 40).primary();
    t.string('email', 255).notNullable().unique();
    t.string('name', 160).notNullable();
    t.string('password_hash', 255).notNullable();
    t.string('role', 32).notNullable(); // executive | finance | sales | admin
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('must_change_password').notNullable().defaultTo(false);
    t.string('last_login_at', 32).nullable();
    timestamps(t);
  });

  await knex.schema.createTable('companies', (t) => {
    t.string('id', 40).primary();
    t.string('name', 200).notNullable();
    t.string('legal_name', 255).nullable();
    t.string('entity_type', 48).notNullable(); // proprietorship | partnership | llp | private_limited | public_limited | trust | other
    t.string('gstin', 20).nullable();
    t.string('pan', 12).nullable();
    t.string('currency', 8).notNullable().defaultTo('INR');
    t.integer('currency_scale').notNullable().defaultTo(2);
    t.string('country', 64).notNullable().defaultTo('India');
    t.text('address').nullable();
    t.boolean('is_demo').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    timestamps(t);
    t.index(['is_demo'], 'idx_companies_demo');
  });

  // Company-level access boundary. A user sees a company only through a row here
  // (admins excepted, which is enforced in the authorization layer).
  await knex.schema.createTable('user_companies', (t) => {
    t.string('id', 40).primary();
    t.string('user_id', 40).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('created_at', 32).notNullable();
    t.unique(['user_id', 'company_id'], { indexName: 'uq_user_company' });
  });

  await knex.schema.createTable('financial_years', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('label', 40).notNullable(); // e.g. "FY 2025-26"
    t.string('start_date', 10).notNullable();
    t.string('end_date', 10).notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(t);
    t.unique(['company_id', 'label'], { indexName: 'uq_fy_company_label' });
    t.index(['company_id', 'start_date'], 'idx_fy_company_start');
  });

  // ------------------------------------------------------------------ import
  await knex.schema.createTable('mapping_profiles', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('category', 48).notNullable();
    t.string('name', 160).notNullable();
    // Stable hash of the sorted header row — lets a repeat upload of the same
    // export format recall its mapping without the user re-doing step 4.
    t.string('header_signature', 64).notNullable();
    t.json('mapping').notNullable();
    t.json('options').nullable();
    t.integer('use_count').notNullable().defaultTo(0);
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    timestamps(t);
    t.unique(['company_id', 'category', 'header_signature'], { indexName: 'uq_profile_signature' });
  });

  await knex.schema.createTable('import_batches', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('financial_year_id', 40).nullable().references('id').inTable('financial_years').onDelete('SET NULL');
    t.string('category', 48).notNullable();
    t.string('file_name', 255).notNullable();
    t.bigInteger('file_size').notNullable();
    t.string('stored_path', 512).notNullable(); // private disk path, never a public URL
    t.string('checksum', 64).notNullable(); // sha256 of file bytes
    t.string('sheet_name', 255).nullable();
    t.string('status', 24).notNullable(); // uploaded | mapped | validated | committed | failed | rolled_back
    t.string('duplicate_strategy', 24).nullable(); // skip | update | review
    t.boolean('partial_import').notNullable().defaultTo(false);
    t.json('mapping').nullable();
    t.json('totals').nullable(); // {totalRows, validRows, invalidRows, duplicates, imported, updated, skipped}
    t.json('warnings').nullable();
    t.text('error_message').nullable();
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    t.string('completed_at', 32).nullable();
    timestamps(t);
    t.index(['company_id', 'created_at'], 'idx_batches_company_created');
    t.index(['company_id', 'category', 'status'], 'idx_batches_company_cat_status');
    t.index(['company_id', 'checksum'], 'idx_batches_checksum');
  });

  await knex.schema.createTable('import_rejections', (t) => {
    t.string('id', 40).primary();
    t.string('batch_id', 40).notNullable().references('id').inTable('import_batches').onDelete('CASCADE');
    t.integer('row_number').notNullable();
    t.json('raw').notNullable();
    t.json('errors').notNullable();
    t.string('severity', 16).notNullable().defaultTo('error'); // error | warning
    t.string('created_at', 32).notNullable();
    t.index(['batch_id'], 'idx_rejections_batch');
  });

  // ------------------------------------------------------------- accounting
  await knex.schema.createTable('ledger_groups', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.string('normalized_name', 200).notNullable();
    t.string('parent_name', 200).nullable();
    t.string('nature', 32).nullable(); // Assets | Liabilities | Income | Expenses (as supplied)
    t.string('external_id', 120).nullable();
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    timestamps(t);
    t.unique(['company_id', 'normalized_name'], { indexName: 'uq_group_company_name' });
  });

  await knex.schema.createTable('ledgers', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('name', 250).notNullable();
    t.string('normalized_name', 250).notNullable();
    t.string('group_name', 200).nullable();
    t.string('gstin', 20).nullable();
    t.bigInteger('opening_balance_minor').nullable(); // null = not supplied (distinct from zero)
    t.string('opening_side', 8).nullable(); // debit | credit
    t.string('external_id', 120).nullable();
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    timestamps(t);
    t.unique(['company_id', 'normalized_name'], { indexName: 'uq_ledger_company_name' });
    t.index(['company_id', 'group_name'], 'idx_ledger_company_group');
  });

  // Standard categories. Rows with company_id NULL are the system defaults; a
  // company may add its own or deactivate a default.
  await knex.schema.createTable('account_categories', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).nullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('key', 64).notNullable();
    t.string('label', 120).notNullable();
    t.string('statement', 8).notNullable(); // PL | BS
    t.string('section', 48).notNullable(); // revenue | cogs | operating_expenses | current_assets | ...
    t.string('normal_side', 8).notNullable(); // debit | credit
    t.integer('sort_order').notNullable().defaultTo(100);
    t.boolean('is_system').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.text('description').nullable();
    timestamps(t);
    t.index(['company_id'], 'idx_categories_company');
  });

  await knex.schema.createTable('account_mappings', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('ledger_id', 40).notNullable().references('id').inTable('ledgers').onDelete('CASCADE');
    t.string('category_key', 64).nullable();
    t.string('status', 16).notNullable(); // suggested | confirmed
    t.decimal('confidence', 5, 4).nullable();
    t.text('reason').nullable();
    t.string('previous_category_key', 64).nullable();
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    t.string('confirmed_by', 40).references('id').inTable('users').onDelete('SET NULL');
    t.string('confirmed_at', 32).nullable();
    timestamps(t);
    t.unique(['company_id', 'ledger_id'], { indexName: 'uq_mapping_company_ledger' });
    t.index(['company_id', 'status'], 'idx_mapping_company_status');
  });

  await knex.schema.createTable('vouchers', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('financial_year_id', 40).nullable().references('id').inTable('financial_years').onDelete('SET NULL');
    t.string('voucher_date', 10).notNullable();
    t.string('voucher_type', 64).nullable();
    t.string('voucher_number', 120).nullable();
    t.text('narration').nullable();
    t.string('reference', 160).nullable();
    t.string('external_id', 120).nullable();
    // Composite identity used for idempotent re-import. Never a row number.
    t.string('dedupe_key', 64).notNullable();
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    timestamps(t);
    t.unique(['company_id', 'dedupe_key'], { indexName: 'uq_voucher_dedupe' });
    t.index(['company_id', 'voucher_date'], 'idx_voucher_company_date');
  });

  await knex.schema.createTable('voucher_lines', (t) => {
    t.string('id', 40).primary();
    t.string('voucher_id', 40).notNullable().references('id').inTable('vouchers').onDelete('CASCADE');
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('ledger_id', 40).notNullable().references('id').inTable('ledgers').onDelete('RESTRICT');
    t.integer('line_no').notNullable().defaultTo(1);
    t.bigInteger('debit_minor').notNullable().defaultTo(0);
    t.bigInteger('credit_minor').notNullable().defaultTo(0);
    t.string('cost_centre', 160).nullable();
    t.text('narration').nullable();
    t.string('created_at', 32).notNullable();
    t.index(['company_id', 'ledger_id'], 'idx_lines_company_ledger');
    t.index(['voucher_id'], 'idx_lines_voucher');
  });

  await knex.schema.createTable('opening_balances', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('financial_year_id', 40).notNullable().references('id').inTable('financial_years').onDelete('CASCADE');
    t.string('ledger_id', 40).notNullable().references('id').inTable('ledgers').onDelete('CASCADE');
    t.bigInteger('amount_minor').notNullable();
    t.string('side', 8).notNullable(); // debit | credit
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    timestamps(t);
    t.unique(['company_id', 'financial_year_id', 'ledger_id'], { indexName: 'uq_opening_balance' });
  });

  for (const table of ['receivables', 'payables'] as const) {
    await knex.schema.createTable(table, (t) => {
      t.string('id', 40).primary();
      t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
      t.string('financial_year_id', 40).nullable().references('id').inTable('financial_years').onDelete('SET NULL');
      t.string('party_name', 250).notNullable();
      t.string('party_ledger_id', 40).nullable().references('id').inTable('ledgers').onDelete('SET NULL');
      t.string('document_number', 120).nullable();
      t.string('document_date', 10).nullable();
      t.string('due_date', 10).nullable(); // null is preserved, never inferred
      t.bigInteger('amount_minor').notNullable();
      t.bigInteger('paid_minor').nullable();
      t.bigInteger('outstanding_minor').notNullable();
      t.string('cost_centre', 160).nullable();
      t.string('reference', 160).nullable();
      t.string('dedupe_key', 64).notNullable();
      t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
      timestamps(t);
      t.unique(['company_id', 'dedupe_key'], { indexName: `uq_${table}_dedupe` });
      t.index(['company_id', 'due_date'], `idx_${table}_company_due`);
      t.index(['company_id', 'party_name'], `idx_${table}_company_party`);
    });
  }

  await knex.schema.createTable('cost_centres', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.string('normalized_name', 200).notNullable();
    t.string('parent_name', 200).nullable();
    t.string('external_id', 120).nullable();
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    timestamps(t);
    t.unique(['company_id', 'normalized_name'], { indexName: 'uq_cc_company_name' });
  });

  await knex.schema.createTable('stock_items', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('name', 250).notNullable();
    t.string('normalized_name', 250).notNullable();
    t.string('unit', 32).nullable();
    t.decimal('quantity', 20, 4).nullable();
    t.bigInteger('rate_minor').nullable();
    t.bigInteger('value_minor').nullable();
    t.string('as_of_date', 10).nullable();
    t.string('external_id', 120).nullable();
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    timestamps(t);
    t.unique(['company_id', 'normalized_name'], { indexName: 'uq_stock_company_name' });
  });

  // --------------------------------------------------------- expense & budget
  await knex.schema.createTable('expenses', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('financial_year_id', 40).nullable().references('id').inTable('financial_years').onDelete('SET NULL');
    t.string('expense_date', 10).notNullable();
    t.string('category', 120).nullable();
    t.string('vendor', 200).nullable();
    t.string('ledger_id', 40).nullable().references('id').inTable('ledgers').onDelete('SET NULL');
    t.bigInteger('amount_minor').notNullable();
    t.string('expense_type', 24).notNullable().defaultTo('one_off'); // fixed | recurring_variable | one_off
    t.string('cost_centre', 160).nullable();
    t.string('reference', 160).nullable();
    t.text('notes').nullable();
    t.string('dedupe_key', 64).notNullable();
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    timestamps(t);
    t.unique(['company_id', 'dedupe_key'], { indexName: 'uq_expense_dedupe' });
    t.index(['company_id', 'expense_date'], 'idx_expense_company_date');
    t.index(['company_id', 'category'], 'idx_expense_company_category');
  });

  await knex.schema.createTable('recurring_expenses', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.string('category', 120).nullable();
    t.bigInteger('amount_minor').notNullable();
    t.string('frequency', 24).notNullable(); // weekly | monthly | quarterly | half_yearly | yearly
    t.string('start_date', 10).notNullable();
    t.string('next_due_date', 10).notNullable();
    t.string('end_date', 10).nullable();
    t.string('ledger_id', 40).nullable().references('id').inTable('ledgers').onDelete('SET NULL');
    t.string('vendor', 200).nullable();
    t.string('cost_centre', 160).nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('is_variable').notNullable().defaultTo(false);
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    timestamps(t);
    t.index(['company_id', 'is_active'], 'idx_recurring_company_active');
  });

  await knex.schema.createTable('commitments', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.string('direction', 10).notNullable(); // inflow | outflow
    t.bigInteger('amount_minor').notNullable();
    t.string('expected_date', 10).notNullable();
    t.string('confidence', 16).nullable(); // high | medium | low
    t.text('notes').nullable();
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    timestamps(t);
    t.index(['company_id', 'expected_date'], 'idx_commitment_company_date');
  });

  await knex.schema.createTable('budgets', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('financial_year_id', 40).nullable().references('id').inTable('financial_years').onDelete('CASCADE');
    t.string('category', 120).notNullable();
    t.string('period_type', 16).notNullable(); // month | quarter | year | custom
    t.string('period_start', 10).notNullable();
    t.string('period_end', 10).notNullable();
    t.string('cost_centre', 160).nullable();
    t.bigInteger('amount_minor').notNullable();
    t.text('notes').nullable();
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    timestamps(t);
    t.index(['company_id', 'period_start'], 'idx_budget_company_period');
  });

  await knex.schema.createTable('forecast_scenarios', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.integer('horizon_days').notNullable().defaultTo(90);
    t.bigInteger('min_cash_minor').nullable();
    t.json('adjustments').notNullable();
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    timestamps(t);
    t.index(['company_id'], 'idx_scenario_company');
  });

  // Frozen report inputs so a past report can be reproduced exactly.
  await knex.schema.createTable('financial_snapshots', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('financial_year_id', 40).nullable().references('id').inTable('financial_years').onDelete('SET NULL');
    t.string('label', 200).notNullable();
    t.string('as_of_date', 10).notNullable();
    t.string('report_type', 48).notNullable();
    t.json('payload').notNullable();
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    t.string('created_at', 32).notNullable();
    t.index(['company_id', 'report_type', 'as_of_date'], 'idx_snapshot_lookup');
  });

  // ------------------------------------------------------- reconciliation
  await knex.schema.createTable('reconciliations', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('financial_year_id', 40).nullable().references('id').inTable('financial_years').onDelete('SET NULL');
    t.string('as_of_date', 10).notNullable();
    t.string('reference_file_name', 255).nullable();
    t.string('status', 24).notNullable(); // no_reference | matched | mismatched
    t.json('summary').nullable();
    t.string('created_by', 40).references('id').inTable('users').onDelete('SET NULL');
    t.string('created_at', 32).notNullable();
    t.index(['company_id', 'created_at'], 'idx_recon_company_created');
  });

  await knex.schema.createTable('reconciliation_lines', (t) => {
    t.string('id', 40).primary();
    t.string('reconciliation_id', 40).notNullable().references('id').inTable('reconciliations').onDelete('CASCADE');
    t.string('ledger_name', 250).notNullable();
    t.string('ledger_id', 40).nullable().references('id').inTable('ledgers').onDelete('SET NULL');
    t.bigInteger('imported_minor').nullable();
    t.bigInteger('reference_minor').nullable();
    t.bigInteger('difference_minor').nullable();
    t.string('status', 24).notNullable(); // match | mismatch | missing_in_import | missing_in_reference
    t.index(['reconciliation_id'], 'idx_recon_lines_parent');
  });

  // --------------------------------------------------------------- alerting
  await knex.schema.createTable('alerts', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('type', 48).notNullable();
    t.string('severity', 16).notNullable(); // info | warning | critical
    t.string('title', 250).notNullable();
    t.text('message').notNullable();
    t.bigInteger('amount_minor').nullable();
    t.string('link', 255).nullable();
    t.string('dedupe_key', 120).notNullable();
    t.boolean('is_read').notNullable().defaultTo(false);
    t.string('resolved_at', 32).nullable();
    t.json('meta').nullable();
    t.string('created_at', 32).notNullable();
    t.unique(['company_id', 'dedupe_key'], { indexName: 'uq_alert_dedupe' });
    t.index(['company_id', 'is_read'], 'idx_alert_company_read');
  });

  await knex.schema.createTable('app_settings', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).nullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('key', 96).notNullable();
    t.json('value').notNullable();
    t.string('updated_by', 40).references('id').inTable('users').onDelete('SET NULL');
    timestamps(t);
    t.unique(['company_id', 'key'], { indexName: 'uq_setting_company_key' });
  });

  // -------------------------------------------------------------------- CRM
  await knex.schema.createTable('crm_links', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).notNullable().references('id').inTable('companies').onDelete('CASCADE');
    t.string('ledger_id', 40).nullable().references('id').inTable('ledgers').onDelete('CASCADE');
    t.string('crm_account_id', 120).nullable();
    t.string('crm_source', 48).notNullable().defaultTo('excel_import');
    t.string('customer_name', 250).notNullable();
    t.string('gstin', 20).nullable();
    t.string('contact_email', 255).nullable();
    t.string('contact_phone', 48).nullable();
    t.string('owner', 160).nullable();
    t.string('match_method', 24).nullable(); // gstin | name | manual
    t.string('source_batch_id', 40).nullable().references('id').inTable('import_batches').onDelete('SET NULL');
    timestamps(t);
    t.index(['company_id'], 'idx_crm_company');
    t.index(['company_id', 'gstin'], 'idx_crm_company_gstin');
  });

  // ------------------------------------------------------------------ audit
  await knex.schema.createTable('audit_events', (t) => {
    t.string('id', 40).primary();
    t.string('company_id', 40).nullable().references('id').inTable('companies').onDelete('SET NULL');
    t.string('user_id', 40).nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('user_email', 255).nullable();
    t.string('action', 64).notNullable();
    t.string('entity_type', 48).nullable();
    t.string('entity_id', 64).nullable();
    t.text('summary').notNullable();
    t.json('meta').nullable();
    t.string('ip', 64).nullable();
    t.string('created_at', 32).notNullable();
    t.index(['company_id', 'created_at'], 'idx_audit_company_created');
    t.index(['action'], 'idx_audit_action');
  });
}

export async function down(knex: Knex): Promise<void> {
  const tables = [
    'audit_events',
    'crm_links',
    'app_settings',
    'alerts',
    'reconciliation_lines',
    'reconciliations',
    'financial_snapshots',
    'forecast_scenarios',
    'budgets',
    'commitments',
    'recurring_expenses',
    'expenses',
    'stock_items',
    'cost_centres',
    'payables',
    'receivables',
    'opening_balances',
    'voucher_lines',
    'vouchers',
    'account_mappings',
    'account_categories',
    'ledgers',
    'ledger_groups',
    'import_rejections',
    'import_batches',
    'mapping_profiles',
    'financial_years',
    'user_companies',
    'companies',
    'users',
  ];
  for (const table of tables) {
    await knex.schema.dropTableIfExists(table);
  }
}
