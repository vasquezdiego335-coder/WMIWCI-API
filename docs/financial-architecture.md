# Financial Architecture — We Move It. We Clear It.

**Decided 2026-07-13 (admin OS increment 2). This document is the single source
of truth for how money is defined in the admin. Code that computes money must
match these definitions or cite this file when it deliberately differs.**

---

## The one rule everything hangs on

> **Every dollar connects to a JOB, an OWNER transaction, or a GENERAL business
> expense.** (Owner spec, increment 1.)

---

## DECISION: crew labor single source of truth = JobCrew payroll (Option A)

**Crew labor cost comes from `JobCrew` payroll records** (hours × rate, or flat
pay, plus tips/bonuses, minus deductions — `crewPayOwedCents` in
`src/lib/profit.ts`). It does **not** come from `WORKER_PAY` expense rows.

Why Option A won:

- Labor needs per-job + per-worker detail (hours, rates, tips, approval status,
  payment status) that an expense row cannot carry.
- Job margin analysis, payroll reporting, and per-worker economics all need the
  same granular record — one table serves all three.
- The `WORKER_PAY` expense category stays, but **only for labor paid to someone
  who is not in the crew system** (a day helper). It is a legitimate job cost
  in that case and only that case.

### The double-count guardrails (live today)

1. **Detection:** the Action Center rule `worker-pay-double-count`
   (`hasLaborDoubleCountRisk` in `src/lib/reminder-rules.ts`, unit-tested) fires
   a HIGH data-quality reminder whenever a job has BOTH crew payroll data AND a
   non-rejected `WORKER_PAY` expense.
2. **Prevention at entry:** the expense form shows an explicit warning when the
   `WORKER_PAY` category is selected on a job.
3. **No silent exclusion:** `computeJobProfit` deliberately does NOT drop
   `WORKER_PAY` expenses from job costs, because a crew + a non-crew helper on
   the same job is legal. Flag-and-review beats silently changing totals.

### Legacy `WORKER_PAY` audit (Part 5 of the owner spec)

Read-only production audit run 2026-07-13 against Neon:

| Check | Count |
| --- | ---: |
| `WORKER_PAY` expense rows | **0** |
| `WORKER_PAY` rows linked to jobs | **0** |
| Total expense rows | **0** |
| `JobCrew` rows with any pay data | **0** |

The expenses system shipped earlier the same day and holds no data yet, so
**there is no legacy to reconcile** — the rule starts clean. No historical
financial totals were modified (there were none to modify).

---

## Accrued labor vs. payroll cash settlement (two different events)

| Concept | Meaning | Source | Feeds |
| --- | --- | --- | --- |
| **Labor cost (accrued payroll)** | Labor *earned* for completed work | `JobCrew` records | Job profit, P&L, labor reports, worker economics |
| **Payroll payment (cash settlement)** | Money actually *paid* to the worker | Future payroll-payment record (roadmap: `payroll-payment-records`) | Cash ledger, cash available, payment history |

**The invariant:** a worker earns $150 on a job → the P&L recognizes $150 of
labor **once**. When the $150 is later paid, cash goes down — but **no second
$150 operating expense is ever created.** Marking a `JobCrew` row `PAID` today
changes `payStatus` only; it does not write an expense. Any future payroll
payment record must keep it that way.

---

## Financial definitions

### Job profit (implemented — `src/lib/profit.ts` + `src/lib/job-money.ts`)

```
  Revenue collected on the job (COMPLETED, non-test payments)
− Accrued crew labor            (JobCrew via crewPayOwedCents)
− Direct job expenses           (Expense rows with bookingId)
− Payment-processing fees       (estimated 2.9% + 30¢ on Stripe-collected money only)
− Refunds on the job
= Net job profit
```

Manual cash payments carry **no** processor fee (`isStripePayment` gate).
Internal-test payments are never revenue anywhere.

### Operating P&L (defined here; report is roadmap item `reports-pnl`)

```
  Recognized operating revenue   (captured, non-test customer payments)
− Accrued payroll labor          (JobCrew)
− Approved operating expenses    (Expense rows, REJECTED excluded)
− Payment-processing fees
− Refunds and credits
= Operating profit
```

**Never in the P&L:** owner contributions (not revenue), owner withdrawals and
distributions (not operating expenses), loan proceeds (not revenue). These
guards exist as code: `operatingRevenueCents` / `operatingExpenseCents` in
`src/lib/owner-ledger.ts`, unit-tested.

### Cash available (estimate — implemented on the Owner Money page)

```
  Owner contributions
+ Verified cash inflows (captured payments)
− Business expenses
− Owner withdrawals + distributions
− Reimbursements paid to owners
= Estimated business cash
```

- A `PERSONAL_PURCHASE` does **not** touch business cash until the
  `REIMBURSEMENT` pays the owner back (the reimbursement is the cash event).
- Always **labeled an estimate** — there is no bank reconciliation yet. The
  emergency-reserve setting is the pressure valve for reconciling to reality.
- Safe-to-distribute subtracts unpaid worker pay + tax reserve + emergency
  reserve first (`safeToDistributeCents`), so the ownership split is never
  applied to money that is already spoken for.

---

## Dependency-aware roadmap (Part 7 of the owner spec)

**Must be decided first** *(all decided in this increment)*
- ✅ Crew labor single source of truth → **JobCrew** (above)
- ✅ Accrued labor vs. paid payroll distinction (above)
- ✅ `WORKER_PAY` legacy handling → zero legacy; guardrails live
- ✅ Revenue recognition → captured, non-test payments only (`isRealPayment`)
- ✅ Cash ledger definition → the estimate formula above, labeled as estimate

**Depends on the financial foundation:** accurate P&L → net-profit headline →
cash-available card → tax/emergency reserve forecasts → per-worker economics →
AI financial criticism. **This is why the dashboard still has no net-profit
card** — it unblocks when `reports-pnl` ships and its numbers are verified.

**Depends on payroll:** worker payment history, pay approval, bulk pay, payroll
receipts, accurate labor reporting.

**Depends on leads:** conversion rate, marketing ROI, cost per booked customer,
source performance, follow-up automation.

**Depends on scheduling:** crew utilization, conflict detection, travel-time
warnings, job readiness, late-check-in alerts.

### Recommended implementation order (after this increment)

1. **Calendar & Scheduling foundation** — highest operational priority; affects
   every job day.
2. **Financial foundation / Reports** — the P&L report on the definitions above
   (the *architecture* is already decided here; this is the report build).
3. **Payroll UI** — crew pay editing + approval workflow on the verified rules.
4. **Leads & Marketing** — pipeline UI + attribution (schema is ready).
5. **Customer Balances & Payments** — aging, failed payments, reconciliation.
6. **Documents & Settings.**

Among Reports / Payroll / Leads alone: **Reports-architecture first** — and that
is exactly what this document just locked. Charts come after accounting
definitions, never before.

---

## Future AI CEO ("The Foreman") — documented only

Roadmap item `ai-ceo-the-foreman` (category AI, status IDEA). **Not built; no
API keys, no model calls, no fake responses.** Architecture when its data
dependencies are reliable: application code computes facts → deterministic
rules detect problems (the Action Center engine, already live) → an affordable
LLM *interprets* verified numbers into briefings → delivery via the existing
Discord bot + admin page on a scheduled Railway job. **Read-only first release;
every insight cites evidence; sensitive actions always require Diego or
Sebastian; everything audited.**
