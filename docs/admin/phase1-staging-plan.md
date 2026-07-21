# Phase 1 staging plan

## Deployment order

1. **Back up the database** (Neon branch/snapshot). The migration is additive,
   but it adds CHECK constraints — take the snapshot anyway.
2. **Merge or rebase.** `prisma/schema.prisma` is also touched by the unmerged
   `claude/frosty-feynman-d7161d` (crew gig board); the two are additive and
   mergeable in either order.
3. `npx prisma validate` — must pass.
4. `npm run db:migrate:prod` (`prisma migrate deploy`) — applies
   `20260720000100_phase1_jobcrew_labor`:
   - 8 enums, 16 audit actions, ~60 `job_crew` columns, 2 `users` columns,
     4 `business_config` columns, the `labor_payments` table, 10 indexes,
     7 CHECK constraints.
   - Backfills: `worker_type='OWNER'` for OWNER users · `role='CREW_LEADER'` for
     existing `crew_leader` rows · minutes from legacy Float hours · **rate
     snapshots frozen from existing `pay_rate` / `flat_pay`** ·
     `approval_status='APPROVED'` for rows already PAY_APPROVED/PAID.
5. `npx prisma generate`, then deploy the app.
6. **Set pay rates on staff profiles** before assigning anyone.
7. Optionally set `owner_economic_rate_cents` (default $30/h).

## Verification on staging (synthetic data only)

`npx tsx scripts/phase1-evidence.ts` covers the offline math. Then, in the UI:

1. Assign an hourly helper → the chip reads "rate locked".
2. Clock in → break → clock out → minutes and overtime are correct.
3. Submit → approve **as the other owner** → profit changes only now.
4. Record a partial payment → remaining owed shown, status PARTIALLY_PAID.
5. Safe-to-distribute is unchanged by that payment.
6. Change the worker's profile rate → the move's cost does **not** move.
7. Assign an owner as `UNPAID_OWNER` → cash vs economic profit both shown.
8. Try to approve your own labor → 403.

## Rollback

The workflow can be disabled **without losing any labor record**:

- **Application rollback (preferred).** Redeploy the previous build. Every Phase 1
  column is additive and nullable/defaulted, and `labor-service.recalcAssignment`
  keeps the legacy `pay_status` / `actual_hours` mirrors in sync, so pre-Phase-1
  dashboards read correctly. **No data lost, no migration reversed.**
- **Hide the UI only.** Remove the `CrewLaborPanel` render from the job page; the
  routes stay available.
- **Full schema rollback is NOT recommended.** Dropping the columns destroys every
  recorded hour, rate snapshot and payment. If unavoidable, export `job_crew` and
  `labor_payments` first. There is deliberately no down-migration: financial
  history should not be silently removable.
