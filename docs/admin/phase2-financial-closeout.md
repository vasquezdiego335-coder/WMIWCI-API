# Phase 2 — Financial closeout, company profit, owner distributions

**Owner spec 2026-07-20. Branch `claude/admin-phase2-financial-closeout`, built
on Phase 1 (`claude/admin-phase1-jobcrew`, commit 7453a340).**

Phase 0 corrected the arithmetic. Phase 1 made labor enterable. Phase 2 turns a
completed move into a **durable financial record** that survives every later
configuration change.

---

## The one rule this phase exists to enforce

> **Profit is computed from money that was COLLECTED, and a finalized closeout
> never changes because a setting changed later.**

An outstanding balance is a receivable, not cash. It never reaches a distribution.
A finalized move reads from its immutable snapshot, not from live config.

## The hierarchy (all in `src/lib/closeout-calc.ts`)

```
  gross customer charges − discounts − credits        = net billed revenue
  captured − actual refunds − lost chargebacks        = net collected revenue
  net billed − net collected − write-off              = outstanding balance

  approved crew labor + eligible expenses + fees      = direct job costs

  net collected − direct job costs                    = CASH GROSS PROFIT
  cash gross profit − unpaid owner labor value        = ECONOMIC PROFIT
  cash gross profit − allocated overhead              = COMPANY NET PROFIT
  company net profit − unpaid owner labor value       = ECONOMIC NET PROFIT

  company net profit
    − tax reserve − business reserves
    − retained earnings − unresolved liabilities      = DISTRIBUTABLE PROFIT
```

`marginBp` = company net profit ÷ net collected revenue, in basis points.
Every figure may be negative except reserves and distributable profit, which
floor at zero. **Losses are shown, never hidden.**

## Modules

| File | Role |
| --- | --- |
| `closeout-calc.ts` | The hierarchy above. Pure, integer cents, basis points. |
| `closeout-blockers.ts` | What stops finalization, split HARD vs OVERRIDABLE; derives closeout status from reality |
| `owner-split.ts` | EQUAL / OWNERSHIP_PERCENT / LABOR_FIRST / CUSTOM + distribution validation |
| `closeout-guards.ts` | The pure route decisions (finalize, override, reopen, reserves, overhead, split, distributions) |
| `closeout-service.ts` | The only Phase 2 module touching Prisma; builds the view and writes snapshots |

## Blockers

**HARD — the data is wrong, and no reason makes it safe.** No override clears
these: `NO_PAYMENT_DATA` · `UNKNOWN_REFUND_AMOUNT` · `REFUND_EXCEEDS_PAYMENT` ·
`NEGATIVE_VALUE` · `LABOR_MISSING_CLOCK_OUT` · `LABOR_MISSING_RATE` ·
`LABOR_NOT_APPROVED` · `ALLOCATION_EXCEEDS_PROFIT` · `RESERVES_EXCEED_PROFIT`.

**OVERRIDABLE — a judgement call an owner may document.** Cleared by an owner
override with a written reason, recorded in the audit log:
`OUTSTANDING_BALANCE` · `OPEN_DISPUTE` · `TRUCK_SOURCE_MISSING` ·
`TRUCK_COST_MISSING` · `RECEIPT_MISSING` (only above the policy threshold) ·
`EXPENSES_PENDING_REVIEW` · `OWNER_REIMBURSEMENT_PENDING` · `LABOR_MISSING`.

Blockers are **re-checked server-side against a freshly built view** at
finalization. The client's opinion of readiness is never trusted.

## Snapshots

Finalizing writes an immutable `FinancialSnapshot` (v1, v2, …). Reopening marks
the previous version **superseded, never deleted**, and finalizing again writes
the next version. Each snapshot records every figure plus the overhead method
and rate, the tax basis-points, the split method, the incomplete flags and the
`calculationVersion` — so a number can always be re-explained later.

Changing a worker rate, an ownership split, a reserve percentage or an overhead
policy **cannot rewrite a finalized move.**

## Reserves

Tax reserve is a percentage of **company net profit** (never of revenue) or a
fixed amount, **floored at zero on a loss**. Business reserves and retained
earnings are named `ReserveAllocation` rows. All of them are **planned
allocations, not bank transfers** — `transferred` is only true when a human
confirms real movement.

## Owner money — three separate things

| Concept | What it is | Where it lives |
| --- | --- | --- |
| **Reimbursement** | Money already the owner's | `OwnerTransaction` — held back from distributable, never profit |
| **Draw / withdrawal** | Owner takes cash out | `OwnerTransaction` — never an expense |
| **Distribution** | A share of collected profit | `OwnerDistribution` — bounded by the snapshotted distributable profit |

Labor pay is a fourth, distinct thing (`JobCrew`, Phase 1).

## Distributions

A distribution can only be authorized against a **finalized snapshot** — there
is no distributing from live, still-moving numbers. Allocation (`approvedCents`)
and cash (`paidCents`) are separate; partial payments are supported; voids never
delete. A DB CHECK enforces `paid_cents <= approved_cents`.

**Calculating a split creates nothing.** An owner must explicitly plan/approve.

## Known limitations

- **No migration applied.** The Neon database has exceeded its compute quota and
  is unreachable, so neither Phase 1 nor Phase 2 migrations are applied and no
  staging run has happened. See `phase2-staging-plan.md`.
- Route tests are contract tests over the pure guards the routes call, not
  HTTP-level integration tests (no test database available).
- `netBilledRevenue` derives from `Booking.totalEstimate` + move-day fees. A
  dedicated itemized invoice model (extra hours, extra stops, supplies sold,
  customer tips) is Phase 3.
- Shared-expense splitting across moves, expense void-after-finalization
  records, and the accountant/crew-leader/read-only roles are Phase 3.
- Overhead `MONTHLY_POOL` uses a per-request move count of 1 until the reporting
  layer supplies a real period count.
- Action Center closeout rules are defined here but not yet wired into
  `reminder-rules.ts` — deferred to Phase 3 with the reporting suite.
- This is not accounting software and the tax reserve is an internal estimate,
  not tax advice.
