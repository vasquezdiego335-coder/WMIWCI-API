# Release: Stage 5 scheduling + pricing + complete email automation runtime

_Integration record for branch `claude/release-stage5-email-integration`,
prepared 2026-07-23. Base: `origin/main` @ `810f95b8`._

## 1. What this release contains

| System | Source | How it arrived |
| --- | --- | --- |
| Core booking + Stage 4 financial closeout | `main` (#17, squash `a4833a5b0`) | already on base |
| Email Marketing admin + journeys + campaign dispatch + automation runtime | `main` (#18, squash `810f95b8`) | already on base |
| Centralized pricing (price book, tiered add-ons, parity tests) | `claude/pricing-system-2026-07` @ `8fa8412f` | merged (`1b7b2ff0`) |
| Stage 5 crew management + scheduling + crew portal + clocking | `claude/stage5-staging-rehearsal` @ `e97fe280` | merged (`ad867d76`) |
| main test-registration hotfix | `fix/main-test-registration` @ `ddb7f310` | superseded — content already on main via #18; patch-identical twin `9a501b1e` carried inside Stage 5 |

Merge order actually used: **pricing → stage5** (both true `--no-ff` merges;
the hotfix and email branches required no action). The pricing branch's 11
Stage 4 commits are byte-identical to the #17 squash (verified: empty
content diff), so only `8fa8412f` introduced new content.

## 2. Conflicts and resolutions (union — nothing dropped)

| File | Sides | Resolution |
| --- | --- | --- |
| `app/api/bookings/route.ts` | email lead-conversion imports vs pricing-config import | kept BOTH import lines; email's lead-conversion block and pricing's tiered zod schema coexist |
| `package.json` (test line, ×2 merges) | email tests / pricing tests / stage5 tests | union of all three; `discount-decision.test.ts` stays removed (module deleted by pricing) |
| `src/lib/permissions.ts` | email Action block + BETA owner-only list vs Stage 5 blocks | both blocks kept in the Action union AND in OWNER_ONLY; stage5 crew additions auto-merged |
| `app/(admin)/…/jobs/[id]/page.tsx` | auto-merge produced a duplicate `import { can }` | integration fix in `ad867d76`: kept Stage 5's `{ can, type Role }` |

Verified by hand after auto-merge: `app/api/discord/interactions/route.ts`
keeps BOTH `onBookingConfirmed` (move-reminder anchoring) and pricing's
retired door-hanger card refusal.

## 3. Migrations

Release migration set = main's 39 + `20260722000000_stage5_crew_scheduling`
(additive, no collision with `20260722000100_email_dispatch_runtime`).

| Scenario | Result |
| --- | --- |
| Stage 4 production-state DB (36 baselined) → release | ✅ applies 4 pending in timestamp order (email ×3 interleaved with stage5) |
| Stage 4+5 staging DB → release (out-of-order case) | ✅ applies the 3 email migrations |
| Schema ↔ applied SQL | ✅ `prisma migrate diff` = "No difference detected" on BOTH upgraded DBs |
| Fresh empty DB → `migrate deploy` | ❌ pre-existing repo-wide: earliest migration ALTERs `bookings`, which nothing creates. Bootstrap = apply schema + baseline (unchanged by this release) |

Rollback: all release migrations are additive — roll back the code deploy
and leave the columns. Do not edit applied migrations.

Note: `20260721230000_email_marketing_admin` contains non-ASCII comment
characters; it requires a UTF-8 database (Neon is UTF-8 — fine; a WIN1252
local Postgres refuses it).

## 4. Redis / worker topology

Queues (all created lazily, producer side in `src/lib/queues/index.ts`):
`email`, `sms`, `discord`, `webhook-retry`, `scheduled`, `marketing`.
Job types on `marketing`: `campaign-batch`, `campaign-recipient-retry`,
`campaign-sweep` (cron */5), `automation-stage`, `automation-sweep` (cron */15).

- **Stage 5 adds NO queues** — crew notifications are ledger-only
  (`AssignmentNotification`; no delivery worker exists yet, by design).
- Worker host (`npm run host:start`, Railway worker service) launches all six
  processors explicitly; nothing starts from a module import.
- Exactly-once: campaign sends carry `eventId = campaign-run:<runId>` through
  `guardedSend` → the EmailSend idempotency key dedupes across restarts.

### Redis-outage hardening (integration fixes in this release)

The combined rehearsal ran the web app against a dead Redis port and found
three availability defects (all predating this branch, shipped in #18 and
earlier):

1. `journeys.cancel()` had no deadline → booking cancel/approve/reschedule
   requests hung forever during an outage. Fixed: 5s race, same idiom as
   `enqueue()` (`ab6780d4`).
2. No BullMQ Queue had an `'error'` listener → Node killed the web process on
   the first forwarded ioredis error. Fixed: `guardQueue()` warn-logging
   listener on all six queues (`ab6780d4`).
3. The booking status route awaited raw `emailQueue.add()` → same hang.
   Fixed: `withDeadline` race on both enqueues (`b1aba0d5`).

Verified live: booking cancel on dead Redis returns 200 in ~15s, state
persists, process survives (55/55 rehearsal).

**Known, deliberately unfixed** (documented, does not block): the email admin
"scheduled" tab (`email-admin.ts` `getJobs`/`getJob`) still awaits unbounded
queue reads and would stall that one admin page during an outage.

## 5. Permissions (combined matrix)

One registry (`src/lib/permissions.ts`). Cross-system invariants locked by
`src/lib/__tests__/release-permissions-integration.test.ts`:

| Area | OWNER | MANAGER | CREW |
| --- | --- | --- | --- |
| Email Marketing (all 10 `email.*`) | ✅ | ❌ (BETA owner-only; post-beta trio = `EMAIL_BETA_OWNER_ONLY`) | ❌ |
| Staff admin (`staff.manage/invite/deactivate`) | ✅ | ❌ | ❌ |
| Schedule ops (`schedule.view/manage`, `staff.view`, `staff.manage_availability`) | ✅ | ✅ | ❌ |
| Conflict override (`schedule.override_conflicts`) | ✅ | ❌ | ❌ |
| Own assignments (`assignment.view_own/acknowledge_own`) | ✅ | ✅ | ✅ (own rows only, enforced at route) |
| Stage 4 money/closeout | unchanged | unchanged | unchanged |

Crew is additionally IDOR-tested (cannot read or act on another worker's
assignment) and blocked from /admin by middleware.

## 6. Audit

Stage 5 adds 24 `AuditAction` values (STAFF_*/INVITATION_*/AVAILABILITY_*/
ASSIGNMENT_*/CONFLICT_OVERRIDDEN/STAFFING_REQUIREMENT_CHANGED); email added
20 EMAIL_* values on main. Zero collisions; both live in the one enum +
migration set; the combined audit_logs table carries both families (verified
live in the rehearsal, including CONFLICT_OVERRIDDEN with target and the
clock actions).

## 7. Admin navigation

Sidebar (merged, no duplicates): Operations → Dashboard/Action Center/
Calendar/**Scheduling**/Jobs/Bookings/Customers/**Staff & Crew**; Money →
Revenue/Expenses/Owner Money/Reports; Growth → **Email Marketing (BETA)**/
Discounts; System → Roadmap/Activity Log/Queues. Crew portal stays separate
at `/crew`. Every link resolves to a built route (verified in build output).

## 8. Booking / job event hooks (single source of truth each)

| Event | Call site | Action |
| --- | --- | --- |
| Checkout started | `POST /api/bookings` | `onCheckoutStarted` (recovery journey) |
| Lead converted | `POST /api/bookings` | `markLeadConverted` + `onLeadClosed` (stops quote follow-up) |
| Quote sent | email-marketing lead quote route | `onQuoteCreated` |
| Booking paid | `fulfillment.ts` (Stripe success) | `onBookingPaid` |
| Approved/confirmed | admin status route + Discord approve | `approveBooking` (capture) + `onBookingConfirmed` → idempotent `onMoveDateSet` (cancel-then-enqueue = reschedule re-anchors, no dupes) |
| Cancelled | admin status route | `onBookingCancelled` (stops recovery + reminders + follow-ups + enrollments + balance reminder) + capture-state-aware customer email |
| Completed | admin status route | `onBookingCompleted` (post-move follow-ups, send-time `not-completed` recheck) + `onBookingCompletedBalance` + job-completion email |
| Crew assigned | `POST /api/admin/jobs/[bookingId]/crew` | conflict engine + rate freeze + `ASSIGNED` ledger notification (dedupe key) |
| Clock in/out | `/api/crew/assignments/[id]/clock` | state machine (single open shift) + audit |
| Closeout finalized | closeout routes (Stage 4) | snapshot; email system reads nothing from it |

## 9. Environment variables (delta view)

Release-relevant additions/changes documented in `.env.example` (this branch
adds the previously undocumented `EMAIL_PROMOTIONS_ENABLED`,
`EMAIL_TEST_RECIPIENT`, `EMAIL_CAMPAIGN_BATCH_SIZE`, `EMAIL_CAMPAIGN_STALE_MS`).

| Variable | Needed by | Notes |
| --- | --- | --- |
| DATABASE_URL / SHADOW_DATABASE_URL | web + worker | Neon (UTF-8) |
| REDIS_URL | web + worker | shared BullMQ broker |
| APP_URL | web + worker | must be a production URL for campaign approval (URL gate) |
| JWT_SECRET / CSRF_SECRET / OWNER+MANAGER creds | web | auth |
| STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET | web + worker | live in prod |
| DISCORD_* | worker (+ interactions route) | approval cards |
| RESEND_API_KEY / EMAIL_FROM / EMAIL_REPLY_TO / RESEND_WEBHOOK_SECRET | worker + webhook route | transactional + marketing |
| EMAIL_TOKEN_SECRET / BUSINESS_POSTAL_ADDRESS / GOOGLE_REVIEW_URL | web + worker | unsubscribe links, CAN-SPAM footer, review CTA |
| EMAIL_JOURNEYS_ENABLED | worker + web | lifecycle journeys master switch |
| **EMAIL_PROMOTIONS_ENABLED** | worker + web | campaign/automation master switch — **stays false in production until the provider-level staging rehearsal passes** |
| EMAIL_TEST_RECIPIENT | web | test-send target |
| EMAIL_CAMPAIGN_BATCH_SIZE / EMAIL_CAMPAIGN_STALE_MS | worker | dispatch tuning |
| OUTBOX_ENABLED | worker | legacy outbox poller |
| TWILIO_* (if TWILIO_ENABLED) | worker | SMS |
| Stage 5 adds **no** new environment variables | — | — |

## 10. Combined staging rehearsal (2026-07-23)

Environment: production build (`next start`) on the release branch; disposable
local PostgreSQL 17.5 (`release_staging`, a copy of the Stage 5 fixture DB
migrated forward with the 3 email migrations); Redis = dead port BY DESIGN;
dummy Stripe keys; no Resend key. Nothing could reach a customer, worker,
queue or payment rail.

**Result: 55/55 checks.** Highlights:

- Permission matrix owner/manager/crew/anon across scheduling, staff,
  invitations, email-marketing, suppressions, crew portal (15 checks).
- Scheduling board: fixture jobs + staffing-health labels.
- Conflict engine gates assignment CREATION (OUTSIDE_AVAILABILITY surfaced);
  owner override flow stores `ConflictOverride` rows; duplicate assignment
  refused; `ASSIGNED` ledger notification recorded (no delivery).
- Rate freeze: profile 2600¢ → `hourlyRateCentsSnapshot` 2600¢ at creation.
- Crew portal: own rows only, IDOR refused, ack, clock-in → duplicate
  clock-in refused → clock-out, duration stamped.
- Stage 4 closeout on the combined schema: profitable $1,000/$900/$270/$100/
  $530 → $265+$265 byte-identical re-read; loss closeout FINALIZED with
  honest −$58 net.
- Dead-Redis failure recovery: booking cancel returns 200 in ~15s, state
  persists, process survives.
- Email admin: audience preview/save (completed_customers), campaign draft +
  validate; approve REFUSED by the production URL gate on a localhost
  APP_URL; dispatch REFUSED for an unapproved campaign; zero real sends.
- Combined audit trail carries STAFF_*/ASSIGNMENT_*/CLOCK_* and EMAIL_*.
- Pricing propagation (direct engine call): Full Studio $549 + 2nd stair
  flight $40 = $589 estimated total.

**Not rehearsable in this environment** (no Redis service, no Resend key, no
Stripe test account, no staging deploy target): campaign batch execution and
pause/resume/cancel under a live worker, automation stage execution and exit
conditions, provider webhook → suppression → enrollment stop, worker-restart
duplicate-send proof, Stripe payment webhooks, Discord cards. These remain
covered by the copy-pasteable provider-level rehearsal in
`docs/email/dispatch-staging-rehearsal.md`, which is REQUIRED before
`EMAIL_PROMOTIONS_ENABLED=true` anywhere.

## 11. Validation (committed release tree)

- `git diff --check` clean; no conflict markers anywhere.
- `npx prisma validate` / `generate` ✅
- `npx tsc --noEmit` ✅
- `npm test` **1433/1433** (main baseline was 1200; pricing +57, stage5
  +102, integration/registration +74 incl. 5 previously orphaned files and
  the new combined-permissions regression file; 85 registered test files,
  zero unregistered, zero duplicates)
- `npm run build` ✅ — Stage 5 pages (`/admin/scheduling`, `/admin/staff`,
  `/admin/staff/[id]`, `/crew`) and all 26 email-marketing routes coexist.
- `npm run preview:emails`, `db:preflight`, `email:preflight`, `email:doctor`
  — see final-validation log in the PR body.

## 12. Production deployment order

1. **Approvals**: owner sign-off on this PR; do NOT merge before it.
2. **Backup**: branch production Neon from `production`.
3. Confirm production migration status (`npx prisma migrate status` against
   prod URL — run locally and deliberately; never in the build).
4. `npx prisma migrate deploy` (applies `stage5_crew_scheduling` and any of
   the 3 email migrations not yet applied, in timestamp order).
5. Deploy the ADMIN/web service (Railway `wonderful-strength`, nixpacks:
   `prisma generate` + `next build`).
6. Deploy the WORKER service (Railway `patient-communication`,
   `npm run host:start`). One instance only (dedupe assumes it).
7. Configure/verify Redis reachable from both services (same REDIS_URL).
8. Resend: verify sending domain + webhook endpoint `/api/email/webhook`
   with `RESEND_WEBHOOK_SECRET`.
9. Stripe: confirm webhook signing secret unchanged (this release does not
   touch the webhook route).
10. Discord: confirm bot + interaction endpoint; the retired door-hanger
    card now refuses politely (expected).
11. Health: `/api/health` green (db, env), Bull Board `/admin/queues` shows
    six queues + the two sweeps' repeatables.
12. Transactional email stays ENABLED as today (journeys per
    `EMAIL_JOURNEYS_ENABLED`).
13. **`EMAIL_PROMOTIONS_ENABLED` stays `false`** until the provider-level
    dispatch rehearsal (docs/email/dispatch-staging-rehearsal.md §§3–11)
    passes on staging with team-owned recipients — then and only then flip
    it in production.
14. Smoke (internal recipients): booking quote ($549 Full Studio), admin
    scheduling board, staff page, crew login → `/crew`, clock in/out on a
    test assignment, Stage 4 closeout read, email admin overview.
15. Monitor: Railway logs (guardQueue warnings = Redis trouble), Resend
    deliverability page, Neon metrics, Bull Board failed-job counts.

### Rollback

- Code: redeploy the previous Railway builds (web + worker) — the schema is
  additive, old code ignores the new tables/columns/enum values.
- Migrations: do NOT drop; leave applied (documented limitation — Prisma
  enum additions and new tables are safe for old code).
- Triggers: if promotional behavior misfires after enabling, set
  `EMAIL_PROMOTIONS_ENABLED=false` (dispatch refuses, automation stages hold,
  enrollments are kept — fail-closed by design).
- Rollback triggers: failed migrate deploy, health check red after deploy,
  duplicate customer emails, capture failures on booking approval, worker
  crash-loop.
