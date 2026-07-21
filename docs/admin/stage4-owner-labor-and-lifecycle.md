# Stage 4 — owner labor workflow and closeout lifecycle

## Part 1 — the owner labor workflow

### The nine steps

1. **Open `/admin/staff`.** Owner session only; a manager is not sent the rate
   values at all.
2. **Select `Edit rates`** on the owner's card.
3. **Enter the owner labor rate** — what that hour is worth if it had to be
   hired. Current production values: **Diego $30.00/h, Sebastian $30.00/h**.
4. **Save.** `PATCH /api/admin/staff/[id]/rates` → `evaluateRateChange` →
   `User.ownerEconomicRateCents` + `rateUpdatedById/At`, audited as
   `LABOR_RATE_CONFIGURED` with before and after.
5. **Assign the owner to the job with worker type `OWNER`.**
   `POST /api/admin/jobs/[id]/crew` with `workerType: "OWNER"` and
   `payModel: "UNPAID_OWNER"`. **This is where the rate freezes** —
   `buildRateSnapshot` writes `economicRateCentsSnapshot` onto the `JobCrew` row
   and never reads the profile again for that assignment.
6. **Record worked time and breaks** — clock in/out via
   `/api/admin/crew-assignments/[id]/clock`, or a manual entry with a reason.
   `recalcAssignment` derives `workedMinutes`, `paidMinutes` and the overtime
   split.
7. **Verify the frozen rate is used.** The closeout's "Unpaid owner labor
   (value)" line = `paidMinutes / 60 × economicRateCentsSnapshot`.
8. **Finalize.** Writes `FinancialSnapshot` v1 and freezes `businessRetainedBp`
   onto the closeout.
9. **Confirm later rate changes do not alter the finalized version.** Change the
   rate on `/admin/staff` and reload the move: v1 is byte-for-byte unchanged,
   because reports and the panel read `allocationFromSnapshot`, which consults no
   live configuration.

### What happens when…

| Situation | Behaviour |
| --- | --- |
| **No owner rate exists** | `buildRateSnapshot` writes `economicRateCentsSnapshot = null`. Owner economic labor is $0 and the dashboard shows **Financial setup required**. If the assignment has hours and no applicable rate of any kind, `laborState = MISSING_RATE` → **HARD** `LABOR_MISSING_RATE`. Never treated as free work. |
| **No labor recorded at all** | `laborState = NOT_ASSIGNED` → `LABOR_MISSING` (**OVERRIDABLE**, reason required). Profit would be overstated and the blocker says so. |
| **Hours exist but no applicable rate** | `laborState = MISSING_RATE` → **HARD** `LABOR_MISSING_RATE`. No override clears it; the rate must be entered. |
| **Rate changes BEFORE finalization** | The assignment keeps its snapshot from assignment time. To apply a new rate to an open move, change the rate snapshot explicitly (`labor.edit_rate_snapshot`, owner-only, reason recorded in `rateAdjustReason`). Editing the profile alone does nothing to an existing assignment — deliberately. |
| **Rate changes AFTER finalization** | Nothing moves. The snapshot holds the resolved figures and `allocationLines`; `configSource`/`configVersion` record which policy produced them. |
| **Closeout is reopened** | v1 gets `supersededAt` at the NEXT finalization and is retained forever. Status → `REOPENED`, `reopenReason` stored, `finalizedAt/ById` cleared. Reports treat the move as provisional again. |
| **Version 2 is created** | New row, `version = 2`, computed from current facts (including any late expense). v1 keeps its own values and its own `allocationLines`. `@@unique([closeoutId, version])` makes a duplicate impossible. |

### The separation that matters

`economicRateCentsSnapshot` drives **economic profit only**. It is not cash, not
a payable, not a draw, and not the 30% allocation. Owners are paid from the
allocation, which is computed on `companyNetProfit` — a figure that does **not**
subtract owner economic labor. Deducting it before the split would pay the owners
twice.

---

## Part 2 — the closeout lifecycle

### States (`CloseoutStatus`)

`NOT_STARTED` → `IN_PROGRESS` → `MISSING_INFORMATION` → `READY_FOR_REVIEW` →
`READY_TO_FINALIZE` → `FINALIZED` → `REOPENED`

Stored status is never trusted on its own. `deriveCloseoutStatus` recomputes what
it SHOULD be from current reality, so a stale row cannot claim a move is ready:

```
finalized                          → FINALIZED
not started                        → NOT_STARTED
hard or unresolved blockers        → REOPENED if reopened, else MISSING_INFORMATION
submitted                          → READY_TO_FINALIZE
otherwise                          → READY_FOR_REVIEW
```

### Transitions

| From | Action | To | Guard |
| --- | --- | --- | --- |
| NOT_STARTED | `START` | IN_PROGRESS | `closeout.edit` |
| any editable | `CONFIRM_TRUCK` / `WRITE_OFF_BALANCE` / `ACK_DISPUTE` / `SET_OVERHEAD` / `SET_TAX_RESERVE` / `ADD_RESERVE` / `SET_SPLIT` | unchanged | `canEditCloseoutInputs` + per-action owner guards |
| any editable | `OVERRIDE` | unchanged | `canOverrideBlocker` — owner, reason, blocker active AND overridable |
| editable | `SUBMIT` | READY_FOR_REVIEW | `closeout.submit` |
| READY_TO_FINALIZE / READY_FOR_REVIEW | `FINALIZE` | FINALIZED **+ snapshot** | `canFinalizeCloseout` |
| FINALIZED | `REOPEN` | REOPENED | `canReopenCloseout` — owner + reason |
| REOPENED | `FINALIZE` | FINALIZED **+ snapshot v+1** | as above |

### Invalid transitions, and what stops them

| Attempt | Refused by | Status |
| --- | --- | --- |
| Finalize with a HARD blocker | `canFinalizeCloseout` | 422 |
| Finalize with an un-overridden overridable blocker | `canFinalizeCloseout` | 422 |
| Finalize an already-finalized move | `canFinalizeCloseout` | 409 |
| Finalize as MANAGER | `canFinalizeCloseout` | 403 |
| Two people finalize at once | `@@unique([closeoutId, version])` → `isConcurrentFinalize` | 409, with a message saying the move IS finalized by the other person |
| Edit inputs on a finalized move | `canEditCloseoutInputs` | 409 |
| Reopen without a reason | `canReopenCloseout` | 422 |
| Reopen a move that is not finalized | `canReopenCloseout` | 422 |
| Override a HARD blocker | `canOverrideBlocker` | 422 |
| Override a blocker that is not active | `canOverrideBlocker` | 422 |
| Reserves exceeding profit | `canSetReserves` | 422 |
| Second closeout for one booking | `MoveCloseout.bookingId` unique | DB constraint |

### Finalization, precisely

`FINALIZE` **rebuilds the view server-side** before deciding — the client's
opinion of readiness is never trusted — then, in ONE transaction:

1. supersede the previous snapshot (`supersededAt`, `supersededById`)
2. write the new snapshot at `version = previous + 1`, including
   `allocationLines`, `configSource`, `configVersion`, `calculationVersion`
3. set the closeout to `FINALIZED` and freeze `businessRetainedBp`
4. write `CLOSEOUT_FINALIZED` with the snapshot id, version, net profit,
   distributable profit and every override used

If the transaction fails on the version unique index, the loser gets a 409 that
explains the move is finalized — not a generic error.

### Reopening, precisely

Sets `REOPENED`, `reopenedAt/ById`, `reopenReason`, and clears `finalizedAt/ById`.
It does **not** touch the existing snapshot: v1 stays current (and therefore
readable) until v2 is written, at which point v1 becomes superseded. Audited as
`CLOSEOUT_REOPENED` with the superseded version and its net profit.

### Current-version selection

Readers take the snapshot with `supersededAt = null`:

* `closeout-service.buildCloseoutView` — for the panel, the job page and the
  printable summary
* `reporting-service.MOVE_SELECT` — `snapshots: { where: { supersededAt: null }, take: 1 }`
* `loadPricingComparables` — `where: { supersededAt: null }`

A move is read from its snapshot only when `closeout.status === 'FINALIZED'`
**and** a current snapshot exists. Otherwise it is provisional and labelled so.
