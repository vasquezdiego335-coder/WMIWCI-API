// ════════════════════════════════════════════════════════════════════════
//  SCHEDULED-RUN REFUSALS ARE MONITORING OUTAGES (item R6, 2026-08-15)
//  ---------------------------------------------------------------------
//  THE DEFECT THIS CLOSES. `vercel.json` runs the payment reconciliation daily.
//  The route requires `CRON_SECRET`, and that variable appeared NOWHERE else in
//  the repo — not in `.env.example` (otherwise exhaustive), not in DEPLOY.md,
//  not in any runbook. As shipped, the schedule fired every day, was refused
//  with a 403, and left one log line. Every detection credited to the B1 repair
//  — "Stripe captured $49 and the app never recorded it", "booking CONFIRMED
//  with no capture" — therefore did not run at all, and nothing said so.
//
//  A refused schedule looks EXACTLY like a quiet day: no findings, no alert, no
//  error anyone reads. That is the project's recurring "presence !=
//  configuration" failure, and the only fix that survives it is to make the
//  refusal itself loud on the channel a human watches.
//
//  DESIGN RULES (inherited from ops-alert.ts)
//   1. Never throws. An alerting failure must not break the endpoint.
//   2. Says only what is known. It reports that the run was REFUSED and why the
//      credential failed; it never claims what the report would have found.
//   3. Throttled, because a channel that pings in a loop gets muted and a muted
//      channel loses the critical alerts with it. The throttle is per-process
//      and per-reason — on serverless that means "at most one per instance per
//      window", which is a ceiling, not a guarantee of exactly one.
// ════════════════════════════════════════════════════════════════════════

import { queueLogger } from './logger'

const log = queueLogger.child({ mod: 'scheduled-run-guard' })

export type ScheduledRefusalReason =
  /** No usable CRON_SECRET is configured, so NO scheduler can ever authenticate. */
  | 'cron_secret_unset'
  /** A secret is configured but this caller presented no credential. */
  | 'no_credential_presented'
  /** A credential was presented and did not authorize. */
  | 'credential_rejected'

export type ScheduledRefusal = {
  reason: ScheduledRefusalReason
  /** Why this request was read as a scheduler rather than a person. */
  caller: 'vercel_cron' | 'bearer_credential'
  /** Is ANY non-empty CRON_SECRET set? (Not whether it is a usable one.) */
  secretPresent: boolean
  /** One sentence, owner-facing, describing what happened. */
  detail: string
  /** What to do about it. */
  action: string
}

const REASON_COPY: Record<ScheduledRefusalReason, { detail: string; action: string }> = {
  cron_secret_unset: {
    detail: 'A scheduled run was refused: CRON_SECRET is not set, so no scheduler can authenticate.',
    action:
      'Set CRON_SECRET (>=16 random characters) on the deployment and redeploy. ' +
      'Until then the daily payment reconciliation does not run.',
  },
  no_credential_presented: {
    detail: 'A scheduled run was refused: the caller presented no Authorization header.',
    action:
      'Check that the scheduler sends `Authorization: Bearer $CRON_SECRET` and that CRON_SECRET ' +
      'is set on the service that runs the schedule.',
  },
  credential_rejected: {
    detail:
      'A scheduled run was refused: the presented credential did not authorize. Either it does not ' +
      'match CRON_SECRET, or CRON_SECRET is a placeholder or shorter than 16 characters (both refuse by design).',
    action:
      'Compare the scheduler credential with CRON_SECRET on the deployment; replace a placeholder or short ' +
      'value with >=16 random characters. Until then the daily payment reconciliation does not run.',
  },
}

/**
 * PURE. Did a SCHEDULER just get turned away?
 *
 * Returns null when the request was authorized, or when nothing about it says
 * "scheduler" — an ordinary unauthenticated browser hit is a 403, not an outage,
 * and paging the owner for those would mute the channel.
 *
 * `authorized` is the caller's own verdict (reconciliation.isScheduledRunAuthorized
 * stays the single authority on the secret rules); this function only explains a
 * refusal. It deliberately does NOT re-implement the placeholder/length policy —
 * it says "rejected, and here are the two things that cause it" rather than
 * asserting which, because a second copy of that rule would drift.
 */
export function classifyScheduledRefusal(input: {
  authHeader?: string | null
  userAgent?: string | null
  secret?: string | null
  authorized: boolean
}): ScheduledRefusal | null {
  if (input.authorized) return null

  const header = input.authHeader?.trim() ?? ''
  const bearer = /^bearer\s+\S/i.test(header)
  // Vercel Cron identifies itself in the user agent (`vercel-cron/1.0`) and
  // sends the Authorization header ONLY when CRON_SECRET is set on the project
  // — which is precisely why an unset secret is invisible without this check.
  const vercelCron = /vercel-cron/i.test(input.userAgent ?? '')
  if (!bearer && !vercelCron) return null

  const secretPresent = !!input.secret?.trim()
  const reason: ScheduledRefusalReason = !secretPresent
    ? 'cron_secret_unset'
    : bearer
      ? 'credential_rejected'
      : 'no_credential_presented'

  return {
    reason,
    caller: vercelCron ? 'vercel_cron' : 'bearer_credential',
    secretPresent,
    ...REASON_COPY[reason],
  }
}

/** How long one process stays quiet about the SAME refusal reason. A daily
 *  schedule alerts every day; a hammering caller cannot flood the channel. */
export const SCHEDULED_REFUSAL_THROTTLE_MS =
  Math.max(0, Number(process.env.SCHEDULED_REFUSAL_ALERT_THROTTLE_MINUTES) || 360) * 60_000

const lastAlertAt = new Map<string, number>()

/** Test seam: forget the throttle state. */
export function resetScheduledRefusalThrottle(): void {
  lastAlertAt.clear()
}

export type ScheduledRefusalAlertResult = {
  /** Did an ops channel ACCEPT the alert? */
  delivered: boolean
  /** Suppressed by the throttle rather than attempted. */
  throttled: boolean
  reason?: string
}

/**
 * Raise the refusal on the ops channel. Best-effort and non-throwing by
 * contract: the endpoint still returns its 403 whatever happens here.
 *
 * `post` is injected in tests; production uses ops-alert.postOpsAlert (a bare
 * HTTPS POST with no discord.js dependency — see that file's header for why the
 * SDK must not be imported from a Next route).
 */
export async function alertScheduledRefusal(
  what: string,
  refusal: ScheduledRefusal,
  post?: (title: string, lines: Array<{ message: string; action?: string }>) => Promise<{ delivered: boolean; reason?: string }>,
  now: () => number = Date.now,
): Promise<ScheduledRefusalAlertResult> {
  const key = `${what}:${refusal.reason}`
  const at = now()
  const previous = lastAlertAt.get(key)
  if (previous !== undefined && at - previous < SCHEDULED_REFUSAL_THROTTLE_MS) {
    return { delivered: false, throttled: true, reason: 'throttled' }
  }
  lastAlertAt.set(key, at)

  try {
    const send = post ?? (await import('./ops-alert')).postOpsAlert
    const res = await send(`🚨 ${what} REFUSED — the scheduled run did not happen`, [
      { message: refusal.detail, action: refusal.action },
      {
        message:
          'While it is refused this check does not run, so a Stripe capture with no Payment row — or a ' +
          'booking left CONFIRMED with no capture — is detected by nothing.',
      },
    ])
    if (!res.delivered) {
      log.error({ what, reason: refusal.reason, why: res.reason }, 'refusal alert COULD NOT BE DELIVERED')
    }
    return { delivered: res.delivered, throttled: false, ...(res.delivered ? {} : { reason: res.reason }) }
  } catch (err) {
    // postOpsAlert does not throw; an injected sender might.
    const reason = err instanceof Error ? err.message : String(err)
    log.error({ what, reason }, 'refusal alert threw')
    return { delivered: false, throttled: false, reason }
  }
}
