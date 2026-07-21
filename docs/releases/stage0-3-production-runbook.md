# Stage 0-3 production runbook

**Platform of record: Railway (API) + Neon (PostgreSQL).**
Vercel is NOT the API platform — see §0.
**Last verified: 2026-07-21 against Railway staging DB `ep-gentle-fire-…`.**

---

## 0. Deployment platform correction

```
GitHub repo  ->  Railway API service   (REAL)
Neon Postgres ->  database             (REAL)
Vercel API projects                    (DUPLICATES — ignore)
```

`wmiwci-core` and `wmiwci-server` are duplicate Vercel projects connected to
`WMIWCI-API`. They serve an outdated booking-lookup page still carrying the
retired slogan "WE MOVE IT. WE CLEAR IT." **A green Vercel preview is not
evidence that the Railway API works** and must never be used as release
evidence, staging, or deployment approval.

`wmiwci-site` is a different project, connected to the customer-facing
`WMIWCI-SITE` repo. **Do not delete it.**

Owner action: delete `wmiwci-core` and `wmiwci-server` in Vercel after
confirming each has no required custom domain, storage, or unique environment
variable.

## 1. Before production

1. Approve and merge **PR #15** (`claude/admin-stage3b-reporting-ui-staging` -> `main`).
2. Confirm `main` contains the merge commit: `git log --oneline -3 main`.
3. **Create a production Neon backup** (branch or `pg_dump -Fc`). Verify it restores.
4. Record the current production Railway deployment commit — this is the
   rollback target. Write it down before deploying.
5. Record current production migration status (§2).
6. Confirm `business_config` exists in production with splits totalling 100.
7. Confirm Railway production environment variables are present and are
   PRODUCTION values (not the staging Neon URL).

## 2. Production database commands

Only these four, in this order:

```bash
npx prisma migrate status     # BEFORE — record what is already applied
npx prisma migrate deploy     # applies ONLY pending migrations
npx prisma migrate status     # AFTER — expect "up to date"
npx prisma generate
```

**Never** run `prisma migrate dev`, `prisma db push`, or `prisma migrate reset`
against production. Never hand-execute migration SQL. Never re-run an applied
migration.

### Expected pending set

Production received the three Stage 1-3 migrations on 2026-07-21 (accidentally,
via a Windows `cmd.exe` invocation where the inline `DATABASE_URL=` prefix
silently failed and fell through to `.env`). It has **not** received:

```
20260721000100_protect_financial_history
20260721000200_saved_view_audit_actions
```

plus whichever email-lifecycle migrations from `main` are still outstanding.
**Confirm with `migrate status` — do not assume this list.**

Note a real collision to be aware of: `20260720000100_email_lifecycle` and
`20260720000100_phase1_jobcrew_labor` share a timestamp prefix. Prisma orders by
full directory name, so `email_lifecycle` sorts first. They touch disjoint
tables, so order is harmless here — but a future migration must not reuse a
timestamp.

## 3. Railway production deployment

1. Railway production environment stays on branch `main`.
2. Pre-deploy command must be **`npx prisma migrate deploy`** — never `db push`.
3. Deploy merged `main`.
4. Confirm the exact deployed commit in the Railway deployment log.
5. Monitor build logs.
6. Monitor startup logs (Prisma client init, Redis, Stripe).
7. Monitor Prisma/database errors — especially `column ... does not exist`,
   which would mean a migration did not apply.
8. Monitor authentication errors.
9. Monitor payment-route errors.
10. Monitor report-route errors and query latency.

## 4. Post-deploy verification (SQL)

```sql
-- The P0 this whole audit existed for
SELECT table_name, column_name FROM information_schema.columns
WHERE column_name ILIKE 'amount%cents'
  AND table_name IN ('labor_payments','reserve_allocations','marketing_spend');
-- all three must read amount_cents

-- P1-2: financial history protection ('r' = RESTRICT)
SELECT confdeltype FROM pg_constraint WHERE conname='move_closeouts_booking_id_fkey';

-- P1-3: saved-view audit values (expect 6)
SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
WHERE t.typname='AuditAction' AND enumlabel LIKE 'SAVED_VIEW%';

-- Config must exist exactly once and total 100
SELECT count(*), max(diego_split_percent + sebastian_split_percent) FROM business_config;
```

## 5. Controlled production smoke test

Use an internal account and synthetic records. **No real charge. No customer
email.**

- Admin login (owner)
- Existing bookings list loads
- A booking detail page loads
- Payment page loads
- Labor page loads
- Closeout page loads
- Reports: Overview, P&L, Move Profitability, Marketing
- Saved view: create, apply, delete
- CSV export downloads and matches the screen
- A manager account is denied profit fields
- A crew account is denied reports entirely
- Logs clean

## 6. Rollback

Rollback is **application-only**. The migrations are additive: no `DROP`,
`TRUNCATE`, `DELETE` or `ALTER COLUMN`, every new column nullable or defaulted,
so the previous build runs unchanged against the new schema.

1. Redeploy the previous Railway application commit (recorded in §1.4).
2. **Leave all migrations in place.**
3. Disable new navigation entries if they linger.
4. Preserve financial history — never drop `financial_snapshots`,
   `labor_payments`, `owner_distributions`, `marketing_spend`,
   `saved_report_views`, or `job_crew` rate snapshots. Those records exist
   nowhere else and cannot be recomputed.
5. Diagnose before redeploying.
