# Expense reconciliation

## Eligibility (Phase 0 rule, unchanged)

`APPROVED`, `REIMBURSED`, `SUBMITTED` and `NEEDS_REVIEW` count as real spend.
`REJECTED` counts **nowhere**. Rejected rows stay visible, struck through, in
both expense lists.

Unreviewed expenses are counted but raise `EXPENSES_PENDING_REVIEW`, so
"unreviewed" is never mistaken for "verified".

## Receipts

`BusinessConfig.receiptRequiredAboveCents` (default $25) decides when a missing
receipt blocks finalization. Below the threshold it is not raised at all; above
it, it is an OVERRIDABLE blocker an owner may document.

Receipt URLs are Cloudinary delivery URLs today. Signed, expiring access for
private financial documents is a known gap carried from the pre-audit.

## After finalization

Expenses on a finalized move cannot be edited casually - the closeout must be
reopened. The existing `financial-adjust.ts` workflow (owner + reason +
before/after audit) still governs edits to APPROVED/REIMBURSED expenses.
