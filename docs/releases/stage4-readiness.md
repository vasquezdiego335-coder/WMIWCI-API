# Stage 4 readiness

**Assessed 2026-07-21, branch `claude/admin-stage3b-reporting-ui-staging` @ `6d408abd`.**

## Verdict

```
STAGE 0-3 COMPLETE — PRODUCTION DEPLOYMENT REQUIRED
```

Every Stage 0-3 **code** task is finished. Two gates remain, and both need owner
credentials that do not exist in this environment.

## Checklist

| Requirement | Status | Evidence |
| --- | --- | --- |
| PR #15 conflict-free | **PASS** | `origin/main` fully contained in HEAD; merge `6d408abd`; fast-forwardable |
| Stage 0-3 tests passing | **PASS** | `npm test` 887/887, 0 fail, 0 skipped |
| Stage 0-3 build passing | **PASS** | `npm run build` exit 0 |
| TypeScript clean | **PASS** | `npx tsc --noEmit` 0 errors |
| Staging migrations applied | **PASS** | 33/33, "Database schema is up to date!" |
| Staging DB invariants | **PASS** | 13/13 post-merge checks; 26/26 integration tests |
| Payment-route correction | **PASS** | Applied + 9 regression tests |
| No unresolved P0/P1 | **PASS** | P0, P1-1..P1-4 all closed |
| Railway staging deployed | **BLOCKED** | No staging Stripe/auth secrets — see below |
| Browser smoke tests | **BLOCKED** | Requires a deployed staging app |
| Permission tests (live) | **BLOCKED** | Requires a deployed staging app |
| Export security (live) | **BLOCKED** | Requires a deployed staging app |
| Rollback rehearsal (live) | **BLOCKED** | Requires a deployed staging app |
| Production runbook | **PASS** | `docs/releases/stage0-3-production-runbook.md` |

## The blocker, precisely

Railway CLI v5.17.0 is installed and authenticated as the owner, and 9 projects
are visible. Staging deployment still cannot proceed because:

1. **No staging Stripe test key, no staging webhook secret, no staging
   `NEXTAUTH_SECRET`.** The task's own constraint forbids production Stripe
   credentials in staging. Duplicating the production Railway environment would
   copy exactly those production secrets, so doing it would violate the
   constraint rather than satisfy it.
2. **The Railway project is not linked and the CLI is non-interactive here** —
   `railway environment` returns "Environment must be specified when not running
   in a terminal", and the 9 projects carry generated names with no reliable way
   to identify the API service without owner confirmation.

Creating an environment under those conditions risks deploying against
production Stripe or against the production database. That is a destructive
production decision, so it stops here for owner action.

## What the owner must do

1. Confirm which Railway project is the WMIWCI-API service.
2. Create a `staging` environment on branch
   `claude/admin-stage3b-reporting-ui-staging` with pre-deploy
   `npx prisma migrate deploy`, and set:
   - `DATABASE_URL` -> the staging Neon database (already fully migrated)
   - `APP_URL` / `NEXTAUTH_URL` -> the Railway staging URL
   - `NEXTAUTH_SECRET` -> a staging-only secret
   - `STRIPE_SECRET_KEY` -> a Stripe **test** key
   - `STRIPE_WEBHOOK_SECRET` -> the staging webhook secret
3. Run the §11-§14 smoke, permission, export and rollback tests from the release
   spec against the Railway staging URL.
4. Then follow `stage0-3-production-runbook.md`.
5. Separately: delete the duplicate Vercel projects `wmiwci-core` and
   `wmiwci-server` after confirming no required domain/storage/env lives only
   there. **Keep `wmiwci-site`.**

## What is already proven without a deployed app

The staging Neon database is fully migrated and was verified directly:

- All 5 release migrations plus main's 5 email migrations applied; status clean.
- 26/26 real-database integration tests: crew assignment, frozen rate snapshots,
  duplicate-assignment rejection, partial + final labor payments, negative
  payment refused by CHECK, **a profile rate change proven not to rewrite
  history**, closeout creation, duplicate-closeout rejection, snapshot
  versioning, **duplicate version rejected (the finalize race, at the
  database)**, reopen-supersedes-not-replaces, overpayment refused by CHECK,
  **booking deletion blocked with financial history intact**, campaign + spend +
  ROAS aggregation, saved-view CRUD, and the new audit enum values.
- Business config: exactly one row, ownership totals 100.
- No financial record auto-finalized: 0 closeouts, 0 snapshots, 0 distributions.

What remains unproven is only what needs a running app: browser rendering,
session-based permission enforcement end to end, live export downloads, and the
application-rollback rehearsal.

## Stage 4 gate

Do not begin Stage 4 until production deployment completes and the production
smoke test in the runbook passes. At that point this document should be updated
to `PRODUCTION DEPLOYED — READY TO BEGIN STAGE 4`.
