# Phase 2 + Phase 3 — Architecture, Hosting, Deployment & SMS Providers

> Architecture designed by **DeepSeek** (the `deepseek-chat` architect pass), implemented and
> reconciled by Claude. The one material correction DeepSeek made to the original spec: the
> **referral ask is NOT sent at payment** (texting a referral request the instant a $49 hold is
> authorized — before the move has happened — is TCPA-risky and poor UX). All marketing
> follow-ups are gated on **job completion** under the existing-business-relationship basis.

---

## 1. What was built

### Phase 2 — Attribution merge (booking revenue → marketing funnel)
- **WMIWCI-API**: `Booking.source` + `Booking.foundUs` columns (migration
  `20260629000000_phase2_phase3_attribution_followups`); `foundUs` added to the booking Zod
  schema; "Where did you find us?" dropdown on the booking form; `fulfillPaidCheckout` POSTs each
  **paid** booking to the tracker (`src/lib/tracker.ts`, fire-and-forget, 5 s timeout).
- **marketing-tracker**: `leads.found_us` + `jobs.external_ref` (UNIQUE, idempotency);
  `POST /api/ingest/booking` (Bearer-authed, idempotent upsert that links revenue back to the
  originating lead by email/phone, else creates one); `found_us` breakdown in `/api/stats`, the
  dashboard, the CSV export, and the bi-weekly report; dropdown on the landing form.

### Phase 3 — Post-move follow-up automation (`src/lib/followups.ts`)
| Touch | Trigger | Delay (quiet-hours-shifted) | Ledger type |
|---|---|---|---|
| Review request | job completed | +2 h | `review-request` |
| Review reminder (only if no review) | job completed | +48 h | `review-reminder` |
| Referral ask (fallback) | job completed | +5 d | `referral-ask` |
| Referral ask (preferred) | **positive** review (≥4★) | +24 h | `referral-ask` *(same type → deduped)* |
| Repeat-business reminder | job completed | +30 d | `repeat-reminder` |

Maps to the 5 requested touches: review (b), repeat (c), 48 h reminder (d), and **one** referral
that prefers the positive-review moment (e) with a day-5 fallback that replaces the
"after-payment" ask (a). The unique `(bookingId, type)` ledger guarantees each fires **at most
once**; `referral-ask` is shared so the customer gets a single referral ask, ever.

**Anti-spam / TCPA controls** (all in `followups.ts`):
- Exactly-once: `FollowUpLedger` row claimed *before* sending (`@@unique([bookingId,type])`).
- Opt-out: `Customer.marketingOptOut`, set by the `POST /api/sms/inbound` STOP/START webhook;
  every marketing SMS carries "Reply STOP to opt out."
- Quiet hours: send only 08:00–20:59 **America/New_York**; jobs are shifted into the window at
  schedule time and re-deferred at send time (DST-safe via `Intl`).
- Frequency cap (safety net): ≤1 follow-up / 24 h and ≤4 / 30 d per customer.
- Kill switch: `MARKETING_FOLLOWUPS_ENABLED` (default **OFF**).

Reviews are captured first-party (no Google webhook exists) via
`POST /api/admin/bookings/[id]/review`; the completion hook `onBookingCompleted()` fires from
`POST /api/admin/bookings/[id]/status` when a booking transitions to `COMPLETED`.

---

## 2. Hosting layout (what runs where)

```
┌─────────────────────────┐     ┌──────────────────────────┐     ┌──────────────────────────┐
│  Vercel — Next.js API    │     │  Railway — worker host    │     │  Railway — marketing-     │
│  (serverless functions)  │     │  (always-on process)      │     │  tracker (Flask)          │
│  • /api/bookings         │     │  tsx src/workers/index.ts │     │  gunicorn app:app         │
│  • /api/stripe/*         │     │  • email / sms / discord  │     │  • /go, /quote, /api/*    │
│  • /api/admin/*          │     │    workers                │     │  • /api/ingest/booking    │
│  • /api/notify/lead      │     │  • SCHEDULED worker =      │     │  • /dashboard, /stats     │
│  • /api/sms/inbound      │     │    cron + delayed jobs     │     │                          │
│  • fulfillPaidCheckout   │     │    (Phase-3 follow-ups)    │     │                          │
└───────────┬─────────────┘     └────────────┬──────────────┘     └────────────┬─────────────┘
            │                                 │                                 │
            │  enqueue (BullMQ add)           │  consume                        │
            └───────────────┬─────────────────┘                                 │
                            ▼                                                    ▼
                  ┌───────────────────┐                              ┌────────────────────┐
                  │ Upstash Redis      │                              │ Tracker Postgres    │
                  │ (BullMQ backbone)  │                              │ (Railway)           │
                  └───────────────────┘                              └────────────────────┘
            ▲
            │
   ┌────────┴────────┐
   │ App Postgres     │  (Prisma; Railway/Neon/Supabase)
   └─────────────────┘
```

- **Vercel (serverless)** runs the Next.js API + admin UI. It only ever **enqueues** BullMQ jobs
  and makes outbound HTTP calls — it never runs a long-lived consumer (serverless can't).
- **Railway worker host** (`workers:start` / `host:start`) is the always-on process that runs the
  BullMQ workers, including the **scheduled worker** that registers the cron jobs and processes
  the Phase-3 delayed follow-up jobs. **This is the only place Phase-3 messages are sent.**
- **Upstash Redis** is the BullMQ backbone (delayed + repeatable jobs live here).
- **marketing-tracker (Flask on Railway)** owns the scans→leads→jobs funnel + its own Postgres.
- Do **not** put the watcher/worker on Vercel; do **not** move the tracker onto Vercel.

---

## 3. Cross-service communication & auth

Two server-to-server hops, each a **shared bearer/secret token**, each fire-and-forget with a
timeout so an outage on one side never blocks a customer action:

| Direction | Endpoint | Header | Token (same value both sides) |
|---|---|---|---|
| tracker → API (Phase 1) | `POST /api/notify/lead` | `X-Internal-Token` | `INTERNAL_NOTIFY_TOKEN` ⇄ `WMIWCI_API_NOTIFY_TOKEN` |
| API → tracker (Phase 2) | `POST /api/ingest/booking` | `Authorization: Bearer` | `TRACKER_INGEST_TOKEN` (both) |

Idempotency: the ingest is keyed on `external_ref = "booking:<id>"` (UNIQUE in `jobs`), so the
Stripe webhook + success-redirect double-fire records revenue exactly once.

**Generated tokens** (set these now; rotate anytime):
```
INTERNAL_NOTIFY_TOKEN = sXfPokOyAUzypowL89kPHXuCcSEyO0fO8Mb1M6TLG6c
TRACKER_INGEST_TOKEN  = HcEQl2YBnRC9Hw39iYCThJHhyEVbnRo3oZd5O4BYBH4
```

---

## 4. Queue & cron architecture

All Phase-3 follow-ups are **event-driven BullMQ delayed jobs on the existing `scheduled`
queue** — no new cron patterns are required.

- On `COMPLETED`, `onBookingCompleted(bookingId)` enqueues 4 delayed jobs (review-request +2 h,
  review-reminder +48 h, referral-ask +5 d, repeat-reminder +30 d). Each delay is shifted into
  08:00–21:00 ET; each job uses a **stable jobId** `followup:<type>:<bookingId>` so a duplicate
  completion can't create duplicate jobs.
- A positive review enqueues `referral-ask` at +24 h (same ledger type → at most one referral).
- The scheduled worker handler (`src/workers/scheduled.worker.ts`) dispatches these to
  `runFollowup()`, which performs every guard (enabled flag, opt-out, quiet-hours re-defer,
  frequency cap, exactly-once ledger claim) before sending.

Existing cron (unchanged), registered idempotently on worker start:
| Job | Pattern | TZ |
|---|---|---|
| `daily-schedule-morning` | `0 7 * * *` | America/New_York |
| `daily-schedule-evening` | `0 19 * * *` | America/New_York |

---

## 5. Full environment-variable map

### WMIWCI-API (set on **both** Vercel and the Railway worker host)
| Var | Phase | Purpose |
|---|---|---|
| `OWNER_PHONE` | 1 | E.164 number for owner SMS alerts |
| `OWNER_EMAIL` | 1 | inbox for owner email alerts |
| `INTERNAL_NOTIFY_TOKEN` | 1 | auth for `/api/notify/lead` (matches tracker) |
| `CUSTOMER_AUTOREPLY_ENABLED` | 1 | `true` to send the lead auto-reply (default on) |
| `TRACKER_URL` | 2 | tracker base URL, e.g. `https://tracker…railway.app` |
| `TRACKER_INGEST_TOKEN` | 2 | auth for `/api/ingest/booking` (matches tracker) |
| `MARKETING_FOLLOWUPS_ENABLED` | 3 | **`true` to arm Phase-3** (default OFF) |
| `GOOGLE_REVIEW_URL` | 3 | review link used in review SMS/email |
| `REFERRAL_URL` | 3 | optional; defaults to `MARKETING_SITE_URL` |
| `MARKETING_SITE_URL` | 2/3 | booking site (existing; used in copy) |
| `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_PHONE_NUMBER` | reuse | SMS |
| `TWILIO_ENABLED` | reuse | `true` to actually send SMS (else dry-run) |
| `RESEND_API_KEY` / `EMAIL_FROM` / `EMAIL_REPLY_TO` | reuse | email |
| `DATABASE_URL` / `SHADOW_DATABASE_URL` | reuse | Prisma (shadow for migrations) |
| Redis (`UPSTASH_REDIS_URL`/`REDIS_URL` per `src/lib/redis.ts`) | reuse | BullMQ |
| `APP_URL`, `STRIPE_*`, `DISCORD_*` | reuse | existing |

### marketing-tracker (Railway)
| Var | Phase | Purpose |
|---|---|---|
| `WMIWCI_API_BASE_URL` | 1 | API base URL for the lead-notify bridge |
| `WMIWCI_API_NOTIFY_TOKEN` | 1 | = `INTERNAL_NOTIFY_TOKEN` |
| `TRACKER_INGEST_TOKEN` | 2 | = the API's `TRACKER_INGEST_TOKEN` |
| `DATABASE_URL` | reuse | Postgres (SQLite locally when unset) |
| `DISCORD_WEBHOOK_URL` / `DISCORD_*` | reuse | alerts |

---

## 6. Safe deploy order

All schema changes are **additive & backward-compatible** (nullable columns, a bool defaulting
false, two new tables), and Phase 3 is **flag-gated OFF**, so the DB can be migrated well ahead
of enabling anything.

**Phase 2**
1. **Tracker** — deploy; `db.init_db()` auto-adds `leads.found_us` + `jobs.external_ref` (Postgres
   `ADD COLUMN IF NOT EXISTS`; SQLite via PRAGMA probe). Set `TRACKER_INGEST_TOKEN`.
2. **API** — `npx prisma migrate deploy` (applies the new migration), then deploy. Set
   `TRACKER_URL` + `TRACKER_INGEST_TOKEN`.
3. Verify: submit a test booking, pay, confirm a `jobs` row with `external_ref="booking:<id>"`.

**Phase 3** (after Phase 2 is healthy)
1. Migration is already applied in Phase 2 step 2 (it includes `FollowUpLedger` + `Review` +
   `Customer.marketing_opt_out` + `Booking.completed_at`).
2. Deploy the **worker host** (it now handles the new scheduled types). Set `GOOGLE_REVIEW_URL`.
3. Point the Twilio number's inbound webhook at `POST /api/sms/inbound` (STOP handling).
4. Flip `MARKETING_FOLLOWUPS_ENABLED=true`. Complete one real/test booking, watch
   `followup_ledger` for `sent` rows.

**Rollback**: `MARKETING_FOLLOWUPS_ENABLED=false` (instant, no redeploy) disables all Phase-3
sends; clearing `TRACKER_INGEST_TOKEN` disables the revenue ingest. New columns/tables are inert
when unused.

---

## 7. SMS provider comparison (for high-volume customer follow-ups)

All five are reputable A2P providers. For **US** application-to-person texting, **10DLC brand +
campaign registration** is mandatory regardless of vendor and is the dominant factor in
deliverability — pick a vendor with a smooth 10DLC flow and register properly.

> Per-segment prices below are **representative US list prices** and move often; confirm on each
> vendor's pricing page and add carrier/10DLC fees. Volume discounts apply.

| Provider | Outbound US SMS (≈/seg) | Reliability | Deliverability | Setup ease | API simplicity |
|---|---|---|---|---|---|
| **Twilio** | ~$0.0079 + fees | Excellent, largest scale | Excellent (mature 10DLC) | Easy, best docs | Excellent — **already integrated** |
| **Telnyx** | ~$0.004 + fees | Excellent (owns network) | Excellent | Moderate | Very good |
| **Plivo** | ~$0.005 + fees | Very good | Very good | Easy | Very good |
| **Vonage** (Nexmo) | ~$0.0072 + fees | Very good, global | Good | Moderate | Good |
| **MessageBird/Bird** | quote-based, higher | Very good | Good | Heavier (omnichannel) | Good but broad |

**Recommendation:** **Stay on Twilio now.** It's already wired (`twilio` SDK, `smsQueue` →
`sms.worker.ts`, `TWILIO_ENABLED`), the most reliable, and has the smoothest 10DLC path — for a
local mover's follow-up volume the per-message delta is a few dollars/month, not worth a
migration. **If SMS spend becomes material** (thousands/month), **Telnyx** is the strongest
move: ~40–50% cheaper at comparable deliverability because it runs its own carrier network, and
its API is close enough that swapping the SMS worker is a contained change. Plivo is the
budget runner-up. Skip MessageBird/Bird unless you want omnichannel (WhatsApp/voice/email) in one
platform — it's more than an SMS follow-up flow needs.

A provider swap is **localized to `src/workers/sms.worker.ts`** — everything upstream enqueues
free-form `{ to, message }` jobs, so only the worker's send call changes.

---

## 8. Operations runbook

- **Arm/disable Phase 3**: `MARKETING_FOLLOWUPS_ENABLED=true|false` on the worker host.
- **Record a review** (fires the referral when ≥4★):
  `POST /api/admin/bookings/<id>/review` `{ "rating": 5, "comment": "..." }` (OWNER/MANAGER auth).
- **Opt a customer out manually**: set `customers.marketing_opt_out = true` (or they text STOP).
- **Audit what was sent**: `SELECT * FROM followup_ledger WHERE booking_id = '<id>'` — one row per
  type with `status` (`sent` / `skipped` / `failed`) and the skip reason.
- **Dry-run everything**: leave `TWILIO_ENABLED` unset (SMS no-op) and `MARKETING_FOLLOWUPS_ENABLED`
  off; the pipeline runs end-to-end without sending.
