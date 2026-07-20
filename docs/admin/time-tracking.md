# Time tracking

**Time is stored as INTEGER MINUTES.** Float hours are a display format only; the
legacy `JobCrew.actualHours` / `scheduledHours` columns are derived mirrors kept
in sync for pre-Phase-1 readers, never the source of truth.

## Two entry methods

**A — Manual owner entry.** Hours, break and travel typed on the Crew & Labor
panel. Always available, even where clocking is.

**B — Clock in / out.** `POST /api/admin/crew-assignments/[id]/clock` with
`CLOCK_IN | CLOCK_OUT | BREAK_START | BREAK_END`. One action per tap. An open
break is auto-closed at clock-out rather than silently lost.

## Calculation

```
elapsed  = clockOut − clockIn          (or manual worked + breaks)
worked   = elapsed − breaks
overtime = max(0, worked − overtimeThresholdMinutes)    default 480 (8h)
regular  = worked − overtime
paid     = regular + overtime + travel-paid-at-regular
```

Worked example: 8:00 → 17:00 with a 30-minute break = 9h elapsed, **8h 30m paid**.

## Travel policy (per assignment)

| Policy | Effect |
| --- | --- |
| `REGULAR` (default) | paid at the regular rate, included in `paidMinutes` |
| `SEPARATE_RATE` | paid at `travelRateCentsSnapshot`, **excluded** from `paidMinutes` |
| `UNPAID` | recorded for analysis, never paid |

Travel lives in exactly one bucket, so it can never be paid twice.

## Validation — ERROR blocks, WARNING routes to review

**ERRORS** (422, nothing written): clock-out before clock-in · clock-out with no
clock-in · future timestamp · negative break/hours/travel · break longer than the
shift · time with no rate · worker not assigned · cancelled assignment.

**WARNINGS** (saved, approval → `NEEDS_REVIEW`): shift longer than
`longShiftReviewMinutes` (default 14h) · missing clock-out · travel longer than
work · overlapping shift for the same worker.

A long move day is legitimate and is never rejected — that is exactly why the two
severities exist.

## Audit

Every clock action, manual edit and adjustment writes an `AuditLog` row with
before → after values, the reason where one is required, and who did it.
