# Action Center architecture (increment 2, hardened 2.1)

Deterministic reminders + safe lifecycle. **No AI anywhere** in detection,
severity, resolution, or dedup — an LLM may one day *summarize* reminders, but it
never becomes the source of truth.

## Pipeline
1. **Pure rules** — `src/lib/reminder-rules.ts` evaluates plain data shapes into
   `ReminderCandidate`s. No Prisma, no clock reads (the clock is passed in), so
   every rule is offline-testable. `evaluateAll` stamps a deterministic
   `fingerprint` (FNV-1a over reminderType + severity + dueAt + description).
2. **Severity** — `src/lib/reminder-severity.ts`. All thresholds are named
   constants (no magic numbers); lead-time tiers are boundary-tested to the
   minute.
3. **Entity links** — `src/lib/entity-links.ts` is the single map of entity →
   admin URL. Returns `null` when no page exists (leads today), so a reminder
   never renders a broken link.
4. **Loader** — `src/lib/reminder-sync.ts#performSync` queries live data
   (active + 30-day-completed bookings, general expenses, pending owner txns,
   leads, customers), pre-computes money via `job-money.ts` (single source), runs
   the rules, and applies the pure diff.
5. **Sync diff** — `computeSyncActions` (pure) decides create / update /
   auto-resolve / reopen / wake **without** ever duplicating an open reminder.
   `dedupeKey` (`rule:entityType:entityId[:extra]`) is unique in the DB, so
   concurrent scans can never double-insert.

## Scan reliability (2.1)
`runScan({ trigger, force })` wraps `performSync`:
- **Advisory lock** — a Postgres *transaction* advisory lock
  (`pg_advisory_xact_lock`, key in `scan-lock.ts`) makes the "is one running? if
  not, claim it" check atomic across web + worker + Railway restarts. An
  in-memory flag would not survive multiple containers.
- **ScanRun lease** — every scan writes a `scan_runs` row (RUNNING → COMPLETED /
  FAILED) with counts + sanitized error. A RUNNING row older than
  `SCAN_STALE_MS` (5 min) is treated as crashed and superseded, so a dead
  process can never wedge the system.
- **Cooldown** — automatic scans (PAGE_LOAD/SCHEDULED) respect `SCAN_COOLDOWN_MS`
  (3 min); a refresh never rescans in a loop. An owner **Rescan now** forces
  past cooldown but never past an in-flight scan.
- **Read/scan split** — the Action Center page READS reminders and renders even
  if the scan throws (fail-open). The page shows last-success / running /
  last-failure from `getScanStatus()`.
- **Transaction tradeoff** — the sync applies in per-action batched writes (not
  one giant transaction), keyed by `dedupeKey` so re-runs are no-ops; a partial
  failure marks the ScanRun FAILED and is visible, and the next scan reconciles.

There is **no scheduled scan** in this increment (manual + page-load only). A
BullMQ cron scan is a documented roadmap item (`notifications-delivery`) — the
infra (`scheduledQueue`) supports it, but wiring it now would couple the worker
deploy to the migration, so it is deferred and gated behind a future
`REMINDER_SCAN_ENABLED` flag.

## Reminder lifecycle
```
        ┌──────── claim / assign (accountability) ────────┐
NEW ─▶ OPEN ─▶ ACKNOWLEDGED ─▶ IN_PROGRESS ─▶ RESOLVED
        │                                         ▲
        ├─▶ SNOOZED ──(snoozedUntil passes)──▶ OPEN
        └─▶ DISMISSED ──(scope decides)──▶ (may reopen)
```
- **claim** records `claimedBy*` + `claimedAt` (and acknowledges an OPEN one).
- **assign** sets `assignedOwner` (Diego/Sebastian) + `assignedBy*`/`assignedAt`.
- **resolve** records `completedBy*`.
- **auto-resolve**: a system reminder no longer detected is resolved with a
  reason; if the condition returns it **reopens**.

### Dismissal scopes (the safety fix)
"Dismissed forever" was unsafe. Scope now decides reopen:
- **OCCURRENCE** (default) — reopens when the record materially changes
  (fingerprint differs).
- **UNTIL_ENTITY_CHANGES** — reopens only on a fingerprint change.
- **PERMANENT_RULE_ENTITY** — never reopens automatically. **Owner-only**,
  **reason required**, restorable from the dismissed archive.
- **Legacy** dismissals (null scope, from increment 2) are treated as permanent
  — nothing resurfaces unexpectedly.

Dismissed reminders are never deleted. Filter `status = DISMISSED` for the
archive; owners can **Restore** any of them.

## Permissions (server-enforced)
`src/lib/permissions.ts#can(role, action)` is the gate on every route (frontend
hiding is not security). OWNER does everything; MANAGER runs operations but not
owner-financial authority. See `docs/permissions.md`.

## Audit
Every human reminder action commits the reminder update **and** its `AuditLog`
row in one `prisma.$transaction` — the log can never disagree with the state.
Dismiss → `REMINDER_DISMISSED`; restore → `REMINDER_RESTORED`; everything else →
`REMINDER_UPDATED`, with `from`/`to`, scope, reason, and actor.
