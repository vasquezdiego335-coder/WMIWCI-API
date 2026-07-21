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
| `OUTBOX_ENABLED` | Route approval/confirmation via the outbox | When true, the legacy email is skipped (no double-send). |
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

_Last updated 2026‑07‑17 alongside the Phase 1–14 email overhaul._
