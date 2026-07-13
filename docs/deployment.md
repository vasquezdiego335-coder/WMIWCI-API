# Admin OS deployment runbook (increment 2.1)

Owner-run. Nothing here is automated. Migrations are additive and DO-block
guarded (safe to re-run), but always take a restore point first.

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
