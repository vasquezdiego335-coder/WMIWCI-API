# Labor payments

**This is labor payment TRACKING, not payroll.** It records that money moved. It
does not withhold, file or report taxes and is not a substitute for payroll
software.

## Model

`labor_payments` — one row per payment against one assignment. Partial payments
are first-class. `JobCrew.paymentStatus` is **derived** from the non-voided rows,
never a mutable total that can drift.

Methods: CASH · ZELLE · VENMO · CASHAPP · CHECK · BANK_TRANSFER · CARD · OTHER.
Each row carries amount, method, date, reference, notes, proof URL and who
recorded it.

## Rules

- **Approval is the gate.** You cannot pay an amount nobody agreed to.
- **Partial payments:** approve $400, pay $250 → $150 remains owed and is held
  back from distributable cash.
- **Overpayment** is blocked unless explicitly confirmed *and* accompanied by a
  note.
- **Voiding never deletes.** The row stays forever, flagged, with who voided it
  and why. Owner-only.
- **A payment never creates an `Expense` row.** Labor is recognized once, when
  accrued (`docs/financial-architecture.md`). Paying moves cash and clears a
  liability — it is not a second cost.

## Effect on money

| Event | Job profit | Business cash | Safe to distribute |
| --- | --- | --- | --- |
| Labor approved | cost appears | unchanged | reduced (held back as owed) |
| Labor paid | **unchanged** | reduced | **unchanged** |

The middle row is the Phase 0 regression this preserves: settling a worker must
never raise the distributable figure.
