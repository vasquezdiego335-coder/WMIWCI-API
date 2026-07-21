# Move closeout workflow

## States

```
NOT_STARTED -> IN_PROGRESS -> MISSING_INFORMATION -> READY_FOR_REVIEW
            -> READY_TO_FINALIZE -> FINALIZED
                                      |
                                      +-> REOPENED -> ... -> FINALIZED (v2)
```

The stored status is never trusted on its own. `deriveCloseoutStatus` recomputes
it from live blockers, so a stale `READY_TO_FINALIZE` row re-derives to
`MISSING_INFORMATION` the moment something breaks.

## Actions (all on `POST /api/admin/closeout/[bookingId]`)

| Action | Who | Requires |
| --- | --- | --- |
| `START` | owner / manager | - |
| `CONFIRM_TRUCK` | owner / manager | a truck source |
| `WRITE_OFF_BALANCE` | owner | a reason |
| `ACK_DISPUTE` | owner / manager | - |
| `SET_OVERHEAD` | owner | a reason when MANUAL |
| `SET_TAX_RESERVE` | owner | must not exceed net profit |
| `ADD_RESERVE` | owner | must not exceed net profit |
| `SET_SPLIT` | owner | a reason when CUSTOM; must be valid |
| `OVERRIDE` | owner | a reason; only OVERRIDABLE blockers |
| `SUBMIT` | owner / manager | - |
| `FINALIZE` | **owner** | zero hard + zero unresolved blockers |
| `REOPEN` | **owner** | a reason |

## Checklist

The checklist is **derived, not stored** - every item is a blocker or its
absence, so it can never disagree with the numbers. Sections: revenue and
payments, refunds and disputes, crew labor, owner labor, truck and travel, other
expenses, receipts, owner reimbursements, reserves, owner split.

## Corrections after finalization

A finalized move is locked (`canEditCloseoutInputs` returns 409). Correcting it
means reopening with a reason, which preserves the prior snapshot as superseded
and produces a before/after history instead of a silent edit.
