# Stage 3 staging plan

## BLOCKING DEPENDENCY (unchanged from Stage 2)

```
npx prisma migrate status
ERROR: Your account or project has exceeded the compute time quota.
```

**DATABASE UNAVAILABLE.** Stage 1, Stage 2 and Stage 3 migrations are ALL
unapplied. No stage has been verified against real persistence.

## Deployment order

1. Restore Neon compute.
2. Back up / branch the database.
3. `npx prisma migrate status` — confirm actual state.
4. `npm run db:migrate:prod` applies, in order:
   - `20260720000100_phase1_jobcrew_labor`
   - `20260720000200_phase2_financial_closeout`
   - `20260720000300_stage3_reporting_analytics`
5. `npx prisma generate`, deploy.
6. Configure: overhead method/rate, tax reserve %, receipt threshold, ownership
   split, staff pay rates. Create marketing campaigns and record their spend.
7. Walk the Stage 1, Stage 2, then Stage 3 scenarios.

## Stage 3 verification

`npx tsx scripts/stage3-evidence.ts` covers the offline math. Against the
database, additionally verify:

1. A monthly report total equals the sum of its snapshots.
2. A provisional move is excluded from FINALIZED_ONLY and disclosed in COMBINED.
3. A door-hanger campaign reports cost-per-lead and both ROAS figures.
4. A 6h-estimated / 10h-actual move flags labor and duration variance.
5. A repeat customer shows realized lifetime value net of acquisition cost.
6. A CSV/XLSX export of a note starting `=HYPERLINK(` opens inert in Excel.
7. Action Center: five conditions appear once, and clear when fixed.
8. A pricing query with 2 comparables returns INSUFFICIENT and no price.

## Rollback

- **Application rollback (preferred).** Every Stage 3 table is NEW and every
  Booking column is nullable, so prior code is unaffected. No data lost.
- **Hide reporting only:** remove the report routes/pages; the modules are pure
  and side-effect free.
- **Schema rollback NOT recommended.** Dropping `marketing_campaigns` /
  `marketing_spend` destroys campaign cost history that cannot be reconstructed.
  Export first. There is deliberately no down-migration.
