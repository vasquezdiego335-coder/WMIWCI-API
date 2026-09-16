# Deployment — Railway (API service + worker host)

Production is **two Railway services built from this repository's `main`
branch**, which must always run the **same commit**. There is no Vercel
deployment, no Upstash, and no SMS. `vercel.json` and `Procfile` are historical
files kept in the tree; no production service reads either one (see §12).

Related: [`ARCHITECTURE.md`](ARCHITECTURE.md) (what the code is),
[`docs/email-operations.md`](docs/email-operations.md) (email runbook),
[`docs/env-ownership.json`](docs/env-ownership.json) (per-service variable
manifest, generated and test-verified).

---

## 1 · Topology

| | API service | Worker host |
|---|---|---|
| Railway project / service | `earnest-solace` / **`wonderful-strength`** | `patient-communication` / **`discord workers`** |
| Runtime | Next.js 15.5.24 (App Router) | plain Node/Express + BullMQ (`tsx src/worker-host.ts`) |
| Build | `npx prisma generate && npx next build` (`nixpacks.toml`) | overridden in that service's own Railway UI |
| Start | `npm run start` → `next start` | `npm run host:start` |
| Healthcheck Path configured in Railway | **none today** | **none today** |
| Restart policy | `ON_FAILURE`, max 10 | `ON_FAILURE`, max 10 |
| Public base URL | `https://wonderful-strength-production-a0f1.up.railway.app` | `https://worker-production-4c70.up.railway.app` |

- **Postgres:** Neon, reached through the **PgBouncer pooler** host. The Prisma
  datasource has no `directUrl`, so migrations need the **direct (non-`-pooler`)
  host** supplied by hand (§10).
- **Redis:** Railway (not Upstash). `UPSTASH_REDIS_REST_*` is a *separate,
  optional* credential used only by the API's rate limiter.
- The two Railway **projects are separate**, so there are no shared or reference
  variables: every `mustMatch` value is typed twice, by hand.

**Recommendation (not applied — it is an owner action in the Railway UI).**
Neither service has a Healthcheck Path. Setting one changes deploy behaviour, so
decide deliberately:

- API → `/api/health/live` (pure liveness) is safe. `/api/health` is *readiness*
  and returns 503 while the worker is down; it will block a deploy.
- Worker → `/livez` (pure liveness) is safe. **`/healthz` is readiness** and
  returns 503 until every worker attaches and every schedule is verified — point
  a healthcheck at it only with a start-up grace of ≥ 60 s and with the
  knowledge that a Redis outage then fails the deploy.

---

## 2 · What each service is responsible for

### API service (`wonderful-strength`)

- Every HTTP route under `app/api/**`, including the externally-registered ones:
  `/api/stripe/webhook`, `/api/discord/interactions`, `/api/email/webhook`,
  `/api/email/unsubscribe`, `/api/email/open`, `/api/email/suppression`,
  `/api/email/agent-heartbeat`, `/api/notify/lead`, and `/api/sms/inbound`
  (**records STOP/START opt-outs only — it sends nothing**).
- The admin dashboard (`app/(admin)/admin/**`), including the whole
  `email-marketing` section.
- **Produces** BullMQ jobs on `email`, `discord`, `scheduled` and
  `webhook-retry`, and performs a few inline guarded sends (the lead
  acknowledgement, `src/lib/notify.ts`).
- It **never consumes a queue.** Anything it enqueues waits for the worker host.

### Worker host (`discord workers`)

- **Consumes all five queues** (§6) — this is the only process that sends email.
- Runs the **self-healing reconciler for the twelve recurring schedules** (§5).
- Drains the transactional outbox and runs every recovery sweep.
- Runs the **Discord gateway bot** (the only gateway login in production).
- Serves its own small Express surface: `/livez`, `/readyz` (= `/healthz`,
  `/health`, `/`), `/api/email/health` (key-gated diagnostics) and an **optional**
  `/api/stripe/webhook` fallback that is only live if someone registers this host
  in Stripe. The recommended topology keeps Stripe pointed at the API.

**Never run `workers:start`, `outbox:start` or `bot:start` alongside
`host:start`.** They would double-consume the queues and log the Discord gateway
in twice. `npm run workers:dev` is a local-development entrypoint only — and a
dev shell holding the production `REDIS_URL` writes production schedules.

---

## 3 · Required environment per service

`docs/env-ownership.json` is the generated, test-verified manifest (188
variables). Read `requiredBy` for "the worker halts without it" and `mustMatch`
for "type the same value on both services". **Compare names and hashes, never
print values.** Regenerate with `npx tsx scripts/gen-env-ownership.ts`.

**(a) Required on BOTH services — a missing one halts the worker at startup**
(`src/lib/env.ts` `checkEnv()`):

`DATABASE_URL`, `REDIS_URL`, `APP_URL`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`,
`DISCORD_APPLICATION_ID`

plus, **whenever this deployment is expected to send email** — `NODE_ENV=production`,
**or** `EMAIL_PROMOTIONS_ENABLED=true`, **or** `EMAIL_JOURNEYS_ENABLED=true`,
unless `EMAIL_SENDING_ENABLED=false`:

`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`,
`BUSINESS_POSTAL_ADDRESS`, `MARKETING_SITE_URL`

> `DISCORD_PUBLIC_KEY` and `DISCORD_APPLICATION_ID` are required by `checkEnv()`
> on **both** services although no worker code reads them. That is an open
> owner decision recorded in the manifest's notes, not a mistake to "fix" by
> deleting the variables from the worker — doing so prints `STARTUP HALTED` and
> exits 1 after `WORKER_CONFIG_FAILURE_EXIT_MS` (default 120 s).

**(b) `mustMatch` — the VALUE must be identical on both services.** Nothing
enforces it. Current set:

`APP_URL`, `BUSINESS_POSTAL_ADDRESS`, `DATABASE_URL`, `EMAIL_CAP_PER_DAY`,
`EMAIL_CAP_PER_WEEK`, `EMAIL_CAP_PER_MONTH`, `EMAIL_FROM`,
`EMAIL_JOURNEYS_ENABLED`, `EMAIL_MARKETING_AGENT_ENABLED`,
`EMAIL_PROMOTIONAL_ALLOWLIST`, `EMAIL_PROMOTIONS_ENABLED`,
`EMAIL_QUIET_START_HOUR`, `EMAIL_QUIET_END_HOUR`, `EMAIL_REPLY_TO`,
`EMAIL_SENDING_ENABLED`, `EMAIL_TOKEN_SECRET`,
`EMAIL_TRANSACTIONAL_GAP_MINUTES`, `MARKETING_FOLLOWUPS_ENABLED`,
`MARKETING_SITE_URL`, `OUTBOX_ENABLED`, `REDIS_URL`, `REFERRAL_PROGRAM_ENABLED`,
`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `TIMEZONE`

The send guard (`src/lib/email-guard.ts`) runs on **both** services, so the caps
and quiet hours above decide when a customer is mailed on whichever service
happens to send. If they differ, customers see inconsistent timing.
`EMAIL_TOKEN_SECRET` must match because the **worker signs** unsubscribe links
and the **API verifies** them.

**(c) API-only (a selection):** `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`,
`JWT_EXPIRY`, `CSRF_SECRET`, `COOKIE_DOMAIN`, `CORS_ALLOWED_ORIGINS`,
`ALLOW_TEST_PAYMENTS`, `INTERNAL_NOTIFY_TOKEN`, `QUOTE_LEAD_CAPTURE_ENABLED`,
`CUSTOMER_AUTOREPLY_ENABLED`, `REFERRAL_SECRET`, `GOOGLE_MAPS_SERVER_KEY`,
`EMAIL_AGENT_HEARTBEAT_TOKEN`, `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN` (rate limiter only), `EMAIL_DNS_*`.

**(d) Worker-only (a selection):** `PORT`, `WORKER_CONFIG_FAILURE_EXIT_MS`,
`OUTBOX_BATCH`, `OUTBOX_POLL_MS`, `OUTBOX_STALE_PROCESSING_MS`,
`OUTBOX_SEND_DATE_PICKED`, **`OUTBOX_EMAIL_DRYRUN` (never `true` in
production — it HOLDS rows and is not a delivery test)**, `EMAIL_HERO_GIF_URL`,
`MARKETING_API_KEY`, `MARKETING_LIST_ID`, `DISCORD_CHANNEL_JOBS`,
`DISCORD_CHANNEL_PAYMENTS`, `DISCORD_CHANNEL_RECEIPTS`,
`DISCORD_CHANNEL_PHOTOS`, `DISCORD_CHANNEL_PAPERWORK`,
`DISCORD_CHANNEL_BOT_LOGS`.

Before a deploy that adds a variable, set it on **every service the manifest
names**. `docs/env-ownership.json` contains no values, and a test enforces that.

---

## 4 · Verifying a running deployment (read-only)

```bash
API="https://wonderful-strength-production-a0f1.up.railway.app"
WRK="https://worker-production-4c70.up.railway.app"

curl -s "$API/api/health/live"     # always 200 while the process serves: liveness only
curl -s "$API/api/health"          # readiness
curl -s "$WRK/livez"               # always 200 while the process serves: liveness only
curl -s "$WRK/readyz"              # readiness (identical to /healthz, /health, /)
```

**API `GET /api/health` is 200 only when** the database answers `SELECT 1`, Redis
answers a real `PING`, every required variable is present, `APP_URL` is a usable
URL, **and** `emailDelivery.ready` is true. Read:

- `emailDelivery.ready` / `.problems` / `.workersAttached` — `email`, `scheduled`
  and `webhook-retry` each need ≥ 1 attached worker. Zero on `email` means every
  queued customer email is waiting for nobody; zero on `webhook-retry` means paid
  deposits are not being fulfilled. `discord` is reported but only informational.
- `emailQueue.workersAttached` (kept for older runbooks), `redis`, `db`,
  `appUrl`, `linkVars`, `emailFlags`, `env.missingRequired`, `commit`.

**Worker `GET /readyz` is 200 only when** the host phase is `running`, no
required configuration is missing or invalid, Redis answers `PING`, Postgres
answers `SELECT 1`, **all five** queue workers are running, unpaused and
*attached* (their Redis connection emitted `ready`), and **every recurring
schedule is registered**. Read:

- `problems[]` — empty on a healthy host; each entry names the fault.
- `workers[]` — `email`, `discord`, `scheduled`, `marketing`, `webhook-retry`,
  each with `running`, `paused`, `attached`, `attachedAt`, `lastError`.
- `schedules` — `{ ok, firstPassDone, registered[], missing[], lastErrors[],
  lastPassAt, nextPassAt }`. **This is the read-only proof that the crons
  exist**: it comes from `getRepeatableJobs()` against Redis, not from the
  startup code's own return value. `missing` counts against readiness only after
  the first reconcile pass or a 60 s boot grace.
- `phase`, `discordBot.ready`, `flags`, `emailBlockRecordFailures`, `commit`.

**Both `commit` values must be equal.** If they are not, one service is running
older code.

A worker started with **missing or invalid configuration** serves 503 naming the
variables for `WORKER_CONFIG_FAILURE_EXIT_MS` (default 120 s), then exits 1 so
Railway marks the deployment crashed. That is the host's **only** non-zero exit:
Redis, Postgres, cron and worker faults are reported as 503 and never exit,
because Railway restarts at most ten times and a long outage would otherwise
leave transactional email permanently down. Neither endpoint ever prints a
secret value.

> **Semantics change, 2026-09-15.** The worker's `/healthz` used to be closer to
> liveness. It is now readiness, and `/livez` is new. An uptime monitor pointed
> at `/healthz` will start alerting on conditions it previously ignored (paused
> worker, missing schedule, Redis down). That is intentional — but tell the owner
> before the deploy. `/api/health` on the API likewise now returns 503 when a
> required queue has no consumer.

---

## 5 · Recurring schedules (12)

Registered by `createCronReconciler` from the single registry
`src/lib/cron-schedules.ts`, on queue **`scheduled`**, via BullMQ's **legacy
repeat API** (`queue.add(name, { type: name }, { repeat: { pattern, tz }, jobId:
'cron:<name>' })`). Re-adding an identical schedule overwrites the same key, so
repeated startups leave exactly twelve entries.

| # | Name | Pattern | TZ | What it does | Gate |
|---|---|---|---|---|---|
| 1 | `daily-schedule-morning` | `0 7 * * *` | America/New_York | Morning Discord digest (today's jobs, last-activity block) | — |
| 2 | `daily-schedule-evening` | `0 19 * * *` | America/New_York | Evening digest (tomorrow's jobs) | — |
| 3 | `campaign-sweep` | `*/15 * * * *` | UTC | Dispatch due SCHEDULED campaigns, re-open stale recipient claims, re-drive overdue DEFERRED recipients, re-enqueue lost batches, finalize settled runs | — |
| 4 | `lead-notification-sweep` | `*/15 * * * *` | UTC | Durable recovery for owner lead alerts (delivery itself is inline) | — |
| 5 | `automation-sweep` | `*/15 * * * *` | UTC | Re-queue due automation stages, evaluate time-based triggers | — |
| 6 | `outbox-email-recovery` | `*/15 * * * *` | UTC | Drain outbox rows whose post-commit nudge was lost | no-op unless `OUTBOX_ENABLED=true` |
| 7 | `email-side-effect-sweep` | `*/15 * * * *` | UTC | Retry webhook side effects (suppressions) that failed to write | — |
| 8 | `email-monitoring` | `*/15 * * * *` | UTC | Read-only health checks; it repairs nothing by design | — |
| 9 | `email-agent-cycle` | `*/15 * * * *` | UTC | Email operations agent; returns immediately when its mode is `off` | self-gated by agent mode |
| 10 | `lead-maintenance` | `20 3 * * *` | America/New_York | Age inactive partial captures, retention purge | — |
| 11 | `marketing-discovery` | `5 10 * * *` | America/New_York | AI campaign **drafter — DRAFT only, never sends** | `EMAIL_MARKETING_AGENT_ENABLED` on the **worker** |
| 12 | `lifecycle-repair` | `0 * * * *` (top of every hour) | UTC | Repair stranded quote journeys, re-drive due follow-up retries, **drain `lifecycle_enqueue_retries`** | — |

Delayed / one-off jobs also land on `scheduled` and are **not** repeatables:
`abandoned-checkout-recovery(-2,-3)`, `job-reminder-72h/24h`,
`quote-followup-1/2/final`, `lead-nurture-1/2/final`, `review-request-48h`,
`review-request`, `review-reminder`, `repeat-reminder`, `referral-ask`,
`balance-reminder-post`, `automation-stage`, `outbox-email-drain`. The
`file-cleanup` job type exists but **has no producer** (dead case).

**How to verify the schedules exist, read-only.** Use the worker's readiness
payload — it is the whole answer and it writes nothing:

```bash
curl -s "$WRK/readyz" | python -c "import sys,json; d=json.load(sys.stdin); print(d['schedules'])"
# expect: ok true, missing [], registered = the 12 names above, lastErrors []
```

Do **not** "check" the crons with `queue.add`, `obliterate`, or Bull Board's
buttons against production Redis: those write. If you must inspect Redis
directly, read-only commands on the repeat hash are enough
(`HKEYS bull:scheduled:repeat`). `npx tsx scripts/email-queue-audit.ts` is a
**dry run by default** and changes nothing; only `--apply` deletes, and what it
deletes is stale promotional jobs, never a schedule.

**Redis eviction.** These schedules live in Redis keys. Confirm with the owner
that the Railway Redis instance has `maxmemory-policy noeviction`; under an
evicting policy the repeat keys can disappear silently. The reconciler
re-registers them within ten minutes and readiness goes 503 in the meantime, but
the jobs that should have fired during the gap are simply never fired.

---

## 6 · Queues and their consumers

All five workers run in the worker host (`EXPECTED_WORKERS = 5`).

| Queue | Producer | Consumer | Attempts | Backoff | Concurrency | Retained failures |
|---|---|---|---|---|---|---|
| `email` | API + worker (journeys, fulfilment, campaigns, outbox) | `src/workers/email.worker.ts` | 3 | exponential 5 s | 5 | last 200 |
| `discord` | API + worker | `src/workers/discord.worker.ts` | 5 | exponential 3 s | 2 | last 200 |
| `scheduled` | API + worker | `src/workers/scheduled.worker.ts` | 3 | fixed 60 s | 2 | last 100 |
| `marketing` | worker | `src/workers/marketing.worker.ts` | 5 | exponential 5 s | 2 | last 100 |
| `webhook-retry` | API (`src/lib/stripe-events.ts`) | `src/workers/webhook.worker.ts` | 5 | exponential 10 s | 5 | last 100 |

**How to prove the queues are actually being consumed:** the API's
`/api/health` → `emailDelivery.workersAttached` (counted from the API side), and
the worker's `/readyz` → `workers[]` (reported by the process that owns them).
If those two disagree, one service is talking to a different Redis.

The scheduled worker runs at concurrency 2 while **eight** jobs fire at minute
`:00`. Sweeps can therefore be minutes late; that is freshness, not correctness.

`src/workers/bull-board.ts` is a manual inspector (`npx tsx
src/workers/bull-board.ts`, `BULL_BOARD_PORT`, default 3001). It lists `email`,
`discord`, `webhook-retry`, `scheduled` — **not** `marketing`.

---

## 7 · Failed, deferred and ambiguous email

Detail lives in [`docs/email-operations.md`](docs/email-operations.md) §6. The
operator rules:

- **Ambiguous is never auto-resent.** A 5xx, a 408, a timeout, an
  `application_error`, or a "success" carrying no message id becomes
  `ambiguous`: terminal, and Resend may already have delivered it. So does a row
  left in `sending` past `EMAIL_SENDING_STALE_MS` (10 min) — it is closed by the
  next claim of the same key and never taken over. **Reconcile against the Resend
  dashboard by hand.**
- **`reopenForRetry` is the only deliberate re-drive**, from the admin Sends
  page. It **refuses `delivered`** (`refused_delivered`) and **refuses `sending`**
  (`refused_in_flight`); reconcile a live or unknown attempt first.
- **Guard deferrals are not failures.** Quiet hours, frequency caps and `not_due`
  re-queue the *same* job at its exact due time with colon-free job ids
  (repeated deferrals work), and do not consume an attempt. A definitive 4xx
  provider rejection on the job's **last** attempt is re-queued at the ledger's
  due time rather than lost.
- **Campaign recipients:** a transient read failure (`suppression_read_failed`,
  any `*_read_failed`, `claim_lookup_failed`, `context_error:`) now goes
  **`DEFERRED` with `next_attempt_at`** and bounded backoff (5/10/20/40/80 min,
  cap 2 h), and ends `FAILED '<reason>:retries_exhausted'` at the budget
  (`EMAIL_CAMPAIGN_TRANSIENT_MAX_ATTEMPTS`, default 6) — **never `SUPPRESSED`**.
  `hard_bounce`, `spam_complaint`, `admin_block`, `invalid_address` and
  `provider_rejected` stay terminal. A run with deferred recipients can stay open
  for ~2.6 h. The `campaign-sweep` re-drives overdue rows; rows whose
  `next_attempt_at` is NULL (written before this release) are deliberately
  ignored.
- **Lifecycle enqueue retries** (`lifecycle_enqueue_retries`): when `queue.add`
  fails or times out on a lifecycle scheduler, the exact job is recorded here.
  Statuses are `pending` (due to be re-added), `enqueued` (the sweep put it back
  in Redis) and `abandoned`. The hourly `lifecycle-repair` re-adds the **same job
  id**, and **abandons any row past its `not_after`** rather than firing a stage
  late. A healthy system keeps this table empty:
  `select status, count(*) from lifecycle_enqueue_retries group by 1;`
- **Alerting:** the email agent's `lifecycle.enqueue_retry_backlog` warns on
  pending rows older than 2 h and goes critical at 6 h or on any
  non-cancellation abandonment in 24 h; `run.deferred_overdue` and
  `run.recipient_terminal_with_retryable_send` cover the campaign path. Outbox
  statuses are described in `docs/email-operations.md` §6c.

---

## 8 · Resend webhook

**Endpoint:** `POST {APP_URL}/api/email/webhook` on the **API service**
(`app/api/email/webhook/route.ts` → `src/lib/email-events.ts`).
**Secret:** `RESEND_WEBHOOK_SECRET` (a `whsec_…` value). Signature is **Svix over
the raw request body** — the route reads `req.text()`, never `req.json()`.
**Dedupe:** the `svix-id` header is stored as `EmailEvent.providerEventId`
(UNIQUE). A replay of an event whose suppression never settled re-drives that
side effect. Replay window ±5 minutes.

Subscribe to **all nine** handled events. Configuring only the older seven means
a provider-side failure and a provider-side suppression are never delivered:

| Resend event | Recorded as | Handling |
|---|---|---|
| `email.sent` | `sent` | Record only |
| `email.delivered` | `delivered` | Sets the delivery column (first writer wins) |
| `email.bounced` — **hard** | `bounced` | Suppress `HARD_BOUNCE` (scope all), stamps `bouncedAt`, stops enrollments |
| `email.bounced` — **soft** | `soft_bounced` | **No suppression, no `bouncedAt`**, no effect on bounce rate |
| `email.complained` | `complained` | Suppress `SPAM_COMPLAINT` |
| `email.suppressed` | `provider_suppressed` | Suppress `PROVIDER_REJECTED` (mirrors Resend's own list) |
| `email.delivery_delayed` | `delivery_delayed` | **Record only** — no column, no state change, no suppression |
| `email.failed` | `failed` | **Record only** — the message was accepted and then failed at Resend. Investigate and resend by hand; **never bulk-resend** |
| `email.opened` | `opened` | Record only |
| `email.clicked` | `clicked` | Record only |

Anything else (`email.scheduled`, `contact.*`, `domain.*`) is `ignored` with HTTP
200. **Hard vs soft** (`src/lib/bounce-classification.ts`): hard only when
`bounce.type` is `Permanent` (case-insensitive) **and** `subType` is not
`MailboxFull` / `MessageTooLarge` / `ContentRejected` / `AttachmentRejected`;
with no `type`, hard only for `subType` `General` / `NoSuchUser` / `NoEmail` /
`Suppressed` / `OnAccountSuppressionList`.

**HTTP semantics** — the provider retry is load-bearing:

| Status | Meaning |
|---|---|
| 200 | Consumed **and** every required side effect settled |
| 400 | Bad signature or unparseable JSON — retrying will never help |
| 500 | Recorded, but a required suppression did **not** complete → Resend must retry |
| 503 | `RESEND_WEBHOOK_SECRET` is not set; the route refuses to process anything |

Side effects that did not settle are retried by `email-side-effect-sweep` every
15 min and **dead-lettered after 5 attempts** — a dead-lettered suppression needs
a human. Correlation to `EmailSend` is by `providerId` and **fails open**: an
event that arrives before the provider id is written (or during a database blip)
is stored with `emailSendId` null and never applies delivery state. The agent
check `webhook.unlinked_event` is where that shows up.

---

## 9 · Nothing replays history automatically

This release adds retries for work that was *lost in flight*. It never
reconstructs email that was never scheduled, and **no deploy, flag or migration
sends a backlog**:

- Webhook events are processed as delivered. There is no backfill of past events,
  and soft-bounce rows written before 2026-09-15 were **not** reclassified
  (owner decision: no backfill).
- `lifecycle_enqueue_retries` re-adds only rows recorded by *this* code, and
  abandons anything past `not_after` with `too_late: not re-enqueued (no
  historical replay)`.
- The campaign sweep re-drives only DEFERRED recipients that carry a
  `next_attempt_at`.
- Outbox recovery drains only `pending` rows; quote journeys enrol only within
  `EMAIL_QUOTE_JOURNEY_MAX_AGE_DAYS` (default 14); follow-up retries only for
  rows younger than 7 days.
- Ambiguous sends are never resent (§7).
- Turning a flag on does not mail past events.

**SMS is gone** (owner, 2026-09-15). There is no Twilio worker and no `sms`
queue. `/api/sms/inbound` only records STOP/START. Do not restore or propose an
SMS path.

---

## 10 · Migrations

Migrations are **never** run in the build (`nixpacks.toml`): build-time
connections to Neon are flaky and a failed migration would block the deploy. They
are an owner-run step.

```bash
# DIRECT (non "-pooler") Neon host — PgBouncer transaction mode breaks the
# migration advisory lock, and the datasource has no directUrl.
DATABASE_URL="postgresql://…@ep-xxx.<region>.aws.neon.tech/…" npx prisma migrate deploy
```

Never run `prisma migrate dev` or `prisma db push` against production: either
would drop the partial indexes (`crm_leads_open_booking_session_key`,
`email_campaign_runs_one_unfinished_per_campaign`) and the tracker's `leads`
table. Never edit an applied migration — production records its checksum.

### This release adds three additive migrations

| Migration | What it does | Rollback |
|---|---|---|
| `20260915120100_campaign_recipient_transient_retry` | `email_campaign_recipients`: `next_attempt_at` (nullable), `transient_attempts` (default 0), index `(status, next_attempt_at)` | drop the index, then the two columns |
| `20260915120200_lifecycle_enqueue_retries` | new table `lifecycle_enqueue_retries` + its indexes | `DROP TABLE IF EXISTS "lifecycle_enqueue_retries";` |
| `20260915120000_campaign_run_single_unfinished` | partial UNIQUE index `email_campaign_runs_one_unfinished_per_campaign` on `(campaign_id) WHERE status IN ('PREPARING','QUEUED','SENDING','PAUSED','CANCELLING')` | `DROP INDEX IF EXISTS "email_campaign_runs_one_unfinished_per_campaign";` |

No migration writes a row and none backfills. Each file's header carries its own
rationale and rollback SQL.

**All three go in together, before the merge.** `prisma migrate deploy` applies
every pending migration in directory-name order and has no per-migration
selector, so a two-phase split is not executable with it — `…120000` lands
first whatever the intent. That is the safer outcome anyway: under the OLD code
the unguarded dispatch race sends a campaign's recipients twice, while with the
index in place a concurrent create surfaces as a `P2002` the admin sees. Both
services then pick up the new code minutes later on merge.

1. **Read-only preflight first.** Run `scripts/campaign-run-duplicate-preflight.sql`
   against production. Queries 1 and 2 **must** return zero rows. If query 1
   returns rows, do not force anything: decide per campaign which run survives
   (the one with recipients or sends), cancel the other through the admin, let it
   settle, and re-run the preflight. Query 6 counts existing
   `SUPPRESSED / 'suppression_read_failed'` recipients for the owner — re-opening
   any of them is a separate, deliberate decision, not part of this release.
2. **Apply all three with one `migrate deploy` BEFORE the PR merges**, because
   Railway auto-deploys on merge. The regenerated Prisma client selects
   `next_attempt_at` / `transient_attempts`, and an unmigrated database throws
   `P2022` on any default-select read of `email_campaign_recipients`. Until the
   retry table exists, a failed enqueue logs `LIFECYCLE_ENQUEUE_LOST` instead of
   being recorded. Between the migration and the merge, the only new exposure is
   that a concurrent dispatch under the old code raises `P2002` instead of
   silently creating a second run — so keep the gap short.
3. **If `…120000` fails** (production already holds two unfinished runs for one
   campaign) `prisma migrate deploy` records it FAILED and blocks every later
   deploy. After resolving the duplicates, run
   `npx prisma migrate resolve --rolled-back 20260915120000_campaign_run_single_unfinished`
   and deploy again.

### The email consent release adds one additive migration (2026-09-16)

| Migration | What it does | Rollback |
|---|---|---|
| `20260916120000_email_consent_enrollment` | new tables `email_consent_events` (append-only: a trigger refuses UPDATE/DELETE except `redact_email_consent(email)`), `email_marketing_status`, `sequence_enrollments`; nullable columns `crm_leads.basis_event_id`, `bookings.basis_event_id`, `email_sends.marketing_basis`, `email_sends.basis_event_id` | in the file's header — roll the code back FIRST, and export `email_consent_events` before dropping it (it is consent evidence) |

It writes no row and backfills nothing: every existing lead and booking has no
notice basis, so no historical contact can be enrolled by it.

**Apply it BEFORE the merge — this one is not optional ordering.** The
regenerated Prisma client selects the four new columns on every default read
and write of `crm_leads`, `bookings` and `email_sends`. On an unmigrated
database, booking creation, payment fulfilment and **every** email send —
transactional included — fail with `P2022` the moment Railway deploys. Then run
`npx tsx scripts/email-schema-preflight.ts`; it must report no drift (it checks
the new tables, columns, the `(request_id, kind)` unique index, the kind CHECK
and the append-only trigger).

Every new flag defaults off (`EMAIL_NOTICE_BASIS_ENABLED`, `OFFER_SIGNUP_ENABLED`,
`EMAIL_EBR_BASIS_ENABLED`, `EMAIL_REQUIRE_TURNSTILE`), so no form notice becomes a
marketing basis and the popup route stays dark until an owner turns them on.

**What the flags turn on.** Every genuine form submission with an email enters
an EXISTING sequence with its existing templates and cadence: a priced quick
quote → quote follow-up (after the quote reply is webhook-delivered, in the page
language); a no-price quote, the booking form's Continue click, every contact
topic (the team alert is queued first), the popup and the tracker → lead
nurture; a submitted, unpaid booking → abandoned-checkout recovery. The one copy
change is the lead-nurture footer, which no longer says "opted in". The full map
is docs/email-marketing/form-marketing-paths.md.

**Rules that apply at once, flags or not:** test/staff/role addresses are refused
promotional mail even with consent; nobody gets two copies of one sequence
running at once (a form-notice person: one of each kind per 30 days); the lead
nurture refuses anyone with a booking on record — a move taken before, or a
booking still waiting for payment or approval; recovery for an unpaid booking
stops once a LATER booking by the same customer is paid or approved; a booking
stops the person's lead sequences; a suppression (bounce, complaint, unsubscribe,
admin block) stops every sequence row; the unsubscribe page never offers "keep me
subscribed" to someone who had already opted out; journey scheduling needs
`EMAIL_PROMOTIONS_ENABLED=true` (already true); an admin can no longer lift an
unsubscribe; a later hard bounce or complaint relabels an admin block.

**Abuse limits (API service, read per request, blank or invalid = default):**
`CONSENT_IP_DISTINCT_EMAILS_24H` (5 distinct addresses granted per client
connection per 24 h; IPv6 grouped by /64), `CONSENT_GLOBAL_GRANTS_24H` (100
distinct addresses per 24 h; a breaker trip posts one ops alert),
`CONSENT_POPUP_GRANTS_24H` (30 distinct popup addresses per 24 h). A withheld
grant still saves the lead and sends the requested reply; it is recorded as a
`basis_withheld` event with its reason. Route limits: booking submit 10/h
(fail-closed, its own bucket), route estimate 40/10 min (fail-closed, its own
bucket), checkout resume 30/h (fail-closed, its own bucket).

**Apply the migration with a lock timeout.** On the Neon DIRECT host, append
`options=-c lock_timeout=5s` to the URL for `migrate deploy`: the three ALTERs
take brief exclusive locks, and production's `lock_timeout` is 0. A timeout rolls
the whole file back cleanly; `migrate resolve --rolled-back
20260916120000_email_consent_enrollment`, then deploy again at a quieter moment.

**Rollout gates, in order:** migration + preflight → API and worker on the same
commit → website → tracker (`INTERNAL_NOTIFY_TOKEN` on API and tracker,
`WMIWCI_API_BASE_URL` on the tracker) → reconcile the Leadtracking/SendGrid
suppressions (import UNSUBSCRIBED first, then bounces as HARD_BOUNCE, invalid as
INVALID_ADDRESS, spam reports as SPAM_COMPLAINT; do not import SendGrid "blocks"
in bulk) → `EMAIL_NOTICE_BASIS_ENABLED=true` on the worker, then the API →
`OFFER_SIGNUP_ENABLED=true` → remove `SENDGRID_API_KEY` from the Lead-tracking
service (keep the service up ≥30 days for its unsubscribe links). Keep
`TURNSTILE_ENABLED=false` until a real secret and a page widget both exist.

CI builds its throwaway database from `prisma/baseline/00_init.sql` plus the
migrations listed in `prisma/baseline/REPRESENTED_MIGRATIONS.txt`, then runs a
real `prisma migrate deploy` for everything else — so a new migration's SQL
genuinely executes in CI. **Never add a name to that list by hand** (a name
belongs there only if the baseline was regenerated to include it), never remove
one, and every new migration must sort after the last listed name — `ci.yml`
enforces that.

---

## 11 · Deploy order and rollback

1. Preflight + migrations per §10.
2. Merge to `main`. Railway auto-deploys **both** services.
3. Confirm both services report the **same `commit`** (§4).
4. Verify: worker `/readyz` → `problems []`, `schedules.missing []`, five
   attached workers; API `/api/health` → `status ok`, `emailDelivery.ready true`.
5. Watch for one hour. **A healthy sweep is silent** — it only logs when it
   re-enqueues or abandons a row. The check is the table:
   `select status, count(*) from lifecycle_enqueue_retries group by 1;` should
   stay empty. A `lifecycle retry ABANDONED` log line means a customer stage was
   dropped rather than fired late; investigate the Redis outage behind it.
6. **Rollback = redeploy the previous commit on BOTH services.** They must stay
   on the same commit. The three migrations are additive and safe to leave in
   place under the old code; only roll SQL back (per §10's table) after the
   application is already rolled back, and never with live traffic on the new
   code.

---

## 12 · First-time / occasional setup

### Secrets

```bash
openssl rand -base64 64     # JWT_SECRET
openssl rand -hex 32        # CSRF_SECRET
npm run hash-password 'yourPasswordHere'   # OWNER_PASSWORD_HASH / MANAGER_PASSWORD_HASH
```

### Provisioned services

| Service | Purpose |
|---|---|
| Neon | PostgreSQL (pooler host for the app, direct host for migrations) |
| Railway | Both app services **and** Redis |
| Stripe | Payments |
| Resend | Email |
| Cloudinary | File storage |
| Discord | Bot + channels |

### Discord

1. App at <https://discord.com/developers/applications>; enable `SERVER MEMBERS
   INTENT` and `MESSAGE CONTENT INTENT`; note the Application ID and Public Key.
2. **Interactions Endpoint URL** →
   `https://wonderful-strength-production-a0f1.up.railway.app/api/discord/interactions`
   (the **API** service — interactions are HTTP, not gateway).
3. Invite with `Send Messages`, `Manage Channels`, `Embed Links`, `Add Reactions`.
4. Register slash commands: `npm run register-commands`.

### Stripe

Dashboard → Developers → Webhooks → Add endpoint:

- URL `https://wonderful-strength-production-a0f1.up.railway.app/api/stripe/webhook`
- Events `checkout.session.completed`, `checkout.session.expired`,
  `payment_intent.payment_failed`

The API verifies the signature and enqueues to `webhook-retry`; the worker host
processes it. Only register the worker's own `/api/stripe/webhook` if you
deliberately want that topology instead.

### Optional services

- **Cloudflare Turnstile** — create the widget, set the site + secret keys and
  `TURNSTILE_ENABLED=true`, redeploy.
- **Sentry** — set the DSN and `SENTRY_ENABLED=true`, redeploy.
- **SMS — removed.** Nothing to activate (§9).

### Database backups

```bash
BACKUP_DIR=./backups DATABASE_URL="…" bash scripts/backup-db.sh
```

### Historical files kept in the tree

`vercel.json` and `Procfile` are **not read by either Railway service**.
`vercel.json` is left in place because a Vercel project may still be linked to
this repository; removing it is an owner decision. `Procfile` documents the
worker start command that the Railway UI actually overrides.

---

_Last updated 2026-09-15 (production reliability release). Rewritten from the
2026-era Vercel/Upstash guide, which described a topology that no longer exists._
