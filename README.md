# 💸 Rem0Beg Pay

> **Earned Wage Access (EWA) Platform for the South African Corporate Market**
> *"Access what you've already earned — on demand, not on payday."*

[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![Stack](https://img.shields.io/badge/stack-TypeScript%20%7C%20PostgreSQL%20%7C%20React-0f172a?style=for-the-badge)](/)
[![Status](https://img.shields.io/badge/status-Phase%201%20MVP-emerald?style=for-the-badge)](/)
[![Compliance](https://img.shields.io/badge/compliance-POPIA%20%7C%20BCEA-green?style=for-the-badge)](/)

---

## 🎯 What is Rem0Beg Pay?

Rem0Beg Pay is a **B2B SaaS fintech platform** that enables South African employees to instantly access a portion (capped at 25%) of their **already-earned wages** before the traditional end-of-month payday.

This is **not a loan**. It is an on-demand salary utility:
- ✅ No interest charges — only a flat R15 transaction fee
- ✅ Operates strictly on an accrual basis (wages already earned)
- ✅ Avoids NCA (National Credit Act) categorisation as a credit provider
- ✅ Month-end payroll deduction handles recovery automatically

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Rem0Beg Pay Platform                    │
├─────────────┬──────────────────┬───────────────┬────────────┤
│  React PWA  │  Express/FastAPI │  PostgreSQL   │ Cron Jobs  │
│  Dashboard  │  Service Layer   │  (Supabase)   │  Workers   │
├─────────────┴──────────────────┴───────────────┴────────────┤
│              Payroll APIs (Sage / PaySpace / SFTP)           │
└─────────────────────────────────────────────────────────────┘
```

---

## ✨ Core Features (Phase 1)

| Module | Description |
|---|---|
| 🏢 **Multi-Tenant Engine** | Schema-level isolation per corporate employer |
| 📊 **Balance Calculator** | Real-time accrued earnings × withdrawal cap |
| ⚡ **Atomic Withdrawals** | Race-condition-safe using `SELECT FOR UPDATE` |
| 📅 **Daily Sync Worker** | Cron-driven payroll data ingestion with quarantine |
| 💰 **Month-End Reconciliation** | Auto-generates CSV for Sage/PaySpace import |
| 📱 **Mobile Dashboard** | React + Tailwind — slider-driven withdrawal UX |
| 🔒 **POPIA Compliant** | Encrypted bank details, RLS on all tables |
| 🧮 **Zero Rounding Errors** | All math via `decimal.js` — never native floats |

---

## 📁 Project Structure

```
rem0beg-pay/
├── database/
│   └── schema.sql                    # Full PostgreSQL DDL (6 tables + views + triggers)
├── backend/
│   ├── services/
│   │   └── ewaService.ts             # Core EWA business logic (TypeScript)
│   └── workers/
│       └── dailySyncWorker.ts        # Daily payroll sync cron worker
├── frontend/
│   └── src/components/
│       └── EmployeeDashboard.tsx     # React mobile dashboard component
├── reconciliation/
│   └── monthEndReconciliation.ts     # Month-end CSV export + SETTLED marking
└── README.md
```

---

## 🗄️ Database Schema

6 core tables with strict financial constraints:

| Table | Purpose |
|---|---|
| `companies` | Multi-tenant root — stores withdrawal caps, payroll API config |
| `employees` | Linked to company — stores accrued earnings, bank details (encrypted) |
| `daily_earnings_ledger` | Immutable daily shift records — source of truth for balances |
| `transactions` | Append-only withdrawal ledger — PENDING → APPROVED → DISBURSED → SETTLED |
| `reconciliation_runs` | Audit trail of month-end export runs (idempotency guard) |
| `sync_logs` | Observability log for every daily worker run |

**Key design decisions:**
- `NUMERIC(15,2)` for all monetary fields — **never FLOAT**
- `SELECT FOR UPDATE` on withdrawal to prevent race conditions
- UNIQUE `(company_id, billing_cycle)` on reconciliation — prevents double-deduction
- All timestamps `TIMESTAMPTZ` — timezone-aware for multi-province payroll

---

## ⚙️ Core Service: `EWAService`

### `calculateAvailableBalance(employeeId)`
```
available = MAX(
  (current_accrued_earnings × withdrawal_cap_pct) − total_withdrawn_this_month,
  0.00
)
```

### `requestWithdrawal(employeeId, amount)`
1. Lock employee row (`SELECT FOR UPDATE`) — blocks concurrent requests
2. Re-calculate available balance from locked state
3. Validate `requested ≤ available`
4. Insert `PENDING` transaction record
5. Increment `total_withdrawn_this_month`
6. Commit atomically

---

## 💰 Financial Safety Rules

```typescript
// ❌ NEVER do this in fintech
const total = 0.1 + 0.2; // = 0.30000000000000004

// ✅ ALWAYS use Decimal.js
import Decimal from 'decimal.js';
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });
const total = new Decimal('0.1').plus('0.2'); // = '0.3' exactly
```

This rule is enforced **throughout the entire codebase** — in the service layer, the sync worker, and the reconciliation module.

---

## 📅 Billing Lifecycle

```
Day 1:    Monthly cycle starts. employee.total_withdrawn_this_month = 0
Days 1-22: Daily sync worker updates accrued_earnings from payroll API
           Employees can request withdrawals throughout the month
Day 23:   Month-end reconciliation runs at 23:00 SAST
          → CSV generated for Sage/PaySpace import
          → Transactions marked SETTLED
          → employee.total_withdrawn_this_month reset to 0
Payday:   Corporate payroll deducts EWA amounts from salaries
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL 15+ (or Supabase)
- `decimal.js` (`npm install decimal.js`)
- `pg` PostgreSQL client (`npm install pg`)

### 1. Database Setup
```bash
psql -U postgres -d your_db -f database/schema.sql
```

### 2. Environment Variables
```env
DATABASE_URL=postgresql://user:password@localhost:5432/rem0beg_pay
ENCRYPTION_KEY=your-32-byte-aes-key-here
NODE_ENV=production
```

### 3. Run the sync worker manually
```bash
DATABASE_URL=... ts-node backend/workers/dailySyncWorker.ts
```

### 4. Run reconciliation for a company
```typescript
import { MonthEndReconciliationService } from './reconciliation/monthEndReconciliation';
const recon = new MonthEndReconciliationService(pool, './exports');
await recon.runForCompany('company-uuid', '2026-06');
```

---

## 🗓️ Development Roadmap

| Phase | Timeline | Deliverables |
|---|---|---|
| **Phase 1** (current) | Weeks 1–10 | Schema, service layer, sync worker, React dashboard, reconciliation |
| **Phase 2** | Weeks 11–16 | Live Capitec Pay / Standard Bank API integration |
| **Phase 3** | Weeks 17–20 | WhatsApp self-service interface (USSD fallback) |
| **Phase 4** | Weeks 21–24 | Savings module, micro-investment tools |

---

## 📋 Regulatory Compliance

| Framework | Status | Notes |
|---|---|---|
| **POPIA** | ✅ | Bank details AES-256 encrypted, RLS on all tables |
| **BCEA** | ✅ | Operates on accrual basis — wages already earned |
| **NCA** | ✅ | Not a credit product — flat fee, no interest |
| **SARB** | 🔄 | Phase 2 banking rail integration will require EMI review |

---

## 👤 About

**Project Sponsor & Lead Developer:** Tshepiso Freddy Thosago
**Document Version:** 1.0
**Authorized:** June 2026

---

*Built for the South African fintech landscape · POPIA Compliant · BCEA Aligned*
