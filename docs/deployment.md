# Admin OS deployment runbook (increment 2.1)

Owner-run. Nothing here is automated. Migrations are additive and DO-block
guarded (safe to re-run), but always take a restore point first.

Steps 0–6 were written for increment 2.1. The **Pre-deploy verification**
section below applies to every deploy from this repo, including the Moving OS
branch (`claude/moving-os`), and runs *before* step 0.

---

## Pre-deploy verification (run this FIRST)

**Nothing runs tests for you.** There is no CI (`.github/` does not exist), no
git hook (`.git/hooks/` holds only `*.sample`), and no `pretest`/`prebuild`
lifecycle hook. Railway builds the admin service with
`npx prisma generate && npx next build` (`nixpacks.toml`) and starts
`npm run start`; migrations are deliberately not in the build. These commands
are the only gate between a broken branch and production.

Run them from the repo root, in this order, and **stop at the first failure**.

| # | Command | Proves | Stop if |
|---|---------|--------|---------|
| 1 | `npm run typecheck` | `tsc --noEmit` over the whole project, tests included | any error |
| 2 | `npm run test:moving-os` | every moving-OS correctness test file is green (`--list` prints the set) | `RESULT: FAIL` |
| 3 | `npx prisma migrate status`<br>`npm run db:preflight` | which migrations are pending (by name); DB reachable, no failed/in-progress migration, core tables present | preflight prints `RESULT: STOP` |
| 4 | Neon branch / restore point (**§0** below) | you can roll the database back | you have no restore point |
| 5 | `npm run db:migrate:prod` (= `npx prisma migrate deploy`, **§3**) | pending migrations applied | any SQL error → see Rollback |
| 6 | `npm run db:postcheck` (**§4**) | increment-2.1 objects queryable, core tables intact | `RESULT: FAIL` |
| 7 | merge + push (**§5**), then `npm run smoke:admin` (**§6**) | the deployed app answers | smoke fails |

```
npm run typecheck
npm run test:moving-os        # standalone: node scripts/test-moving-os.mjs
npx prisma migrate status     # read-only: lists PENDING migrations by name
npm run db:preflight          # read-only
#   → take the Neon branch / restore point (§0)
npm run db:migrate:prod       # = npx prisma migrate deploy  (§3)
npm run db:postcheck          # read-only  (§4)
#   → merge + push (§5), Railway auto-deploys
npm run smoke:admin           # (§6)
```

Steps 1–3 are safe to run any time: they mutate nothing. Steps 1 and 2 touch no
database and no network at all.

If `npm run test:moving-os` reports a missing script, the npm alias has not been
added to `package.json` yet — run `node scripts/test-moving-os.mjs` instead. The
runner is standalone and needs no npm script.

### The moving-OS gate (step 2)

`scripts/test-moving-os.mjs` runs **only** the moving-OS correctness tests, so a
new regression cannot hide inside the known-red baseline (see below). The file
list lives in ONE place — the `MOVING_OS_TESTS` array in that script.

```
node scripts/test-moving-os.mjs           # run the gate
node scripts/test-moving-os.mjs --list    # the current gate set, one path per line
node scripts/test-moving-os.mjs --audit   # gate size vs `npm test` vs *.test.ts on disk
```

**This document prints no test count.** An earlier revision typed the gate size
and the suite totals into prose, and both were wrong within days: it claimed the
gate was "16 files, 308 tests" when the array already listed 17 files, and it
gave a suite baseline of "2494 tests / 2476 pass" that was ~20 tests short by the
next review and further out by the one after. A number that only a human
re-measures rots silently, and this project has lost rounds to exactly that. So
every count now lives where it is recomputed: the gate's own summary line
(`files N   tests N   pass N   fail N`) is the authority on its size, and
`--audit` reads the `npm test` file count straight out of `package.json` instead
of repeating one. If you need a number for a deploy note, run the command and
paste what it printed, with the date you ran it.

- The gate grew during the P0 and hardening rounds and will keep growing;
  `--list` is always the current set. What matters is not its size but that
  `RESULT: PASS` is printed and the exit code is `0`.
- Exit codes: `0` all green · `1` a test failed (or the summary was unreadable —
  it says which) · `2` the list itself is broken (missing file, duplicate, or a
  known-red baseline file smuggled into the list) and **nothing was run**.
- The existence check is deliberate: a previous pass listed a filename that did
  not exist, which would have silently shrunk the suite. A bad path now fails
  before any test runs.
- Offline by design. The tests that need Prisma install a fake client on
  `globalThis` before `src/lib/db.ts` is first imported. Keep it that way: there
  is no init migration in `prisma/migrations` (nothing creates the `bookings`
  table), so no CI job could provision a database from this repo anyway.
- **Adding a test:** append it to `MOVING_OS_TESTS` in the same change that
  creates the file. Nothing discovers tests automatically — a moving-OS test that
  is not in the array is not gated, however green it is. A file is gate-eligible
  when it is (a) offline, (b) green today, and (c) not one of the known-red
  baseline files below. Existing green tests for a module a P0/hardening item
  touched belong in the array too: six such files (`booking-approval`,
  `scan-lock`, `booking-display`, `scheduling-guards`, `reminder-rules`,
  `conflict-engine`) sat outside it after the P0 round and were added in the
  hardening round.

Scope, stated plainly: passing this gate means *the listed files* are green. It
is not a statement about the rest of `npm test`, and it is not a statement about
anything untested.

### Known baseline failures — do NOT fix here

`npm test` (the full file-by-file script in `package.json`) is **red on this
branch before you change anything**. The failures live in exactly **8 files** and
are **four unrelated problems**, none of them moving-OS correctness.

The per-file counts below are the load-bearing fact, and they are the same list
the gate carries in code (`BASELINE_FAILING_FILES` in
`scripts/test-moving-os.mjs`, which the runner refuses to start if any of them is
smuggled into the gate). The **18** in "still 18" is the sum of the Fails column
— add it up rather than trusting the sentence. Suite-wide totals (how many tests
`npm test` runs in all, how many pass) are deliberately not printed here: they
change every time anyone adds a test, and a stale total is worse than none. Run
`npm test` and read its tail if you need them.

| Group | Files | Fails | What it actually is |
|-------|-------|-------|---------------------|
| a. Stale price constant *in this repo* | `estimate.test.ts` (5), `pricing-config.test.ts` (2) | 7 | The tests hard-code a 1BR base of **$649**; `src/lib/pricing-config.ts` says **$550**. Server math and the price book agree with each other — the loop at `estimate.test.ts:17-19` asserting `MOVE_SIZES[k].price === PACKAGES[k].price.amount` clears for every package, and the same test then fails on line 20's typed-in `649`. Only the test constants are stale. `pricing-config.ts` values are frozen, so this is a test-side defect. |
| b. Sibling-site mirror drift | `pricing-parity.test.ts` (1), `pricing-browser-parity.test.ts` (2), `pricing-truck-parity.test.ts` (2), `services-page-parity.test.ts` (4) | 9 | Compare against the generated mirror in the separate site repo (`C:/WMIWCI-SITE`), which has drifted. Their `existsSync` skip guards do not fire because those files are present. |
| c. Site HTML content | `booking-access-review.test.ts` (1) | 1 | `pricing.html` in the site repo no longer carries the `booking-form.html?size=…` package preselect links. |
| d. Missing generated artifact | `email-lifecycle.test.ts` (1) | 1 | Reads `email-previews/quote-request-received.html`, which is gitignored and only exists after `npm run preview:emails`. Environment-dependent, not a parity check. |

**Correction to the round-3 note** (`docs/moving-os-phase1-fixes-round3.md`),
which described all ~18 as pricing-parity drift: only group (b), 9 of 18, is
that. Writing off all 18 as "known parity drift" buries three other kinds of rot.

How to read a run of `npm test`: **"still 18, same 8 files" is the baseline.**
Anything else — a 19th failure, or a failure in a file not listed above — is new
and must be understood before deploying. None of these 8 files is in the
moving-OS gate; the runner refuses to start if one is added to its list, so
"a gate failure is a new regression" is checked rather than claimed.

This composition — which files fail, how many in each, and why — was last
re-confirmed against a real run on **2026-08-14** (the same date the gate carries
in `BASELINE_CONFIRMED`; keep the two in step). Two full runs that afternoon
reported different suite totals minutes apart because tests were being added in
parallel, while the failing set was identical both times. That is the whole
argument for pinning the failing *set* here and looking the totals up live.

Do **not** repair these here, and specifically do not "fix" group (a) by editing
`src/lib/pricing-config.ts` — customer-facing pricing constants are frozen.

### What `db:preflight` and `db:postcheck` do NOT check

Both scripts were written for increment 2.1 and their expected-object lists were
never extended. Verified by reading them:

- `scripts/db-preflight.ts` expects `reminders`, `scan_runs`, `roadmap_items`,
  `expenses`, `owner_transactions`, `leads`, `business_config` (+ 5 enums), and
  hard-fails only on missing core tables.
- `scripts/db-postcheck.ts` checks the same increment-2.1 tables, three Prisma
  model counts, three indexes, and the core tables.

Neither verifies **any** object from the three Moving OS migrations. So
`db:postcheck` will print `RESULT: PASS — schema is consistent` with `trucks`,
`inventory_catalog_items`, `booking_inventory_items`, `bookings.truck_id`,
`bookings.service_mode`, `bookings.staffing_plan` and `bookings.start_time_known`
all absent. **Read `npx prisma migrate status` for the migration answer** — a
`PASS` from postcheck is not evidence that a Moving OS migration landed.

(Extending those two expected-object arrays is a small, obvious follow-up; until
someone does it, do not report "migration verified" on the strength of step 6.)

### Moving OS migrations in this branch

Hand-applied, additive, `IF NOT EXISTS`-guarded, safe to re-run. Whether they
are applied to a given database is only knowable from `_prisma_migrations` —
ask `npx prisma migrate status`, not this document.

| Migration | Adds |
|-----------|------|
| `20260811000000_moving_os_phase1` | enum `TruckStatus`; tables `trucks`, `inventory_catalog_items`, `booking_inventory_items`; `bookings.truck_id`, `.price_override_reason`, `.origin_property_type`, `.dest_property_type`, `.service_mode`, `.coi_required`; AuditAction `TRUCK_CREATED`/`TRUCK_UPDATED` |
| `20260812000000_staffing_plan` | `bookings.staffing_plan` (JSONB, nullable) |
| `20260812010000_start_time_known` | `bookings.start_time_known` (BOOLEAN NOT NULL DEFAULT true) |

Apply them **before** the app that reads them deploys. Prisma expands `$scalars`
from the generated client, so a query that names no new column still throws
P2022 while the SQL is missing; the known code-before-SQL degradations are
tracked in `docs/moving-os-p0-review.md` § E.

### Environment: `CRON_SECRET` and the only automated money check (item R6)

`vercel.json` declares one schedule — `GET /api/admin/reconciliation`, daily at
13:00 UTC. That endpoint is **the only automated check that compares Stripe
against our own database**. It authenticates a scheduler with
`Authorization: Bearer $CRON_SECRET`, and the platform sends that header **only
when `CRON_SECRET` is set on the deployment**.

Until it is set, the schedule fires and is refused every day. State the cost
plainly, because a refused schedule and a clean day look identical from outside:

- **"Stripe captured the $49 and the app recorded no `Payment` row"** — detected
  by nothing. The customer's move-day balance stays $49 too high and the Action
  Center eventually asks the owner to collect it *again*.
- **"Booking `CONFIRMED`, hold never captured"** — detected by nothing. The
  authorization expires in ~7 days and the deposit is never collected.
- amount drift, duplicate payments, refund/dispute state mismatch — visible only
  to whoever remembers to run `npm run reconcile`.

Rules (in `src/lib/reconciliation.ts`, `isScheduledRunAuthorized`, unit-tested):
**≥16 characters**, no placeholder-shaped values (`REPLACE…`, `PASTE…`, `YOUR…`,
`TODO…`), and unset means scheduled access is impossible — never "everyone
passes". The owner session and `npm run reconcile` are unaffected.

Since this round a **refused scheduled run raises an ops alert** on the Discord
alerts channel (falling back to operations) rather than only logging —
`src/lib/scheduled-run-guard.ts`, throttled per process per reason. Delivery
needs `DISCORD_BOT_TOKEN` plus `DISCORD_CHANNEL_ALERTS` or
`DISCORD_CHANNEL_OPERATIONS`; without them the refusal is logged as an ERROR and
the alert result records that nothing was reached.

**This service deploys on Railway** (`nixpacks.toml`, §5 below), and
`vercel.json` crons **only run on Vercel**. So on the current target, setting
`CRON_SECRET` makes the endpoint *callable by a scheduler* — it does not create
one. Either add a scheduled job on the platform that actually runs this service
(same URL, same `Authorization` header), or accept that reconciliation is manual
and run `npm run reconcile` on a stated cadence. Do not record "the daily money
check is on" on the strength of the `crons` block alone; that block is exactly
the "presence != configuration" shape this project keeps losing rounds to.

Verify after deploy (a correct secret answers 200 with the report):
```
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://<admin-host>/api/admin/reconciliation
```
Full variable reference: `.env.example` → "SCHEDULED JOBS / CRON"; secret
generation: `DEPLOY.md` § 7.

### Backup: what `npm run backup` is and is not

`npm run backup` runs `bash scripts/backup-db.sh`, which needs **bash + pg_dump
on PATH** and `DATABASE_URL` set, and writes a local `.sql` dump. It is not the
step this runbook means at §0. **The restore target is the Neon branch /
restore point** — take that first; treat the dump as an optional extra.

### Build-time protection that already exists

`next.config.mjs` sets neither `typescript.ignoreBuildErrors` nor
`eslint.ignoreDuringBuilds`, and `tsconfig.json` includes `**/*.ts`, so
`next build` type-checks the whole project **including test files**. A type
error blocks the deploy — which is real protection, and also means a type error
in a test-only file will break the production build. Behavioural regressions are
not caught by the build at all; that is what step 2 is for.

---

## 0. Backup / restore point (Neon)
- In the Neon console, create a **branch** of the production database (e.g.
  `pre-2_1`) OR note the current LSN / restore point. This is the rollback
  target for the database.
- Record the current deployed Git commit on `main` (App rollback target):
  `git -C C:\WMIWCI-API rev-parse main`.

## 1. Fetch the branch
```
cd C:\WMIWCI-API
git fetch origin
git checkout admin-os-increment-2-1-hardening
git pull
```

## 2. Preflight (read-only — mutates nothing)
```
npm run db:preflight
```
Expect: connectivity OK, no IN-PROGRESS/FAILED migrations, core tables present.
The new tables (`reminders`, `scan_runs`, `roadmap_items`, …) may show
"MISSING (pending migration)" if increment 2 / 2.1 migrations aren't applied yet
— that is expected before step 3. **If preflight prints `RESULT: STOP`, do not
proceed** — resolve the reported issue first.

## 3. Apply migrations (against the prod URL)
```
npx prisma migrate deploy
```
This applies any pending increment-2 and increment-2.1 migrations. If a
migration errors, see **Rollback → Failed migration** below.

## 4. Postcheck (read-only)
```
npm run db:postcheck
```
Expect `RESULT: PASS` — new tables queryable, unique dedupe + entity indexes
present, core tables intact.

## 5. Merge + deploy the app
```
git checkout main
git merge admin-os-increment-2-1-hardening
git push origin main
```
Railway auto-deploys the admin service from `main`. The build runs
`prisma generate && next build` (migrations are NOT run in the build — you ran
them deliberately in step 3).

## 6. Smoke test
```
npm run smoke:admin
# optional HTTP auth-guard probes against the live admin:
SMOKE_BASE_URL=https://<your-admin-domain> npm run smoke:admin
```
Then the manual click-through (signed in as OWNER): Dashboard → Action Center
(reminders load before any scan; the scan-status line shows "last scan") →
Rescan now → assign/claim/snooze/resolve a reminder → open the DISMISSED filter
→ confirm "Dismiss permanently" is owner-only → Roadmap → Seed once → Seed again
(no duplicates) → edit + reject-with-reason an item → confirm bookings /
customers / jobs / payments / expenses still load → check Railway worker logs
show no new errors.

---

## Rollback

### App rollback (Railway)
Redeploy the previously recorded `main` commit (Railway dashboard → admin
service → Deployments → redeploy the prior build), or:
```
git checkout main
git revert --no-edit <merge_commit_sha>   # or reset to the recorded commit on a hotfix branch
git push origin main
```

### Database
Prisma **cannot** auto-roll-back an already-applied migration. The 2.1 changes
are additive (new tables + nullable columns), so leaving them in place is
harmless even if the app is rolled back — the old app simply ignores them.
If you must revert the schema, **switch the app's `DATABASE_URL` back to the
Neon branch/restore point** you created in step 0. Do not hand-drop tables on
the live branch.

### Failed migration (`P3018`)
1. Read the SQL error. The 2.1 migrations are idempotent, so the usual cause is
   an environment issue, not the SQL.
2. Mark the failed migration rolled back so deploy can retry:
   `npx prisma migrate resolve --rolled-back <migration_name>`
3. Fix the cause, then re-run `npx prisma migrate deploy`.

### Migration succeeded but the app build fails
The DB is ahead of the app — safe (additive). Fix the build on the branch, then
merge again. No data action needed.

### Railway deployed before the DB migration
The new pages query missing tables → runtime errors on `/admin/action-center`
and `/admin/roadmap` only (the rest of the app is unaffected). Apply the
migration (step 3) and the pages recover on the next request.

### Disabling scheduled scans
There is no scheduled scan wired in this increment (manual + page-load only), so
there is nothing to disable. If a future scheduled scan is added behind
`REMINDER_SCAN_ENABLED`, unset that env var on the worker service to stop it.
