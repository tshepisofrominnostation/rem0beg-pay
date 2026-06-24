/**
 * Rem0Beg Pay — Month-End Reconciliation Module
 * ===============================================
 * Runs on the 23rd of each month (configurable per company).
 * Exports a clean CSV/JSON payload for corporate payroll import.
 *
 * PROCESS:
 *  1. Query all 'DISBURSED' transactions for the billing cycle
 *  2. Aggregate per-employee totals (withdrawals + fees)
 *  3. Generate CSV formatted for Sage / PaySpace import
 *  4. Mark transactions as 'SETTLED' atomically
 *  5. Record reconciliation run in audit table
 *  6. Validate CSV — reject if any dirty data found
 *
 * CURRENCY SAFETY:
 * All aggregation uses Decimal.js — PostgreSQL NUMERIC values
 * are fetched as strings and parsed into Decimal to prevent
 * JS floating-point contamination during final formatting.
 *
 * IDEMPOTENCY:
 * The reconciliation_runs table has a UNIQUE (company_id, billing_cycle)
 * constraint. Re-running for the same cycle will throw an error,
 * preventing double-deduction. Manual override requires admin action.
 *
 * Author: Tshepiso Freddy Thosago
 * Date: June 2026
 */

import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ── Types ─────────────────────────────────────────────────────

interface ReconRow {
  employee_id:          string;
  external_payroll_ref: string;
  full_name:            string;
  transaction_count:    number;
  total_withdrawn:      Decimal;
  total_fees:           Decimal;
  total_deduction:      Decimal;   // what payroll deducts from next salary
}

interface CsvRow {
  Employee_ID:           string;
  External_Payroll_Ref:  string;
  Full_Name:             string;
  Transaction_Count:     number;
  Total_EWA_Withdrawn:   string;   // formatted: "2500.00"
  Total_Fees_Charged:    string;
  Total_EWA_Deduction:   string;   // Total_EWA_Withdrawn + Total_Fees_Charged
  Current_Month_Cycle:   string;   // '2026-06'
  Currency:              string;   // 'ZAR'
  Generated_At:          string;   // ISO timestamp
}

interface ReconciliationResult {
  companyId:          string;
  billingCycle:       string;
  totalEmployees:     number;
  totalTransactions:  number;
  totalAmount:        Decimal;
  totalFees:          Decimal;
  totalDeduction:     Decimal;
  csvFilename:        string;
  csvContent:         string;
  checksum:           string;
  settledCount:       number;
}

// ── Logger ─────────────────────────────────────────────────────
const log = {
  info:  (msg: string) => console.log(`[${new Date().toISOString()}] [RECON] INFO  ${msg}`),
  warn:  (msg: string) => console.warn(`[${new Date().toISOString()}] [RECON] WARN  ${msg}`),
  error: (msg: string) => console.error(`[${new Date().toISOString()}] [RECON] ERROR ${msg}`),
  ok:    (msg: string) => console.log(`[${new Date().toISOString()}] [RECON] ✓     ${msg}`),
};

// ════════════════════════════════════════════════════════════
// DATA SANITISATION HELPERS
// ════════════════════════════════════════════════════════════

/**
 * Sanitise a string value for CSV inclusion.
 * Payroll systems reject dirty data — this is non-negotiable.
 * Rules:
 *  - Null/undefined → empty string
 *  - Strip control characters (newlines, tabs, etc.)
 *  - Wrap in quotes if the value contains commas, quotes, or newlines
 *  - Escape internal double quotes by doubling them ("")
 */
function sanitiseForCsv(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value)
    .replace(/[\r\n\t\x00-\x1F\x7F]/g, ' ')  // strip control chars
    .trim();

  // RFC 4180: wrap in quotes if contains comma, quote, or whitespace
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format a Decimal as a fixed 2-decimal-place string.
 * Validates the result to prevent 'NaN' or 'Infinity' in CSV.
 */
function formatAmount(d: Decimal): string {
  if (d.isNaN() || !d.isFinite()) {
    throw new Error(`Invalid financial amount detected: ${d.toString()}`);
  }
  return d.toFixed(2);
}

/**
 * Validate a reconciliation row before CSV inclusion.
 * Any invalid row blocks the entire export (fail-safe).
 */
function validateReconRow(row: ReconRow, index: number): void {
  if (!row.external_payroll_ref?.trim()) {
    throw new Error(`Row ${index}: Missing external_payroll_ref for employee ${row.employee_id}`);
  }
  if (!row.employee_id?.trim()) {
    throw new Error(`Row ${index}: Missing employee_id`);
  }
  if (row.total_deduction.isNegative()) {
    throw new Error(`Row ${index}: Negative total_deduction for ${row.external_payroll_ref} — ${row.total_deduction.toFixed(2)}`);
  }
  if (row.total_deduction.isNaN()) {
    throw new Error(`Row ${index}: NaN total_deduction for ${row.external_payroll_ref}`);
  }
  if (row.transaction_count <= 0) {
    throw new Error(`Row ${index}: Zero transactions for ${row.external_payroll_ref} — should not appear in export`);
  }
}

// ════════════════════════════════════════════════════════════
// RECONCILIATION SERVICE CLASS
// ════════════════════════════════════════════════════════════

export class MonthEndReconciliationService {
  private readonly pool: Pool;
  private readonly outputDir: string;

  constructor(pool: Pool, outputDir = './exports') {
    this.pool = pool;
    this.outputDir = outputDir;
    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  // ──────────────────────────────────────────────────────────
  // MAIN: runForCompany()
  // ──────────────────────────────────────────────────────────
  async runForCompany(
    companyId: string,
    billingCycle?: string  // defaults to current month 'YYYY-MM'
  ): Promise<ReconciliationResult> {

    const cycle = billingCycle ?? this.currentCycle();
    log.info(`=== Month-End Reconciliation | Company: ${companyId} | Cycle: ${cycle} ===`);

    // ── Guard: Prevent duplicate runs ────────────────────────
    const existingRun = await this.pool.query(
      `SELECT id, run_at FROM reconciliation_runs
       WHERE company_id = $1 AND billing_cycle = $2`,
      [companyId, cycle]
    );

    if (existingRun.rows.length > 0) {
      const runAt = existingRun.rows[0].run_at;
      throw new Error(
        `Reconciliation for cycle ${cycle} was already run at ${runAt}. ` +
        `To re-run, an admin must delete the reconciliation_runs record manually.`
      );
    }

    // ── 1. Fetch all DISBURSED transactions for this cycle ───
    log.info('Querying DISBURSED transactions...');
    const txnResult = await this.pool.query<{
      employee_id:          string;
      external_payroll_ref: string;
      full_name:            string;
      transaction_count:    string;
      total_withdrawn:      string;
      total_fees:           string;
      total_deduction:      string;
    }>(`
      SELECT
        t.employee_id,
        e.external_payroll_ref,
        e.first_name || ' ' || e.last_name AS full_name,
        COUNT(t.id)::TEXT                  AS transaction_count,
        SUM(t.amount_requested)::TEXT      AS total_withdrawn,
        SUM(t.transaction_fee)::TEXT       AS total_fees,
        SUM(t.total_payroll_deduction)::TEXT AS total_deduction
      FROM transactions t
      JOIN employees e ON e.id = t.employee_id
      WHERE t.company_id    = $1
        AND t.billing_cycle = $2
        AND t.status        = 'DISBURSED'
      GROUP BY t.employee_id, e.external_payroll_ref, e.first_name, e.last_name
      ORDER BY e.external_payroll_ref
    `, [companyId, cycle]);

    if (txnResult.rows.length === 0) {
      log.warn(`No DISBURSED transactions found for company ${companyId} cycle ${cycle}`);
    }

    log.info(`Found ${txnResult.rows.length} employees with disbursed transactions`);

    // ── 2. Convert DB strings to Decimal objects ─────────────
    const reconRows: ReconRow[] = txnResult.rows.map(row => ({
      employee_id:          row.employee_id,
      external_payroll_ref: row.external_payroll_ref,
      full_name:            row.full_name,
      transaction_count:    parseInt(row.transaction_count, 10),
      total_withdrawn:      new Decimal(row.total_withdrawn),
      total_fees:           new Decimal(row.total_fees),
      total_deduction:      new Decimal(row.total_deduction),
    }));

    // ── 3. Validate every row before touching the database ───
    log.info('Validating all rows...');
    reconRows.forEach((row, index) => validateReconRow(row, index + 1));
    log.ok('All rows validated — no dirty data found');

    // ── 4. Calculate grand totals using Decimal ───────────────
    const grandTotalAmount = reconRows
      .reduce((acc, r) => acc.plus(r.total_withdrawn), new Decimal('0.00'))
      .toDecimalPlaces(2);

    const grandTotalFees = reconRows
      .reduce((acc, r) => acc.plus(r.total_fees), new Decimal('0.00'))
      .toDecimalPlaces(2);

    const grandTotalDeduction = reconRows
      .reduce((acc, r) => acc.plus(r.total_deduction), new Decimal('0.00'))
      .toDecimalPlaces(2);

    const totalTransactions = reconRows
      .reduce((acc, r) => acc + r.transaction_count, 0);

    // ── 5. Generate CSV ───────────────────────────────────────
    const generatedAt = new Date().toISOString();
    const csvContent  = this.generateCsv(reconRows, cycle, generatedAt);
    const checksum    = crypto.createHash('sha256').update(csvContent).digest('hex');
    const filename    = `rem0beg_recon_${companyId.slice(0, 8)}_${cycle}.csv`;
    const filepath    = path.join(this.outputDir, filename);

    fs.writeFileSync(filepath, csvContent, 'utf-8');
    log.ok(`CSV written: ${filepath} | SHA256: ${checksum.slice(0, 16)}...`);

    // ── 6. Atomically mark transactions as SETTLED ───────────
    log.info('Marking transactions as SETTLED...');
    const client: PoolClient = await this.pool.connect();
    let settledCount = 0;

    try {
      await client.query('BEGIN');

      const settleResult = await client.query(`
        UPDATE transactions
        SET
          status      = 'SETTLED',
          settled_at  = NOW(),
          updated_at  = NOW()
        WHERE company_id    = $1
          AND billing_cycle = $2
          AND status        = 'DISBURSED'
        RETURNING id
      `, [companyId, cycle]);

      settledCount = settleResult.rowCount ?? 0;
      log.ok(`Marked ${settledCount} transactions as SETTLED`);

      // ── 7. Reset employee monthly counters ─────────────────
      // Zero out total_withdrawn_this_month and advance cycle start
      await client.query(`
        UPDATE employees
        SET
          total_withdrawn_this_month = 0.00,
          current_cycle_start        = DATE_TRUNC('month', CURRENT_DATE + INTERVAL '1 month'),
          updated_at                 = NOW()
        WHERE company_id = $1
          AND status     = 'ACTIVE'
      `, [companyId]);

      log.ok('Reset employee monthly counters for next cycle');

      // ── 8. Record reconciliation audit entry ─────────────────
      await client.query(`
        INSERT INTO reconciliation_runs (
          company_id, billing_cycle, run_at,
          total_employees, total_transactions,
          total_amount, total_fees, total_deduction,
          export_filename, export_checksum,
          status, run_by
        ) VALUES (
          $1, $2, NOW(),
          $3, $4,
          $5, $6, $7,
          $8, $9,
          'SUCCESS', 'SYSTEM_CRON'
        )
      `, [
        companyId, cycle,
        reconRows.length, totalTransactions,
        grandTotalAmount.toFixed(2),
        grandTotalFees.toFixed(2),
        grandTotalDeduction.toFixed(2),
        filename, checksum,
      ]);

      await client.query('COMMIT');
      log.ok('Reconciliation run committed to audit log');

    } catch (err) {
      await client.query('ROLLBACK');
      log.error(`DB transaction rolled back: ${(err as Error).message}`);
      // Delete the CSV file since the DB wasn't updated
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      throw err;
    } finally {
      client.release();
    }

    log.ok(`=== Reconciliation Complete ===`);
    log.ok(`  Employees:    ${reconRows.length}`);
    log.ok(`  Transactions: ${totalTransactions}`);
    log.ok(`  Total drawn:  R${grandTotalAmount.toFixed(2)}`);
    log.ok(`  Total fees:   R${grandTotalFees.toFixed(2)}`);
    log.ok(`  Total deduct: R${grandTotalDeduction.toFixed(2)}`);
    log.ok(`  CSV:          ${filename}`);

    return {
      companyId,
      billingCycle:     cycle,
      totalEmployees:   reconRows.length,
      totalTransactions,
      totalAmount:      grandTotalAmount,
      totalFees:        grandTotalFees,
      totalDeduction:   grandTotalDeduction,
      csvFilename:      filename,
      csvContent,
      checksum,
      settledCount,
    };
  }

  // ──────────────────────────────────────────────────────────
  // CSV GENERATOR
  // ──────────────────────────────────────────────────────────
  private generateCsv(
    rows: ReconRow[],
    cycle: string,
    generatedAt: string
  ): string {
    // Header row — matches Sage / PaySpace import format
    const headers = [
      'Employee_ID',
      'External_Payroll_Ref',
      'Full_Name',
      'Transaction_Count',
      'Total_EWA_Withdrawn',
      'Total_Fees_Charged',
      'Total_EWA_Deduction',
      'Current_Month_Cycle',
      'Currency',
      'Generated_At',
    ].join(',');

    const dataRows = rows.map(row => {
      const csvRow: CsvRow = {
        Employee_ID:          sanitiseForCsv(row.employee_id),
        External_Payroll_Ref: sanitiseForCsv(row.external_payroll_ref),
        Full_Name:            sanitiseForCsv(row.full_name),
        Transaction_Count:    row.transaction_count,
        Total_EWA_Withdrawn:  formatAmount(row.total_withdrawn),
        Total_Fees_Charged:   formatAmount(row.total_fees),
        Total_EWA_Deduction:  formatAmount(row.total_deduction),
        Current_Month_Cycle:  sanitiseForCsv(cycle),
        Currency:             'ZAR',
        Generated_At:         sanitiseForCsv(generatedAt),
      };

      return [
        csvRow.Employee_ID,
        csvRow.External_Payroll_Ref,
        csvRow.Full_Name,
        csvRow.Transaction_Count,
        csvRow.Total_EWA_Withdrawn,
        csvRow.Total_Fees_Charged,
        csvRow.Total_EWA_Deduction,
        csvRow.Current_Month_Cycle,
        csvRow.Currency,
        csvRow.Generated_At,
      ].join(',');
    });

    // Grand totals summary row (prefixed with # for easy parsing)
    const grandTotal = rows.reduce(
      (acc, r) => ({
        withdrawn:  acc.withdrawn.plus(r.total_withdrawn),
        fees:       acc.fees.plus(r.total_fees),
        deduction:  acc.deduction.plus(r.total_deduction),
      }),
      { withdrawn: new Decimal('0'), fees: new Decimal('0'), deduction: new Decimal('0') }
    );

    const summaryRow = [
      '#TOTALS',
      '',
      `${rows.length} employees`,
      rows.reduce((acc, r) => acc + r.transaction_count, 0),
      formatAmount(grandTotal.withdrawn),
      formatAmount(grandTotal.fees),
      formatAmount(grandTotal.deduction),
      cycle,
      'ZAR',
      generatedAt,
    ].join(',');

    return [
      `# Rem0Beg Pay — Month-End EWA Deduction Export`,
      `# Billing Cycle: ${cycle}`,
      `# Generated: ${generatedAt}`,
      `# IMPORTANT: Import this file in your payroll system ONCE.`,
      `# SHA256 checksum must be verified before import.`,
      headers,
      ...dataRows,
      summaryRow,
    ].join('\r\n');  // CRLF for maximum payroll system compatibility
  }

  // ── Helper: current billing cycle ─────────────────────────
  private currentCycle(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
}

// ════════════════════════════════════════════════════════════
// CRON RUNNER — runs on the 23rd of each month at 23:00 SAST
// ════════════════════════════════════════════════════════════
/*
import cron from 'node-cron';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const reconService = new MonthEndReconciliationService(pool, './exports');

// "0 23 23 * *" = 23:00 on the 23rd of every month
cron.schedule('0 23 23 * *', async () => {
  const companies = await pool.query(
    `SELECT id FROM companies WHERE status = 'ACTIVE' AND billing_cycle_day = 23`
  );
  for (const co of companies.rows) {
    try {
      await reconService.runForCompany(co.id);
    } catch (err) {
      console.error(`[RECON CRON] Failed for company ${co.id}:`, err);
    }
  }
}, { timezone: 'Africa/Johannesburg' });
*/
