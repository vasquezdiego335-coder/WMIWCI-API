# Stage 1-3 rollback plan

## Principle

All three migrations are **purely additive** — zero `DROP`, zero `TRUNCATE`,
zero `DELETE`, zero `ALTER COLUMN`. Nothing existing is removed or retyped.
Therefore the correct rollback is an **application rollback**, leaving the
schema in place.

## Can the previous application version run against the new schema?

| Check | Result |
| --- | --- |
| Any existing column removed? | No |
| Any existing column retyped or made NOT NULL? | No |
| Any existing enum value removed? | No |
| Any existing default changed? | No |
| New tables ignorable by old code? | Yes — old code never references them |
| New columns ignorable? | Yes — all are nullable or defaulted |
| Old queue workers affected? | No new queue kinds are enqueued by Stages 1-3 |

**Conclusion: an application rollback is safe.** Old code reads the new schema
without modification.

## Rollback levels

| Level | Action | Effect |
| --- | --- | --- |
| 1 | Flip the Reports sidebar item back to `soon: true` | Nobody navigates to reporting |
| 2 | Remove `app/(admin)/admin/(dashboard)/reports/` | Reporting UI gone; API still serves |
| 3 | Remove `app/api/admin/reports/` | Reporting stops entirely. **No financial record is touched** — reporting only ever writes `report_exports` audit rows |
| 4 | Redeploy the previous application build | Full revert to pre-Stage behavior; schema untouched |

## Why the migrations must NOT be destructively reversed

Dropping these tables destroys records that exist nowhere else:

- `financial_snapshots` — the **immutable** record of what each move earned.
  This is the entire point of Stage 2 and cannot be recomputed, because it was
  captured under settings that have since changed.
- `labor_payments` — proof of money paid to crew.
- `owner_distributions` — proof of profit paid to owners.
- `marketing_spend` — campaign costs that exist in no other system.
- `job_crew` rate snapshots — dropping them re-exposes every historical move to
  today's pay rates, silently rewriting past profit.

There is deliberately **no down-migration**. If a table truly must go, export it
first (`\copy … TO … CSV`) and record why.

## If a migration fails midway

Prisma runs each migration file in a transaction, so a failure rolls that file
back and records it in `_prisma_migrations` with `finished_at` NULL. Recovery:

1. `SELECT migration_name, logs FROM _prisma_migrations WHERE finished_at IS NULL;`
2. Fix the underlying data (almost always a CHECK-constraint violation the
   preflight would have caught).
3. `npx prisma migrate resolve --rolled-back <migration_name>`
4. Re-run `npx prisma migrate deploy`.

Do not hand-edit `_prisma_migrations` and do not manually execute the SQL.
