# Phase 1 — JobCrew labor & time tracking (implementation)

**Owner spec 2026-07-20. Branch `claude/admin-phase1-jobcrew`, built on Phase 0
(`claude/admin-phase0-financial-integrity`, commit 83841528).**

Phase 0 made missing labor *visible*. Phase 1 makes it *enterable*, and makes
`JobCrew` the one financial answer to "what did this move cost in labor".

---

## 1. Canonical source of truth

`JobCrew` owns assignment state, hours, rate snapshots, approved labor cost and
payment status for **customer moves**. `profit.ts` reads it and nothing else.
The Discord `crew_jobs` gig board is for **non-move internal work** and has no
booking, no `Job`, and no app `User` — full analysis and the duplicate-prevention
design in **[discord-crew-integration.md](discord-crew-integration.md)**.

| Concern | Owner |
| --- | --- |
| Assignment state (a move) | `JobCrew` |
| Actual hours | `JobCrew` (integer minutes) |
| Rate snapshots | `JobCrew` |
| Approved labor cost | `JobCrew.approvedPayCents` |
| Payment status | `JobCrew.paymentStatus`, derived from `labor_payments` |
| What profit reads | `JobCrew` — **never** `crew_jobs` |

## 2. Modules

| File | Role |
| --- | --- |
| `src/lib/labor-time.ts` | Time math in **integer minutes** + two-severity validation (ERROR blocks, WARNING routes to review) |
| `src/lib/labor-calc.ts` | Pay math, rate snapshots, cash-vs-economic owner labor, job rollup, the `crew_jobs` adapter |
| `src/lib/labor-guards.ts` | The pure route decisions (approval, rate change, payment, $0, assignment, time authority) |
| `src/lib/labor-service.ts` | The only labor module that touches Prisma; recomputes every derived column |
| `src/lib/money-rules.ts` | Extended: `isLiveAssignment`, `isApprovedLabor`, snapshot-aware `hasPaySignal` |
| `src/lib/financial-completeness.ts` | Extended: 8 distinct `LaborState`s replace a generic "$0" |
| `src/lib/profit.ts` / `job-money.ts` | Consume the labor rollup; add economic profit |

## 3. Accounting rules

- **Only APPROVED labor is a cost.** DRAFT/SUBMITTED labor is shown and warned
  about but never counted — an unagreed number is not a liability.
- **Only the snapshot prices a move.** `User.payRate` seeds a snapshot at
  assignment and is never read again for that assignment.
- **Labor is recognized once, when accrued.** Recording a payment moves cash and
  clears a liability; it never writes an `Expense` row.
- **Paid labor leaves cash; unpaid labor is held back.** A row is one or the
  other, so the Phase 0 "paying a worker raises distributable cash" bug cannot
  return.
- **Owner labor is never assumed free.** `UNPAID_OWNER` costs $0 cash and carries
  an economic value at the replacement rate.
- **Travel is paid in exactly one bucket** (regular / separate rate / unpaid).

## 4. Formulas

```
HOURLY          regular×rate + overtime×otRate + travel + bonuses + reimbursement
FLAT            flat snapshot + bonuses
DAY_RATE        day rate + bonuses
UNPAID_OWNER    cash $0; economic = paid minutes × economic rate
ZERO_CONFIRMED  cash $0; economic $0 (deliberate, owner-confirmed, audited)
CUSTOM          the owner-approved amount

paid minutes = regular + overtime + travel-paid-at-regular
overtime     = worked − overtimeThresholdMinutes (default 480), 0 when disabled

move cash gross profit = net revenue − approved cash labor − eligible expenses − Stripe fees
move economic profit   = cash gross profit − unpaid owner labor value
```

## 5. Statuses

- **Assignment** INVITED / OFFERED / ACCEPTED / DECLINED / ASSIGNED / IN_PROGRESS /
  COMPLETED / CANCELLED / NO_SHOW — DECLINED, CANCELLED and NO_SHOW contribute no labor
- **Approval** DRAFT → SUBMITTED → APPROVED, or NEEDS_REVIEW / REJECTED
- **Payment** UNPAID / PARTIALLY_PAID / PAID / VOIDED — derived from non-voided `labor_payments`
- **Labor state** (completeness) NOT_ASSIGNED · ASSIGNED_NO_HOURS · MISSING_CLOCK_OUT ·
  MISSING_RATE · HOURS_UNAPPROVED · APPROVED_UNPAID · PAID · ZERO_CONFIRMED

Blocking states for finalization: missing labor, missing clock-out, missing rate,
unapproved hours, missing payment data. An owner may override with a reason.

## 6. Known limitations

- **No migration has been applied.** It is written and additive; it needs
  `npm run db:migrate:prod` (see [phase1-staging-plan.md](phase1-staging-plan.md)).
- Route tests are **contract tests over the pure guards the routes call**, not
  HTTP-level integration tests — there is no test database in this environment.
- CREW is still blocked from `/admin` by middleware, so worker self-service needs
  the Phase 4 crew portal. Its permission rules are built and tested here.
- Overtime is a **house policy** (8h/day, 1.5×), configurable per business — not
  a jurisdictional payroll rule.
- **This is labor payment tracking, not payroll.** No tax withholding, filing or
  reporting.
- Only the Crew & Labor panel is mobile-optimized; the rest of the admin keeps
  the fixed 230px desktop sidebar (Phase 4).
- The gig-board leakage (completed `crew_jobs` payouts reaching no ledger)
  remains open — see discord-crew-integration.md for the recommended fix.
