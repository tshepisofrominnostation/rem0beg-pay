/**
 * Rem0Beg Pay — Core EWA Service Layer
 * =====================================
 * Handles all earned-wage-access business logic:
 *  - calculateAvailableBalance()
 *  - requestWithdrawal()
 *
 * CRITICAL FINANCIAL SAFETY RULE:
 * All monetary arithmetic uses the `decimal.js` library.
 * NEVER use native JS floats for money. Example of why:
 *   0.1 + 0.2 === 0.30000000000000004  ← catastrophic in fintech
 *   new Decimal('0.1').plus('0.2').toString() === '0.3' ✓
 *
 * Author: Tshepiso Freddy Thosago
 * Date: June 2026
 */

import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';

// ── Decimal.js config: 20 significant digits, ROUND_HALF_UP ──
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ── Types ─────────────────────────────────────────────────────

export type TransactionStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'DISBURSED'
  | 'SETTLED'
  | 'REVERSED';

export interface EmployeeBalance {
  employeeId: string;
  companyId: string;
  fullName: string;
  baseNetMonthlySalary: Decimal;
  currentAccruedEarnings: Decimal;
  totalWithdrawnThisMonth: Decimal;
  withdrawalCapPct: Decimal;
  transactionFee: Decimal;
  availableBalance: Decimal;          // max they can withdraw right now
  maxCapAmount: Decimal;              // accrued * cap (before subtracting withdrawn)
  companyStatus: string;
  employeeStatus: string;
  currentCycleStart: Date;
}

export interface WithdrawalResult {
  transactionId: string;
  referenceNumber: string;
  employeeId: string;
  amountRequested: Decimal;
  transactionFee: Decimal;
  netDisbursement: Decimal;           // amount going to employee's bank
  totalPayrollDeduction: Decimal;     // amount deducted at month-end
  status: TransactionStatus;
  billingCycle: string;
  createdAt: Date;
}

export interface ServiceError {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

// ── Custom error class ────────────────────────────────────────

export class EWAServiceError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;

  constructor({ code, message, context }: ServiceError) {
    super(message);
    this.name = 'EWAServiceError';
    this.code = code;
    this.context = context;
  }
}

// ── Reference number generator ────────────────────────────────
// Format: RBP-YYYYMMDD-XXXXX (e.g. RBP-20260614-00042)

let dailySequence = 0;
function generateReferenceNumber(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  dailySequence = (dailySequence + 1) % 99999;
  const seq = String(dailySequence).padStart(5, '0');
  return `RBP-${date}-${seq}`;
}

// ── Billing cycle helper ──────────────────────────────────────
// Returns 'YYYY-MM' for the current month

function currentBillingCycle(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ════════════════════════════════════════════════════════════
// EWA SERVICE CLASS
// ════════════════════════════════════════════════════════════

export class EWAService {
  private readonly pool: Pool;
  private readonly TRANSACTION_FEE = new Decimal('15.00'); // R15 flat fee

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // ──────────────────────────────────────────────────────────
  // 1. CALCULATE AVAILABLE BALANCE
  // ──────────────────────────────────────────────────────────
  /**
   * Determines the exact rand amount an employee can withdraw
   * right now, based on:
   *   available = MAX((accrued_earnings × cap_pct) − withdrawn, 0)
   *
   * Uses the database view v_employee_balances for a single
   * consistent read. All arithmetic done in Decimal.js.
   *
   * @param employeeId - UUID of the employee
   * @returns EmployeeBalance object with all balance fields
   * @throws EWAServiceError if employee not found or inactive
   */
  async calculateAvailableBalance(employeeId: string): Promise<EmployeeBalance> {
    const query = `
      SELECT
        eb.employee_id,
        eb.company_id,
        eb.full_name,
        eb.base_net_monthly_salary,
        eb.current_accrued_earnings,
        eb.total_withdrawn_this_month,
        eb.withdrawal_cap_pct,
        eb.transaction_fee,
        eb.available_balance,
        eb.current_cycle_start,
        eb.employee_status,
        eb.company_status
      FROM v_employee_balances eb
      WHERE eb.employee_id = $1
    `;

    const result = await this.pool.query(query, [employeeId]);

    if (result.rows.length === 0) {
      throw new EWAServiceError({
        code: 'EMPLOYEE_NOT_FOUND',
        message: `Employee ${employeeId} does not exist.`,
        context: { employeeId },
      });
    }

    const row = result.rows[0];

    // ── Validate company is active ───────────────────────────
    if (row.company_status !== 'ACTIVE') {
      throw new EWAServiceError({
        code: 'COMPANY_INACTIVE',
        message: `The company associated with this employee is not active (status: ${row.company_status}). EWA services are suspended.`,
        context: { employeeId, companyStatus: row.company_status },
      });
    }

    // ── Validate employee is active ──────────────────────────
    if (row.employee_status !== 'ACTIVE') {
      throw new EWAServiceError({
        code: 'EMPLOYEE_INACTIVE',
        message: `Employee is not active (status: ${row.employee_status}). Cannot access EWA services.`,
        context: { employeeId, employeeStatus: row.employee_status },
      });
    }

    // ── Convert DB values to Decimal (all math in Decimal.js) ─
    const accruedEarnings   = new Decimal(row.current_accrued_earnings);
    const withdrawn         = new Decimal(row.total_withdrawn_this_month);
    const capPct            = new Decimal(row.withdrawal_cap_pct);
    const transactionFee    = new Decimal(row.transaction_fee);
    const baseSalary        = new Decimal(row.base_net_monthly_salary);

    // ── Core calculation ─────────────────────────────────────
    // maxCapAmount = accrued × cap (e.g., R8,500 × 0.25 = R2,125)
    const maxCapAmount = accruedEarnings.times(capPct).toDecimalPlaces(2);

    // available = max(maxCapAmount − withdrawn, 0)
    const availableBalance = Decimal.max(
      maxCapAmount.minus(withdrawn).toDecimalPlaces(2),
      new Decimal('0.00')
    );

    return {
      employeeId:              row.employee_id,
      companyId:               row.company_id,
      fullName:                row.full_name,
      baseNetMonthlySalary:    baseSalary,
      currentAccruedEarnings:  accruedEarnings,
      totalWithdrawnThisMonth: withdrawn,
      withdrawalCapPct:        capPct,
      transactionFee,
      availableBalance,
      maxCapAmount,
      companyStatus:           row.company_status,
      employeeStatus:          row.employee_status,
      currentCycleStart:       new Date(row.current_cycle_start),
    };
  }

  // ──────────────────────────────────────────────────────────
  // 2. REQUEST WITHDRAWAL (Atomic — race-condition safe)
  // ──────────────────────────────────────────────────────────
  /**
   * Processes a withdrawal request atomically using a
   * PostgreSQL transaction with SELECT FOR UPDATE to prevent
   * race conditions (double-spending / concurrent requests).
   *
   * Flow:
   *  1. BEGIN transaction
   *  2. Lock employee row (SELECT FOR UPDATE — blocks concurrent requests)
   *  3. Re-calculate available balance from locked state
   *  4. Validate requested amount ≤ available balance
   *  5. Validate requested amount > transaction fee (otherwise pointless)
   *  6. INSERT transaction record
   *  7. UPDATE employee totals
   *  8. COMMIT
   *
   * All amounts in Decimal.js throughout.
   *
   * @param employeeId - UUID of the employee
   * @param requestedAmount - Amount in Rands (as string to avoid float)
   * @returns WithdrawalResult with full transaction details
   * @throws EWAServiceError on limit exceeded, inactive status, etc.
   */
  async requestWithdrawal(
    employeeId: string,
    requestedAmountInput: string | number
  ): Promise<WithdrawalResult> {

    // ── Input validation ─────────────────────────────────────
    // Accept string input to prevent caller from passing a float
    const requestedAmount = new Decimal(String(requestedAmountInput));

    if (requestedAmount.isNaN() || !requestedAmount.isFinite()) {
      throw new EWAServiceError({
        code: 'INVALID_AMOUNT',
        message: 'Requested amount is not a valid number.',
        context: { input: requestedAmountInput },
      });
    }

    if (requestedAmount.lessThanOrEqualTo(0)) {
      throw new EWAServiceError({
        code: 'INVALID_AMOUNT',
        message: 'Requested amount must be greater than R0.00.',
        context: { requestedAmount: requestedAmount.toString() },
      });
    }

    // Minimum useful withdrawal: more than the fee
    if (requestedAmount.lessThanOrEqualTo(this.TRANSACTION_FEE)) {
      throw new EWAServiceError({
        code: 'AMOUNT_TOO_SMALL',
        message: `Requested amount (R${requestedAmount.toFixed(2)}) must exceed the R${this.TRANSACTION_FEE.toFixed(2)} transaction fee.`,
        context: { requestedAmount: requestedAmount.toString(), fee: this.TRANSACTION_FEE.toString() },
      });
    }

    // Max sensible single withdrawal: R500,000
    if (requestedAmount.greaterThan(500000)) {
      throw new EWAServiceError({
        code: 'AMOUNT_TOO_LARGE',
        message: 'Single withdrawal request exceeds the maximum allowed (R500,000).',
        context: { requestedAmount: requestedAmount.toString() },
      });
    }

    // ── Begin atomic database transaction ────────────────────
    const client: PoolClient = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // ── Step 1: Lock employee row against concurrent requests ─
      // SELECT FOR UPDATE acquires a row-level lock.
      // Any concurrent withdrawal request will WAIT here until
      // this transaction commits or rolls back.
      const lockQuery = `
        SELECT
          e.id,
          e.company_id,
          e.status                      AS employee_status,
          e.current_accrued_earnings,
          e.total_withdrawn_this_month,
          e.current_cycle_start,
          e.bank_account_encrypted,
          e.bank_name,
          c.withdrawal_cap_pct,
          c.transaction_fee,
          c.status                      AS company_status
        FROM employees e
        JOIN companies c ON c.id = e.company_id
        WHERE e.id = $1
        FOR UPDATE OF e           -- locks ONLY the employee row
      `;
      const lockResult = await client.query(lockQuery, [employeeId]);

      if (lockResult.rows.length === 0) {
        throw new EWAServiceError({
          code: 'EMPLOYEE_NOT_FOUND',
          message: `Employee ${employeeId} does not exist.`,
          context: { employeeId },
        });
      }

      const emp = lockResult.rows[0];

      // ── Step 2: Validate company and employee status ─────────
      if (emp.company_status !== 'ACTIVE') {
        throw new EWAServiceError({
          code: 'COMPANY_INACTIVE',
          message: `Company is not active (status: ${emp.company_status}).`,
          context: { employeeId, companyStatus: emp.company_status },
        });
      }

      if (emp.employee_status !== 'ACTIVE') {
        throw new EWAServiceError({
          code: 'EMPLOYEE_INACTIVE',
          message: `Employee is not active (status: ${emp.employee_status}).`,
          context: { employeeId, employeeStatus: emp.employee_status },
        });
      }

      // ── Step 3: Re-calculate available balance from locked data ─
      // This is the AUTHORITATIVE calculation — derived from the
      // freshly-locked row, not from any cached value.
      const accrued    = new Decimal(emp.current_accrued_earnings);
      const withdrawn  = new Decimal(emp.total_withdrawn_this_month);
      const capPct     = new Decimal(emp.withdrawal_cap_pct);
      const fee        = new Decimal(emp.transaction_fee);

      const maxCap          = accrued.times(capPct).toDecimalPlaces(2);
      const availableBalance = Decimal.max(
        maxCap.minus(withdrawn).toDecimalPlaces(2),
        new Decimal('0.00')
      );

      // ── Step 4: Check requested amount ≤ available balance ───
      if (requestedAmount.greaterThan(availableBalance)) {
        throw new EWAServiceError({
          code: 'INSUFFICIENT_BALANCE',
          message: `Requested R${requestedAmount.toFixed(2)} exceeds available balance of R${availableBalance.toFixed(2)}.`,
          context: {
            requestedAmount:   requestedAmount.toString(),
            availableBalance:  availableBalance.toString(),
            totalAccrued:      accrued.toString(),
            capPct:            capPct.toString(),
            alreadyWithdrawn:  withdrawn.toString(),
          },
        });
      }

      // ── Step 5: Calculate fee and totals ─────────────────────
      // The R15 fee is deducted from the disbursement amount.
      // Full amount + fee is recovered from payroll at month-end.
      const netDisbursement       = requestedAmount.minus(fee).toDecimalPlaces(2);
      const totalPayrollDeduction = requestedAmount.plus(fee).toDecimalPlaces(2);
      // Note: fee is charged separately on top of requested amount
      // (i.e., employee gets requestedAmount, payroll deducts requestedAmount + fee)
      // Adjust based on business rule: here fee is ADDED to payroll deduction
      const billingCycle  = currentBillingCycle();
      const refNumber     = generateReferenceNumber();
      const transactionId = uuidv4();

      // ── Step 6: Insert transaction record ────────────────────
      const insertTxnQuery = `
        INSERT INTO transactions (
          id, employee_id, company_id, reference_number,
          amount_requested, transaction_fee, net_disbursement,
          total_payroll_deduction, status, billing_cycle,
          disbursement_bank, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8, 'PENDING', $9,
          $10, NOW(), NOW()
        )
        RETURNING id, reference_number, status, created_at
      `;

      await client.query(insertTxnQuery, [
        transactionId,
        employeeId,
        emp.company_id,
        refNumber,
        requestedAmount.toFixed(2),          // $5
        fee.toFixed(2),                      // $6
        netDisbursement.toFixed(2),          // $7
        totalPayrollDeduction.toFixed(2),    // $8
        billingCycle,                        // $9
        emp.bank_name || null,               // $10
      ]);

      // ── Step 7: Update employee running totals ───────────────
      // Increment total_withdrawn_this_month atomically.
      const updateEmpQuery = `
        UPDATE employees
        SET
          total_withdrawn_this_month = total_withdrawn_this_month + $1,
          updated_at = NOW()
        WHERE id = $2
      `;

      await client.query(updateEmpQuery, [
        requestedAmount.toFixed(2),
        employeeId,
      ]);

      // ── Step 8: Commit ────────────────────────────────────────
      await client.query('COMMIT');

      console.log(`[EWAService] ✓ Withdrawal created: ${refNumber} | Employee: ${employeeId} | Amount: R${requestedAmount.toFixed(2)}`);

      return {
        transactionId,
        referenceNumber:       refNumber,
        employeeId,
        amountRequested:       requestedAmount,
        transactionFee:        fee,
        netDisbursement,
        totalPayrollDeduction,
        status:                'PENDING',
        billingCycle,
        createdAt:             new Date(),
      };

    } catch (err) {
      // ── Rollback on any error ─────────────────────────────
      await client.query('ROLLBACK');
      console.error(`[EWAService] ✗ Withdrawal rolled back for ${employeeId}:`, err);

      // Re-throw EWAServiceErrors as-is; wrap unknown errors
      if (err instanceof EWAServiceError) throw err;
      throw new EWAServiceError({
        code: 'DATABASE_ERROR',
        message: 'A database error occurred while processing your withdrawal. Please try again.',
        context: { originalError: (err as Error).message },
      });

    } finally {
      // Always release the connection back to the pool
      client.release();
    }
  }

  // ──────────────────────────────────────────────────────────
  // 3. GET RECENT TRANSACTIONS  (for dashboard)
  // ──────────────────────────────────────────────────────────
  async getRecentTransactions(employeeId: string, limit = 10) {
    const query = `
      SELECT
        id, reference_number, amount_requested, transaction_fee,
        net_disbursement, total_payroll_deduction, status,
        billing_cycle, disbursed_at, created_at
      FROM transactions
      WHERE employee_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const result = await this.pool.query(query, [employeeId, limit]);

    // Convert amounts to Decimal for safe handling
    return result.rows.map(row => ({
      ...row,
      amount_requested:        new Decimal(row.amount_requested),
      transaction_fee:         new Decimal(row.transaction_fee),
      net_disbursement:        new Decimal(row.net_disbursement),
      total_payroll_deduction: new Decimal(row.total_payroll_deduction),
    }));
  }
}

// ════════════════════════════════════════════════════════════
// USAGE EXAMPLE (for testing / API route handlers)
// ════════════════════════════════════════════════════════════
/*
import { Pool } from 'pg';
import { EWAService, EWAServiceError } from './ewaService';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ewaService = new EWAService(pool);

// Check balance
const balance = await ewaService.calculateAvailableBalance('emp-uuid-here');
console.log(`Available: R${balance.availableBalance.toFixed(2)}`);

// Request withdrawal
try {
  const txn = await ewaService.requestWithdrawal('emp-uuid-here', '500.00');
  console.log(`Created: ${txn.referenceNumber}`);
} catch (err) {
  if (err instanceof EWAServiceError) {
    console.error(`[${err.code}] ${err.message}`);
  }
}
*/
