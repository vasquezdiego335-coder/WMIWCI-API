# WMIWCI-API — Architecture Map

> Backend for **We Move It. We Clear It.** (NJ labor-only moving / junk removal).
> **Stack:** Next.js 14 (App Router) + TypeScript + Prisma (Postgres/Neon) + BullMQ (Upstash Redis) + Stripe + Discord + Resend + Twilio.
> **This is NOT a Python/FastAPI app.** All server logic is TypeScript. API endpoints are Next.js route handlers at `app/api/**/route.ts` — the file path *is* the URL; they cannot be moved into other folders.

This file is a guide for humans and LLMs. Each top-level folder below can be analyzed independently; the "Reads / Writes" notes say what each part touches.

---

## 1. Deployment topology (important — explains the whole design)

| Process | Runs on | Command | Notes |
|---|---|---|---|
| Next.js app (routes + admin UI) | **Vercel** (serverless) | `npm run dev` (:3000) | Handles HTTP only. **Cannot** run BullMQ workers (no persistent process). |
| BullMQ workers | **Persistent host** (Railway/Render/VPS/local) | `npm run workers:dev` | Consume jobs from Upstash and actually send email/SMS/Discord. |
| Discord gateway bot | **Persistent host** | `npm run bot:dev` | Receives slash commands / interactions over the gateway. |

The webhook/route side only **queues** jobs to **Upstash Redis**; a worker must be running somewhere to process them. If no worker runs, a payment succeeds but nothing notifies.

---

## 2. The core flow: request → payment → approval

```
1. Browser → POST /api/bookings
   → create Booking (status PENDING_PAYMENT) + Stripe Checkout Session ($49 manual-capture HOLD)
   → returns { checkoutUrl }.   NO customer message sent here.

2. Customer pays on Stripe.
   ├─ Stripe → POST /api/stripe/webhook  (checkout.session.completed, signature-verified)
   └─ Browser redirect → GET /api/stripe/checkout/success   (guaranteed; backup if webhook fails)
   Both call fulfillPaidCheckout() — IDEMPOTENT via an atomic status claim, so it runs exactly once.
   It: flips Booking → PENDING_APPROVAL, then queues:
     • FINAL CONFIRMATION email + SMS   (customer-facing, 1 of 4)
     • Discord approval card             (internal — the Approve/Deny/Offer buttons)
     • job card + marketing stub         (internal / no-op)

3. Worker process drains Upstash:
     • email.worker  → Resend  (only allowed templates)
     • sms.worker    → Twilio
     • discord.worker→ Discord REST (posts the approval card)

4. Admin clicks ✅ Approve in Discord → POST /api/discord/interactions (Ed25519-verified)
   → capture the $49 hold → Booking CONFIRMED → queues PRE-APPROVAL email + SMS (customer-facing, 1 of 4).
```

**Messaging policy:** the system sends **exactly four** customer messages — Pre-Approval (email+SMS) on admin approve, Final Confirmation (email+SMS) on payment. Hard-enforced by `ALLOWED_TEMPLATES` in `src/workers/email.worker.ts`. See `MESSAGING` notes per file below.

---

## 3. Folder tree (with core / non-critical markers)

```
WMIWCI-API/
├── app/                          # Next.js App Router (routes + admin UI)
│   ├── api/                      # ⬅ all HTTP endpoints (route.ts = the URL)
│   │   ├── bookings/route.ts             [CORE] POST: create booking + Stripe checkout
│   │   ├── stripe/
│   │   │   ├── webhook/route.ts           [CORE] Stripe events → fulfillPaidCheckout
│   │   │   └── checkout/
│   │   │       ├── success/route.ts       [CORE] browser redirect → fulfill (webhook backup)
│   │   │       └── cancel/route.ts        [non-critical]
│   │   ├── discord/interactions/route.ts  [CORE] approve/deny/offer buttons (Ed25519)
│   │   ├── contact/route.ts               [non-critical] contact form → Discord alert
│   │   ├── customer/booking/[token]/…     [non-critical] self-service portal API
│   │   ├── admin/…                        [non-critical] admin CRUD (auth-gated)
│   │   ├── auth/{login,logout,me}/route.ts[non-critical] admin session
│   │   ├── files/upload/route.ts          [non-critical] Cloudinary signed upload
│   │   └── health/route.ts                [non-critical] env presence check
│   ├── (admin)/admin/…           [non-critical] admin dashboard UI (React)
│   ├── my-booking/[token]/…      [non-critical] customer portal UI
│   ├── privacy, terms, page, layout
│
├── src/lib/                      # framework-agnostic core helpers
│   ├── stripe.ts                 [CORE] Stripe client, checkout, capture/cancel, webhook verify
│   ├── fulfillment.ts            [CORE] fulfillPaidCheckout() — single source of truth post-payment
│   ├── queues/index.ts           [CORE] BullMQ queue singletons + lazy proxies + job types
│   ├── redis.ts                  [CORE] ioredis singleton + BullMQ connection options
│   ├── db.ts                     [CORE] Prisma client singleton
│   ├── logger.ts                 [CORE] pino loggers (api/webhook/queue/bot)
│   ├── i18n.ts                   [CORE] bilingual EN/ES SMS strings + email subjects
│   ├── auth.ts                   [CORE] JWT session + CSRF (used by middleware)
│   ├── resend.ts                 [CORE] Resend email client + from/reply-to
│   ├── scheduling.ts             [non-critical] availability slots, Eastern formatting
│   ├── reschedule.ts             [non-critical] "Offer New Dates" shared logic
│   ├── agreement.ts              [non-critical] Moving Service Agreement version/text
│   ├── cloudinary.ts             [non-critical] file storage
│   ├── marketing.ts              [non-critical] CRM enroll — STUB (no-op until configured)
│   └── env.ts                    [non-critical] env validation report for /api/health
│
├── src/workers/                  # BullMQ workers — run OFF Vercel
│   ├── index.ts                  [CORE] entry: loads dotenv, starts all 5 workers
│   ├── email.worker.ts           [CORE] Resend sender + 2-template ALLOWLIST
│   ├── sms.worker.ts             [CORE] Twilio sender + config validation + logging
│   ├── discord.worker.ts         [CORE] posts cards via discord-rest (REST, no gateway)
│   ├── scheduled.worker.ts       [non-critical] cron digests + reminders (registers repeat jobs)
│   ├── marketing.worker.ts       [non-critical] calls the marketing stub
│   └── bull-board.ts             [non-critical] optional queue inspector UI (manual: npx tsx)
│
├── src/bot/                      # Discord GATEWAY bot — run OFF Vercel
│   ├── index.ts                  [CORE-for-bot] boots the gateway client
│   ├── discord-actions.ts        [CORE-for-bot] gateway Client (login, slash cmds, interactions)
│   ├── discord-rest.ts           [CORE] REST card sender used BY THE WORKER (no gateway/login)
│   ├── command-handler.ts        [non-critical] slash command logic
│   ├── register-commands.ts      [non-critical] one-off command registration
│   └── commands/setup-business.ts[non-critical]
│
├── src/emails/                   # React-email templates (rendered in email.worker)
│   ├── pre-approval.tsx           [CORE] 1 of 2 allowed emails
│   ├── final-confirmation.tsx     [CORE] 1 of 2 allowed emails
│   └── *.tsx (others)             [non-critical] defined but NOT triggered (allowlist-blocked)
│
├── prisma/                       # schema.prisma, migrations/, seed.ts
├── middleware.ts                 [CORE] auth + CSRF + rate-limit; matcher = /admin, /api/admin only
├── .env / .env.example           env (see §5)
└── next.config.mjs, tsconfig.json, tailwind, package.json
```

> **Don't move `app/**`, `middleware.ts`, or `prisma/`** — their locations are dictated by Next.js / Prisma. Only `src/lib`, `src/workers`, `src/bot`, `src/emails` are freely reorganizable.

---

## 4. Critical gotchas (read before changing these areas)

- **Stripe webhook needs the raw body.** `app/api/stripe/webhook/route.ts` uses `req.text()` (not `req.json()`) so the signature verifies. `runtime = 'nodejs'` is required.
- **`STRIPE_WEBHOOK_SECRET` must match the delivery method.** For local `stripe listen`, use the `whsec_` it prints — NOT a Dashboard secret.
- **`NODE_ENV=production` + `sk_test_` key throws** ("Production must use a live Stripe secret key", `src/lib/stripe.ts`). Local dev must use `NODE_ENV=development`.
- **Workers post Discord via `discord-rest.ts` (REST), never `discord-actions.ts` (gateway).** Importing the gateway module into the worker boots a second login and crashes.
- **Queue proxies in `queues/index.ts` forward get AND set.** A get-only proxy made BullMQ's cron path read back an undefined value → `Cannot read properties of undefined (reading 'on')`. Keep the `set` trap.
- **All `queue.add()` on a request path is timeout-guarded** (BullMQ `maxRetriesPerRequest: null` means a dead Redis hangs `.add()` forever).
- **`fulfillPaidCheckout()` is idempotent** via an atomic `updateMany` status claim — webhook and success-redirect can both call it; only one wins.

---

## 5. Environment variables

**Stripe:** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_BOOKING_FEE_CENTS`
**App/URLs:** `NODE_ENV`, `APP_URL` (must reach this backend), `MARKETING_SITE_URL`, `CORS_ALLOWED_ORIGINS`
**Data/queue:** `DATABASE_URL` (Neon), `REDIS_URL` (Upstash `rediss://…`)
**Email (Resend):** `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`
**SMS (Twilio):** `TWILIO_ENABLED`, `TWILIO_ACCOUNT_SID` (`AC…`), `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (E.164 `+1…`)
**Discord:** `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_*`
**Auth:** `JWT_SECRET`, `CSRF_SECRET`, `OWNER_*`, `MANAGER_*`
**Optional/test:** `ALLOW_TEST_ENDPOINTS` (gate for `/api/test/sms` in prod), `MARKETING_*`, `CLOUDINARY_*`

---

## 6. Run commands

```
npm run dev           # Next.js app (:3000)
npm run workers:dev   # all 5 BullMQ workers (must run for any notification to send)
npm run bot:dev       # Discord gateway bot (slash commands / interactions)
npm run typecheck     # tsc --noEmit
npx tsx src/workers/bull-board.ts   # optional queue inspector (:3001)
```

---

## 7. Known dead/optional code (not yet removed)

- **`webhook-retry` queue** (`queues/index.ts`, `bull-board.ts`): defined but never produced or consumed.
- **Untriggered email templates** (`src/emails/*` except pre-approval / final-confirmation): defined and mapped, but the messaging allowlist blocks them. Kept in case they're re-enabled.
