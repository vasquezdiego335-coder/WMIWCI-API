# Stage 3B — Reporting UI, routes and database gate

**Owner spec 2026-07-20. Branch `claude/admin-stage3b-reporting-ui-staging`,
built on Stage 3 (`claude/admin-stage3-reporting-analytics`, commit f52e7f90).**

## Database gate result: DATABASE UNAVAILABLE

```
npx prisma migrate status
ERROR: Your account or project has exceeded the compute time quota.
```

No alternative database exists in this environment (no local PostgreSQL, no
Docker, nothing listening on 5432). Therefore:

- Stage 1, Stage 2 and Stage 3 migrations remain **UNAPPLIED**.
- **No persistence has been verified** for any stage.
- Every database-backed feature below is **built but unverified**.
- The verdict stays below staging-ready, exactly as the spec requires.

## What Stage 3B added

| Layer | Files |
| --- | --- |
| Request validation | `reporting-filters.ts` — Zod-validated params, period resolution, metadata contract |
| Prisma bridge | `reporting-service.ts` — the only reporting module that reads the DB |
| Report shaping | `report-builders.ts` — one builder per report, feeding BOTH screen and export |
| Access control | `report-permissions.ts` — report access, export access, response shaping, column sets |
| API | `/api/admin/reports/[report]`, `/api/admin/reports/export` |
| Pages | `/admin/reports` + 7 sub-reports |

## The rules the UI enforces

1. **Every page shows a basis strip** above its numbers: period, accounting
   basis, reporting mode, timezone and the finalized/provisional/unusable counts.
2. **`$0.00` and "no verified data" never look the same.** `dataStateFor()`
   distinguishes EMPTY, NO_VERIFIED_DATA and UNAVAILABLE, and each renders
   differently.
3. **Owner-only money is stripped server-side** by `shapeForRole()` before the
   JSON is serialized — hiding a column in the UI is not a control.
4. **Profit/loss is never signalled by colour alone**; a negative figure carries
   the word "(loss)".
5. **A failed report returns 503 with `dataState: UNAVAILABLE`**, never zeros.

## Query strategy (per spec §30)

- **Snapshot aggregation** — finalized moves read `FinancialSnapshot`, never recalculated.
- **Application aggregation** — provisional moves run the Stage 2 closeout math,
  capped at `MAX_PROVISIONAL_RECOMPUTE` (300) with the truncation disclosed.
- **Database aggregation** — counts, lead groups and marketing spend use `groupBy`/`_sum`.
- Repeat-customer detection is one `groupBy`, not a per-row query (no N+1).
- Hard scan cap `MAX_REPORT_ROWS` (5,000); custom ranges capped at 800 days.
- **No caching** — every figure is computed from current rows.

## Known limitations

- **No database verification of anything.** See the gate result above.
- **No database-backed integration tests.** The route tests are contract tests
  over the pure predicates the routes call.
- Action Center reporting rules are computed and exportable but the Action Center
  **persistence workflow** (writing candidates into `Reminder` via reminder-sync)
  is not wired in this branch.
- PDF export is not implemented; CSV and XLSX are.
- ACCOUNTANT / CREW_LEADER / READ_ONLY roles are still not in `UserRole`.
- Crew-efficiency analytics and saved-view CRUD are not built.
- Charts are not implemented — tables and cards only.
