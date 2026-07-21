# Crew assignment workflow

## Owner / manager assignment

1. Open the move → **Crew & Labor** → *Add crew member*.
2. Pick the worker (active users only), role and pay model.
3. The profile rate prefills; typing a rate overrides it.
4. On save the **rate snapshot is frozen** onto the assignment
   (`rateSnapshotAt`, `rateSnapshotSource`) and `CREW_ASSIGNED` is audited with
   the full snapshot.

`POST /api/admin/jobs/[bookingId]/crew` — the `Job` row is created on demand, so
crew can be assigned before the move starts.

## Guards (all pure + tested, `labor-guards.ts`)

- Owner or manager only.
- A deactivated worker cannot be assigned.
- One active assignment per worker per move (DB unique index `(jobId, userId)`;
  a previously cancelled row is **revived**, never duplicated).
- An HOURLY worker with no rate anywhere is refused — free labor is never assumed.
- `UNPAID_OWNER` needs no rate; that model is deliberate.
- Overlapping shifts for one worker are warned, not blocked.

## Lifecycle

```
ASSIGNED → IN_PROGRESS → COMPLETED
    ↘ CANCELLED (reason required) / DECLINED / NO_SHOW → contribute no labor
```

## Removal

An assignment with recorded payments or approved labor **cannot be deleted** — it
is cancelled with a reason, preserving history. Only a DRAFT assignment with no
payments can be removed outright.

## Discord gig board

`crew_jobs` acceptances do **not** create `JobCrew` rows today, because a gig has
no booking. The adapter and its guarantees are documented in
[discord-crew-integration.md](discord-crew-integration.md).
