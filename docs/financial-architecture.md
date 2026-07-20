# Financial Architecture — We Move It. We Clear It.

**Decided 2026-07-13 (admin OS increment 2). This document is the single source
of truth for how money is defined in the admin. Code that computes money must
match these definitions or cite this file when it deliberately differs.**

---

## The one rule everything hangs on

> **Every dollar connects to a JOB, an OWNER transaction, or a GENERAL business
> expense.** (Owner spec, increment 1.)

---

> ## STAGE 3 UPDATE (2026-07-20) — company reporting on top of snapshots
>
> See `docs/admin/stage3-reporting-analytics.md`.
>
> - Reports read the immutable `FinancialSnapshot` for finalized moves and
>   **never recalculate them** from current settings. Provisional moves use live
>   Stage 2 math and are always labelled.
> - Every report declares a BASIS (cash vs accrual) and a SCOPE (finalized vs
>   provisional vs combined); a mixed total carries an explicit warning.
> - Reporting boundaries are business-local (America/New_York) over UTC storage,
>   DST-safe, with an exclusive end.
> - Marketing is judged by `Profit ROAS = attributed FINALIZED net profit /
>   spend`, never by scans, leads or gross revenue.
> - First-touch attribution is IMMUTABLE; corrections go to an owner-assigned
>   source and are audited.
> - Exports neutralize spreadsheet formulas losslessly, allow-list columns by
>   role, and never log their own contents.

> ## PHASE 2 UPDATE (2026-07-20) — financial closeout + durable snapshots
>
> See `docs/admin/phase2-financial-closeout.md`. The hierarchy is now complete
> and centralized in `src/lib/closeout-calc.ts`:
>
> ```
> net collected − direct job costs        = CASH GROSS PROFIT
>   − unpaid owner labor value            = ECONOMIC PROFIT
> cash gross profit − allocated overhead  = COMPANY NET PROFIT
>   − unpaid owner labor value            = ECONOMIC NET PROFIT
> company net profit − tax reserve − business reserves
>   − retained earnings − unresolved liabilities = DISTRIBUTABLE PROFIT
> ```
>
> - **Profit comes only from COLLECTED money.** An outstanding balance is a
>   receivable and can never reach an owner distribution.
> - Finalizing writes an **immutable `FinancialSnapshot`**. Changing a rate, an
>   ownership split, a reserve percentage or an overhead policy can no longer
>   rewrite a move that was already closed. Reopening supersedes, never deletes.
> - Blockers are HARD (wrong data — never overridable) or OVERRIDABLE (a
>   judgement call an owner documents with a reason).
> - Reimbursement / draw / distribution / labor pay remain four distinct things.
> - Tax reserve is a % of company net profit, floored at $0 on a loss. Reserves
>   are PLANNED allocations, not bank transfers.

> ## PHASE 1 UPDATE (2026-07-20) — JobCrew now has a real write path
>
> The decision below is UNCHANGED and now enforced by working code. See
> `docs/admin/phase1-jobcrew-implementation.md`.
>
> - Labor is recorded on `JobCrew` with **integer minutes** and a **frozen rate
>   snapshot** — a later profile-rate change can no longer rewrite a past move.
> - **Only APPROVED labor is a cost.** DRAFT/SUBMITTED labor is displayed and
>   warned about but never counted.
> - **Owner labor is never free**: `UNPAID_OWNER` costs $0 cash and carries an
>   economic value, giving every move a CASH gross profit and an ECONOMIC profit.
> - `labor_payments` supports partial payments; `paymentStatus` is derived from
>   the non-voided rows and **never writes an `Expense`**.
> - The Discord `crew_jobs` gig board is NOT a competing labor total — it has no
>   booking, no Job and no app User. See `docs/admin/discord-crew-integration.md`.

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

**CORRECTED IN PHASE 0 (2026-07-20).** Refunds net off REVENUE; they are not a
cost line. See `docs/admin/phase0-financial-integrity.md`.

```
  Net collected revenue          (captured − actual refunds − lost chargebacks)
− Accrued crew labor             (JobCrew via crewPayOwedCents)
− Eligible direct job expenses   (Expense rows with bookingId, REJECTED excluded)
− Payment-processing fees        (estimated 2.9% + 30¢ on Stripe-CAPTURED money only)
= Gross job profit
```

It is **gross** profit: company overhead is not yet allocated per move (Phase 3).

Manual cash payments carry **no** processor fee (`isStripePayment` gate).
Internal-test payments are never revenue anywhere. Authorized-but-uncaptured
holds (`PENDING`) are never revenue and are reported separately.

**Every revenue and expense figure in the admin derives from
`src/lib/money-rules.ts`.** Pages must not write their own `status:` filters —
that divergence is precisely what produced the Phase 0 defects.

Job profit is always paired with `FinancialCompleteness`
(`src/lib/financial-completeness.ts`). A crew pay of $0 means "not recorded"
far more often than it means "free", and no surface may present a profit figure
without saying which.

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

**CORRECTED IN PHASE 0:** paid crew labor now leaves the estimate. It previously
did not, and because safe-to-distribute held back only *unpaid* labor, settling a
worker RAISED the distributable figure by the amount just paid out.

```
  Owner contributions
+ Net collected revenue (captured − refunds − lost chargebacks)
− Eligible business expenses (REJECTED excluded)
− Crew labor already PAID
− Owner withdrawals + distributions
− Reimbursements paid to owners
= Estimated business cash
```

```
  Estimated business cash
− Unpaid (accrued) crew labor
− Known upcoming bills
− Owner reimbursements owed
− Captured money at risk in an OPEN dispute
− Tax reserve (% of OPERATING PROFIT: revenue − expenses − labor, floored at 0)
− Emergency reserve
= Estimated safe to distribute   (may be NEGATIVE — reported as a shortfall)
```

Labor cannot be subtracted twice: a `JobCrew` row is either `PAID` (out of cash)
or not (held back), never both.

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

---

## Increment 2.1 — enforcement hardening

The increment-2 decisions above are unchanged. 2.1 turns the WORKER_PAY *hint*
into server enforcement and adds finalized-record integrity.

### WORKER_PAY is enforced server-side (not just a hint)
`src/lib/worker-pay-guard.ts#evaluateWorkerPayExpense` (pure, tested) runs inside
`POST /api/admin/expenses` on every create — a forged or scripted request cannot
bypass it:
- Non-`WORKER_PAY`, or `WORKER_PAY` on a job with **no** crew payroll (a real
  non-crew helper) → allowed.
- `WORKER_PAY` on a job that **already has crew payroll** → **blocked (422)** as
  duplicate labor, unless an **OWNER** overrides with a **reason** (audited
  `WORKER_PAY_OVERRIDE`). A MANAGER override is 403.

The expense form also blocks submit + explains the rule, and the Action Center
`worker-pay-double-count` reminder still flags any that predate enforcement.

### Payroll settlement never touches profit (tested)
Marking a `JobCrew` row `PAY_APPROVED → PAID` changes only cash-settlement state
(status, paid date, method, reference). `computeJobProfit` does not read pay
status, so job profit and the P&L are identical before and after payment —
proven in `owner-ledger.test.ts` ("marking PAID must not create a second
expense"). Labor is recognized once, when accrued.

### Finalized financial records preserve history
`src/lib/financial-adjust.ts` defines when a record is finalized. Today the only
finalized financial record with an edit path is the **expense** (APPROVED /
REIMBURSED). Changing its **amount or category** after finalization is an
**owner-only adjustment** that **requires a reason** and writes a
`FINANCIAL_ADJUSTMENT` audit row carrying **before → after** — never a silent
overwrite. A no-op edit (same value) does not trigger the workflow. Crew-pay and
payment edit UIs don't exist yet; their adjustment workflow lands here when they
ship (roadmap: `payroll-editing-ui`, `payroll-payment-records`).

### Refunds — SUPERSEDED BY PHASE 0 (2026-07-20)

> **The behavior previously documented here was arithmetically wrong.** It read:
> *"`computeJobProfit` counts REFUNDED and PARTIALLY_REFUNDED payments as a cost
> and excludes them from collected revenue."* Doing both subtracts the refund
> twice — a refunded payment is already absent from revenue because its status is
> no longer `COMPLETED`. A $2,000 payment with a $200 refund reported −$2,000
> instead of +$1,800. This paragraph is kept, struck, as the record of a
> documented-but-incorrect rule; do not restore it.

**Current behavior.** Refunds net off revenue using the real
`Payment.refundedAmountCents`, and never appear as a cost. `REFUNDED` /
`PARTIALLY_REFUNDED` payments remain CAPTURED money whose net collected value is
`amount − refunded − chargeback`, floored at zero. Full rules, including how an
unknown partial-refund amount is flagged rather than guessed, are in
`docs/admin/phase0-financial-integrity.md`.

There is still **no refund-initiation flow** in the admin — refunds are recorded
from Stripe webhooks, not issued from these pages. A full refund/authorization
workflow (deposit refund, auth release, cash refund) is a roadmap item
(`customers-balance-tracking`); it is **not** faked here.

### Stripe states — what the app does and does not know
The app knows a payment is captured revenue when it is `COMPLETED` and not an
internal test (`isRealPayment`). It does **not** import Stripe payout/balance
data, so "cash available" is an **estimate from the recorded ledger** (labeled as
such on the Owner Money page), never a claim of the real bank or Stripe balance.
Authorized-but-uncaptured holds are **not** counted as collected. Stripe payout
reconciliation is a roadmap item.

### Guardrail tests
`owner-ledger.test.ts` + `worker-pay-guard.test.ts` + `financial-adjust.test.ts`
assert: labor counted once, PAID creates no second expense, WORKER_PAY duplicate
blocked, manager override forbidden, owner override needs a reason, contributions
excluded from revenue, withdrawals excluded from expenses, rejected owner txns
ignored, finalized-edit predicates.
