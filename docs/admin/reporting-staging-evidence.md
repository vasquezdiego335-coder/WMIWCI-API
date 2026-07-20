# Reporting staging evidence

## Database-backed evidence: NONE

The Neon project is over its compute quota and no alternative database exists in
this environment. **No staging scenario has been executed against real
persistence for Stage 1, Stage 2 or Stage 3.**

What that means concretely — none of the following are verified:

- migrations apply cleanly, in order, on a real database
- crew assignments, hours, rate snapshots persist
- closeout blockers behave against stored rows
- finalized snapshots are immutable in the database
- attribution columns persist and first-touch resists overwrite
- Action Center rows dedupe and auto-resolve across scans
- exports produce a file end-to-end through the route
- reporting pages render real data

## Offline evidence that DOES exist

| Evidence | Command | Result |
| --- | --- | --- |
| Unit + contract tests | `npm test` | 608/608 pass |
| Stage 3 scenarios (synthetic) | `npx tsx scripts/stage3-evidence.ts` | 8/8 pass |
| Stage 2 scenarios (synthetic) | `npx tsx scripts/phase2-evidence.ts` | 8/8 pass |
| Stage 1 scenarios (synthetic) | `npx tsx scripts/phase1-evidence.ts` | 8/8 pass |
| Phase 0 scenarios (synthetic) | `npx tsx scripts/phase0-evidence.ts` | pass |
| Types | `npx tsc --noEmit` | 0 errors in tracked code |
| Schema | `npx prisma validate` | valid |
| Build | `npm run build` | all 7 pages + 2 API routes registered |

## Restoring the staging database

1. Open the Neon console for project `ep-polished-poetry-aq6tbdtp`.
2. Either upgrade the plan or wait for the compute quota to reset.
3. **Create a dedicated staging branch** in Neon — do not verify against production.
4. Point `DATABASE_URL` and `SHADOW_DATABASE_URL` at that branch.
5. `npx prisma migrate status` — expect three pending migrations.
6. Apply them one at a time, verifying between each:
   - `20260720000100_phase1_jobcrew_labor` → run the Stage 1 checks
   - `20260720000200_phase2_financial_closeout` → run the Stage 2 checks
   - `20260720000300_stage3_reporting_analytics` → run the Stage 3 checks
7. `npx prisma generate`, deploy, then walk the scenarios in
   `phase1-staging-plan.md`, `phase2-staging-plan.md`, `stage3-staging-plan.md`.
