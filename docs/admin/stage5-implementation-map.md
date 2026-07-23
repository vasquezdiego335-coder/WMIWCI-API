# Stage 5 — implementation map

> **STATUS: IMPLEMENTED.** This was the pre-build planning record. The built
> system is documented in `stage5-crew-scheduling.md`; the decisions below were
> followed (JobCrew extended, not forked; conflict engine pure; availability
> precedence tested first; CREW routed to `/crew`). Kept for the rationale.


**Branch `claude/stage5-crew-scheduling`, based on `origin/main` @ `a4833a5b0`
("Claude/stage4 financial workflow (#17)").** Written before any Stage 5 code,
from reading the repository rather than from assumption.

The headline finding: **most of what Stage 5 asks for already exists under
different names.** `JobCrew` is already a first-class assignment record with a
lifecycle, rate snapshots and time tracking. Building a parallel "Assignment"
model would fork the financial record that Stage 4 depends on. Stage 5 must
EXTEND `JobCrew`, not replace it.

---

## 1. What already exists

### 1.1 Models

| Model | What it already is | Stage 5 relevance |
| --- | --- | --- |
| `User` | Staff. `role` (OWNER/MANAGER/CREW), `workerType`, `active`, `payRate`, `defaultFlatRateCents`, `preferredRole`, `reliabilityRating`, and the Stage 4 rate block (`ownerEconomicRateCents`, `defaultPayModel`, `rateEffectiveOn`, `rateNotes`, `rateUpdatedById/At`, `canDrive`, `canLeadCrew`) | **Extend** — skills, license expiry, worker status, deactivation reason |
| `Job` | One per booking. `status`, `startedAt`, `completedAt`, `durationMins`, `crewNotes` | **Extend** — staffing requirements live here or in a child model |
| `JobCrew` | **THE assignment + labor record.** ~70 fields | **Extend** — see 1.2 |
| `Availability` | `userId` + `date` + `isDayOff` + `startTime`/`endTime` strings + `notes`, unique on `(userId, date)` | **Extend** — date-specific only; no recurrence, no timezone, no exception taxonomy |
| `DayBlock` | Business-wide blocked dates (`date` unique) | Reuse as the "administrative hard-unavailable" precedence tier |
| `MoveCloseout` / `FinancialSnapshot` / `ReserveAllocation` / `OwnerDistribution` | Stage 4 | **Do not touch** beyond reading |
| `AuditLog` | `action` (enum), `userId`, `bookingId`, `details` JSON | **Extend** the enum only |

### 1.2 `JobCrew` — what it already covers

This is the single most important discovery. `JobCrew` already has:

* **Identity** — `jobId`, `userId`, `workerType` (`CrewWorkerType`), `role`
  (`CrewRole`), `assignmentStatus` (`CrewAssignmentStatus`), `crewLeader`,
  `crewJobId` (Discord gig link, unique)
* **Lifecycle timestamps** — `assignedAt`, `acceptedAt`, `declinedAt`,
  `cancelledAt`, `cancelReason`, `assignmentNotes`
* **Scheduled time** — `scheduledStartAt`, `scheduledEndAt`,
  `scheduledBreakMinutes`, `scheduledMinutes`, `scheduledTravelMinutes`
* **Actual time** — `clockIn`, `clockOut`, `breakStartedAt`,
  `actualBreakMinutes`, `workedMinutes`, `regularMinutes`, `overtimeMinutes`,
  `travelMinutes`, `paidMinutes`, `timeEntrySource`, `timeAdjustedById/At`,
  `timeAdjustReason`
* **Frozen rates** — `payModel`, `hourlyRateCentsSnapshot`,
  `overtimeRateCentsSnapshot`, `flatPayCentsSnapshot`, `dayRateCentsSnapshot`,
  `travelRateCentsSnapshot`, **`economicRateCentsSnapshot`** (owner labor),
  `rateSnapshotAt`, `rateSnapshotSource`, `rateAdjustedById/At/Reason`
* **Approval** — `approvalStatus` (`LaborApprovalStatus`), `submittedAt/ById`,
  `approvedAt/ById`, `rejectedReason`, `adjustmentReason`, `approvedPayCents`,
  `calculatedPayCents`
* **Zero-labor assertion** — `zeroLaborConfirmed` + who/when/why
* **Payment** — `paymentStatus`, `laborPayments[]`
* **Audit** — `createdById/ByName`, `updatedById`, `sourceSystem`, timestamps
* **Constraint** — unique `(jobId, userId)`

### 1.3 Enums already closed

`CrewWorkerType` OWNER · EMPLOYEE · CONTRACTOR · TEMP_HELPER
`CrewRole` CREW_MEMBER · CREW_LEADER · DRIVER · HELPER · OWNER_OPERATOR · OTHER
`CrewAssignmentStatus` INVITED · OFFERED · ACCEPTED · DECLINED · ASSIGNED · IN_PROGRESS · COMPLETED · CANCELLED · NO_SHOW
`LaborApprovalStatus` DRAFT · SUBMITTED · NEEDS_REVIEW · APPROVED · REJECTED
`LaborPaymentStatus` UNPAID · PARTIALLY_PAID · PAID · VOIDED
`LaborPayModel` HOURLY · FLAT · DAY_RATE · UNPAID_OWNER · ZERO_CONFIRMED · CUSTOM
`TimeEntrySource` CLOCK · MANUAL · IMPORTED · OWNER_OVERRIDE · DISCORD_WORKFLOW
`CrewPayStatus` (legacy, kept in sync by `labor-calc`)

**The brief's suggested assignment lifecycle (DRAFT/OFFERED/CONFIRMED/DECLINED/
CANCELLED/COMPLETED/NO_SHOW) maps onto `CrewAssignmentStatus` almost exactly.**
Use the repository's vocabulary: `ASSIGNED` is the existing "confirmed", and
`INVITED`/`OFFERED` already distinguish the two pre-acceptance states. Adding a
parallel enum would break `labor-calc.legacyPayStatusFor` and every existing
reader.

### 1.4 Services

| File | Responsibility | Purity |
| --- | --- | --- |
| `labor-time.ts` | minutes math, break handling, overtime split | pure |
| `labor-calc.ts` | pay computation, `buildRateSnapshot`, legacy mirrors | pure |
| `labor-guards.ts` | `canApproveLabor`, `canAssignCrew`, `canWriteTime`, `canChangeRateSnapshot`, `canConfirmZeroLabor`, `canDeleteAssignment`, `canRecordLaborPayment`, `canVoidLaborPayment` | pure |
| `labor-service.ts` | the ONLY labor module touching Prisma: `recalcAssignment`, `loadLaborPolicy`, `ensureJobForBooking`, `otherShiftsFor` | impure |
| `labor-rates.ts` | Stage 4 rate configuration + `describeLaborSetup` | pure |
| `financial-completeness.ts` | `deriveLaborState` → NOT_ASSIGNED / ASSIGNED_NO_HOURS / MISSING_CLOCK_OUT / MISSING_RATE / HOURS_UNAPPROVED / ZERO_CONFIRMED / APPROVED_UNPAID / PAID | pure |
| `closeout-*.ts`, `profit-allocation.ts`, `owner-split.ts`, `reporting-*.ts` | Stage 4 | mostly pure |
| `permissions.ts` | `can(role, action)` matrix | pure |
| `queues/index.ts` | **lazy** BullMQ getters — safe to import from routes | impure on first call |

`otherShiftsFor(userId, excludeJobCrewId)` already exists and already returns
other clocked shifts — it is the seed of the overlap conflict check.

### 1.5 Routes and pages

* `app/api/admin/staff/[id]/route.ts` — role/active
* `app/api/admin/staff/[id]/rates/route.ts` — Stage 4 rate configuration
* `app/api/admin/jobs/[id]/crew/route.ts` — **assignment creation**, takes the rate snapshot
* `app/api/admin/crew-assignments/[id]/route.ts` · `/approval` · `/clock` · `/payments`
* `app/api/admin/availability/route.ts`
* `app/(admin)/admin/(dashboard)/staff/page.tsx` — staff list + Stage 4 rate panel
* `app/(admin)/admin/(dashboard)/schedule/page.tsx` — existing calendar
* `app/(admin)/admin/(dashboard)/jobs/[id]/page.tsx` — job detail, closeout panel
* `app/(admin)/admin/(dashboard)/action-center/`

### 1.6 Permissions already defined

`labor.assign_crew`, `labor.edit_assignment`, `labor.edit_rate_snapshot`,
`labor.enter_hours`, `labor.clock_self`, `labor.submit_hours`,
`labor.view_own_labor`, `labor.view_all_labor`, `labor.confirm_zero_labor`,
`labor.set_owner_labor_value`, `labor.record_payment`, `labor.void_payment`,
`labor.finalize_override` — plus the full `closeout.*`, `distribution.*`,
`report.*` sets. CREW is already allow-listed for exactly three self-service
actions (`labor.clock_self`, `labor.submit_hours`, `labor.view_own_labor`).

**Stage 5 should add `schedule.*` and `availability.*` actions in this style and
must NOT invent a second permission system.**

### 1.7 Audit vocabulary already present

`CREW_ASSIGNED`, `CREW_ASSIGNMENT_UPDATED`, `CREW_ASSIGNMENT_CANCELLED`,
`CREW_ASSIGNMENT_ACCEPTED`, `CREW_ASSIGNMENT_DECLINED`, `CREW_CLOCK_IN`,
`CREW_CLOCK_OUT`, `CREW_BREAK_UPDATED`, `CREW_HOURS_EDITED`,
`CREW_HOURS_SUBMITTED`, `CREW_HOURS_APPROVED`, `CREW_HOURS_REJECTED`,
`CREW_RATE_SNAPSHOT_CHANGED`, `CREW_ZERO_LABOR_CONFIRMED`,
`CREW_OWNER_LABOR_VALUED`, `CREW_PAYMENT_RECORDED`, `CREW_PAYMENT_VOIDED`,
`CREW_PAY_UPDATED`, `CREW_PAID`, `LABOR_RATE_CONFIGURED`, `JOB_CREATED`,
`SCHEDULE_MODIFIED`, `AVAILABILITY_SET`.

### 1.8 Queues and notification infrastructure

Lazy BullMQ getters for `email`, `sms`, `discord`, `webhookRetry`, `scheduled`,
`marketing`. Workers live in `src/workers/` and run in a **separate Railway
service** (`Procfile` → `npm run host:start`); the admin service must never
start them. Importing `src/lib/queues` from a route is safe — that is the
existing pattern and the file documents why.

---

## 2. What is genuinely missing

| Brief | Status | Approach |
| --- | --- | --- |
| C1 staff profile fields | **Partial** — Stage 4 added rates, `canDrive`, `canLeadCrew` | Extend `User`: skills, license expiry, worker status, start/deactivation dates + reason |
| C2 worker state | **Missing** — only boolean `active` | New `WorkerStatus` enum, kept SEPARATE from `role` and `workerType` |
| C3 invitation flow | **Missing** — staff page shows a disabled "Invite (soon)" chip; no token infrastructure | Model + admin flow; the auth dependency must be documented, not faked |
| C4 deactivation workflow | **Missing** — `active` toggles with no reason, no future-assignment check | New guarded workflow |
| D1–D4 recurring availability | **Missing** — `Availability` is date-only, no timezone, no recurrence | New `AvailabilityRule` + `AvailabilityException`; keep `Availability` as the legacy date row or migrate it |
| E job staffing requirements | **Missing entirely** | New model on `Job` |
| F assignment fields | **Partial** | Add `offeredAt`, `reportTime`, `declineReason`, `removedAt`/`removalReason`, `completedAt`, `isDriver`, worker-visible vs private notes |
| G roles/skills | **Partial** — `CrewRole` exists, skills do not | Add a skill vocabulary + per-user capability |
| H conflict engine | **Missing entirely** | New pure module — the highest-value piece |
| I scheduling board | **Missing** | New page |
| J job staffing panel | **Missing** | New panel on the job page |
| K worker experience | **Missing** — middleware blocks CREW from `/admin` entirely | Needs a route-group decision before any UI |
| L time tracking | **Mostly present** | Wire clock/break/approve to assignments already done; add the missing validations |
| M rate freezing | **Present** — freeze point is ASSIGNMENT (`buildRateSnapshot` in the crew route) | Document; do NOT add a second freeze point |
| N notifications | **Missing for assignments** | Use existing queues; idempotency keys required |
| O calendar integration | **Partial** | Extend `/admin/schedule` |
| P permissions | **Partial** | Add `schedule.*`, `availability.*` in the existing style |
| Q audit events | **Mostly present** | Add scheduling/availability/override actions |
| R APIs | **Partial** | Add availability, staffing-requirement, conflict-preview, scheduling-board routes |

---

## 3. Decisions this map forces

1. **`JobCrew` IS the assignment model.** Extend it. A second model would
   split the financial record Stage 4 reads, and `buildCloseoutView` would stop
   seeing labor.
2. **The rate freeze point stays at ASSIGNMENT.** `buildRateSnapshot` runs in
   `POST /api/admin/jobs/[id]/crew`. Stage 4's durability guarantee depends on
   it. Adding a freeze at approval or finalization would create two truths.
3. **Owner labor flows through `workerType: OWNER` + `economicRateCentsSnapshot`.**
   That path already exists end to end; Stage 5 must not introduce a parallel one.
4. **The conflict engine must be pure and server-side**, called by every
   mutation path, in the style of `closeout-blockers.ts` — a list of coded
   findings with a severity, plus a separate guard that decides.
5. **Availability needs a precedence function before it needs a UI.** The
   ordering (admin block → date-specific unavailable → date-specific available →
   recurring → default unavailable) is a pure decision and should be tested
   offline first.
6. **CREW cannot currently reach any admin surface** — `middleware.ts` blocks
   `/admin` and `/api/admin` for them. Part K therefore needs a routing
   decision (a separate `/crew` route group) that is a prerequisite, not a
   detail.

---

## 4. Concurrent-branch conflict risk

`claude/pricing-system-2026-07` (`8fa8412f`, pushed, unmerged) introduces
`src/lib/pricing-config.ts` and touches `src/lib/estimate.ts` and
`app/api/bookings/route.ts`.

| File | Risk | Note |
| --- | --- | --- |
| `prisma/schema.prisma` | **High** | Both branches add to it; enum and model blocks will conflict textually |
| `src/lib/estimate.ts` | Low | Stage 5 does not touch pricing |
| `app/api/bookings/route.ts` | Low | Stage 5 does not touch booking creation |
| `package.json` (test list) | **Medium** | Both branches append test files to one line |
| `app/(admin)/.../staff/page.tsx` | Low | Pricing branch does not touch staff |

Merge order recommendation: land the pricing branch first (it is smaller and
already pushed), then rebase Stage 5 onto it, resolving `schema.prisma` and the
`npm test` line by hand.

---

## 5. Gaps in the existing code found during discovery

Recorded here rather than fixed silently:

1. **`Availability` has no timezone and stores times as strings** (`"08:00"`).
   Every scheduling comparison in Stage 5 needs an explicit zone; the repo uses
   `America/New_York` elsewhere (`booking-display.ts`, digest boundaries).
2. **`Availability` allows one row per `(userId, date)`** — it cannot express
   two blocks in a day, which D1 requires.
3. **`JobCrew` has `declinedAt` but no decline reason field**; `cancelReason`
   exists but is cancellation-specific.
4. **No `offeredAt`**, so "offered but unacknowledged for N hours" cannot be
   measured — which Part N's escalation depends on.
5. **The staff invite button is a disabled chip** pointing at a flow that does
   not exist; the page says so honestly today.
6. **`Job` has no scheduled window of its own** — it inherits
   `booking.scheduledStart/End`. Any staffing requirement model must decide
   whether the job window is the booking window or its own field.
