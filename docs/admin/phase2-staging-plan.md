# Phase 2 staging plan

## BLOCKING DEPENDENCY

**Neither the Phase 1 nor the Phase 2 migration has been applied.** The Neon
database (`ep-polished-poetry-aq6tbdtp`) returns:

```
ERROR: Your account or project has exceeded the compute time quota.
```

Phase 1 staging was therefore never run. Both phases are code-complete and
verified offline, and **unverified against a real database.** Restore database
access before anything below.

## Deployment order

1. Restore Neon compute (upgrade plan or wait for the quota to reset).
2. **Back up / branch the database.**
3. `npx prisma migrate status` - confirm what is actually applied.
4. `npm run db:migrate:prod` - applies, in order:
   - `20260720000100_phase1_jobcrew_labor`
   - `20260720000200_phase2_financial_closeout`
5. `npx prisma generate`, deploy the app.
6. Set staff pay rates, then `BusinessConfig`: overhead method + rate, tax
   reserve %, receipt threshold, ownership split.
7. Walk the Phase 1 scenarios (`phase1-staging-plan.md`), THEN Phase 2.

## Phase 2 verification (synthetic data only)

`npx tsx scripts/phase2-evidence.ts` covers the offline math. In the UI:

1. Profitable move -> finalize -> snapshot v1 exists.
2. Outstanding balance -> finalize blocked -> write off with a reason -> allowed.
3. $200 refund on $2,000 -> net collected $1,800, deducted once.
4. Owner-paid $150 expense -> distributable held back -> reimburse -> released.
5. Owner unpaid labor -> cash profit and economic profit differ.
6. Loss -> $0 reserves, $0 distributable, distribution refused.
7. Finalize, reopen with a reason, add a toll, finalize -> v2, v1 superseded.
8. Manager attempts finalize / override / split / distribution -> 403 each.

## Rollback

- **Application rollback (preferred).** Redeploy the previous build. Every Phase 2
  table is NEW and every `business_config` column is defaulted, so prior code is
  unaffected. **No data lost, no migration reversed.**
- **Hide the UI only.** Remove the `FinancialCloseoutPanel` render from the job
  page; routes remain for API use.
- **Schema rollback is NOT recommended.** Dropping `financial_snapshots` destroys
  the immutable history that is the entire point of this phase. Export
  `move_closeouts`, `financial_snapshots`, `reserve_allocations` and
  `owner_distributions` first. There is deliberately no down-migration.
