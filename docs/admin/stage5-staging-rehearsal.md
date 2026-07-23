# Stage 5 — staging rehearsal record (2026-07-22/23)

**Branch `claude/stage5-staging-rehearsal`** (continuation of
`claude/stage5-crew-scheduling` @ `1085301a`, based on `origin/main` @
`a4833a5b0`). This is the record of the first full run of Stage 5 against a
REAL database and the complete application runtime — the step the Stage 5 build
doc listed as deferred.

## Environment

* Disposable local PostgreSQL 17.5 (embedded, UTF8, port 54329) — **never Neon**.
* `.env` sanitized: `DATABASE_URL` → local staging DB, `REDIS_URL` → dead port,
  Resend/Discord/Twilio/Stripe keys disabled, `OUTBOX_ENABLED=false`. Nothing in
  this rehearsal could reach a real worker, customer, queue or payment rail.
* App: `next build` + `next start` (production runtime, not dev).
* Fixtures: `scripts/stage5-staging-fixtures.ts` — deterministic, prefix
  `s5fix`, all emails `@staging.local`, refuses non-local databases,
  `--clean` removes everything. 7 users + 1 pending invite + 12 jobs
  (unstaffed / staffed / understaffed / driver-required / skill-required /
  overlapping pair / Sunday outside-availability / override-eligible /
  completed-profit / completed-loss / owner-labor) + recurring rules,
  vacation, Sunday AVAILABLE_OVERRIDE and a partial-day-off exception.

## Migration verification

* `20260722000000_stage5_crew_scheduling` applied to a **Stage 4-populated**
  database via real `npx prisma migrate deploy` (main's 36 migrations
  baselined, exactly as production would run it): success; pre-existing users
  and JobCrew rows read back valid with correct defaults; rate snapshots
  untouched; all 6 new tables present. Re-running the migration SQL a second
  time is a no-op (idempotency guards verified).
* **Schema ↔ SQL agreement is exact**: main schema + this migration vs
  `schema.prisma` → `prisma migrate diff` = empty.
* **Fresh database from zero CANNOT run `migrate deploy`** — pre-existing,
  repo-wide: the earliest migration (`20260525…`) ALTERs `bookings`, which no
  migration creates. Production was baselined outside the migration ledger.
  Any new environment must be baselined the same way (apply the schema, mark
  migrations applied) — this is NOT a Stage 5 defect and Stage 5 does not
  change it.
* Rollback: additive-only; revert the code deploy and leave the columns.

## What was rehearsed (all against the running app over HTTP)

| Area | Result |
| --- | --- |
| Permissions matrix (owner/manager/crew/anon × every Stage 5 route, page gates, IDOR probes) | 26/26 |
| Staff profile editing + validation + audit | pass |
| Deactivation (reason required, future-work 409, resolve-and-cancel, history preserved, reactivation) | pass |
| Invitations (create/duplicate/existing/invalid/OWNER-refused/resend/cancel/token hygiene/audits) | pass |
| Availability engine (rule windows, exceptions, precedence, boundaries, cross-midnight, DayBlock, ADMIN_BLOCK, no-rules default) | 17/17 |
| Conflict engine — every reachable code exercised live | pass (see matrix below) |
| Assignment lifecycle (create+freeze, duplicate, ack, material change → stale ack, re-ack, offer flow, cancel/revive, delete guards) | pass |
| Override discipline (owner-only, reason required, whitespace refused, stored + audited, per-save only, hard blocks never overridable) | pass |
| Rate freeze (profile change never rewrites a snapshot; new assignment freezes the new rate; historical closeout untouched) | pass |
| Stage 4 closeout — profitable / loss / owner-labor, full workflow to FINALIZE | 22/22 |
| Scheduling board (contents, health labels, ordering, range filter, empty state, page render) | 11/11 |
| Crew portal (own-rows only, worker-safe fields, clocking state machine, inactive refusal, IDOR) | 15/15 |
| Notifications ledger (dedupe keys, idempotent replays, CHANGED/CANCELLED/OFFERED/ASSIGNED) | pass |
| Audit coverage (every rehearsed mutation, no token leakage) | pass |
| End-to-end Part R workflow (32 numbered steps, one continuous run) | 20/20 checks |
| Performance (board 73 ms @ 69 jobs, conflict preview avg 28 ms) | pass |
| Races (duplicate create → unique-index backstop holds; duplicate clock-in → single open shift) | pass |

## Stage 4 numbers confirmed (fixtures)

* **Profitable** — $1,000.00 collected, frozen labor 4 h × $25.00 = $100.00 →
  company net profit $900.00. With 30% tax reserve: tax reserve **$270.00**,
  unpaid-approved-labor holdback **$100.00**, distributable **$530.00** split
  EQUAL → Diego $265.00 / Sebastian $265.00. Finalize snapshots all of it;
  re-reads are byte-identical. (The existing Stage 4 logic allocates **net
  profit** after liabilities — not gross revenue.)
* **Loss** — $150.00 collected vs $208.00 labor → company net −$58.00;
  distributable clamps to $0, no negative distribution, finalize still works.
* **Owner labor** — 4 h × $50.00 economic rate: `ownerEconomicLaborCents`
  $200.00, **zero cash wage**, cash profit $600.00, economic profit $400.00,
  labor state never MISSING_RATE, owner never becomes a payroll employee.

## Defects found and FIXED during the rehearsal

1. **Assignment CREATION bypassed the conflict engine entirely**
   (`POST /api/admin/jobs/[id]/crew`). A direct POST could put a suspended,
   unavailable, license-expired or double-booked worker on a job with no
   record. Creation now runs the same engine + `canSaveAssignment` guard as
   the schedule route; warnings need an owner override + written reason, which
   is stored as `ConflictOverride` + audited; both admin panels surface the
   conflicts and offer the owner override flow.
2. **Deactivated crew kept portal access** — sessions are stateless 7-day
   JWTs and no `/api/crew` route re-checked the live row. New pure guard
   `isPortalEligible` (unit-tested) now runs on every crew route and the
   `/crew` page; verified live: a deactivated worker with a still-valid cookie
   gets 403 on list/act/clock.
3. **`PREVIOUS_JOB_ENDS_LATE` misfired for later-week shifts** — any future
   booking "ended after" the report time, so a Thursday job spammed warnings
   on a Monday assignment. The engine now requires the other shift to actually
   precede the assignment (regression-tested both directions).
4. **A worker could never re-acknowledge after a material change** — the crew
   ACKNOWLEDGE action always tried `→ ACCEPTED`, illegal from ASSIGNED, so the
   staled acknowledgment was permanent. Acknowledging an ASSIGNED/IN_PROGRESS
   row now stamps `acknowledgedAt` and clears the stale flag without a status
   change; OFFERED still transitions to ACCEPTED.
5. **`CONFLICT_OVERRIDDEN` audit had no target** — the schedule route's audit
   entry omitted the jobCrewId/worker; both are recorded now.
6. Hardening: staffing requirement cross-field validation (drivers ≤ workers,
   min ≤ required); invitation list no longer returns raw tokens; invalid
   dates on profile/availability writes now 422 instead of 500; new-assignment
   notification (`ASSIGNED` ledger type) recorded once, idempotently.

## Known limitations (documented, deliberately not "fixed" here)

* **Notification DELIVERY is ledger-only** — see the note in
  `stage5-crew-scheduling.md`. No worker is contacted until a delivery worker
  consumes `AssignmentNotification`.
* **Invitation acceptance / account creation stays external** (hash-password +
  seed path). The E2E rehearsal performed the documented external step
  explicitly; nothing fakes completion.
* **Concurrent duplicate invitations** can both land (no partial unique index
  on pending email). Owner-only endpoint, sequential duplicates are refused,
  both rows are cancellable — accepted as a documented race.
* **Preview `MISSING_RATE` is lenient** for ACTIVE workers (by design — the
  rate resolves precisely at assignment; creation guards the
  hourly-with-no-rate case and the closeout hard-blocks MISSING_RATE).
* **Fresh-database bootstrap** needs baselining (see migration section).

## Deployment requirements (unchanged from the build doc, plus)

1. Back up production Neon (branch from `production`).
2. Merge order: this branch supersedes `fix/main-test-registration` (patch-
   identical hotfix commit is already carried; close the hotfix PR or merge it
   first — either way the package.json test line resolves to this branch's).
3. Railway runs `npx prisma migrate deploy` (never `db push`).
4. `npx prisma migrate status` → up to date; smoke `/admin/scheduling`,
   `/admin/staff/[id]`, `/crew` with a crew account.
5. The notification delivery worker remains OFF until wired + tested with a
   safe recipient.

## Reproducing

```bash
# one-time: local Postgres on 54329 (any disposable instance works)
npx tsx scripts/stage5-staging-fixtures.ts          # seed (refuses non-local DBs)
npx tsx scripts/stage5-staging-fixtures.ts --clean  # teardown
```

Fixture password for every staging account: `Stage5!staging`.
