# Stage 4 — data model

Every field below exists in `prisma/schema.prisma` on `main` @ `a4833a5b0`.
Nothing here is aspirational.

## Relationship diagram

```
Lead ──(converted)──▶ Customer ──1:N──▶ Booking ──1:1──▶ Job ──1:N──▶ JobCrew ──N:1──▶ User
                                          │                                 │
                                          │                                 └──1:N──▶ LaborPayment
                                          ├──1:N──▶ Payment  (refunds live ON the payment row)
                                          ├──1:N──▶ Expense  ──N:1──▶ User (approvedBy)
                                          └──1:1──▶ MoveCloseout
                                                       ├──1:N──▶ FinancialSnapshot   (versioned)
                                                       ├──1:N──▶ ReserveAllocation
                                                       └────────▶ OwnerDistribution  (by bookingId)

AuditLog ──▶ Booking (bookingId, nullable) and User (userId, nullable)
BusinessConfig — singleton row, id = "singleton"
```

`Lead` is a marketing record; it is **not** in the financial chain and never
contributes money.

## `MoveCloseout` — workflow, not money

`id` · `bookingId` **unique** (one closeout per move, enforced by the database)
· `status` (`CloseoutStatus`)

Lifecycle: `startedAt/ById`, `submittedAt/ById`, `finalizedAt/ById`,
`reopenedAt/ById`, **`reopenReason`**

Human confirmations — these exist because their ABSENCE is meaningful:
`truckSource` (`TruckSource?`), `truckSourceConfirmedAt/ById`,
`balanceWriteOffCents`, `balanceWriteOffReason`, `disputeAcknowledgedAt`

Per-move decisions: `overheadMethod`, `overheadAmountCents`, `overheadReason`,
`taxReserveBp`, `taxReserveCents`, `taxReserveReason`, `splitMethod`,
`splitReason`, **`businessRetainedBp`** (frozen at finalization)

`overrides` JSON — `[{ code, reason, byId, byName, at }]`, never a bare boolean.

## `FinancialSnapshot` — the immutable record

`id` · `closeoutId` · `bookingId` · `version`
**`@@unique([closeoutId, version])`** — the constraint that makes a concurrent
double-finalize impossible rather than merely unlikely.
`@@index([bookingId])`, `@@index([supersededAt])`
`closeout MoveCloseout @relation(onDelete: Cascade)`

| Group | Fields |
| --- | --- |
| Revenue | `netBilledRevenueCents`, `netCollectedRevenueCents`, `outstandingBalanceCents`, `refundedCents`, `chargebackCents`, `disputedOpenCents` |
| Costs | `directExpenseCents`, `crewLaborCents`, `ownerCashLaborCents`, `ownerEconomicLaborCents`, `processingFeeCents`, `truckCostCents`, `directJobCostCents` |
| Profit | `cashGrossProfitCents`, `economicProfitCents`, `allocatedOverheadCents`, `companyNetProfitCents`, `economicNetProfitCents`, `marginBp?` |
| Allocation | `taxReserveCents`, **`businessRetainedBp`**, **`businessRetainedCents`**, **`roundingRemainderCents`**, `businessReserveCents`, `retainedEarningsCents`, `unresolvedLiabilityCents`, `distributableProfitCents`, `ownerAllocations` JSON, **`allocationLines`** JSON |
| Provenance | `overheadMethod`, `overheadRateRaw?`, `taxReserveBp?`, `splitMethod?`, `incompleteFlags` JSON, `calculationVersion`, **`configSource`**, **`configVersion`** |
| Versioning | `supersededAt?`, `supersededById?`, `createdById?`, `createdByName?`, `createdAt` |

`allocationLines` stores the 40/30/30 lines **as presented**, so a report can
restate the move without consulting live configuration.

## `JobCrew` — the labor record Stage 4 reads

`@@unique([jobId, userId])`. Relevant to Stage 4:

* **Worker type** — `workerType` (`CrewWorkerType`: OWNER / EMPLOYEE /
  CONTRACTOR / TEMP_HELPER) and `role` (`CrewRole`)
* **Frozen rates** — `payModel`, `hourlyRateCentsSnapshot`,
  `overtimeRateCentsSnapshot`, `flatPayCentsSnapshot`, `dayRateCentsSnapshot`,
  `travelRateCentsSnapshot`, **`economicRateCentsSnapshot`**, `rateSnapshotAt`,
  `rateSnapshotSource`, `rateAdjustedById/At/Reason`
* **Time** — `clockIn`, `clockOut`, `breakStartedAt`, `actualBreakMinutes`,
  `workedMinutes`, `regularMinutes`, `overtimeMinutes`, `travelMinutes`,
  `paidMinutes`, `timeEntrySource`, `timeAdjustedById/At/Reason`
* **Approval** — `approvalStatus` (`LaborApprovalStatus`), `submittedAt/ById`,
  `approvedAt/ById`, `rejectedReason`, `adjustmentReason`, `calculatedPayCents`,
  `approvedPayCents`
* **Zero-labor assertion** — `zeroLaborConfirmed` + `ById` + `At` + `Reason`
* **Payment** — `paymentStatus`, `laborPayments[]`

## `User` — the rate configuration (Stage 4 additions)

`ownerEconomicRateCents?` · `defaultPayModel?` (`LaborPayModel`) ·
`rateEffectiveOn?` · `rateNotes?` · `rateUpdatedById?` · `rateUpdatedAt?` ·
`canDrive` (default false) · `canLeadCrew` (default false)

Alongside the pre-existing `payRate?`, `defaultFlatRateCents?`, `workerType`,
`preferredRole?`, `active`.

**Every rate column is nullable with no default.** Unset is UNKNOWN, never $0.

## `Payment` — Stage 4 additions

`method?` (`PaymentMethod`, includes the new `STRIPE` value), indexed as
`payments_method_idx`. Nullable on purpose: historical rows predate the column
and their method is genuinely unknown.

## `BusinessConfig` — singleton

`diegoSplitPercent` (50) · `sebastianSplitPercent` (50) · `taxReservePercent` ·
`emergencyReserveCents` · **`generalReserveBp`** (the company-retained share) ·
`ownerEconomicRateCents` (business-wide fallback, column default 3000) ·
`overtimeThresholdMinutes` (480) · `overtimeMultiplierPct` (150) ·
`longShiftReviewMinutes` (840) · `overheadMethod` + its four rate fields ·
`receiptRequiredAboveCents` (2500)

⚠️ `ownerEconomicRateCents` carries a **column default of 3000** ($30/h) that
nobody chose. Stage 4 stopped treating it as evidence of configuration —
`financial-setup` requires a per-owner `User.ownerEconomicRateCents` instead.

## Delete behaviour

* `FinancialSnapshot` → `onDelete: Cascade` from `MoveCloseout`
* `ReserveAllocation` → `onDelete: Cascade` from `MoveCloseout`
* `Booking → MoveCloseout` and `Job → JobCrew` use the default (Restrict), so a
  move with financial history cannot be deleted out from under it
* Nothing in the closeout path performs a hard delete. Superseding, voiding and
  rejecting are the only ways a record leaves consideration.

## Migrations

| Migration | Adds |
| --- | --- |
| `20260721180000_stage4_payment_method_and_retained_share` | `PaymentMethod.STRIPE`, `AuditAction.JOB_CREATED`, `payments.method` + index, `move_closeouts.business_retained_bp`, snapshot `business_retained_bp/cents` + `rounding_remainder_cents` (NOT NULL DEFAULT 0) |
| `20260721190000_stage4_labor_rate_configuration` | 8 `users` columns, `AuditAction.LABOR_RATE_CONFIGURED` |
| `20260721190100_stage4_snapshot_allocation_provenance` | snapshot `allocation_lines`, `config_source`, `config_version`, `AuditAction.CLOSEOUT_REHEARSAL` |

All three additive: every column nullable or defaulted, enum values added, no
backfill, no destructive change. Applied to production 2026-07-21.
