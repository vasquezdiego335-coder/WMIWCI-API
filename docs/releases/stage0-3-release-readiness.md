# Stage 0-3 + P1 release readiness

**Branch:** `claude/admin-stage3b-reporting-ui-staging`
**Date:** 2026-07-21
**Verdict:** STAGING PASSED — PRODUCTION NOT DEPLOYED

---

## 1. What this release contains

14 commits, a clean linear chain, all verified present on the branch. Each stage
contains the one before it, so this merges as one coherent unit — no
cherry-picking required or recommended.

| Commit | Contents |
| --- | --- |
| `83841528` | Stage 0 — refund double-penalty, expense eligibility, paid labor in safe-to-distribute, missing-labor warnings |
| `7453a340` | Stage 1 — JobCrew labor & time tracking |
| `9099d4ff` | Stage 2 — closeout, immutable snapshots, overhead, reserves, splits, distributions |
| `f52e7f90` | Stage 3 — reporting, marketing profitability, variance, pricing, exports |
| `606bc27a` | Stage 3B — reporting UI, report + export routes |
| `ff5a97d1` | P0 — `@map("amount_cents")` on `LaborPayment` and `ReserveAllocation` |
| `e7075cdc` | P1-1 — marketing write path |
| `9973b7cd` | P1-2 — `ON DELETE RESTRICT` on the closeout FK |
| `5d488228` | P1-4 — friendly 409 on concurrent finalize |
| `15f25d46` | P1-3 — saved report views (superseded by `6f7e293b`) |
| `637a8507` | Database audit documentation |
| `6f7e293b` | P1-3 complete — CRUD, permissions, audit, UI |
| `e005f843` | Payment-route follow-up documentation |
| `7fa584dd` | Build fix — exclude email preview artifacts |

144 files changed, +22,070 / -262.

## 2. Validation results

| Command | Exit | Result |
| --- | --- | --- |
| `npx prisma validate` | 0 | Schema valid |
| `npx prisma generate` | 0 | Client generated |
| `npx tsc --noEmit` | 0 | **0 errors** (was 4) |
| `npm test` | 0 | **663/663 pass**, 0 fail, 0 skipped, 0 todo |
| `npm run build` | 0 | **Compiles and completes** (was failing) |
| `npm run lint` | n/a | **Not configured** — prompts interactively for ESLint setup, so not run |

Focused suites (money rules, refunds, expense eligibility, labor, payments,
completeness, closeout, finalize race, distributions, reporting, marketing,
pricing, saved views, exports, permissions): **446/446**.

Every added test file is registered in the `test` script and verified running —
the suite count moved 608 -> 628 -> 649 -> 663 as each was added. That script
enumerates files explicitly, so an unregistered test file silently never runs.

## 3. Build cleanup

`npm run build` previously failed at type-check:

```
./email-marketing-html/src-tsx/render-marketing-emails.tsx:6:27
Cannot find module '../src/emails/referral'
```

`email-marketing-html/` is generated review output (HTML previews plus a copy of
the generating script). Nothing under `app/` or `src/` imports it, it has no
`package.json`, and its relative imports only resolve from the script's original
location — so compiling it could only ever fail.

Corrections, both narrow and deliberate:

- `tsconfig.json` — excluded alongside `email-archive`, which was already
  excluded for exactly the same reason. No application code is excluded.
- `.gitignore` — `email-marketing-html/` and `email-marketing-html.zip` were
  untracked but **not ignored**, so they reached the build and would have broken
  CI and Railway for anyone. Local copies untouched on disk.

A throwaway tsconfig was used once to isolate the cause and was deleted; the
evidence above is the **normal repository build**.

## 4. Migration chain

28 migrations. Five are new in this release, applied in filename order:

```
20260720000100_phase1_jobcrew_labor
20260720000200_phase2_financial_closeout
20260720000300_stage3_reporting_analytics
20260721000100_protect_financial_history
20260721000200_saved_view_audit_actions
```

- **Zero destructive statements** across all five — no `DROP TABLE`,
  `DROP COLUMN`, `TRUNCATE`, `DELETE FROM` or `ALTER COLUMN`. The single
  `DROP CONSTRAINT IF EXISTS` in `protect_financial_history` re-adds the same FK
  with `RESTRICT` in the next statement: a swap, not a removal.
- Enum-only migration (`20260721000200`) uses `ADD VALUE IF NOT EXISTS` and does
  not consume a new value in the same transaction.
- Every new column is nullable or defaulted, so **old application code tolerates
  the schema** — this is what has kept production healthy while its app is behind.

## 5. Staging verification — REAL DATABASE

Neon PostgreSQL 17.10, endpoint `ep-gentle-fire-…` (staging; **not** the
production endpoint `ep-polished-poetry-…`). No credentials recorded here.

Data present before migrating: 55 bookings, 2 jobs, 2 users, 6 payments,
3 expenses, 0 job_crew.

### Preflight: CLEAR — 0 P0 blockers

All Stage 1 conflicts (duplicate assignments, invalid clock order, negative
hours/rates, orphan FKs) and all Stage 2 conflicts (refund > capture, unknown
partial refunds, negative money, unsupported expense statuses): **0**.
No new table, enum or column pre-existed.

The corrected migration-history condition proved itself: **0 blocking**,
**4 resolved rollbacks** correctly classified as informational. The original
`WHERE finished_at IS NULL` reported all four as blockers.

### Post-migration verification

| Check | Result |
| --- | --- |
| `amount_cents` on labor_payments / reserve_allocations / marketing_spend | **3/3 correct** — the P0 confirmed against a real database |
| New tables | 9/9 |
| CHECK constraints | 19 present |
| `move_closeouts_booking_id_fkey` delete rule | **RESTRICT** (was CASCADE) |
| `SAVED_VIEW_*` audit enum values | 6/6 |
| New enum types | 18/18 |
| Auto-finalized records | 0 closeouts, 0 snapshots, 0 distributions |
| Attribution seed | 5 preserved, 50 left NULL (stay UNKNOWN — never invented) |

### Integration tests: 26/26 against real PostgreSQL

Stage 1 — crew assignment, frozen rate snapshot, duplicate assignment blocked by
unique index, hours, approval, partial + final payment summing to $200.00,
negative payment refused by CHECK, **and a profile rate change proven not to
rewrite a historical assignment**.

Stage 2 — closeout create, duplicate closeout blocked, reserve allocation,
snapshot v1, **duplicate version rejected (the finalize race, confirmed at the
database)**, reopen supersedes rather than replaces, superseded v1 retains its
original profit, `paid_cents > approved_cents` refused by CHECK, **booking with a
closeout cannot be deleted and its financial history survived the attempt**.

Stage 3 — campaign, spend, spend aggregation for the ROAS denominator, saved
view create / round-trip / rename / share, and the new `SAVED_VIEW_SHARED` enum
value written to the audit log.

All synthetic rows torn down; `move_closeouts` back to 0.

## 6. Business configuration

Staging had **no `business_config` row** — closeout cannot function without one.
Seeded from the schema's own declared defaults, not guessed:

| Setting | Value |
| --- | --- |
| Ownership split | Diego 50 / Sebastian 50 = **100** |
| Tax reserve | 25% |
| Overhead method | NONE (no overhead silently applied to history) |
| General reserve | 0 bp |
| Receipt required above | $25.00 |

**Production must be checked for this row before deploying.**

## 7. Known limitations

1. **Not deployed anywhere.** No staging app deployment was performed — no
   staging Railway environment or credentials were available in this session.
   The verification above is database-level and offline-suite level.
2. **No UI smoke test.** The saved-view, closeout and reporting screens have not
   been exercised in a browser against the migrated database.
3. **Production is split-state**: its database has Stage 1-3 (applied
   accidentally on 2026-07-21 via a Windows `cmd.exe` invocation where the inline
   `DATABASE_URL=` prefix silently failed and fell through to `.env`), while its
   application is still `main`. Additive-only migrations are why nothing broke.
   Production has **not** received `20260721000100` or `20260721000200`.
4. **Payment-route follow-up open** — see
   `docs/follow-ups/payment-route-stripe-cleanup.md`. Requires human review.
5. **`npm run lint` unconfigured.**
6. **Marketing attribution backfill** — historical booking sources were not
   rewritten (deliberate). Expect UNKNOWN and case-variant buckets initially.

## 8. Rollback readiness

All migrations are additive, so **the correct rollback is an application
rollback, leaving the schema in place**. Verified properties:

- No existing column removed, retyped, or made NOT NULL
- No existing enum value removed
- Every new column nullable or defaulted
- Old code never references the new tables

Levels: (1) hide the Reports sidebar item, (2) remove reporting pages,
(3) remove reporting API routes, (4) redeploy the previous build.

**Never** drop `financial_snapshots`, `labor_payments`, `owner_distributions`,
`marketing_spend`, `saved_report_views`, or `job_crew` rate snapshots. Those
records exist nowhere else and are not recomputable.

## 9. Production deployment sequence

1. **Back up production** (Neon branch or `pg_dump -Fc`); verify the restore.
2. `npx prisma migrate status` — confirm which of the five are already applied.
3. Apply only pending: expect `20260721000100` and `20260721000200`.
4. Verify `move_closeouts_booking_id_fkey` delete rule is `RESTRICT`.
5. Verify the six `SAVED_VIEW_*` enum values exist.
6. Verify `business_config` has a row with splits totalling 100.
7. `npx prisma generate`.
8. Deploy merged `main`.
9. Smoke test: labor payment -> closeout -> report -> save a view -> apply it.
10. Monitor logs for Prisma errors, 409 finalize conflicts, and booking-deletion
    restrictions.
