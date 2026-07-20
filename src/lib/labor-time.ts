// ============================================================================
// labor-time.ts — THE time math for crew labor (Phase 1, owner spec 2026-07-20).
//
// TIME IS INTEGER MINUTES. Floating-point hours are a display format, never a
// stored truth: 8.1 hours is ambiguous, 486 minutes is not. The legacy
// JobCrew.actualHours / scheduledHours Floats are derived mirrors kept in sync
// for older readers.
//
// Pure functions — no Prisma, no I/O, no Date.now() except where passed in — so
// every rule is unit-testable offline (src/lib/__tests__/labor-time.test.ts).
// ============================================================================

export const MINUTES_PER_HOUR = 60

/** Default house policy; overridden per-business by BusinessConfig. */
export interface TimePolicy {
  overtimeThresholdMinutes: number // minutes in a day past which OT applies; 0 = no OT
  longShiftReviewMinutes: number // flag (not reject) shifts longer than this
}

export const DEFAULT_TIME_POLICY: TimePolicy = {
  overtimeThresholdMinutes: 480, // 8h
  longShiftReviewMinutes: 840, // 14h
}

/** How travel time is treated for THIS assignment. */
export type TravelPolicy = 'UNPAID' | 'REGULAR' | 'SEPARATE_RATE'

export const minutesToHours = (m: number): number => Math.round((m / MINUTES_PER_HOUR) * 100) / 100
export const hoursToMinutes = (h: number): number => Math.round(h * MINUTES_PER_HOUR)

/** Whole minutes between two instants; negative when out of order. */
export function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000)
}

/** "8h 30m" / "45m" / "0m" — for the UI, never for storage. */
export function formatMinutes(minutes: number | null | undefined): string {
  const m = Math.max(0, Math.round(minutes ?? 0))
  const h = Math.floor(m / MINUTES_PER_HOUR)
  const rem = m % MINUTES_PER_HOUR
  if (h === 0) return `${rem}m`
  if (rem === 0) return `${h}h`
  return `${h}h ${rem}m`
}

export interface TimeInput {
  clockIn?: Date | null
  clockOut?: Date | null
  /** Direct entry when there is no clock pair (manual owner entry). */
  workedMinutesOverride?: number | null
  breakMinutes?: number | null
  travelMinutes?: number | null
  travelPayPolicy?: TravelPolicy
}

export interface TimeBreakdown {
  /** Wall-clock span, before breaks. */
  elapsedMinutes: number
  breakMinutes: number
  /** elapsed − breaks. The time actually spent working. */
  workedMinutes: number
  regularMinutes: number
  overtimeMinutes: number
  travelMinutes: number
  /** Travel minutes that are PAID at the regular rate (policy REGULAR only).
   *  Kept separate so travel is never counted in two buckets at once. */
  travelPaidAtRegular: number
  /** Travel minutes paid at their own rate (policy SEPARATE_RATE only). */
  travelPaidSeparately: number
  /** regular + overtime + travel-paid-at-regular. The billable total. */
  paidMinutes: number
}

/**
 * Split a shift into paid buckets.
 *
 *   elapsed        = clockOut − clockIn   (or workedMinutesOverride + breaks)
 *   worked         = elapsed − breaks
 *   regular + OT   = worked, split at the overtime threshold
 *   travel         = per the assignment's travel policy
 *
 * TRAVEL IS NEVER DOUBLE COUNTED: it lives in exactly one of
 * travelPaidAtRegular / travelPaidSeparately / neither (UNPAID), and only the
 * REGULAR bucket is folded into paidMinutes. Separate-rate travel is priced by
 * labor-calc.ts from travelPaidSeparately, which paidMinutes excludes.
 */
export function computeTimeBreakdown(input: TimeInput, policy: TimePolicy = DEFAULT_TIME_POLICY): TimeBreakdown {
  const breakMinutes = Math.max(0, Math.round(input.breakMinutes ?? 0))
  const travelMinutes = Math.max(0, Math.round(input.travelMinutes ?? 0))

  let elapsedMinutes: number
  if (input.workedMinutesOverride != null) {
    // Manual entry states WORKED time; elapsed is worked + breaks.
    elapsedMinutes = Math.max(0, Math.round(input.workedMinutesOverride)) + breakMinutes
  } else if (input.clockIn && input.clockOut) {
    elapsedMinutes = Math.max(0, minutesBetween(input.clockIn, input.clockOut))
  } else {
    elapsedMinutes = 0
  }

  const workedMinutes = Math.max(0, elapsedMinutes - breakMinutes)

  const threshold = policy.overtimeThresholdMinutes
  const overtimeMinutes = threshold > 0 ? Math.max(0, workedMinutes - threshold) : 0
  const regularMinutes = workedMinutes - overtimeMinutes

  const travelPolicy: TravelPolicy = input.travelPayPolicy ?? 'REGULAR'
  const travelPaidAtRegular = travelPolicy === 'REGULAR' ? travelMinutes : 0
  const travelPaidSeparately = travelPolicy === 'SEPARATE_RATE' ? travelMinutes : 0

  return {
    elapsedMinutes,
    breakMinutes,
    workedMinutes,
    regularMinutes,
    overtimeMinutes,
    travelMinutes,
    travelPaidAtRegular,
    travelPaidSeparately,
    paidMinutes: regularMinutes + overtimeMinutes + travelPaidAtRegular,
  }
}

// ── Validation ──────────────────────────────────────────────────────────────
//
// Two severities, deliberately. A long move day is legitimate and must not be
// rejected; a clock-out before clock-in is impossible and must be. ERRORS block
// the write; WARNINGS route the record to NEEDS_REVIEW.

export type TimeIssueLevel = 'ERROR' | 'WARNING'

export interface TimeIssue {
  level: TimeIssueLevel
  code: string
  message: string
}

export interface ValidationInput extends TimeInput {
  now?: Date
  assignmentStatus?: string
  /** Other assignments for the SAME worker, to detect overlaps. */
  otherShifts?: { start: Date; end: Date; label?: string }[]
  hasRate?: boolean
  isAssigned?: boolean
}

const err = (code: string, message: string): TimeIssue => ({ level: 'ERROR', code, message })
const warn = (code: string, message: string): TimeIssue => ({ level: 'WARNING', code, message })

/** Validate a time entry. Returns every issue found, most severe first. */
export function validateTimeEntry(input: ValidationInput, policy: TimePolicy = DEFAULT_TIME_POLICY): TimeIssue[] {
  const issues: TimeIssue[] = []
  const now = input.now ?? new Date()

  if (input.isAssigned === false) {
    issues.push(err('not_assigned', 'This worker is not assigned to this move.'))
  }
  if (input.assignmentStatus === 'CANCELLED') {
    issues.push(err('assignment_cancelled', 'This assignment was cancelled; time cannot be recorded against it.'))
  }

  if (input.clockOut && !input.clockIn) {
    issues.push(err('clock_out_without_in', 'There is a clock-out with no clock-in.'))
  }
  if (input.clockIn && input.clockOut && input.clockOut.getTime() < input.clockIn.getTime()) {
    issues.push(err('clock_out_before_in', 'Clock-out is before clock-in.'))
  }
  for (const [label, d] of [['Clock-in', input.clockIn], ['Clock-out', input.clockOut]] as const) {
    if (d && d.getTime() > now.getTime() + 60_000) {
      issues.push(err('future_timestamp', `${label} is in the future.`))
    }
  }

  const breakMinutes = Math.round(input.breakMinutes ?? 0)
  if (breakMinutes < 0) issues.push(err('negative_break', 'Break time cannot be negative.'))
  if ((input.workedMinutesOverride ?? 0) < 0) issues.push(err('negative_hours', 'Worked time cannot be negative.'))
  if ((input.travelMinutes ?? 0) < 0) issues.push(err('negative_travel', 'Travel time cannot be negative.'))

  const b = computeTimeBreakdown(input, policy)

  if (b.elapsedMinutes > 0 && breakMinutes > b.elapsedMinutes) {
    issues.push(err('break_exceeds_shift', 'The break is longer than the shift.'))
  }
  if (b.elapsedMinutes > policy.longShiftReviewMinutes) {
    issues.push(warn('long_shift', `This shift is ${formatMinutes(b.elapsedMinutes)} — longer than usual. Confirm it is correct.`))
  }
  if (b.travelMinutes > b.workedMinutes && b.workedMinutes > 0) {
    issues.push(warn('travel_exceeds_work', 'Travel time is longer than the time worked. Confirm it is correct.'))
  }
  if (input.clockIn && !input.clockOut) {
    issues.push(warn('missing_clock_out', 'This shift has no clock-out yet.'))
  }
  if (input.hasRate === false && b.paidMinutes > 0) {
    issues.push(err('missing_rate', 'This worker has no pay rate on the assignment. Set a rate or use flat pay.'))
  }

  // Overlapping shifts for the same worker.
  if (input.clockIn && input.clockOut && input.otherShifts?.length) {
    for (const other of input.otherShifts) {
      const overlaps = input.clockIn.getTime() < other.end.getTime() && other.start.getTime() < input.clockOut.getTime()
      if (overlaps) {
        issues.push(warn('overlapping_shift', `This overlaps another shift for the same worker${other.label ? ` (${other.label})` : ''}.`))
      }
    }
  }

  return issues.sort((a, z) => (a.level === z.level ? 0 : a.level === 'ERROR' ? -1 : 1))
}

export const hasBlockingIssue = (issues: TimeIssue[]): boolean => issues.some((i) => i.level === 'ERROR')
export const hasReviewIssue = (issues: TimeIssue[]): boolean => issues.some((i) => i.level === 'WARNING')

/** True when a worker currently has an open shift (clocked in, not out). */
export const isClockedIn = (c: { clockIn?: Date | null; clockOut?: Date | null }): boolean =>
  !!c.clockIn && !c.clockOut

/** True when a worker is currently on break (break started, shift still open). */
export const isOnBreak = (c: { breakStartedAt?: Date | null; clockOut?: Date | null }): boolean =>
  !!c.breakStartedAt && !c.clockOut
