// ════════════════════════════════════════════════════════════════════════
//  EMAIL JOB SHAPE — pure validation for src/workers/email.worker.ts
//  ---------------------------------------------------------------------
//  A malformed job must fail LOUDLY and ALONE: it is moved to BullMQ's failed
//  set without retries (retrying cannot repair its data), and it cannot hold
//  up any other job. Kept infrastructure-free so it is unit-testable.
// ════════════════════════════════════════════════════════════════════════

/** Returns a short problem description, or null when the job data is usable. */
export function validateEmailJobData(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'job data is not an object'
  const d = data as Record<string, unknown>
  if (typeof d.template !== 'string' || d.template.trim() === '') return 'template is missing'
  if (typeof d.to !== 'string' || d.to.trim() === '') return 'recipient is missing'
  if (d.payload !== undefined && d.payload !== null && (typeof d.payload !== 'object' || Array.isArray(d.payload))) {
    return 'payload is not an object'
  }
  for (const k of ['bookingId', 'leadId', 'businessEventKey', 'notificationId'] as const) {
    if (d[k] !== undefined && d[k] !== null && typeof d[k] !== 'string') return `${k} is not a string`
  }
  return null
}
