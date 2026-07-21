# Financial finalization

## What finalizing does

1. Rebuilds the closeout view from live records (the client is not trusted).
2. Re-checks every blocker server-side.
3. Verifies owner permission.
4. Writes an **immutable** `FinancialSnapshot`, superseding the previous version.
5. Sets status FINALIZED with who and when.
6. Writes a `CLOSEOUT_FINALIZED` audit row including every override used.
7. Locks closeout inputs against casual editing (409 until reopened).

It sends no emails.

## What a finalized move may still have

Unpaid crew labor, an unpaid owner distribution, or a written-off receivable -
each **disclosed** on the panel and held back from distributable profit. What it
may NOT have is unapproved labor, unknown refunds, or missing payment data;
those are HARD blockers.

## Reopening

Owner-only, reason required. Preserves the prior snapshot as **superseded**,
unlocks the inputs, and requires finalizing again - producing v2 and a visible
before/after (staging Scenario 7: v1 $740.00 -> v2 $728.00 after a late $12 toll).

## Why snapshots exist

Changing a worker rate, an ownership percentage, a reserve percentage or an
overhead policy must never silently rewrite a move that was already closed.
Historical truth reads from the snapshot; the live view is shown alongside it so
the owner can see what drifted.
