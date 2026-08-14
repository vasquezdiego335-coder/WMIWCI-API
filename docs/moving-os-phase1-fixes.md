# Moving OS Phase 1 — correctness fix pass (owner spec 2026-08-12)

Phase 1 shipped the architecture; an independent review found the DEFAULT PATHS are
not yet trustworthy. This pass fixes correctness ONLY — no new product features, no
Phase 2 work. Every item below gets a regression test.

Repo: C:\wt-moving-os, branch claude/moving-os (Phase 1 is committed as the parent
commit). Hard rules unchanged from docs/moving-os-phase1-spec.md:
- NEVER change customer-facing price constants (src/lib/pricing-config.ts,
  src/lib/service-area.ts).
- NEVER run prisma migrate / db push / any command that touches a real database.
  `npx prisma generate` is allowed. New migrations are hand-authored SQL only.
- No git commands (the orchestrator owns commits).
- Do not edit package.json (the orchestrator appends test files).
- No customer emails from admin paths.
- Admin API house pattern: getSession→401, can()→403, zod safeParse→422,
  mutation+AuditLog in ONE $transaction, apiLogger on failure.
- Fail SOFT on unapplied migrations (P2021/P2022) with an honest message.

## Item 1 — stripe_link bookings must not lose their staffing requirement
PROBLEM: `POST /api/admin/bookings` creates the Job + JobStaffingRequirement only
when the booking is created CONFIRMED (deposit modes collect_on_day / waived). The
DEFAULT owner path (`stripe_link`) creates the booking PENDING_PAYMENT with no Job;
payment moves it to PENDING_APPROVAL; `approveBooking` (src/lib/booking-approval.ts)
upserts the Job but NOTHING creates the staffing requirement — so the most-used path
lands a confirmed job with no staffing plan, which is exactly the dispatch blind spot
Phase 1 set out to close.

FIX:
1. Schema (additive): `Booking.staffingPlan Json? @map("staffing_plan")` — the
   owner's crew/truck/hours plan captured at booking time (crewSize, truckSize,
   estimatedHoursMin/Max, difficulty, flags used to build the requirement, plus
   `source: 'admin_book_move'` and the recommendation `reasons`). New migration
   folder `prisma/migrations/20260812000000_staffing_plan/migration.sql` (ADD COLUMN
   IF NOT EXISTS, same house style as 20260811000000_moving_os_phase1).
2. New shared helper `src/lib/staffing-plan.ts`:
   - `buildStaffingPlan(input)` — pure; the ONE place that turns a booking's
     serviceType + inventory + access + serviceMode + truck choice into the plan
     shape (reuse `recommendEstimate` from src/lib/estimate-assistant.ts; do not
     duplicate its math).
   - `staffingRequirementDataFromPlan(plan, { jobId, estimatedStartAt, estimatedEndAt })`
     — pure; the ONE place that maps a plan onto JobStaffingRequirement columns.
   - `ensureStaffingRequirement(tx, { jobId, booking, plan })` — IDEMPOTENT upsert
     keyed on the requirement's unique jobId (verify the unique in schema.prisma;
     if jobId is not unique, use findFirst-then-create inside the same tx and say so
     in a comment). Never throws into the caller's critical path: callers wrap it,
     but it must be safe to call twice (approve → reopen → approve).
   - When no persisted plan exists (public-form bookings, legacy rows), DERIVE one
     from the booking's own data (BookingInventoryItem rows + access columns +
     serviceType) so public bookings finally get requirements too. Mark the plan
     `source: 'derived'`.
3. Wire it:
   - Admin CONFIRMED path: persist `staffingPlan` on the booking AND call
     `ensureStaffingRequirement` (replacing the current inline creation).
   - Admin stripe_link path: persist `staffingPlan` on the booking (no Job yet).
   - `src/lib/booking-approval.ts`: inside the same transaction that upserts the Job,
     call `ensureStaffingRequirement` using the persisted plan (or a derived one).
     It must be FAIL-SOFT relative to approval: a staffing failure must never block
     capturing the deposit or confirming the booking — wrap it so approval still
     commits, and log. Comment why.
4. EXACTLY ONCE: assert idempotency in tests — approve twice / create-then-approve
   must leave exactly one requirement row with the plan's values.

TESTS (src/lib/__tests__/staffing-plan.test.ts): plan→requirement mapping; derived
plan when none persisted; idempotent ensure (second call is a no-op update, not a
duplicate); plan survives the stripe_link → approval path (simulate with fakes,
offline — mirror the fake-store style already used in booking-approval.test.ts).

## Item 2 — no invented 7:00 AM start; capture a real time
PROBLEM: Admin Book Move derives `scheduledStart` from a hardcoded 7:00 AM (or
similar hidden default), so Calendar, staffing times, and truck conflicts all key off
a time nobody chose, and free-text arrival windows are silently promoted to an exact
timestamp.

FIX:
1. `AdminBookingSchema` gains `move.startTime?: 'HH:MM'` (24h, zod-validated) next to
   the existing arrival-window text. The form gets a real time input (labelled
   "Crew start time (ET)") plus the existing arrival-window free text.
2. `scheduledStart` = the ET local combination of moveDate + startTime converted
   correctly (use the repo's existing ET helpers — see src/lib/scheduling.ts /
   waiting-time.ts for the house pattern; do NOT hand-roll a UTC offset, DST must be
   right). `scheduledEnd` = scheduledStart + the plan's max hours, following the
   existing buffer convention in src/lib/scheduling.ts.
3. NO startTime → `scheduledStart`/`scheduledEnd` stay NULL and the booking is
   day-level scheduled (confirmedDate only). NEVER parse a time out of the
   arrival-window free text, and never substitute a default hour.
4. The POST response `warnings[]` and the Book Move success panel must say plainly
   when a booking was created without a start time ("day-level scheduling — truck
   conflicts checked by day"). The truck conflict lib already treats unknown times
   conservatively; confirm that path is what runs.
5. Grep the Phase-1 code for any remaining hardcoded hour default and remove it.

TESTS (extend src/lib/__tests__/admin-booking.test.ts): startTime → correct UTC
instant for both EST and EDT dates; absent startTime → null start/end + the warning;
arrival-window text alone never produces a timestamp; scheduledEnd derives from plan
hours.

## Item 3 — preserve the selected customerId (no repeat-customer duplication)
PROBLEM: The workspace lets the owner pick an existing customer, but the POST upserts
by email — correcting or adding an email/phone creates a SECOND CRM record, breaking
repeat-customer history, lifetime value, and the first-time discount logic.

FIX:
1. `AdminBookingSchema` gains `customer.id?: string` (the picked record).
2. POST: when `customer.id` is supplied and exists, that row IS the customer.
   Update its contact fields ONLY where the owner supplied a value (never blank an
   existing email/phone; never flip consent columns; never touch isFirstTime).
   If the supplied email now belongs to a DIFFERENT existing customer, refuse with
   409 and an explicit message (do not silently merge two CRM records).
3. Only when no `customer.id` is given may the route fall back to
   upsert-by-email / create.
4. Do the customer create/update INSIDE the booking `$transaction`.
5. Audit the customer mutation (before/after contact fields) in the same transaction.

TESTS (admin-booking.test.ts + a route-level pure helper): pure
`resolveCustomerMutation({ pickedId, existing, submitted })` returning
`{mode:'use'|'update'|'create'|'conflict', data}` — blank submissions never erase
stored contact info; email-belongs-to-another-customer → conflict; picked id always
wins over email matching.

## Item 4 — staffing requirements must be service-mode aware
PROBLEM: Staffing is derived as if every job is a full-service move with our truck,
so labor-only / customer-truck / loading-only / unloading-only jobs get wrong
`customerProvidedTruck` and `requiredDrivers` values, which then drive wrong dispatch
warnings.

FIX (inside `src/lib/staffing-plan.ts`, one rule table, commented):
- Our truck assigned (booking.truckId set) → `customerProvidedTruck=false`,
  `requiredDrivers >= 1`, driver skill required.
- No truck assigned AND serviceMode is `labor_only` | `loading_only` |
  `unloading_only` → `customerProvidedTruck=true`, `requiredDrivers=0`
  (we are not driving), and the plan notes "customer provides transportation".
- `full_service` with no truck assigned → `requiredDrivers>=1` and a plan warning
  that no truck is assigned yet (this is a real ops gap, surface it honestly).
- `rentalTruckPickup` mirrors the booking's truck source when a Truck row is chosen
  (source RENTAL → true).
- `requiresLead` stays true; `minimumWorkers = max(2, required-1)` unchanged.
- Loading-only / unloading-only are single-location jobs: do not require a second
  location's access flags to be present, and say so in the plan notes.

TESTS (staffing-plan.test.ts): a matrix over {serviceMode} × {truck assigned?}
asserting customerProvidedTruck / requiredDrivers / notes for every combination.

## Item 5 — recommendedMovers must be a FLOOR, never averaged away
PROBLEM: An item requiring 4 movers can still yield a 3-mover recommendation because
the package base dominates.

FIX in `src/lib/estimate-assistant.ts`: after all adjustments,
`crewSize = clamp(max(adjustedCrew, max(item.recommendedMovers over the inventory)), 2, 5)`
and when the item floor is what decided the number, push a reason naming the item
("Piano requires 4 movers"). Keep the existing cap semantics; if an item's floor
exceeds the cap of 5, cap at 5 AND add a reason that the job may need a second trip
or outside help (never silently swallow it).

TESTS (estimate-assistant.test.ts): studio package + piano(4) → crewSize 4 with the
naming reason; 2-bedroom + pool table(3) never drops below 3; item floor above cap
→ 5 + explicit reason; existing acceptance case unchanged.

## Item 6 — structured-data parity with the public booking path
PROBLEM: Admin-created bookings skip columns the reporting/Action Center/scheduling
code depends on, so admin jobs are second-class citizens in every downstream system.

FIX in `buildBookingCreateData` (src/lib/admin-booking.ts). Read
app/api/bookings/route.ts and mirror it column-for-column where the admin form has
the data:
- Structured address components the form already collects: origin/dest
  street/city/state/zip (the `origin_*` / `dest_*` columns), plus the composed
  single-line strings.
- `serviceAreaZone`, `travelFee`, `travelFeeDueOnMoveDay` from the server-side
  `checkServiceArea` call (already done — ensure ALL of its outputs are persisted).
- `manualReviewRequired` + `reviewReasons` via the same `buildReviewReasons` helper
  the public route uses (src/lib/booking-review.ts), so review-gated charges and
  Action Center rules behave identically.
- `bedrooms` (already), `numBoxes` derived from inventory rows whose catalog
  category is boxes, `estimatedCubicFeet` ONLY if a real derivation exists — do not
  invent one.
- Service booleans (needsPacking/Unpacking/Assembly/Disassembly) and specialty flags
  (hasPiano/hasSafe/hasPoolTable/hasAppliances) set from the inventory + services
  the form captured, matching how the public route sets them.
- ADDRESS VERIFICATION HONESTY: run the SAME server-side verification the public
  route runs (`src/lib/address-verify.ts` or whatever it imports) when it is
  configured; persist its REAL result. If it is not configured or fails, leave the
  verification columns unverified/null — NEVER write 'verified' for an address that
  was not validated, and let `booking-address-unverified` fire honestly.

TESTS (admin-booking.test.ts): every structured column asserted against a sample
payload; unverified-by-default when no validation ran; reviewReasons populated for a
review-gated input (e.g. a 400lb+ heavy item); numBoxes derivation; no fabricated
cubic feet.

## Item 7 — Action Center kick must be reliable or honestly reported
PROBLEM: The POST fires `syncReminders` fire-and-forget and the success panel claims
the scan was kicked unconditionally, so a silent failure reads as success.

FIX: await the kick with a short timeout (or run it and capture the outcome),
returning `actionCenterScan: 'completed' | 'skipped_cooldown' | 'failed'` in the POST
response (never throw — a scan failure must not fail the booking). The success panel
renders the real outcome, and on `failed` it links to /admin/action-center with
"scan did not run — open the Action Center to refresh". Read src/lib/reminder-sync.ts
first: honor its cooldown/lock semantics and use its real return value rather than
inventing states.

TESTS: a pure mapper `describeScanOutcome(result | error)` → the three states, tested
offline.

## Item 8 — verify auth on the new admin surfaces
FIX: Confirm by reading `middleware.ts` that `/admin/book`, `/admin/trucks`,
`/admin/leads`, `/admin/leads/[id]`, and every new `/api/admin/*` route added in
Phase 1 (bookings POST, trucks, trucks/[id], leads, leads/[id], estimate/recommend,
customers/search, inventory/catalog) are covered by BOTH `PROTECTED_ROUTES` and
`config.matcher` — the repo has a live precedent where a path was in the allowlist
but absent from the matcher, so the gate silently never ran (/api/files/upload).
Extend the matcher where needed WITHOUT weakening any existing rule. Every page must
also be gated by its layout session check (verify, don't assume).

TESTS (src/lib/__tests__/admin-route-coverage.test.ts): a pure test that walks the
matcher patterns and asserts each of the new paths (including a concrete `[id]`
instance like /api/admin/leads/abc123) matches a matcher entry and resolves to the
intended role set. Follow the existing admin-csrf-guard.test.ts style.

## Item 9 — truck-conflict concurrency
PROBLEM: The conflict check runs BEFORE the transaction, so two near-simultaneous
creates can both pass and double-book one truck.

FIX: inside the booking `$transaction`, when a truckId is present:
1. Take a Postgres transaction advisory lock keyed on (truck, ET day) — the repo
   already uses `pg_advisory_xact_lock` in src/lib/scan-lock.ts; follow that pattern
   (hash the key to a bigint deterministically; document the key derivation).
2. RE-RUN the conflict query inside the lock and abort the transaction (throw a typed
   error the route maps to 409) unless `truckConflictOverride` is true.
3. The pre-transaction check stays as the fast/friendly path for the UI.
Document that the lock is per (truck, day) so unrelated bookings never serialize.

TESTS: a pure test for the lock-key derivation (stable, collision-resistant, same key
for the same truck+day across DST) and a fake-tx test proving the in-transaction
re-check throws the 409-mapped error when a conflicting booking appears between the
pre-check and the commit.

## Item 10 — review bundle (orchestrator-owned, no agent work)
The ZIP dropped every `[id]` path because PowerShell globbing treats `[id]` as a
character class. Rebuild with -LiteralPath and verify manifest == contents.

## Definition of done
`npx tsc --noEmit` clean; every new/updated test green via `npx tsx --test <file>`;
the pre-existing 18 pricing-parity failures are the ONLY acceptable test failures;
`npm run build` attempted and its real result reported (env-related build failure is
reported honestly, not hidden).
