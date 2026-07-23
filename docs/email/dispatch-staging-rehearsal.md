# Dispatch runtime — staging rehearsal

_Prepared 2026-07-22 for branch `claude/email-marketing-dispatch-complete`._

**STATUS: BLOCKED — NOT COMPLETE.** This environment has no staging database,
Redis, Resend key or webhook endpoint, so the rehearsal below has NOT been
run. Every step is exact and copy-pasteable; run them in order against the
staging stack and check the expected outcome before enabling
`EMAIL_PROMOTIONS_ENABLED` anywhere. **No step below touches a real
customer** — the three test contacts are team-owned addresses.

## 0. Environment

Staging services (same topology as `docs/email/email-staging-runbook.md` §1):
API (`npm run start`) + worker host (`npm run host:start`). Required vars:

```
DATABASE_URL=<staging Neon branch — NEVER production>
REDIS_URL=<staging redis>
RESEND_API_KEY=<staging/test-mode key>
EMAIL_FROM / EMAIL_REPLY_TO=<staging-verified domain>
APP_URL=<staging app url>
EMAIL_TOKEN_SECRET=<staging secret>
BUSINESS_POSTAL_ADDRESS=<the real registered address>
GOOGLE_REVIEW_URL=<any safe https url for staging>
EMAIL_TEST_RECIPIENT=<team inbox>
EMAIL_JOURNEYS_ENABLED=true
EMAIL_PROMOTIONS_ENABLED=true          # staging ONLY until this passes
```

## 1. Migrate + verify

```bash
npx prisma migrate deploy
npm run db:preflight
npm run email:preflight
```

Expected: `20260722000100_email_dispatch_runtime` applies; preflights green;
`email_campaign_runs`, `email_campaign_recipients`,
`email_automation_enrollments` exist.

## 2. Start the worker and confirm the crons

```bash
npm run host:start
```

Expected in the log: all workers start, and
`Cron jobs registered (daily digests + campaign/automation sweeps)`.
In Bull Board (`/admin/queues`): repeatables `cron:campaign-sweep` (*/5) and
`cron:automation-sweep` (*/15).

## 3. Fixture contacts (3) — eligible / unsubscribed / suppressed

Create three COMPLETED bookings via the seed or the booking form + admin
completion, with customers at team-owned addresses, e.g.
`staging+ok@…`, `staging+unsub@…`, `staging+bounce@…`. Then:

* Unsubscribe `staging+unsub@…` via its unsubscribe link
  (`/api/email/unsubscribe?token=…` from any prior staging email).
* Suppress `staging+bounce@…` hard: POST the Resend `email.bounced` webhook
  fixture to `/api/email/webhook` (see §9), or use the admin suppression page.

## 4. Campaign draft → validate → approve

Admin → Email marketing → Audiences: create `staging-completed` on segment
`completed_customers`. Campaigns: create a draft (template `repeat-reminder`,
audience `staging-completed`, sourceKey `staging-rehearsal-1`). Click
**Validate** — expected: passing, audience preview showing 3 candidates with
1 unsubscribed excluded + 1 suppressed excluded, eligible = 1. Click
**Approve**. Transition to **SCHEDULED**.

## 5. Test send

Test-send tab → `repeat-reminder` → the configured test recipient. Expected:
`[TEST]` email arrives; `email_sends` row has `is_test = true`.

## 6. Dispatch and verify per-recipient truth

Campaigns tab → **Start sending** (or wait ≤5 min for the sweep if
scheduledAt was set). Expected:

* a run card appears: 1 recipient, then `SENT 1`;
* recipient rows: `staging+ok` → SENT with an `email_send_id`;
  `staging+unsub` → UNSUBSCRIBED (`reason: unsubscribed`);
  `staging+bounce` → SUPPRESSED;
* the eligible inbox receives ONE email with unsubscribe link + postal
  address; the other two receive NOTHING;
* audit log: `EMAIL_CAMPAIGN_DISPATCHED`;
* run finalizes COMPLETED; campaign → COMPLETED.

## 7. Pause / resume / cancel (needs volume)

Add ~10 more completed staging bookings (distinct addresses) OR set
`EMAIL_CAMPAIGN_BATCH_SIZE=1` on the worker to slow a 3-recipient run. Clone
the campaign (new sourceKey), approve, dispatch, then immediately **Pause**.
Expected: run PAUSED, remaining recipients stay PENDING, no further inbox
deliveries while paused (watch ≥2 min). **Resume** → the rest send.
Run a third campaign, pause, then **Cancel remaining** → recipients
CANCELLED with `reason: run_cancelled`, run CANCELLED, none of them ever
receive the email. Audit: RUN_PAUSED / RUN_RESUMED / RUN_CANCELLED.

## 8. Automation enrollment, delay, stop

Automations tab: create "Staging quote chase" — trigger `quote_created`,
stage 1 `quote-followup-1` at the 5-minute minimum delay, stage 2
`quote-followup-2` at 10 minutes. Validate → TEST → test send → ACTIVE.
Leads tab: submit a staging lead via the public contact form, then **Mark
quoted**. Expected:

* `email_automation_enrollments` row: ACTIVE, version 1, currentStage 0,
  `next_run_at` ≈ +5 min; Execution panel shows 1 enrolled;
* after ~5 min: stage 1 delivered (or DEFERRED to the quiet-hours window —
  run the rehearsal inside 8:00–21:00 ET), currentStage 1;
* NOW cause the stop: create a booking with the lead's email (checkout is
  enough — `markLeadConverted` fires on booking creation). Expected: the
  enrollment goes STOPPED `lead_closed` (event) or `lead_converted`
  (execution-time), and stage 2 NEVER sends;
* repeat "Mark quoted" on the same lead: no new enrollment (dedupe), no
  restart of the journey clock.

## 9. Webhook → suppression → enrollment stop

```bash
curl -X POST "$APP_URL/api/email/webhook" -H 'Content-Type: application/json' \
  -H "svix-id: msg_stg1" -H "svix-timestamp: $(date +%s)" -H "svix-signature: <sign or disable verification in staging>" \
  -d '{"type":"email.bounced","data":{"email_id":"<providerId from §6>","to":["staging+ok@…"],"bounce":{"type":"hard"}}}'
```

Expected: `email_events` row, suppression created, any ACTIVE enrollment for
the address STOPPED `suppressed:hard_bounce`, deliverability page counts it.

## 10. Restart + duplicate-send proof

`Ctrl-C` the worker mid-run (between two batches of a paused-then-resumed
campaign), restart it. Expected: within 5 min the sweep re-opens the stale
claim / re-enqueues the batch; the inbox receives **no duplicate** — the
resumed recipient's `email_sends` row shows attempts > 1 with ONE
`provider_id`.

## 11. Sign-off checklist

- [ ] every §6 recipient state + reason correct
- [ ] pause holds, resume completes, cancel never sends (§7)
- [ ] enrollment → delayed stage → stop condition → stage skipped (§8)
- [ ] webhook → suppression → enrollment stop (§9)
- [ ] worker restart produces zero duplicates (§10)
- [ ] admin progress, customer timeline, audit events, health page all
      reflect the above
- [ ] ONLY THEN set `EMAIL_PROMOTIONS_ENABLED=true` in production
