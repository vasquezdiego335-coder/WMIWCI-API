# Stage 4 — permissions and auditing

Source of truth: `src/lib/permissions.ts`. Policy: **OWNER does everything.
MANAGER runs operations but has no owner-financial authority. CREW has three
self-service labor rights and is blocked from `/admin` entirely by middleware.**

`can(role, action)` is the only gate. Hiding a control in the UI is never the
control — every sensitive route calls `can()` server-side, and report responses
are additionally stripped field-by-field by `shapeForRole`.

## Who can do what

| Capability | Action | OWNER | MANAGER | CREW |
| --- | --- | --- | --- | --- |
| See the closeout tab and its numbers | `closeout.view` | ✅ | ✅ | ❌ |
| Reconcile expenses / receipts / truck source | `closeout.edit` | ✅ | ✅ | ❌ |
| Submit a closeout for review | `closeout.submit` | ✅ | ✅ | ❌ |
| **Finalize** (writes the snapshot) | `closeout.finalize` | ✅ | ❌ | ❌ |
| **Reopen** a finalized move | `closeout.reopen` | ✅ | ❌ | ❌ |
| **Override a blocker** (incl. the internal-test rehearsal) | `closeout.override_blocker` | ✅ | ❌ | ❌ |
| Set overhead / reserves / owner split | `closeout.set_overhead`, `set_reserves`, `set_owner_split` | ✅ | ❌ | ❌ |
| See company profit | `money.view_company_profit` | ✅ | ❌ | ❌ |
| See the owner ledger | `money.view_owner_ledger` | ✅ | ❌ | ❌ |
| See per-job profit | `money.view_job_profit` | ✅ | ✅ | ❌ |
| Edit business config | `money.edit_business_config` | ✅ | ❌ | ❌ |
| **Manage staff rates** (incl. owner labor value) | `labor.set_owner_labor_value` | ✅ | ❌ | ❌ |
| Change a FROZEN historical rate | `labor.edit_rate_snapshot` | ✅ | ❌ | ❌ |
| Assign crew / edit an assignment | `labor.assign_crew`, `labor.edit_assignment` | ✅ | ✅ | ❌ |
| Enter hours for anyone | `labor.enter_hours` | ✅ | ✅ | ❌ |
| Clock in/out on one's OWN assignment | `labor.clock_self` | ✅ | ✅ | ✅ |
| Submit one's own hours | `labor.submit_hours` | ✅ | ✅ | ✅ |
| View one's own labor and pay | `labor.view_own_labor` | ✅ | ✅ | ✅ |
| View everyone's hours and pay | `labor.view_all_labor` | ✅ | ✅ | ❌ |
| **Approve labor** | `payroll.approve` | ✅ | ❌ | ❌ |
| Mark labor paid | `payroll.mark_paid` | ✅ | ❌ | ❌ |
| Confirm $0 labor | `labor.confirm_zero_labor` | ✅ | ❌ | ❌ |
| Void a labor payment | `labor.void_payment` | ✅ | ❌ | ❌ |
| Approve / reject an expense | `money.approve_expense` | ✅ | ✅ | ❌ |
| Edit a FINALIZED expense | `money.edit_finalized_expense` | ✅ | ❌ | ❌ |
| Delete an expense | `money.delete_expense` | ✅ | ❌ | ❌ |
| Plan / approve / pay / void a distribution | `distribution.*` | ✅ | ❌ | ❌ |
| Financial reports (P&L, company profit) | `report.view_financial` | ✅ | ❌ | ❌ |
| Operational reports | `report.view_operational` | ✅ | ✅ | ❌ |
| Owner-money and worker-pay reports | `report.view_owner_money`, `report.view_worker_pay` | ✅ | ❌ | ❌ |
| Export a profit/pay report | `report.export_sensitive` | ✅ | ❌ | ❌ |
| View the audit log | `audit.view` | ✅ | ❌ | ❌ |

**A crew member has no admin access at all** — `middleware.ts` blocks `/admin`
and `/api/admin` for the CREW role. The three CREW permissions exist so a future
crew-facing surface is built on an already-correct rule, and so `can()` never
accidentally answers true for a worker. Route-level ownership ("is this YOUR
assignment?") is checked at the route, because a permission matrix cannot express
"own".

## What is masked from a manager

Three layers, not one:

1. **Route access** — owner-only actions return 403.
2. **Response shaping** — `shapeForRole` walks every report response and drops
   `OWNER_ONLY_FIELDS`: `companyNetProfitCents`, `economicNetProfitCents`,
   `economicProfitCents`, `cashGrossProfitCents`, `ownerEconomicLaborCents`,
   `crewLaborCents`, `taxReserveCents`, `businessReserveCents`,
   `retainedEarningsCents`, `distributableProfitCents`, `marginBp`,
   `finalizedNetProfitCents`, `provisionalNetProfitCents`, `profitRoasBp`,
   `netOfSpendCents`, `averageProfitPerMoveCents`.
3. **Export columns** — every allocation column
   (`companyNetProfit`, `businessRetained*`, `diegoAllocation`,
   `sebastianAllocation`, `roundingRemainder`) is tagged `roles: ['OWNER']` and
   filtered by `visibleColumns` before a single cell is written.

Rate values are additionally not even **queried** for a non-owner session on
`/admin/staff` — the `select` is conditional on the role.

## Audit actions and when they fire

| Action | Fires when | Key details recorded |
| --- | --- | --- |
| `JOB_CREATED` | `ensureJobForBooking` creates a Job — exactly once, race-safe via a count check | jobId, source, previous/new state |
| `CLOSEOUT_STARTED` | `START` | closeoutId |
| `CLOSEOUT_TRUCK_SOURCE_CONFIRMED` | `CONFIRM_TRUCK` | previous, next |
| `CLOSEOUT_BALANCE_WRITTEN_OFF` | `WRITE_OFF_BALANCE` | previous outstanding, write-off, **reason** |
| `CLOSEOUT_DISPUTE_ACKNOWLEDGED` | `ACK_DISPUTE` | disputed cents |
| `OVERHEAD_METHOD_SELECTED` | `SET_OVERHEAD` | previous, next, amount, reason |
| `TAX_RESERVE_CHANGED` | `SET_TAX_RESERVE` | previous, next, bp, reason |
| `BUSINESS_RESERVE_CHANGED` | `ADD_RESERVE` | kind, amount, reason, `planned: true` |
| `OWNER_SPLIT_CHANGED` | `SET_SPLIT` | previous, next, shares, reason |
| `CLOSEOUT_OVERRIDE_USED` | `OVERRIDE` | code, **reason**, previous overrides |
| `CLOSEOUT_REHEARSAL` | `OVERRIDE` of `NO_PAYMENT_DATA` on an internal-test move | reason, `internalTest: true`, the side effects that did NOT happen, `excludedFromReporting: true` |
| `CLOSEOUT_SUBMITTED` | `SUBMIT` | blocker codes |
| `CLOSEOUT_FINALIZED` | `FINALIZE` | snapshot id, **version**, company net profit, distributable profit, every override used |
| `CLOSEOUT_REOPENED` | `REOPEN` | **reason**, superseded version, its net profit |
| `LABOR_RATE_CONFIGURED` | `PATCH /api/admin/staff/[id]/rates` | target user, **before and after of every field that moved**, `historicalRatesUnchanged: true` |
| `BUSINESS_CONFIG_UPDATED` | `PATCH /api/admin/business-config` | changed keys **and values** |
| `CREW_*` (assigned, updated, cancelled, accepted, declined, clock in/out, break, hours edited/submitted/approved/rejected, rate snapshot changed, zero labor confirmed, owner labor valued, payment recorded/voided) | the corresponding labor route | actor, target, before/after |
| `REPORT_EXPORTED` | any export attempt, success or failure | report, format, period, basis, filters, **column keys**, record count — deliberately **never the contents** |

Two deliberate choices worth knowing:

* **An audit failure never blocks the operation it describes** in
  `ensureJobForBooking` (`.catch(() => {})`) — a logging outage must not stop a
  crew being assigned. Everywhere else the audit write is inside the same
  transaction as the change, so a financial mutation and its record land together
  or not at all.
* **Export audits record the shape, not the data.** Logging the file would
  recreate the disclosure the export controls exist to prevent.
