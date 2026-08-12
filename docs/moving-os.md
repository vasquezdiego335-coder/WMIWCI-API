# Moving OS — audit + phased plan (2026-08-11)

Direction: "SmartMoving's moving-industry depth with Jobber's simplicity," custom-built
for Move It Clear It. Full lifecycle — Lead → Estimate → Inventory → Pricing →
Follow-up → Booking → Deposit/Hold → Scheduling → Dispatch → Crew → Truck → Move →
Sign-off → Payment → Expenses → Profit → Review → Repeat — where ONE "BOOK MOVE"
decision cascades everywhere. Filter for every feature: does Diego need it, will
another owner understand it, does it kill manual work or an expensive mistake.

This doc is the audit-of-record (code-verified on main @ 77962944) and the build plan.

## 1. Gap matrix (direction section → current state)

| Direction section | State | Evidence |
|---|---|---|
| Sales/opportunity workspace (phone-call intake) | **MISSING** | `/api/admin/bookings` is GET-only; no admin create form anywhere. Phone customers must be walked through the public form + Stripe checkout themselves. |
| Move details capture (addresses/access/services/size) | **EXISTS (public form only)** | Booking has ~170 structured columns incl. per-end floors/elevator/stairs/access notes/codes, verified addresses, service booleans (`booking-schema.ts`, schema 814-1118). Admin cannot enter or edit most of them. |
| Smart inventory (searchable items × qty, follows the customer) | **MISSING** | No InventoryItem model. Inventory = `itemsDescription` free text + scalar booleans (hasPiano/hasSafe/…); job page parses the blob line-by-line. |
| Smart estimating assistant (crew/truck/hours + WHY) | **MISSING** | `assignTruck()` (pricing-config) derives minimum truck from move size — the only recommendation logic in the repo. Nothing recommends crew or hours. `pricing-intelligence.ts` is post-hoc comparables, advisory, unconsumed at quote time. |
| Pricing engine (Settings → Pricing, owner override + reason) | **PARTIAL, HIGH-RISK AREA** | ALL customer prices are compile-time constants in `pricing-config.ts` + `service-area.ts`, hand-mirrored into the SITE repo (`gen:pricing-config`). No pricing UI, no override-with-reason (labor-rates has the house pattern; pricing never adopted it). Discounts admin buttons POST to a route that DOES NOT EXIST; the canonical `applyDiscount()` has zero live callers while live math discounts never-discountable charges uncapped. Published drive-time travel ladder ($100/$150 tiers) is DEAD CODE — live travel is flat $50 extended-NJ. **The 18 failing pricing-parity tests on main are the drift detector firing.** |
| Dispatch board | **~40%** | `/admin/scheduling` = date-grouped staffing-health cards. No crew lanes, no unassigned lane, no drag. **Blind spot: a confirmed booking with no Job row is invisible to the board** (Job created only at first crew assignment; board requires `job isNot null`). JobStaffingRequirement is never auto-created and NO UI writes it — UNDERSTAFFED/MISSING_DRIVER can never fire for real jobs. |
| Truck / resource management + truck conflicts | **MISSING** | No Truck model (60 models, zero fleet). Truck = free-text strings on Booking + TruckSource closeout enum. Truck double-booking is undetectable because trucks are strings. |
| Crew mode | **PARTIAL + 2 CONFIRMED BUGS** | Portal exists (ack/decline, worker-safe fields). **Bug 1: clock buttons POST to `/api/admin/...` which middleware 403s for CREW** — the purpose-built `/api/crew/.../clock` route has zero callers; real crew cannot clock in at all. **Bug 2: CREW login redirect loop** (login page ignores `?next=`, middleware fallback redirects /admin→/admin). Rich warning data (stairs/heavy/elevator/access notes) exists on Booking + StaffingRequirement but crew page selects NONE of it. No job detail page, no photos flow, no checklist, no report-issue, no arrived/en-route. AssignmentNotification + CrewInvitation are ledger-only (nothing sends). |
| Job timeline (one chronological stream) | **PARTIAL** | Dense AuditLog in money/crew areas, but 4 unmerged displays on the job page; lead events never audited (LEAD_CREATED/LEAD_STATUS_CHANGED/PRICE_CHANGED/BOOKING_CREATED are dead enum values — real bookings get NO creation audit row); no call logging; no en-route event; ManualEvent (Discord field log) is unlinked by design. |
| Sales pipeline (visual, auto-advancing) | **PARTIAL** | LeadStatus enum matches NEW/CONTACTED/QUOTE_SENT/FOLLOW_UP/BOOKED/LOST exactly, and NEW→QUOTE_SENT→BOOKED advances automatically. **But nothing ever writes CONTACTED/FOLLOW_UP/LOST/contactedAt/lostReason/assignedTo** — owner can't record a call, can't close a dead lead (open leads silt up forever + email-dedupe merges new inquiries into stale rows). No kanban, no per-stage counts, no lead detail page, no manual lead entry, no convert-to-booking. |
| Follow-up automation | **EXISTS (env-gated)** | Quote follow-up 24h/3d/7d, nurture, abandoned checkout, post-move review/referral/repeat — all consent/suppression/quiet-hours guarded via ONE `guardedSend`. All inert unless Railway env flags are on (presence ≠ configuration). |
| Capacity/booking view | **MISSING** | `isDayAvailable` (DayBlock + MAX_JOBS_PER_DAY env) guards ONLY customer self-reschedule. No admin capacity indicator anywhere; booking creation and approval never check capacity. |
| Operations warnings | **PARTIAL** | 27-rule deterministic Action Center — genuinely good — but **pull-only** (scan runs ONLY on page load / manual rescan; no cron). Missing moving-specific rules: confirmed-move-no-inventory, assembly-requested-no-fee/note, big-move-small-crew (needs derived requirement), truck-double-booked (needs Truck model), capacity-exceeded, missing COI (no COI concept exists at all). Conflict engine + Action Center are two disconnected warning surfaces. |
| Job-day communication | **PARTIAL** | Booking-received, final-confirmation, 72h/24h reminders, completion, balance reminder, review/referral: wired (env-gated). **Gaps: final-confirmation email PROMISES "we'll text you when we're en route" — no code keeps that promise** (jobStarted i18n string has zero consumers); payment receipt is manual-resend-only (registry claims auto — and referral eligibility requires the receipt audit row, so referrals silently never fire); 7AM day-of SMS says "crew is on the way" regardless of slot; SMS delivery status never written back; Notification model is dead (admin Communications card permanently empty); portal tokens expire 7 days after CREATION so week-out moves have dead portal links on move day. |
| Customer service / issues | **MISSING** | `problemFlags` free-text string. No Issue entity/status/resolution. |
| One-screen job command center | **~70%** | jobs/[id] has 19 cards incl. the full money model. Missing: structured inventory, documents section (all files render as photos), issues, sign-off, messages (email-out only), and it's a 929-line scroll, desktop-only. |
| New owner experience / guide | **MISSING** | Zero help/onboarding content in the admin (grep-verified). Settings is a "soon" stub. |
| Mobile | **PARTIAL** | Fixed 230px sidebar, no media queries, no CSS layer; only CrewLaborPanel/FinancialCloseoutPanel are mobile-first islands. |

Strong foundations to build ON (do not rebuild): the money spine (customerBalance /
profit / closeout snapshots / distributions), booking approval + $49 manual-capture
hold, Stage-5 availability/conflict engines, the estimate engine (`computeEstimate`),
the send guard, the Action Center rule engine, the audit patterns in labor-rates.

## 2. Hard rules for all phases

1. **Never touch customer-facing price constants** (`pricing-config.ts`,
   `service-area.ts`) without the owner's explicit go + site-mirror regeneration.
   Owner pricing on a booking = per-booking columns + PRICE_CHANGED audit, never
   the price book.
2. Migrations are additive SQL, applied MANUALLY per `docs/deployment.md` —
   never auto-run against Neon.
3. Every new admin write: session + permission gate + AuditLog with before/after +
   reason where money moves (the labor-rates pattern).
4. Never claim SMS/email was sent when env-gated off; reuse `guardedSend` for any
   customer email.
5. New test files must be appended to the `test` script in package.json (explicit list).
6. Baseline on main: 2196/2214 pass; the 18 failures are ALL pricing-parity (site
   mirror drift) and pre-exist this work.

## 3. Phases

### Phase 1 — Sales workspace + BOOK MOVE cascade (this branch)
The ultimate-test flow, built on existing spine:
- **Schema (additive)**: `Truck` (name/size/source/status/notes/active) +
  `Booking.truckId`; `InventoryCatalogItem` (name/category/heavy/disassembly/
  recommendedMovers/volume) + `BookingInventoryItem` (booking, catalog?, name,
  qty, notes) so inventory follows lead→quote→job→crew with no retyping;
  `Booking.priceOverrideReason`.
- **Estimating assistant** (`src/lib/estimate-assistant.ts`): pure, advisory —
  move size + inventory + access → recommended crew, truck (reuses `assignTruck`),
  hours range, difficulty, with human-readable reasons. Never writes a price.
- **Admin Book Move workspace** (`/admin/book`): find/create customer → move
  details → access → services → inventory picker (search + qty + custom) →
  recommendation card with WHY → owner price (override stores reason +
  PRICE_CHANGED audit) → BOOK.
- **POST /api/admin/bookings**: owner/manager-gated create that CASCADES:
  Customer upsert, Booking (structured columns, server estimate recorded as the
  recommendation), Job row + JobStaffingRequirement auto-created from the
  recommendation (fixes the dispatch blind spot at the source), matching lead
  auto-converted, BOOKING_CREATED + PRICE_CHANGED audits, Action Center scan
  kicked, optional Stripe $49 hold link to send to the customer OR
  deposit-waived/collect-on-day with audit. No customer email unless the owner
  ticks it (reuses existing templates + guard).
- **Lead pipeline**: PATCH route writing the dead statuses (CONTACTED, FOLLOW_UP,
  LOST + reason — closes the silt-up defect), lead detail page (`/admin/leads/[id]`)
  with activity + emails + convert-to-booking (prefills /admin/book), pipeline
  counts bar on /admin/leads, manual "New lead" entry (MANUAL_ENTRY source),
  `entity-links` lead mapping fixed, LEAD_STATUS_CHANGED audited.
- **Trucks**: `/admin/trucks` CRUD + truck pick in Book Move/job ops +
  `truck-double-booked` Action Center rule (overlapping bookings sharing a truck)
  + hard warning surfaced in Book Move when the chosen truck is taken.
- **Audit-found bug fixes** (small, verified): crew clock 403 (point card at
  /api/crew clock route), CREW login redirect loop, portal token extended on
  approval.

### Phase 2 — Dispatch depth + warnings that push
Board shows job-less confirmed bookings + unassigned lane + crew/truck lanes;
capacity bar per day (jobs vs MAX + crew demand); cron-driven Action Center scan
(REMINDER_SCAN_ENABLED) + new rules (no-inventory, assembly-mismatch,
big-move-small-crew via the assistant's derived requirement, capacity-exceeded);
AssignmentNotification delivery sweep; conflict engine findings mirrored into
Action Center.

### Phase 3 — Crew mode complete + job-day comms
Crew job detail page (warnings/addresses/maps/inventory), arrived/en-route/photos/
checklist/report-issue actions, receipt-on-capture (unblocks referral chain),
en-route SMS trigger (keeps the email's promise), Twilio status callback,
Notification model retired or wired.

### Phase 4 — Pricing settings + timeline + issues + guide
DB price book with owner UI (careful migration off code constants, parity tests
kept), discount grant path fixed, quote/estimate entity with acceptance,
unified timeline component (AuditLog + EmailSend + FollowUpLedger + ManualEvent +
column stamps), Issue entity, in-app owner guide, responsive shell.

## 4. Known pre-existing defects registry (audit 2026-08-11, not Phase-1 scope unless listed above)

- Discounts admin Approve/Deny POST a nonexistent route; live discount math ignores
  cap + exclusions (`job-money.ts` L293); legacy uncapped `applyDiscount` in stripe.ts.
- Published travel ladder unreachable (`estimate.ts` L239-249 vs `service-area.ts`).
- `pricing.ts` presents dead `bookingPricing()` as canonical.
- Approval Discord card hardcodes `totalEstimate - 49` (`fulfillment.ts` L220).
- Owner Money page prices labor from legacy columns + live rates; upcomingBills=0.
- SET_SPLIT preview hardcodes 50/50; MONTHLY_POOL overhead charges one move the pool.
- Customer.isFirstTime never updated → customers index shows First-time forever.
- baseRate PATCH silent no-op on quoted bookings (customerBalance prefers totalEstimate).
- Self-service reschedule API complete but portal UI never calls it; offer emails suppressed.
- `/api/files/upload` missing from middleware matcher (CSRF/role gate never runs).
- EMAIL-REGISTRY.md stale; registry claims receipt fires on capture (it does not).
- 16 AuditAction values never written; day-block + legacy staff PATCH mislabel as
  BOOKING_STATE_CHANGED.
- Two schedule pages disagree on "scheduled"; two availability systems drift
  (legacy Availability vs Stage-5 rules).
- reminder scan caps: bookings take 500 / customers take 2000 silently truncate.
