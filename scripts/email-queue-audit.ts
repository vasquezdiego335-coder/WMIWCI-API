// ════════════════════════════════════════════════════════════════════════
//  EMAIL QUEUE AUDIT  (owner spec 2026-08-06)
//    npx tsx scripts/email-queue-audit.ts            ← DRY RUN, changes nothing
//    npx tsx scripts/email-queue-audit.ts --apply    ← cancels what it names
//  ---------------------------------------------------------------------
//  WHY THIS EXISTS. The consent rules changed. Any promotional job queued
//  BEFORE that change was scheduled under the old rules, and its subject may
//  never have opted in. The send gate now refuses it — correctly — but the job
//  itself survives: it sits in Redis, wakes on its delay, gets refused, and in
//  some paths re-queues. That is retry churn that hides the real failures, and
//  it is the one thing a rules change cannot clean up by itself.
//
//  WHAT IT WILL AND WILL NOT TOUCH
//
//    CANCEL   a PROMOTIONAL job whose subject cannot legally receive it:
//             consent false/null, suppressed, converted, lost, or gone.
//    RETAIN   every transactional job, and every promotional job whose subject
//             HAS explicitly opted in. Untouched, not even inspected further.
//    UNKNOWN  a job it cannot classify with confidence — no subject id, a job
//             type it does not recognise, or a database read that failed.
//             REPORTED AND LEFT ALONE. Deleting something you do not
//             understand is how a working system becomes a broken one, and a
//             stale job that gets refused at send time is a much smaller
//             problem than a deleted job that was legitimate.
//
//  DRY RUN IS THE DEFAULT and there is no way to make it implicit. The output
//  of a dry run is exactly the output of an --apply run, minus the deletions,
//  so what you approve is what happens.
//
//  It never prints a customer email address.
// ════════════════════════════════════════════════════════════════════════
import 'dotenv/config'
import { Queue } from 'bullmq'
import { bullConnection } from '../src/lib/redis'
import { prisma } from '../src/lib/db'
import { classifyTemplate } from '../src/lib/email-guard'
import { quoteFollowupBlockReason, leadNurtureBlockReason, LEAD_NURTURE_STAGES } from '../src/lib/journeys'
import { bookingBlockReason } from '../src/lib/email-eligibility'
import { hasEverBooked } from '../src/lib/leads'

const APPLY = process.argv.includes('--apply')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const OFF = '\x1b[0m'
const head = (s: string) => `\n${BOLD}${s}${OFF}\n${DIM}${'─'.repeat(s.length)}${OFF}`

type Verdict = 'CANCEL' | 'RETAIN' | 'UNKNOWN'
type Row = { queue: string; jobId: string; name: string; verdict: Verdict; reason: string; runsAt: string }

const rows: Row[] = []

/** Scheduled-job types that produce a PROMOTIONAL email, and their subject. */
const LEAD_PROMOTIONAL = new Set<string>([
  'quote-followup-1',
  'quote-followup-2',
  'quote-followup-final',
  ...LEAD_NURTURE_STAGES.map((s) => s.type),
])
const BOOKING_PROMOTIONAL: Record<string, string> = {
  'abandoned-checkout-recovery': 'abandoned-checkout',
  'abandoned-checkout-recovery-2': 'abandoned-checkout-2',
  'abandoned-checkout-recovery-3': 'abandoned-checkout-3',
  'review-request-48h': 'review-request',
  'review-request': 'review-request',
  'review-reminder': 'review-reminder',
  'referral-ask': 'referral',
  'repeat-reminder': 'repeat-reminder',
}

/** May this LEAD still receive this promotional stage? */
async function judgeLead(leadId: string, type: string): Promise<{ verdict: Verdict; reason: string }> {
  const lead = await prisma.lead
    .findUnique({
      where: { id: leadId },
      select: {
        email: true, status: true, quotedAt: true, bookedAt: true, lostAt: true,
        moveDate: true, convertedBookingId: true, emailMarketingConsent: true,
      },
    })
    .catch(() => undefined)
  if (lead === undefined) return { verdict: 'UNKNOWN', reason: 'lead read failed' }
  if (lead === null) return { verdict: 'CANCEL', reason: 'lead_deleted' }

  const block = LEAD_NURTURE_STAGES.some((s) => s.type === type)
    ? leadNurtureBlockReason({ ...lead, previousCustomer: await hasEverBooked(lead.email) })
    : quoteFollowupBlockReason(lead)
  return block ? { verdict: 'CANCEL', reason: block } : { verdict: 'RETAIN', reason: 'eligible' }
}

/** May this BOOKING still receive this promotional template? */
async function judgeBooking(bookingId: string, template: string): Promise<{ verdict: Verdict; reason: string }> {
  const b = await prisma.booking
    .findUnique({
      where: { id: bookingId },
      select: {
        status: true, isInternalTest: true, depositPaid: true, completedAt: true,
        requestedDate: true, confirmedDate: true, scheduledStart: true,
        customer: { select: { emailMarketingConsent: true, marketingOptOut: true } },
      },
    })
    .catch(() => undefined)
  if (b === undefined) return { verdict: 'UNKNOWN', reason: 'booking read failed' }
  if (b === null) return { verdict: 'CANCEL', reason: 'booking_deleted' }

  const block = bookingBlockReason(template, {
    status: b.status,
    isInternalTest: b.isInternalTest,
    depositPaid: b.depositPaid,
    completedAt: b.completedAt,
    requestedDate: b.requestedDate,
    confirmedDate: b.confirmedDate,
    scheduledStart: b.scheduledStart,
    customerMarketingConsent: b.customer?.emailMarketingConsent ?? null,
    customerMarketingOptOut: b.customer?.marketingOptOut ?? false,
  })
  return block ? { verdict: 'CANCEL', reason: block } : { verdict: 'RETAIN', reason: 'eligible' }
}

async function auditQueue(name: 'scheduled' | 'email'): Promise<void> {
  const q = new Queue(name, { connection: bullConnection })
  try {
    // Every state a job can be sitting in and still fire later. ACTIVE is
    // deliberately excluded: a job mid-execution cannot be removed safely, and
    // the send gate is what stops it.
    const jobs = await q.getJobs(['delayed', 'waiting', 'paused', 'failed'], 0, 5000)
    console.log(`   ${DIM}${name}: ${jobs.length} pending job(s)${OFF}`)

    for (const job of jobs) {
      const d = (job.data ?? {}) as Record<string, unknown>
      const type = String(d.type ?? d.template ?? job.name ?? '')
      const runsAt = job.opts?.delay
        ? new Date(job.timestamp + job.opts.delay).toISOString().slice(0, 16).replace('T', ' ')
        : 'now'
      const push = (verdict: Verdict, reason: string) =>
        rows.push({ queue: name, jobId: String(job.id), name: type, verdict, reason, runsAt })

      // ── The email queue carries a TEMPLATE; classification is exact. ──
      if (name === 'email') {
        const template = String(d.template ?? '')
        if (!template) {
          push('UNKNOWN', 'job carries no template')
          continue
        }
        if (classifyTemplate(template) === 'transactional') {
          push('RETAIN', 'transactional — never touched')
          continue
        }
        const leadId = typeof d.leadId === 'string' ? d.leadId : null
        const bookingId = typeof d.bookingId === 'string' ? d.bookingId : null
        if (leadId) push(...(Object.values(await judgeLead(leadId, template)) as [Verdict, string]))
        else if (bookingId) push(...(Object.values(await judgeBooking(bookingId, template)) as [Verdict, string]))
        else push('UNKNOWN', 'promotional job with no lead or booking id')
        continue
      }

      // ── The scheduled queue carries a JOB TYPE. ──
      if (LEAD_PROMOTIONAL.has(type)) {
        const leadId = typeof d.leadId === 'string' ? d.leadId : null
        if (!leadId) push('UNKNOWN', 'lead stage with no leadId')
        else {
          const v = await judgeLead(leadId, type)
          push(v.verdict, v.reason)
        }
        continue
      }
      const template = BOOKING_PROMOTIONAL[type]
      if (template) {
        const bookingId = typeof d.bookingId === 'string' ? d.bookingId : null
        if (!bookingId) push('UNKNOWN', 'booking stage with no bookingId')
        else {
          const v = await judgeBooking(bookingId, template)
          push(v.verdict, v.reason)
        }
        continue
      }
      // Cron entries, digests, sweeps, transactional reminders: not ours.
      push('RETAIN', 'not a promotional job')
    }

    // ── ACT ────────────────────────────────────────────────────────────
    if (APPLY) {
      for (const r of rows.filter((x) => x.queue === name && x.verdict === 'CANCEL')) {
        const job = jobs.find((j) => String(j.id) === r.jobId)
        if (!job) continue
        await job.remove().catch((err) => {
          r.verdict = 'UNKNOWN'
          r.reason = `remove failed: ${err instanceof Error ? err.message : String(err)}`
        })
      }
    }
  } finally {
    await q.close().catch(() => undefined)
  }
}

async function main() {
  console.log(`${BOLD}Email queue audit${OFF} ${APPLY ? `${RED}--apply — THIS WILL CANCEL JOBS${OFF}` : `${DIM}(dry run — nothing will change)${OFF}`}`)

  console.log(head('Scanning'))
  await auditQueue('scheduled')
  await auditQueue('email')

  const cancel = rows.filter((r) => r.verdict === 'CANCEL')
  const retain = rows.filter((r) => r.verdict === 'RETAIN')
  const unknown = rows.filter((r) => r.verdict === 'UNKNOWN')

  if (cancel.length > 0) {
    console.log(head(APPLY ? 'Cancelled' : 'Would cancel'))
    for (const r of cancel) console.log(`   ${RED}✗${OFF} ${r.queue}/${r.name.padEnd(28)} ${DIM}runs ${r.runsAt}${OFF}  ${r.reason}`)
  }
  if (unknown.length > 0) {
    console.log(head('Could not classify — LEFT ALONE'))
    for (const r of unknown) console.log(`   ${YELLOW}?${OFF} ${r.queue}/${r.name.padEnd(28)} ${DIM}runs ${r.runsAt}${OFF}  ${r.reason}`)
  }

  console.log(head('Result'))
  console.log(`   found      ${BOLD}${rows.length}${OFF}`)
  console.log(`   ${APPLY ? 'cancelled ' : 'to cancel '} ${cancel.length > 0 ? RED : ''}${BOLD}${cancel.length}${OFF}`)
  console.log(`   retained   ${GREEN}${BOLD}${retain.length}${OFF}  ${DIM}(transactional + opted-in + cron)${OFF}`)
  console.log(`   unclassified ${unknown.length > 0 ? YELLOW : ''}${BOLD}${unknown.length}${OFF}${OFF}  ${DIM}(reported, never touched)${OFF}`)

  // ── The DB side of the same question ──────────────────────────────────
  // A queue job is what RETRIES. An EmailSend row in a non-terminal state is
  // just a record — nothing re-drives it today (dueForRetry has no caller) —
  // so it is REPORTED rather than rewritten. Sealing a consent refusal as
  // terminal would also mean a later opt-in could never rescue the send.
  const stalled = await prisma.emailSend
    .groupBy({
      by: ['blockedReason'],
      where: { status: { in: ['blocked_retryable', 'deferred', 'retry_pending'] }, emailClass: 'promotional' },
      _count: { _all: true },
    })
    .catch(() => [])
  if (stalled.length > 0) {
    console.log(head('Promotional ledger rows in a non-terminal state'))
    for (const s of stalled) console.log(`   ${String(s._count._all).padStart(4)}  ${s.blockedReason ?? '(none)'}`)
    console.log(`   ${DIM}Records, not retries — nothing re-drives these. Left as-is so a later${OFF}`)
    console.log(`   ${DIM}opt-in can still rescue the send.${OFF}`)
  }

  if (!APPLY && cancel.length > 0) {
    console.log(`\n${YELLOW}Re-run with --apply to cancel the ${cancel.length} job(s) above.${OFF}`)
  }
  console.log('')
}

main()
  .catch((err) => {
    console.error(`${RED}audit failed:${OFF}`, err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined)
    process.exit(process.exitCode ?? 0)
  })
