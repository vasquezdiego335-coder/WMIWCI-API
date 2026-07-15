# Controlled $1 Payment-Test Plan & Staging Verification

**Status: PREPARED — do NOT run the real $1 transaction, apply prod migrations, or deploy to production until the owner approves.** Everything below is set up and waiting.

All money-moving steps use the **owner-only, env-gated $1 test override**, never the real $49 and never public pricing.

---

## 0. Staging environment setup (owner action)

1. **Point a staging deploy at a staging database** (a copy/branch of prod, NOT prod). Never run these tests against production traffic.
2. **Apply the migrations to the staging DB only** (in order; run the preflight first):
   ```
   npm run db:preflight          # read-only: reports target host + pending migrations
   npx prisma migrate deploy     # applies all pending, additive, idempotent migrations
   ```
   Migration order (by timestamp):
   1. `20260714000100_expense_item_title_subcategory` (from the expense branch, if integrating)
   2. `20260715000100_lead_ingestion_fields`
   3. `20260715000200_payment_refund_dispute`
3. **Environment variables** (staging):
   | Var | Value | Purpose |
   |-----|-------|---------|
   | `ALLOW_TEST_PAYMENTS` | `true` | **Staging only.** Enables the $1 test endpoint. Leave unset/false in prod. |
   | `TEST_PAYMENT_AMOUNT_CENTS` | `100` (optional) | $1 default; clamped [50, 4900]. |
   | `STRIPE_SECRET_KEY` | `sk_test_…` | Stripe **test mode** key. |
   | `STRIPE_ALLOW_TEST` | `true` | Allows the test key under NODE_ENV=production (Railway forces production). |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` | From the staging webhook endpoint. |
   | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | from Upstash console | Distributed rate limiting. |
   | (existing) `DATABASE_URL`, `REDIS_URL`, `APP_URL`, `DISCORD_*` | staging values | as usual |
4. **Never paste secret values into chat or commit them.**

---

## 1. Stripe webhook events (req 12)

In the Stripe **test-mode** dashboard → Developers → Webhooks → the staging endpoint (`{APP_URL}/api/stripe/webhook`), confirm ALL of these are enabled:

**New (added in this PR):**
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`
- `payment_intent.canceled`

**Existing (must remain):**
- `checkout.session.completed`
- `payment_intent.payment_failed`
- `checkout.session.expired`

> The handlers are idempotent (WebhookLog dedupes by event id) and monotonic, so re-sending events is safe. Use `stripe trigger <event>` (Stripe CLI) or the dashboard "Resend" to exercise replay/out-of-order.

---

## 2. Upstash + rate-limit verification (req 13)

Confirm `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set in staging (presence only — never print values). Then verify each limiter returns HTTP 429 past its threshold:

| Route | Limit | How to test | Expect |
|-------|-------|-------------|--------|
| `POST /api/auth/login` | 10 / 15 min per IP | 11 rapid bad logins from one IP | 11th → **429** with `Retry-After` |
| `POST /api/bookings` | 5 / hr per IP | 6 rapid booking POSTs | 6th → **429** |
| `POST /api/contact` | 5 / 10 min per IP (fail-open) | 6 rapid contact POSTs | 6th → **429** (Upstash on) |
| `POST /api/notify/lead` | 60 / min per IP | loop >60 with the internal token | **429** past 60 |

Also confirm: different IPs get independent buckets; with Upstash **unset**, fail-open routes still succeed and fail-closed routes fall back to a local per-instance limit (degraded).

---

## 3. Lead-source persistence (req 14)

Confirm each source writes a `leads` row (query the staging DB or `/admin` once the Leads UI exists):

| Source | Action | Expect |
|--------|--------|--------|
| Contact form | `POST /api/contact` | one `leads` row, `source=WEBSITE`, message stored |
| Not-sure booking | `POST /api/bookings` with `serviceType='not-sure'` | booking **and** a `leads` row, `jobType='quote-request'` |
| Marketing tracker | `POST /api/notify/lead` (internal token) | one `leads` row |
| Discord outage | stop the Discord worker, submit contact form | `leads` row still created (persist-before-notify) |

**Coupon claim — NOT complete.** The site popup posts to the external **Leadtracking** Railway app (`/api/leads`), which owns coupon-code generation + email. Coupon leads reach the admin `Lead` table **only** if Leadtracking is connected to forward to `POST /api/notify/lead` (now persisting). That cross-system connection is an owner decision and has **not** been made or verified — do not mark coupon → Lead as done.

---

## 4. Controlled $1 payment-test checklist (req 10, 18)

**Trigger the test booking** (owner, logged into staging admin):
```
# From the browser DevTools console while logged into the staging admin, OR curl
# with the session + CSRF cookies (X-CSRF-Token must equal the moveit_csrf cookie):
POST {APP_URL}/api/admin/test-booking
   → returns { bookingId, bookingReference, checkoutUrl, amount:"$1.00" }
```
Then open `checkoutUrl` and pay the **$1** authorization with Stripe test card `4242 4242 4242 4242`.

Fill in **Actual / Pass-Fail / Evidence** as you run each test. `Actual` is PENDING until the owner runs it.

| # | Test | Setup | Steps | Expected | Actual | P/F | Evidence | Cleanup |
|---|------|-------|-------|----------|--------|-----|----------|---------|
| 1 | **Booking submission** | `ALLOW_TEST_PAYMENTS=true`, owner session | Call `/api/admin/test-booking` | 200; booking `isInternalTest=true`, `depositAmount=100`, status `PENDING_PAYMENT`; AuditLog `BOOKING_CREATED` `controlled_test_booking` | PENDING | | bookingId, WMIC-#### | Archive/delete the test booking after |
| 2 | **$1 authorization** | test booking from #1 | Pay checkout with 4242 card | Stripe PaymentIntent `requires_capture` (manual), amount 100; booking still uncaptured | PENDING | | pi_… id | — |
| 3 | **Approval via Discord** | a NEW #1/#2 test booking; approval card in Discord | Tap "Approve" | Exactly one capture; Payment row COMPLETED amount=100, `isInternalTest=true`; booking CONFIRMED; AuditLog `PAYMENT_RECEIVED` source=`discord` | PENDING | | pi_, ch_, payment.id | Refund in #9/#10 |
| 4 | **Approval via admin portal** | a separate NEW test booking | `POST /api/admin/bookings/{id}/status {status:'CONFIRMED'}` (owner) | Same as #3 but AuditLog source=`admin`; capture happens (the fixed bug) | PENDING | | payment.id, audit id | Refund after |
| 5 | **Exactly one capture** | booking from #3 or #4 | Inspect Stripe + DB | Stripe shows ONE captured charge; ONE Payment row | PENDING | | charge count, payment count | — |
| 6 | **Payment record correctness** | after a capture | Read Payment row | amount=100, status COMPLETED, stripePaymentIntentId + stripeChargeId set, receiptUrl present, metadata.capturedBy + approvalSource | PENDING | | payment JSON | — |
| 7 | **Duplicate approval protection** | CONFIRMED booking from #3 | Approve AGAIN (Discord and admin) | No second capture; result `already_confirmed`; still ONE Payment | PENDING | | Stripe charge count stays 1 | — |
| 8 | **Concurrent approval** (best effort) | fresh test booking | Fire Discord approve + admin confirm near-simultaneously | Exactly one capture; the loser gets `already_confirmed`/`raced` | PENDING | | logs, charge count=1 | — |
| 9 | **Declined booking + auth cancellation** | fresh #1/#2 test booking (uncaptured) | Discord "Deny" (or admin cancel PENDING_APPROVAL) | Booking CANCELLED; Stripe auth **canceled/released** (no charge); booking-declined email queued; AuditLog `decline_booking` `hold_released` | PENDING | | pi status=canceled | — |
| 10 | **Partial refund** ($1 supports it) | a CAPTURED $1 test booking | Refund **$0.50** in Stripe test dashboard | `charge.refunded` webhook → Payment `PARTIALLY_REFUNDED`, refundedAmountCents=50; AuditLog `PAYMENT_REFUNDED` | PENDING | | refund id, payment.status | — |
| 11 | **Full refund** | the same (or a fresh captured) booking | Refund the remainder / full $1 | Payment `REFUNDED`, refundedAmountCents=100 | PENDING | | refund id | — |
| 12 | **Replayed webhook** | any refund event from #10/#11 | Stripe dashboard "Resend" the same event | No double effect (WebhookLog dedupe); amounts unchanged | PENDING | | webhook_logs status=duplicate/processed | — |
| 13 | **Out-of-order webhook** | dispute events | `stripe trigger charge.dispute.closed` before `…created`, or resend older refund after newer | Monotonic: refunded total never drops; REFUNDED never downgrades; disputeStatus reflects latest | PENDING | | payment fields stable | — |
| 14 | **Dispute surfacing** | `stripe trigger charge.dispute.created` on a test charge | — | Payment.stripeDisputeId + disputeStatus set; Discord `failure-alert`; AuditLog `PAYMENT_DISPUTED` | PENDING | | discord msg, audit id | — |
| 15 | **Reconciliation** | after the above | `npm run reconcile` (or `GET /api/admin/reconciliation`, owner) | Reports 0 CRITICAL issues for the properly-recorded tests; flags any intentionally-broken case | PENDING | | JSON report | — |

**Cleanup (after all tests):** every test booking/payment is `isInternalTest=true` and already excluded from revenue. Optionally archive the test bookings (status → ARCHIVED) or delete ONLY these test rows by their recorded ids. **Never delete unrelated records.** Disable the override: unset `ALLOW_TEST_PAYMENTS` in staging.

---

## 5. Post-test: disable the override

- Unset `ALLOW_TEST_PAYMENTS` (endpoint returns 403 again).
- Confirm `ALLOW_TEST_PAYMENTS` is **never** set in production.
- Optionally delete `app/api/admin/test-booking/route.ts` + `src/lib/test-payments.ts` if the override is no longer wanted.
