/**
 * Rem0Beg Pay — Daily Payroll Sync Worker
 * =========================================
 * Runs as a scheduled cron job (00:05 every weekday morning).
 * Simulates calling an external Payroll / Time-and-Attendance API,
 * processes shift data, and updates the Daily Earnings Ledger.
 *
 * CRON SCHEDULE: "5 0 * * 1-5"  (00:05 Mon–Fri, SA time)
 *
 * FINANCIAL SAFETY: All daily earnings calculations use Decimal.js.
 * Never divide base_net_monthly_salary by a JS float directly.
 *
 * DATA INTEGRITY:
 * - Validate all incoming rows against schema before DB writes.
 * - Corrupt / invalid rows → quarantine queue (sync_logs.quarantine_payload).
 * - Use a single DB transaction per company batch (atomic commit/rollback).
 * - Log every operation with timestamps for observability.
 *
 * Author: Tshepiso Freddy Thosago
 * Date: June 2026
 */

import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ── Types ─────────────────────────────────────────────────────

interface PayrollApiEmployee {
  external_payroll_ref: string;     // e.g. 'EMP-001'
  employee_name: string;
  date: string;                     // 'YYYY-MM-DD'
  hours_worked: number;             // e.g. 8.5
  shift_type: 'FULL' | 'HALF' | 'OVERTIME' | 'ABSENT';
  base_net_monthly_salary: string;  // string to avoid float issues
}

interface PayrollApiResponse {
  company_id: string;
  source_system: string;
  sync_date: string;
  records: PayrollApiEmployee[];
}

interface SyncResult {
  companyId: string;
  batchId: string;
  processed: number;
  failed: number;
  quarantined: PayrollApiEmployee[];
  totalEarningsAdded: Decimal;
  duration: number; // ms
}

// ── Logger helper ─────────────────────────────────────────────

const log = {
  info:  (msg: string, meta?: object) => console.log(`[${new Date().toISOString()}] [SYNC] INFO  ${msg}`, meta ?? ''),
  warn:  (msg: string, meta?: object) => console.warn(`[${new Date().toISOString()}] [SYNC] WARN  ${msg}`, meta ?? ''),
  error: (msg: string, meta?: object) => console.error(`[${new Date().toISOString()}] [SYNC] ERROR ${msg}`, meta ?? ''),
  ok:    (msg: string, meta?: object) => console.log(`[${new Date().toISOString()}] [SYNC] ✓     ${msg}`, meta ?? ''),
};

// ════════════════════════════════════════════════════════════
// MOCK PAYROLL API CLIENT
// Replace this with real HTTP calls to Sage / PaySpace / SFTP
// in production. The interface contract stays the same.
// ════════════════════════════════════════════════════════════

class MockPayrollApiClient {
  /**
   * Simulates a REST call to an HR / Time-and-Attendance system.
   * In production: replace with axios.get(endpoint, { headers: { 'X-API-Key': key } })
   *
   * The mock returns realistic SA payroll data including
   * intentionally corrupt rows to test quarantine handling.
   */
  async fetchDailyShifts(
    companyId: string,
    date: string
  ): Promise<PayrollApiResponse> {
    // Simulate network latency (80–250ms)
    await new Promise(resolve => setTimeout(resolve, 80 + Math.random() * 170));

    log.info(`Calling mock payroll API for company ${companyId} | date: ${date}`);

    // Mock realistic payroll dataset
    const mockRecords: PayrollApiEmployee[] = [
      {
        external_payroll_ref: 'EMP-001',
        employee_name: 'Nomsa Dlamini',
        date,
        hours_worked: 8,
        shift_type: 'FULL',
        base_net_monthly_salary: '28500.00',
      },
      {
        external_payroll_ref: 'EMP-002',
        employee_name: 'Sipho Khumalo',
        date,
        hours_worked: 4,
        shift_type: 'HALF',
        base_net_monthly_salary: '22000.00',
      },
      {
        external_payroll_ref: 'EMP-003',
        employee_name: 'Lerato Mokoena',
        date,
        hours_worked: 10,
        shift_type: 'OVERTIME',
        base_net_monthly_salary: '35000.00',
      },
      {
        external_payroll_ref: 'EMP-004',
        employee_name: 'Bongani Sithole',
        date,
        hours_worked: 0,
        shift_type: 'ABSENT',
        base_net_monthly_salary: '18000.00',
      },
      {
        external_payroll_ref: 'EMP-005',
        employee_name: 'Thandi Nkosi',
        date,
        hours_worked: 8,
        shift_type: 'FULL',
        base_net_monthly_salary: '31000.00',
      },
      // ── Intentionally corrupt row (tests quarantine) ──────
      {
        external_payroll_ref: '',             // ← missing ref
        employee_name: 'Unknown Employee',
        date,
        hours_worked: -5,                     // ← invalid hours
        shift_type: 'FULL',
        base_net_monthly_salary: 'NaN',       // ← corrupt salary
      },
    ];

    return {
      company_id:    companyId,
      source_system: 'MOCK_TIMEKEEPING_v2',
      sync_date:     date,
      records:       mockRecords,
    };
  }
}

// ════════════════════════════════════════════════════════════
// VALIDATION ENGINE
// ════════════════════════════════════════════════════════════

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateShiftRecord(record: PayrollApiEmployee): ValidationResult {
  const errors: string[] = [];

  if (!record.external_payroll_ref?.trim()) {
    errors.push('Missing external_payroll_ref');
  }

  if (!record.date || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
    errors.push(`Invalid date format: ${record.date}`);
  }

  if (typeof record.hours_worked !== 'number' || record.hours_worked < 0 || record.hours_worked > 24) {
    errors.push(`Invalid hours_worked: ${record.hours_worked}`);
  }

  // Validate salary as a valid decimal string
  const salaryDecimal = new Decimal(record.base_net_monthly_salary || 'NaN');
  if (salaryDecimal.isNaN() || salaryDecimal.isNegative() || salaryDecimal.isZero()) {
    errors.push(`Invalid base_net_monthly_salary: ${record.base_net_monthly_salary}`);
  }

  if (!['FULL', 'HALF', 'OVERTIME', 'ABSENT'].includes(record.shift_type)) {
    errors.push(`Unknown shift_type: ${record.shift_type}`);
  }

  return { valid: errors.length === 0, errors };
}

// ════════════════════════════════════════════════════════════
// DAILY EARNINGS CALCULATOR
// ════════════════════════════════════════════════════════════

/**
 * Calculates the rand amount earned for a single day.
 *
 * Formula: base_net_monthly_salary / working_days_in_month × days_worked_fraction
 *
 * days_worked_fraction:
 *   FULL    → 1.00
 *   HALF    → 0.50
 *   ABSENT  → 0.00
 *   OVERTIME→ 1.25 (25% premium, simplified)
 *
 * WORKING_DAYS_IN_MONTH: standardised to 22 for consistency.
 * In production, derive this from the actual calendar.
 *
 * All arithmetic in Decimal.js — no native floats.
 */
const WORKING_DAYS_PER_MONTH = new Decimal('22');

function calculateDailyEarnings(
  baseMonthlySalary: Decimal,
  shiftType: PayrollApiEmployee['shift_type']
): { daysWorked: Decimal; amountEarned: Decimal } {
  const dailyRate = baseMonthlySalary.dividedBy(WORKING_DAYS_PER_MONTH);

  const multiplierMap: Record<typeof shiftType, string> = {
    FULL:     '1.00',
    HALF:     '0.50',
    ABSENT:   '0.00',
    OVERTIME: '1.25',
  };

  const daysWorked = new Decimal(multiplierMap[shiftType] ?? '0.00');
  const amountEarned = dailyRate.times(daysWorked).toDecimalPlaces(2);

  return { daysWorked, amountEarned };
}

// ════════════════════════════════════════════════════════════
// DAILY SYNC WORKER CLASS
// ════════════════════════════════════════════════════════════

export class DailySyncWorker {
  private readonly pool: Pool;
  private readonly apiClient: MockPayrollApiClient;

  constructor(pool: Pool) {
    this.pool = pool;
    this.apiClient = new MockPayrollApiClient();
  }

  // ──────────────────────────────────────────────────────────
  // MAIN ENTRY POINT: run()
  // Called by cron scheduler every weekday morning
  // ──────────────────────────────────────────────────────────
  async run(): Promise<void> {
    const startTime = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    log.info(`=== Daily Sync Worker Starting | Date: ${today} ===`);

    // Fetch all active companies that have a payroll endpoint configured
    const companiesResult = await this.pool.query<{
      id: string;
      name: string;
      payroll_system: string;
      payroll_api_endpoint: string;
    }>(`
      SELECT id, name, payroll_system, payroll_api_endpoint
      FROM companies
      WHERE status = 'ACTIVE'
        AND payroll_api_endpoint IS NOT NULL
      ORDER BY name
    `);

    if (companiesResult.rows.length === 0) {
      log.warn('No active companies with payroll endpoints found. Exiting.');
      return;
    }

    log.info(`Found ${companiesResult.rows.length} active companies to sync.`);

    // Process each company sequentially (use Promise.all for parallel in prod)
    for (const company of companiesResult.rows) {
      try {
        const result = await this.syncCompany(company.id, company.name, today);
        log.ok(`Company "${company.name}" synced | Processed: ${result.processed} | Failed: ${result.failed} | Earnings added: R${result.totalEarningsAdded.toFixed(2)} | Duration: ${result.duration}ms`);
      } catch (err) {
        log.error(`Company "${company.name}" sync FAILED`, { error: (err as Error).message });
      }
    }

    log.info(`=== Daily Sync Worker Complete | Total duration: ${Date.now() - startTime}ms ===`);
  }

  // ──────────────────────────────────────────────────────────
  // SYNC ONE COMPANY (atomic per company)
  // ──────────────────────────────────────────────────────────
  private async syncCompany(
    companyId: string,
    companyName: string,
    date: string
  ): Promise<SyncResult> {
    const batchStart = Date.now();
    const batchId = uuidv4();
    const quarantined: PayrollApiEmployee[] = [];
    let processed = 0;
    let failed = 0;
    let totalEarningsAdded = new Decimal('0.00');

    log.info(`[${companyName}] Starting sync | batchId: ${batchId}`);

    // ── 1. Fetch from mock/real payroll API ──────────────────
    const apiResponse = await this.apiClient.fetchDailyShifts(companyId, date);
    const records = apiResponse.records;
    log.info(`[${companyName}] Received ${records.length} records from ${apiResponse.source_system}`);

    // ── 2. Validate all records first (fail-fast on bad data) ─
    const validRecords: PayrollApiEmployee[] = [];
    for (const record of records) {
      const { valid, errors } = validateShiftRecord(record);
      if (valid) {
        validRecords.push(record);
      } else {
        log.warn(`[${companyName}] Quarantining record for "${record.employee_name}"`, { errors });
        quarantined.push({ ...record, _validationErrors: errors } as PayrollApiEmployee & { _validationErrors: string[] });
        failed++;
      }
    }

    // ── 3. Build lookup of active employees for this company ──
    const empLookupResult = await this.pool.query<{
      id: string;
      external_payroll_ref: string;
      base_net_monthly_salary: string;
    }>(`
      SELECT id, external_payroll_ref, base_net_monthly_salary
      FROM employees
      WHERE company_id = $1 AND status = 'ACTIVE'
    `, [companyId]);

    const empMap = new Map(
      empLookupResult.rows.map(e => [e.external_payroll_ref, e])
    );

    // ── 4. Process valid records in a single DB transaction ───
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const record of validRecords) {
        const emp = empMap.get(record.external_payroll_ref);

        if (!emp) {
          log.warn(`[${companyName}] Employee ref "${record.external_payroll_ref}" not found in DB — skipping`);
          failed++;
          continue;
        }

        // ── Calculate earnings using Decimal.js ───────────────
        const baseSalary = new Decimal(emp.base_net_monthly_salary);
        const { daysWorked, amountEarned } = calculateDailyEarnings(
          baseSalary,
          record.shift_type
        );

        // ── Upsert daily_earnings_ledger ──────────────────────
        // ON CONFLICT: if record for this employee+date exists,
        // it means a re-sync — update the figures (idempotent).
        await client.query(`
          INSERT INTO daily_earnings_ledger (
            employee_id, company_id, earn_date,
            hours_worked, days_worked, amount_earned,
            sync_source, sync_batch_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (employee_id, earn_date)
          DO UPDATE SET
            hours_worked   = EXCLUDED.hours_worked,
            days_worked    = EXCLUDED.days_worked,
            amount_earned  = EXCLUDED.amount_earned,
            sync_source    = EXCLUDED.sync_source,
            sync_batch_id  = EXCLUDED.sync_batch_id
        `, [
          emp.id,
          companyId,
          record.date,
          record.hours_worked,
          daysWorked.toFixed(2),
          amountEarned.toFixed(2),
          apiResponse.source_system,
          batchId,
        ]);

        // ── Re-aggregate current_accrued_earnings from ledger ──
        // Sum all non-voided entries for this employee in the
        // current month — authoritative source of truth.
        const accrualResult = await client.query<{ total: string }>(`
          SELECT COALESCE(SUM(amount_earned), 0)::TEXT AS total
          FROM daily_earnings_ledger
          WHERE employee_id   = $1
            AND earn_date     >= DATE_TRUNC('month', CURRENT_DATE)
            AND is_void       = FALSE
        `, [emp.id]);

        const newAccruedTotal = new Decimal(accrualResult.rows[0].total);

        // ── Update employee running balance ───────────────────
        await client.query(`
          UPDATE employees
          SET
            current_accrued_earnings = $1,
            updated_at               = NOW()
          WHERE id = $2
        `, [newAccruedTotal.toFixed(2), emp.id]);

        totalEarningsAdded = totalEarningsAdded.plus(amountEarned);
        processed++;

        log.ok(
          `[${companyName}] ${record.employee_name} (${record.external_payroll_ref}) | ` +
          `Shift: ${record.shift_type} | Earned today: R${amountEarned.toFixed(2)} | ` +
          `Month total: R${newAccruedTotal.toFixed(2)}`
        );
      }

      await client.query('COMMIT');

      // ── 5. Log sync run to sync_logs ─────────────────────────
      await this.pool.query(`
        INSERT INTO sync_logs (
          company_id, batch_id, source_system,
          records_received, records_processed, records_failed,
          status, quarantine_payload, started_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      `, [
        companyId,
        batchId,
        apiResponse.source_system,
        records.length,
        processed,
        failed,
        quarantined.length > 0 ? 'PARTIAL' : 'SUCCESS',
        quarantined.length > 0 ? JSON.stringify(quarantined) : null,
        new Date(batchStart).toISOString(),
      ]);

    } catch (err) {
      await client.query('ROLLBACK');
      log.error(`[${companyName}] DB transaction rolled back`, { error: (err as Error).message });
      throw err;
    } finally {
      client.release();
    }

    return {
      companyId,
      batchId,
      processed,
      failed,
      quarantined,
      totalEarningsAdded,
      duration: Date.now() - batchStart,
    };
  }
}

// ════════════════════════════════════════════════════════════
// CRON RUNNER ENTRY POINT
// In production: use node-cron, Bull, or AWS EventBridge
// ════════════════════════════════════════════════════════════
/*
import cron from 'node-cron';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const worker = new DailySyncWorker(pool);

// Run at 00:05 every weekday (Mon-Fri), Africa/Johannesburg
cron.schedule('5 0 * * 1-5', async () => {
  try {
    await worker.run();
  } catch (err) {
    console.error('[CRON] Daily sync failed:', err);
    // Alert via Slack/PagerDuty in production
  }
}, { timezone: 'Africa/Johannesburg' });

console.log('[CRON] Daily sync worker registered — runs at 00:05 Mon–Fri (SAST)');
*/

// ── Manual trigger for testing ─────────────────────────────
// ts-node dailySyncWorker.ts
if (require.main === module) {
  (async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const worker = new DailySyncWorker(pool);
    await worker.run();
    await pool.end();
  })().catch(console.error);
}
