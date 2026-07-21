// ============================================================================
// labor-clock.ts — the pure state machine for a clock action (Stage 5 extract).
//
// Extracted so the admin clock route and the crew clock route apply the SAME
// rules. No Prisma: it takes the current assignment shape and an action and
// returns the field updates + the audit action, or a typed refusal. The route
// still owns validation-against-policy and persistence.
// ============================================================================

import { minutesBetween, isClockedIn } from './labor-time'

export type ClockAction = 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END'

export interface ClockRow {
  assignmentStatus: string
  clockIn: Date | null
  clockOut: Date | null
  breakStartedAt: Date | null
  actualBreakMinutes: number | null
}

export type ClockResult =
  | { ok: true; data: Record<string, unknown>; auditAction: string }
  | { ok: false; status: 409 | 422; error: string }

/**
 * Compute the field updates for one clock action. Every ordering rule lives
 * here: no clock-out before clock-in, no double clock-in, no break outside a
 * shift, no second running break. An open break is auto-closed at clock-out
 * rather than silently lost.
 */
export function buildClockUpdate(a: ClockRow, action: ClockAction, at: Date, byUserId: string): ClockResult {
  if (['CANCELLED', 'DECLINED', 'NO_SHOW'].includes(a.assignmentStatus)) {
    return { ok: false, status: 422, error: 'This assignment is not active, so time cannot be recorded against it.' }
  }
  const data: Record<string, unknown> = { timeEntrySource: 'CLOCK', timeAdjustedById: byUserId, timeAdjustedAt: new Date() }

  switch (action) {
    case 'CLOCK_IN':
      if (a.clockIn && !a.clockOut) return { ok: false, status: 409, error: 'Already clocked in.' }
      data.clockIn = at
      data.clockOut = null
      data.assignmentStatus = 'IN_PROGRESS'
      return { ok: true, data, auditAction: 'CREW_CLOCK_IN' }

    case 'CLOCK_OUT': {
      if (!a.clockIn) return { ok: false, status: 422, error: 'Cannot clock out without a clock-in.' }
      if (a.clockOut) return { ok: false, status: 409, error: 'Already clocked out.' }
      let breakMinutes = a.actualBreakMinutes ?? 0
      if (a.breakStartedAt) {
        breakMinutes += Math.max(0, minutesBetween(a.breakStartedAt, at))
        data.breakStartedAt = null
      }
      data.actualBreakMinutes = breakMinutes
      data.clockOut = at
      data.assignmentStatus = 'COMPLETED'
      data.completedAt = at
      return { ok: true, data, auditAction: 'CREW_CLOCK_OUT' }
    }

    case 'BREAK_START':
      if (!isClockedIn(a)) return { ok: false, status: 422, error: 'Clock in before starting a break.' }
      if (a.breakStartedAt) return { ok: false, status: 409, error: 'A break is already running.' }
      data.breakStartedAt = at
      return { ok: true, data, auditAction: 'CREW_BREAK_UPDATED' }

    case 'BREAK_END':
      if (!a.breakStartedAt) return { ok: false, status: 422, error: 'No break is running.' }
      data.actualBreakMinutes = (a.actualBreakMinutes ?? 0) + Math.max(0, minutesBetween(a.breakStartedAt, at))
      data.breakStartedAt = null
      return { ok: true, data, auditAction: 'CREW_BREAK_UPDATED' }
  }
}
