import { Worker, Job } from 'bullmq'
import twilioFactory, { type Twilio } from 'twilio'
import { bullConnection } from '../lib/redis'
import { queueLogger } from '../lib/logger'
import type { SmsJobData } from '../lib/queues'

// ════════════════════════════════════════════════════════════════════════
//  SMS worker (Twilio)
//  ----------------------------------------------------------------------
//  Hardened for production debuggability:
//   • Validates TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER
//     are present and well-formed before touching the API.
//   • Logs the FULL job lifecycle: received → sending → sent (or full error).
//   • On a Twilio failure, logs the entire error shape (status/code/message/
//     moreInfo) so problems are obvious in the console, then rethrows so BullMQ
//     records the job as failed and retries transient errors.
//   • Missing/placeholder creds → a clear WARNING and a clean skip (no throw,
//     no crash) so a half-configured deploy doesn't spin on retries.
// ════════════════════════════════════════════════════════════════════════

const PLACEHOLDERS = new Set(['', 'REPLACE_ME', 'placeholder'])
const isSet = (v?: string): v is string => !!v && !PLACEHOLDERS.has(v) && !v.includes('REPLACE_ME')

// Show only the last 4 digits in logs (never leak full customer numbers).
function maskPhone(to?: string): string {
  if (!to) return '(none)'
  return to.length <= 4 ? to : `${to.slice(0, 2)}***${to.slice(-4)}`
}

type TwilioConfig = { accountSid: string; authToken: string; from: string }

// Validate Twilio env and return either a usable config or the list of what's
// missing/malformed. Never throws.
function readTwilioConfig():
  | { ok: true; config: TwilioConfig }
  | { ok: false; problems: string[] } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER

  const problems: string[] = []
  if (!isSet(accountSid)) problems.push('TWILIO_ACCOUNT_SID missing/empty')
  else if (!accountSid.startsWith('AC')) problems.push('TWILIO_ACCOUNT_SID malformed (must start with "AC")')
  if (!isSet(authToken)) problems.push('TWILIO_AUTH_TOKEN missing/empty')
  if (!isSet(from)) problems.push('TWILIO_PHONE_NUMBER missing/empty')
  else if (!from.startsWith('+')) problems.push('TWILIO_PHONE_NUMBER malformed (must be E.164, e.g. +18623755371)')

  if (problems.length) return { ok: false, problems }
  return { ok: true, config: { accountSid: accountSid!, authToken: authToken!, from: from! } }
}

// Lazy Twilio client singleton — built once, on first send.
let _client: Twilio | null = null
function getTwilioClient(config: TwilioConfig): Twilio {
  if (!_client) _client = twilioFactory(config.accountSid, config.authToken)
  return _client
}

async function processSmsJob(job: Job<SmsJobData>): Promise<void> {
  const { to, message, bookingId } = job.data
  const log = queueLogger.child({ jobId: job.id, jobName: job.name, to: maskPhone(to), bookingId })

  log.info({ messageLength: message?.length ?? 0 }, '📨 SMS job received')

  // ── Feature flag ─────────────────────────────────────────────────────────
  if (process.env.TWILIO_ENABLED !== 'true') {
    log.info(
      { dryRun: true, wouldSendTo: maskPhone(to), messagePreview: message?.slice(0, 60) },
      '✅ SMS DRY RUN — job received and processed, Twilio call skipped (TWILIO_ENABLED != "true")'
    )
    return
  }

  // ── Validate the job payload ──────────────────────────────────────────────
  if (!isSet(to) || !isSet(message)) {
    log.warn({ hasTo: !!to, hasMessage: !!message }, '🚫 SMS job missing "to" or "message" — skipping')
    return
  }

  // ── Validate Twilio configuration ────────────────────────────────────────
  const cfg = readTwilioConfig()
  if (!cfg.ok) {
    log.warn(
      { problems: cfg.problems },
      '⚠️ Twilio is enabled but NOT properly configured — skipping send (fix the listed env vars)'
    )
    return
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  const client = getTwilioClient(cfg.config)
  log.info({ from: cfg.config.from }, '📤 Sending SMS via Twilio…')

  try {
    const res = await client.messages.create({ body: message, from: cfg.config.from, to })
    log.info({ sid: res.sid, status: res.status }, '✅ SMS sent')
  } catch (err) {
    // Surface the ENTIRE Twilio error shape — this is the bit you actually need
    // when a text silently fails (21211 invalid number, 21608 unverified trial
    // number, 20003 auth error, etc.).
    const e = err as {
      status?: number
      code?: number | string
      message?: string
      moreInfo?: string
      details?: unknown
    }
    log.error(
      {
        twilioStatus: e?.status,
        twilioCode: e?.code,
        twilioMessage: e?.message,
        moreInfo: e?.moreInfo,
        details: e?.details,
      },
      '❌ Twilio send FAILED'
    )
    // Rethrow so BullMQ marks the job failed (visible in Bull Board) and retries.
    throw err instanceof Error ? err : new Error(String(err))
  }
}

export function startSmsWorker() {
  // Log the Twilio configuration state ONCE at startup so a misconfig is obvious
  // the moment the worker boots — not only when the first text is attempted.
  if (process.env.TWILIO_ENABLED === 'true') {
    const cfg = readTwilioConfig()
    if (cfg.ok) {
      queueLogger.info({ from: cfg.config.from }, '✓ SMS worker: Twilio configured and enabled')
    } else {
      queueLogger.warn({ problems: cfg.problems }, '⚠️ SMS worker: TWILIO_ENABLED=true but config is incomplete')
    }
  } else {
    queueLogger.info('SMS worker: TWILIO_ENABLED != "true" — texts will be skipped (no-op)')
  }

  const worker = new Worker<SmsJobData>('sms', processSmsJob, {
    connection: bullConnection,
    concurrency: 3,
  })

  worker.on('failed', (job, err) => {
    queueLogger.error({ jobId: job?.id, jobName: job?.name, err: err.message }, 'SMS job failed (after retries)')
  })
  worker.on('completed', (job) => {
    queueLogger.debug({ jobId: job.id, jobName: job.name }, 'SMS job completed')
  })

  return worker
}
