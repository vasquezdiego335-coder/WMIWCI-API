# Stage 5 — crew management and scheduling

**Branch `claude/stage5-crew-scheduling`, on `origin/main` @ `a4833a5b0` + the
`main` test-registration hotfix.** This document is the built system, not a plan.
The discovery map (`stage5-implementation-map.md`) is the planning record.

## Architecture — JobCrew stays canonical

`JobCrew` is THE assignment and labor record, and Stage 4 reads every labor cost
from it. Stage 5 **extends** it rather than adding a competing table, so the
closeout keeps seeing the same labor. New supporting tables hang off the
existing `User` / `Job` / `JobCrew` records; none is a second source of truth.

## Schema

### Extended

* **User** — `workerStatus` (`WorkerStatus`), `skills` (`CrewSkill[]`),
  `licenseExpiresAt`, `canDriveCustomerVehicle`, `startDate`, `deactivatedAt`,
  `deactivationReason`, `createdById`, `updatedById` (alongside the Stage 4
  `canDrive`, `canLeadCrew`, rate block).
* **JobCrew** — `offeredAt`, `acknowledgedAt`, `acknowledgmentStaleAt`,
  `declineReason`, `removedAt`, `removalReason`, `completedAt`, `noShowAt`,
  `reportTime`, `isDriver`, `workerVisibleNotes`, `privateAdminNotes`.
* **Job** — relation to `JobStaffingRequirement`.

### New tables

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `AvailabilityRule` | recurring weekly blocks, minutes-from-midnight in a stored `timezone` | index `(userId, dayOfWeek)`; FK → users `onDelete: Cascade` |
| `AvailabilityException` | date-specific overrides | index `(userId, date)`, `(date)`; FK cascade |
| `JobStaffingRequirement` | what a job needs | **unique `jobId`**; FK → jobs cascade |
| `CrewInvitation` | pending invite + expiring token | **unique `token`**; index email, status |
| `ConflictOverride` | documented waive of a warning | index jobId, jobCrewId |
| `AssignmentNotification` | per-notification state | **unique `dedupeKey`** (idempotency) |

### New enums

`WorkerStatus` ACTIVE·INACTIVE·ON_LEAVE·UNAVAILABLE·SUSPENDED
`CrewSkill` PACKING·FURNITURE_PROTECTION·ASSEMBLY·HEAVY_ITEMS·STAIR_CARRY·DRIVING·LEAD·LOADING·UNLOADING
`AvailabilityExceptionKind` ADMIN_BLOCK·UNAVAILABLE_FULL·UNAVAILABLE_PARTIAL·AVAILABLE_OVERRIDE·VACATION·LEAVE
`InvitationStatus` PENDING·ACCEPTED·EXPIRED·CANCELLED

Plus 24 `AuditAction` values (staff, availability, assignment, conflict).

### Migration

`20260722000000_stage5_crew_scheduling` — **additive only** and idempotent:
enums via `duplicate_object` guards, tables via `CREATE TABLE IF NOT EXISTS`,
columns via `ADD COLUMN IF NOT EXISTS`, FKs via `duplicate_object` guards, enum
values via `ADD VALUE IF NOT EXISTS`. No Stage 4 financial data is touched.

**Rollback risk: low.** Dropping the new tables/columns restores the prior
state. Enum-value additions cannot roll back inside a transaction, but nothing
in the migration uses the new values in the same transaction, so a partial
failure is safely re-runnable.

## Availability precedence

Pure, in `availability-engine.ts`, tested offline. Highest wins:

1. administrative hard-unavailable (per-worker `ADMIN_BLOCK` or business `DayBlock`) → **UNAVAILABLE, hard**
2. date-specific unavailable (`UNAVAILABLE_FULL` / `VACATION` / `LEAVE`, or an overlapping `UNAVAILABLE_PARTIAL`) → UNAVAILABLE
3. date-specific `AVAILABLE_OVERRIDE` covering the whole window → AVAILABLE
4. recurring rule for that weekday covering the whole window (within effective range) → AVAILABLE
5. default → **UNAVAILABLE**

A window is available only if **fully** covered — a partial overlap is not
availability. `availability-service.ts` converts a real UTC window to the
worker's local minutes (DST-correct via `Intl`) before calling the engine; an
overnight window is evaluated on the start date with the end minute wrapped past
24h, so it is not silently split.

## Staffing requirements + health

`JobStaffingRequirement` carries the counts, driver/lead needs, required skills,
times, characteristics (stairs, elevator, heavy, packing, out-of-state…), and
worker-visible vs private notes. `staffing-health.ts` derives one headline:
`UNSTAFFED · UNDERSTAFFED · MISSING_DRIVER · MISSING_LEAD · MISSING_SKILL ·
OVERSTAFFED · UNACKNOWLEDGED · CONFLICTED · FULLY_STAFFED · READY`, by precedence,
plus the supporting flags.

## Assignment lifecycle

Over the **existing** `CrewAssignmentStatus`. Legal transitions
(`assignment-lifecycle.ts`):

```
INVITED   → OFFERED, ASSIGNED, CANCELLED, DECLINED
OFFERED   → ACCEPTED, DECLINED, ASSIGNED, CANCELLED
ACCEPTED  → ASSIGNED, IN_PROGRESS, CANCELLED, NO_SHOW, DECLINED
ASSIGNED  → IN_PROGRESS, CANCELLED, NO_SHOW, COMPLETED
IN_PROGRESS → COMPLETED, CANCELLED, NO_SHOW
DECLINED  → OFFERED, ASSIGNED     (re-offer / re-assign)
CANCELLED → OFFERED, ASSIGNED     (re-open onto same worker)
COMPLETED, NO_SHOW → terminal
```

A **material** change (start, end, report time, either address, role,
driver/lead) after acknowledgment sets `acknowledgmentStaleAt`, re-requests
acknowledgment, and replaces the reminders. Notes are not material.

## Conflict engine + codes

Pure, `conflict-engine.ts`, called by every mutation path.

| Code | Severity |
| --- | --- |
| `ASSIGNMENT_ON_CANCELLED_JOB` | HARD_BLOCK |
| `INACTIVE_WORKER` | HARD_BLOCK |
| `SUSPENDED_WORKER` | HARD_BLOCK |
| `DUPLICATE_ASSIGNMENT` | HARD_BLOCK |
| `START_AFTER_END` | HARD_BLOCK |
| `INELIGIBLE_DRIVER` | HARD_BLOCK |
| `EXPIRED_LICENSE` | HARD_BLOCK |
| `ADMIN_UNAVAILABLE` | HARD_BLOCK |
| `OUTSIDE_AVAILABILITY` | OVERRIDABLE_WARNING |
| `DATE_UNAVAILABLE` | OVERRIDABLE_WARNING |
| `OVERLAPPING_ASSIGNMENT` | OVERRIDABLE_WARNING |
| `INSUFFICIENT_TRAVEL_BUFFER` | OVERRIDABLE_WARNING (estimated) |
| `PREVIOUS_JOB_ENDS_LATE` | OVERRIDABLE_WARNING |
| `EXCESSIVE_SHIFT` | OVERRIDABLE_WARNING |
| `INSUFFICIENT_BREAK` | OVERRIDABLE_WARNING |
| `MISSING_RATE` | OVERRIDABLE_WARNING |
| `ASSIGNMENT_OUTSIDE_JOB_WINDOW` | OVERRIDABLE_WARNING |
| `TIME_CHANGED_AFTER_ACK` | OVERRIDABLE_WARNING |
| `UNDERSTAFFED` | OVERRIDABLE_WARNING |
| `MISSING_DRIVER` | OVERRIDABLE_WARNING |
| `MISSING_LEAD` | OVERRIDABLE_WARNING |
| `MISSING_SKILL` | OVERRIDABLE_WARNING |
| `OVERSTAFFING` | OVERRIDABLE_WARNING |
| `UNRESOLVED_FUTURE_ASSIGNMENT` | HARD_BLOCK (deactivation) |
| `REQUIREMENTS_CHANGED_AFTER_ACK` | INFORMATIONAL |
| `NO_STAFFING_REQUIREMENT` | INFORMATIONAL |
| `UNACKNOWLEDGED` | INFORMATIONAL |

`evaluateConflicts(conflicts, overriddenCodes)` is the guard: proceed only when
nothing hard-blocks and every warning has a recorded override. An override
requires `schedule.override_conflicts` (owner-only) **and** a reason, and writes
a `ConflictOverride` row + a `CONFLICT_OVERRIDDEN` audit entry.

**Travel time is estimated.** No routing provider is wired in. The buffer check
uses a configured minute buffer (`travelBufferMinutes` 60, halved to
`sameAddressBufferMinutes` 15 when addresses match) and every finding it raises
carries `estimated: true` and the word "estimated". It never claims a real drive
time.

## Rate freezing — one point, unchanged

The rate is frozen at **assignment** by `buildRateSnapshot` in
`POST /api/admin/jobs/[id]/crew`, exactly as Stage 4 requires. Stage 5 adds no
second freeze point. Owner labor flows through `workerType: OWNER` +
`economicRateCentsSnapshot`; crew through the cash/flat/day snapshot. A later
profile change never restates a frozen assignment.

## Time tracking

`labor-clock.ts` is the pure state machine (no clock-out before clock-in, no
double clock-in, no break outside a shift, no second running break, open break
auto-closed at clock-out). Both the admin clock route and the crew clock route
call it, so they cannot drift. `recalcAssignment` derives worked/paid minutes
and the overtime split; the closeout reads the result.

## Permissions

| Action | OWNER | MANAGER | CREW |
| --- | --- | --- | --- |
| `staff.view` | ✅ | ✅ | ❌ |
| `staff.manage` / `staff.invite` / `staff.deactivate` | ✅ | ❌ | ❌ |
| `staff.manage_availability` | ✅ | ✅ | ❌ |
| `schedule.view` / `schedule.manage` | ✅ | ✅ | ❌ |
| `schedule.override_conflicts` | ✅ | ❌ | ❌ |
| `assignment.view_own` / `assignment.acknowledge_own` | ✅ | ✅ | ✅ |

CREW reach `/crew` and `/api/crew` only (middleware); route handlers enforce
own-assignment ownership. They still cannot reach `/admin`. All Stage 4 masking
(owner money, owner rates, closeouts) is unchanged.

## Audit events

`STAFF_INVITED`, `INVITATION_RESENT`, `INVITATION_CANCELLED`,
`INVITATION_ACCEPTED`, `STAFF_DEACTIVATED`, `STAFF_REACTIVATED`,
`STAFF_PROFILE_UPDATED`, `STAFF_SKILLS_CHANGED`, `STAFF_DRIVER_STATUS_CHANGED`,
`AVAILABILITY_RULE_CREATED/UPDATED/DELETED`,
`AVAILABILITY_EXCEPTION_CREATED/DELETED`, `STAFFING_REQUIREMENT_CHANGED`,
`ASSIGNMENT_OFFERED/ACKNOWLEDGED/DECLINED/REPLACED/DRIVER_CHANGED/LEAD_CHANGED/COMPLETED/NO_SHOW`,
`CONFLICT_OVERRIDDEN` — plus the existing `CREW_*` labor actions for
clock/break/approve.

## Notifications

`crew-notifications.ts`. Idempotency via `AssignmentNotification.dedupeKey`:
re-enqueuing the same key never doubles a message. A material change cancels
obsolete reminders (`cancelObsoleteReminders`) before scheduling replacements
(`replaceAssignmentReminders`). Importing the module never starts a worker.

**Delivery status (verified in the 2026-07 staging rehearsal): LEDGER-ONLY.**
The `AssignmentNotification` rows are written idempotently, but no queue job is
enqueued and no worker consumes them yet — `sentAt`/`providerResult` stay null.
Nothing contacts a worker until a delivery worker is wired to the ledger (SMS or
email through the existing lazy queue getters). This is deliberate for launch
safety (no accidental sends), and it means the "workers get told" half of Part N
is a documented follow-up, not a shipped behavior.

## APIs

| Route | Verb | Notes |
| --- | --- | --- |
| `/api/admin/jobs/[id]/staffing` | GET · PUT | context · requirement |
| `/api/admin/jobs/[id]/crew` | POST | assignment create (rate freeze) — extended with driver/report/notes |
| `/api/admin/crew-assignments/[id]/schedule` | POST | offer/ack/decline/cancel/no-show/complete + driver/lead + schedule edit (re-runs conflicts) |
| `/api/admin/crew-assignments/[id]/clock` | POST | admin clock |
| `/api/admin/conflicts/preview` | POST | run engine without saving |
| `/api/admin/staff/[id]/availability` | GET · POST | rules + exceptions |
| `/api/admin/staff/[id]/availability/[itemId]` | DELETE | remove rule/exception |
| `/api/admin/staff/[id]/profile` | PATCH | skills, driver, license, status |
| `/api/admin/staff/[id]/deactivate` | POST | deactivate/reactivate |
| `/api/admin/staff/invitations` | GET · POST | list · create |
| `/api/admin/staff/invitations/[id]` | POST | resend/cancel |
| `/api/admin/scheduling` | GET | board data |
| `/api/crew/assignments` | GET | own assignments (worker-safe) |
| `/api/crew/assignments/[id]` | POST | acknowledge/decline own |
| `/api/crew/assignments/[id]/clock` | POST | crew clock (own only) |

Every write route: auth, authorization, zod validation, transition + conflict
validation, transactional persistence, audit, safe error codes.

## Pages

`/admin/scheduling` · `/admin/staff` (enhanced) · `/admin/staff/[id]` ·
`/admin/jobs/[id]` (Staffing card) · `/crew` (worker home). Each has loading,
empty, error and permission-denied states in the Ink Navy / Bone White / Ember
Orange / Antique Gold palette.

## Invitation onboarding — the one external dependency

The invitation model and admin flow are complete. Turning an **accepted**
invitation into a login account depends on the auth onboarding path, which is
not a self-serve flow yet (accounts are created by the `hash-password` + seed
script). The token is the acceptance credential; account creation is picked up
by the onboarding step. Nothing silently creates credentials. This is stated in
the invite panel and here, not faked.

## Staging + rollback

1. Review the Stage 5 PR; confirm the migration and code are in it.
2. Back up production Neon (branch from `production`).
3. Merge.
4. Railway runs `npx prisma migrate deploy` (this repo does NOT migrate in the
   build — see `nixpacks.toml`).
5. `npx prisma migrate status` → `Database schema is up to date!`
6. Confirm health.

Rollback: the migration is additive; if a defect surfaces, revert the code
deploy — the new columns/tables are harmless when unused. Do not drop columns on
a live database without a follow-up migration.

## Verification at this commit

```
git diff --check     clean
npx prisma validate  valid
npx prisma generate  ok
npx tsc --noEmit     0 errors
npm test             1136/1136 pass   (1037 at branch point)
npm run build        Compiled successfully
```

Stage 5 test files: `availability-engine` (24), `conflict-engine` (28),
`assignment-lifecycle` (12), `scheduling-guards` (11), `labor-clock` (8),
`stage5-permissions` (5), `invitation-service` (6), `stage5-stage4-integration`
(7). All registered in `npm test`.

## Final pipeline rehearsal

Still **deferred**. The full booking → job → **staffing → scheduling** →
closeout rehearsal now has an implementation for every step, but it has not been
run against a database (production holds 0 closeouts and 0 snapshots). The plan
is `stage4-rehearsal-plan.md`; its previously-blocked steps (6, 9–14, 38) are now
buildable. Run it only after Stage 5 is deployed and the operator authorizes it.
