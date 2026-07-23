# Email dispatch runtime — campaigns + automations

_Added 2026-07-22 on branch `claude/email-marketing-dispatch-complete`._

This document describes the EXECUTION layer that closes the gap the previous
staging runbook named: "campaign dispatch and automation execution have no
worker." They now do. Nothing in this layer creates a second send pathway —
every message still leaves through `guardedSend()` and lands on the canonical
`EmailSend` ledger.

---

## 1. The master switch

```
EMAIL_PROMOTIONS_ENABLED=true
```

**Default: OFF, fail closed.** Campaign dispatch refuses and automation stages
hold (enrollments are kept, not lost) until this is deliberately set after the
staging rehearsal passes. The admin shows a banner on the Campaigns and
Automations tabs while it is off. Test sends are unaffected — they carry their
own gate (`EMAIL_TEST_RECIPIENT`).

Related, pre-existing gates that still apply to every promotional send:
`BUSINESS_POSTAL_ADDRESS`, `APP_URL` + `EMAIL_TOKEN_SECRET` (unsubscribe URL),
suppression, quiet hours, frequency caps.

New tuning knobs (all optional): `EMAIL_CAMPAIGN_BATCH_SIZE` (default 25),
`EMAIL_CAMPAIGN_STALE_MS` (default 15 min — stale SENDING claim recovery).

## 2. Campaign execution

Modules: `src/lib/email-campaign-run.ts` (pure state machines),
`src/lib/email-campaign-dispatch.ts` (the executor),
`src/lib/email-recipient-context.ts` (live payload builders).

```
SCHEDULED/ACTIVE campaign
  └─ dispatchCampaign(campaignId, actor)      ← admin "Start sending" or the
       1. reload + canDispatch()                campaign-sweep cron when
       2. approval freshness (edit after        scheduledAt arrives
          approval ⇒ refuse)
       3. fresh validateCampaign()
       4. EMAIL_PROMOTIONS_ENABLED
       5. template ↔ segment compatibility (context registry)
       6. resolveAudienceDetailed()           ← CURRENT db state, never a preview;
          eligible + excluded-with-reasons      MAX_AUDIENCE bound
       7. EmailCampaignRun (snapshot frozen)  ← edits after this touch NOTHING
       8. EmailCampaignRecipient rows           UNIQUE(runId,email)
       9. bounded campaign-batch jobs           deterministic job ids
```

Each batch claims recipients atomically (`PENDING → SENDING` via guarded
`updateMany`), builds the recipient's REAL context (fails closed with
`context_*` reasons), renders through `src/lib/email-render.ts`, and calls
`guardedSend` with `eventId = campaign-run:<runId>` — so the EmailSend
idempotency key makes every send exactly-once per run + recipient across
batch retries, worker restarts and repeated dispatch calls.

**Run states:** PREPARING → QUEUED → SENDING → COMPLETED /
COMPLETED_WITH_ERRORS, plus PAUSED, CANCELLING → CANCELLED, FAILED.
**Recipient states:** PENDING, SENDING, SENT, DEFERRED, SUPPRESSED,
UNSUBSCRIBED, INELIGIBLE, CONTEXT_INVALID, SKIPPED, FAILED, CANCELLED — every
non-SENT terminal state carries a machine-readable `reason`.

Delivery/opens/clicks/bounces stay on `EmailSend`/`EmailEvent` (the recipient
row links via `emailSendId`); the run tables are orchestration, not a second
analytics system.

**Controls** (admin Campaigns tab, `email.manage_campaign`, all audited):
Start sending, Pause (holds unprocessed recipients within one send), Resume
(re-enqueues pending batches), Cancel remaining, Retry failed. The
`campaign-sweep` cron (every 5 min) dispatches due SCHEDULED campaigns,
re-opens stale SENDING claims, re-enqueues lost batches and finalizes settled
runs — restart recovery is automatic.

## 3. Campaign-safe templates (the context registry)

Only templates with a LIVE context builder can be broadcast, and only to
segments whose members can honestly receive them:

| Template | Requires | Allowed segments |
|---|---|---|
| quote-followup-1/2/final | lead with real `quotedAt` | quoted_leads_no_booking |
| abandoned-checkout(-2/-3) | booking still PENDING_PAYMENT | abandoned_booking |
| review-request | completed booking, no review, GOOGLE_REVIEW_URL | review_eligible |
| referral | completed booking + positive review | referral_eligible |
| repeat-reminder (re-engagement / win-back) | completed booking | completed_customers, repeat_customers, first_time_customers, reengagement_eligible |

Transactional templates have no entry and are refused at validation AND at
dispatch. Builders never substitute synthetic values — a missing entity,
URL or qualifying fact is a named refusal (`context_missing:*`,
`context_ineligible:*`), asserted by `email-recipient-context.test.ts`.

**Truthful urgency:** no template in the broadcastable set makes a scarcity
claim. There is no quote-expiration model in the schema, so no email may claim
one; a discount is only referenced through the campaign's real `discountCode`.

## 4. Automation execution

Module: `src/lib/email-automation-runtime.ts`.

Triggers fire at their real business-event sites:

| Trigger | Fired from |
|---|---|
| lead_created | `leads.ingestLeadSafe` (new leads only) |
| quote_created | `journeys.onQuoteCreated` (admin Leads tab → Mark quoted) |
| booking_started | `journeys.onCheckoutStarted` |
| booking_confirmed | `journeys.onBookingConfirmed` |
| payment_captured | `journeys.onBookingPaid` |
| move_completed | admin status route → `journeys.onBookingCompletedBalance` |
| booking_abandoned, move_date_approaching (7-day window), customer_inactive, review_eligible, referral_eligible | the `automation-sweep` cron, grounded in real db state |
| move_finalized | **not yet wired** — needs the closeout finalize site |

Enrollment: one row per automation VERSION + subject (`dedupeKey` unique — a
re-fired trigger is a no-op; a new version is a new identity). The audience
narrowing is checked per subject and fails closed. Stage jobs use
`automationJobId(automationId, version, stageKey, enrollmentId)` — the id
scheme that previously had no caller.

Each stage, immediately before sending, re-evaluates LIVE state:
stop rules (conversion, payment→abandonment-only, cancellation, review,
referral, move-date passage, and the LOCKED suppression stops), the
per-automation monthly cap, the automation's own status (PAUSED holds without
losing stages; ARCHIVED stops with a reason), and the master switch. Sends go
through `guardedSend` with `eventId = <automation>:v<version>:<stage>:<enrollment>`
— a queue duplicate or worker retry resumes the same logical send.

Event-driven stops mirror the rules the moment the event happens
(`stopEnrollmentsFor`): deposit paid stops ONLY `booking_started`/
`booking_abandoned` enrollments; cancellation, lead conversion and suppression
stop everything for the subject. The execution-time re-evaluation remains the
authoritative protection (same philosophy as journey cancellation).

## 5. Payment reminders

* **Deposit requested / unpaid** — the existing abandoned-checkout journey
  (checkout started → 45 min / 24 h / 72 h, stops the moment the deposit is
  paid) is the deposit-reminder sequence; nothing was duplicated.
* **Payment failed** — the existing Stripe-event → `payment-failed` template.
* **Remaining balance after completion** — NEW: `balance-reminder-post` at
  completion + 24 h (`journeys.onBookingCompletedBalance`, flag
  `EMAIL_JOURNEYS_ENABLED` + `EMAIL_JOURNEY_BALANCE_DISABLED` opt-out). The
  worker recomputes `job-money.customerBalance()` at send time: zero balance,
  cancellation, non-COMPLETED status or an internal-test booking skip with a
  named reason. Amounts are dynamic (`grandTotal` / `amountPaid` /
  `balanceDue` from real cents) on the existing `final-invoice` template —
  nothing is hardcoded and no forfeiture/release claim is made, because no
  business logic enforces one.
* **Pre-move balance** — deliberately NOT a separate email: policy is that the
  balance is collected on move day, and the 72 h/24 h `job-reminder` already
  owns the pre-move slot. Adding a third pre-move email was judged noise;
  revisit only with owner sign-off.

## 6. Worker topology (unchanged)

The new cases live in the EXISTING scheduled worker
(`src/workers/scheduled.worker.ts`), started by the processes that already
run in production: `npm run host:start` (Railway worker service,
`src/worker-host.ts`) or `npm run workers:start`. The two sweep crons are
registered idempotently on startup (stable job ids `cron:campaign-sweep`,
`cron:automation-sweep`). No new process, no import-time side effects.

## 7. Idempotency summary

| Layer | Mechanism |
|---|---|
| Dispatch call | one unfinished run per campaign (refuse-and-return) |
| Recipient rows | UNIQUE(runId, email) + createMany skipDuplicates |
| Batch jobs | deterministic BullMQ job ids |
| Individual send | EmailSend idempotencyKey ← campaign-run:<runId> |
| Enrollment | UNIQUE dedupeKey (automation + version + subject) |
| Stage job | automationJobId (version-scoped) |
| Stage send | EmailSend idempotencyKey ← version+stage+enrollment |
| Quote trigger | markLeadQuoted newlyQuoted-once + journey job ids |
| Balance reminder | businessEventKey booking:<id>:balance-reminder-post |
| Provider ambiguity | guard marks `ambiguous`, NEVER auto-resends |
