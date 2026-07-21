# Phase 0 — Financial Integrity

**Owner spec 2026-07-20. Branch `claude/admin-phase0-financial-integrity`.**
**Scope: stop the admin from displaying misleading money. Nothing else.**

Phase 0 fixes four confirmed defects found by `docs/admin/admin-pre-audit.md` and
makes incomplete financial records impossible to mistake for finished ones. It
does **not** build payroll, time tracking, closeout, reports, or owner
distribution — those are Phase 1 and later.

---

## The four defects and their corrections

### 1. Refunds were double-penalized

**Before.** `computeJobProfit` recognized revenue as payments with
`status === 'COMPLETED'`, then added the **full `amount`** of every `REFUNDED` /
`PARTIALLY_REFUNDED` payment to costs. A refunded payment's status is no longer
`COMPLETED`, so it had already been removed from revenue — the refund was
subtracted a second time. The same construction appeared on the Revenue page as
`SUM(COMPLETED) − SUM(REFUNDED)`.

| Scenario | Before | Correct |
| --- | ---: | ---: |
| $2,000 captured, fully refunded | −$2,000 | $0 |
| $2,000 captured, $200 refunded | −$2,000 | +$1,800 |

The partial case was the worst: `PARTIALLY_REFUNDED` appeared in neither
aggregate on the Revenue page, so a partially refunded $2,000 payment showed as
**$0 revenue** while its full $2,000 was charged as a job cost.

**After.** Refunds net off **revenue** and are never a cost line.
`Payment.refundedAmountCents` — the real cumulative refunded amount, maintained
monotonically by `payment-events.refundPatch` — is now the input. One derivation
in `src/lib/money-rules.ts` serves every surface:

```
per payment:  net collected = captured − refunded − chargeback   (floor 0)
per job:      gross profit  = net collected revenue
                            − crew pay
                            − eligible job expenses
                            − Stripe processing fees
```

`totalCostsCents` no longer contains a refund term at all.

### Eligible payment statuses

| Status | Captured? | Counts as revenue |
| --- | --- | --- |
| `COMPLETED` | yes | net of any refund |
| `PARTIALLY_REFUNDED` | yes | net of the recorded refund |
| `REFUNDED` | yes | nets to $0 |
| `PENDING` | **no** | never — this is an authorized hold (the $49 deposit before owner approval). Reported separately as `authorizedNotCapturedCents`. |
| `FAILED` | no | never |
| any status with `isInternalTest` | — | never, anywhere |

### Refund treatment rules

- `refundedAmountCents` is authoritative when present, clamped to the capture.
- `REFUNDED` with a null amount infers a **full** refund (safe: the status says so).
- `PARTIALLY_REFUNDED` with a null amount is **UNKNOWN**. We do not guess a
  number. `refundedCentsOf` returns 0 and `hasUnknownRefundAmount` flags it, which
  raises a `missingPaymentData` blocker on the move and a warning on the Revenue
  page. Inventing a partial amount is exactly the class of behavior Phase 0 exists
  to eliminate.
- A **lost** dispute is computed as "whatever the refund left" (`amount − refunded`),
  so a refund and a chargeback on the same charge can never subtract past the
  capture. An **open** dispute deducts nothing but is reported as money at risk
  and held back from distributable cash.
- Stripe processing fees follow the **capture**, not the net — Stripe keeps its
  fee on a refunded charge. A fully refunded card job therefore ends at a real,
  honest negative equal to the fee.

### 2. Rejected expenses were counted inconsistently

**Before.** The dashboard's monthly expense aggregate had **no status filter**;
Owner Money used `status: { not: 'REJECTED' }`. Two pages, two totals, same rows.

**After.** One rule in `money-rules.ts`, used by every surface:

| Status | Counts | Why |
| --- | --- | --- |
| `APPROVED` | yes | reviewed real spend |
| `REIMBURSED` | yes | real spend, already settled with the payer |
| `SUBMITTED` | yes | the money left the business; review is a workflow state, not a truth state. Flagged `unreviewedExpenses`. |
| `NEEDS_REVIEW` | yes | same, flagged |
| `REJECTED` | **no** | "this is not a business expense" — counts in no job cost, no company expense, no cash figure, no distributable calculation |

Deleted expenses cannot be counted: `DELETE /api/admin/expenses/[id]` is a hard,
owner-only, audited removal. There is no soft-delete or void state.

Pages must use `ELIGIBLE_EXPENSE_WHERE` (Prisma) or `eligibleExpenseCents()`
(in-memory) rather than writing their own status filter. Rejected rows stay
**visible** in both expense lists — struck through, labelled "not counted".

### 3. Paid labor never left the cash estimate

**Before.**

```
estimateBusinessCash = contributions + revenue − expenses − ownerCashOut − reimbursements
safeToDistribute     = cash − unpaidWorkerPay − bills − taxReserve − emergencyReserve
```

Crew labor is deliberately not an `Expense` row (Option A, see
`financial-architecture.md`), and paid labor was subtracted **nowhere**.
Meanwhile only *unpaid* labor was held back. So marking a worker `PAID` removed
their pay from the reserve without ever removing it from cash — **"safe to
distribute" went UP by exactly the amount just paid out.**

**After.**

```
estimateBusinessCash = owner contributions
                     + net collected revenue          (refunds/chargebacks already off)
                     − eligible business expenses     (REJECTED excluded)
                     − paid crew labor                ← NEW
                     − owner withdrawals + distributions
                     − reimbursements paid to owners

distributablePosition = estimated business cash
                      − unpaid (accrued) crew labor
                      − known upcoming bills
                      − owner reimbursements owed     ← NEW
                      − captured money at risk in an open dispute   ← NEW
                      − tax reserve
                      − emergency reserve
```

**No double subtraction** is structural, not a convention: a `JobCrew` row is
either `payStatus === 'PAID'` (in `paidLaborCents`, out of cash) or not (in
`unpaidLaborCents`, held back). Never both. `profit.test.ts` pins this with a
regression test asserting the distributable figure is *identical* before and
after settlement.

**Tax reserve base corrected.** It was `(revenue − expenses) × pct` with labor
ignored, which overstated the hold-back. It is now a percentage of operating
profit (`revenue − expenses − labor`), floored at zero — a loss-making period
reserves nothing.

**Negative results are reported.** `distributablePosition` returns
`{ rawCents, distributableCents, shortfallCents, totalHeldBackCents }`. A
shortfall renders in red as "Shortfall — do not distribute" with the signed
amount. It is never silently clamped to a reassuring $0.00.

**Label corrected.** The card is now "Estimated Safe to Distribute" and states
in the body that it is an estimate from the recorded ledger for planning — not a
bank balance and not finalized distributable profit.

### 4. Missing labor was indistinguishable from zero labor

`JobCrew` has no write path anywhere in the application (verified: no
`prisma.jobCrew.create/update/upsert` exists). Crew pay therefore computes to $0
on every job, and a $0 labor cost rendered identically to a real one.

**After.** `src/lib/financial-completeness.ts` returns, alongside every profit
figure:

```ts
type FinancialCompleteness = {
  isComplete: boolean
  status: 'COMPLETE' | 'INCOMPLETE' | 'NOT_APPLICABLE'
  missingLabor: boolean
  missingExpenses: boolean
  missingPaymentData: boolean
  unreviewedExpenses: boolean
  laborConfirmedZero: boolean
  warnings: string[]   // owner-facing copy
  blockers: string[]   // the subset that blocks financial finalization
}
```

**Trigger conditions** (only on `IN_PROGRESS` / `COMPLETED` moves — a booking
that has not been worked is `NOT_APPLICABLE` and produces no warnings, so the
banner never becomes noise):

| Flag | Fires when | Blocks finalization |
| --- | --- | --- |
| `missingLabor` | no `JobCrew` rows, **or** rows exist with no hours/rate/flat pay ever entered | **yes** |
| `missingPaymentData` | a completed move with no captured payment, or a partial refund with no recorded amount | **yes** |
| `missingExpenses` | zero eligible job-linked expenses | no — a labor-only move on a customer truck can legitimately have none |
| `unreviewedExpenses` | eligible expenses are still `SUBMITTED`/`NEEDS_REVIEW` | no |
| `laborConfirmedZero` | every crew row explicitly states zero (`flatPay: 0` / `actualHours: 0`) | n/a — this is **complete** |

**`$0 confirmed` vs `unknown` is explicit.** The Profit card renders
`not recorded` for missing labor and `$0.00 (confirmed)` for a deliberate zero.
`null` is an absence of information; `0` is a statement. They are never conflated.

**Warning copy** (single source, `financial-completeness.ts`):

> Crew labor has not been recorded for this move. Profit may be overstated.

**Where it appears:**

| Surface | Treatment |
| --- | --- |
| Job detail — Profit card | Red `Callout` **above** the number, listing every warning; header badge; "Gross profit (incomplete)" in amber |
| Job detail — sticky header | `Complete` / `Missing labor` badge next to the status badges |
| Job detail — Crew & Payroll card | Red `Callout` stating labor is unknown, not zero (renders even when no `Job` row exists) |
| Jobs list | Amber banner counting affected moves + a per-card badge + `Gross profit *` |
| Dashboard | Amber banner: *"N of M worked moves have no crew labor recorded"*, stating profit and cash figures below are overstated and that revenue/expense totals are unaffected |
| Owner Money | Warning when no labor exists anywhere, since the cash estimate inherits the overstatement |
| Revenue page | Warning when any partial refund has an unrecorded amount |

**Profit is still shown.** It is marked incomplete, never hidden — the owner
needs the provisional number; they just must not mistake it for final.

### Finalization guard (rule shipped, workflow deferred)

There is no move-closeout model yet (Phase 2). Phase 0 ships the pure decision
`canFinalizeFinancials()` so the future closeout route cannot be written without
honoring it — the same pattern as `worker-pay-guard.ts`, which was written before
the payroll UI it protects.

- Blockers present → **422 blocked**.
- `override: true` + `role: 'OWNER'` + a non-empty `reason` → allowed, and the
  caller must write a `FINANCIAL_ADJUSTMENT` audit row.
- `role: 'MANAGER'` → **403**, always. Finalizing an incomplete money record is
  owner-financial authority.
- A move that was never worked cannot be finalized at all.

---

## What "incomplete financial record" means

A move whose `FinancialCompleteness.isComplete` is `false`. Its profit is
**provisional**: computed correctly from the data that exists, but known to be
missing inputs. It may be read for orientation. It must not be used to decide a
distribution, a price, or whether a job type is worth taking — and it cannot be
marked financially final without an audited owner override.

---

## Files

**New**
- `src/lib/money-rules.ts` — revenue recognition + expense eligibility + crew-labor signals
- `src/lib/financial-completeness.ts` — completeness evaluation + finalization guard
- `src/lib/__tests__/money-rules.test.ts`
- `src/lib/__tests__/financial-completeness.test.ts`
- `scripts/phase0-evidence.ts` — synthetic worked examples, no DB access

**Changed**
- `src/lib/profit.ts` — refunds off revenue; new `JobProfit` shape; `distributablePosition`; `taxReserveCentsFor`; labor split helpers
- `src/lib/job-money.ts` — blessed Prisma selects; `jobFinancialCompleteness()`
- `src/lib/owner-ledger.ts` — `paidLaborCents` in the cash estimate; `totalReimbursementOwed`; `operatingProfitCents`
- `src/lib/reminder-rules.ts` / `reminder-sync.ts` — `grossRevenueCents` → `netRevenueCents`
- Admin pages: dashboard, jobs list, job detail, payments, expenses, owner-money
- `app/(admin)/admin/(dashboard)/_ui.tsx` — `Callout`, `CompletenessBadge`

---

## Deferred to Phase 1 and later (deliberately NOT in this branch)

Worker clock-in/out · the `JobCrew` write interface · payroll · owner labor
valuation (cash vs true-economic view) · owner split calculator · profit
distribution workflow · full move closeout · CSV/XLSX export · mobile redesign ·
expense allocation engine (shared + overhead) · historical pricing calculator ·
per-move overhead allocation (which is why the job figure is labelled **gross**
profit, not net).
