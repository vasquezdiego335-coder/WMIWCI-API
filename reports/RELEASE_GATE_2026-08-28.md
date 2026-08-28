# MoveItClearIt — Release Gate

**Outcome: NO-GO**, with four named blockers. Everything else is done, verified
and committed.

| | |
|---|---|
| API branch | `fix/lead-state-v3-production-gate` @ `ba6ae46b` (base `0ea3ef17`) |
| SITE branch | `fix/lead-state-v3-production-gate` @ `b2c55a94` |
| Diff vs base | 60 files, +8,317 / −580 |
| New migrations | 4, all additive, all on `crm_leads` |
| Verified against | PostgreSQL 18.4, Redis 7.4.11 (local, disposable) |
| Date | 2026-08-28 |

Nothing was pushed, deployed or migrated. No production data was read or
written. No real Discord message, email or SMS was sent — the HTTP tests drive a
receiver bound to `127.0.0.1`. `EMAIL_PROMOTIONS_ENABLED` stayed `false`
throughout.

---

## Gate results

Every gate below was run on the exact tree at `ba6ae46b`. Exit codes captured
directly, not inferred from a pipeline's last command.

| Gate | Result |
|---|---|
| `prisma validate` | **0** |
| `npm run typecheck` | **0** |
| `npm run lint` | **0** |
| `node scripts/verify-test-gate.mjs` | **0** — 168 test files on disk, 168 enforced |
| `npm test` (API) | **3009 pass / 0 fail / 0 skipped / 0 todo** |
| `npm run test:parity` | **316 pass / 0 fail / 0 skipped / 0 todo** |
| `npm run build` (NODE_ENV=production) | **0** |
| `git diff --check` | **0** |
| SITE `node --test tests/` | **37 pass / 0 fail / 0 skipped / 0 todo** |
| `scripts/release-rehearsal.ts` | 17 checks — 9 pass, 2 fail *(both are blockers B2/B3 below)* |
| `npm audit --omit=dev` | 1 high *(blocker B1)* |

No test was weakened, skipped or deleted to make a gate green. Where something
was not run, it says **NOT RUN** and why.

---

## THE BLOCKERS

### B1 — Next.js carries an unfixable HIGH advisory · owner decision

`next@14.2.35` is the last release of its line; the advisories are fixed in 15/16.
Upgrading is two majors and is not a release-gate change.

**The residual risk is much narrower than the audit line implies.** Checked
against this deployment, the following advisories **do not apply**: no
`next/image` anywhere (Image Optimizer DoS, unbounded image cache), no
`'use server'` (all Server Action advisories), no `rewrites` (request smuggling,
SSRF via attacker-controlled destination), no Pages Router (i18n middleware
bypass), no custom server, no CSP nonces, no `beforeInteractive` scripts.

What remains: middleware redirect cache-poisoning and RSC cache confusion.
Middleware here only guards `/admin/*` behind authentication, and authenticated
admin responses are not shared-cacheable, so exposure is low — but not zero.

- **Owner action:** accept the risk in writing, or schedule the Next 14 → 16
  upgrade as its own change with its own gate.

### B2 — A database cannot be rebuilt from `prisma/migrations` · owner action

There is **no init migration**. Nothing in `prisma/migrations` creates
`bookings`, `crm_leads` or any base table — the schema was originally created
with `prisma db push`, and every migration since assumes the tables exist.
`prisma migrate deploy` against an empty database dies on the first migration:

```
FAILS at 20260525000000_deposit_paid_and_truck_addon — "bookings" does not exist
```

Harmless for *this* deploy: production already has the tables and the
`_prisma_migrations` history. But it means **recovery depends entirely on
backups** — which is why B3 matters as much as it does, and why a fresh staging
environment cannot be built from source.

- **Owner action:** baseline the migration history — generate an init migration
  with `prisma migrate diff --from-empty --to-schema-datamodel`, then
  `prisma migrate resolve --applied <name>` against production so the existing
  database records it as already applied. **Do not** simply add the file: without
  the `resolve` step, the next `migrate deploy` would try to create tables that
  already exist and fail.

### B3 — The backup/restore round-trip is NOT RUN on this machine

`pg_dump` refuses to dump a server newer than itself, and the only client tools
available here are 17.6 against an 18.4 server. The `scripts/backup-db.sh`
round-trip is therefore **NOT RUN** — not passed, not assumed.

What *was* proven, using a database-level copy with the source dropped first:
5,000 rows recovered, and the partial unique index still present, still UNIQUE,
still PARTIAL — a second open lead on one session refused, a fresh lead after
the old one closed still allowed.

Two defects in the backup script were found and **fixed**: it had no version
preflight (so on a host whose tools had fallen behind a managed database, the
nightly backup would simply stop producing files with nobody watching cron), and
its own header documented `psql < backup-file.sql` while the script gzips its
output — the documented restore command could not work.

- **Owner action:** run `scripts/backup-db.sh` against staging on a host with
  client tools ≥ the production server major, restore it into a scratch
  database, and confirm `crm_leads_open_booking_session_key` is present
  afterwards.

### B4 — No staging Discord channel · owner action

The delivery path is proven end to end against a real local HTTP receiver
(15 scenarios, real processor, real transport). What has **not** happened is a
canary through the actual Discord API, because that needs a staging channel and
token, and sending to a live destination was outside what I was authorised to do.

- **Owner action:** provide a staging channel + token, then run one
  `lead_created` notice through it and confirm the card renders.

---

## What was fixed, and why each one mattered

### The capture path could lose a lead silently

The notification event was written **after** the lead had already committed,
from a detached async block. A process killed in between produced a lead nobody
would ever be told about — and no sweeper could find it, because the row meaning
"the owner is owed a message" did not exist.

Both rows now land in **one PostgreSQL transaction**. Publication happens after
commit and is allowed to fail; the durable row is what gets re-driven. Proven
against real PostgreSQL: a committed lead has exactly one event created in the
same commit, and a rolled-back transaction leaves neither.

The duplicate-lead race was **reproduced before it was fixed** — 20 concurrent
captures on one session produced 4 rows in one run and 20 in another. With the
partial unique index: 5 rounds × 20 concurrent → exactly one row, one id, one
`isNew: true`.

### The retry tests were testing a copy of the worker

The previous HTTP suite re-implemented claim → attempt → deliver inside the test
file. That proves the test's own copy behaves and says nothing about the worker
that runs. There is now one processor (`lead-notification-processor.ts`) that
both the worker and the tests execute, and one real transport pointed at a local
receiver.

Doing that surfaced a live bug: **BullMQ's delay and our `nextAttemptAt` are two
clocks**, and a job that ran early found nothing claimable, returned success and
was removed — stranding a row whose due time had passed with nothing scheduled to
come back for it. Early jobs are now rescheduled and consume no attempt. Backoff
gained ±10% jitter so a provider outage doesn't schedule a hundred retries for
the same instant.

And **nothing re-drove the outbox at all**. A new sweeper runs behind a
PostgreSQL advisory lock, in bounded batches, reporting scanned / requeued /
staleRecovered / failed / oldestPendingMs. A site with no visitors is exactly
when a stuck notification matters most.

### `/api/contact` returned success for enquiries it never stored

It answered `{ok:true}` — "Message received, we'll reply shortly" — when
persistence had failed. HTTP monitoring saw a healthy 200 while the customer's
message existed nowhere. It could not have been caught: the route called
persistence directly, so no test could make the store fail.

It now answers **503** with a machine-readable code, one non-PII `errorRef`
shared by the response, the log and the operations alert, and the phone number.
Fifteen tests drive the real handler.

Writing them found two more:

- **The honeypot was dead code.** `company: z.string().max(0)` meant a *filled*
  honeypot failed validation, so every bot got a 422 shape error and the
  silent-accept branch was unreachable — and the status code told the bot which
  submissions were being trapped.
- **The parsed-payload log carried the customer's name and email** on every
  submission.

### Two states that could never happen

`ROUTED` and `ROUTING_FAILED` are fully built, correctly rendered, and
**unreachable**. Nothing writes `quote_mileage_status='calculated'` or
`'routing_failed'`; `calculatedSnapshot()` has no production caller; and
`/api/route-estimate` genuinely measures the drive and then **persists nothing**.

So a lead sits at *"awaiting pickup and destination addresses"* for its entire
life — and the line from the original incident report was never a rendering bug.
It was the only state a lead can reach.

`lead_enriched` was the same shape: declared in the event union and in the schema
comment, produced by nothing.

Both are now pinned by tests that fail if a producer appears without the rest of
the wiring. **Persisting the measured route onto the lead is an owner decision**
— routing calls are billed per request — and is deliberately not done here.

### The 133% bounce rate was still on the dashboard

Correcting `checkBounceRate` fixed the *alert*. `getOverview()` kept counting
`sent` off `EmailSend.createdAt` and bounces off `EmailEvent.occurredAt` — two
clocks, so a message sent before the window that bounced inside it landed in the
numerator and not the denominator. The owner could fix the alert, open the
screen, and read 133% there instead. **The complaint rate, which nobody had
looked at, had the identical flaw.** All three rates now come from one cohort
anchored on `sentAt`.

### Admin date filters used the wrong clock

`new Date(from + 'T00:00:00')` has no zone designator, so it parsed in the
**server's** local time. The server runs in UTC, the business runs in Eastern —
"from the 5th" began at 8 PM on the 4th, and an evening lead was filed under the
wrong day. Scheduling had the confident version, `'T00:00:00Z'`, which ends the
day at 8 PM Eastern and drops evening jobs. Neither validated, so `?from=lol`
reached Prisma as an Invalid Date and 500'd an admin page.

There is now one DST-correct helper (a 23-hour and a 25-hour day are both
tested), half-open so the final second isn't lost, which drops a bound it cannot
read rather than throwing.

### Five tests that passed without testing anything

When source is edited through a tool that expands escapes, `\b` in a regex
becomes a literal 0x08. The regex still compiles — it stops meaning "word
boundary" and starts meaning "the backspace character", which appears in nothing.

`src/emails/__tests__/brand.test.ts` had **nineteen** of them. The banned-word
guards (*cleanout*, *junk removal*, *limpieza*, *basura*), the
unverifiable-claim-count guards and the legal-claim guards (*"licensed and
insured"*, *"fully insured"*, *"we will drive"*) were all dead — honesty rules on
copy that goes to customers. Repaired; the properties genuinely hold.

A new guard reads the bytes of every tracked source file. On its first run it
found a **fifth** instance in shipped code — `app/api/service-area/check/route.ts`,
where a control-character class had expanded into raw bytes including a NUL,
making a live route binary to git. Semantics there survived, and that is proven
by comparing both classes across 768 code points. Then the guard failed on **its
own file**, because the comment describing the finding contained the very bytes
it described — which is the clearest demonstration available that a reviewer
cannot catch this and a machine must.

### Dependencies: 5 findings → 1

`postcss@8.4.31` was pinned **nested under next**, so the top-level `^8.4.39`
never reached it. `prismjs@1.29.0` arrived under `@react-email/code-block`. Both
fixes are inside the same major, so targeted `overrides` take them with no
breaking change and no `--force`. That removed one HIGH and all three MODERATEs.
Verified through a real `npm ci`, the full suite and a production build — postcss
sits in the CSS pipeline, where a silent break is a broken stylesheet rather than
a failed test.

---

## Migration safety, measured

`CREATE UNIQUE INDEX` (not `CONCURRENTLY`) takes a **ShareLock**: reads continue,
writes wait. Measured against real PostgreSQL, worst case (every row inside the
partial predicate):

| Open rows | Build time |
|---|---|
| 10,000 | 9 ms |
| 100,000 | 71 ms |
| 500,000 | ~350 ms *(extrapolated)* |
| 1,000,000 | ~700 ms *(extrapolated)* |

Proven, not assumed: with the lock held open, a concurrent reader succeeded and a
concurrent writer hit `lock_timeout`. **This is a write pause measured in
milliseconds, not a site outage.**

The migration **can still fail**, and that is correct: if production already
holds open duplicates, `CREATE UNIQUE INDEX` aborts and the migration does not
apply. Deciding which half of a split customer survives is a business call.

- **Pre-deploy:** run `scripts/lead-session-duplicate-preflight.sql`, which
  carries the reviewed close-don't-delete procedure.
- **Never** run `prisma db push` or `prisma migrate dev` against production —
  either would drop the partial unique index *and* the marketing tracker's
  separate `leads` table.

---

## Deploy order, once the blockers clear

1. Run the duplicate preflight. Resolve any open duplicates by closing, not
   deleting.
2. Take a backup and **restore it somewhere** — per B3, that round-trip has not
   been rehearsed on tooling that can do it.
3. `prisma migrate deploy` (4 additive migrations).
4. Confirm `crm_leads_open_booking_session_key` exists; `schema-drift.test.ts`
   asserts exactly this against a live database.
5. Deploy the app. Schedule `sweepLeadNotifications`.
6. Alert on `leadNotificationHealth().oldestPendingMs` and on `terminal > 0` —
   a parked notice means the owner was never told about a lead.

## Rollback

Every migration is additive; none drops a column or writes a row. The index
reverses with:

```sql
DROP INDEX IF EXISTS "crm_leads_open_booking_session_key";
```

Dropping it restores the duplicate-lead race, so it is a rollback of last resort
rather than a routine step.

---

## Known limits of this verification

- **Production was never inspected.** Table sizes, the real open-duplicate count,
  and the live `EMAIL_PROMOTIONS_ENABLED` value are unknown to me. The lock
  budget above is measured locally and extrapolated; substitute the real row
  count to get the real number.
- **The Discord canary is NOT RUN** (B4). Delivery is proven against a local
  receiver, not the Discord API.
- **The backup script round-trip is NOT RUN** (B3).
- **`true-e2e-browser-to-postgres`** requires `WMIWCI_SITE_DIR`; it is included
  and passing in the enforced suite runs above, and skips without it.
