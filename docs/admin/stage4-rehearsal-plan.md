# Final pipeline rehearsal plan — DEFERRED, NOT RUN

**Status: NOT EXECUTED.** This plan must not run against production financial
reporting until the whole booking → job → scheduling → closeout pipeline is
deployed **and the operator explicitly authorizes it.** Stage 5 (scheduling) is
not built, so steps 6–14 have no implementation yet.

At the time of writing, production holds **0 closeouts and 0 snapshots**. Nothing
below has been proven against real rows.

## Ground rules

* The fixture is an **internal-test** customer and booking. Never a real
  customer, never a real card.
* `booking.isInternalTest = true` is what makes the rehearsal legal — it is the
  only thing that softens `NO_PAYMENT_DATA`, and only for an OWNER with a written
  reason.
* No Stripe operation, no customer email, no customer SMS occurs on this path.
* Synthetic revenue is excluded from company reporting by `money-rules`; every
  report query filters `isInternalTest: false`.

## Steps

Each step: **precondition → route → expected rows → expected audit → pass
condition → failure meaning.**

| # | Step | Route / service | Expected DB | Expected audit | Pass condition |
| --- | --- | --- | --- | --- | --- |
| 1 | Create internal test customer | `/admin/customers` or seed | `Customer` | — | row exists |
| 2 | Create internal test booking | admin booking create | `Booking` with `isInternalTest = true` | `BOOKING_CREATED` | flag is true — **if false, stop; the rehearsal is not legal** |
| 3 | Approve the booking | `booking.approve` (OWNER) | status advances; **no Stripe capture on a test booking** | `BOOKING_STATE_CHANGED` | no payment intent captured |
| 4 | Confirm exactly one Job | `ensureJobForBooking` | exactly 1 `Job` for the booking | — | `SELECT count(*) = 1` |
| 5 | Confirm `JOB_CREATED` audited | — | — | exactly one `JOB_CREATED` for this booking | count = 1 (race-safe by design) |
| 6 | Define staffing requirements | **Stage 5 — not built** | — | — | blocked |
| 7 | Assign Diego and Sebastian as `OWNER` | `POST /api/admin/jobs/[id]/crew` `workerType: OWNER`, `payModel: UNPAID_OWNER` | 2 `JobCrew` rows, each with `economicRateCentsSnapshot = 3000` | `CREW_ASSIGNED` ×2 | **snapshot is 3000, not null** — if null, the rate was set after assignment |
| 8 | Confirm no active crew member is required | — | — | — | assignment succeeds with 0 CREW-role users |
| 9 | Offer / confirm assignments | **Stage 5 — not built** | — | — | blocked |
| 10 | Verify acknowledgment behaviour | **Stage 5 — not built** | — | — | blocked |
| 11 | Verify scheduling conflicts | **Stage 5 — not built** | — | — | blocked |
| 12 | Add a temporary availability exception | **Stage 5 — not built** | — | — | blocked |
| 13 | Confirm the conflict engine responds | **Stage 5 — not built** | — | — | blocked |
| 14 | Remove the exception | **Stage 5 — not built** | — | — | blocked |
| 15 | Add a synthetic payment | `/api/admin/payments` | `Payment` with `isInternalTest = true`, `method` set | `PAYMENT_RECEIVED` | `method` persists and is queryable |
| 16 | Clock in both owners | `/api/admin/crew-assignments/[id]/clock` | `clockIn` set | `CREW_CLOCK_IN` ×2 | both open shifts |
| 17 | Record breaks | same route | `breakStartedAt` → `actualBreakMinutes` | `CREW_BREAK_UPDATED` | break minutes deducted from worked |
| 18 | Clock out | same route | `clockOut`, `workedMinutes`, `paidMinutes` derived | `CREW_CLOCK_OUT` ×2 | `paidMinutes = worked − break` |
| 19 | Approve labor | `/api/admin/crew-assignments/[id]/approval` (OWNER) | `approvalStatus = APPROVED` | `CREW_HOURS_APPROVED` ×2 | manager attempt returns 403 |
| 20 | Confirm frozen $30/h used | closeout view | owner economic labor = `paidMinutes/60 × 3000` | — | matches to the cent |
| 21 | Add one approved expense | `/admin/expenses` | `Expense` APPROVED | `EXPENSE_APPROVED` | included in `directJobCost` |
| 22 | Add one rejected expense | same | `Expense` REJECTED | `EXPENSE_REJECTED` | — |
| 23 | Confirm rejected expense excluded | closeout view | — | — | `directExpenseCents` excludes it |
| 24 | Calculate net profit | `buildCloseoutView` | — | — | matches a hand calculation |
| 25 | Confirm 40/30/30 | closeout panel | — | — | business 40% / Diego 30% / Sebastian 30% of net, summing exactly to net |
| 26 | Finalize | `POST /api/admin/closeout/[id]` `FINALIZE` | `FinancialSnapshot` v1; closeout `FINALIZED`; `businessRetainedBp` frozen | `CLOSEOUT_FINALIZED` with version 1 | exactly one snapshot row |
| 27 | Re-read the snapshot **from the database** | direct SQL | — | — | `allocationLines`, `configSource`, `configVersion`, `calculationVersion` all populated |
| 28 | Change the live owner rate / config | `/admin/staff`, `/admin/owner-money` | `User.ownerEconomicRateCents` changes | `LABOR_RATE_CONFIGURED` | — |
| 29 | Confirm version 1 does not change | re-read the same row | — | — | **byte-for-byte identical to step 27** |
| 30 | Reopen with a reason | `REOPEN` | `REOPENED`, `reopenReason` set, `finalizedAt` cleared, **snapshot untouched** | `CLOSEOUT_REOPENED` | v1 still present, still `supersededAt = null` |
| 31 | Add a late approved expense | `/admin/expenses` | `Expense` APPROVED | `EXPENSE_APPROVED` | — |
| 32 | Finalize version 2 | `FINALIZE` | `FinancialSnapshot` v2; v1 gets `supersededAt` | `CLOSEOUT_FINALIZED` version 2 | two snapshot rows |
| 33 | Confirm v1 unchanged | direct SQL | — | — | every money column identical to step 27 |
| 34 | Confirm v1 superseded | direct SQL | `supersededAt` not null, `supersededById` set | — | — |
| 35 | Confirm v2 is current | direct SQL | `supersededAt` null | — | exactly one current version |
| 36 | Confirm the full audit chain | audit log | — | assignment, clock, break, approval, expense, closeout, override, reopen, finalize ×2 | no gaps |
| 37 | Confirm CREW cannot see protected values | log in as a CREW user | — | — | `/admin` blocked by middleware; report fields stripped by `shapeForRole` |
| 38 | Confirm obsolete notification jobs cancelled | **Stage 5 — not built** | — | — | blocked |
| 39 | Confirm every surface agrees | closeout panel · job page · reports · printable summary | — | — | identical net profit and identical 40/30/30 on all four |

## Cleanup

Delete in FK-safe order, and only in an environment meant to stay clean:
`FinancialSnapshot` → `ReserveAllocation` → `MoveCloseout` → `LaborPayment` →
`JobCrew` → `Job` → `Expense` → `Payment` → `Booking` → `Customer`, then the
`AuditLog` rows for that booking.

Better alternative: **leave the fixture in place.** It is flagged
`isInternalTest`, it is excluded from every report by construction, and it is
useful evidence that the pipeline works. Delete only if the environment must be
pristine.

## Blocked steps summary

Steps **6, 9–14 and 38** require Stage 5 (staffing requirements, assignment
offer/acknowledgment, availability exceptions, the conflict engine and assignment
notifications). Until Stage 5 ships, this rehearsal can be run only in a reduced
form that skips scheduling — which would prove the FINANCIAL chain but not the
pipeline. That reduced run is available on request and is the recommended interim
step, because it would move Stage 4 from "deployed" to "verified" without waiting
for Stage 5.
