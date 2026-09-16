# Email System — Operations Runbook (Phases 12–14)

Deploy, test, and monitor the transactional email system. Scope: the React Email
templates in `src/emails/` (19 templates behind 25 allowlisted template keys —
some files serve a numbered sequence), the send worker `src/workers/email.worker.ts`,
the validation gate `src/emails/validation.ts`, and the hosted assets on the
site. Owner spec 2026‑07‑17. **This runbook is the plan — it does not deploy.**

Related: [`controlled-test-plan.md`](controlled-test-plan.md) (the $1 booking
test), [`deployment.md`](deployment.md) (general infra).

---

## 0 · Architecture at a glance

```
sender (booking-approval.ts / fulfillment.ts / scheduled.worker.ts)
   → emailQueue.add(template, { to, bookingId, notificationId, payload })   [BullMQ/Redis]
      → email.worker processEmailJob:
           1. ALLOWED_TEMPLATES guard   (drop unknown → Notification FAILED, no retry)
           2. assertEmailPayload()      (link safety + required data + Phase-4 status gate)
           3. render() HTML + render(plainText) text
           4. inject open-pixel (if APP_URL + notificationId)
           5. resend.emails.send({ from, to, reply_to, subject, html, text, headers })
```

- **Transactional** templates (receipts/confirmations/reminders): no unsubscribe.
- **Promotional** templates (abandoned-checkout, review-request, referral,
  referral-reward): `MarketingFooter` + `List-Unsubscribe` header (dormant until
  a real unsubscribe URL is supplied).

---

## 1 · Environment variables

The complete, generated per-service list is
[`../docs/env-ownership.json`](env-ownership.json); the deploy tables are in
[`DEPLOY.md`](../DEPLOY.md) §3. The email-specific ones:

| Var | Purpose | Notes |
|---|---|---|
| `RESEND_API_KEY` | Resend transport | **Required on both services in production** — `checkEnv()` halts the worker without it. There is no `re_placeholder` fallback in production. |
| `RESEND_WEBHOOK_SECRET` | Verifies the Svix signature on `/api/email/webhook` | `whsec_…`. Missing ⇒ the route returns 503 and processes nothing. Required on both services. |
| `EMAIL_FROM` | From header | Default `Move It Clear It <hello@moveitclearit.com>`. `mustMatch`. |
| `EMAIL_REPLY_TO` | Reply-To | Default `hello@moveitclearit.com`. `mustMatch`. |
| `EMAIL_TOKEN_SECRET` | Signs unsubscribe / open tokens | The **worker signs**, the **API verifies** — if these differ, every unsubscribe link 400s. `mustMatch`. |
| `BUSINESS_POSTAL_ADDRESS` | CAN-SPAM footer | Required whenever this deployment sends email. |
| `MARKETING_SITE_URL` | Booking / redeem / referral links in emails | Required with email on; a stale value mails dead links. |
| `APP_URL` | Portal + open-pixel base | Required. A placeholder value fails `/api/health` readiness. |
| `EMAIL_SENDING_ENABLED` | Global kill switch | `'false'` holds everything. `mustMatch`. |
| `EMAIL_CAP_PER_DAY/WEEK/MONTH`, `EMAIL_QUIET_START_HOUR`, `EMAIL_QUIET_END_HOUR`, `EMAIL_TRANSACTIONAL_GAP_MINUTES` | Send-guard policy | `guardedSend` runs on **both** services, so these must match or customers see inconsistent timing. |
| `EMAIL_ASSET_BASE_URL` | Hosted PNG/GIF base | Default `https://moveitclearit.com/email`. |
| `REFERRAL_SECRET` | Signs referral codes | Required only if `signReferralCode()` is used. |
| `OUTBOX_ENABLED` | Route approval/confirmation via the outbox | When true, the legacy email is skipped; a post-commit queue nudge drains immediately and a 15-minute sweep recovers missed nudges. |
| `OUTBOX_EMAIL_DRYRUN` | Worker-only | **Never `true` in production** — it HOLDS rows and is not a delivery test. |
| `ALLOW_TEST_PAYMENTS` | Enables the $1 controlled test | **Temporary toggle — leave OFF in prod except during a supervised test.** |
| `EMAIL_CAMPAIGN_TRANSIENT_MAX_ATTEMPTS`, `EMAIL_AUTOMATION_TRANSIENT_MAX_ATTEMPTS` | Transient-failure budget (default 6) | See §6h. |
| `DATABASE_URL`, `JWT_SECRET` | App/DB | Needed by the build's page-data step. |

Verify with `scripts/verify-email-assets.ts` (all hosted asset URLs return 200)
before relying on images.

---

## 2 · Deploy runbook (Phase 12)

**Never deploy straight to production.** Promote a verified preview build.

1. **Pre-flight (local / CI)**
   - `npx tsc --noEmit` → clean.
   - `npx tsx --test src/emails/__tests__/*.test.ts` → all green (render-href,
     amounts, status, footer, cancellation, client-compat).
   - `npx tsx scripts/preview-all-emails.ts` → 17/17 render; skim
     `email-previews/*.html`.
   - `npx next build` → "Compiled successfully" + lint clean.
2. **DB migrations** (if any schema change): `prisma migrate deploy` **before**
   the app rolls, then `prisma generate`. The email work in this batch is
   code-only — no new migration.
3. **Assets** (only if icons/hero changed): regenerate with
   `scripts/gen-email-assets.ts`, deploy `WMIWCI-SITE/public/email/**`, then
   `scripts/verify-email-assets.ts` (expect 200s incl. the animated
   `truck-hero.gif`). Assets are versionless — deploy them **before** the worker.
4. **Worker host** (Railway project `patient-communication`, service
   `discord workers`, start command `npm run host:start`). There is no separate
   `email.worker` deployment — all five workers run in that one process. Confirm
   `GET /readyz` returns 200 with `problems []`, five attached `workers[]` and
   `schedules.missing []`, then `📧 Email job received` on the first job.
5. **Promote** the verified preview to production.
6. **Rollback**: revert to the previous deploy; templates are stateless, so a
   rollback is safe and instant. In-flight jobs already validated will still
   send with the rolled-back code.

**Feature flags to check before a prod send:** `OUTBOX_ENABLED` (avoid
double-send), `ALLOW_TEST_PAYMENTS=off`, `RESEND_API_KEY` is a real key.

---

## 3 · Production test plan (Phase 13)

### 3a · The $1 controlled booking test
Follow [`controlled-test-plan.md`](controlled-test-plan.md). Amounts are dynamic:
previews may show `$1`; **never hardcode `$1` or `$49`.** With
`ALLOW_TEST_PAYMENTS=on`, run one real booking → approve → verify the
`final-confirmation` and `payment-receipt` show the captured amount, then turn
the flag OFF.

### 3b · Per-template trigger matrix
| Template | Trigger | Required payload (gate) |
|---|---|---|
| pre-approval | booking request received (`fulfillment.ts`) | — |
| final-confirmation | owner approves (`booking-approval.ts`) | `bookingStatus=CONFIRMED`, `date`, `timeLabel`, `amountPaid`, `portalUrl` |
| payment-receipt | admin resend / capture | `displayId`, `date`, `amountPaid`, `portalUrl` |
| payment-failed | auth/capture/final-payment failure | `updatePaymentUrl` |
| information-required | pending request missing details | `portalUrl` |
| operational-alert | delay/reschedule/weather | (dynamic `message`) |
| booking-declined | owner denies | — |
| booking-cancellation | captured booking cancelled | (partial → itemization props) |
| booking-updated | date/time/address change | ≥1 change (`changedLabel`/`changes`) |
| job-reminder | 72h/24h before (`scheduled.worker`) | `scheduledStart`, `timeLabel`, `originAddress`, `portalUrl` |
| job-completion | move complete | — |
| final-invoice | post-job invoice | `portalUrl` |
| abandoned-checkout | started, no deposit | — (promotional) |
| review-request | after completion | `googleReviewUrl` |
| referral | post-move ask | — (promotional) |
| referral-reward | referral converted | `redeemUrl` (promotional) |

### 3c · Validation-gate behavior to confirm
- A missing/placeholder (`#`) link → **blocked**, Notification `FAILED`, no send.
- A confirmation with `bookingStatus` ≠ CONFIRMED → **blocked** (Phase 4).
- A `booking-updated` with no change → **blocked**.
- Blocked jobs do **not** retry (fail-safe: log + drop).

### 3d · Rendering / spam check
- Send test copies to Gmail, Outlook (web + desktop), Apple Mail, one mobile.
- Confirm: images load after "show images"; the plain-text part exists
  (View source → `Content-Type: text/plain`); no broken layout in Outlook;
  transactional mail shows **no** unsubscribe, promotional mail **does**.

---

## 4 · Monitoring (Phase 14)

### 4a · Send + open state (in-app)
- Every send writes a `Notification` row (`QUEUED → SENT | FAILED | SKIPPED`).
  A validation block sets `FAILED` with the reason — **watch this count**; a
  spike means a sender is enqueuing bad payloads.
- Opens: the worker injects a 1×1 pixel (`/api/email/open?token=…`) and stamps
  `openToken`. Opens are best-effort (image-blocking clients under-report).

### 4b · Resend webhook (LIVE)
- The ingest route exists: **`POST {APP_URL}/api/email/webhook`** on the API
  service (`app/api/email/webhook/route.ts` → `src/lib/email-events.ts`), Svix
  signature over the raw body, deduped by `svix-id`. Hard bounces, complaints
  and provider suppressions create suppression entries and stop enrollments;
  soft bounces deliberately do not.
- **Subscribe to all nine handled events** — the exact event→action table, the
  soft/hard rule and the 200/400/500/503 semantics are in
  [`DEPLOY.md`](../DEPLOY.md) §8. An endpoint configured from an older runbook
  is missing `email.failed` and `email.suppressed`.
- Watch the Resend dashboard for bounce rate (>2% = investigate) and complaint
  rate (>0.1% = urgent; risks domain reputation).

### 4c · Domain auth (must be green before volume)
- **SPF, DKIM, DMARC** on the sending domain. Start DMARC at `p=none` with `rua`
  reporting, then tighten to `quarantine`/`reject`.
- One-click **List-Unsubscribe** on promotional mail is already wired; it stays
  dormant until `unsubscribeUrl` is a real https endpoint.

### 4d · Alerts to set up
- Notification `FAILED` rate over a rolling window.
- Worker crash / Redis disconnect (no `📧` logs = queue stalled). The direct
  signal is the worker's `GET /readyz` (503 with `problems[]`) and the API's
  `GET /api/health` (`emailDelivery.ready false`).
- Resend bounce/complaint webhook thresholds.
- `lifecycle_enqueue_retries` backlog — the email agent check
  `lifecycle.enqueue_retry_backlog` warns at 2 h pending, critical at 6 h or on
  any non-cancellation abandonment in 24 h (§6h).

---

## 5 · Open blockers (need owner / DNS / backend — not fakeable)

| Blocker | Unblocks |
|---|---|
| **Real Google review URL** | review-request CTA |
| **Cancellation-policy URL** | cancellation/partial-refund reference link |
| **Social profile URLs** | footer social chips |
| **SPF / DKIM / DMARC** on the sending domain | deliverability at volume (the webhook ingest itself is **built and live** — §4b) |
| **Redemption route + DB field** | referral-code enforcement (signing helper already shipped) |

Closed since this table was written: the signed one-click **unsubscribe route**
(`app/api/email/unsubscribe`), the **Resend webhook ingest**
(`app/api/email/webhook`), and `BUSINESS_POSTAL_ADDRESS`, which is now a
required variable whenever the deployment sends email.

**Senders, corrected.** `final-invoice` is enqueued by the `balance-reminder-post`
stage on the scheduled queue, and `operational-alert` by the outbox premium-email
path (`src/outbox/services/premiumEmails.tsx`). `information-required` and
`referral-reward` still render only through the admin / test-send paths — verify
in the code before relying on either.

---

## 6 · Production readiness (2026‑09‑15)

Written after the "emails stopped on Aug 30" investigation. No pipeline failure
was found — no qualifying quote or booking event occurred after the last
confirmation — but the investigation exposed defects that would have hidden, or
caused, a real outage. What changed, and how to operate it:

### 6a · Detecting silence (email agent, every 15 min)
- `send.confirmation_stalled` — a quote confirmation still `queued` **> 30 min**
  → warning; **> 2 h** → critical. The worker is not draining the queue, the
  kill switch is holding it, or Redis lost the job. Once every stuck lead is
  older than 24 h it drops back to a warning, and an unchanged set of stuck
  leads stays one incident — it does not page Discord every hour for a week.
- `send.silence_with_demand` — quote requests in the last 72 h (older than a
  30‑min grace) but **no real provider‑accepted email** in that window: 1 lead →
  warning, 2+ → critical. **Zero demand and zero sends stays healthy** — a quiet
  week is not an outage.
- The 07:00 ET Discord digest carries **Last activity**: last quick‑quote lead,
  last partial lead, last real email, last booking — each with its age. "Did
  emails stop, or did customers stop?" is answered every morning.

### 6b · Provider outcomes and retries
- Resend SDK 3.x never throws; it returns `application_error` for timeouts,
  resets and unparseable bodies. Those, any 5xx, 408, and a "success" with no
  message id are now **`ambiguous`**: terminal, never auto‑resent (the provider
  may have accepted the message). Reconcile against the Resend dashboard.
- A definitive 4xx rejection stays retryable (60 s × attempts, max 5). A retry
  that arrives early gets `not_due` **with the due time**, and the email job is
  re‑queued at exactly that time (colon‑free job ids; repeated deferrals work).
  A rejection on the queue job's **last** attempt is re‑queued at the ledger's
  due time instead of failing with nothing left to re‑drive it.
- A send left in `sending` longer than `EMAIL_SENDING_STALE_MS` (10 min) — its
  worker died mid‑send — is closed as **`ambiguous`** by the next claim of the
  same key. It is **never taken over and re‑sent**: the claim is written just
  before the provider call, so Resend may already have accepted it.
- A refusal that cannot be written to `email_sends` logs
  `EMAIL_BLOCK_RECORD_FAILED`, is counted on the worker's `/healthz`
  (`emailBlockRecordFailures`), and the queue job retries.

### 6c · Outbox (`email_jobs`) statuses mean what they say
`sent` = provider accepted (or already had, for this key) · `skipped` = terminal
policy refusal, nothing sent · `failed` = attempts exhausted **or** ambiguous
(`last_error` says which; never auto‑resent) · `pending` = waiting, including
**holds** (`held:email_sending_disabled`, `held:held_outbox_dryrun`) that give
their attempt back. `OUTBOX_EMAIL_DRYRUN=true` HOLDS rows — it is never a
delivery test and never marks anything sent. Rows stuck in `processing` are
re‑pended by the drain's reaper, or closed `failed` if it was their last attempt;
a `pending` row with no attempts left is closed `failed` too. Every status
update matches the claim it came from (`attempts`), so a slow worker cannot
overwrite a newer claim of the same row. A live claim (`in_flight`) is looked at
again only after the stale window, never on a seconds‑long backoff.

### 6d · Bounces
A transient bounce (e.g. `550 4.4.7 Message expired`) is recorded as event type
`soft_bounced`: no suppression, no `bouncedAt`, no effect on bounce rates or the
`suppression.event_not_applied` check. Hard bounces and complaints still
suppress (scope `all`). The audit check drops a `bounced` row only when its
stored detail **positively** reads as soft — a truncated, unreadable detail stays
visible. Rows from before this release may still carry `bouncedAt` for a soft
bounce; the admin describes those as "the provider reported a bounce", never as
"suppressed". No backfill was run (owner decision).

### 6e · AI campaign drafter truth
Discovery runs **only on the worker** (10:05 ET). When it runs with
`EMAIL_MARKETING_AGENT_ENABLED` unset there, it records a `discovery_skipped`
ledger row. The Campaigns page shows **ENABLED — NOT RUNNING** whenever the
API has the flag on but no sweep ran in 36 h, and names the service that skipped.
The page shows **ACTIVE** when a sweep ran recently even if the flag is off on
the API. The email agent raises `marketing.discovery_stale` when the flag is on
in the process running the check but the worker skipped, and a process with the
flag off never auto‑resolves that incident (it cannot observe it).
The drafter only ever creates DRAFT campaigns; it never sends. To turn it on,
set the flag on **both** services (it is `mustMatch` in `docs/env-ownership.json`).

### 6f · No SMS
Move It Clear It no longer sends SMS (owner, 2026‑09‑15). Follow‑ups record the
SMS channel as `not_applicable`. Customer copy no longer promises a text
("we'll text you when we're en route", "confirmation by text and email").

### 6f2 · Follow‑up retries
The hourly lifecycle sweep re‑drives `failed_retryable` follow‑ups whose
`next_attempt_at` is due — only rows younger than **7 days**; older retryable
rows are closed `failed_terminal` (`stale:retry-window-expired`) so a review
request is never sent weeks after a move. A guard **deferral** (caps, quiet hours,
not due) uses the guard's own due time and does not consume one of the five
attempts; a row that does use all five ends `failed_terminal`.

### 6g · Post‑deploy verification (read‑only)
1. Both Railway services report the same `commit` on their health endpoint.
2. API `/api/health`: `status ok`, `redis.ok true`, `emailDelivery.ready true`
   (and `emailQueue.workersAttached ≥ 1`). `GET /api/health/live` is the pure
   liveness probe and is always 200 while the process serves.
3. Worker `/readyz` (= `/healthz`): `status ok`, `problems []`, all five
   `workers[]` `running` + `attached`, `schedules.missing []`. `GET /livez` is
   the pure liveness probe.
4. No unexpected sends: Resend `GET /emails` newest item unchanged unless a real
   customer event happened; `email_jobs` has no `pending/processing` rows that
   are not explained; BullMQ `email` wait/failed = 0.
5. `select status, count(*) from lifecycle_enqueue_retries group by 1;` — a
   healthy system keeps this table empty.
6. Rollback: redeploy the previous commit on **both** services (they must stay
   on the same commit). This release **does** carry three additive migrations —
   see [`DEPLOY.md`](../DEPLOY.md) §10 for the order, the read-only preflight and
   the rollback SQL. They are safe to leave applied under the rolled-back code.

### 6h · Durability added in this release
- **Lifecycle enqueues are durable.** A lifecycle scheduler whose `queue.add`
  fails or times out records the exact job (queue, name, data, deterministic job
  id, intended fire time, `not_after`) in `lifecycle_enqueue_retries`. The hourly
  `lifecycle-repair` re‑adds the **same job id**; a row past its `not_after` is
  **abandoned, not fired late** (`too_late: not re-enqueued (no historical
  replay)`). Statuses: `pending` → `enqueued`, or `abandoned`. Cancelling a
  journey closes matching rows first, so a sweep can never resurrect a cancelled
  stage. Logging is truthful: "scheduled" is said only when every attempted
  stage was actually scheduled.
- **A campaign recipient is never SUPPRESSED by a database blip.** Transient
  read failures (`suppression_read_failed`, any `*_read_failed`,
  `claim_lookup_failed`, `context_error:`) become **`DEFERRED` with
  `next_attempt_at`** and bounded backoff (5/10/20/40/80 min, cap 2 h), ending
  `FAILED '<reason>:retries_exhausted'` at `EMAIL_CAMPAIGN_TRANSIENT_MAX_ATTEMPTS`
  (default 6). `hard_bounce`, `spam_complaint`, `admin_block`, `invalid_address`
  and `provider_rejected` stay terminal. A run with deferred recipients can stay
  open ~2.6 h. **Existing** `SUPPRESSED / 'suppression_read_failed'` rows were
  **not** rewritten — re‑opening any of them is a separate owner decision.
- **One dispatch per campaign.** Run creation takes a per‑campaign
  `pg_advisory_xact_lock` and is backed by a partial unique index. Things an
  operator will notice: a cancel issued during `PREPARING` now really cancels;
  `retryFailedRecipients` returns 409 while another run is unfinished; a
  post‑queue failure no longer marks a live run FAILED (the sweep re‑drives its
  batches).
- **The schedules are verified, not assumed.** `/readyz` reports
  `schedules.registered` / `.missing` read back from Redis, and a background
  reconciler re‑registers a missing schedule within ten minutes — so a flushed
  Redis heals without a redeploy.

---

_Last updated 2026‑09‑15 (production‑readiness fixes); originally 2026‑07‑17 alongside the Phase 1–14 email overhaul._
