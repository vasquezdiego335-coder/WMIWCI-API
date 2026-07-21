# Owner distributions

A distribution is a share of **collected** profit. It is not an expense, not
labor pay, and not a reimbursement.

## Allocation vs payment

`approvedCents` is the decision; `paidCents` is the cash. They are separate
fields, partial payments are first-class, and a DB CHECK enforces
`paid_cents <= approved_cents`.

## Statuses

`PLANNED` -> `APPROVED` -> `PARTIALLY_PAID` -> `PAID`, or `VOIDED`.

## Rules

- **A distribution can only be authorized against a FINALIZED snapshot.** There
  is no distributing from live, still-moving numbers (422 if the move is not
  finalized).
- The amount is bounded by `snapshot.distributableProfitCents` minus everything
  already allocated on that move.
- Approving is owner-only; so is recording payment and voiding.
- Voiding never deletes - the row stays, flagged, with who and why.
- The system records decisions and cash movements. **It does not move money.**
