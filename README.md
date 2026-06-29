# 💸 Rem0Beg Pay — Earned Wage Access Platform

> *Access what you've already earned. Before payday.*

**Built by Tshepiso Freddy Thosago | Rem0Beg Solutions**

[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript)](https://typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql)](https://postgresql.org)
[![Netlify](https://img.shields.io/badge/Live-Netlify-00C7B7?style=for-the-badge&logo=netlify)](https://rem0beg-pay.netlify.app)

---

## 🌐 Live Demo

**👉 [https://rem0beg-pay.netlify.app](https://rem0beg-pay.netlify.app)**

---

## 💡 What Problem Does This Solve?

**60% of South African workers** run out of money before payday and resort to:
- Loan sharks charging 30–50% interest
- Payday lenders (classified as credit under the NCA)
- Friends and family borrowing cycles

Rem0Beg Pay lets employees access **wages they've already earned** — not a loan. The money is already theirs. We just release it early.

**Business model:** Flat **R15 transaction fee** per withdrawal (not interest — this keeps us outside the National Credit Act).

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│  React + Tailwind CSS Frontend (Mobile-first PWA)        │
│  Withdrawal slider · Transaction history · Profile       │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  EWA Core Service (TypeScript)                           │
│  - calculateAvailableBalance()                           │
│  - processWithdrawal() — atomic, decimal-safe            │
│  - Daily sync worker (payroll data ingestion)            │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  PostgreSQL Database                                     │
│  Multi-tenant · POPIA compliant · Atomic transactions   │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  Payroll Integration Layer                               │
│  Sage 300 People · PaySpace · Pastel Payroll             │
│  (OAuth2 + SFTP connectors)                             │
└─────────────────────────────────────────────────────────┘
```

---

## 🗄️ Database Schema

```sql
-- Multi-tenant: every table scoped by company_id
companies    (id, name, payroll_system, pay_cycle, tenant_key)
employees    (id, company_id, name, salary, bank_account_hash)
daily_earnings    (id, employee_id, date, gross_earned, net_earned)
transactions      (id, employee_id, amount, fee, status, created_at)
reconciliation    (id, company_id, period, total_advanced, total_fees)
```

**Key constraints:**
- `withdrawal <= 25% of net_earned_this_period` — NCA compliance
- `fee = NUMERIC(10,2)` — never a float, always exact decimal
- `company_id` on every table — zero cross-tenant data leakage (POPIA)

---

## 💰 The Withdrawal Calculation (Core Business Logic)

```typescript
// ewaService.ts — simplified
async function calculateAvailableBalance(employeeId: string) {
  const earned = await getDailyEarnings(employeeId);      // from payroll sync
  const withdrawn = await getTotalWithdrawnThisPeriod(employeeId);

  const maxAllowed = earned * 0.25;         // 25% cap (NCA compliance)
  const available = maxAllowed - withdrawn; // subtract what's already taken
  const fee = new Decimal(15.00);           // flat R15 — never floating point

  return { available, fee, net: available.minus(fee) };
}
```

Why `Decimal` and not JavaScript's `number`?
> `0.1 + 0.2 === 0.30000000000000004` in JavaScript. For financial calculations, floating-point errors can cost real money. The `decimal.js` library uses string-based arithmetic — always exact. This is non-negotiable in fintech.

---

## 🔄 Payroll Integration Layer

```
Sage 300 People  →  OAuth2 token → GET /employees, /payslips
PaySpace         →  API key      → GET /employees/earnings
Pastel Payroll   →  SFTP         → Parse CSV export → ingest
```

The daily sync worker (`dailySyncWorker.ts`) runs on a schedule:
1. Authenticates with the employer's payroll system
2. Fetches today's earnings for all employees
3. Upserts `daily_earnings` records
4. Quarantines corrupted records (instead of failing the whole batch)

---

## 🏦 Month-End Reconciliation

At month end, `monthEndReconciliation.ts`:
1. Sums all withdrawals per employee
2. Deducts total from the employer's next payroll run
3. Generates a reconciliation report per company
4. Marks the period as `RECONCILED`

The employer never touches individual employee bank accounts — Rem0Beg Pay handles the float and recovers it in bulk at payroll time.

---

## ⚙️ Local Setup

```bash
git clone https://github.com/tshepisofrominnostation/rem0beg-pay.git
cd rem0beg-pay

# Open the live frontend
# (Full backend requires PostgreSQL + payroll API credentials)
open frontend/index.html
```

---

## 💡 Interview Q&A

**"Why is this not a loan under the National Credit Act?"**
> The NCA regulates credit — money you borrow and pay back with interest. Rem0Beg Pay only releases wages the employee has already earned. There is no principal, no interest, no credit agreement. The flat R15 fee is a service fee, not interest. The legal distinction is that the money already belongs to the employee — we're just releasing it early on behalf of their employer.

**"Why a flat R15 fee instead of a percentage?"**
> Two reasons. First, it's simpler to explain to employees — no confusion about rates. Second, a percentage fee on small withdrawals could technically be classified as interest under the NCA. A flat transaction fee is clearly a service charge.

**"How do you prevent an employee from withdrawing more than 25%?"**
> In `processWithdrawal()`, I calculate the available balance inside a database transaction. The check and the deduction happen atomically. If two requests come in simultaneously for the same employee, the database's transaction isolation ensures only one goes through — the second will see the updated balance and be rejected. This is called "optimistic locking via atomic transactions."

**"Why decimal.js instead of JavaScript numbers for money?"**
> JavaScript uses IEEE 754 floating-point for all numbers. `0.1 + 0.2` gives `0.30000000000000004`. Over thousands of transactions, these rounding errors accumulate into real money. `decimal.js` uses arbitrary-precision decimal arithmetic — every calculation is exact. In fintech, this is not optional.

**"How does multi-tenancy protect POPIA compliance?"**
> POPIA requires that personal financial data is only accessible to the data subject and authorised processors. Every database table has a `company_id` foreign key. Every query includes `WHERE company_id = req.user.companyId` — derived from their JWT. A user at Company A literally cannot construct a query that returns Company B's employee data, even if they tried.

**"What happens if the payroll sync fails halfway through?"**
> The sync worker processes employees in batches. Each batch runs in a database transaction — if any record fails, only that batch rolls back. Failed records go into a quarantine table with the error reason. The next sync picks up from where it left off. The system never fails silently — every error is logged with employee ID and timestamp.

**"What is B2B2C?"**
> Business-to-Business-to-Consumer. Rem0Beg Pay sells to employers (B2B) who then offer it to their employees (the consumers). We never sign up individual employees directly — the employer integrates us into their payroll system and we become a benefit they offer to staff. This makes customer acquisition cheaper because one employer contract gives us access to hundreds of employees.

---

## 📊 Market Opportunity

| Metric | Value |
|---|---|
| SA formal sector employees | ~10 million |
| Average salary (median) | R22,000/month |
| Target EWA penetration | 2 withdrawals/employee/month |
| Revenue per withdrawal | R15 |
| **Addressable revenue (1% market share)** | **R30 million/month** |

---

## 🗺️ Roadmap

- [x] Core EWA calculation engine (TypeScript)
- [x] PostgreSQL schema with POPIA compliance
- [x] Payroll integration layer (Sage, PaySpace, Pastel)
- [x] Month-end reconciliation worker
- [x] Mobile-first React dashboard
- [ ] Live banking API integration (Stitch / PayShap)
- [ ] FSCA regulatory approval
- [ ] Employer self-service portal
- [ ] WhatsApp withdrawal notifications

---

## 👤 About

**Developer:** Tshepiso Freddy Thosago | Rem0Beg Solutions
**GitHub:** [github.com/tshepisofrominnostation](https://github.com/tshepisofrominnostation)
