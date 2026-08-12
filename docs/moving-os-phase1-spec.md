# Moving OS Phase 1 — implementation spec (2026-08-11)

Read docs/moving-os.md first (audit + hard rules). Repo = C:\wt-moving-os on branch
claude/moving-os (base = origin/main 77962944). All work in this worktree. Never run
git commands; never run prisma migrate against any DB; `npx prisma generate` is fine.

## House rules that apply to every stage
- Admin API pattern (copy app/api/admin/expenses/route.ts): `getSession()` → 401,
  `can(session.role as Role, '<perm>')` → 403, zod `safeParse` → 422, mutation +
  `prisma.auditLog.create` in ONE `$transaction`, `apiLogger` on errors.
- New permissions go in src/lib/permissions.ts following its existing matrix style.
  Phase 1 permissions: `booking.create_admin` (OWNER+MANAGER), `truck.manage`
  (OWNER+MANAGER), `lead.manage` (OWNER+MANAGER).
- Schema: new models use @@map snake_case table names + @map snake_case columns,
  cuid ids, createdAt/updatedAt like recent models (see JobStaffingRequirement).
- Migration SQL is hand-authored, additive, idempotent (`CREATE TABLE IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`, guarded `CREATE TYPE` via DO $$ ... EXCEPTION WHEN
  duplicate_object). Mirror the style of prisma/migrations/20260722000000_stage5_*.
- UI: server components + small client islands, inline styles matching
  app/(admin)/admin/(dashboard)/_ui.tsx patterns (use its exports where they fit).
  Fail SOFT if the new tables are missing (catch P2021/table-missing → render an
  honest "migration 20260811000000_moving_os_phase1 not applied" callout instead of
  crashing) — house pattern, migrations are applied manually.
- Money: NEVER touch src/lib/pricing-config.ts / service-area.ts values. Per-booking
  owner pricing only (totalEstimate/baseRate columns + audit).
- Customer emails: none in Phase 1 admin-create flow. The UI surfaces the portal
  link + (if chosen) Stripe hold link for the owner to send manually.
- Tests: node:test style like src/lib/__tests__/*.test.ts, pure/offline (no DB, no
  network). Do NOT edit package.json (the orchestrator appends test files at the end).
  Structure route logic as pure helpers in src/lib so they are testable offline.

## Stage 1 — schema + migration (sequential, first)
prisma/schema.prisma additions:
- `enum TruckStatus { AVAILABLE MAINTENANCE RETIRED }`
- `model Truck` @@map("trucks"): id cuid; name String; size String ("10ft"|"15ft"|
  "26ft"|other free); source TruckSource @default(RENTAL) (REUSE existing enum);
  status TruckStatus @default(AVAILABLE); capacityNotes String? @map("capacity_notes");
  active Boolean @default(true); createdAt/updatedAt; bookings Booking[].
- `model InventoryCatalogItem` @@map("inventory_catalog_items"): id; name String
  @unique; category String ("furniture"|"boxes"|"beds"|"appliances"|"tvs"|
  "specialty"|"heavy"|"other"); isHeavy Boolean @default(false) @map("is_heavy");
  needsDisassembly Boolean @default(false) @map("needs_disassembly");
  typicalVolumeCuFt Int? @map("typical_volume_cu_ft"); recommendedMovers Int?
  @map("recommended_movers"); protectionNotes String? @map("protection_notes");
  active Boolean @default(true); createdAt; items BookingInventoryItem[].
- `model BookingInventoryItem` @@map("booking_inventory_items"): id; bookingId
  @map("booking_id") + relation (onDelete: Cascade); catalogItemId String?
  @map("catalog_item_id") + relation (onDelete: SetNull); name String (snapshot —
  custom items have no catalog row); quantity Int @default(1); isHeavy/
  needsDisassembly Boolean @default(false) (snapshots); notes String?; createdAt;
  @@index([bookingId]).
- Booking additions (all nullable/defaulted, snake_case @map):
  truckId String? @map("truck_id") + `truck Truck? @relation(...)`;
  priceOverrideReason String? @map("price_override_reason");
  originPropertyType String? @map("origin_property_type") (house|apartment|storage|
  office|other); destPropertyType String? @map("dest_property_type");
  serviceMode String? @map("service_mode") (full_service|labor_only|loading_only|
  unloading_only); coiRequired Boolean @default(false) @map("coi_required");
  inventoryItems BookingInventoryItem[].
- Migration folder prisma/migrations/20260811000000_moving_os_phase1/migration.sql
  covering EXACTLY the above.
- Then `npx prisma generate` and `npm run typecheck` must pass.
- Also add to src/lib/permissions.ts: the three Phase-1 permissions (OWNER+MANAGER;
  follow the file's structure and OWNER_ONLY conventions — these three are NOT
  owner-only).
- Seed data: create src/lib/inventory-catalog.ts exporting
  `DEFAULT_INVENTORY_CATALOG: Array<{name, category, isHeavy?, needsDisassembly?,
  recommendedMovers?}>` (~40 common moving items: queen/king/full/twin bed (+frames,
  disassembly), mattresses, dressers, nightstands, couches (3-seat/loveseat/
  sectional-heavy), tables (dining/coffee), chairs, desks, bookshelves, TVs by size,
  washer/dryer/fridge/stove (heavy, 2 movers), boxes S/M/L/wardrobe, bags, piano
  (heavy 4), safe (heavy 3+), pool table (heavy 3, disassembly), treadmill,
  elliptical, grill, patio set, mirrors/art, lamps, rugs). Also export
  `async function ensureCatalogSeeded(prisma)` that inserts missing names with
  createMany skipDuplicates — called lazily by the catalog GET route, so the first
  page load seeds an applied-migration DB and an unapplied DB fails soft.

## Stage 2A — estimating assistant
- src/lib/estimate-assistant.ts — PURE, advisory, never prices anything. Header
  comment stating the contract (mirror pricing-intelligence.ts's "no write path to
  a customer price" stance).
  Input: { serviceType?: string|null; bedrooms?: number|null;
  inventory: Array<{name; quantity; isHeavy?; needsDisassembly?; recommendedMovers?}>;
  originStairFlights?; destStairFlights?; originHasElevator?; destHasElevator?;
  longCarry?: boolean; needsPacking?; needsAssembly?; needsDisassembly?;
  additionalStops?: number }
  Output: { jobSizeLabel: string; crewSize: number; truckSize: string|null;
  estimatedHoursMin: number; estimatedHoursMax: number; possibleTrips: number;
  difficulty: 'standard'|'elevated'|'high'; reasons: string[] }.
  Rules (deterministic, whole numbers):
  - Base by package key (MOVE_SIZES keys from src/lib/estimate.ts): little-studio/
    half-studio → 2 crew 2-3h; full-studio/one-bedroom → 2 crew 3-4h;
    two-bedroom → 3 crew 4-6h; three-bedroom → 3 crew 5-7h; four-bedroom → 4 crew
    6-8h; five-bedroom-plus → 5 crew 8-10h; not-sure/null → 2 crew, hours null-ish
    → use 3-5h and reason "size unconfirmed — verify on the call".
  - Truck from MIN_TRUCK_BY_PACKAGE / assignTruck in src/lib/pricing-config.ts
    (import read-only); not-sure → null truck + reason.
  - +1 crew if total heavy items (isHeavy quantity sum) >= 2, or any item with
    recommendedMovers >= 3; +1h to both bounds per 2 stair flights beyond the first
    across both ends when no elevator on that end; +1h max-bound for packing;
    +30min-equivalent (round up) for each of assembly/disassembly when flagged or
    any inventory needsDisassembly; +1 possible trip when the item count sum > 40
    or (serviceType is studio-class AND heavy >= 2); difficulty escalates: any
    heavy item OR stairs>=2 flights → 'elevated'; (heavy AND stairs) OR piano/safe/
    pool-table name match → 'high'.
  - EVERY adjustment pushes a human-readable reason string ("Second-floor stairs at
    pickup, no elevator", "Bed disassembly required", "2-bedroom inventory").
  - Crew capped 2..5, hours capped 2..12, all integers (hours may be halves).
  Acceptance (test these exactly): 2-bedroom + two couches + destStairFlights 2 no
  elevator + a bed with needsDisassembly → { crewSize: 3, truckSize: '15ft' per the
  live truck table (use whatever MIN_TRUCK_BY_PACKAGE actually returns for
  two-bedroom — read it, don't guess), hours 4..6 or 4..7 with the +1h stair/
  disassembly rules applied consistently, difficulty 'elevated'+, reasons include
  stairs + disassembly + size }.
- POST /api/admin/estimate/recommend — session + can('booking.create_admin');
  zod body mirroring the input; returns { recommendation, quote } where quote =
  computeEstimate(estimate.ts) mapped from the same body (serviceType +
  structured access fields it supports) — quote is the RECOMMENDED price shown in
  the workspace; no persistence.
- Tests: src/lib/__tests__/estimate-assistant.test.ts (the acceptance case above,
  not-sure honesty, crew/hour caps, reasons non-empty, truck matches
  MIN_TRUCK_BY_PACKAGE for every package key).

## Stage 2B — trucks
- src/lib/truck-conflicts.ts — pure: `overlapWindow(aStart, aEnd, bStart, bEnd,
  fallbackHours=6)` and `findTruckConflictsIn(bookings, {truckId, start, end,
  excludeBookingId})` over plain booking shapes {id, truckId, scheduledStart,
  scheduledEnd, confirmedDate, status} using live statuses CONFIRMED/SCHEDULED/
  IN_PROGRESS; when scheduledEnd missing, assume fallbackHours (align with
  reminder-rules' 4h default? use 6h for trucks and say why: trucks are held for
  load+drive+unload). Same-ET-day two bookings sharing a truck with unknown times
  = conflict (conservative).
- API: GET/POST /api/admin/trucks (list incl. that day's bookings when ?date=,
  create) + PATCH /api/admin/trucks/[id] (name/size/source/status/capacityNotes/
  active) — truck.manage, audited (AuditAction: use BOOKING_STATE_CHANGED? NO —
  add nothing to the enum; use details-rich generic? Existing enum has no truck
  action. Use AuditAction.BOOKING_STATE_CHANGED ONLY for booking changes; for truck
  CRUD write action: 'STAFF_PROFILE_UPDATED'? NO. → Add enum values TRUCK_CREATED /
  TRUCK_UPDATED to AuditAction in Stage 1 schema + migration (ALTER TYPE ... ADD
  VALUE IF NOT EXISTS) — Stage 1 owns this, Stage 2B consumes.)
- Admin page /admin/trucks: list (name, size, source, status, active, today/
  upcoming assignments count), inline create form, edit/status toggle via client
  island. Fail-soft when table missing.
- Action Center rule: in src/lib/reminder-rules.ts add `truck-double-booked`
  (category JOBS_SCHEDULING, CRITICAL) — evaluate over bookings that share a
  truckId with overlapping windows (reuse the pure lib); dedupeKey
  `truck-double-booked:truck:<truckId>:<yyyy-mm-dd>`. Wire the booking select in
  src/lib/reminder-sync.ts to include truckId (+ scheduledEnd already there?
  verify). Keep the rule pure like the others; tests go next to the lib.
- Tests: src/lib/__tests__/truck-conflicts.test.ts (overlap math, unknown-times
  same-day conservative conflict, exclude self, cancelled ignored; reminder rule
  fires + dedupeKey stable).

## Stage 2C — lead pipeline
- POST /api/admin/leads — manual lead entry (lead.manage): zod {name?, phone?,
  email?, moveDate?, moveSize?, originZip?, destinationZip?, notes? → compose into
  the existing notes convention, serviceInterest?}; at least one of phone/email
  required; source: LeadSource.MANUAL_ENTRY; status NEW; audit LEAD_CREATED
  (enum value exists, currently never written — wire it, no schema change).
- PATCH /api/admin/leads/[id] (lead.manage): actions
  `mark_contacted` (status NEW→CONTACTED + contactedAt first-wins),
  `set_follow_up` (CONTACTED/QUOTE_SENT→FOLLOW_UP),
  `mark_lost` (any open status→LOST; lostReason REQUIRED zod nativeEnum
  LeadLostReason; lostAt),
  `reopen` (LOST→NEW, clears lostAt/lostReason),
  `assign` (assignedTo string|null).
  Transitions validated against a pure map in src/lib/lead-transitions.ts
  (export ALLOWED_LEAD_ACTIONS + applyLeadAction(lead, action, payload) returning
  {data} or {error} — offline-testable). BOOKED is NEVER settable by hand (only
  markLeadConverted). Audit LEAD_STATUS_CHANGED {from, to, reason?, by}.
- /admin/leads page: add a pipeline counts bar above the table — one chip per
  LeadStatus (NEW/CONTACTED/QUOTE_SENT/FOLLOW_UP/BOOKED/LOST) with count
  (groupBy status) linking to ?status= filter (add status filter support to the
  existing filter logic); make each row link to the new detail page.
- /admin/leads/[id] detail page: contact block (tel:/mailto: links, contactPreference
  + bestTimeToCall surfaced), stage timestamps rail (createdAt/contactedAt/quotedAt/
  bookedAt/lostAt), consent + suppression badges (reuse the list page's helpers),
  captured move info (date/size/zips/notes), lead-linked EmailSend rows (to,
  template, status, createdAt — take 20), action buttons client island (Mark
  contacted / Needs follow-up / Mark lost w/ reason select / Reopen / Assign) +
  "Convert to booking →" link to /admin/book?leadId=<id>, converted badge linking
  to the booking when convertedBookingId set.
- src/lib/entity-links.ts: map lead → /admin/leads/[id] (the comment says update
  when pages ship — this ships it).
- Tests: src/lib/__tests__/lead-transitions.test.ts (every allowed action, LOST
  requires reason, BOOKED unreachable, reopen clears loss fields, idempotent
  contactedAt first-wins).

## Stage 2D — audit-found bug fixes (small, surgical)
1. app/crew/CrewAssignmentCard.tsx: clock() must POST to
   `/api/crew/assignments/${id}/clock` (today it hits /api/admin/... which
   middleware 403s for CREW — confirmed bug).
2. app/(admin)/admin/login/page.tsx: honor `?next=` on success when it starts with
   '/' and is a local path (else default /admin); middleware.ts: the
   insufficient-permission redirect for a CREW role hitting /admin must go to
   /crew, not /admin (kills the redirect loop).
3. src/lib/booking-approval.ts: inside the approval transaction, extend
   customerTokenExpiry to max(current, moveDate/confirmedDate + 3 days, now + 30
   days is WRONG — use: greatest of existing expiry and (scheduled move date + 3d),
   falling back to now+30d when no date) so portal links survive to move day
   (audit: tokens die 7 days after creation). Keep it one field in the existing
   update; comment why.
No tests required beyond typecheck for 1-2; for 3 add a pure helper
`extendedPortalExpiry(current: Date|null, moveDate: Date|null, now: Date): Date`
in src/lib/booking-approval.ts (exported) + 4 assertions appended to
src/lib/__tests__/booking-approval.test.ts following its existing style.

## Stage 3 — admin booking create + Book Move workspace (after 1, 2A, 2B)
- src/lib/admin-booking.ts — pure helpers (offline-testable):
  `AdminBookingSchema` (zod): customer {name req, email optional-but-validated,
  phone req-if-no-email, locale 'en'|'es' default en}; move {serviceType key from
  MOVE_SIZES | 'not-sure', moveDate ISO date (>= today ET), arrivalWindow?,
  originAddress {street, city, state def NJ, zip}, destAddress same,
  originPropertyType/destPropertyType enums, originFloor?/destFloor?,
  originStairFlights?/destStairFlights?, originHasElevator?/destHasElevator?,
  longCarry?, coiRequired?, accessNotes?, additionalStopsCount? int};
  services {serviceMode, needsPacking/Unpacking/Assembly/Disassembly booleans};
  inventory: Array<{catalogItemId?, name req, quantity 1..99, notes?}> (may be
  empty — but empty triggers a returned warning string);
  truckId?; itemsDescription?; crewInstructions?;
  pricing {ownerTotal number>0 dollars, overrideReason required-when
  ownerTotal differs from server recommendation by > $1};
  deposit {mode: 'stripe_link'|'collect_on_day'|'waived'};
  sendNothing: the flow never emails the customer (UI copy states it).
  `buildBookingCreateData(input, {estimate, travel, reference, token, tokenExpiry})`
  → the prisma Booking.create data object mapping every structured column the
  public route maps (mirror app/api/bookings/route.ts lines ~377-466: originAddress
  string composed "street, city, state zip" + structured fields, serviceType,
  baseRate = estimate.estimatedTotal - travelFee convention, totalEstimate =
  ownerTotal, depositAmount 4900, status per deposit mode, source 'admin',
  bedrooms from serviceType map where derivable).
  `decideStatus(depositMode)` → stripe_link: PENDING_PAYMENT; collect_on_day |
  waived: CONFIRMED.
- POST on the EXISTING app/api/admin/bookings/route.ts (it exports GET only —
  add POST; booking.create_admin): flow —
  1. zod parse; 2. checkServiceArea(originZip/destZip) server-side (service-area.ts)
  → zone + travelFee (manual_review zone is ALLOWED for admin — owner decides —
  but recorded); 3. computeEstimate for the recommendation (same inputs as the
  public route); 4. Customer upsert by email (email absent → synthesize
  `no-email-<phonedigits>@placeholder.invalid`, a deliberate never-deliverable
  address: guardedSend validation refuses it, which is the honest behavior; comment
  this); 5. transaction: booking create (bookingReference via
  src/lib/booking-reference.ts atomic pattern from the public route, customer
  portal token like the public route but expiry = moveDate+3d min now+7d),
  BookingInventoryItem createMany (snapshot name/isHeavy/needsDisassembly from
  catalog when catalogItemId given), Job upsert {status SCHEDULED} when status
  CONFIRMED, JobStaffingRequirement create from the assistant recommendation
  (requiredWorkers=crewSize, minimumWorkers=max(2,crewSize-1), requiredDrivers 1,
  requiresLead true, hasStairs/hasElevator/longCarry/heavyItems/packing/assembly
  from inputs+inventory, estimatedStartAt from scheduledStart), audits:
  BOOKING_CREATED {source:'admin', by, depositMode} + PRICE_CHANGED {recommended,
  ownerTotal, reason} when overridden (both enum values exist, currently dead —
  this wires them); 6. when CONFIRMED also stamp confirmedDate/scheduledStart/
  scheduledEnd via confirmationScheduleData (src/lib/scheduling.ts — same as
  approveBooking); 7. deposit stripe_link mode: create the checkout session
  (src/lib/stripe.ts same as public route) and store stripeCheckoutId; return its
  url; 8. markLeadConverted (src/lib/leads.ts) with the customer email/leadId when
  provided; 9. fire-and-forget syncReminders('API') (reminder-sync.ts — currently
  dead export, wire it) wrapped in catch; 10. truck conflict check (Stage 2B lib)
  BEFORE the tx → if conflicts, refuse unless body.truckConflictOverride=true
  (then include in audit details) — never allow silent double-booking (the
  direction's hard rule); 11. response {bookingId, bookingReference, portalUrl,
  stripeUrl?, jobId?, warnings[]} (warnings: empty inventory, manual-review zone,
  not-sure size, truck override).
- /admin/book page + BookMoveForm client island (the phone-call workspace):
  sections top-to-bottom (Jobber-simple, one screen, no wizard): Customer
  (search-as-you-type against new GET /api/admin/customers/search?q= — add that
  tiny route, session+booking.create_admin, name/email/phone contains, take 8,
  returns id/name/email/phone/bookings count; picking one fills the fields;
  ?leadId= prefills from the Lead server-side), Move details (date, window,
  addresses w/ property-type selects, stops), Access (floors/stairs/elevator/
  long carry/COI/parking notes), Services (mode radio + 4 checkboxes), Inventory
  (search input hitting GET /api/admin/inventory/catalog?q= (new route: session-
  gated, ensureCatalogSeeded lazy, ilike take 10) + qty steppers + custom item
  add + running list), Recommendation card (debounced POST /api/admin/estimate/
  recommend; shows crew/truck/hours/trips/difficulty + REASONS + recommended
  price; refresh button), Truck select (GET /api/admin/trucks?date= — shows
  per-truck busy state, conflict warning inline + explicit override checkbox),
  Price (recommended readonly, owner price input, reason input appears when
  differs), Deposit mode radios (copy: stripe link = "hold link to send",
  collect_on_day, waived), BOOK MOVE button → success panel: booking ref, links
  to /admin/jobs/[id], portal URL copy button, Stripe URL copy button when
  present, list of everything that cascaded (booking/job/staffing/lead/scan) —
  the direction's "everything else happens from that decision" made visible.
- Sidebar: add "Book Move" at the top of Overview (route /admin/book) and
  "Trucks" under Operations (route /admin/trucks) in
  app/(admin)/admin/(dashboard)/Sidebar.tsx.
- Tests: src/lib/__tests__/admin-booking.test.ts — zod acceptance/rejection
  (email-or-phone, override reason required when differing, date past refusal),
  buildBookingCreateData column mapping (origin composition, baseRate/totalEstimate
  convention incl. travel, status by deposit mode), placeholder email synthesis,
  staffing-requirement derivation from a recommendation.

## Stage 4 (orchestrator-owned)
package.json test-list append; full npm test + typecheck; Sidebar conflict check;
review pass; commits.
