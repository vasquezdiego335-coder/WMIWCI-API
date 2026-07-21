# Action Center — financial wiring

Stage 2 defined closeout blockers; Stage 3 turns them into live Action Center
candidates.

## Rules

From blockers: missing payment - unknown refund - refund exceeds payment - labor
unapproved/missing/missing clock-out/missing rate - truck source missing - truck
cost missing - receipt missing - expenses pending - open dispute - outstanding
balance - reimbursement pending - allocation/reserves exceed profit.

Lifecycle: move not closed out (after a grace period, escalating) - ready to
finalize - ready for owner review - closeout reopened - distribution pending.

Profitability: move lost money - margin below target - labor payment pending -
estimate significantly off - lead source unknown.

Campaign: campaign missing spend.

## Dedupe and auto-resolve

Every candidate carries `<rule>:booking:<id>`. Re-scanning an unchanged condition
is a no-op. When the condition clears, the candidate stops being produced and
`resolvedKeys()` marks the orphan resolved — that is what makes automatic
resolution real rather than a promise.

**An OVERRIDDEN blocker raises nothing.** Re-alerting on a documented owner
decision is how people learn to ignore the Action Center.

A FINALIZED move raises nothing except a reopen notice or a pending distribution.

Colliding rules on one key collapse to the **most severe**.
