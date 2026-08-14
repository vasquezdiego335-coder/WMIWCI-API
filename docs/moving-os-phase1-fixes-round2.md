# Phase 1 correctness — ROUND 2 (gate did not pass; 2026-08-12)

Round 1 (commit pending) fixed real defects but adversarial verification found the
guarantees do not hold on the DEFAULT paths. Gate verdicts:

| Item | Verdict |
|---|---|
| 3 customer identity | PASS |
| 5 specialty mover floor | PASS |
| 8 admin auth coverage | PASS |
| 1 staffing on the $49 path | PARTIAL + 2 sub-FAIL |
| 4 service-mode staffing | PARTIAL + 1 sub-FAIL |
| 6 structured parity | PARTIAL |
| 7 scan honesty | PARTIAL |
| 9 truck concurrency | PARTIAL (vacuous on default path) |
| 2 real scheduled times | **FAIL (regression)** |

Same standing rules as round 1 (docs/moving-os-phase1-fixes.md): no git, no database
commands, no price constants, no package.json, additive hand-authored migrations,
admin API house pattern, fail-soft on unapplied migrations, honest capability claims.

The rule for this round: **fix the DEFAULT path, and make the test assert the
guarantee rather than an adjacent property.** Several round-1 tests passed while the
defect lived (an approve-twice test that proved staffing was never re-called; a truck
race test that only injected CONFIRMED rows; a review-parity test that hand-built an
estimate the route cannot produce). Every fix below must be proven on the path a real
owner uses: `stripe_link` deposit, day-level or timed, public bookings included.

---

## R2-1 (was item 2, FAIL — a REGRESSION, fix first)
**Defect:** day-level admin bookings store `requestedDate` = 00:00 ET. At approval,
`confirmationScheduleData` (src/lib/scheduling.ts:167-175) does
`start = scheduledStart ?? confirmedDate ?? requestedDate`, so the day anchor is
promoted into `scheduledStart` — the job lands at **12:00 AM ET**. Worse than the
7:00 AM it replaced: `truck-conflicts.ts` treats two known times as an interval
compare, so the conservative "same day, unknown times ⇒ conflict" rule evaporates and
a silent truck double-booking becomes possible. Blast radius: staffing
`estimatedStartAt`, approval notification ("12:00 AM"), pre-move reminder anchoring,
reminder-rules copy, and the success panel's "day-level scheduling" line becomes a lie
the moment the hold is approved.

**Fix:**
1. Schema (additive): `Booking.startTimeKnown Boolean @default(true)`
   `@map("start_time_known")` + migration
   `prisma/migrations/20260812010000_start_time_known/migration.sql`. Default `true`
   so every existing row and the public path (which always supplies a time) keep
   today's behavior; the admin create sets it `false` when the owner gave no time.
2. `confirmationScheduleData` must NOT invent a start when `startTimeKnown === false`:
   return `scheduledStart = null`, `scheduledEnd = null`, and keep `confirmedDate` as
   the day anchor. Read the function's other callers first and keep them working.
3. Approval (`claimConfirm`) must not write a fabricated start for those rows.
4. Everything downstream must degrade honestly with a null start — audit the
   consumers the verifier named (`email-eligibility.ts:62-63`, `journeys.ts:348`,
   `reminder-rules.ts:286-292`, the approval notification via `formatEastern`) and
   make each say "date only / time to be confirmed" rather than printing midnight.
5. Truck conflicts must keep day-level conservatism through approval (this is the
   double-booking guard — verify it with a test that approves a day-level booking and
   then re-checks against an 8 AM job on the same truck).

**Tests (the ones round 1 lacked):** a day-level booking still has `scheduledStart`
null AFTER approval; a timed booking keeps its real time through approval; the
day-level vs 8 AM truck check still reports a conflict post-approval; DST-correct in
both January and July.

Note for the record (pre-existing, NOT in scope): `etDateTimeToInstant` defaults a
missing time to 07:00 (scheduling.ts:94-95) and the public route passes
`time ?? '07:00'` (app/api/bookings/route.ts:92). Unreachable from the admin path.
Leave them; write a one-line comment pointing here.

## R2-2 (was item 9, PARTIAL — vacuous on the default path)
**Defect:** the advisory lock and re-check are correct, but the candidate query
filters `TRUCK_CONFLICT_STATUSES = [CONFIRMED, SCHEDULED, IN_PROGRESS]` while the
DEFAULT `stripe_link` create writes `truckId` on a **PENDING_PAYMENT** row. The truck
is assigned where the conflict check cannot see it, so two creates (concurrent OR
sequential) both take the same truck. `approveBooking` never re-checks trucks, the
trucks "busy" indicator uses the same statuses so the UI shows it free, and the
Action Center rule also filters live statuses — it fires only after both are approved.

**Fix:**
1. Introduce `TRUCK_HOLD_STATUSES` = live statuses + `PENDING_APPROVAL` +
   `PENDING_PAYMENT` (a truck the owner assigned to an unpaid booking IS held).
   Use it in: the pre-check, the locked re-check, `findTruckConflictsIn`, the
   `/api/admin/trucks?date=` busy indicator, and the `truck-double-booked` reminder
   rule. `DRAFT`, `COMPLETED`, `CANCELLED`, `ARCHIVED` never hold a truck.
   Keep ONE exported constant — no per-caller copies.
2. Distinguish in the message: a conflict against a pending booking says so ("Truck 1
   is held by an unpaid booking on Aug 15"), because the owner may legitimately
   override that; a conflict against a confirmed job is firmer. Both are refusals
   unless `truckConflictOverride` is set; both are audited.
3. `prisma.$transaction(..., { timeout, maxWait })`: the lock loser can currently
   exceed Prisma's 5s default and die P2028→500 instead of the promised 409. Set
   explicit, commented values sized to the work inside the transaction.
4. Cross-midnight: when the job's window (or the 6h fallback) crosses the ET day
   boundary, take BOTH day keys in a deterministic order (lowest key first, so two
   transactions can never deadlock).

**Tests:** a PENDING_PAYMENT booking holding a truck causes a refusal for a second
create on the same truck+day (this is the exact defect — assert it directly);
CANCELLED/COMPLETED do not; the pending-vs-confirmed message differs; two-key
ordering is deterministic across a midnight-crossing window.

## R2-3 (was item 1, 2 sub-FAILs + replay risk)
**Sub-FAIL A — unapplied migration kills the whole ensure.**
`prismaApprovalStore.ensureStaffing` selects `staffingPlan` (booking-approval.ts:646).
With migration 20260812000000 unapplied — the normal code-before-SQL deploy state —
the findUnique throws P2022 and the ENTIRE ensure dies, including the *derived* path
that needs no new column. Result: confirmed booking, $49 captured, Job created, NO
staffing requirement — the original defect, on the default path, for the whole window.
**Fix:** select the new columns defensively (try with, fall back to a select without
them on P2022/P2021 — reuse the repo's `isMigrationMissing` helper) so the derived
plan still runs. The same applies to `startTimeKnown` from R2-1.

**Sub-FAIL B — a failed ensure is unrepairable, and the test proves the wrong thing.**
The `already_confirmed` early return (booking-approval.ts:278-280) sits BEFORE the
staffing block, so re-approving never retries. Round 1's test asserted
`{create:1, update:0}` after a second approve — which is proof the second approval
never called ensure at all.
**Fix:** the idempotent-replay path must still run `ensureStaffing` (it is an upsert;
running it on an already-confirmed booking is safe and is the repair mechanism).
Rewrite the test to assert the REAL guarantee: after a first approval whose ensure
threw, a second approval creates the requirement.

**Replay risk — do not clobber owner edits.** A Job can exist pre-approval (crew
assigned early) and its requirement hand-tuned via
`/api/admin/jobs/[id]/staffing`. Approval's ensure currently overwrites
requiredWorkers/minWorkers/requiredDrivers/flags/instructions with no audit.
**Fix:** `ensureStaffingRequirement` becomes create-if-missing; when a row already
exists, leave the owner's values alone (log + return `unchanged`). Existence is the
guarantee; the owner's judgment outranks a replayed plan. If a field is null on the
existing row and the plan has a value, filling that single null is acceptable — say
so in a comment and test it.

## R2-4 (was item 4, sub-FAIL — the highest-volume path is staffed wrong)
**Defect:** only the admin form ever writes `serviceMode`. Every **public and legacy**
booking has `serviceMode = null`, which falls through to the full-service branch:
`customerProvidedTruck=false, requiredDrivers=1, skills=['DRIVING']` — while the same
row carries contrary evidence the spine never reads (`truckProvider`, `truckSize`,
`truckReservationStatus`, `truckAddonDueOnMoveDay`, and the itemsDescription truck
line). R2-3 makes these wrong values ACTIVE for the first time, and they fire
MISSING_DRIVER on jobs where we were never driving.

**Fix:** when `serviceMode` is null, derive the transportation facts from the columns
the public route actually writes. Read `app/api/bookings/route.ts` and
`src/lib/booking-schema.ts` to learn the real `truckProvider` value space before
writing the mapping (do not guess the strings). Rule of thumb to verify against the
data: customer-provided truck ⇒ `customerProvidedTruck=true, requiredDrivers=0`;
a truck we pick up/return ⇒ driver required. When the columns are genuinely
ambiguous, prefer the NON-driving interpretation and add a plan note saying the mode
was not recorded — never staff a driver we are not sending. Consider also writing
`serviceMode` on the public route when it is unambiguous (additive, no schema change
needed — the column exists), which fixes it at the source for new bookings.

**Tests:** a realistic PUBLIC booking row (serviceMode null + customer-provided truck
columns) yields `customerProvidedTruck=true, requiredDrivers=0` and NO driving skill;
the truck-pickup variant requires a driver; the ambiguous case is non-driving + noted.
Round 1's test asserted the wrong behavior as intended — replace it.

## R2-5 (was item 6, PARTIAL — review-gating differs by who booked it)
**Defect:** the admin route calls `computeEstimate` without `heavyItems`, and heavy /
specialty review reasons exist only under that input. An admin 2BR booking with the
catalog's "Piano (upright)" lands `hasPiano=true, specialtyItems='Piano (upright)'`
but `manualReviewRequired=false, reviewReasons=[]` — an internally contradictory row.
The identical public booking IS review-gated. Action Center, booking-completeness, the
Discord card and the "pending review" email copy all behave differently for the same
job depending on who entered it.

**Fix:** feed the captured inventory's heavy/specialty signal into the estimate on the
admin route so `buildReviewReasons` sees it (the data exists —
`resolveInventorySnapshots` carries isHeavy/category/name and `deriveMoveDetails`
already computes hasPiano/hasSafe/hasPoolTable). Match the public path's semantics; do
not invent pounds the catalog does not have — if `computeEstimate`'s heavy input needs
a weight, pass only what is real and add the specialty review reason directly for
piano/safe/pool-table rather than fabricating a number.

**Test the ROUTE-level guarantee:** an admin booking payload containing a piano
produces `manualReviewRequired=true` with a reason — asserted from an inventory
payload, not from a hand-built estimate.

## R2-6 (was item 7, PARTIAL — an honest mechanism telling a false story)
**Defect:** the two `skipped_cooldown` messages assert coverage the code cannot know.
"one ran moments ago, so the list is already current" is provably FALSE — that scan
ran before this booking committed. Booking two jobs back to back reliably shows a
green line claiming the list is current while job #2 is absent from it. There is no
cron scan today (Phase 2 adds it), so cooldown skips are common.
**Fix:** rewrite both messages to state what is actually known ("a scan ran recently —
this booking may not appear until the next one; open the Action Center to refresh
now"). Prefer forcing the scan for a just-created booking if `runScan` supports it
without breaking the in-progress guard; if it does not, say so honestly instead.
Also reconsider the 6s timeout: on a large dataset a healthy-but-slow scan paints a
red "did not run" banner routinely, training the owner to ignore it. Either raise it
with a comment justifying the number, or word the timeout state as "still running".
Wrap `markLeadConverted` (the one unguarded post-commit step) so a booking that
exists can never return 500.

## R2-7 (small, confirmed by verification)
1. **Locale overwrite (item 3 residual):** `locale` is written unconditionally
   (admin-booking.ts:483-486) because zod defaults it to 'en', and the lead pre-link
   carries no locale — so converting a Spanish-speaking repeat customer's lead
   silently switches their email language to English. Make locale follow the same
   "only when the owner actually supplied it" rule as the other contact fields, and
   carry locale through the lead prefill.
2. **Hand-typed specialty (item 5 residual):** a custom inventory line named "Piano"
   sets `hasPiano=true` via the name regex but has no catalog row, so no crew floor
   fires — a piano job books with 2-3 movers. Apply the same floor when the specialty
   name-match fires on a custom line.

## Definition of done for round 2
Every fix proven on the DEFAULT path (`stripe_link`, day-level and timed, public rows
where relevant). `npx tsc --noEmit` clean. All new and existing tests green except the
18 known pricing-parity failures. No test may assert a property adjacent to the
guarantee — if the guarantee is "exactly once after a failure", the test must make the
first attempt fail.
