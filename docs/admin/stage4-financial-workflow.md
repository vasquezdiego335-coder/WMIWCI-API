# Stage 4 — financial workflow: state of play

**Branch `claude/stage4-financial-workflow`. Last updated 2026-07-21.**
Honest status: the closeout **calculation** foundation is complete and tested.
The closeout **workflow** is not yet proven against a database.

## Verdict

```
STAGE 4 INCOMPLETE
```

`finalize → snapshot → reopen → version two` has never executed against real
rows. Until it has, nothing downstream (itemized charges, discounts, Leads,
marketing) should start — that was the whole point of the ordering.

## The seven defects, and where they stand

| | Defect | Status |
| --- | --- | --- |
| D1 | `Payment` could not record how money arrived | ✅ real indexed `method` column + `STRIPE` enum value |
| D2 | A losing move could never be finalized | ✅ `overAllocated` = requested > available |
| D3 | A synthetic move could never be closed out | ✅ `NO_PAYMENT_DATA` is OVERRIDABLE **only** when `isInternalTest` |
| D4 | `generalReserveBp` was a dead column | ✅ now THE company-retained share |
| D5 | Auto-created Jobs were unaudited | ✅ `JOB_CREATED`, exactly once, race-safe |
| D6 | No pay rates, no crew users | ⚠️ **detection** shipped; the **editing UI is not built**; rates remain owner-supplied |
| D7 | No `BusinessConfig` row in production | ✅ seeded with the owner's policy |

## The 40/30/30 policy

Owner instruction 2026-07-21: **40% business · 30% Diego · 30% Sebastian**, of
FINAL company net profit, after every cost and obligation.

Internally that is `generalReserveBp = 4000` plus a 50/50 owner split of the
remaining 60%. `src/lib/profit-allocation.ts` is THE presentation model that
converts the internal representation into the owner's terms — every surface must
render it rather than the raw split.

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
| Job profit summary | ❌ |
| Finalization review | ❌ (uses the closeout panel's block) |
| Snapshot history | ❌ |
| Reports | ❌ |
| CSV / XLSX / PDF exports | ❌ |
| Printable summaries | ❌ |

**The unfinished surfaces are the main remaining Stage 4 UI work.** The shared
model makes them mechanical, but they are not done.

## Snapshot durability

`FinancialSnapshot` stores `businessRetainedBp`, `businessRetainedCents`,
`roundingRemainderCents`, `distributableProfitCents`, `ownerAllocations` and
`calculationVersion`. `FINALIZE` freezes `businessRetainedBp` onto
`MoveCloseout`, and `buildCloseoutView` prefers the frozen rate over live
config — so a later policy change cannot rewrite a closed move.

**Not yet proven:** reports and exports do not read snapshots at all, so the
"reports use frozen values" requirement is untestable until they do.

## D3 — the internal-test rehearsal pathway

One line of behaviour, not a subsystem. When `booking.isInternalTest`,
`NO_PAYMENT_DATA` drops HARD → OVERRIDABLE. Everything else was already
enforced by `canOverrideBlocker`:

* OWNER only (`closeout.override_blocker`)
* written reason, rejected on empty/whitespace
* audited as `CLOSEOUT_OVERRIDE_USED` with the reason
* no Stripe, email or SMS — the closeout path calls none of them
* synthetic revenue already excluded by `money-rules`

A real booking cannot take this path: the severity gate refuses an owner with a
valid reason (422). Omitting the flag defaults to STRICT. The flag unlocks
nothing else — `LABOR_MISSING_RATE` stays HARD, `REFUND_EXCEEDS_PAYMENT` is
never softened.

## D6 — what the owner must still configure

`src/lib/financial-setup.ts` reports what is unset; the dashboard shows
**"Financial setup required"** above the money with a linked checklist. It
REPORTS ONLY — a test asserts its output contains no number that could be
mistaken for a configured rate.

Outstanding in production:

* Diego's owner labor value — **owner must set**
* Sebastian's owner labor value — **owner must set**
* At least one active crew member — **owner must add**
* A default rate per crew member — **owner must set**

A missing rate stays a HARD blocker (`LABOR_MISSING_RATE`) and is never treated
as $0. An owner CASH rate is optional — owners taking no wage is valid.

**The editing UI is not built.** Rates cannot currently be set through the admin.

## Migration

`20260721180000_stage4_payment_method_and_retained_share` — **additive only**:
every column nullable or defaulted, two enum values (`PaymentMethod.STRIPE`,
`AuditAction.JOB_CREATED`), one index. Safe on a live database, no backfill, no
downtime. The deployed app keeps working if it lands first.

**Not applied anywhere.** No staging database exists.

## Remaining work, in order

1. Owner rate-configuration UI (D6 editing)
2. 40/30/30 on the six unfinished surfaces, exports included
3. Make reports/exports read finalized snapshots, then test frozen values
4. Open the Stage 4 PR
5. Back up Neon → merge → `npx prisma migrate deploy` → verify status + health
6. Run the end-to-end internal closeout and prove finalize → snapshot → reopen →
   version two
7. Only then: itemized charges, discounts/credits/write-offs, Leads, marketing

## Verification at last commit

```
git diff --check     clean
npx prisma validate  schema valid
npx prisma generate  ok
npx tsc --noEmit     0 errors
npm test             963/963 pass   (909 at branch point)
npm run build        compiled successfully
```

Test files added this stage: `profit-policy.test.ts` (19),
`profit-allocation.test.ts` (14), `stage4-closeout-foundation.test.ts` (18),
plus `scripts/stage4-closeout-rehearsal.ts`.
