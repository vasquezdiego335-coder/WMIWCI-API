# Owner reimbursements

An owner paying a business cost from personal money creates a **liability**, not
profit and not a draw.

## Accounting treatment (the double-count rule)

A single $150 truck expense paid personally by an owner is:

1. an **Expense** row -> reduces the move's profit **once**, and
2. an `OwnerTransaction` `PERSONAL_PURCHASE` -> creates reimbursement owed.

The reimbursement is then held back from **distributable profit** (as an
unresolved liability) until a `REIMBURSEMENT` transaction settles it.

**It is never subtracted twice.** The expense reduces profit; the reimbursement
reduces distributable cash. Verified by staging Scenario 4: the difference
between "owed" and "reimbursed" distributable profit is exactly $150.

## Rules

- A **rejected** expense creates no reimbursement.
- A reimbursement is **not** owner profit and **not** a draw.
- Reimbursements owed block finalization (OVERRIDABLE) so they are never
  forgotten.
- Statuses derive from the ledger: owed / partially reimbursed / reimbursed;
  rejected owner transactions count nowhere.
