# Phase 1 — the `JobCrew` write path (plan only, not implemented)

**Prerequisite: Phase 0 is merged** (`docs/admin/phase0-financial-integrity.md`).
Phase 0 deliberately made the absence of labor data loud. Phase 1 makes it
enterable. Nothing below exists yet.

## Why this is the next build

`JobCrew` is the schema's single source of truth for crew labor
(`financial-architecture.md`, Option A) and has 18 payroll columns, a
`CrewPayStatus` enum, four `payroll.*` permissions and three audit actions — all
of which are currently dead, because no code path ever creates or updates a row.
Until that changes, every profit figure in the product is missing its largest
cost, and the Phase 0 warnings will fire on 100% of moves.

---

## ⚠ Coordinate first: a second labor system is being built in parallel

The worktree `C:/WMIWCI-API/.claude/worktrees/frosty-feynman-d7161d` (branch
`claude/frosty-feynman-d7161d`) is adding a **Discord crew gig board** with its
own table:

```
crew_jobs (migration 20260627000000_crew_job_board)
  title, difficulty, payout_base, payout_total, requires_uhaul,
  requires_driver, driver_bonus, assigned_worker_id, status, …
```

Crew self-claim a job with an Accept button; payout is
`payout_base × difficulty multiplier + driver bonus`, locked in at accept time.

**That is a second, independent labor-cost model.** It does not write `JobCrew`.
If both ship as-is the business will have two disagreeing answers to "what did
labor cost on this move", and job profit will read from the one that is empty.

**Decide before building Phase 1** (owner call):

- **(a)** `crew_jobs` becomes the crew-facing *interface* and writes a `JobCrew`
  row on Accept/Complete — `JobCrew` stays the single source of truth. *Recommended.*
- **(b)** `crew_jobs` stays a standalone internal gig board unlinked to customer
  bookings, and `JobCrew` is fed by the admin UI only. Requires an explicit rule
  that `crew_jobs` payouts are recorded as expenses so they are not lost.
- **(c)** `crew_jobs` replaces `JobCrew`, and `profit.ts` is repointed. Largest
  change; discards the existing payroll columns.

Option (a) preserves both efforts. Whichever is chosen must be written into
`financial-architecture.md` before code is merged, because the WORKER_PAY
double-count guard keys off `JobCrew` having data.

---

## Recommended implementation order

### 1. Decide the labor source of truth (above). Blocking. *Small*

### 2. Migration — additive only. *Small*
```
JobCrew   + role                (CREW_LEADER | MOVER | DRIVER | HELPER)
          + workerType          (OWNER | EMPLOYEE | CONTRACTOR | TEMP)
          + travelHours, overtimeHours   Float?
          + rateSnapshotCents   Int?   ← the rate AT ASSIGNMENT time
          + adjustedById, adjustmentReason, adjustedAt
User      + defaultFlatRateCents Int?
          + workerType
CHECK     clock_out > clock_in
CHECK     actual_hours >= 0 AND actual_hours <= 24
CHECK     scheduled_hours >= 0
```
**Rate snapshots matter:** `crewPayOwedCents` currently falls back to
`User.payRate` at *read* time, so raising someone's rate retroactively changes
the profit of every historical job. Snapshot the rate when the row is created and
prefer it.

### 3. Routes. *Medium*
| Route | Method | Permission | Notes |
| --- | --- | --- | --- |
| `/api/admin/jobs/[id]/crew` | POST | `payroll.edit_hours` | assign a worker; snapshots rate; `CREW_ASSIGNED` audit |
| `/api/admin/jobs/[id]/crew/[crewId]` | PATCH | `payroll.edit_hours` | hours/rate/tips/bonus/deductions; `CREW_PAY_UPDATED` audit with before→after |
| `/api/admin/jobs/[id]/crew/[crewId]` | DELETE | `payroll.edit_hours` | unassign; blocked once `PAID` |
| `/api/admin/crew/[crewId]/clock` | POST | `payroll.edit_hours` (self-service later) | clock in/out |
| `/api/admin/crew/[crewId]/approve` | POST | `payroll.approve` (OWNER) | `SCHEDULED→PAY_APPROVED` |
| `/api/admin/crew/[crewId]/pay` | POST | `payroll.mark_paid` (OWNER) | `→PAID` + method + date; `CREW_PAID` audit. **Must not create an Expense row** (`financial-architecture.md`). |
| `/api/admin/staff/[id]` | PATCH | OWNER | add `payRate` to the existing route |

Every write: Zod validation, one `$transaction` with its audit row, and — for
edits after `PAY_APPROVED` — the `financial-adjust.ts` before→after workflow that
expenses already use.

### 4. Forms. *Medium*
- **Job detail → Crew tab**: assign worker (active users), role, scheduled hours,
  rate (prefilled from `User.payRate`, overridable), flat-pay toggle.
- **Per-row hours entry**: clock in / clock out / break, or direct hours; live
  computed pay via `crewPayOwedCents`; tips, bonus, deductions.
- **Explicit "confirm $0 labor"** control — Phase 0 already distinguishes
  confirmed-zero from missing, and the UI must be able to state it (owner-worked
  jobs where labor is treated as a draw).
- **Approve → Mark paid** with method and date.
- **Staff page**: pay-rate editing (removes the standing "no pay rate set" reminder).

### 5. Validation. *Small, but do it in the route, not the form*
Negative hours · `clock_out ≤ clock_in` · hours > 24 · overlapping shifts for one
worker (`evaluateCrewOverlaps` already exists and finally gets data) · missing
rate with no flat pay · editing a `PAID` row without the adjustment workflow ·
assigning an inactive user · duplicate worker on one job (unique constraint
already exists).

### 6. Permissions. *Small*
The four `payroll.*` actions already exist in the matrix and are correctly
owner-scoped for approve/mark-paid. Additionally:
- Gate the job Profit + Crew cards behind `money.view_job_profit` (the job page
  currently calls `getSession()` and discards it — see pre-audit §12).
- Worker self-service hours needs roles that do not exist yet
  (`CREW_LEADER`, `READ_ONLY`); defer, or restrict to OWNER/MANAGER entry first.

### 7. Owner vs worker labor. *Medium — needs an owner decision*
Owners are `User` rows and can be assigned like anyone else. The open question is
**cash view vs true-economic view**:
- *Cash view*: owner labor costs $0 unless actually paid → real cash profit.
- *Economic view*: owner labor valued at a replacement rate
  (`BusinessConfig.ownerLaborRateCents`) → what the move would cost with hired crew.

Phase 1 should record `workerType: OWNER` and the hours, and display **both**
figures. Do not silently pick one. Paying an owner for labor should be an
`OwnerTransaction` of a new `LABOR_PAYMENT` type, not a withdrawal — otherwise
labor payments contaminate the draw ledger.

### 8. Tests. *Medium*
Pure: rate snapshot precedence · overtime · break deduction · flat vs hourly ·
clock-range validation · overlap detection · owner labor in both views.
Route-level (**new capability — none exist today**): permission enforcement,
audit rows written, `PAID` creating no expense, adjustment workflow on edits.
Regression: a job with crew data must flip Phase 0's `missingLabor` to false and
`isComplete` to true; the WORKER_PAY guard must start blocking (it is inert today
because `bookingHasCrewLabor()` can never return true).

### 9. Mobile entry workflow. *Medium*
Hours are entered at a job site, and the admin is currently ~81px wide on a
phone. Minimum for Phase 1: a responsive Crew tab, large tap targets, a numeric
keypad for hours, and clock in/out as one-tap actions. The full responsive pass
stays Phase 4.

---

## Order summary

1. Decide the labor source of truth (blocking; coordinate with `frosty-feynman`)
2. Additive migration + CHECK constraints
3. Assign / edit-hours routes + audit
4. Job-detail Crew tab + hours entry + confirm-$0 control
5. Approve → mark-paid workflow
6. Staff pay-rate editing
7. Owner-labor dual view + `LABOR_PAYMENT` owner transaction type
8. Route + regression tests
9. Mobile pass on the Crew tab

**Complexity: Large.** Steps 1–4 alone remove the Phase 0 warning from real
moves and make the $2,000 → $1,175 calculation possible for the first time.
