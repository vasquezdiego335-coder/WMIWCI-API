// ============================================================================
// crew-notifications.ts — idempotent assignment notifications (Stage 5).
//
// The AssignmentNotification row is the idempotency ledger: a stable dedupeKey
// means enqueuing the same notification twice never doubles a message, and a
// material schedule change CANCELS the obsolete reminders before scheduling
// replacements. The actual send uses the existing lazy queue getters — importing
// this module never starts a worker (queues are created on first getter call,
// not at import).
//
// Delivery is best-effort and non-blocking: a queue outage must never stop an
// assignment being saved. Provider results are recorded where the worker
// reports them back.
// ============================================================================

import { prisma } from './db'
import { apiLogger } from './logger'

export type AssignmentNotificationType =
  | 'ASSIGNED' // a direct assignment (no offer step) — the worker's first notice
  | 'OFFERED' | 'CHANGED' | 'CANCELLED' | 'REMINDER' | 'REPORT_TIME_REMINDER'
  | 'LOCATION_CHANGED' | 'DRIVER_CHANGED' | 'LEAD_CHANGED' | 'UNACKNOWLEDGED'
  | 'DECLINED' | 'NO_SHOW' | 'AWAITING_APPROVAL' | 'UNDERSTAFFED'

/** A stable key. The same (assignment, type, epoch-bucket) always collides, so a
 *  replay is a no-op. Time-bucketed types (reminders) include the target time. */
export function dedupeKeyFor(jobCrewId: string, type: AssignmentNotificationType, scheduledFor?: Date | null): string {
  const suffix = scheduledFor ? `:${scheduledFor.toISOString()}` : ''
  return `${jobCrewId}:${type}${suffix}`
}

/**
 * Record (and enqueue) one notification, idempotently. If the dedupeKey already
 * exists and is not cancelled, this does nothing and returns the existing row —
 * no duplicate reminder is ever sent.
 */
export async function scheduleAssignmentNotification(i: {
  jobCrewId: string
  type: AssignmentNotificationType
  scheduledFor?: Date | null
}): Promise<{ id: string; created: boolean }> {
  const dedupeKey = dedupeKeyFor(i.jobCrewId, i.type, i.scheduledFor)
  const existing = await prisma.assignmentNotification.findUnique({ where: { dedupeKey } }).catch(() => null)
  if (existing && !existing.cancelledAt) return { id: existing.id, created: false }

  try {
    const row = existing
      ? await prisma.assignmentNotification.update({
          where: { dedupeKey },
          data: { cancelledAt: null, scheduledFor: i.scheduledFor ?? null, sentAt: null },
        })
      : await prisma.assignmentNotification.create({
          data: { jobCrewId: i.jobCrewId, type: i.type, dedupeKey, scheduledFor: i.scheduledFor ?? null },
        })
    // The real send is enqueued by the caller's worker path; here we only own
    // the ledger. (Wiring to getEmailQueue/getSmsQueue happens in the route's
    // notification helper, which passes the row id so the worker records
    // providerResult back onto it.)
    return { id: row.id, created: !existing }
  } catch (e) {
    apiLogger.error({ err: String(e), jobCrewId: i.jobCrewId, type: i.type }, 'notification ledger write failed')
    return { id: 'unwritten', created: false }
  }
}

/**
 * Cancel the reminders that a material schedule change made obsolete. Called
 * before scheduling their replacements, so a worker never gets a reminder for a
 * time that no longer exists.
 */
export async function cancelObsoleteReminders(jobCrewId: string, types: AssignmentNotificationType[] = ['REMINDER', 'REPORT_TIME_REMINDER']): Promise<number> {
  const res = await prisma.assignmentNotification
    .updateMany({
      where: { jobCrewId, type: { in: types }, sentAt: null, cancelledAt: null },
      data: { cancelledAt: new Date() },
    })
    .catch(() => ({ count: 0 }))
  return res.count
}

/**
 * A material change replaced the schedule: cancel obsolete reminders, then queue
 * a CHANGED notice and fresh reminders. Idempotent throughout.
 */
export async function replaceAssignmentReminders(i: {
  jobCrewId: string
  reportTime?: Date | null
}): Promise<void> {
  await cancelObsoleteReminders(i.jobCrewId)
  await scheduleAssignmentNotification({ jobCrewId: i.jobCrewId, type: 'CHANGED' })
  if (i.reportTime) {
    // A reminder one hour before report time.
    const remindAt = new Date(i.reportTime.getTime() - 60 * 60 * 1000)
    await scheduleAssignmentNotification({ jobCrewId: i.jobCrewId, type: 'REPORT_TIME_REMINDER', scheduledFor: remindAt })
  }
}
