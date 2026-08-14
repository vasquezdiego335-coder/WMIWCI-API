# Moving OS — P0 review + repair (owner spec 2026-08-13)

Not Phase 2. Close the correctness problems that stop Diego trusting the system while
booking fast. The priorities, in the owner's words: **no fake time, no fake scan, no
duplicate truck, no missing crew plan, no misleading customer promise, no silent
migration failure, no unprofitable quote accepted blindly.**

## Method (non-negotiable)
1. **Inspect actual code.** Do not trust test names, comments, or docs without
   verifying. This codebase has burned three rounds on exactly that: tests asserting
   adjacent behavior, a comment vouching for behavior a template did not have, and a
   comment-stripper that was a silent no-op on CRLF so every negative source guard was
   satisfiable by a comment merely naming the old code.
2. **Trace the DEFAULT path** end to end and judge every fix against it:
   admin Book Move → `deposit.mode = 'stripe_link'` → **PENDING_PAYMENT** → Stripe
   checkout paid → PENDING_APPROVAL → `approveBooking` → CONFIRMED.
3. **Build fixtures with the shipped writer** (`buildBookingCreateData`), never by
   hand. Two verdicts were lost to fixtures inventing columns production never writes.
4. Day-level bookings are real: if the owner entered no start time, **never** invent
   12:00 AM, 7:00 AM, or any other hour.
5. Never change customer-facing pricing constants (`pricing-config.ts`,
   `service-area.ts`). Never run migrations or deploy. Never remove existing work.
6. Every admin write: auth + permission + validation + audit + server-side enforcement.
7. **No message may claim** something was sent, scanned, included, verified, scheduled,
   or current unless the code can prove it.

---

## A. Truck holds must use the real estimated duration
**Problem.** The default `stripe_link` booking is PENDING_PAYMENT and persists
`truckId` + `requestedDate`, but NOT `scheduledStart`/`scheduledEnd` (those are written
at confirmation). Truck conflict detection therefore falls back to a fixed 6-hour hold
and ignores `Booking.estimatedHours` — which `buildBookingCreateData` already saves. A
long 4BR/5BR job whose estimated window crosses midnight occupies only ONE ET day in
detection, so the next-day-early booking is not refused, even though the identical
CONFIRMED job would be.

**Fix goal.** A PENDING_PAYMENT hold occupies the same operational truck window the
estimate implies: use `max(real estimated window, fallback)`, falling back to 6 hours
only when there is no better data.

**Acceptance**
- `TRUCK_CANDIDATE_SELECT` carries `estimatedHours` (and whatever else the window needs).
- `TruckBookingShape` carries `estimatedHours` or equivalent.
- `truckOccupiedEtDays` and conflict detection preserve the LONGER of the estimated and
  fallback windows.
- Advisory-lock day keys and conflict day-span logic stay consistent with each other —
  a window that spans two ET days must lock both and be detected on both.
- Test with a **writer-built** PENDING_PAYMENT row: a long job (4BR/5BR or high
  `estimatedHours`) starting afternoon/evening whose estimated window crosses midnight.
  The next-day-early second booking must be refused exactly as it would be for a
  confirmed job.

Files: `src/lib/truck-conflicts.ts`, `src/lib/truck-lock.ts`, `src/lib/admin-booking.ts`,
`app/api/admin/bookings/route.ts`, and the three truck test files.

## B. Remove every false Action Center coverage claim
**Problem.** The server-side messages were made honest, but
`BookMoveForm.tsx` still carries a fallback string *"Action Center rescanned — this
booking is included"*. A claim that survives as a client fallback is still a claim.

**Fix goal.** No owner-facing string claims included / current / scanned-into-list
unless the scan genuinely loaded that booking's status AND the predicate matches the
real loader in `reminder-sync.ts`.

**Acceptance**
- The old fallback claim is gone from `BookMoveForm.tsx`.
- Repo-wide search for: `is included`, `already current`, `this booking is included`,
  `scan kicked`, and near-variants. Every hit is either removed or provably true.
- A test FAILS if any of those phrases reappears in owner-facing scan code. Write it as
  a source guard over the real files — and make sure the guard actually reads code, not
  comments (see the CRLF lesson in Method §1).

Files: `src/lib/scan-lock.ts`, `src/lib/reminder-sync.ts`,
`app/api/admin/bookings/route.ts`, `BookMoveForm.tsx`, `action-center-kick.test.ts`.

## C. The last 12:00 AM leaks (Discord commands)
**Problem.** `src/bot/command-handler.ts` defines `fmtDate` with
`dateStyle:'medium', timeStyle:'short'` and applies it to `requestedDate`/`confirmedDate`,
so `/booking` (and any `/schedule`-style listing) still prints **12:00 AM** for a
date-only move. Seven other surfaces were fixed; this one was outside the previous
contract's file list.

**Fix goal.** Every Discord command surface uses the shared booking-aware formatter.

**Acceptance**
- `/booking` lookup shows no hour for a date-only job.
- Any `/schedule`-style listing shows no hour for a date-only job.
- Timed jobs still show their real hour.
- Tests or source guards genuinely cover `command-handler.ts` (it was previously
  uncovered, which is why this leaked).

Files: `src/bot/command-handler.ts`, `src/lib/booking-display.ts`,
`src/lib/scheduling.ts`, `src/lib/__tests__/day-anchor-display.test.ts`.

## D. Make test/build protection real
**Problem.** `package.json`'s `test` script enumerates ~140 files by name, and ~18 of
them fail on `main` already (pricing-parity, comparing against a generated mirror in a
separate site repo that has drifted). A new correctness regression hides inside that
noise. Deployment does not run tests at all.

**Fix goal.** A practical pre-deploy verification path a human can actually run, which
separates KNOWN baseline failures from NEW moving-OS correctness failures.

**Acceptance**
- A dedicated runner covering ONLY the moving-OS correctness tests, wired as
  `test:moving-os`. Implement it as `scripts/test-moving-os.mjs` with the file list in
  ONE place (the orchestrator adds the npm script; do not edit package.json yourself).
  It must exit non-zero on any failure and print a clear pass/fail summary.
- Every moving-OS correctness test is in that list: admin-booking, admin-review-parity,
  admin-customer-locale, admin-route-coverage, estimate-assistant, staffing-plan,
  staffing-repair-triggers, day-level-scheduling, day-anchor-display,
  approval-deploy-window, truck-conflicts, truck-hold, truck-lock, lead-transitions,
  action-center-kick, plus anything this P0 round adds. Verify each file EXISTS
  (a previous pass listed a filename that did not exist and would have broken the suite).
- Document the exact pre-deploy command order in `docs/deployment.md`:
  typecheck → moving-os tests → migration preflight → backup → migration → postcheck.
- Call out the pricing-parity failures clearly as a known, separate baseline problem —
  do NOT fix them here.

## E. Migration-window honesty
**Problem.** Migrations are hand-applied, so code-before-SQL is a NORMAL state. The
approval path got a degraded-read ladder, but other reads/scans/pages may still use
`include`/full-row reads that throw P2022 before the new columns exist — and Prisma
expands `$scalars` from the GENERATED schema, so a query that names no new column still
breaks.

**Fix goal.** On critical paths, either survive the missing column or fail with an
honest "migration not applied" message BEFORE any partial or misleading action.

**Acceptance**
- Approval must never capture money and silently skip staffing because a migration is
  missing. (Either both, or an honest failure before the capture.)
- Booking create must fail BEFORE writing anything if required migration columns are
  absent.
- Action Center failure during the migration window is honest — it must not claim
  coverage.
- Any remaining non-critical page that may 500 before SQL is applied is DOCUMENTED
  (a listed, known degradation is acceptable; a silent wrong result is not).

Files: `src/lib/booking-approval.ts`, `app/api/admin/bookings/[id]/status/route.ts`,
`src/lib/reminder-sync.ts`, `app/my-booking/[token]/page.tsx`,
`app/(admin)/admin/(dashboard)/jobs/page.tsx`, `src/outbox/services/premiumEmails.tsx`,
`src/lib/fulfillment.ts`, `app/api/admin/bookings/route.ts`.

### E — what was built (2026-08-14)

`src/lib/migration-window.ts` is now the ONE place that knows which columns and
tables a running deploy may be ahead of, and how to read a booking without them:

* `PENDING_MIGRATIONS` / `MIGRATION_BOOKING_COLUMNS` / `MIGRATION_TABLES` — the
  at-risk set, **pinned against the migration SQL by test**
  (`src/lib/__tests__/migration-window.test.ts` parses
  `prisma/migrations/*/migration.sql` and fails if the constants drift, or if a
  newer migration directory appears that nobody classified).
* `bookingScalarSelect()` — every Booking column the GENERATED client declares
  MINUS those. Derived, not hand-listed, because a hand-maintained list is what
  rotted in round 3. Any other column is guaranteed present (its migration is
  applied), so a degraded read can never omit a column a consumer needs.
* `readBookingWithMigrationFallback()` — rung 1 is the natural `include`; a
  migration-shaped failure (P2021/P2022 only) retries with the derived select.
  A real outage always propagates.
* `isMigrationMissing()` — the single detector; `booking-approval` re-exports it.

**Guarantee 1 — approval never captures money and then silently skips staffing.**
`STAFFING_BOOKING_SELECT` was named "columns that exist independently of the
round-2 migrations", which was **false**: it named `truckId`, `serviceMode` and
the `truck` / `inventoryItems` relations, all created by
`20260811000000_moving_os_phase1`. On a database with none of the three applied,
both rungs raised P2022/P2021, the throw escaped `ensureStaffingForBooking`, and
`repairStaffing` swallowed it — **after** the $49 was captured. Now:

* the staffing read is a THREE-rung ladder (`readBookingThroughRungs`), whose
  base rung names only columns that predate the whole Moving OS set, so the
  requirement is still written on any database this code can deploy against;
* `approveBooking` runs a **pre-capture readiness probe** (step 0, before the
  claim and before `stripe.capture`). If the crew requirement provably cannot be
  written it returns `code: 'migration_missing'` with `NOTHING was captured` and
  the migration names; the admin status route answers **503**. Only a
  migration-shaped failure refuses — a flaky probe never blocks the owner.

**Guarantee 2 — booking create fails before writing anything.** The transaction
already rolled the row back, but `nextBookingReference()` runs OUTSIDE it and is
a `SELECT nextval(...)`, which Postgres never rolls back — so every refused
create permanently burned a WMIC-#### number. A **create preflight** (step 8a)
now probes the at-risk columns/tables with a pure read before the sequence is
touched, and answers the same 503.

**Guarantee 2, corrected and extended (H1, 2026-08-14).** As written above the
guarantee was (a) untested and (b) false on the path that carries every customer
booking. Both are closed:

* **It was untested.** Deleting the ENTIRE preflight block from
  `app/api/admin/bookings/route.ts` left the whole gate green — 17 files, 337
  tests, 0 fail. The probe is now `migration-window.checkBookingCreateReady()`
  (the ONE implementation, injected probes, no `prisma` import so it stays
  offline-testable), and `src/lib/__tests__/migration-window.test.ts` § 6 pins
  both halves: its BEHAVIOUR against the fake client (refuses on P2021/P2022,
  **rethrows a real outage**, reads only — no write, no audit), and its ORDER in
  both route sources.
* **`POST /api/bookings` — the public create — was not protected.** It did
  `prisma.customer.upsert` → `nextBookingReference()` → `booking.create`, so in
  the window a real CRM row was written and a WMIC-#### number permanently
  burned before the missing column was discovered, on every customer booking.
  The same preflight now runs immediately after schema validation — **before the
  first database statement** and before address verification spends a provider
  call. Nothing to move: every write on that path is already after it.
* **The two audiences get different sentences.** The owner keeps
  `MIGRATION_MISSING_MESSAGE` (names the migrations — the fix is the next thing
  they read). A customer gets `MIGRATION_CUSTOMER_MESSAGE`: nothing was
  submitted, you have not been charged, try again shortly. It names no
  migration, column, table or vendor — a customer cannot act on that, and an
  open-internet API that spells out its schema is leaking. The owner-facing
  reason goes to the server log. Both are pinned by test.

**What the H1 tests do NOT prove** (so the guarantee is not read as wider than
it is):

* The ORDER half is a **source guard over the comment-stripped route files**, not
  an executed route. Importing a Next route handler offline would drag Stripe,
  Redis and the Discord client into a gate that is deliberately offline, so what
  is proven is: the call is present, it precedes `nextBookingReference()` and
  every `prisma`/`tx` write in the file, its result is branched on, and the
  branch returns `NextResponse.json(..., { status: 503 })`. It is not proven by
  executing Next and reading a 503 off the wire.
* The probe reads exactly the columns `PENDING_MIGRATIONS` adds. A create still
  returns `$scalars`, so a column added by a migration **nobody classified**
  would be discovered by the create itself, after the reference is drawn — that
  is precisely what the constants-vs-migration-SQL tests exist to prevent, and
  why the probe select is derived from the shared constant rather than
  hand-listed.

**Also fixed:** `fulfillment.ts` read the booking with an unguarded `include`
*one statement after* the atomic claim. Because the claim IS the idempotency
guard, a P2022 there meant the customer who had just paid $49 got no Discord
card, no email and no SMS — **ever** — and `stripe-events.ts` then recorded the
webhook as `processed`. The read now happens BEFORE the claim; if the row cannot
be read at all the claim is not consumed, the booking stays PENDING_PAYMENT, and
`stripe-events.ts` refuses to mark the event processed so the retry survives.

### E — KNOWN, ACCEPTED DEGRADATIONS during the code-before-SQL window

These are deliberate. None of them produces a silent wrong result.

| Surface | Behaviour with the SQL unapplied | Why it is acceptable |
|---|---|---|
| Customer portal `/my-booking/[token]` | Renders, without the newest columns | Nothing customer-visible depends on them; `moveTimeKnown` falls back to the 00:00 ET anchor SHAPE, so a day-level move still shows no time row. Warn-logged server-side. |
| Admin **Jobs** page | Renders, with a visible warning banner naming the migrations | The jobs are real; truck assignment / crew plan / `startTimeKnown` are simply unreadable, and the page says so. |
| `GET /api/admin/bookings` | Returns the list plus `degraded: true` + `degradedReason` | A caller is never told a partial row is a whole one. |
| Premium emails (outbox) | Render and send, `timeLabel` derived from the anchor shape | The renderers already tolerate a partial booking; this stops a multi-hour window burning all 5 send attempts and failing a customer's first email terminally. |
| Approval | Captures AND staffs, from a **derived** plan with no fleet-truck / inventory evidence; reported `planSource: 'derived'` + the reason names the migration | The owner's captured plan is unreadable, not wrong. It is never claimed as the owner's. |
| Paid-checkout fulfillment | Fans out normally from the degraded row; if even that fails, defers with `migration-not-applied` and claims nothing | The customer is contacted DURING the window, not after it; the deferral keeps the Stripe retry alive. |
| **Action Center scan** (`reminder-sync.performSync`) | **Does not run at all.** ScanRun is recorded FAILED with a sanitized reason; the kick reports `state: 'failed'` (`SCAN_KICK_MESSAGES.failed` — no coverage claim); the Action Center page shows "⚠ Last scan failed — … Existing reminders are still shown." | **Deliberately NOT laddered.** A scan over partially-readable rows would stop matching truck/staffing evidence it cannot see, and the diff engine would then **auto-resolve** true warnings. Failing loudly is safer than erasing a real alert. Consequence, stated plainly: for the whole window no reminder is created, updated or auto-resolved — including truck-double-booked — and stale reminders keep showing. |

### E — NOT covered by this pass (same `include`-everything shape, other owners)

These still throw P2022 in the window. Listed so nobody believes the sweep was
repo-wide:

* `src/bot/command-handler.ts` (4 reads) — `/job`, `/schedule`, `/approve`,
  `/deny` fail in the gateway bot. Deliberate: adding a `select` that names
  `startTimeKnown` there would make the bot depend on the newest column (see
  P0-C, which relies on the shape fallback instead).
* `src/workers/scheduled.worker.ts` (5 reads) — the pre-move reminder sender.
  The window suppresses reminders; it does not send wrong ones.
* `src/lib/followups.ts:377`, `src/lib/reschedule.ts:28`,
  `src/lib/closeout-service.ts:92`, `src/lib/stripe-events.ts:222`
  (the `payment_failed` alert), `app/api/admin/bookings/[id]/route.ts`,
  `app/api/admin/receipts/[id]/resend/route.ts`.
* `src/lib/staffing-plan.ts:1043` — `tx.jobStaffingRequirement.findUnique` with
  no `select`. LATENT only: no pending migration touches that table. It becomes
  live the day a column is added to `JobStaffingRequirement`.
* The booking-reference sequence is still consumed by a create that fails AFTER
  the preflight — admin: a customer-email conflict, a truck conflict caught
  under the lock, P2028; public: a Stripe checkout failure, which rolls the
  booking back (best effort) but cannot give the number back. Gaps in WMIC-####
  numbering are expected and harmless; no row is written, or the row is deleted.
* A refused create still costs the caller one rate-limit token on the public
  path: `rateLimit()` runs before the preflight, in Redis. That is a counter,
  not a record — no customer data is written and nothing must be cleaned up —
  but a customer retrying through a long migration window can be rate-limited.
  Moving the limiter after the probe would let an unlimited flood of
  unauthenticated POSTs hit the database instead, which is worse.

---

## Definition of done
`npx tsc --noEmit` clean. Every moving-OS correctness test green via the new runner.
The ~18 pricing-parity failures remain and are called out, not fixed. Every new
assertion must fail if its defect is reintroduced — mutation-test the important ones.
No Phase 2 work.
