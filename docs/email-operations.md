# Email System — Operations Runbook (Phases 12–14)

Deploy, test, and monitor the transactional email system. Scope: the 16 React
Email templates in `src/emails/`, the send worker `src/workers/email.worker.ts`,
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

| Var | Purpose | Notes |
|---|---|---|
| `RESEND_API_KEY` | Resend transport | Falls back to `re_placeholder` (no real sends) if unset. |
| `EMAIL_FROM` | From header | Default `Move It Clear It <hello@moveitclearit.com>`. |
| `EMAIL_REPLY_TO` | Reply-To | Default `hello@moveitclearit.com`. |
| `APP_URL` | Portal + open-pixel base | Required for open tracking + portal links. |
| `EMAIL_ASSET_BASE_URL` | Hosted PNG/GIF base | Default `https://moveitclearit.com/email`. |
| `REFERRAL_SECRET` | Signs referral codes | Required only if `signReferralCode()` is used. |
| `OUTBOX_ENABLED` | Route approval/confirmation via the outbox | When true, the legacy email is skipped; a post-commit queue nudge drains immediately and a 15-minute sweep recovers missed nudges. |
| `ALLOW_TEST_PAYMENTS` | Enables the $1 controlled test | **Temporary toggle — leave OFF in prod except during a supervised test.** |
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
4. **Worker** (Railway): deploy `email.worker`. Confirm it connects to Redis and
   logs `📧 Email job received` on the first job.
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

### 4b · Resend-side (deliverability)
- Configure Resend webhooks → an ingest route for `email.delivered`,
  `email.bounced`, `email.complained`. **Hard bounces + complaints must
  suppress future sends** to that address (build a suppression check before
  `resend.emails.send`). *(Route not built yet — see blockers.)*
- Watch the Resend dashboard for bounce rate (>2% = investigate) and complaint
  rate (>0.1% = urgent; risks domain reputation).

### 4c · Domain auth (must be green before volume)
- **SPF, DKIM, DMARC** on the sending domain. Start DMARC at `p=none` with `rua`
  reporting, then tighten to `quarantine`/`reject`.
- One-click **List-Unsubscribe** on promotional mail is already wired; it stays
  dormant until `unsubscribeUrl` is a real https endpoint.

### 4d · Alerts to set up
- Notification `FAILED` rate over a rolling window.
- Worker crash / Redis disconnect (no `📧` logs = queue stalled).
- Resend bounce/complaint webhook thresholds.

---

## 5 · Open blockers (need owner / DNS / backend — not fakeable)

| Blocker | Unblocks |
|---|---|
| **Unsubscribe route** (signed, one-click) | promotional List-Unsubscribe header + footer link |
| **Business postal address** | CAN-SPAM footer on promotional mail |
| **Real Google review URL** | review-request CTA |
| **Cancellation-policy URL** | cancellation/partial-refund reference link |
| **Social profile URLs** | footer social chips |
| **SPF / DKIM / DMARC + Resend webhook ingest** | deliverability + bounce/complaint suppression |
| **Redemption route + DB field** | referral-code enforcement (signing helper already shipped) |
| **Senders for the 4 new templates** | information-required / operational-alert / final-invoice / referral-reward are in the allowlist but nothing enqueues them yet |

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
2. API `/api/health`: `status ok`, `redis.ok true`, `emailQueue.workersAttached ≥ 1`.
3. Worker `/healthz`: `status ok`, every `workers[].running true`, `problems []`.
4. No unexpected sends: Resend `GET /emails` newest item unchanged unless a real
   customer event happened; `email_jobs` has no `pending/processing` rows that
   are not explained; BullMQ `email` wait/failed = 0.
5. Rollback: redeploy the previous commit on **both** services (they must stay
   on the same commit). No migration is involved in this release.

---

_Last updated 2026‑09‑15 (production‑readiness fixes); originally 2026‑07‑17 alongside the Phase 1–14 email overhaul._
