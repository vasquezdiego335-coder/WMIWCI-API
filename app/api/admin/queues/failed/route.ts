// ════════════════════════════════════════════════════════════════════════
//  FAILED-JOB INSPECTOR  —  GET /api/admin/queues/failed?queue=scheduled
//  ---------------------------------------------------------------------
//  WHY THIS EXISTS: the monitoring sweep reports "the scheduled queue has 100
//  failed jobs retained", and there was no way to see WHAT they were. The
//  admin Queues page links to /api/admin/queues/bull-board, which does not
//  exist; src/workers/bull-board.ts binds to 127.0.0.1 and is imported by
//  nothing. So the one question an alert raises — "failed at what?" — had no
//  answer inside the product.
//
//  WHY NOT BULL BOARD: it is an Express app, and this API is Next.js App
//  Router, which cannot mount Express middleware. Standing it up properly
//  would mean exposing a full queue-MANAGEMENT UI (retry, promote, delete
//  jobs) on a public host. This endpoint answers the diagnostic question
//  without creating that surface: it is READ-ONLY and admin-authenticated.
//
//  It returns REASONS GROUPED BY FREQUENCY rather than a job dump, because
//  "97 of these are the same error" is the useful fact, not 100 stack traces.
// ════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { denyReason, type Role } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

/** Queues an operator may inspect. Closed list — never a caller-supplied name. */
const INSPECTABLE = ['scheduled', 'email', 'sms', 'discord', 'webhook-retry', 'marketing'] as const
type QueueName = (typeof INSPECTABLE)[number]

/** Hard cap on how many jobs are read, so a huge backlog cannot stall the request. */
const MAX_SAMPLE = 60

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  // Queue internals are operational data: same permission as the rest of the
  // admin surface, checked server-side.
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const requested = (req.nextUrl.searchParams.get('queue') ?? 'scheduled') as QueueName
  if (!INSPECTABLE.includes(requested)) {
    return NextResponse.json({ error: `Unknown queue "${requested}". Allowed: ${INSPECTABLE.join(', ')}.` }, { status: 400 })
  }

  try {
    const queues = await import('@/lib/queues')
    const map: Record<QueueName, unknown> = {
      scheduled: queues.scheduledQueue,
      email: queues.emailQueue,
      sms: queues.smsQueue,
      discord: queues.discordQueue,
      'webhook-retry': queues.webhookRetryQueue,
      marketing: queues.marketingQueue,
    }
    const queue = map[requested] as {
      getFailedCount: () => Promise<number>
      getFailed: (start: number, end: number) => Promise<
        { id?: string | number; name: string; failedReason?: string; finishedOn?: number; timestamp?: number; attemptsMade?: number }[]
      >
    }
    if (!queue) return NextResponse.json({ error: `Queue "${requested}" is not available in this process.` }, { status: 503 })

    const total = await queue.getFailedCount()
    const jobs = total > 0 ? await queue.getFailed(0, Math.min(total, MAX_SAMPLE) - 1) : []

    // Group by the FIRST LINE of the failure. A stack trace differs per job;
    // the message is what identifies the defect.
    const groups = new Map<string, { count: number; jobName: string; newest: number | null; oldest: number | null; sampleId: string | null }>()
    for (const j of jobs) {
      const key = (j.failedReason ?? 'unknown').split('\n')[0].trim().slice(0, 200)
      const when = j.finishedOn ?? j.timestamp ?? null
      const g = groups.get(key) ?? { count: 0, jobName: j.name, newest: when, oldest: when, sampleId: j.id != null ? String(j.id) : null }
      g.count++
      if (when != null) {
        g.newest = g.newest == null ? when : Math.max(g.newest, when)
        g.oldest = g.oldest == null ? when : Math.min(g.oldest, when)
      }
      groups.set(key, g)
    }

    const reasons = Array.from(groups.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([reason, g]) => ({
        reason,
        count: g.count,
        jobName: g.jobName,
        newest: g.newest ? new Date(g.newest).toISOString() : null,
        oldest: g.oldest ? new Date(g.oldest).toISOString() : null,
        sampleJobId: g.sampleId,
      }))

    return NextResponse.json({
      queue: requested,
      totalFailedRetained: total,
      sampled: jobs.length,
      truncated: total > jobs.length,
      reasons,
      // Stated plainly so a stale backlog is not mistaken for a live incident.
      note:
        reasons.length === 0
          ? 'No failed jobs retained.'
          : `Retained failures are HISTORY, not necessarily current. Compare "newest" against now: if it is old, these are a stale backlog from an already-fixed defect.`,
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Could not read the queue: ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 }
    )
  }
}
