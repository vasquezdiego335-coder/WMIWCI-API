# Moving OS Phase 2 — Dispatch, Capacity, Readiness, Monitoring (owner spec 2026-08-12)

Phase 2 makes the system operate the company day to day. The standard:

> Before a move happens, the system knows whether we are actually ready to perform it —
> and the owner answers "can I take another job?", "who works tomorrow?", "what is not
> ready?" from ONE screen, without comparing five pages.

Take operational depth from moving-industry software and simplicity from Jobber-class
tools; copy neither's interface, branding, behavior, or code. This is built for Move It
Clear It.

## GATE — do not build on broken Phase 1
Phase 2 implementation MUST NOT begin until the correctness pass in
docs/moving-os-phase1-fixes.md verifies. Gate items (owner's list) → fix-pass items:
$49/stripe_link staffing (1) · real scheduled times (2) · customer identity (3) ·
labor-only staffing (4) · specialty mover minimum (5) · structured booking parity (6) ·
scan honesty (7) · admin auth (8). Truck concurrency (9) satisfies §15 below.
Any FAIL is fixed before new functionality.

## Standing rules (carry over from Phase 1)
- No customer-facing price constants change (pricing-config.ts, service-area.ts).
- Migrations are hand-authored, additive, idempotent, and NEVER applied to a database
  by an agent. New surfaces fail soft with an honest "migration not applied" message.
- Admin API house pattern: getSession→401, can()→403, zod→422, mutation+AuditLog in one
  $transaction, apiLogger.
- No faked capability: no SMS if SMS is not connected, no ETA if there is no routing
  provider, no "sent" before delivery, no "verified" without verification.
- ONE SOURCE OF TRUTH (§24): derive operational views from canonical records. Never
  store a second copy of job time, staffing requirement, or truck assignment.

## 1. Operational Readiness engine — the core of Phase 2
`src/lib/readiness.ts` — ONE pure, deterministic evaluator (no AI, no heuristic scores)
consumed by dashboard, job page, dispatch, calendar, Action Center, and capacity.

Shape:
```
evaluateReadiness(job, now) -> {
  status: 'READY' | 'NOT_READY',
  score: number,            // 0-100, secondary to status
  blocking: ReadinessIssue[],
  warnings: ReadinessIssue[],
  informational: ReadinessIssue[],
  passed: string[],
  categories: Record<Category, { status, issues }>,
}
ReadinessIssue = { key, category, severity, message, action?: { label, href } }
```
- `status` is authoritative; `score` is a visual aid. NEVER render a bare number —
  every surface shows WHY plus an action where one exists.
- Computed from current data, never stored stale. If caching becomes necessary,
  invalidation must be provably reliable; prefer derive-on-read at this scale.
- `key` is deterministic and stable (e.g. `job:<id>:crew_short`) — Action Center
  dedupe (§5) and readiness share the same semantics (§8).

CATEGORIES + severity. BLOCKING ⇒ NOT_READY. WARNING ⇒ still READY but surfaced.
INFORMATIONAL ⇒ context only, excluded from the calculation.

- CUSTOMER & JOB: customer exists, valid pickup address, valid destination when the
  service requires one, move date, real scheduled time / arrival window (Phase-1 fix 2
  means this is now truthful), service type, pricing established. BLOCKING: missing
  pickup, missing required destination, missing move time.
- INVENTORY / SCOPE: inventory present when required, move size, specialty items
  identified, requested photos, disassembly/assembly documented, heavy-item
  requirements understood. WARNING mostly; escalates by proximity (§ timing).
- ACCESS (when applicable): stairs, elevator, parking/access notes, long carry,
  loading dock, building restrictions, COI requirement flagged.
- CREW: staffing requirement exists, required count established, enough movers
  assigned, driver assigned when required, assigned staff available, no overlapping
  assignment, required skills covered. BLOCKING: no crew, insufficient crew, driver
  required but missing, worker conflict.
- TRUCK — SERVICE-TYPE AWARE (§13, non-negotiable): for company-truck jobs, truck
  required/assigned/available/no overlap/size appropriate → BLOCKING when missing or
  conflicting. For labor-only / customer-truck jobs, the ABSENCE of a company truck
  and driver is CORRECT and must never reduce readiness or raise a warning.
- MONEY / BOOKING: booking status valid, deposit/hold state understood, price
  established, payment anomalies surfaced. An unpaid final balance does NOT make a
  future job NOT_READY (no business rule requires prepayment).
- DOCUMENTS: COI uploaded when required (BLOCKING near the move), required documents,
  special instructions acknowledged.

TIMING (urgency rises as the job approaches; reuse Action Center severity conventions):
same issue is a WARNING at 10 days and CRITICAL tomorrow. Encode as a per-issue
proximity ladder, not a global multiplier.

24-HOUR KPI FOUNDATION (§17): record readiness TRANSITIONS (NOT_READY→READY and back)
with timestamps — transitions only, never a row per scan — so "was this job ready 24h
before start?" is answerable later without building analytics now.

## 2. Dispatch board
Calendar answers *when*; dispatch answers *who and what performs it*.

MANDATORY (Scenario K): every confirmed/operational job appears, INCLUDING one with no
Job row or no assignments. Phase 1's audit found the board required `job isNot null`,
so untouched bookings — the ones most needing dispatch — were invisible. The query is
booking-driven with assignments joined optionally.

- UNASSIGNED lane first, showing needs (movers, driver, truck) and readiness.
- Worker-centric lanes (adapt to the existing worker-centric model; do not invent
  fixed "Crew A/B" entities).
- Day view primary; week overview secondary.
- Job cards: time, customer, origin→destination, service type, move size, estimated
  duration, required vs assigned movers, required vs assigned driver, truck
  requirement vs assigned truck, readiness, key warnings.
- Assign/remove worker, crew lead, driver, truck inline — no navigation for routine
  dispatch.
- Drag-and-drop ONLY if it does not reduce reliability; a clean assignment modal that
  works beats a fragile drag. Either way the conflict preview runs BEFORE commit and
  the server re-checks at mutation time (§14, §15). Overrides are explicit, permitted
  by role, and audited — never silent.
- Mobile: a purpose-built responsive surface (unassigned, not-ready, today's crews,
  assign worker/truck, conflicts, job details) — not a shrunken desktop board.

## 3. Travel gap intelligence
No routing provider exists. Do NOT invent ETAs. Use scheduled end → next scheduled
start against known addresses, flag TIGHT/IMPOSSIBLE gaps conservatively, and state the
estimate's basis. Architect the seam so a routing provider can replace the heuristic
later without touching callers.

## 4. Capacity engine
`src/lib/capacity.ts`, per day: jobs vs configured limit, movers required vs available,
mover-hours required vs available (crew × estimated hours; sum per day), drivers
required vs available, company trucks required vs available, truck conflicts,
unassigned staffing requirements.

States: AVAILABLE / GETTING FULL / NEAR CAPACITY / OVER CAPACITY — each with a stated
REASON ("all company trucks allocated 9 AM–2 PM"). No mystery score.

Honesty rule: theoretical mover-hours ≠ schedulable. Distinguish "capacity estimate"
from "actual schedule feasibility" in the copy; overlapping windows and travel still
decide reality.

Surfaces: Book Move date selection (shows the day's load and warns what a new move
would demand — warn, never hard-block absent a real rule; owner override is informed,
not silent) and compact calendar indicators (detail on click, never clutter).

## 5. Automatic Action Center monitoring
Cron scan on the existing worker infrastructure every 15–30 min (documented cadence),
scoped to OPEN/UPCOMING work only — never a full-history sweep (§23). The owner must
never need to open a page for a problem to be found.

Rules (keep existing; add moving-specific): confirmed move with no staffing
requirement · no crew · insufficient crew · driver required but missing · company truck
required but missing · truck conflict · crew conflict · job tomorrow missing
pickup/destination · job tomorrow missing expected inventory · large move with
suspiciously small crew (derived from the estimator/requirement, never "all 3-bedroom
moves need 4") · specialty-item requirement unsatisfied · assembly/disassembly
requested with incomplete operational notes · COI required but missing · capacity
exceeded / severe resource shortage · completed job with outstanding balance ·
critical automation/queue failure.

DEDUPE + LIFECYCLE: deterministic keys (`JOB_<id>_MISSING_CREW`); a repeat scan UPDATES
the open issue (including severity escalation as the job nears) rather than creating a
duplicate; when the condition clears the issue auto-resolves.

## 6. Discord critical alerts — secondary channel only
Database/admin is the source of truth; no workflow may depend on Discord delivering.
CRITICAL and carefully chosen urgent warnings only. Cooldown/dedupe: initial alert,
then re-alert only on severity increase, meaningful change, significant proximity
change, or a configured reminder threshold. Delivery failure is logged and NEVER loses
the Action Center issue.

## 7. Crew assignment notification delivery
Phase 1's audit confirmed AssignmentNotification rows are written and nothing sends
them. Build the delivery sweep: pick up unsent → attempt delivery → mark sent ONLY on
success → record failure + retry with backoff. Content is practical (job, date, report
time, move time, route, role) with a secure crew-portal link; no owner-only data.
Report-time reminders where the infrastructure genuinely supports them, on connected
channels only.

## 8. Unified warning surface
Conflict engine, readiness engine, Action Center rules, and capacity may stay separate
internally, but the OWNER sees one converged list per job with shared semantics and no
duplicates — on the job page, dispatch, and Action Center alike.

## 9-11. Surfaces
- JOB PAGE: readiness panel near the TOP (status, score, blocking, warnings, actions).
- DASHBOARD: TODAY and TOMORROW — jobs, ready, not ready, mover demand, truck demand,
  capacity — then the single most important NOT READY job.
- CALENDAR: subtle readiness indicator per job (ready / warning / not ready); click
  reveals the explanation. No visual chaos.

## 12-16. Rules that must hold
- Understaffing is derived from structured data (move size, inventory, specialty
  requirements, estimated duration, estimator recommendation, staffing requirement) —
  never a hardcoded size→crew assumption unless configured.
- Company vs customer truck (§13) governs every warning, readiness item, and capacity
  count.
- Conflict validation is server-side, not frontend-only.
- Concurrency (§15): the final server mutation re-checks conflicts before commit;
  client preview is never the guard. (Phase-1 fix 9 established the advisory-lock
  pattern for trucks — reuse it for crew.)
- Action Center priority: CRITICAL = tomorrow's execution in danger; HIGH = must
  resolve soon; NORMAL = matters but does not threaten the next operating day.

## 18-19. Audit + permissions
Log crew/truck assign+remove, dispatch and conflict overrides, readiness transitions
(meaningful ones only), critical issue created/resolved, capacity override. Do not
flood the log with automated evaluations.
Roles: OWNER full; ADMIN operational; CREW LEAD limited; MOVER own data only. Crew
endpoints must never leak revenue, owner money, marketing config, or other workers'
sensitive data. Backend permissions tested directly, not assumed from UI gating.

## 21. Crew Mode
Crew see their work: report time, move time, pickup, destination, and the warnings that
affect them (STAIRS, BED DISASSEMBLY, WOOD FLOORS), with Directions / Arrived / Start /
Checklist / Photos / Report Issue / Complete. Crew never see owner-only readiness or
financial context ("bring floor protection" yes; "margin 21%" never).

## 22. Test scenarios (Phase 2 is not done until these pass)
A ready job · B zero crew tomorrow (visible on dashboard, dispatch unassigned, job
page, Action Center, Discord if configured) · C partially staffed 2/4 · D labor-only
with customer U-Haul → READY with NO false missing-truck/driver warnings · E truck
conflict across overlapping windows · F worker conflict · G capacity pressure during
Book Move · H COI required and missing · I issue resolution (assign crew → readiness
recomputes → issue auto-resolves → no duplicate Discord spam) · K MANDATORY: confirmed
job nobody has ever dispatched still appears everywhere it should.

## 23. Performance
Scans must not degrade the database: bounded date ranges, indexed queries, no N+1 in
readiness evaluation over a day's jobs, batched notification sweeps, pagination on
dispatch ranges. Scoped to relevant open/upcoming work. Measure before optimizing
further, but never ship a cron that walks all history.

## 25. Scope discipline
Phase 2 is dispatch, capacity, readiness, monitoring, notifications, unified warnings.
NOT payroll, storage, fleet maintenance, route-optimization AI, a customer app, GPS
tracking, payroll tax, territory management, or accounting replacement. Finish these
extremely well.

## 26-27. UI + owner guide
Fast, professional, dense-but-scannable, careful status colors; no decorative cards,
emoji UI, animation, mystery icons, or tiny text. Update /admin/owner-guide (which does
not exist yet — Phase 1's audit found ZERO in-app help) with: preparing tomorrow's
jobs, what READY means (blocking vs warning), using dispatch, what a conflict means,
when overriding is appropriate, reading capacity (mover-hours, trucks, jobs), why
Discord alerted you (secondary channel — the real issue is in Action Center), and when
crew notifications send. Written for an owner who did not build the software.
