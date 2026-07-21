# Stage 4 — financial workflow: state of play

**Branch `claude/stage4-financial-workflow`. Last updated 2026-07-21.**
Honest status: the closeout **foundation** is complete, tested and built.
The closeout **workflow** has still never run against a database.

## Verdict

```
STAGE 4 CLOSEOUT FOUNDATION COMPLETE — DEPLOYMENT REQUIRED
```

Everything the workflow needs now exists in code: the owner can configure the
rates it depends on, a rehearsal can be run without touching a card, a finalized
move is a frozen record rather than a live opinion, and every surface and export
states the 40/30/30 policy. What has NOT happened is
`finalize → snapshot → reopen → version two` against real rows. Until it has,
nothing downstream (itemized charges, discounts, Leads, marketing) should start.

## The seven defects

| | Defect | Status |
| --- | --- | --- |
| D1 | `Payment` could not record how money arrived | ✅ real indexed `method` column + `STRIPE` enum value |
| D2 | A losing move could never be finalized | ✅ `overAllocated` = requested > available |
| D3 | A synthetic move could never be closed out | ✅ `internal-rehearsal.ts` — one gate, four conditions, declared side effects |
| D4 | `generalReserveBp` was a dead column | ✅ now THE company-retained share, frozen at finalization |
| D5 | Auto-created Jobs were unaudited | ✅ `JOB_CREATED`, exactly once, race-safe |
| D6 | No pay rates, no crew users | ✅ detection **and** editing — `/admin/staff` configures per-owner and per-crew rates |
| D7 | No `BusinessConfig` row in production | ✅ seeded with the owner's policy |

## The 40/30/30 policy

Owner instruction 2026-07-21: **40% business · 30% Diego · 30% Sebastian**, of
FINAL company net profit, after every cost and obligation.

Internally that is `generalReserveBp = 4000` plus a 50/50 owner split of the
remaining 60%. `src/lib/profit-allocation.ts` is THE presentation model that
converts the internal representation into the owner's terms — every surface
renders it rather than the raw split.

```
$1,000 net → business $400 · Diego $300 · Sebastian $300
$1,175 net → business $470 · Diego $352.50 · Sebastian $352.50
```

Rules enforced in code: applied only to POSITIVE net profit · never to revenue,
the quote, or collected payments · never deducted twice · no automatic tax
reserve on top (`taxReservePercent` is 0 by owner decision) · manual reserves are
ADDITIVE · rounding remainder stays with the business · liabilities come first ·
owner allocations can never exceed available profit.

> The retained 40% is a **general company allocation** — it may fund taxes,
> equipment, insurance, licensing or growth. The software does not present it as
> tax advice, and every surface that shows it says so.

### Surfaces

| Surface | 40/30/30 shown |
| --- | --- |
| Financial Closeout panel | ✅ |
| Owner Money → Safe to Distribute | ✅ |
| Job Profit & Costs | ✅ |
| Finalization review | ✅ |
| Snapshot history | ✅ (each version's OWN frozen figures) |
| Financial Overview | ✅ |
| Profit and loss | ✅ (its own section, labelled equity activity) |
| Move profitability | ✅ per move and per period |
| Revenue versus profit | ✅ |
| Customer + marketing profitability | ✅ (exports and API; table columns unchanged) |
| CSV / XLSX / PDF exports | ✅ eleven allocation columns |
| Printable closeout summary | ✅ `/admin/closeout-summary/[id]` |

Every surface shows dollars AND the share of final net profit. The internal
50/50 is never shown on its own.

## Snapshot durability

`FinancialSnapshot` stores `businessRetainedBp`, `businessRetainedCents`,
`roundingRemainderCents`, `distributableProfitCents`, `ownerAllocations`,
`allocationLines` (the resolved lines as PRESENTED), `calculationVersion`,
`configSource` and `configVersion`.

`allocationFromSnapshot` reads them and consults **no live configuration at
all**. Reports read it for every finalized move. Consequently:

* changing `generalReserveBp` cannot restate a closed move
* changing the owner split cannot restate a closed move
* changing an owner's labor rate cannot restate a closed move
* reopening supersedes v1 and writes v2; v1 stays byte-for-byte as it was

The closeout panel shows the frozen figures and, when live numbers have drifted,
says so — without changing either.

Snapshots written before Stage 4 have no `allocationLines`; they are restated
from their existing frozen amounts, still without live config, and contribute
zero allocation to a period total rather than a guess.

## D3 — the internal-test rehearsal pathway

`src/lib/internal-rehearsal.ts`. All four conditions must hold:

* the booking is `isInternalTest`
* the actor is an OWNER (`closeout.override_blocker`)
* a written reason is supplied (whitespace is not a reason)
* `INTERNAL_REHEARSAL_DISABLED` is not `true`

Order matters: the internal-test check runs FIRST, so a real booking is refused
with a message about the booking rather than about the person.

Guaranteed non-events, declared in `REHEARSAL_SIDE_EFFECTS` and recorded in the
audit entry: no Stripe operation, no customer email, no customer SMS, no
customer Discord message. Synthetic revenue is excluded from reporting by
`money-rules`. The rehearsal is audited as `CLOSEOUT_REHEARSAL` in addition to
`CLOSEOUT_OVERRIDE_USED`, so synthetic activity is findable without parsing
reasons.

It covers `NO_PAYMENT_DATA` and nothing else. `LABOR_MISSING_RATE` stays HARD;
`REFUND_EXCEEDS_PAYMENT` is never softened.

## D6 — labor-rate configuration

`/admin/staff`, owner-only, via `PATCH /api/admin/staff/[id]/rates`.

Per owner: economic labor rate, optional cash rate, pay type, active, effective
date, notes, updated-by and updated-at. Per crew member: default hourly rate,
flat-rate option, role, worker type, active, driver eligibility, crew-leader
eligibility.

```
Financial labor setup

Diego owner labor rate: Not configured
Sebastian owner labor rate: Not configured
Active crew members: 0
```

> Owner labor rates estimate the economic cost of owner work.
> They are separate from the 30% owner profit allocations.

* A blank rate is **not configured**, never $0. An explicit $0 economic rate is
  refused with a message offering blank instead.
* The business-wide `ownerEconomicRateCents` (column default $30/h — a number
  nobody chose) can no longer answer for an owner. Each owner's gap is reported
  separately.
* `buildRateSnapshot` no longer falls back to $30/h for owner labor. Unset means
  NULL, which surfaces as `LABOR_MISSING_RATE`.
* Changing a profile rate does not touch any `JobCrew` snapshot.
* Owner-only, audited as `LABOR_RATE_CONFIGURED` with before and after.
* A manager on `/admin/staff` is not sent the values at all.

**Still owner-supplied in production:** Diego's rate, Sebastian's rate, and any
crew members with their rates. The software will not guess them.

## Migrations

Three, all **additive only** — every column nullable or defaulted, enum values
added, no backfill, no downtime, safe if they land before the code:

* `20260721180000_stage4_payment_method_and_retained_share`
* `20260721190000_stage4_labor_rate_configuration`
* `20260721190100_stage4_snapshot_allocation_provenance`

**Not applied anywhere.** No staging database exists.

## Deployment sequence

Do not start until the PR is reviewed.

1. Review the Stage 4 PR; confirm migrations and matching code are in it.
2. **Back up production Neon.**
3. Merge.
4. Railway runs `npx prisma migrate deploy`.
5. Confirm `npx prisma migrate status` → `Database schema is up to date!`
6. Confirm Railway deployment health.
7. Enter Diego's and Sebastian's labor rates through `/admin/staff`.
   **Do not enter guessed rates.**

## End-to-end verification (after deployment)

One safe internal closeout rehearsal, on a disposable internal-test booking —
never a real customer:

1. Create an internal-test booking with no Stripe payment.
2. Ensure exactly one Job; verify the `JOB_CREATED` audit entry.
3. Record a synthetic manual test payment; verify `Payment.method` persists.
4. Assign synthetic labor with a frozen rate; record hours and a break; approve.
5. Add one approved expense and one rejected expense; verify the rejected one is
   excluded.
6. Calculate final company net profit; confirm Business 40 / Diego 30 /
   Sebastian 30.
7. Finalize. Re-read the snapshot **from the database**.
8. Change live configuration; prove the snapshot is unchanged.
9. Reopen with a reason; add a late synthetic expense; finalize version two.
10. Verify v1 is unchanged and superseded, and v2 carries the new values.
11. Remove the disposable records if the environment is meant to stay clean.

Only when that passes does the verdict become
`STAGE 4 CLOSEOUT FOUNDATION DEPLOYED AND VERIFIED`.

## Verification at this commit

```
git diff --check     clean
npx prisma validate  schema valid
npx prisma generate  ok
npx tsc --noEmit     0 errors
npm test             1068/1068 pass   (963 at the previous commit)
npm run build        compiled successfully
```

Test files this stage: `profit-policy.test.ts` (19),
`profit-allocation.test.ts` (14), `stage4-closeout-foundation.test.ts` (20),
`labor-rates.test.ts` (22), `internal-rehearsal.test.ts` (17),
`stage4-allocation-reporting.test.ts` (33). All registered in `npm test`.

## After this, in order

1. Deploy and run the end-to-end verification above.
2. Then, and only then: itemized charges, discounts/credits/write-offs, Leads,
   marketing, worker operations, Stage 5.
