# Phase 1 correctness — ROUND 3 (closing the last three FAILs; 2026-08-12)

Round 2 fixed the headline defects. Verified PASS and NOT to be re-opened:
day-level `scheduledStart` stays null through approval (both DST sides, sequential
repeats, after a transient failure) · a timed booking keeps its real instant ·
truck day-level conservatism survives approval · a PENDING_PAYMENT truck hold refuses
a second create, sequentially AND concurrently · a replayed plan never clobbers
owner-edited staffing · a public booking (serviceMode null) is no longer staffed with
a driver we are not sending · an admin piano booking is review-gated like the public
one · locale is not overwritten and hand-typed specialty lines get the crew floor.

Round 3 closes what verification still finds. Standing rules unchanged (no git, no
database commands, no price constants, additive hand-authored migrations, house API
pattern, fail-soft on unapplied migrations, honest capability claims). package.json is
now the orchestrator's problem and is already updated — do not touch it.

**The round-3 rule:** every fix must hold for the row the SHIPPED WRITER actually
persists. Round 2 lost two verdicts to test fixtures that invented columns
production never writes (a `scheduledStart` on a PENDING_PAYMENT row). Build fixtures
by calling `buildBookingCreateData`, not by hand.

---

## R3-1 (was R2-1d, FAIL — customer- and owner-facing regression)
**Defect:** the day anchor is 00:00 ET, and seven surfaces still format it WITH a
time, so a date-only move reads **12:00 AM**. This is a regression against HEAD, which
stored 07:00 and therefore read "7:00 AM". Reproduced surfaces:
1. Discord owner approval card — `booking-display.ts:114-130` (`jobDateTime`, called
   at :637 with `requestedDate`)
2. Discord crew job card — `booking-display.ts:410`
3. Discord "Approved" card, the one the owner sees at the moment of approval —
   `app/api/discord/interactions/route.ts:89-90`
4. Customer pre-approval email "Time" row — `src/emails/pre-approval.tsx:100-101,267`
   (NEITHER sender passes `timeLabel`: outbox `renderPreApproval`
   `premiumEmails.tsx:160-186` and the legacy queue payload `fulfillment.ts:157-175`)
5. Customer SMS — `fulfillment.ts:116-122` (`timeStyle:'short'`), used at :185-188
6. Customer portal — `app/my-booking/[token]/page.tsx:206-208` ("Around 12:00 AM")
7. Admin jobs list — `app/(admin)/admin/(dashboard)/jobs/page.tsx:46,173`
Plus the Action Center row prints `dueAt` with the hour
(`action-center/page.tsx:19,185`); round 2's test only scanned title/description.

**Also (was R2-1 item 4, PARTIAL):** the 72h/24h reminder now prints NO DATE at all —
the worker passes only `booking.scheduledStart` (null for day-level) and
`job-reminder.tsx:68-70` falls back to "Your move is coming up soon". Losing the date
is not an acceptable substitute for losing the hour. The comment at
`journeys.ts:643-645` claims the template renders the date alone; it does not. Fix the
code and the comment.

**Fix:** ONE shared formatter is the only correct shape here — a booking-aware
`formatMoveWhen`-style helper that takes the row (or an explicit
`{ date, startTimeKnown }`) and returns the date alone when the time is not known, the
date+time when it is. Route every surface above through it; carry `startTimeKnown`
into the Discord card payloads, the email payloads (pre-approval especially), the SMS
builder, the portal projection, and the jobs-list query. Where a surface renders
`dueAt`/anchor timestamps generically, make the day-level case render date-only.

**Tests:** assert each surface's rendered string for a day-level booking contains no
"12:00 AM" and no "AM/PM" at all, and that a TIMED booking still shows its real hour.
Include the 72h reminder body (it must name the date).

## R3-2 (was R2-3a, FAIL — approvals break entirely during the deploy window)
**Defect:** `approveBooking`'s first statement is `store.loadBooking`, which in
production is an unqualified `prisma.booking.findFirst({ include: { customer: true } })`
(`booking-approval.ts:704`). Prisma expands `$scalars` from the GENERATED schema, which
now declares `startTimeKnown` and `staffingPlan`, so in the normal code-before-SQL
window that read raises P2022 and **approveBooking throws before anything runs** —
neither the admin status route (`.../status/route.ts:62`) nor the Discord handler
(`interactions/route.ts:166`) wraps it, so **every approval 500s and no deposit is
captured**. The admin surface dies one step earlier on its own unqualified read
(`status/route.ts:42`). Round 2 built the defensive ladder
(`loadStaffingBookingRow`, :343-363) but wired it only to the staffing read, and the
unit test made only the injected read fail — adjacent to the guarantee again.

**Fix:** apply the same degraded-read ladder to EVERY production read on the approval
path, starting with `loadBooking` and the admin status route's read. Prefer explicit
`select` lists over `include`-everything so a new column can never break an old
deploy. The degraded path must still capture the deposit and confirm the booking; only
the new-column-dependent behavior degrades.

**Also (was R2-1 unapplied-migration, PARTIAL):** `confirmationScheduleData` treats
only an explicit `false` as day-level, so an unreadable flag promotes the anchor
again — fail-soft in the direction of the defect. Make the day-level determination
survive a missing column (e.g. treat "no time component on the anchor" as day-level
when the flag is unreadable), or ensure the degraded read still yields the flag.
Document the choice.

**Test the guarantee, not the ladder:** drive the shipped `approveBooking` with a
store whose reads raise P2022 for the new columns and assert the booking is still
captured + confirmed and the job still gets a derived staffing requirement.

## R3-3 (was R2-6, FAIL — the false claim moved from the skip message to the success message)
**Defect:** round 2 made the two skip messages honest, then put an unverifiable claim
in the success message: `scan-lock.ts:101` returns *"Action Center rescanned — this
booking is included"*, and round 2 also switched the kick to `force: true`, so `ran`
is now the NORMAL ending — the false line prints on essentially every default-path
booking. It is false because `performSync` loads
`['PENDING_APPROVAL','CONFIRMED','SCHEDULED','IN_PROGRESS']` + recent COMPLETED
(`reminder-sync.ts:47-52`) and the default `stripe_link` booking is **PENDING_PAYMENT**.
The codebase already admits this in a comment at `reminder-rules.ts:502-507`. Worse,
`action-center-kick.test.ts:170-175` asserts the false claim and exempts it from the
COVERAGE_CLAIMS guard — the test requires the defect.

**Fix (do BOTH halves; they also close R2-2 clause 2):**
1. Add `PENDING_PAYMENT` to the `performSync` booking loader so pending holds are
   actually evaluated — this is what makes the truck-double-booked rule work on the
   rows the default path writes, and it makes an inclusion claim truthful.
2. Fix the truck rule's own row mapper: `toTruckShape` (`reminder-rules.ts:509-516`)
   drops `requestedDate` and `basisOf` is `scheduledStart ?? confirmedDate`, so pending
   rows are discarded at the `!!basis` filter regardless of statuses. Carry
   `requestedDate` and use the same basis coalescing the rest of the system uses
   (`moveDateInRange`/`effectiveMoveDate`).
3. Only then may the success message claim inclusion — and it must be conditioned on
   the booking's status actually being in the scanned set. If it is not, say
   "rescanned" without the inclusion promise.
4. Delete/invert the blessing assertion in `action-center-kick.test.ts` and add
   `/is included/` to the guarded claims.
5. Note `reminder-sync.ts:44-60` caps at `take: 500` with NO `orderBy` — add a
   deterministic order (newest/soonest first) so truncation is not arbitrary.

## R3-4 (was R2-2 clauses 2/4, PARTIAL — cross-midnight and the wrong fixture)
1. **Cross-midnight detection regresses for pending rows.** A PENDING_PAYMENT hold
   persists no `scheduledStart`, so it keys to ONE ET day; a 9 PM hold whose 6h
   fallback runs to 3 AM does not refuse a 00:30 create the next day, while the
   identical CONFIRMED job does. Fix the DETECTION half to match the LOCKING half:
   when a basis-only (unknown-time) booking's fallback window crosses midnight,
   evaluate both ET days.
2. **The truck-hold fixture invents a column production never writes**
   (`truck-hold.test.ts:196` sets `scheduledStart` on a PENDING_PAYMENT row), so it
   asserts `time_overlap` where production yields `same_day_unknown_times` — and that
   invented start is exactly what concealed the cross-midnight gap. Rebuild the
   fixture through `buildBookingCreateData` and re-assert the real classifications.

## R3-5 (was R2-3b, PARTIAL — the repair path is unreachable)
`repairStaffing` on the already-confirmed replay is correct but no production surface
can reach it: `VALID_TRANSITIONS['CONFIRMED']` excludes CONFIRMED
(`status/route.ts:12-18`), the admin UI offers only Mark-scheduled/Cancel, the Discord
`/approve` refuses a non-PENDING_APPROVAL booking, and the Approve button is removed
after success. So a job whose staffing write failed stays unstaffed forever.

**Fix:** give the repair a reachable trigger through NORMAL operations — call
`ensureStaffingRequirement` on the CONFIRMED→SCHEDULED transition and when a crew
member is first assigned (`labor-service.ensureJobForBooking`), both of which the
owner already does. Keep it fail-soft and idempotent (create-if-missing semantics from
R2-3c stand). Then assert: a booking whose approval-time staffing threw gets its
requirement when the owner marks it scheduled or assigns the first crew member.

## Definition of done
`npx tsc --noEmit` clean. `npm test` green except the 18 known pricing-parity
failures — note the round-2 test files are NOW in the suite, so a regression in any of
them fails the build. Every new assertion must fail if its defect is reintroduced
(mutation-test the important ones, as round 2's schedule agent did).
