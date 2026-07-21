# Stage 4 readiness

**As of 2026-07-21, branch `claude/admin-stage3b-reporting-ui-staging`.**

Phases 0-3B and every P1 item from the migration audit are built, tested and
committed. Nothing is deployed. This document is the honest statement of what
is true where, so Stage 4 starts from fact rather than assumption.

---

## 1. The one thing to understand first

**The production DATABASE and the production APPLICATION are at different
stages, and that is currently the only reason nothing is broken.**

| | State |
| --- | --- |
| Production database | Stage 1-3 schema applied 2026-07-21 |
| Production application | `main` @ `287ffc0e` — Phase 0 and everything after is absent |

The migrations were applied to production by accident (a bash-style
`DATABASE_URL="..." npx prisma migrate deploy` typed into Windows `cmd.exe`,
where the inline assignment is not valid syntax; both prefix lines errored and
the bare command fell through to `.env`, which points at production).

It was survivable because the audit's central finding held: **all three
migrations are purely additive** — no `DROP`, `TRUNCATE`, `DELETE` or
`ALTER COLUMN`, every new column nullable or defaulted. Old code ignores the new
schema entirely. All 19 CHECK constraints validated against real production data
without aborting, which is a genuine (if backwards) confirmation that production
data is clean.

**Nothing about that is a reason to relax.** The next deploy is the moment the
two halves meet.

## 2. Deployment order for Stage 4 (do not reorder)

1. **Merge this branch to `main`.** 10 commits. Do not cherry-pick — the P0
   `@map` fix (`ff5a97d1`) is meaningless without the Stage 1-3 code, and the
   Stage 1-3 code is broken without the fix.
2. **Apply `20260721000100_protect_financial_history`** (P1-2). Production still
   has the old `ON DELETE CASCADE`.
3. **Seed `business_config`** if it has no row — see §5.
4. **Deploy the application.**
5. **Smoke test** — one labor payment, one closeout, one report. This is the
   first time any of it runs against a real database.

Applying step 4 before step 1 leaves production exactly as it is today (safe).
Applying step 1 before the `@map` fix is impossible — it is in the same branch.

## 3. What each stage delivered

| Stage | Commit | Delivers |
| --- | --- | --- |
| Phase 0 | `83841528` | Refund double-penalty, expense eligibility, paid labor in safe-to-distribute, missing-labor warnings |
| Phase 1 | `7453a340` | JobCrew labor & time tracking — the first write path for labor cost |
| Phase 2 | `9099d4ff` | Closeout, immutable snapshots, overhead, reserves, owner splits, distributions |
| Stage 3 | `f52e7f90` | Reporting, marketing profitability, estimate variance, pricing intelligence, exports |
| Stage 3B | `606bc27a` | Reporting UI, report + export routes, route-level tests |
| P0 fix | `ff5a97d1` | `@map("amount_cents")` on `LaborPayment` and `ReserveAllocation` |
| P1-1 | `e7075cdc` | Marketing write path — Profit ROAS can produce a number |
| P1-2 | `9973b7cd` | `ON DELETE RESTRICT` — booking deletion cannot destroy snapshots |
| P1-4 | `5d488228` | Friendly 409 on concurrent finalize |
| P1-3 | `15f25d46` | Saved report views |

**649 tests, all passing.** 3 TypeScript errors remain, all inside the untracked
`email-marketing-html/` directory; none in application code.

## 4. Every table now has a write path

The audit's recurring finding — schema shipped without the code that fills it —
is closed. This is the check to re-run before declaring any future stage done.

| Model | Write path | Status |
| --- | --- | --- |
| `JobCrew` | `/api/admin/jobs/[id]/crew`, `crew-assignments/*` | Phase 1 |
| `LaborPayment` | `crew-assignments/[id]/payments` | Phase 1 |
| `MoveCloseout` | `closeout/[id]` | Phase 2 |
| `FinancialSnapshot` | `closeout/[id]` FINALIZE | Phase 2 |
| `ReserveAllocation` | `closeout/[id]` ADD_RESERVE | Phase 2 |
| `OwnerDistribution` | `distributions` | Phase 2 |
| `MarketingCampaign` | `marketing/campaigns` | **P1-1** |
| `MarketingSpend` | `marketing/spend` | **P1-1** |
| `SavedReportView` | `reports/views` | **P1-3** |
| `ReportExport` | `reports/export` | Stage 3B (write-only by design) |

## 5. Known gaps Stage 4 inherits

### 5.1 `business_config` may have no row

Staging has none. Stage 2 reads it for the ownership split, overhead method,
reserve rates, overtime threshold and receipt threshold. **Closeout will not
function without a row.** Check production before deploying:

```sql
SELECT count(*) FROM business_config;
SELECT diego_split_percent + sebastian_split_percent AS must_be_100 FROM business_config;
```

### 5.2 The marketing sourceKey join is exact-string

`resolveAttribution()` only trims booking sources — it does not upper-case — and
spend is matched to revenue by exact compare against `MarketingCampaign.sourceKey`.
P1-1 canonicalizes keys on write and warns at creation time when a key would
only match after canonicalization, but **historical booking sources were not
rewritten** (deliberately — rewriting attribution history is not a migration's
job). Expect some `UNKNOWN` and some case-variant buckets in the first marketing
report. Owner-assigned source is the intended correction path.

### 5.3 Stripe-failure rollback is unguarded

`app/api/bookings/route.ts:586` deletes the booking when Stripe checkout creation
fails, with no `.catch()`. Post-P1-2 the FK is RESTRICT, so if that delete ever
met a booking carrying financial history it would throw inside a `catch` block
and surface as an opaque 500 instead of "Failed to initialize payment". It
cannot happen today (the row is seconds old), but the fix is one `.catch()` and
should be made by hand. Attempted during P1 work; blocked by tooling on the
payment path.

### 5.4 The test script enumerates files explicitly

`package.json` `"test"` lists every test file by name. **A new test file is
silently never run** — this was caught only because a suite count did not move.
Stage 4 should convert it to a glob.

### 5.5 Staging is behind production

`ep-gentle-fire-aq0ufpsl` still has 23/26 migrations. It can no longer rehearse
a production deploy until it is brought forward. Bring staging to parity before
using it to validate anything.

### 5.6 Reporting has never run against real data

All 649 tests are offline. No report, export, closeout or labor calculation has
ever executed against a populated database. **Green tests are not evidence of
database-backed correctness** — the P0 `@map` defect passed `prisma validate`,
`tsc` and 608 tests while being fatal on first contact with PostgreSQL.

## 6. Credential hygiene

A production connection string was pasted in plaintext during this work.
**Rotate `neondb_owner` in the Neon console.** Neither that credential nor any
other appears in this repository; the only copy used during the session was
written to a session-scoped scratchpad outside the repo.

## 7. Suggested Stage 4 scope

In descending order of value:

1. **Deploy what exists.** Ten commits of financial machinery are sitting
   unused. Everything below is worth less than this.
2. **Crew-facing time capture.** Labor cost is only as good as the clock-in
   data, and today it must be typed by an owner.
3. **Marketing UI.** P1-1 built the routes; there is no screen.
4. **Saved-view UI.** Same — P1-3 built the routes, the reports pages do not
   call them yet.
5. **Attribution correction tooling** for §5.2.
6. **Close §5.3 and §5.4** — both are small and both are foot-guns.
