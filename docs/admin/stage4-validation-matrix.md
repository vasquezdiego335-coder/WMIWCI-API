# Stage 4 — validation matrix

Two mechanisms, deliberately different, and it matters which one you are looking
at:

* **Blockers** (`src/lib/closeout-blockers.ts`) — coded findings about the MOVE.
  They have a `code`, a `severity` and a `section` the UI deep-links to.
* **Guards** (`src/lib/closeout-guards.ts`, `labor-guards.ts`) — permission and
  state decisions about the REQUEST. They return an HTTP status and a message.
  **They have no codes**, and none are invented here.

Severity means exactly one thing:

* **HARD** — the data is WRONG, not merely absent. No reason makes it safe, so
  no override accepts it.
* **OVERRIDABLE** — a judgement call an owner is entitled to make and document.

## Blockers

| Code | Meaning | Trigger | Severity | Override permission | Reason | Operator response |
| --- | --- | --- | --- | --- | --- | --- |
| `REFUND_EXCEEDS_PAYMENT` | A refund is larger than the payment it refunds | any payment with `refundedAmountCents > amount` | **HARD** | none — cannot be overridden | — | Fix the payment records |
| `NEGATIVE_VALUE` | A negative amount exists that should not | `hasNegativeValue` | **HARD** | none | — | Review the records |
| `ALLOCATION_EXCEEDS_PROFIT` | Owner allocations exceed distributable profit | `allocatedToOwnersCents > distributableProfitCents` | **HARD** | none | — | Reduce the allocation |
| `RESERVES_EXCEED_PROFIT` | Requested reserves exceed available profit | `reserves.overAllocated` | **HARD** | none | — | Lower the reserves |
| `NO_PAYMENT_DATA` | No captured customer payment | `grossCapturedCents === 0` | **HARD** on a real booking · **OVERRIDABLE** when `booking.isInternalTest` | `closeout.override_blocker` (internal-test only) | **yes** | Record the payment, or rehearse on an internal-test move |
| `UNKNOWN_REFUND_AMOUNT` | A partial refund has no recorded amount | `revenue.hasUnknownRefund` | **HARD** | none | — | Enter the refund amount |
| `LABOR_MISSING_CLOCK_OUT` | A worker clocked in and never out | `laborState === 'MISSING_CLOCK_OUT'` | **HARD** | none | — | Close the shift or correct the time |
| `LABOR_MISSING_RATE` | Hours exist that cannot be priced | `laborState === 'MISSING_RATE'` | **HARD** | none | — | Set the rate on the assignment or the profile |
| `LABOR_NOT_APPROVED` | Labor recorded but not approved | `laborState === 'HOURS_UNAPPROVED'` | **HARD** | none | — | Approve or reject the hours |
| `LABOR_MISSING` | No labor recorded at all | `laborState` is `NOT_ASSIGNED` or `ASSIGNED_NO_HOURS` | OVERRIDABLE | `closeout.override_blocker` | **yes** | Record the labor, or confirm $0 with a reason |
| `OUTSTANDING_BALANCE` | The customer still owes money | `outstandingBalanceCents > 0` | OVERRIDABLE | `closeout.override_blocker` | **yes** | Collect it, or write it off with a reason |
| `OPEN_DISPUTE` | Money is in an unacknowledged dispute | `disputedOpenCents > 0 && !disputeAcknowledged` | OVERRIDABLE | `closeout.override_blocker` | **yes** | Acknowledge the dispute |
| `TRUCK_SOURCE_MISSING` | Truck source unconfirmed | `!truckSourceConfirmed` | OVERRIDABLE | `closeout.override_blocker` | **yes** | Confirm the source — a missing truck cost is not $0 until someone says so |
| `TRUCK_COST_MISSING` | Costly truck source with no truck expense | confirmed source is RENTAL / THIRD_PARTY / COMPANY_OWNED and no TRUCK_RENTAL or GAS expense | OVERRIDABLE | `closeout.override_blocker` | **yes** | Add the expense, or override |
| `RECEIPT_MISSING` | An eligible expense at or above the threshold has no receipt | per expense, `amountCents >= receiptRequiredAboveCents` (default $25.00) | OVERRIDABLE | `closeout.override_blocker` | **yes** | Attach the receipt |
| `EXPENSES_PENDING_REVIEW` | Unreviewed expenses on the move | `pendingExpenseCount > 0` | OVERRIDABLE | `closeout.override_blocker` | **yes** | Approve or reject them |
| `OWNER_REIMBURSEMENT_PENDING` | Money owed back to an owner | `ownerReimbursementOwedCents > 0` | OVERRIDABLE | `closeout.override_blocker` | **yes** | Settle it, or accept the hold-back |

Blockers are returned most-severe-first. An empty list means the move is ready.

## Guard refusals (no codes — status + message)

| Situation the brief asked about | Actually enforced by | Result |
| --- | --- | --- |
| **Duplicate closeout** | `MoveCloseout.bookingId` **unique**; `ensureCloseout` returns the existing row | Impossible at the database level |
| **Missing reopen reason** | `canReopenCloseout` | 422 "A reason is required to reopen a finalized move." |
| **Already finalized version** | `canFinalizeCloseout` | 409 "This move is already finalized. Reopen it to make changes." |
| **Duplicate current version** | `@@unique([closeoutId, version])` + `isConcurrentFinalize` | 409 with an explanation that the other person finalized it |
| **Snapshot mismatch** | *No such validation exists.* Snapshots are written once and never updated, so there is nothing to reconcile. Reading is via `allocationFromSnapshot`, which tolerates a malformed JSON column by falling back to the frozen amounts rather than fabricating a line. | — |
| **Invalid worker type** | Prisma enum `CrewWorkerType` + zod `z.enum` on the crew route | 422 |
| **Invalid break duration** | `labor-time.computeTimeBreakdown` (breaks cannot exceed elapsed time) | clamped/flagged; a shift over `longShiftReviewMinutes` (840) is flagged for review, not rejected |
| **Negative worked duration** | `labor-time` — clock-out before clock-in yields no positive worked time | invalid entry |
| **Editing a finalized move** | `canEditCloseoutInputs` | 409 |
| **Manager attempting an owner action** | `can(role, action)` via the specific guard | 403 |
| **Reserve above profit** | `canSetReserves` | 422 with both amounts in the message |
| **Manual overhead with no reason** | `canSetOverhead` | 422 |
| **Custom split with no reason** | closeout route | 422 |
| **Owner split not totalling 100%** | `computeOwnerSplit` → `canSetOwnerSplit` | 422 |
| **Rate of $0 for owner labor** | `evaluateRateChange` | 422 "…Leave it blank instead — blank means 'not decided yet'." |
| **Rehearsal on a real booking** | `evaluateRehearsal` | 422, message names the booking not the person |
| **Rehearsal by a manager** | `evaluateRehearsal` | 403 |
| **Rehearsal with no reason** | `evaluateRehearsal` | 422 |

## Labor states feeding the blockers

`deriveLaborState` (`financial-completeness.ts`) returns exactly one of:

`NOT_ASSIGNED` · `ZERO_CONFIRMED` · `MISSING_CLOCK_OUT` · `MISSING_RATE` ·
`ASSIGNED_NO_HOURS` · `HOURS_UNAPPROVED` · `APPROVED_UNPAID` · `PAID`

Order matters: `MISSING_RATE` is checked **before** "no hours", because time that
exists but cannot be priced is a different problem with a different fix, and
telling the owner "hours not entered" when the hours ARE entered sends them to
the wrong screen.

`ZERO_CONFIRMED` is not `NOT_ASSIGNED`. A deliberate, reasoned $0 is a financial
assertion; an absent record is an unknown. The system keeps them apart.
