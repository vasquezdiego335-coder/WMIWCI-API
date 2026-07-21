# Stage 4 step 1 — end-to-end closeout rehearsal

**Run 2026-07-21 against production (Neon `ep-polished-poetry-aq6tbdtp`).**
Script: `scripts/stage4-closeout-rehearsal.ts` (`--seed-config` / `--run` / `--cleanup`).

## Which move, and why

**No real move could be used.** Production has zero closeout-eligible bookings:

```
PENDING_PAYMENT 33 · PENDING_APPROVAL 14 · CONFIRMED 8
IN_PROGRESS 0 · COMPLETED 0
jobCrew 0 · laborPayments 0 · moveCloseouts 0 · snapshots 0
```

`isSettledForMoney()` admits only `IN_PROGRESS` and `COMPLETED`, so the closeout
panel had never rendered for any booking in the system's life. Advancing a real
customer booking to `COMPLETED` would have falsified operational history, and
§3 forbids fabricating payments, hours or expenses. Per §2 option 1, the
rehearsal used a **synthetic internal-test move**.

Subject: `STAGE4-REHEARSAL-1` — `isInternalTest: true`, no Stripe call, no email,
no SMS, 1BR quote $649 (base $599 + travel $50) + $50 truck add-on. **Every row
it created was removed afterwards** (`--cleanup`, verified). No customer PII is
recorded here because no customer record was involved.

## What the run proved works

| Step | Result |
| --- | --- |
| `ensureJobForBooking` idempotency | ✅ two calls, one Job, unique index holds |
| Charge reconciliation | ✅ billed $699.00 = $649 quote + $50 truck, travel counted once |
| Duplicate crew assignment | ✅ rejected by the unique index |
| Rate snapshot | ✅ $30.00/h frozen at assignment, not read from the live profile |
| REJECTED expense exclusion | ✅ $99.99 rejected row excluded; cost = $147.00 from 3 approved rows |
| Labor rollup | ✅ 6h × $30 = $180.00 |
| Closeout derivation | ✅ full hierarchy produced: billed → collected → cost → profit → overhead → reserves → distributable |
| Blocker engine | ✅ 6 blockers raised, `canFinalize: false` |
| Owner split | ✅ computed (`OWNERSHIP_PERCENT`), $0.00 each on a loss — correct |

## Defects found

### D1 — `Payment` cannot record how money arrived (SCHEMA)

`Payment` has **no `method` column**. `/api/admin/payments` accepts a
`PaymentMethod` and then stores it in `metadata` JSON and interpolates it into
`description`:

```ts
description: `${method} payment${note ? ` — ${note}` : ''}`,
metadata: { manual: true, method, recordedBy: session.name, ... }
```

`Expense` **does** have `paymentMethod PaymentMethod?`. The ledger can record how
money *left* the business but not how it *arrived*. Cash / Zelle / Venmo / check
/ bank transfer cannot be queried, filtered, grouped or reported — §3 requires
exactly that. **Requires a migration.**

Class: *incorrect validation / data-quality*. Severity: **P1**.

### D2 — a losing move can never be finalized (CALCULATION)

`RESERVES_EXCEED_PROFIT` fired as a **HARD** blocker with **all reserves at
$0.00** and company net profit at **−$327.00**.

`closeout-calc.computeReserves` sets `overAllocated: raw < 0` where
`raw = companyNetProfit − reserves − liabilities`. On a loss with zero reserves,
`raw` is already negative, so `overAllocated` is true and
`closeout-service` passes `reservesExceedProfit: true`. Reserving **nothing**
against a loss is not over-allocating. Every unprofitable move is currently
unfinalizable, with a message that misdescribes the cause.

Class: *incorrect calculation*. Severity: **P1**.

### D3 — an internal-test move can never be closed out (DESIGN)

`summarizeRevenue` excludes `isInternalTest` payments (correctly — they are not
revenue), but `NO_PAYMENT_DATA` is a **HARD** blocker. So the only production-safe
way to rehearse a closeout is structurally unable to complete one. The two
correct rules combine into "the workflow cannot be tested end to end in
production."

Class: *incomplete state transition*. Severity: **P2** — blocks verification, not
real operation.

### D4 — `generalReserveBp` is a dead column (WIRING)

`BusinessConfig.generalReserveBp` is referenced **nowhere** in `app/` or `src/`.
Business reserve is only ever the sum of manually-created `ReserveAllocation`
rows. The owner's **40% business reserve** therefore has no automatic path — it
would have to be hand-entered on every single move.

Class: *missing API route / incomplete state transition*. Severity: **P1**.

### D5 — Job creation writes no audit entry (AUDIT GAP)

`ensureJobForBooking` upserts a `Job` with no `AuditLog` write. A Job appearing
on a move is invisible in the activity log. The status route and the Discord
approval path do log, so the gap is specific to the crew-assignment entry point.

Class: *audit-log gap*. Severity: **P2**.

### D6 — no worker pay rates exist (DATA)

Both active users are `OWNER` with `payRate: null`, and there are **no `CREW`
users at all**. A real assignment through the UI would produce `MISSING_RATE`
and the HARD `LABOR_MISSING_RATE` blocker. The rehearsal only got past this by
writing an explicit snapshot.

Class: *data-quality*. Severity: **P1** — owner action, not a code fix.

### D7 — `BusinessConfig` did not exist in production (DATA — FIXED)

`businessConfig 0`. Every reserve, split and overhead figure silently fell back
to null → 0/NONE. Seeded during this run with the owner's stated policy.

## BusinessConfig as seeded

Owner instruction 2026-07-21: **"40% business, 30% each owner."**

| Field | Value | Reasoning |
| --- | --- | --- |
| `diegoSplitPercent` | 50 | splits apply to **distributable** profit, so 50% of the remaining 60% = **30% of net** |
| `sebastianSplitPercent` | 50 | same → **30% of net** |
| `generalReserveBp` | 4000 | **40%** business reserve |
| `taxReservePercent` | **0** | 40 + 30 + 30 = 100%, leaving nothing for tax |
| rest | schema defaults | owner economic rate $30/h, OT after 8h at 1.5×, receipts required above $25, overhead `NONE` |

> ⚠️ **Flagged for owner review:** the tax reserve is now **0%** (default was 25%).
> The 40% business reserve is the only buffer, so tax must come out of it. Change
> in Owner Money → Business Config if that is not intended.
>
> ⚠️ The 40% is **not yet enforced** — see D4. Until `generalReserveBp` is wired,
> the business reserve stays $0 unless entered by hand.

## Verified closeout output (synthetic figures)

```
net billed        $699.00      crew labor        $180.00
net collected     $0.00 *      direct expenses   $147.00
outstanding       $699.00      direct job cost   $327.00
                               cash gross profit −$327.00
overhead          $0.00 (NONE) company net       −$327.00
tax reserve       $0.00        business reserve  $0.00  ← D4
DISTRIBUTABLE     $0.00        split: DIEGO $0.00 · SEBASTIAN $0.00

* $699.00 was recorded as two payments but both are isInternalTest → D3
```

Blockers raised: `RESERVES_EXCEED_PROFIT` (HARD, **D2 — spurious**),
`NO_PAYMENT_DATA` (HARD, D3), `OUTSTANDING_BALANCE`, `TRUCK_SOURCE_MISSING`,
`RECEIPT_MISSING` ×2. `canFinalize: false`.

**Finalize, snapshot and reopen were NOT reached** — D2 and D3 block them. They
remain unverified against a real database.

## What must be fixed before Stage 4 features

1. **D2** — a losing move must be finalizable (blocker logic).
2. **D4** — wire `generalReserveBp` so the owner's 40% is automatic.
3. **D1** — add `Payment.method` (migration).
4. **D3** — let the closeout engine treat a test move as closeable, or provide a
   verification path that does not depend on production data.
5. **D5** — audit-log the Job upsert.
6. **D6** — owner sets pay rates and creates crew users.

Only after these does building itemized charges (§6), discounts/credits/write-offs
(§7) and balance visibility (§8) rest on a workflow that actually completes.
