# Stage 1-3 Prisma migration audit (read-only)

**Audited 2026-07-20 against `C:/WMIWCI-API`, branch
`claude/admin-stage3b-reporting-ui-staging`, commit `606bc27a`.**
**No migration was applied. No application code or migration SQL was changed.**

---

## Verdict

The migration chain is **structurally sound but NOT deployable as written.**
Two Prisma field mappings disagree with the SQL that creates their columns.
Everything else — ordering, ancestry, enums, foreign keys, backfills — is clean.

## P0 — must be fixed before any `prisma migrate deploy`

### P0-1 Column-name mismatch: `LaborPayment.amountCents`

`prisma/schema.prisma`:

```prisma
model LaborPayment {
  amountCents    Int   // <-- NO @map
```

`20260720000100_phase1_jobcrew_labor/migration.sql`:

```sql
"amount_cents" INTEGER NOT NULL,
```

Prisma will emit `SELECT "amountCents"` against a column named `amount_cents`.
**Every query touching labor payments fails at runtime** with
`column "amountCents" does not exist`.

Blast radius — these all read `laborPayments.amountCents`:

- `POST /api/admin/crew-assignments/[id]/payments` (record a labor payment)
- `DELETE …/payments` (void a payment)
- `labor-service.recalcAssignment` -> every crew write path
- `job-money.toLaborAssignments` -> the job detail page and the jobs list
- `closeout-service.buildCloseoutView` -> the entire Stage 2 closeout
- `reporting-service` -> every Stage 3 report that touches labor

### P0-2 Column-name mismatch: `ReserveAllocation.amountCents`

Identical defect:

```prisma
model ReserveAllocation {
  amountCents   Int   // <-- NO @map
```

```sql
"amount_cents" INTEGER NOT NULL,
```

Breaks `ADD_RESERVE` on the closeout route and the business-reserve total inside
`buildCloseoutView`.

**Proof this is accidental, not a convention:** `MarketingSpend.amountCents`
in the same schema *does* carry `@map("amount_cents")`. Two fields were missed.

### Why every check still passes

`prisma validate`, `prisma generate`, `tsc --noEmit` and all **608 tests** pass,
because none of them touch a database — the client is generated *from* the
schema, so the mapping is self-consistent right up until it meets PostgreSQL.
This is exactly the failure mode a static audit exists to catch.

### Correction (do NOT apply during the audit)

Edit `prisma/schema.prisma` only — the SQL is already correct and consistent
with every other column in the codebase:

```prisma
// model LaborPayment
amountCents    Int    @map("amount_cents")

// model ReserveAllocation
amountCents    Int    @map("amount_cents")
```

Then `npx prisma generate`, `npx tsc --noEmit`, `npm test`.
**No migration file changes and no new migration are required** — the database
shape is unchanged; only Prisma's view of it is corrected.

---

## P1 findings

### P1-1 `MarketingCampaign` / `MarketingSpend` have NO write path

`prisma.marketingCampaign` appears exactly **once** in the codebase — a
`findMany` inside `reporting-service.loadMarketingReport`. `prisma.marketingSpend`
appears **zero** times. There is no `/api/admin/marketing` route.

Consequence: after the Stage 3 migration both tables exist and stay permanently
empty, so `spendBySource` is always empty, `spendCents` is always 0, and
**Profit ROAS — Stage 3's headline metric — is always `null`** with the caveat
"No marketing spend recorded". The marketing report cannot do its job.

This is the same class of defect as the original Stage-0 finding that `JobCrew`
had no write path. Not a migration blocker; a Stage 4 build item.

### P1-2 Cascade delete can destroy immutable financial history

```sql
move_closeouts.booking_id     -> bookings(id)        ON DELETE CASCADE
financial_snapshots.closeout_id -> move_closeouts(id) ON DELETE CASCADE
```

Deleting a `Booking` therefore silently destroys its `MoveCloseout` **and every
`FinancialSnapshot`** — the immutable record Stage 2 exists to protect.

Two live delete paths exist:

| Path | Risk today |
| --- | --- |
| `app/api/bookings/route.ts:586` — rollback when Stripe checkout creation fails | **Low.** The booking is seconds old and cannot have a closeout. |
| `app/api/admin/test-booking/route.ts:100` — internal test-booking cleanup | **Low-moderate.** A test booking that was closed out would lose its snapshots. |

Neither is exploitable today, but the FK makes future data loss a one-line
change away. Recommended correction (post-migration, needs its own migration):
change `move_closeouts_booking_id_fkey` to `ON DELETE RESTRICT`, so a booking
carrying financial history cannot be deleted at all.

Note `owner_distributions.booking_id` is deliberately a **plain reference with no
FK**, so distributions already survive a booking deletion. The inconsistency is
worth resolving in one direction.

### P1-3 `SavedReportView` is created but entirely unused

Zero reads, zero writes. The table will exist and stay empty. Harmless, but it
is dead schema until saved-view CRUD is built.

---

## P2 findings

### P2-1 Benign default drift on `job_crew.updated_at`

```sql
ALTER TABLE "job_crew" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
```

Prisma's `@updatedAt` models a column with **no** database default. The default
is *required* here so existing rows can be backfilled, but it means a future
`prisma migrate diff` will report drift on this column. Expected and benign —
document it so nobody "fixes" it by dropping the default and breaking the
backfill.

### P2-2 CHECK constraints are invisible to Prisma

All 19 CHECK constraints across the three migrations exist only in SQL. Prisma
does not model them, so they will never appear in `schema.prisma` and a
`migrate diff` will not see them. They are not at risk of being dropped, but
anyone regenerating a migration from the schema alone would lose them.

### P2-3 CHECK constraints validate existing rows immediately

`ALTER TABLE … ADD CONSTRAINT … CHECK` scans the whole table. On a database with
real `job_crew`, `bookings` or `payments` rows, a single violating row aborts the
migration. This is *desirable* (it refuses to import bad data) but means the
preflight queries in `stage1-3-preflight.sql` must be run first.

---

## What is clean

| Check | Result |
| --- | --- |
| Migration count | 26, no duplicate timestamp prefixes |
| `migration.sql` present in every directory | yes |
| Git ancestry Stage 0 -> 1 -> 2 -> 3A -> 3B | clean linear chain, verified with `merge-base --is-ancestor` |
| Each stage migration introduced by its expected commit | yes |
| Destructive statements (`DROP`, `TRUNCATE`, `DELETE`, `ALTER COLUMN`) | **zero** in all three migrations |
| Foreign keys created after their parent tables | yes, all 5 |
| `ALTER TYPE … ADD VALUE` used in the same transaction | **no** — zero `INSERT` statements, so the PG same-transaction hazard does not apply |
| `ADD VALUE IF NOT EXISTS` | used throughout; safe to retry |
| Enum values: schema vs SQL | all 18 new enums match exactly; 40 `AuditAction` values all present in schema |
| Money storage | integer cents everywhere in new models |
| Backfills fabricate data | **no** — see below |

## Backfill audit

Every backfill is derived from data that already exists. Nothing is invented.

| Migration | Backfill | Truthful because |
| --- | --- | --- |
| Stage 1 | `users.worker_type = 'OWNER'` where `role = 'OWNER'` | restates an existing fact |
| Stage 1 | `job_crew.role = 'CREW_LEADER'` where `crew_leader = true` | restates an existing boolean |
| Stage 1 | `worked_minutes` from `actual_hours × 60` | unit conversion of a recorded value |
| Stage 1 | rate snapshots frozen from existing `pay_rate` / `flat_pay` | **freezes** history rather than inventing it |
| Stage 1 | `approval_status = 'APPROVED'` where `pay_status IN ('PAY_APPROVED','PAID')` | restates an existing approval |
| Stage 1 | `payment_status = 'PAID'` where `pay_status = 'PAID'` | restates an existing payment |
| Stage 3 | `first_touch_source` from `source`/`found_us` | preserves the original attribution, once |

**Critically, nothing is defaulted to a falsely-complete state.** `MoveCloseout`
rows are not created at all, so every existing completed move correctly reads as
`NOT_STARTED` / provisional rather than finalized. `JobCrew.approval_status`
defaults to `DRAFT`, not `APPROVED`. No move is silently marked financially
complete.

## Duplicate source-of-truth check

| Concern | Result |
| --- | --- |
| `JobCrew` vs Discord `CrewJob` | **Not duplicated.** `CrewJob` lives on the unmerged `claude/frosty-feynman-d7161d` worktree, has no `bookingId`/`jobId`/`User` FK, and no reporting or profit code reads it. `JobCrew.crewJobId` exists as a nullable, unique, **FK-free** seam. |
| Labor as both `JobCrew` and `WORKER_PAY` expense | Guarded by `worker-pay-guard` (blocks the duplicate) plus an Action Center detection rule. |
| Finalized profit recomputed vs snapshotted | Reports read `FinancialSnapshot` for finalized moves and never recalculate. |

## Application-to-schema contract

| Model | Writes | Reads | Verdict |
| --- | --: | --: | --- |
| `jobCrew` | 7 | 16 | OK |
| `laborPayment` | 2 | 1 | **P0-1 breaks all of these** |
| `moveCloseout` | 11 | 1 | OK |
| `financialSnapshot` | 2 | 3 | OK |
| `reserveAllocation` | 1 | 0 (read via relation) | **P0-2 breaks the write** |
| `ownerDistribution` | 3 | 4 | OK |
| `marketingCampaign` | 0 | 1 | **P1-1 no write path** |
| `marketingSpend` | 0 | 0 (read via relation) | **P1-1 no write path** |
| `savedReportView` | 0 | 0 | **P1-3 dead schema** |
| `reportExport` | 1 | 0 | OK (write-only audit table by design) |

## Transaction and concurrency review

Correctly atomic (verified in code): crew assignment + rate snapshot + audit;
labor approval + audit; labor payment + audit; closeout finalize + snapshot +
status + audit; reopen + audit; distribution create + audit; export + audit row.

Residual concurrency risks, all mitigated by database constraints rather than
application checks:

| Risk | Guard |
| --- | --- |
| Two assignments for one worker on one move | `@@unique([jobId, userId])` |
| Duplicate snapshot version | `@@unique([closeoutId, version])` |
| Two closeouts for one move | `@@unique` on `move_closeouts.booking_id` |
| Distribution paid > approved | DB CHECK `paid_cents <= approved_cents` |
| Replayed Discord gig acceptance | `@unique` on `job_crew.crew_job_id` |

**One gap:** `writeSnapshot` reads the current max version then inserts
`version + 1`. Two simultaneous finalizations would race, but the unique
constraint turns that into a failed insert rather than a duplicate — acceptable,
though the route should surface a friendly 409 instead of a raw constraint error.

## Database availability

`npx prisma migrate status` -> **DATABASE UNAVAILABLE**
(`ERROR: Your account or project has exceeded the compute time quota`).
No alternative database exists in this environment: no local PostgreSQL client,
no Docker, nothing listening on 5432. **All drift analysis above is STATIC.**
