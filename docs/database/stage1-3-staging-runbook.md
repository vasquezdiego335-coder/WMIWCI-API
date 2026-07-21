# Stage 1-3 staging runbook

**Do not run any of this until P0-1 and P0-2 in `stage1-3-migration-audit.md`
are corrected.** Applying the chain first means Stage 1 and Stage 2 write paths
fail the moment they are exercised.

## Step 0 — correct the blockers (code change, no migration)

```prisma
// prisma/schema.prisma
model LaborPayment      { amountCents Int @map("amount_cents") }
model ReserveAllocation { amountCents Int @map("amount_cents") }
```

```bash
npx prisma generate
npx tsc --noEmit
npm test                     # expect 608/608
```

Commit that as its own change. No new migration is needed.

---

## Plan A — clean throwaway database rehearsal

Use a database you can destroy. Never production.

```bash
# 1. Point at the throwaway DB (do not commit this value)
export DATABASE_URL="postgresql://…/throwaway"
export SHADOW_DATABASE_URL="postgresql://…/throwaway_shadow"

# 2. Static checks
npx prisma validate
npx prisma generate

# 3. Confirm the chain is fully pending
npx prisma migrate status     # expect 26 pending

# 4. Apply everything (clean DB: no data to violate a constraint)
npx prisma migrate deploy

# 5. Confirm clean
npx prisma migrate status     # expect "Database schema is up to date"
```

### Verify structure

```sql
-- 9 new tables
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('labor_payments','move_closeouts','financial_snapshots',
  'reserve_allocations','owner_distributions','marketing_campaigns',
  'marketing_spend','saved_report_views','report_exports') ORDER BY 1;

-- 19 CHECK constraints
SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
WHERE contype = 'c' AND conrelid::regclass::text IN
 ('job_crew','labor_payments','move_closeouts','financial_snapshots',
  'reserve_allocations','owner_distributions','marketing_campaigns',
  'marketing_spend','report_exports') ORDER BY 1, 2;

-- THE P0 CHECK: this must return amount_cents, not amountCents
SELECT table_name, column_name FROM information_schema.columns
WHERE column_name ILIKE 'amount%cents'
  AND table_name IN ('labor_payments','reserve_allocations','marketing_spend');

-- 18 new enum types
SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY typname;
```

Then run the scenario sets in §21-23 below. Use `prisma migrate deploy`, never
`prisma db push` — push does not exercise the migration files.

---

## Plan B — staging database containing a copy of real data

1. **Confirm the target.** `SELECT current_database();` — verify it is staging,
   not production. Record the database name and host **without credentials**.
2. **Back up.** Neon: create a branch or point-in-time snapshot. Self-hosted:
   `pg_dump -Fc`. Verify the backup restores before continuing.
3. **Run the preflight** — `docs/database/stage1-3-preflight.sql`.
4. **Stop if any violation count is non-zero.** Fix the data, re-run.
5. **Apply Stage 1 only:**
   `npx prisma migrate deploy` will apply all pending. To go one at a time,
   temporarily move the later two directories aside, or apply on a branch that
   only contains Stage 1. Verify before continuing.
6. **Verify Stage 1 schema** — `job_crew` has ~64 new columns, `labor_payments`
   exists, rate snapshots were frozen:
   ```sql
   SELECT count(*) FROM job_crew WHERE rate_snapshot_source = 'legacy_backfill';
   SELECT count(*) FROM job_crew WHERE approval_status = 'APPROVED';
   ```
7. **Run the Stage 1 scenario set** (§21).
8. **Apply Stage 2.** Verify `move_closeouts` is EMPTY — no existing move may be
   auto-finalized:
   ```sql
   SELECT count(*) FROM move_closeouts;            -- expect 0
   SELECT count(*) FROM financial_snapshots;       -- expect 0
   ```
9. **Run the Stage 2 scenario set** (§22).
10. **Apply Stage 3.** Verify first-touch seeding preserved the original source
    and did not invent one:
    ```sql
    SELECT count(*) FROM bookings WHERE first_touch_source IS NOT NULL;
    SELECT count(*) FROM bookings WHERE first_touch_source IS NULL;  -- stays UNKNOWN
    ```
11. **Run the Stage 3 scenario set** (§23).
12. `npx prisma migrate status` — expect clean.
13. `npx prisma generate && npm run build` — confirm the app builds against the
    regenerated client.
14. **Record the rollback point**: the backup id and the commit SHA deployed.

---

## §21 Stage 1 scenario set

Assign worker · assign owner · rate snapshot persists · scheduled hours persist ·
clock-in/out persist · breaks persist · overtime computed · manual correction
persists with reason · approval persists · partial payment persists · full
payment persists · **change a worker's profile rate and confirm a historical
move's cost does NOT change** · confirmed $0 labor is distinguishable from
missing labor · job profit counts labor exactly once · safe-to-distribute is
unchanged when unpaid labor becomes paid · a worker cannot approve their own pay ·
a second concurrent assignment for the same worker is rejected by the unique index.

## §22 Stage 2 scenario set

Closeout creation · revenue reconciliation · partial refund nets once · full
refund · expense review · receipt threshold · truck source confirmation ·
owner reimbursement held back · overhead allocation · tax reserve floors at $0 on
a loss · business reserves · owner split · **finalization writes an immutable
snapshot** · distribution creation · partial distribution payment · full payment ·
reopening supersedes rather than deletes · late expense correction produces v2 ·
concurrent finalization is rejected by the version unique index · manager is
refused finalize/override/split/distribution.

## §23 Stage 3 scenario set

Reporting overview · P&L vs previous period · move profitability · revenue vs
profit · estimate variance including a scope change · marketing profitability ·
customer profitability · pricing intelligence with <3 comparables returning
INSUFFICIENT · finalized vs provisional separation · cash vs accrual · date
filtering across a month boundary · DST start and end · last day of a custom
range included · CSV export · XLSX export · a `=HYPERLINK(` note opens inert ·
manager cannot export a profit column · marketing spend persists **(blocked by
P1-1 until a campaign write path exists)** · attribution persists and first-touch
resists overwrite · empty-state behavior on a fresh database · pagination and
sorting · report totals equal the stored snapshots.
