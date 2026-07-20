# Labor source of truth — `JobCrew` vs `crew_jobs`

**Decision recorded 2026-07-20, before any Phase 1 code was written. Gate item
from the Phase 1 spec.**

## What the audit found

The Phase 0 report flagged a suspected collision: a concurrent worktree
(`.claude/worktrees/frosty-feynman-d7161d`, branch `claude/frosty-feynman-d7161d`,
**uncommitted**) adds a `crew_jobs` table with its own payout model. The concern
was two systems answering "what did labor cost on this move" differently.

**A full read of that implementation shows the collision does not exist in the
form anticipated — and the spec's preferred architecture cannot be applied as
written.** Verified against the real code, not the description:

| Question | Finding |
| --- | --- |
| Does `CrewJob` reference a `Booking`? | **No.** No `bookingId` column, no relation. |
| Does `CrewJob` reference a `Job`? | **No.** |
| Does `CrewJob` reference a `User`? | **No.** `assignedWorkerId` is a **Discord user id** string. The schema comment states: *"crew are Discord members, not app Users"*. |
| What is its payout model? | `round(payoutBase × difficultyMultiplier) + driverBonus`, locked at accept time. A **gig price**, not hours × rate. |
| What does its own README say? | *"This is **not** the customer booking pipeline… a separate, self-serve board for paying out crew — its own table, its own commands, its own channels."* |

`crew_jobs` is an **internal gig board for work that is not a customer move**:
an owner posts a task with `/createjob`, a crew member claims it from Discord,
completes it, and gets a fixed payout. It is not attached to a move, so **it
cannot currently produce a labor cost for a move at all.**

## Why the spec's preferred flow was not implemented literally

The spec proposed:

```
Discord gig board → crew accepts → create/update JobCrew assignment
```

`JobCrew.jobId` is **NOT NULL** with a foreign key to `Job`, and every `Job`
requires a `Booking`. A `crew_job` has no booking. Writing a `JobCrew` row on
gig acceptance would therefore require **fabricating a customer move for every
internal task** — inventing labor data attached to a job that never happened,
which the same spec forbids. That path was rejected on the evidence.

## The decision

| Concern | Owner |
| --- | --- |
| Assignment state **for a customer move** | **`JobCrew`** |
| Actual hours | **`JobCrew`** |
| Rate snapshots | **`JobCrew`** |
| Approved labor cost | **`JobCrew`** |
| Payment status / payment records | **`JobCrew`** + `labor_payments` |
| What the profit calculator reads | **`JobCrew` only** |
| Assignment state for a **non-move internal gig** | `crew_jobs` (Discord) |
| Gig payout amount | `crew_jobs` (its own locked snapshot) |

**`JobCrew` is the canonical financial labor record for every customer move.
`profit.ts` reads `JobCrew` and nothing else. `crew_jobs` is never summed into
move profitability, because a gig has no move.**

## Duplicate-prevention design

Three mechanisms, in order of strength:

1. **Structural.** The labor cost of a move is derived exclusively from
   `JobCrew` rows joined through `Job.bookingId`. There is no code path in
   `money-rules.ts`, `profit.ts`, `labor-calc.ts` or `job-money.ts` that reads
   `crew_jobs`. A gig payout cannot reach a move's profit even by accident.
2. **The seam, built and tested now.** `JobCrew.crewJobId` (nullable, **unique**,
   plain reference — no FK, matching the existing `OwnerTransaction.bookingId`
   pattern so this migration is independent of unmerged work). If the gig board
   later gains a booking linkage, `linkCrewJobToAssignment()` in
   `src/lib/labor-calc.ts` is the ONE adapter: it upserts on `crewJobId`, so a
   replayed Discord acceptance can never create a second assignment, and the gig
   payout becomes the assignment's **flat-pay snapshot** — counted once, in
   `JobCrew`, like any other flat-rate worker. `crew_jobs.payout_total` is then a
   record of what was promised, never a second cost.
3. **Existing guard, now live.** `worker-pay-guard.ts` blocks a `WORKER_PAY`
   expense on a job that already has crew payroll. It was inert before Phase 1
   (`bookingHasCrewLabor()` could never return true because no `JobCrew` row
   could exist). With a real write path it starts enforcing.

## The real risk this audit surfaced

Not a double-count — a **gap**. Gig payouts are real money leaving the business
that currently lands in **no** financial ledger: not `JobCrew` (no move), not
`Expense`, not the cash estimate. A completed `crew_job` marks itself paid inside
Discord and the admin never sees the money.

**Recommended follow-up (NOT built in Phase 1, needs an owner decision):** a
completed `crew_job` should write a **general business `Expense`** (category
`WORKER_PAY`, `bookingId: null`) so the payout appears in company costs and the
cash estimate. That is the correct home for non-move labor. It does not conflict
with the WORKER_PAY guard, which only fires on *booking-linked* expenses.

## Merge note

`crew_jobs` is uncommitted on another branch. This migration deliberately does
**not** depend on it: `crewJobId` is a plain nullable string with no foreign key.
Both branches touch `prisma/schema.prisma` in different regions (`CrewJob` is
appended after `Task`; Phase 1 edits `JobCrew` and appends `LaborPayment`), so
they are additive and mergeable in either order.
