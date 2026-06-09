# Booking → Stripe → Discord → Notifications — End-to-End Test Plan

> **Stack reality:** this backend is **Next.js 14 (TypeScript, App Router) + Prisma/Postgres + BullMQ/Redis + discord.js + Stripe + Resend + Twilio** — *not* FastAPI/SQLite. All routes live under `backend/app/api/**`. Workers (BullMQ) run as a separate persistent process (`src/workers/index.ts`), since Vercel functions are serverless.

---

## 0. Architecture at a glance

```
booking-form.html ──POST /api/bookings──▶ creates Booking(DRAFT) + Stripe Checkout ($49 HOLD)
                                          │
        Stripe Checkout (deposit) ◀───────┘  capture_method: manual  → authorize only
                  │
                  ▼ checkout.session.completed
        POST /api/stripe/webhook (sig-verified, idempotent)
                  │  Booking → PENDING_APPROVAL, stripePaymentIntentId saved
                  ├─ emailQueue  → "pending-approval"
                  ├─ smsQueue    → "$49 authorized (hold)…"
                  └─ discordQueue → booking approval card (✅ Approve / 📅 Offer New Dates / ❌ Deny)
                  │
   ┌──────────────┼───────────────────────────────────────────────┐
   ▼              ▼                                                 ▼
✅ APPROVE     📅 OFFER NEW DATES                                ❌ DENY
capture $49    keep hold, email+SMS 3 dates + token link        void/refund $49
CONFIRMED      booking stays PENDING_APPROVAL                    CANCELLED
email+SMS      customer opens /booking-form.html?reschedule=…    apology email+SMS
24h reminder   picks date → PATCH /api/customer/booking/[token]  + rebook link
               → fresh approval card re-posts to Discord
```

Separately: `contact.html`/marketing → **POST /api/contact** → Discord team alert + bilingual email/SMS auto-ack.

---

## 1. Environment (Stripe TEST mode)

In `backend/.env.local`:

```bash
NODE_ENV=development
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://…            # local or Supabase/Neon
REDIS_URL=redis://localhost:6379       # or Upstash URL
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…          # from `stripe listen` (below)
DISCORD_BOT_TOKEN=…  DISCORD_PUBLIC_KEY=…  DISCORD_APPLICATION_ID=…
DISCORD_CHANNEL_SCHEDULING=…  DISCORD_CHANNEL_OPERATIONS=…  DISCORD_CHANNEL_ALERTS=…
RESEND_API_KEY=re_…                    # email (omit to no-op email jobs)
TWILIO_ENABLED=false                   # true + SID/TOKEN/NUMBER to send real SMS
```

`sk_test_…` keys are **blocked in production** by `src/lib/stripe.ts`. The worker should call `assertEnv()` (from `src/lib/env.ts`) at boot so a missing required var fails loudly.

**Run it locally (3 terminals):**
```bash
# 1. App
cd backend && npm run dev
# 2. Workers (email/SMS/Discord/scheduled)
cd backend && npx tsx src/workers/index.ts
# 3. Stripe webhook forwarding → gives you whsec_…
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

---

## 2. Health check (start here)

```bash
curl -s localhost:3000/api/health | jq
```
**Expect `200`** with `{"status":"ok","db":"connected","env":{"ok":true,…}}`.
If `503`/`"degraded"`: `env.missingRequired` lists exactly which vars are absent (presence only — never values). Fix those first.

---

## 3. Happy path — booking → deposit → approve

### 3a. Create booking
```bash
curl -s -X POST localhost:3000/api/bookings \
  -H 'Content-Type: application/json' \
  -d '{
    "fullName":"Test Mover","phone":"8625551234","email":"test@example.com",
    "serviceType":"2br","date":"2026-07-01","time":"08:00",
    "addressFrom":"1 Main St, West Orange NJ","addressTo":"2 Oak Ave, Montclair NJ",
    "truckOption":"own-truck","agreementAccepted":true,"agreementName":"Test Mover"
  }' | jq
```
**Expect `200`** + `{ "checkoutUrl":"https://checkout.stripe.com/…", "url":…, "stripeUrl":… }`.
Open `checkoutUrl`, pay with test card **`4242 4242 4242 4242`**, any future expiry / any CVC / any ZIP.

**Failure cases to try:**
| Payload change | Expect |
|---|---|
| `agreementAccepted:false` | `422` "You must accept the Moving Service Agreement" |
| missing `email` / bad email | `422` validation, `details` lists field |
| invalid JSON body | `400` "Invalid JSON" |
| Redis down | still `200` + `checkoutUrl` (queues are non-fatal) |

### 3b. Webhook fires (watch the `stripe listen` + worker logs)
- `Booking` → `PENDING_APPROVAL`, `stripePaymentIntentId` set, `depositPaid:false` (hold, not captured).
- Email job `pending-approval`, SMS "authorized (a hold, not a charge)", Discord approval card posted to `DISCORD_CHANNEL_SCHEDULING`.
- **Idempotency:** replay the same event (`stripe events resend <id>`) → webhook logs "Duplicate — skipping", no double card.

### 3c. Approve in Discord
Click **✅ Approve**. Expect:
- PaymentIntent **captured** (`$49` now charged); `Payment` row `COMPLETED`; `Booking`→`CONFIRMED`, `depositPaid:true`.
- Customer gets `booking-confirmed` email + SMS; 24h reminder scheduled.
- Card edits in place to green "✅ APPROVED".
- Permission: a Discord user **not** mapped to an OWNER/MANAGER `User.discordId` → ephemeral "permission denied", no state change.

---

## 4. Decline (terminal) — releases the hold

Click **❌ Deny**. Expect:
- Hold **voided** (`cancelDeposit`) if not yet captured → customer never charged; if it had been captured, it's **refunded**.
- `Booking`→`CANCELLED`; apology email (`booking-denied`) + SMS with rebook link + manual-fallback line.
- Card edits to red "❌ DENIED — $49 hold released (not charged)".

---

## 5. **NEW** — Reschedule on decline (keeps the deposit)

Click **📅 Offer New Dates**. Expect:
- $49 hold **kept** (not released). Booking stays `PENDING_APPROVAL`.
- `findAvailableSlots()` computes 3 open weekday dates after the requested date.
- `reschedule-offer` email (bilingual template, lists the 3 dates, ember CTA) + SMS with `…?reschedule=<customerToken>` link.
- Card edits to blue "📅 RESCHEDULE OFFERED" but **keeps the buttons** (staff can still Approve/Deny if the customer calls).

**Customer picks a new date:**
```bash
# token = booking.customerToken (from the link / DB)
curl -s -X PATCH localhost:3000/api/customer/booking/<TOKEN> \
  -H 'Content-Type: application/json' \
  -d '{"requestedDate":"2026-07-15T08:00:00.000Z"}' | jq
```
**Expect `200`** "New date submitted … your $49 hold stays attached." Then:
- `Booking.requestedDate` updated, status `PENDING_APPROVAL`.
- A **fresh Discord approval card** re-posts (job type `reschedule-offer` → `postBookingApprovalCard`), Details prefixed "🔁 RESCHEDULED by customer".
- Approving that card captures the (still-valid) hold as normal.

**Edge / failure cases:**
| Case | Expect |
|---|---|
| `<TOKEN>` expired/invalid | `401` "Invalid token" |
| new date < 72h away | `422` "Reschedule requires at least 72 hours notice" |
| **Hold expired** (>7 days) | PATCH still succeeds; on Approve, capture fails gracefully → card shows "⚠️ capture failed — re-collect" (log: "hold may have expired") |

> ⚠️ **Stripe authorization holds expire (~7 days).** The `customerToken` also lives 7 days, so they're aligned — but a slow customer means re-collecting the $49. This is handled, not silent.

**Frontend prefill:** open `booking-form.html?reschedule=<TOKEN>` → name/phone/email/addresses prefill from the backend, an orange banner explains the hold is intact, and localStorage remembers edits. (Console shows `[BookingMemory]` debug lines.)

---

## 6. **NEW** — Contact form

```bash
curl -s -X POST localhost:3000/api/contact \
  -H 'Content-Type: application/json' \
  -d '{"name":"Jane Q","email":"jane@example.com","phone":"8625559999",
       "subject":"Quote question","message":"Do you cover Livingston?","locale":"es"}' | jq
```
**Expect `200`** `{ "ok":true, "message":"Mensaje recibido…" }` (Spanish because `locale:"es"`). Then:
- Discord **✉️ New Contact Message** card → `DISCORD_CHANNEL_OPERATIONS` (falls back to alerts/scheduling), shows 🇪🇸 flag.
- Bilingual `contact-ack` email to the customer; bilingual SMS if phone + Twilio enabled.

| Case | Expect |
|---|---|
| `message:""` | `422` validation |
| `company:"anything"` (honeypot) | `200 {ok:true}` but **silently dropped** (bot) |
| no `locale` | English ack |

---

## 7. Spanish (EN/ES) toggle tests

- **Frontend:** load any page, click **ES**. Every `data-en`/`data-es` node swaps instantly; reload keeps choice (localStorage). Booking + contact forms post `locale` accordingly.
- **Backend copy:** `src/lib/i18n.ts` `t(locale, key, vars)` drives SMS; `emailSubject(template, locale)` drives subjects. New email templates (`contact-ack`, `reschedule-offer`) render Spanish when `payload.locale` starts with `es`.
- ⚠️ **To make the *whole* booking pipeline bilingual** (confirmation/denied/reminder emails+SMS), the customer's language must be **persisted**. That needs a one-line schema add — see §9.

---

## 8. Failure-mode checklist

| Inject | Expected behavior |
|---|---|
| Redis offline | `/api/bookings` still returns `checkoutUrl` (queue adds wrapped in try/catch); jobs resume when Redis returns |
| Resend key absent | email jobs no-op/log; pipeline continues |
| `TWILIO_ENABLED=false` | SMS worker logs "SMS disabled — skipping" |
| Discord channel env unset | `postBookingApprovalCard` logs "channel not configured — skipping" (no crash) |
| Bad Stripe signature | webhook `400` "Invalid signature", nothing processed |
| Duplicate webhook | second delivery short-circuits via `WebhookLog` idempotency |
| Discord button by non-staff | ephemeral permission-denied, no state change |

---

## 9. Remaining one-step for FULL bilingual notifications

Add a persisted locale to the customer (everything else is already wired to consume it):

```prisma
model Customer {
  // …existing fields…
  locale String @default("en") @map("locale")
}
```
```bash
cd backend && npx prisma migrate dev --name add_customer_locale   # local
#            npx prisma migrate deploy                              # prod
```
Then: set `locale` on `customer.upsert` in `/api/bookings` from the posted `locale`, and pass `locale: booking.customer.locale` into the `booking-confirmed` / `booking-denied` / `reschedule-offer` email + SMS jobs (replace the `locale:'en'` TODO in `app/api/discord/interactions/route.ts`). No other code changes needed — `i18n.ts` and the templates already branch on it.

---

## 10. Production deploy notes

- **App** on Vercel (Next.js preset; build `prisma generate && next build`). `/api/health`, `/api/bookings`, `/api/contact`, `/api/stripe/webhook`, `/api/discord/interactions` are all serverless routes — no `main.py`.
- **Workers** must run on a persistent host (Railway/Render/VPS): `node dist/workers/index.js`. They are *not* deployed to Vercel.
- Stripe webhook endpoint (prod): `https://<app-domain>/api/stripe/webhook`.
- Discord **Interactions Endpoint URL**: `https://<app-domain>/api/discord/interactions`.
- Verify `/api/health` returns `200` post-deploy before pointing the marketing site at it.
