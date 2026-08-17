import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { runReconciliationWithAlert, isScheduledRunAuthorized } from '@/lib/reconciliation'
import { alertScheduledRefusal, classifyScheduledRefusal } from '@/lib/scheduled-run-guard'
import { apiLogger } from '@/lib/logger'

export const runtime = 'nodejs'
export const revalidate = 0

// GET /api/admin/reconciliation?days=30 — payment integrity report.
// Cross-references recent Stripe charges with local Payments + Bookings and
// returns every mismatch (captured-no-row, confirmed-no-payment, amount drift,
// duplicates, refund/dispute state). Read-only against our own data — the only
// side effect is an ops-channel alert when something needs a human.
//
// ITEM B1 (release blocker): the detector was correct and NOBODY RAN IT. There
// was no cron, no scheduled job and no admin page linking this endpoint, so the
// one thing that can see "Stripe captured $49 and the app never recorded it"
// only ever ran when someone remembered to run it. Two changes:
//   1. A SCHEDULER can call it. Vercel Cron (and any other caller holding
//      CRON_SECRET) authenticates with `Authorization: Bearer <CRON_SECRET>`.
//      The owner session still works exactly as before.
//   2. Critical/high findings are POSTED to the ops channel by
//      runReconciliationWithAlert, so a scheduled run that finds money missing
//      says so instead of returning JSON to nobody.
//
// AUTH RULES (deliberately strict, and unit-tested in reconciliation.ts):
//   • An unset / placeholder / short CRON_SECRET means scheduled access is
//     IMPOSSIBLE, never "everyone passes".
//   • The cron path grants exactly this report and nothing else.
//
// THE SCHEDULE lives in vercel.json (`crons`, daily). Vercel sends
// `Authorization: Bearer $CRON_SECRET` only when that env var is set, so an
// unset secret means the schedule fires and is REFUSED.
//
// ITEM R6 — A REFUSED SCHEDULE IS A MONITORING OUTAGE, NOT A QUIET DAY. The
// first repair logged one ERROR line and returned 403. Nobody reads a log
// stream, so a schedule that never ran was indistinguishable from a schedule
// that ran and found nothing — while the detection this endpoint exists for
// (Stripe captured $49, the app recorded nothing) was simply not happening. The
// refusal is now RAISED on the ops channel, before any session lookup, so the
// outage announces itself. CRON_SECRET is documented in .env.example, DEPLOY.md
// and docs/deployment.md; each says plainly what does not run until it is set.

export async function GET(req: Request): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization')
  const scheduled = isScheduledRunAuthorized(authHeader, process.env.CRON_SECRET)
  if (!scheduled) {
    // Only a request that LOOKS like a scheduler (Vercel's cron user agent, or
    // any presented bearer credential) can be a refused schedule. An ordinary
    // browser hit returns null here and falls through to the session check —
    // paging the owner for those would mute the channel that carries this.
    const refusal = classifyScheduledRefusal({
      authHeader,
      userAgent: req.headers.get('user-agent'),
      secret: process.env.CRON_SECRET,
      authorized: false,
    })
    if (refusal) {
      apiLogger.error(
        { reason: refusal.reason, caller: refusal.caller, secretPresent: refusal.secretPresent },
        'the scheduled reconciliation was REFUSED — the daily money check did not run',
      )
      // Never throws; the 403 below is returned either way.
      const alerted = await alertScheduledRefusal('Payment reconciliation', refusal)
      if (!alerted.delivered && !alerted.throttled) {
        apiLogger.error({ reason: alerted.reason }, 'the refusal alert itself could not be delivered')
      }
      // The body stays generic: WHICH credential rule failed is owner
      // information (it goes to the log and the ops channel), not something to
      // hand an unauthenticated caller.
      return NextResponse.json({ error: 'Scheduled run refused.' }, { status: 403 })
    }
    const session = await getSession()
    if (!session || !can(session.role as Role, 'audit.view')) {
      return NextResponse.json({ error: 'Owner only.' }, { status: 403 })
    }
  }
  const days = Math.min(90, Math.max(1, parseInt(new URL(req.url).searchParams.get('days') ?? '30', 10) || 30))
  try {
    const report = await runReconciliationWithAlert(days)
    if (report.summary.needsAttention) {
      apiLogger.error(
        {
          trigger: scheduled ? 'cron' : 'owner',
          windowDays: report.windowDays,
          critical: report.summary.critical,
          high: report.summary.high,
          alerted: report.alerted,
          alertReason: report.alertReason ?? null,
          issues: report.issues.filter((i) => i.severity !== 'medium').map((i) => `${i.type}:${i.ref}`),
        },
        'reconciliation found money-integrity issues',
      )
    } else {
      apiLogger.info(
        { trigger: scheduled ? 'cron' : 'owner', windowDays: report.windowDays, chargesChecked: report.chargesChecked },
        'reconciliation clean',
      )
    }
    return NextResponse.json(report)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    apiLogger.error({ trigger: scheduled ? 'cron' : 'owner', err: detail }, 'reconciliation run failed')
    return NextResponse.json({ error: 'Reconciliation failed', detail }, { status: 500 })
  }
}
