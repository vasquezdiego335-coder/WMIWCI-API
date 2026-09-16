# WMIWCI-API — Architecture Map

> Backend for **We Move It. We Clear It.** (NJ labor-only moving / junk removal).
> **Stack:** Next.js 15.5 (App Router) + TypeScript + Prisma 5.22 (Postgres/Neon via the PgBouncer pooler) + BullMQ 5.x (Redis on Railway) + Stripe + Discord + Resend. (No SMS: removed 2026-09-15.)
> **This is NOT a Python/FastAPI app.** All server logic is TypeScript. API endpoints are Next.js route handlers at `app/api/**/route.ts` — the file path *is* the URL; they cannot be moved into other folders.

This file is a guide for humans and LLMs. Each top-level folder below can be analyzed independently; the "Reads / Writes" notes say what each part touches.

---

## 1. Deployment topology (important — explains the whole design)

Production is **two Railway services** built from `main`, which must always run
the same commit. Full runbook: [`DEPLOY.md`](DEPLOY.md).

| Process | Runs on | Production command | Local command | Notes |
|---|---|---|---|---|
| Next.js app (routes + admin UI) | Railway `earnest-solace` / **`wonderful-strength`** | `npm run start` (`next start`) | `npm run dev` (:3000) | Handles HTTP only; **produces** jobs, never consumes a queue. |
| Combined worker host — 5 BullMQ workers + the recurring schedules + the outbox + the Discord **gateway** bot, in ONE process | Railway `patient-communication` / **`discord workers`** | `npm run host:start` (`tsx src/worker-host.ts`) | `npm run host:dev` | The only process that sends email. Serves `/livez` and `/readyz`. |

`npm run workers:dev`, `outbox:dev` and `bot:dev` are **development-only**
entrypoints. Running any of them alongside `host:start` double-consumes the
queues and logs the Discord gateway in twice.

The route side only **queues** jobs to **Redis (Railway)**; the worker host must
be running to process them. If it is not, a payment succeeds but nothing
notifies — which is why `/api/health` is now 503 when the `email`, `scheduled`
or `webhook-retry` queue has no attached consumer.

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
   It: flips Booking → PENDING_APPROVAL, then fans out (src/lib/fulfillment.ts):
     • PRE-APPROVAL email                (customer-facing: "we have your request")
     • Discord approval card             (internal — the Approve/Deny/Offer buttons)
     • job card + marketing enroll       (internal / stub)
   The fan-out reports each piece truthfully: a failed enqueue is recorded in
   lifecycle_enqueue_retries and retried hourly, never logged as "queued".

3. The worker host drains Redis:
     • email.worker  → Resend  (only allowed templates)
     • discord.worker→ Discord REST (posts the approval card)

4. Admin clicks ✅ Approve in Discord → POST /api/discord/interactions (Ed25519-verified)
   → capture the $49 hold → Booking CONFIRMED → queues the FINAL CONFIRMATION
     email (src/lib/booking-approval.ts).
```

> The order above is the one the code implements: **payment → `pre-approval`**,
> **approval → `final-confirmation`**. Earlier revisions of this file had the two
> swapped.

**Messaging policy:** customer messages are EMAIL ONLY (SMS was removed on 2026-09-15). Hard-enforced by `ALLOWED_TEMPLATES` in `src/workers/email.worker.ts`. See `MESSAGING` notes per file below.

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
│   │   ├── email/webhook/route.ts         [CORE] Resend events (Svix-signed) → suppression
│   │   ├── email/{unsubscribe,open,suppression,agent-heartbeat}/route.ts
│   │   ├── sms/inbound/route.ts           [non-critical] STOP/START opt-out record ONLY (no sending)
│   │   ├── health/route.ts                [CORE] readiness: DB + Redis PING + env + queue consumers
│   │   └── health/live/route.ts           [non-critical] pure liveness, always 200
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
│   ├── i18n.ts                   [CORE] bilingual EN/ES email subjects
│   ├── auth.ts                   [CORE] JWT session + CSRF (used by middleware)
│   ├── resend.ts                 [CORE] Resend email client + from/reply-to
│   ├── scheduling.ts             [non-critical] availability slots, Eastern formatting
│   ├── reschedule.ts             [non-critical] "Offer New Dates" shared logic
│   ├── agreement.ts              [non-critical] Moving Service Agreement version/text
│   ├── cloudinary.ts             [non-critical] file storage
│   ├── marketing.ts              [non-critical] CRM enroll — STUB (no-op until configured)
│   ├── env.ts                    [CORE] checkEnv() — the worker HALTS on a missing required var
│   ├── cron-schedules.ts         [CORE] the 12 recurring schedules + self-healing reconciler
│   ├── worker-health.ts          [CORE] pure health verdicts (worker readiness, email delivery)
│   ├── lifecycle-enqueue.ts      [CORE] durable enqueue — a failed queue.add is recorded, not lost
│   └── lifecycle-retry-sweep.ts  [CORE] hourly drain of lifecycle_enqueue_retries (no history replay)
│
├── src/worker-host.ts            [CORE] thin Railway entrypoint (dotenv, signals, process handlers)
├── src/worker-runtime/           # the host itself
│   ├── host.ts                   [CORE] startup order, /livez + /readyz, graceful shutdown
│   └── load-modules.ts           [CORE] dynamic imports — nothing builds a client before HTTP binds
│
├── src/workers/                  # BullMQ workers — all five run INSIDE the worker host
│   ├── index.ts                  [DEV-ONLY] workers:dev / workers:start — never in production
│   ├── email.worker.ts           [CORE] Resend sender + 25-template ALLOWLIST
│   ├── discord.worker.ts         [CORE] posts cards via discord-rest (REST, no gateway)
│   ├── scheduled.worker.ts       [CORE] cron job handlers, digests, every recovery sweep
│   ├── marketing.worker.ts       [non-critical] campaign batches + automation stages
│   ├── webhook.worker.ts         [CORE] consumes `webhook-retry` — paid-deposit fulfilment
│   └── bull-board.ts             [non-critical] optional queue inspector UI (manual: npx tsx)
│
├── src/bot/                      # Discord GATEWAY bot — runs inside the worker host
│   ├── index.ts                  [CORE-for-bot] boots the gateway client
│   ├── discord-actions.ts        [CORE-for-bot] gateway Client (login, slash cmds, interactions)
│   ├── discord-rest.ts           [CORE] REST card sender used BY THE WORKER (no gateway/login)
│   ├── command-handler.ts        [non-critical] slash command logic
│   ├── register-commands.ts      [non-critical] one-off command registration
│   └── commands/setup-business.ts[non-critical]
│
├── src/emails/                   # React-email templates (rendered in email.worker)
│   ├── pre-approval.tsx           [CORE] queued on payment
│   ├── final-confirmation.tsx     [CORE] queued on owner approval
│   └── *.tsx (others)             25 templates are in ALLOWED_TEMPLATES; a few render
│                                  only through the admin/test paths. Anything NOT in
│                                  the allowlist is dropped with a log, never sent.
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
- **`src/lib/redis.ts` builds NO connection at import.** Use `getLazyBullConnection()` inside a start function. An eager connection made the worker host fail before its health server could say why.
- **The worker host's `/healthz` is READINESS** (= `/readyz`): 503 until config is valid, Redis and Postgres answer, all five workers are attached and all twelve schedules are registered. `/livez` is liveness. Same split on the API: `/api/health` vs `/api/health/live`.
- **Never send a lifecycle job with a bare `queue.add`.** Use `enqueueDurable()` (`src/lib/lifecycle-enqueue.ts`) so a Redis stall records the job in `lifecycle_enqueue_retries` instead of silently deleting a customer's sequence — and never log "scheduled" for a stage that was not.

---

## 5. Environment variables

**[`docs/env-ownership.json`](docs/env-ownership.json) is the authoritative,
generated manifest** — which service reads each of the 188 variables, which are
required at startup (`requiredBy`), which must hold the same value on both
services (`mustMatch`). It is verified by
`src/lib/__tests__/env-ownership.test.ts` and regenerated with
`npx tsx scripts/gen-env-ownership.ts`. Per-service deploy tables are in
[`DEPLOY.md`](DEPLOY.md) §3. Orientation only:

**Stripe:** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_BOOKING_FEE_CENTS`
**App/URLs:** `NODE_ENV`, `APP_URL` (must reach this backend), `MARKETING_SITE_URL`, `CORS_ALLOWED_ORIGINS`
**Data/queue:** `DATABASE_URL` (Neon, pooler host), `REDIS_URL` (Railway Redis)
**Email (Resend):** `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_TOKEN_SECRET`, `BUSINESS_POSTAL_ADDRESS`
**Send policy (both services, `mustMatch`):** `EMAIL_SENDING_ENABLED`, `EMAIL_CAP_PER_DAY/WEEK/MONTH`, `EMAIL_QUIET_START_HOUR`/`EMAIL_QUIET_END_HOUR`, `EMAIL_TRANSACTIONAL_GAP_MINUTES`
**Flags:** `OUTBOX_ENABLED`, `EMAIL_JOURNEYS_ENABLED`, `EMAIL_PROMOTIONS_ENABLED`, `MARKETING_FOLLOWUPS_ENABLED`, `REFERRAL_PROGRAM_ENABLED`, `EMAIL_MARKETING_AGENT_ENABLED`
**Discord:** `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_*`
**Auth:** `JWT_SECRET`, `CSRF_SECRET`, `OWNER_*`, `MANAGER_*`
**Optional/test:** `ALLOW_TEST_PAYMENTS`, `MARKETING_*`, `CLOUDINARY_*`

---

## 6. Run commands

```
npm run dev           # Next.js app (:3000)
npm run host:dev      # the combined worker host — what production runs (host:start)
npm run workers:dev   # DEV ONLY: bare workers, no host/health server. Never with host:*
npm run bot:dev       # DEV ONLY: gateway bot alone (the host already starts it)
npm run typecheck     # tsc --noEmit
npx tsx src/workers/bull-board.ts   # optional queue inspector (:3001)
```

A dev shell holding the production `REDIS_URL` writes production queues and
schedules. Point local runs at a local Redis.

---

## 7. Known dead/optional code (not yet removed)

- **`file-cleanup`** (`src/lib/queues/index.ts` job type, handled in
  `scheduled.worker.ts`): nothing ever enqueues it — a dead case.
- **`src/workers/index.ts`**: the pre-host entrypoint. Still used by
  `workers:dev` / `workers:start`; never run in production.
- **`vercel.json`** and **`Procfile`**: historical, read by no production
  service (see `DEPLOY.md` §12).
- **Templates outside `ALLOWED_TEMPLATES`**: rendered only by previews or the
  admin test-send path. The allowlist drops anything else with a log.
- The **`webhook-retry` queue is NOT dead** — the API enqueues Stripe events
  (`src/lib/stripe-events.ts`) and `src/workers/webhook.worker.ts` consumes
  them. Earlier revisions of this file claimed otherwise.
