# Stage 4 — troubleshooting

## "Profit looks too high"

Almost always one of three things, in order of likelihood:

1. **Labor is not recorded.** Cash gross profit with no labor cost is revenue
   minus expenses. Check the closeout for `LABOR_MISSING`, and check the
   dashboard's "moves missing labor" count.
2. **No overhead policy is configured.** With `overheadMethod = NONE`, "company
   net profit" equals GROSS profit. The Financial Overview says so in a warning
   when overhead is $0 across a period with moves.
3. **Owner labor is not valued.** If the owners worked and no owner rate is set,
   economic profit equals cash profit and the move looks better than it was.

## "Owner labor shows zero"

Check in this order:

1. Is the person assigned to the job **with `workerType: OWNER`**? An owner
   assigned as EMPLOYEE gets a cash rate path, not the economic one.
2. Does the assignment have `economicRateCentsSnapshot`? It is frozen at
   ASSIGNMENT. If the owner rate was set *after* the assignment was created, the
   snapshot is null and the value is $0.
   **Fix:** change the rate snapshot on the assignment (owner-only,
   `labor.edit_rate_snapshot`, reason recorded) — not the profile.
3. Are there `paidMinutes`? Value = `paidMinutes / 60 × economicRateCentsSnapshot`.
   No hours means no value, correctly.

## "Active crew members: 0"

**This is not an error.** Move It Clear It has two owners and no employees. Two
different things are being reported and they should not be confused:

* The **staff panel's** `ownerRatesReady` only requires that every OWNER has a
  rate. Zero crew does not make it false.
* The **dashboard's** setup checklist has a separate `crew_exists` item, so the
  "Financial setup required" banner will persist until a crew member is added.
  That is a prompt, not a gate, and it blocks nothing.

The real gate is the closeout: a move with **no labor at all** raises
`LABOR_MISSING` (overridable). When Diego and Sebastian do the work, assign them
as crew with worker type OWNER — that is what makes the labor real and the profit
honest.

## "Labor missing"

`laborState = NOT_ASSIGNED` or `ASSIGNED_NO_HOURS`. Either record the labor, or —
if the move genuinely had no labor cost — use the explicit **confirm $0 labor**
path (owner-only, reason required). `ZERO_CONFIRMED` and "nobody entered
anything" are different states and the system keeps them apart on purpose.

## "Labor rate missing"

`LABOR_MISSING_RATE`, **HARD**, no override. Somebody has hours that cannot be
priced. Set an hourly/flat/day rate on the assignment, or on the staff profile
and then re-snapshot the assignment. A missing rate is never treated as $0 —
that is the whole rule.

## "A rejected expense is included in costs"

It should be impossible: `money-rules.isEligibleExpense` filters on approval
status before any total. If you see one, check whether the expense is actually
`REJECTED` or merely unreviewed — unreviewed expenses raise
`EXPENSES_PENDING_REVIEW` and are excluded from costs but are NOT rejected.

## "An approved expense is excluded"

Check three things: it is linked to this booking; its category is eligible; and
it is not flagged `isInternalTest`. An expense on the customer's account but not
attached to the move will never appear in that move's costs.

## "The allocation does not total 100%"

For a POSITIVE net profit the three lines always sum to exactly
`companyNetProfitCents` — floors plus the remainder-to-business rule guarantee
it, and a test sweeps a range of odd amounts to prove it.

If a **period** total shows less than 40/30/30, that is correct and deliberate:
period percentages are derived from the dollars actually allocated. A period
containing a loss-making move shows a smaller realized share, because that move
allocated nothing while still contributing its loss to net profit.

## "A snapshot changed"

It cannot, and if it appears to have, you are almost certainly looking at the
**live** figures rather than the snapshot. The closeout panel shows both: the
frozen allocation with a `FINALIZED · SNAPSHOT Vn` badge, and a warning when live
recomputation now differs. Reports read `allocationFromSnapshot`, which consults
no live configuration at all.

To confirm: read the `financial_snapshots` row directly. `createdAt`,
`calculationVersion`, `configSource` and `configVersion` tell you which policy
produced it.

## "Reopening overwrote version 1"

It does not. `REOPEN` sets `REOPENED`, `reopenedAt/ById` and `reopenReason`, and
clears `finalizedAt/ById` — it does not touch the snapshot. v1 becomes
`superseded` only when v2 is written, and is retained forever. If v1 is genuinely
missing, that is a defect: capture the closeout id and the audit trail
(`CLOSEOUT_REOPENED` records the superseded version and its net profit) before
doing anything else.

## "There are two current versions"

`@@unique([closeoutId, version])` makes duplicate versions impossible, and
`writeSnapshot` supersedes the previous row inside the same transaction that
writes the new one. Two rows with `supersededAt = null` would mean the
transaction was bypassed. Do not "fix" it by editing rows: identify which version
the audit log says was finalized last, and escalate.

## "Audit records are missing"

`ensureJobForBooking`'s `JOB_CREATED` write is deliberately non-blocking — a
logging failure must not stop a crew being assigned — so that one can be absent
after an outage. Every closeout mutation writes its audit **inside the same
transaction** as the change, so those cannot go missing without the change also
being rolled back. If a `CLOSEOUT_FINALIZED` entry is missing but a snapshot
exists, escalate rather than patch.

## "Someone saw financial data they should not have"

Three layers should have stopped it: `can()` at the route, `shapeForRole` on the
response, and `roles: ['OWNER']` on the export column. Establish which surface
leaked before changing anything — the fix differs for each, and adding a UI
condition fixes none of them.

## "The dashboard setup banner will not go away"

Read the checklist rather than the headline. With two owners, both rates set and
no crew, `crew_exists` stays outstanding by design. Options: add a crew member
when you hire one, or accept the banner — it gates nothing.

## "The wrong worker type was used"

An owner assigned as EMPLOYEE gets a cash-rate path and their labor becomes a
payable; a crew member assigned as OWNER gets an economic rate and their labor
stops being a cash cost. Both distort the move. Fix the assignment's
`workerType`, then re-snapshot the rate (owner-only, reason recorded) and
re-approve the hours. If the move is already finalized, reopen it with a
reason — that creates version 2 and leaves version 1 intact, which is the correct
audit trail for a correction.
