-- ============================================================
-- Rem0Beg Pay — PostgreSQL Schema v1.0
-- Earned Wage Access (EWA) Platform
-- Author: Tshepiso Freddy Thosago
-- Date: June 2026
--
-- DESIGN NOTES:
-- 1. All monetary values use NUMERIC(15,2) — NOT FLOAT.
--    Floating-point types (FLOAT, DOUBLE) introduce binary
--    rounding errors (e.g. 0.1 + 0.2 = 0.30000000000000004).
--    NUMERIC stores exact decimal values — mandatory for fintech.
-- 2. All IDs use UUID to prevent enumeration attacks and support
--    future microservice decomposition.
-- 3. Tenant isolation enforced at schema level via company_id FK
--    on every employee-adjacent table.
-- 4. Timestamps use TIMESTAMPTZ (timezone-aware) to handle
--    multi-province payroll cycles correctly.
-- 5. The transactions table is append-only (no hard deletes).
--    Corrections happen via reversal records, not UPDATEs.
-- ============================================================

-- ── EXTENSIONS ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy name search

-- ── ENUMS ────────────────────────────────────────────────────

-- Transaction lifecycle states
-- PENDING   → request received, awaiting approval
-- APPROVED  → compliance/cap check passed
-- DISBURSED → funds sent to employee bank account
-- SETTLED   → included in month-end payroll deduction export
-- REVERSED  → cancelled or failed after disbursement
CREATE TYPE transaction_status AS ENUM (
  'PENDING', 'APPROVED', 'DISBURSED', 'SETTLED', 'REVERSED'
);

-- Company account status
CREATE TYPE company_status AS ENUM (
  'ACTIVE', 'SUSPENDED', 'ONBOARDING', 'TERMINATED'
);

-- Employee record status
CREATE TYPE employee_status AS ENUM (
  'ACTIVE', 'INACTIVE', 'TERMINATED', 'ON_LEAVE'
);

-- Payroll sync result
CREATE TYPE sync_status AS ENUM (
  'SUCCESS', 'PARTIAL', 'FAILED', 'QUARANTINED'
);

-- ════════════════════════════════════════════════════════════
-- TABLE 1: companies  (Multi-tenant root entity)
-- ════════════════════════════════════════════════════════════
-- Each company is an independent tenant. Their employees,
-- transactions, and reconciliation records are fully isolated.
-- withdrawal_cap_pct is stored as a decimal (0.25 = 25%).
-- The payroll_api_key is hashed before storage — never plain text.
CREATE TABLE companies (
  id                    UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  name                  TEXT          NOT NULL,
  registration_number   TEXT          UNIQUE,               -- CIPC reg number
  tax_reference         TEXT,                               -- SARS reference
  payroll_system        TEXT,                               -- 'Sage', 'PaySpace', 'Pastel'
  payroll_api_key_hash  TEXT,                               -- bcrypt hash of API key
  payroll_api_endpoint  TEXT,                               -- SFTP/REST endpoint URL
  withdrawal_cap_pct    NUMERIC(5,4)  NOT NULL DEFAULT 0.25 -- 0.25 = 25% cap
                        CHECK (withdrawal_cap_pct > 0 AND withdrawal_cap_pct <= 0.50),
  transaction_fee       NUMERIC(8,2)  NOT NULL DEFAULT 15.00, -- R15 flat fee
  billing_cycle_day     INTEGER       NOT NULL DEFAULT 23   -- day of month to run recon
                        CHECK (billing_cycle_day BETWEEN 1 AND 28),
  status                company_status NOT NULL DEFAULT 'ONBOARDING',
  contact_name          TEXT,
  contact_email         TEXT,
  contact_phone         TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_companies_status ON companies(status);
CREATE INDEX idx_companies_name   ON companies USING gin(name gin_trgm_ops);

-- ════════════════════════════════════════════════════════════
-- TABLE 2: employees
-- ════════════════════════════════════════════════════════════
-- Linked to a single company (tenant).
-- base_net_monthly_salary: take-home after tax/UIF — what EWA
--   calculations are based on. NOT gross. NUMERIC for precision.
-- current_accrued_earnings: running total updated by daily sync
--   worker. Resets on the 1st of each month.
-- bank_account_number stored encrypted at application layer
--   (not plaintext). Here we store the encrypted ciphertext.
-- external_payroll_ref: the employee ID in Sage/PaySpace — used
--   for month-end CSV export matching.
CREATE TABLE employees (
  id                       UUID            DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id               UUID            NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  external_payroll_ref     TEXT            NOT NULL,         -- Sage/PaySpace employee ID
  first_name               TEXT            NOT NULL,
  last_name                TEXT            NOT NULL,
  id_number                TEXT,                             -- SA ID / passport
  email                    TEXT            NOT NULL,
  phone                    TEXT,
  base_net_monthly_salary  NUMERIC(15,2)   NOT NULL
                           CHECK (base_net_monthly_salary > 0),
  current_accrued_earnings NUMERIC(15,2)   NOT NULL DEFAULT 0.00
                           CHECK (current_accrued_earnings >= 0),
  total_withdrawn_this_month NUMERIC(15,2) NOT NULL DEFAULT 0.00
                           CHECK (total_withdrawn_this_month >= 0),
  -- Bank details (store encrypted ciphertext at app layer)
  bank_name                TEXT,
  bank_account_encrypted   TEXT,                            -- AES-256 encrypted
  bank_account_type        TEXT CHECK (bank_account_type IN ('CHEQUE','SAVINGS','TRANSMISSION')),
  branch_code              TEXT,
  status                   employee_status NOT NULL DEFAULT 'ACTIVE',
  hire_date                DATE,
  -- Cycle tracking: reset monthly by reconciliation worker
  current_cycle_start      DATE            NOT NULL DEFAULT DATE_TRUNC('month', NOW())::DATE,
  created_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  -- Ensure external_payroll_ref is unique within a company
  UNIQUE (company_id, external_payroll_ref),
  UNIQUE (company_id, email)
);

-- Indexes — employee lookups are the hottest query path
CREATE INDEX idx_employees_company        ON employees(company_id);
CREATE INDEX idx_employees_status         ON employees(company_id, status);
CREATE INDEX idx_employees_payroll_ref    ON employees(company_id, external_payroll_ref);
CREATE INDEX idx_employees_email          ON employees(email);
-- Partial index: only active employees (most reads filter on this)
CREATE INDEX idx_employees_active         ON employees(company_id)
  WHERE status = 'ACTIVE';

-- ════════════════════════════════════════════════════════════
-- TABLE 3: daily_earnings_ledger
-- ════════════════════════════════════════════════════════════
-- Immutable record of how much an employee earned on a given day.
-- Populated by the daily sync worker from HR/Time-and-Attendance.
-- amount_earned: prorated daily slice of base_net_monthly_salary
--   (base_net_monthly_salary / working_days_in_month * days_worked)
-- sync_source: which payroll system this record came from.
-- This table is INSERT-only. Corrections use is_void=true + new row.
CREATE TABLE daily_earnings_ledger (
  id              UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id     UUID          NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  company_id      UUID          NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  earn_date       DATE          NOT NULL,
  hours_worked    NUMERIC(5,2)  NOT NULL DEFAULT 0.00
                  CHECK (hours_worked >= 0 AND hours_worked <= 24),
  days_worked     NUMERIC(4,2)  NOT NULL DEFAULT 1.00
                  CHECK (days_worked >= 0 AND days_worked <= 1),
  amount_earned   NUMERIC(15,2) NOT NULL
                  CHECK (amount_earned >= 0),
  sync_source     TEXT          NOT NULL DEFAULT 'MANUAL',  -- 'SAGE','PAYSPACE','SFTP','MANUAL'
  sync_batch_id   UUID,                                     -- groups records from same sync run
  is_void         BOOLEAN       NOT NULL DEFAULT FALSE,     -- soft-void for corrections
  void_reason     TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- Prevent duplicate entries for same employee on same date
  UNIQUE (employee_id, earn_date)
);

-- Indexes — balance calculation queries aggregate by employee + date range
CREATE INDEX idx_del_employee_date   ON daily_earnings_ledger(employee_id, earn_date DESC);
CREATE INDEX idx_del_company_date    ON daily_earnings_ledger(company_id, earn_date DESC);
CREATE INDEX idx_del_batch           ON daily_earnings_ledger(sync_batch_id);
-- Partial: only non-voided records (balance sums always filter this)
CREATE INDEX idx_del_active          ON daily_earnings_ledger(employee_id, earn_date)
  WHERE is_void = FALSE;

-- ════════════════════════════════════════════════════════════
-- TABLE 4: transactions
-- ════════════════════════════════════════════════════════════
-- Core financial ledger. APPEND-ONLY — never DELETE or UPDATE
-- amounts. Status transitions happen via status column only.
-- reference_number: human-readable, unique per transaction.
-- net_disbursement: amount_requested (fee borne by employee).
-- Atomic writes via DB transactions prevent race conditions.
CREATE TABLE transactions (
  id                  UUID              DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id         UUID              NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  company_id          UUID              NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  reference_number    TEXT              NOT NULL UNIQUE,    -- e.g. RBP-20260614-00042
  amount_requested    NUMERIC(15,2)     NOT NULL
                      CHECK (amount_requested > 0),
  transaction_fee     NUMERIC(8,2)      NOT NULL DEFAULT 15.00,
  net_disbursement    NUMERIC(15,2)     NOT NULL            -- amount_requested - fee (if fee deducted upfront)
                      CHECK (net_disbursement >= 0),
  total_payroll_deduction NUMERIC(15,2) NOT NULL,           -- amount_requested + fee at month-end
  status              transaction_status NOT NULL DEFAULT 'PENDING',
  -- Lifecycle timestamps (nullable until that state is reached)
  approved_at         TIMESTAMPTZ,
  disbursed_at        TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ,
  reversed_at         TIMESTAMPTZ,
  -- Bank disbursement tracking
  disbursement_ref    TEXT,                                 -- bank/mock API reference
  disbursement_bank   TEXT,                                 -- destination bank name
  -- Cycle this transaction belongs to
  billing_cycle       TEXT              NOT NULL,           -- e.g. '2026-06'
  -- Optional reversal link
  reversal_of         UUID              REFERENCES transactions(id),
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- Indexes — reports filter heavily by employee, company, status, cycle
CREATE INDEX idx_txn_employee         ON transactions(employee_id);
CREATE INDEX idx_txn_company          ON transactions(company_id);
CREATE INDEX idx_txn_status           ON transactions(status);
CREATE INDEX idx_txn_billing_cycle    ON transactions(company_id, billing_cycle);
CREATE INDEX idx_txn_employee_cycle   ON transactions(employee_id, billing_cycle);
CREATE INDEX idx_txn_reference        ON transactions(reference_number);
-- Partial: pending transactions (most time-sensitive reads)
CREATE INDEX idx_txn_pending          ON transactions(employee_id, created_at)
  WHERE status = 'PENDING';

-- ════════════════════════════════════════════════════════════
-- TABLE 5: reconciliation_runs
-- ════════════════════════════════════════════════════════════
-- Audit trail for every month-end reconciliation execution.
-- Records what was exported and confirms the CSV was generated.
-- Prevents accidental double-runs for the same cycle.
CREATE TABLE reconciliation_runs (
  id                   UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id           UUID          NOT NULL REFERENCES companies(id),
  billing_cycle        TEXT          NOT NULL,              -- '2026-06'
  run_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  total_employees      INTEGER       NOT NULL DEFAULT 0,
  total_transactions   INTEGER       NOT NULL DEFAULT 0,
  total_amount         NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  total_fees           NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  total_deduction      NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  export_filename      TEXT,                               -- CSV filename generated
  export_checksum      TEXT,                               -- SHA256 of CSV content
  status               sync_status   NOT NULL DEFAULT 'SUCCESS',
  error_log            JSONB,                              -- any row-level errors
  run_by               TEXT,                              -- system or admin user
  UNIQUE (company_id, billing_cycle)                      -- one run per cycle per company
);

CREATE INDEX idx_recon_company_cycle ON reconciliation_runs(company_id, billing_cycle);

-- ════════════════════════════════════════════════════════════
-- TABLE 6: sync_logs  (Data pipeline audit trail)
-- ════════════════════════════════════════════════════════════
-- Every daily worker run is logged here for observability.
-- quarantine_payload stores bad rows for admin review.
CREATE TABLE sync_logs (
  id                  UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          UUID          NOT NULL REFERENCES companies(id),
  batch_id            UUID          NOT NULL DEFAULT gen_random_uuid(),
  source_system       TEXT          NOT NULL,              -- 'SAGE','PAYSPACE','SFTP'
  records_received    INTEGER       NOT NULL DEFAULT 0,
  records_processed   INTEGER       NOT NULL DEFAULT 0,
  records_failed      INTEGER       NOT NULL DEFAULT 0,
  status              sync_status   NOT NULL,
  quarantine_payload  JSONB,                              -- bad rows stored here
  error_message       TEXT,
  started_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_sync_logs_company ON sync_logs(company_id, started_at DESC);
CREATE INDEX idx_sync_logs_batch   ON sync_logs(batch_id);

-- ════════════════════════════════════════════════════════════
-- TRIGGERS: auto-update updated_at timestamps
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_employees_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════════════════════════
-- VIEWS: Common reporting queries pre-built
-- ════════════════════════════════════════════════════════════

-- Employee balance summary (used by API on every dashboard load)
CREATE OR REPLACE VIEW v_employee_balances AS
SELECT
  e.id                          AS employee_id,
  e.company_id,
  e.external_payroll_ref,
  e.first_name || ' ' || e.last_name AS full_name,
  e.base_net_monthly_salary,
  e.current_accrued_earnings,
  e.total_withdrawn_this_month,
  c.withdrawal_cap_pct,
  c.transaction_fee,
  -- Max withdrawable = (accrued * cap) - already withdrawn, min 0
  GREATEST(
    ROUND(e.current_accrued_earnings * c.withdrawal_cap_pct, 2)
    - e.total_withdrawn_this_month,
    0.00
  )                             AS available_balance,
  e.current_cycle_start,
  e.status                      AS employee_status,
  c.status                      AS company_status
FROM employees e
JOIN companies c ON c.id = e.company_id;

-- Month-end reconciliation view
CREATE OR REPLACE VIEW v_reconciliation_summary AS
SELECT
  t.company_id,
  t.billing_cycle,
  t.employee_id,
  e.external_payroll_ref,
  e.first_name || ' ' || e.last_name AS full_name,
  COUNT(t.id)                   AS transaction_count,
  SUM(t.amount_requested)       AS total_withdrawn,
  SUM(t.transaction_fee)        AS total_fees,
  SUM(t.total_payroll_deduction) AS total_deduction
FROM transactions t
JOIN employees e ON e.id = t.employee_id
WHERE t.status = 'DISBURSED'
GROUP BY t.company_id, t.billing_cycle, t.employee_id,
         e.external_payroll_ref, e.first_name, e.last_name;

SELECT 'Rem0Beg Pay schema created successfully ✓' AS result;
