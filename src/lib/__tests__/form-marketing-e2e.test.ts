// ════════════════════════════════════════════════════════════════════════
//  form-marketing-e2e.test.ts — every genuine form submission, end to end,
//  against a REAL PostgreSQL (Prisma) and a REAL Redis (BullMQ).
//  (form submissions into existing marketing sequences, release 2026-09-16)
//  ---------------------------------------------------------------------
//  The offline suites (capture-routes-consent, offer-signup, journeys-*) pin
//  each seam against fakes. This one proves the WHOLE chain holds together:
//
//    form body → real route handler → capture basis (grant safeguards, the
//    append-only consent event, the stored lead/booking basis) → journeys
//    (eligibility, the person-level enrollment claim, durable enqueue) → real
//    BullMQ jobs → the REAL stage processor (processScheduledJob) → the REAL
//    email processor (processEmailJob) → the existing React template → the
//    send guard → the provider.
//
//  WHAT IS NOT REAL, AND WHY:
//    • the provider. resend.emails.send is replaced with a node:test mock for
//      every test, and with a thrower between tests, so nothing can ever reach
//      the network. Every recipient is @example.com (assertTestRecipient).
//    • BullMQ Workers. The 'email', 'scheduled' and 'discord' queue names are
//      global and shared with every suite running in parallel in CI, so this
//      file never starts a Worker. Jobs are found by their deterministic ids
//      (journey__<key>__<stage>__<subject>) or by their data (lead / booking /
//      address of THIS run) and handed to the real processors directly.
//    • the test-identity refusal. @example.com is a RESERVED domain, which the
//      grant safeguards and the send gate rightly refuse. Two narrow, documented
//      exemptions let the real flow run for THIS run's addresses only:
//        – grant time: captureBasisDeps().evaluate is the real
//          evaluateGrantSafeguards with testIdentity → null for this run's
//          addresses (the same seam capture-routes-consent/offer-signup use);
//        – send time: the canary rehearsal exemption the product already has —
//          each exact address is listed in EMAIL_PROMOTIONAL_ALLOWLIST.
//      Every other safeguard, prohibition and stop rule is production code.
//    • the booking SUBMIT route (app/api/bookings). It has no seam for Stripe
//      checkout creation, address verification or the routed-mileage lookup,
//      all of which are network calls. Test 4 therefore creates the booking and
//      customer rows with Prisma and runs the route's own marketing sequence
//      exactly as the route does: applyCaptureBasis({ surface: 'booking',
//      scenario: 'abandoned_checkout', … }) → onBookingCreated(…) →
//      startCaptureScenario(…). capture-routes-consent pins that order on the
//      route source.
//
//  ISOLATION. Every address carries this run's id; every cleanup is scoped to
//  those addresses and the leads/bookings they own. Consent events are
//  append-only by design and are never deleted (unique addresses make that
//  harmless, exactly like consent-db.test.ts).
//
//  Skips unless BOTH a disposable DATABASE_URL and REDIS_TEST_URL are set;
//  a production-looking target is a hard failure (see _disposable-test-env.ts).
// ════════════════════════════════════════════════════════════════════════
import { test, before, after, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { Job, JobType, Queue } from 'bullmq'
import type { PrismaClient } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { assertNoProductionCredentials, assertTestRecipient, dbSkip, redisSkip } from './_disposable-test-env'
import type { EmailJobData } from '../queues'
import type { SequenceKind } from '../consent/notice-registry'
import type { EnrolmentOutcome, NoticeSubmissionInput } from '../journeys'

// A production-looking DATABASE_URL / Redis URL / Resend key is a HARD FAILURE,
// never a skip.
assertNoProductionCredentials()
const skip: string | false = dbSkip() || redisSkip()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Scheduling tolerance: the anchor is read in-process, the job timestamp by BullMQ. */
const TOLERANCE_MS = 15_000

const run = randomUUID().replace(/-/g, '').slice(0, 10)
const APP_URL = 'https://api.form-marketing-e2e.invalid'
const SITE_URL = 'https://www.form-marketing-e2e.invalid'
const WEBHOOK_SECRET = `whsec_${randomBytes(32).toString('base64')}`
const INTERNAL_TOKEN = `form-e2e-internal-${randomUUID()}`

// ── ENVIRONMENT, before ANY module that reads it at load time is imported ──
//  journeys.ts reads EMAIL_JOURNEYS_ENABLED at load, notify.ts reads
//  OWNER_EMAIL / CUSTOMER_AUTOREPLY_ENABLED at load, resend.ts reads
//  RESEND_API_KEY at load, and the queues read REDIS_URL on first use.
if (!skip) {
  process.env.REDIS_URL = process.env.REDIS_TEST_URL
  Object.assign(process.env, {
    EMAIL_JOURNEYS_ENABLED: 'true',
    EMAIL_PROMOTIONS_ENABLED: 'true',
    EMAIL_NOTICE_BASIS_ENABLED: 'true',
    OFFER_SIGNUP_ENABLED: 'true',
    QUOTE_LEAD_CAPTURE_ENABLED: 'true',
    PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED: 'true',
    // Throwaway secrets, unique to this run (the per-IP throttle counts only
    // this run's HMACs).
    CONSENT_IP_HMAC_SECRET: `form-e2e-ip-${randomUUID()}`,
    EMAIL_TOKEN_SECRET: `form-e2e-token-${randomUUID()}`,
    INTERNAL_NOTIFY_TOKEN: INTERNAL_TOKEN,
    RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RESEND_API_KEY: 're_test_dummy',
    BUSINESS_POSTAL_ADDRESS: '100 Sample Street, Newark NJ 07103',
    APP_URL,
    MARKETING_SITE_URL: SITE_URL,
    // Non-interfering send policy. Parsed by email-guard numberFromEnv: a real
    // non-negative number overrides the default. Quiet hours [24, 0) never
    // match an hour 0–23; a transactional gap of 0 disables the gap check.
    EMAIL_QUIET_START_HOUR: '24',
    EMAIL_QUIET_END_HOUR: '0',
    EMAIL_CAP_PER_DAY: '1000',
    EMAIL_CAP_PER_WEEK: '1000',
    EMAIL_CAP_PER_MONTH: '1000',
    EMAIL_TRANSACTIONAL_GAP_MINUTES: '0',
    // The grant throttles count the SHARED CI database; other suites record
    // grants too. Generous, so they can never withhold this run's notices.
    CONSENT_IP_DISTINCT_EMAILS_24H: '100000',
    CONSENT_GLOBAL_GRANTS_24H: '100000',
    CONSENT_POPUP_GRANTS_24H: '100000',
    // Rebuilt by address() with this run's exact addresses (canary exemption).
    EMAIL_PROMOTIONAL_ALLOWLIST: '',
  })
  for (const k of [
    'TURNSTILE_ENABLED',
    'EMAIL_REQUIRE_TURNSTILE',
    'TURNSTILE_SECRET_KEY',
    'EMAIL_SENDING_ENABLED',
    'EMAIL_JOURNEY_QUOTE_DISABLED',
    'EMAIL_JOURNEY_ABANDONED_DISABLED',
    'EMAIL_JOURNEY_LEAD_NURTURE_DISABLED',
    'EMAIL_EBR_BASIS_ENABLED',
    'EMAIL_QUOTE_JOURNEY_MAX_AGE_DAYS',
    'CUSTOMER_AUTOREPLY_ENABLED',
    'OWNER_EMAIL',
    'EMAIL_TEST_RECIPIENT',
    'EMAIL_HERO_GIF_URL',
    'DISCORD_BOT_TOKEN',
    'DISCORD_CHANNEL_LEADS',
    'DISCORD_CHANNEL_NEWS',
    'DISCORD_CHANNEL_OPERATIONS',
    // The Upstash limiter would be a network call; unset, the public forms fail open.
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'CORS_ALLOWED_ORIGINS',
  ]) {
    delete process.env[k]
  }
  assertNoProductionCredentials()
}

// ── THIS RUN'S ADDRESSES ────────────────────────────────────────────────
const MINE = new Set<string>()
/** A synthetic @example.com address for one scenario, registered for cleanup and the canary exemption. */
function address(label: string): string {
  const email = `form-e2e-${label}-${run}@example.com`.toLowerCase()
  assertTestRecipient(email)
  MINE.add(email)
  process.env.EMAIL_PROMOTIONAL_ALLOWLIST = Array.from(MINE).join(',')
  return email
}

// ── MODULES (loaded in before(), after the environment above) ─────────────
type RouteHandler = (req: NextRequest) => Promise<Response>
let prisma: PrismaClient
let NextRequestCtor: typeof import('next/server').NextRequest
let resend: typeof import('../resend')['resend']
let queues: typeof import('../queues')
let journeys: typeof import('../journeys')
let captureBasis: typeof import('../capture-basis')
let registry: typeof import('../consent/notice-registry')
let guard: typeof import('../email-guard')
let CONSENT_VERSION: string
let processScheduledJob: typeof import('../../workers/scheduled.worker')['processScheduledJob']
let processEmailJob: typeof import('../../workers/email.worker')['processEmailJob']
const routes = {} as {
  quote: RouteHandler
  partial: RouteHandler
  contact: RouteHandler
  tracker: RouteHandler
  popup: RouteHandler
  webhook: RouteHandler
  unsubscribe: RouteHandler
}
let emailQ: Queue
let scheduledQ: Queue
let discordQ: Queue

/** Effects in the order they happened, across the route seams (see before()). */
const order: string[] = []
/** Every scenario a route asked the journeys to start, with the journeys' answer. */
const scenarioLog: Array<{ input: NoticeSubmissionInput; outcome: EnrolmentOutcome }> = []
const restores: Array<() => void> = []

before(async () => {
  if (skip) return
  ;({ prisma } = (await import('../db')) as unknown as { prisma: PrismaClient })
  await prisma.$connect()
  ;({ NextRequest: NextRequestCtor } = await import('next/server'))
  ;({ resend } = await import('../resend'))
  queues = await import('../queues')
  journeys = await import('../journeys')
  captureBasis = await import('../capture-basis')
  registry = await import('../consent/notice-registry')
  guard = await import('../email-guard')
  ;({ CONSENT_VERSION } = await import('../consent'))
  ;({ processScheduledJob } = await import('../../workers/scheduled.worker'))
  ;({ processEmailJob } = await import('../../workers/email.worker'))
  const grant = await import('../consent/grant-safeguards')
  const identity = await import('../consent/test-identity')
  const contactDeps = await import('../contact-route-deps')

  const handler = (mod: unknown) => (mod as { POST: RouteHandler }).POST
  routes.quote = handler(await import('../../../app/api/leads/quote-capture/route'))
  routes.partial = handler(await import('../../../app/api/leads/partial/route'))
  routes.contact = handler(await import('../../../app/api/contact/route'))
  routes.tracker = handler(await import('../../../app/api/notify/lead/route'))
  routes.popup = handler(await import('../../../app/api/leads/offer-signup/route'))
  routes.webhook = handler(await import('../../../app/api/email/webhook/route'))
  routes.unsubscribe = handler(await import('../../../app/api/email/unsubscribe/route'))

  emailQ = queues.getEmailQueue()
  scheduledQ = queues.getScheduledQueue()
  discordQ = queues.getDiscordQueue()

  // The provider can never be reached: between tests every send throws. Each
  // test installs its own recording stub with t.mock.method, which restores
  // this thrower when the test ends.
  ;(resend.emails as unknown as { send: unknown }).send = async () => {
    throw new Error('form-marketing-e2e: the email provider is not reachable outside a test stub')
  }

  // GRANT-TIME test identity: the real safeguards, with THIS run's reserved
  // addresses exempted. STARTSCENARIO: the production call (journeys'
  // onNoticeSubmission), recorded so ordering and refusals can be asserted.
  restores.push(
    captureBasis.__setCaptureBasisDeps({
      evaluate: (input) =>
        grant.evaluateGrantSafeguards(input, {
          testIdentity: async (email) => (MINE.has(email) ? null : identity.testIdentityReason(email)),
        }),
      async startScenario(input) {
        order.push(`scenario:${input.surface}:${input.scenario}:${input.email}`)
        const outcome = await journeys.onNoticeSubmission(input)
        scenarioLog.push({ input, outcome })
        return outcome
      },
    }),
  )
  // The contact route's team alert: the REAL Discord queue add, recorded in order.
  const realEnqueue = contactDeps.contactRouteDeps().enqueue
  restores.push(
    contactDeps.__setContactRouteDeps({
      async enqueue(job) {
        const added = (await realEnqueue(job)) as Job
        order.push(`discord:${added.id}:${String((job.payload as { email?: unknown }).email)}`)
        return added
      },
    }),
  )
})

after(async () => {
  if (skip) return
  for (const r of restores.reverse()) r()
  Reflect.deleteProperty(resend.emails, 'send')
  // Fire-and-forget work (lead notices, automation triggers, the legacy nurture
  // hooks) must settle before the rows it touches are removed.
  await sleep(2000)
  const emails = Array.from(MINE)
  const leadIds = (await prisma.lead.findMany({ where: { email: { in: emails } }, select: { id: true } })).map((l) => l.id)
  const bookingIds = (
    await prisma.booking.findMany({ where: { customer: { email: { in: emails } } }, select: { id: true } })
  ).map((b) => b.id)
  const mineJob = (data: Record<string, any> | undefined): boolean => {
    if (!data) return false
    const p = (data.payload ?? {}) as Record<string, unknown>
    return (
      leadIds.includes(data.leadId) ||
      bookingIds.includes(data.bookingId) ||
      MINE.has(data.to) ||
      MINE.has(String(p.email ?? '')) ||
      leadIds.includes(String(p.leadId ?? '')) ||
      bookingIds.includes(String(p.bookingId ?? ''))
    )
  }
  for (const q of [emailQ, scheduledQ, discordQ]) {
    const jobs = await q.getJobs(['waiting', 'delayed', 'prioritized', 'paused', 'completed', 'failed'], 0, -1).catch(() => [])
    for (const job of jobs) if (job && mineJob(job.data)) await job.remove().catch(() => undefined)
  }
  const quietly = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (err) {
      console.warn(`[form-marketing-e2e] cleanup of ${what} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await quietly('email events', () => prisma.emailEvent.deleteMany({ where: { email: { in: emails } } }))
  await quietly('email sends', () => prisma.emailSend.deleteMany({ where: { email: { in: emails } } }))
  await quietly('enrollments', () => prisma.sequenceEnrollment.deleteMany({ where: { emailNormalized: { in: emails } } }))
  await quietly('suppressions', () => prisma.emailSuppression.deleteMany({ where: { email: { in: emails } } }))
  await quietly('retry rows', () =>
    prisma.lifecycleEnqueueRetry.deleteMany({ where: { subjectId: { in: [...leadIds, ...bookingIds] } } }),
  )
  await quietly('lead notices', () => prisma.leadNotification.deleteMany({ where: { leadId: { in: leadIds } } }))
  await quietly('leads', () => prisma.lead.deleteMany({ where: { id: { in: leadIds } } }))
  await quietly('bookings', () => prisma.booking.deleteMany({ where: { id: { in: bookingIds } } }))
  await quietly('customers', () => prisma.customer.deleteMany({ where: { email: { in: emails } } }))
  await Promise.all([emailQ, scheduledQ, discordQ].map((q) => q.close().catch(() => undefined)))
  await prisma.$disconnect()
})

// ════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let ipSeq = 0
/** Each submission from its own documentation-range client IP. */
const nextIp = () => `198.51.100.${(++ipSeq % 250) + 1}`

/** POST a JSON body to a real route handler, the way the site does. */
async function post(
  handler: RouteHandler,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await handler(
    new NextRequestCtor(`${APP_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://www.moveitclearit.com',
        'x-real-ip': nextIp(),
        'user-agent': 'Mozilla/5.0 (form-marketing-e2e)',
        referer: 'https://www.moveitclearit.com/quote.html',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  )
  const text = await res.text()
  let json: any = text
  try {
    json = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  return { status: res.status, json }
}

/** A correctly Svix-signed Resend webhook, through the real route. */
let webhookSeq = 0
async function webhook(event: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const id = `msg_form_e2e_${run}_${++webhookSeq}`
  const timestamp = String(Math.floor(Date.now() / 1000))
  const raw = JSON.stringify(event)
  const key = Buffer.from(WEBHOOK_SECRET.slice('whsec_'.length), 'base64')
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64')
  const res = await routes.webhook(
    new NextRequestCtor(`${APP_URL}/api/email/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
      body: raw,
    }),
  )
  return { status: res.status, json: await res.json() }
}

// ── The provider stub ─────────────────────────────────────────────────────
type Mail = { id: string | null; to: string; subject: string; html: string; text?: string; headers?: Record<string, string> }
type ProviderMode = 'ok' | 'reject' | 'throw'

/**
 * Replace resend.emails.send for this test. `calls` is every request the send
 * guard made; `sent` only the ones the stub accepted. It refuses any address
 * that is not this run's, so a wrong recipient fails loudly.
 */
function provider(t: TestContext, script: (call: number) => ProviderMode = () => 'ok') {
  const calls: Mail[] = []
  const sent: Mail[] = []
  t.mock.method(resend.emails, 'send', async (payload: { to: string | string[]; subject: string; html?: unknown; text?: unknown; headers?: Record<string, string> }) => {
    const to = Array.isArray(payload.to) ? payload.to[0] : payload.to
    assertTestRecipient(to)
    if (!MINE.has(to)) throw new Error('form-marketing-e2e: the stub only accepts this run’s addresses')
    const mail: Mail = {
      id: null,
      to,
      subject: payload.subject,
      html: String(payload.html ?? ''),
      text: typeof payload.text === 'string' ? payload.text : undefined,
      headers: payload.headers,
    }
    calls.push(mail)
    const mode = script(calls.length)
    if (mode === 'throw') throw new Error('socket hang up')
    if (mode === 'reject') {
      return { data: null, error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' } }
    }
    mail.id = `prov_${run}_${randomUUID()}`
    sent.push(mail)
    return { data: { id: mail.id }, error: null }
  })
  return { calls, sent }
}

// ── Database reads, always scoped to one address ─────────────────────────
const leadsOf = (email: string) => prisma.lead.findMany({ where: { email }, orderBy: { createdAt: 'asc' } })
async function onlyLead(email: string) {
  const leads = await leadsOf(email)
  assert.equal(leads.length, 1, `exactly one lead for ${email}`)
  return leads[0]
}
const eventsOf = (email: string) =>
  prisma.emailConsentEvent.findMany({ where: { emailNormalized: email }, orderBy: { occurredAt: 'asc' } })
const enrollmentsOf = (email: string) =>
  prisma.sequenceEnrollment.findMany({ where: { emailNormalized: email }, orderBy: { createdAt: 'asc' } })
const sendsOf = (email: string, template?: string) =>
  prisma.emailSend.findMany({ where: { email, ...(template ? { template } : {}) }, orderBy: { createdAt: 'asc' } })
const scenariosFor = (email: string) => scenarioLog.filter((s) => s.input.email === email)

// ── Queues ────────────────────────────────────────────────────────────────
const OPEN_JOB_STATES: JobType[] = ['waiting', 'delayed', 'prioritized', 'paused']

async function queuedJobs(queue: Queue, match: (data: Record<string, any>) => boolean): Promise<Job[]> {
  const jobs = await queue.getJobs(OPEN_JOB_STATES, 0, -1, true)
  return jobs.filter((j): j is Job => Boolean(j) && match(j.data))
}
const emailJobsFor = (match: (data: EmailJobData) => boolean) => queuedJobs(emailQ, (d) => match(d as EmailJobData))

/** The existing cadences, spelled out here so this suite pins them independently. */
const STAGES: Record<SequenceKind, { key: string; stages: Array<[string, number]> }> = {
  quote_followup: { key: 'quote', stages: [['quote-followup-1', 24 * HOUR], ['quote-followup-2', 3 * DAY], ['quote-followup-final', 7 * DAY]] },
  lead_nurture: { key: 'lead-nurture', stages: [['lead-nurture-1', 4 * HOUR], ['lead-nurture-2', 24 * HOUR], ['lead-nurture-final', 72 * HOUR]] },
  abandoned_checkout: {
    key: 'abandoned',
    stages: [['abandoned-checkout-recovery', 45 * MINUTE], ['abandoned-checkout-recovery-2', 24 * HOUR], ['abandoned-checkout-recovery-3', 72 * HOUR]],
  },
}
const stageIds = (kind: SequenceKind, subjectId: string) =>
  STAGES[kind].stages.map(([type]) => `journey__${STAGES[kind].key}__${type}__${subjectId}`)
const fireAtOf = (job: Job) => job.timestamp + (job.opts?.delay ?? job.delay ?? 0)

/**
 * Every stage of `kind` exists for `subjectId`, delayed, and fires at the
 * anchor (somewhere in [from, to]) plus its cadence — shifted out of quiet
 * hours exactly as the scheduler does (a no-op under this suite's policy).
 */
async function expectStages(kind: SequenceKind, subjectId: string, from: number, to: number): Promise<Job[]> {
  const ids = stageIds(kind, subjectId)
  assert.deepEqual(journeys.stageJobIdsForKind(kind, subjectId), ids, `${kind}: the deterministic job ids`)
  const jobs: Job[] = []
  for (const [i, [type, delay]] of STAGES[kind].stages.entries()) {
    const job = await scheduledQ.getJob(ids[i])
    assert.ok(job, `${ids[i]} must be queued`)
    assert.equal(job.name, type)
    assert.equal(job.data.type, type)
    assert.equal(await job.getState(), 'delayed', `${type} waits for its time`)
    const lo = guard.nextAllowedTime(new Date(from + delay)).getTime() - TOLERANCE_MS
    const hi = guard.nextAllowedTime(new Date(to + delay)).getTime() + TOLERANCE_MS
    const fireAt = fireAtOf(job)
    assert.ok(fireAt >= lo && fireAt <= hi, `${type} fires at anchor + ${delay / MINUTE}m (got ${new Date(fireAt).toISOString()})`)
    jobs.push(job)
  }
  return jobs
}

async function expectNoStages(kind: SequenceKind, subjectId: string, why: string): Promise<void> {
  for (const id of stageIds(kind, subjectId)) assert.equal(await scheduledQ.getJob(id), undefined, `${id}: ${why}`)
}

/** Stage job → the real stage processor. Returns the email jobs that run queued. */
async function runStage(job: Job, match: (data: EmailJobData) => boolean): Promise<Job[]> {
  const seen = new Set((await emailJobsFor(match)).map((j) => j.id))
  await processScheduledJob(job as never)
  return (await emailJobsFor(match)).filter((j) => !seen.has(j.id))
}

const sendEmailJob = (job: Job) => processEmailJob(job as never)

/** The corrected lead-nurture footer (EN), matched from after the apostrophe the renderer escapes. */
const NURTURE_FOOTER_EN = /receiving this because you gave us your email about a move on moveitclearit\.com\. To stop these emails, use the Unsubscribe link below\./
const UNSUBSCRIBE_HEADER = /^<https:\/\/api\.form-marketing-e2e\.invalid\/api\/email\/unsubscribe\?token=[^>]+>$/

function expectPromotionalHeaders(mail: Mail, label: string) {
  assert.ok(mail.headers, `${label}: a promotional send carries headers`)
  assert.match(mail.headers!['List-Unsubscribe'], UNSUBSCRIBE_HEADER, `${label}: List-Unsubscribe`)
  assert.equal(mail.headers!['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click', `${label}: RFC 8058 one-click`)
}

// ── Form bodies (synthetic data only) ─────────────────────────────────────
const moveDay = () => new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10)
const QUOTE_NOTICE = { version: 'quote-2026-09-16-r2', trigger: 'submit' }
const BOOKING_NOTICE_VERSION = 'booking-2026-09-16-r2'
const CONTACT_NOTICE = { version: 'contact-2026-09-16-r2', trigger: 'submit' }
const POPUP_NOTICE = { version: 'popup-2026-09-16-r2', trigger: 'submit' }
const TRACKER_NOTICE_VERSION = 'tracker-2026-09-16-r2'

const quoteBody = (email: string, extra: Record<string, unknown> = {}) => ({
  firstName: 'Test',
  lastName: 'Fixture',
  phone: '8625550100',
  email,
  moveDate: moveDay(),
  pickupZip: '07052',
  destinationZip: '07030',
  moveSize: '1br',
  bookingSessionId: `sess-${randomUUID()}`,
  locale: 'en',
  marketingNotice: QUOTE_NOTICE,
  emailMarketingOptOut: false,
  ...extra,
})

const contactBody = (email: string, topic: 'quote' | 'booking' | 'other', extra: Record<string, unknown> = {}) => ({
  name: 'Test Customer',
  email,
  message: 'Planning a two bedroom move next month.',
  locale: 'en',
  topic,
  marketingNotice: CONTACT_NOTICE,
  emailMarketingOptOut: false,
  ...extra,
})

const partialBody = (email: string, bookingSessionId: string, extra: Record<string, unknown> = {}) => ({
  email,
  firstName: 'Test',
  lastName: 'Booker',
  bookingSessionId,
  formStep: 'card1',
  locale: 'en',
  ...extra,
})

const trackerBody = (email: string, externalId: string, extra: Record<string, unknown> = {}) => ({
  name: 'Tracker Visitor',
  email,
  phone: '8625550101',
  source: 'tracker',
  externalId,
  noticeVersion: TRACKER_NOTICE_VERSION,
  clientIp: nextIp(),
  userAgent: 'Mozilla/5.0 (form-marketing-e2e tracker)',
  submittedAt: new Date(Date.now() - MINUTE).toISOString(),
  locale: 'en',
  emailOptOut: false,
  ...extra,
})
const TRACKER_AUTH = { 'x-internal-token': INTERNAL_TOKEN }

const popupBody = (email: string) => ({ email, locale: 'en', marketingNotice: POPUP_NOTICE, emailUserTyped: true })

/** A contact submission that starts the lead nurture; returns the lead and its three stage jobs. */
async function nurtureViaContact(email: string, topic: 'quote' | 'booking' | 'other' = 'quote') {
  const t0 = Date.now()
  const res = await post(routes.contact, '/api/contact', contactBody(email, topic))
  const t1 = Date.now()
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  const lead = await onlyLead(email)
  const jobs = await expectStages('lead_nurture', lead.id, t0, t1)
  return { lead, jobs }
}

// ════════════════════════════════════════════════════════════════════════
//  1. PRICED QUICK QUOTE → quote_followup, behind the delivery gate
// ════════════════════════════════════════════════════════════════════════

const SUBJECTS = {
  'quote-request-received': { en: 'We received your moving estimate request', es: 'Recibimos su solicitud de estimado de mudanza' },
  'quote-followup-1': { en: 'Did your quote come through?', es: '¿Recibiste tu presupuesto?' },
  'lead-nurture-1': { en: 'To price your move, we need a few things', es: 'Para cotizar tu mudanza necesitamos unos datos' },
  'abandoned-checkout': { en: 'Your date is still available', es: 'Tu fecha sigue disponible' },
} as const

async function pricedQuoteFlow(t: TestContext, locale: 'en' | 'es'): Promise<Mail> {
  const email = address(`quote-priced-${locale}`)
  const mail = provider(t)

  // ── the submission ──
  const res = await post(routes.quote, '/api/leads/quote-capture', quoteBody(email, { locale, moveSize: '1br' }))
  assert.equal(res.status, 200)
  assert.equal(res.json.captured, true)
  assert.equal(res.json.emailStatus, 'queued')
  assert.ok(res.json.estimate && res.json.estimate.totalDollars > 0, 'a priced 1-4BR package produced a real server quote')

  const lead = await onlyLead(email)
  assert.ok(lead.quotedAt, 'the real quote stamped quotedAt')
  const events = await eventsOf(email)
  assert.deepEqual(events.map((e) => e.kind), ['notice_accepted'])
  const notice = events[0]
  assert.equal(notice.surface, 'quote')
  assert.equal(notice.noticeVersion, QUOTE_NOTICE.version)
  assert.equal(notice.locale, locale)
  assert.equal(notice.noticeCopySha256, registry.NOTICE_VERSIONS[QUOTE_NOTICE.version].copySha256[locale])
  assert.equal(notice.trigger, 'submit')
  assert.equal(notice.leadId, lead.id)
  assert.equal(lead.basisEventId, notice.id, 'the lead points at its notice')

  const enrollments = await enrollmentsOf(email)
  assert.deepEqual(
    enrollments.map((e) => [e.sequenceKind, e.subjectType, e.subjectId, e.status, e.basisEventId]),
    [['quote_followup', 'lead', lead.id, 'active', notice.id]],
  )
  assert.deepEqual(scenariosFor(email).map((s) => [s.input.surface, s.input.scenario, s.outcome.scheduled]), [['quote', 'quote_followup', true]])

  // ── the transactional reply the person asked for ──
  const replies = await emailJobsFor((d) => d.leadId === lead.id && d.template === 'quote-request-received')
  assert.equal(replies.length, 1, 'one quote-request-received job')
  assert.equal(replies[0].data.businessEventKey, `lead:${lead.id}:quote-request-received:v1`)
  await sendEmailJob(replies[0])
  assert.equal(mail.sent.length, 1)
  const reply = mail.sent[0]
  assert.equal(reply.to, email)
  assert.equal(reply.subject, SUBJECTS['quote-request-received'][locale])
  assert.equal(reply.headers, undefined, 'a transactional reply carries NO List-Unsubscribe header')
  const [replyRow] = await sendsOf(email, 'quote-request-received')
  assert.equal(replyRow.status, 'delivered')
  assert.equal(replyRow.emailClass, 'transactional')
  assert.equal(replyRow.marketingBasis, 'transactional')
  assert.equal(replyRow.providerId, reply.id)

  // ── Sequence A: three delayed stages anchored on quotedAt ──
  const anchor = lead.quotedAt!.getTime()
  const stages = await expectStages('quote_followup', lead.id, anchor, anchor)
  await expectNoStages('lead_nurture', lead.id, 'a real quote never runs the no-price nurture')

  // ── the delivery gate: stage 1 BEFORE the reply's delivery is confirmed ──
  const isStage1 = (d: EmailJobData) => d.leadId === lead.id && d.template === 'quote-followup-1'
  const beforeGate = Date.now()
  assert.deepEqual(await runStage(stages[0], isStage1), [], 'no email is queued while the reply is unconfirmed')
  assert.equal(mail.calls.length, 1, 'nothing was sent')
  const wait = await scheduledQ.getJob(`journey__quote__quote-followup-1__${lead.id}__wait1`)
  assert.ok(wait, 'the stage waits in a bounded step')
  assert.equal(wait.data.confirmationWaitAttempt, 1)
  assert.equal(wait.data.leadId, lead.id)
  assert.ok(Math.abs(fireAtOf(wait) - (beforeGate + 2 * HOUR)) < TOLERANCE_MS + 2 * MINUTE, 'the wait step is ~2h')

  // ── Resend reports the reply delivered (signed webhook, real route) ──
  const hook = await webhook({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: reply.id, to: [email] } })
  assert.equal(hook.status, 200, JSON.stringify(hook.json))
  assert.deepEqual(hook.json, { ok: true, result: 'recorded' })
  assert.ok((await sendsOf(email, 'quote-request-received'))[0].deliveredAt, 'delivered_at is set from the webhook')

  // ── now stage 1 goes out ──
  const queued = await runStage(stages[0], isStage1)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].data.businessEventKey, `lead:${lead.id}:quote-followup-1`)
  assert.equal((queued[0].data.payload as { locale?: string }).locale, locale, 'the stage speaks the notice’s language')
  await sendEmailJob(queued[0])
  assert.equal(mail.sent.length, 2)
  const followup = mail.sent[1]
  assert.equal(followup.to, email)
  assert.equal(followup.subject, SUBJECTS['quote-followup-1'][locale])
  expectPromotionalHeaders(followup, 'quote-followup-1')
  const [row] = await sendsOf(email, 'quote-followup-1')
  assert.equal(row.status, 'delivered')
  assert.equal(row.emailClass, 'promotional')
  assert.equal(row.marketingBasis, 'notice')
  assert.equal(row.basisEventId, notice.id)
  assert.equal(row.leadId, lead.id)
  return followup
}

test('1a. priced quick quote (EN): notice → quote_followup; reply sent without List-Unsubscribe; stages +24h/+3d/+7d; stage 1 waits for the delivered webhook, then sends on a notice basis', { skip, timeout: 120_000 }, async (t) => {
  const followup = await pricedQuoteFlow(t, 'en')
  assert.match(followup.html, /<html[^>]*lang="en"/)
  assert.match(followup.html, /receiving this because you asked us for a moving quote\./)
})

test('1b. priced quick quote (ES): the Spanish notice is recorded and every email is the Spanish version', { skip, timeout: 120_000 }, async (t) => {
  const followup = await pricedQuoteFlow(t, 'es')
  assert.match(followup.html, /<html[^>]*lang="es"/)
  assert.match(followup.html, /Te escribimos porque pediste un presupuesto para una mudanza\./)
  assert.doesNotMatch(followup.html, /receiving this because you asked us for a moving quote/)
})

// ════════════════════════════════════════════════════════════════════════
//  2. NO-PRICE QUOTE → lead_nurture, no delivery gate
// ════════════════════════════════════════════════════════════════════════

test('2. no-price quote (5BR manual plan): reply queued, lead_nurture +4h/+24h/+72h, stage 1 sends at once with the corrected footer', { skip, timeout: 120_000 }, async (t) => {
  const email = address('quote-noprice')
  const mail = provider(t)
  const t0 = Date.now()
  const res = await post(routes.quote, '/api/leads/quote-capture', quoteBody(email, { moveSize: '5br' }))
  const t1 = Date.now()
  assert.equal(res.status, 200)
  assert.equal(res.json.captured, true)
  assert.equal(res.json.emailStatus, 'queued')
  assert.equal(res.json.estimate, null, 'a hand-planned move has no automatic number')

  const lead = await onlyLead(email)
  assert.equal(lead.quotedAt, null, 'no quote was recorded')
  const events = await eventsOf(email)
  assert.deepEqual(events.map((e) => [e.kind, e.surface]), [['notice_accepted', 'quote']])
  assert.equal(lead.basisEventId, events[0].id)
  assert.deepEqual(
    (await enrollmentsOf(email)).map((e) => [e.sequenceKind, e.subjectId, e.status]),
    [['lead_nurture', lead.id, 'active']],
  )
  const replies = await emailJobsFor((d) => d.leadId === lead.id && d.template === 'quote-request-received')
  assert.equal(replies.length, 1, 'the reply is queued first, unchanged')
  assert.equal((replies[0].data.payload as Record<string, unknown>).estimatedPrice, undefined)

  const stages = await expectStages('lead_nurture', lead.id, t0, t1)
  await expectNoStages('quote_followup', lead.id, 'no price, no quote follow-up')

  const queued = await runStage(stages[0], (d) => d.leadId === lead.id && d.template === 'lead-nurture-1')
  assert.equal(queued.length, 1, 'no delivery gate on the nurture')
  await sendEmailJob(queued[0])
  assert.equal(mail.sent.length, 1)
  const sent = mail.sent[0]
  assert.equal(sent.subject, SUBJECTS['lead-nurture-1'].en)
  expectPromotionalHeaders(sent, 'lead-nurture-1')
  assert.match(sent.html, NURTURE_FOOTER_EN, 'the corrected footer sentence')
  assert.doesNotMatch(sent.html, /opted in/i, 'never claims an opt-in')
  const [row] = await sendsOf(email, 'lead-nurture-1')
  assert.equal(row.status, 'delivered')
  assert.equal(row.marketingBasis, 'notice')
  assert.equal(row.basisEventId, events[0].id)
})

// ════════════════════════════════════════════════════════════════════════
//  3. BOOKING FORM CONTACT STEP (/api/leads/partial)
// ════════════════════════════════════════════════════════════════════════

test('3. booking contact step: debounce/blur and an untyped Continue record nothing and start nothing; the typed Continue starts lead_nurture; a later autosave adds nothing', { skip, timeout: 120_000 }, async (t) => {
  const email = address('booking-step')
  const mail = provider(t)
  const session = `sess-${randomUUID()}`
  const path = '/api/leads/partial'

  // Background pings carry the notice with a trigger other than 'continue'.
  for (const trigger of ['debounce', 'blur']) {
    const res = await post(routes.partial, path, partialBody(email, session, { marketingNotice: { version: BOOKING_NOTICE_VERSION, trigger }, emailUserTyped: true }))
    assert.equal(res.status, 200)
    assert.equal(res.json.captured, true, `${trigger}: the lead is still saved`)
  }
  const lead = await onlyLead(email)
  assert.deepEqual(await eventsOf(email), [], 'a ping is not a submission: no event of any kind')
  assert.deepEqual(await enrollmentsOf(email), [])
  await expectNoStages('lead_nurture', lead.id, 'a ping starts nothing')

  // Continue, but the address was prefilled/restored (not typed on this page load).
  const untyped = await post(routes.partial, path, partialBody(email, session, { marketingNotice: { version: BOOKING_NOTICE_VERSION, trigger: 'continue' }, emailUserTyped: false }))
  assert.equal(untyped.status, 200)
  let events = await eventsOf(email)
  assert.deepEqual(events.map((e) => [e.kind, e.withheldReason]), [['basis_withheld', 'email_not_user_typed']])
  assert.deepEqual(await enrollmentsOf(email), [])
  await expectNoStages('lead_nurture', lead.id, 'an untyped Continue starts nothing')
  assert.deepEqual(scenariosFor(email), [], 'no sequence was even asked for')

  // The trusted Continue click.
  const t0 = Date.now()
  const typed = await post(routes.partial, path, partialBody(email, session, { marketingNotice: { version: BOOKING_NOTICE_VERSION, trigger: 'continue' }, emailUserTyped: true }))
  const t1 = Date.now()
  assert.equal(typed.status, 200)
  events = await eventsOf(email)
  const notices = events.filter((e) => e.kind === 'notice_accepted')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].surface, 'booking')
  assert.equal(notices[0].trigger, 'continue')
  assert.equal(notices[0].emailUserTyped, true)
  assert.equal((await onlyLead(email)).basisEventId, notices[0].id)
  assert.deepEqual((await enrollmentsOf(email)).map((e) => [e.sequenceKind, e.subjectId, e.status]), [['lead_nurture', lead.id, 'active']])
  const stages = await expectStages('lead_nurture', lead.id, t0, t1)
  const stamps = stages.map((j) => j.timestamp)

  // An autosave afterwards — a debounce ping with the notice, and a notice-less beacon.
  await post(routes.partial, path, partialBody(email, session, { marketingNotice: { version: BOOKING_NOTICE_VERSION, trigger: 'debounce' }, emailUserTyped: true, formStep: 'card2' }))
  await post(routes.partial, path, partialBody(email, session, { emailUserTyped: true, formStep: 'card3' }))
  assert.equal((await eventsOf(email)).length, events.length, 'no new event')
  assert.equal((await enrollmentsOf(email)).length, 1, 'no new enrollment')
  assert.equal((await leadsOf(email)).length, 1, 'still one lead')
  const again = await Promise.all(stageIds('lead_nurture', lead.id).map((id) => scheduledQ.getJob(id)))
  assert.deepEqual(again.map((j) => j?.timestamp), stamps, 'the stage jobs were not re-added')
  assert.equal(scenariosFor(email).length, 1, 'only the Continue click asked for a sequence')
  assert.equal(mail.calls.length, 0, 'the contact step sends nothing itself')
})

// ════════════════════════════════════════════════════════════════════════
//  4. BOOKING SUBMISSION (abandoned_checkout)
//  The /api/bookings handler cannot run offline-safe: it creates a Stripe
//  Checkout Session, verifies addresses and prices routed mileage over the
//  network, with no seam for any of them. So the rows are created here and the
//  route's OWN marketing calls run in the route's order:
//    applyCaptureBasis(booking, abandoned_checkout) → onBookingCreated →
//    startCaptureScenario  (pinned on the route source by capture-routes-consent).
// ════════════════════════════════════════════════════════════════════════

async function createPendingBooking(email: string, status: 'PENDING_PAYMENT' | 'CONFIRMED' = 'PENDING_PAYMENT', depositPaid = false) {
  const customer = await prisma.customer.create({ data: { email, name: 'Test Booker', phone: '8625550102', locale: 'en' } })
  const booking = await prisma.booking.create({
    data: {
      customerId: customer.id,
      status,
      depositPaid,
      isInternalTest: false,
      originAddress: '1 Sample Street, Newark NJ 07102',
      destAddress: '2 Sample Avenue, Hoboken NJ 07030',
      requestedDate: new Date(Date.now() + 30 * DAY),
      customerTokenExpiry: new Date(Date.now() + 30 * DAY),
      moveSizeKey: '1br',
      serviceTypeKey: 'full_service',
    },
  })
  return { customer, booking }
}

/** The /api/bookings marketing hand-over, call for call. */
async function bookingSubmitted(email: string, session: string, contractBody: Record<string, unknown>) {
  const { customer, booking } = await createPendingBooking(email)
  const contract = captureBasis.parseCaptureContract(contractBody)
  const basis = await captureBasis.applyCaptureBasis({
    surface: 'booking',
    scenario: 'abandoned_checkout',
    email: customer.email,
    bookingId: booking.id,
    customerId: customer.id,
    contract,
    acceptTrigger: 'submit',
    locale: 'en',
    region: { phone: customer.phone, postalCodes: ['07102', '07030'], country: 'US' },
    client: { ip: nextIp(), userAgent: 'Mozilla/5.0 (form-marketing-e2e)', pageUrl: 'https://www.moveitclearit.com/booking-form.html' },
    submissionKey: session,
  })
  const handover = await journeys.onBookingCreated({
    bookingId: booking.id,
    email: customer.email,
    bookingSessionId: session,
    marketingConsent: captureBasis.legacyConsentGivenOptOut(undefined, contract),
    consentSource: 'BOOKING_FORM',
    consentVersion: CONSENT_VERSION,
  })
  const scenario = await captureBasis.startCaptureScenario(basis, { surface: 'booking', email: customer.email, bookingId: booking.id })
  return { customer, booking, basis, handover, scenario, contract }
}

test('4a. booking submission: an email carried from the quote page is accepted; abandoned checkout +45m/+24h/+72h; stage 1 sends while PENDING_PAYMENT; once paid the next stage sends nothing and the jobs are gone', { skip, timeout: 120_000 }, async (t) => {
  const email = address('booking-submit')
  const mail = provider(t)
  const session = `sess-${randomUUID()}`
  const t0 = Date.now()
  // No emailUserTyped: the address came pre-filled from the earlier quote page.
  const { booking, basis, handover, scenario, contract } = await bookingSubmitted(email, session, {
    marketingNotice: { version: BOOKING_NOTICE_VERSION, trigger: 'submit' },
    emailMarketingOptOut: false,
  })
  const t1 = Date.now()
  assert.equal(contract.emailUserTyped, undefined)
  assert.equal(basis.status, 'granted', JSON.stringify(basis))
  assert.equal((basis as { stored: boolean }).stored, true)
  assert.equal(handover.convertedLeadId, null, 'no lead to convert')
  assert.equal(handover.abandoned?.scheduled, 3)
  assert.deepEqual(scenario, { scheduled: true, stages: 3 }, 'the route’s own scenario request is idempotent with the hand-over')

  const events = await eventsOf(email)
  assert.deepEqual(events.map((e) => [e.kind, e.surface, e.bookingId]), [['notice_accepted', 'booking', booking.id]])
  assert.equal(events[0].emailUserTyped, null)
  assert.equal((await prisma.booking.findUnique({ where: { id: booking.id } }))?.basisEventId, events[0].id)
  assert.deepEqual(
    (await enrollmentsOf(email)).map((e) => [e.sequenceKind, e.subjectType, e.subjectId, e.status]),
    [['abandoned_checkout', 'booking', booking.id, 'active']],
  )
  const stages = await expectStages('abandoned_checkout', booking.id, t0, t1)

  // Stage 1 while the deposit is still owed.
  const queued = await runStage(stages[0], (d) => d.bookingId === booking.id && d.template === 'abandoned-checkout')
  assert.equal(queued.length, 1)
  await sendEmailJob(queued[0])
  assert.equal(mail.sent.length, 1)
  assert.equal(mail.sent[0].subject, SUBJECTS['abandoned-checkout'].en)
  expectPromotionalHeaders(mail.sent[0], 'abandoned-checkout')
  const [row] = await sendsOf(email, 'abandoned-checkout')
  assert.equal(row.status, 'delivered')
  assert.equal(row.bookingId, booking.id)
  assert.equal(row.marketingBasis, 'notice')
  assert.equal(row.basisEventId, events[0].id)

  // The deposit is authorised: fulfillment moves the booking on and runs onBookingPaid.
  await prisma.booking.update({ where: { id: booking.id }, data: { status: 'PENDING_APPROVAL' } })
  await journeys.onBookingPaid(booking.id)
  await expectNoStages('abandoned_checkout', booking.id, 'payment removes the recovery stages')
  assert.deepEqual(
    await runStage(stages[1], (d) => d.bookingId === booking.id && d.template === 'abandoned-checkout-2'),
    [],
    'a stage that still fired after payment queues nothing',
  )
  assert.equal(mail.calls.length, 1, 'and nothing more is sent')
})

test('4b. a booking for an address with a running lead_nurture stops that nurture (person-level stop) and its next stage sends nothing', { skip, timeout: 120_000 }, async (t) => {
  const email = address('booking-stops-nurture')
  const mail = provider(t)
  const session = `sess-${randomUUID()}`
  const t0 = Date.now()
  await post(routes.partial, '/api/leads/partial', partialBody(email, session, { marketingNotice: { version: BOOKING_NOTICE_VERSION, trigger: 'continue' }, emailUserTyped: true }))
  const t1 = Date.now()
  const lead = await onlyLead(email)
  const nurture = await expectStages('lead_nurture', lead.id, t0, t1)

  const { booking, handover } = await bookingSubmitted(email, session, {
    marketingNotice: { version: BOOKING_NOTICE_VERSION, trigger: 'submit' },
    emailMarketingOptOut: false,
    emailUserTyped: true,
  })
  assert.equal(handover.convertedLeadId, lead.id, 'the booking converts the contact-step lead')
  const converted = await prisma.lead.findUnique({ where: { id: lead.id } })
  assert.equal(converted?.status, 'BOOKED')
  assert.equal(converted?.convertedBookingId, booking.id)

  const enrollments = await enrollmentsOf(email)
  const nurtureRow = enrollments.find((e) => e.sequenceKind === 'lead_nurture')
  assert.equal(nurtureRow?.status, 'stopped')
  //  Two stop hooks run on a booking: the converted lead closes (lead_closed)
  //  and the person-level stop (person_booked). Whichever lands first names it.
  assert.ok(['lead_closed', 'person_booked'].includes(String(nurtureRow?.stopReason)), String(nurtureRow?.stopReason))
  assert.equal(enrollments.find((e) => e.sequenceKind === 'abandoned_checkout')?.status, 'active', 'the booking’s own sequence is untouched')
  await expectNoStages('lead_nurture', lead.id, 'the booking cancelled the nurture stages')

  for (const [i, template] of (['lead-nurture-1', 'lead-nurture-2'] as const).entries()) {
    assert.deepEqual(await runStage(nurture[i], (d) => d.leadId === lead.id && d.template === template), [], `${template} queues nothing after the booking`)
  }
  assert.equal(mail.calls.length, 0, 'no nurture email to someone who booked')
})

// ════════════════════════════════════════════════════════════════════════
//  5. CONTACT FORM — answer first, then lead_nurture
// ════════════════════════════════════════════════════════════════════════

test('5a. contact form, topics quote / booking / other: the Discord team alert is queued BEFORE lead_nurture is started, and a first-time address is enrolled with its three stages', { skip, timeout: 120_000 }, async (t) => {
  const mail = provider(t)
  for (const topic of ['quote', 'booking', 'other'] as const) {
    const email = address(`contact-${topic}`)
    const surface = topic === 'quote' ? 'contact' : 'contact_support'
    const mark = order.length
    const t0 = Date.now()
    const res = await post(routes.contact, '/api/contact', contactBody(email, topic))
    const t1 = Date.now()
    assert.equal(res.status, 200, topic)
    assert.equal(res.json.ok, true)

    const lead = await onlyLead(email)
    const events = await eventsOf(email)
    assert.deepEqual(events.map((e) => [e.kind, e.surface]), [['notice_accepted', surface]], topic)
    assert.equal(lead.basisEventId, events[0].id)

    // ANSWER FIRST, observed at the route's seams…
    const effects = order.slice(mark).filter((e) => e.endsWith(`:${email}`))
    const alertAt = effects.findIndex((e) => e.startsWith('discord:'))
    const scenarioAt = effects.indexOf(`scenario:${surface}:lead_nurture:${email}`)
    assert.ok(alertAt > -1, `${topic}: the team alert was queued`)
    assert.ok(scenarioAt > alertAt, `${topic}: the lead nurture was asked for only after the alert (${effects.join(' → ')})`)
    const alertJob = await discordQ.getJob(effects[alertAt].split(':')[1])
    assert.ok(alertJob, `${topic}: the alert is a real Discord job`)
    assert.equal(alertJob.data.type, 'contact-message')
    assert.equal(alertJob.data.payload.email, email)

    // …and in Redis.
    assert.deepEqual((await enrollmentsOf(email)).map((e) => [e.sequenceKind, e.subjectId, e.status]), [['lead_nurture', lead.id, 'active']], topic)
    const stages = await expectStages('lead_nurture', lead.id, t0, t1)
    assert.ok(alertJob.timestamp <= stages[0].timestamp, `${topic}: the alert job predates the first stage job`)
  }
  assert.equal(mail.calls.length, 0, 'the contact form sends no customer email of its own')
})

test('5b. contact form, topic booking, from an address that already has a real booking: the notice is recorded, the alert is queued, and the existing previous_customer rule refuses the nurture', { skip, timeout: 120_000 }, async (t) => {
  const mail = provider(t)
  const email = address('contact-previous-customer')
  await createPendingBooking(email, 'CONFIRMED', true)
  const mark = order.length
  const res = await post(routes.contact, '/api/contact', contactBody(email, 'booking'))
  assert.equal(res.status, 200)
  const lead = await onlyLead(email)
  assert.deepEqual((await eventsOf(email)).map((e) => [e.kind, e.surface]), [['notice_accepted', 'contact_support']])
  assert.ok(order.slice(mark).some((e) => e.startsWith('discord:') && e.endsWith(`:${email}`)), 'the team is still alerted')
  assert.deepEqual(scenariosFor(email).map((s) => s.outcome), [{ scheduled: false, reason: 'previous_customer' }])
  assert.deepEqual(await enrollmentsOf(email), [], 'no enrollment')
  await expectNoStages('lead_nurture', lead.id, 'a previous customer never gets the first-time nurture')
  assert.equal(mail.calls.length, 0)
})

// ════════════════════════════════════════════════════════════════════════
//  6. POPUP (/api/leads/offer-signup)
// ════════════════════════════════════════════════════════════════════════

test('6. popup: the response body is unchanged; popup-offer lead, notice, lead_nurture; stage 1 greets "there", never a placeholder name', { skip, timeout: 120_000 }, async (t) => {
  const email = address('popup')
  const mail = provider(t)
  const t0 = Date.now()
  const res = await post(routes.popup, '/api/leads/offer-signup', popupBody(email))
  const t1 = Date.now()
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { ok: true, code: 'MOVE10' })
  assert.equal(mail.calls.length, 0, 'the request itself sends nothing')

  const lead = await onlyLead(email)
  assert.match(String(lead.message ?? ''), /10% code/, 'the popup-offer lead')
  const events = await eventsOf(email)
  assert.deepEqual(events.map((e) => [e.kind, e.surface, e.noticeVersion]), [['notice_accepted', 'popup', POPUP_NOTICE.version]])
  assert.equal(lead.basisEventId, events[0].id)
  assert.deepEqual((await enrollmentsOf(email)).map((e) => [e.sequenceKind, e.subjectId, e.status]), [['lead_nurture', lead.id, 'active']])
  const stages = await expectStages('lead_nurture', lead.id, t0, t1)

  const queued = await runStage(stages[0], (d) => d.leadId === lead.id && d.template === 'lead-nurture-1')
  assert.equal(queued.length, 1)
  assert.equal((queued[0].data.payload as { customerName?: unknown }).customerName, undefined, 'no placeholder name reaches the payload')
  await sendEmailJob(queued[0])
  assert.equal(mail.sent.length, 1)
  assert.match(mail.sent[0].html, /Hi there, we got your message\./)
  assert.doesNotMatch(mail.sent[0].html, /Website lead/i)
  assert.match(mail.sent[0].html, NURTURE_FOOTER_EN)
  expectPromotionalHeaders(mail.sent[0], 'lead-nurture-1 (popup)')
})

// ════════════════════════════════════════════════════════════════════════
//  7. TRACKER FORWARD (/api/notify/lead)
// ════════════════════════════════════════════════════════════════════════

test('7. tracker forward: token required; lead with utmCampaign = sourceCode, notice, lead_nurture; the transactional acknowledgement goes out; a replay of the same externalId adds nothing', { skip, timeout: 120_000 }, async (t) => {
  const email = address('tracker')
  const mail = provider(t)
  const externalId = `trk_${run}`
  const sourceCode = 'dh-sept-2026'

  const unauthorised = await post(routes.tracker, '/api/notify/lead', trackerBody(email, externalId, { sourceCode }))
  assert.equal(unauthorised.status, 401)
  assert.deepEqual(await leadsOf(email), [], 'an unauthenticated forward ingests nothing')

  const t0 = Date.now()
  const res = await post(routes.tracker, '/api/notify/lead', trackerBody(email, externalId, { sourceCode }), TRACKER_AUTH)
  const t1 = Date.now()
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { ok: true })

  const lead = await onlyLead(email)
  assert.equal(lead.utmCampaign, sourceCode)
  assert.equal(lead.utmSource, 'tracker')
  const events = await eventsOf(email)
  assert.deepEqual(events.map((e) => [e.kind, e.surface, e.noticeVersion]), [['notice_accepted', 'tracker', TRACKER_NOTICE_VERSION]])
  assert.equal(events[0].requestId, captureBasis.captureRequestId('tracker', 'submit', externalId, email))
  assert.deepEqual((await enrollmentsOf(email)).map((e) => [e.sequenceKind, e.subjectId, e.status]), [['lead_nurture', lead.id, 'active']])
  const stages = await expectStages('lead_nurture', lead.id, t0, t1)

  // The acknowledgement auto-reply: transactional, through the guard, no unsubscribe header.
  assert.equal(mail.sent.length, 1)
  assert.equal(mail.sent[0].to, email)
  assert.equal(mail.sent[0].subject, 'We got your request')
  assert.equal(mail.sent[0].headers, undefined)
  const [ack] = await sendsOf(email, 'lead-acknowledgement')
  assert.equal(ack.status, 'delivered')
  assert.equal(ack.emailClass, 'transactional')

  // The tracker retries the same forward.
  const replay = await post(routes.tracker, '/api/notify/lead', trackerBody(email, externalId, { sourceCode, submittedAt: new Date().toISOString() }), TRACKER_AUTH)
  assert.equal(replay.status, 200)
  assert.deepEqual(replay.json, { ok: true, duplicate: true })
  assert.equal((await eventsOf(email)).length, 1, 'no second event')
  assert.equal((await leadsOf(email)).length, 1, 'no second lead')
  assert.equal((await enrollmentsOf(email)).length, 1, 'no second enrollment')
  assert.equal(scenariosFor(email).length, 1, 'no second scenario request')
  const again = await Promise.all(stageIds('lead_nurture', lead.id).map((id) => scheduledQ.getJob(id)))
  assert.deepEqual(again.map((j) => j?.timestamp), stages.map((j) => j.timestamp), 'no stage re-added')
  assert.equal(mail.calls.length, 1, 'no second acknowledgement')
})

// ════════════════════════════════════════════════════════════════════════
//  NEGATIVE / STOP CASES
// ════════════════════════════════════════════════════════════════════════

async function expectOptedOut(email: string, surface: string) {
  const events = await eventsOf(email)
  assert.deepEqual(events.map((e) => [e.kind, e.surface, e.optOutBox]), [['opted_out_at_capture', surface, true]], `${surface}: the withdrawal, and nothing granted beside it`)
  const status = await prisma.emailMarketingStatus.findUnique({ where: { emailNormalized: email } })
  assert.ok(status?.optedOutAt, `${surface}: the person's status records the opt-out`)
  assert.deepEqual(await enrollmentsOf(email), [], `${surface}: no enrollment`)
  assert.deepEqual(scenariosFor(email), [], `${surface}: no sequence asked for`)
  const lead = await onlyLead(email)
  for (const kind of ['lead_nurture', 'quote_followup'] as const) await expectNoStages(kind, lead.id, `${surface}: opted out`)
  return lead
}

test('8. opt-out box ticked on the quote, contact, booking-step and tracker forms: opted_out_at_capture, no enrollment, no jobs — and the transactional quote reply / tracker acknowledgement still go out', { skip, timeout: 120_000 }, async (t) => {
  const mail = provider(t)

  // Quick quote (priced).
  const quoteEmail = address('optout-quote')
  const quote = await post(routes.quote, '/api/leads/quote-capture', quoteBody(quoteEmail, { emailMarketingOptOut: true }))
  assert.equal(quote.status, 200)
  assert.equal(quote.json.emailStatus, 'queued')
  const quoteLead = await expectOptedOut(quoteEmail, 'quote')
  const replies = await emailJobsFor((d) => d.leadId === quoteLead.id && d.template === 'quote-request-received')
  assert.equal(replies.length, 1)
  await sendEmailJob(replies[0])
  assert.deepEqual(mail.sent.map((m) => [m.to, m.subject]), [[quoteEmail, SUBJECTS['quote-request-received'].en]], 'the reply the person asked for is still sent')

  // Contact form.
  const contactEmail = address('optout-contact')
  const mark = order.length
  const contact = await post(routes.contact, '/api/contact', contactBody(contactEmail, 'quote', { emailMarketingOptOut: true }))
  assert.equal(contact.status, 200)
  await expectOptedOut(contactEmail, 'contact')
  assert.ok(order.slice(mark).some((e) => e.startsWith('discord:') && e.endsWith(`:${contactEmail}`)), 'the team is still alerted')

  // Booking form, contact step Continue.
  const bookingEmail = address('optout-booking')
  const step = await post(
    routes.partial,
    '/api/leads/partial',
    partialBody(bookingEmail, `sess-${randomUUID()}`, { marketingNotice: { version: BOOKING_NOTICE_VERSION, trigger: 'continue' }, emailUserTyped: true, emailMarketingOptOut: true }),
  )
  assert.equal(step.status, 200)
  await expectOptedOut(bookingEmail, 'booking')

  // Tracker forward.
  const trackerEmail = address('optout-tracker')
  const forward = await post(routes.tracker, '/api/notify/lead', trackerBody(trackerEmail, `trk_opt_${run}`, { emailOptOut: true }), TRACKER_AUTH)
  assert.equal(forward.status, 200)
  await expectOptedOut(trackerEmail, 'tracker')
  assert.deepEqual(mail.sent.slice(1).map((m) => [m.to, m.subject, m.headers]), [[trackerEmail, 'We got your request', undefined]], 'the acknowledgement is transactional')

  assert.equal(mail.calls.length, 2, 'only the two transactional replies were sent')
})

test('9. unsubscribe: the real one-click route suppresses, records the withdrawal and stops the enrollment; stage 2 sends nothing; a new form records a notice but starts nothing and never lifts the suppression; the transactional quote reply is still sent', { skip, timeout: 120_000 }, async (t) => {
  const email = address('unsubscribe')
  const mail = provider(t)
  const { lead, jobs } = await nurtureViaContact(email, 'quote')
  const notice = (await eventsOf(email))[0]

  const [stage1] = await runStage(jobs[0], (d) => d.leadId === lead.id && d.template === 'lead-nurture-1')
  await sendEmailJob(stage1)
  assert.equal(mail.sent.length, 1)
  expectPromotionalHeaders(mail.sent[0], 'lead-nurture-1')

  // RFC 8058 one-click, using the exact URL the email carried.
  const unsubscribeUrl = mail.sent[0].headers!['List-Unsubscribe'].slice(1, -1)
  const unsub = await routes.unsubscribe(
    new NextRequestCtor(unsubscribeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    }),
  )
  assert.equal(unsub.status, 200)
  assert.deepEqual(await unsub.json(), { ok: true, status: 'unsubscribed' })
  const suppression = await prisma.emailSuppression.findUnique({ where: { email } })
  assert.equal(suppression?.reason, 'UNSUBSCRIBED')
  assert.equal(suppression?.scope, 'promotional')
  assert.ok((await eventsOf(email)).some((e) => e.kind === 'unsubscribed' && e.surface === 'unsubscribe_link'), 'the withdrawal is on record')
  const [enrollment] = await enrollmentsOf(email)
  assert.equal(enrollment.status, 'stopped')
  //  The unsubscribe event stops it, and so does the suppression it writes
  //  (email-suppression.suppress); whichever lands first names the reason.
  assert.ok(['unsubscribed', 'suppressed:unsubscribed'].includes(String(enrollment.stopReason)), String(enrollment.stopReason))

  // Stage 2 fires anyway (the unsubscribe does not remove queued jobs): nothing goes out.
  assert.deepEqual(await runStage(jobs[1], (d) => d.leadId === lead.id && d.template === 'lead-nurture-2'), [])
  assert.equal(mail.calls.length, 1)

  // Clear the old stage jobs so anything a new submission queued would be visible.
  for (const job of jobs) await job.remove().catch(() => undefined)
  const optedOutAt = (await prisma.emailMarketingStatus.findUnique({ where: { emailNormalized: email } }))?.optedOutAt
  assert.ok(optedOutAt)

  // A NEW form submission from the same address: a quote with no price.
  const again = await post(routes.quote, '/api/leads/quote-capture', quoteBody(email, { moveSize: '5br' }))
  assert.equal(again.status, 200)
  assert.equal(again.json.captured, true)
  assert.equal(again.json.emailStatus, 'queued')
  const events = await eventsOf(email)
  const quoteNotices = events.filter((e) => e.kind === 'notice_accepted' && e.surface === 'quote')
  assert.equal(quoteNotices.length, 1, 'the new submission is recorded as the notice it is')
  assert.ok(!events.some((e) => e.kind === 'express_opt_in' || e.kind === 'resubscribed'), 'a form never resubscribes')
  assert.deepEqual(scenariosFor(email).map((s) => s.outcome).at(-1), { scheduled: false, reason: 'suppressed' })
  assert.deepEqual((await enrollmentsOf(email)).map((e) => [e.id, e.status]), [[enrollment.id, 'stopped']], 'no new enrollment')
  const sameLead = await onlyLead(email)
  assert.equal(sameLead.id, lead.id)
  await expectNoStages('lead_nurture', lead.id, 'an unsubscribed person starts nothing')
  await expectNoStages('quote_followup', lead.id, 'an unsubscribed person starts nothing')
  const still = await prisma.emailSuppression.findUnique({ where: { email } })
  assert.deepEqual([still?.reason, still?.scope], ['UNSUBSCRIBED', 'promotional'], 'the suppression is never lifted by a form')
  const status = await prisma.emailMarketingStatus.findUnique({ where: { emailNormalized: email } })
  assert.equal(status?.optedOutAt?.getTime(), optedOutAt.getTime(), 'the opt-out still stands')
  assert.equal(status?.lastNoticeEventId, quoteNotices[0].id, 'the latest submission is on the status row')
  assert.notEqual(notice.id, quoteNotices[0].id)

  // The reply to the new quote request is transactional: a promotional-scope unsubscribe does not block it.
  const replies = await emailJobsFor((d) => d.leadId === lead.id && d.template === 'quote-request-received')
  assert.equal(replies.length, 1)
  await sendEmailJob(replies[0])
  assert.equal(mail.sent.length, 2)
  assert.equal(mail.sent[1].subject, SUBJECTS['quote-request-received'].en)
  assert.equal(mail.sent[1].headers, undefined)
})

test('10. complaint and hard bounce: signed webhooks suppress (scope all); later stages send nothing; a new form submission does not re-subscribe', { skip, timeout: 180_000 }, async (t) => {
  const mail = provider(t)
  const cases = [
    { label: 'complaint', type: 'email.complained', extra: {}, reason: 'SPAM_COMPLAINT', column: 'complainedAt' as const, via: 'popup' as const },
    { label: 'hard-bounce', type: 'email.bounced', extra: { bounce: { type: 'Permanent', subType: 'General' } }, reason: 'HARD_BOUNCE', column: 'bouncedAt' as const, via: 'contact' as const },
  ]
  for (const c of cases) {
    const email = address(c.label)
    let lead: Awaited<ReturnType<typeof onlyLead>>
    let jobs: Job[]
    if (c.via === 'popup') {
      const t0 = Date.now()
      assert.deepEqual((await post(routes.popup, '/api/leads/offer-signup', popupBody(email))).json, { ok: true, code: 'MOVE10' })
      lead = await onlyLead(email)
      jobs = await expectStages('lead_nurture', lead.id, t0, Date.now())
    } else {
      ;({ lead, jobs } = await nurtureViaContact(email, 'other'))
    }
    const [stage1] = await runStage(jobs[0], (d) => d.leadId === lead.id && d.template === 'lead-nurture-1')
    const sentBefore = mail.sent.length
    await sendEmailJob(stage1)
    assert.equal(mail.sent.length, sentBefore + 1, c.label)
    const providerId = mail.sent[mail.sent.length - 1].id

    const hook = await webhook({ type: c.type, created_at: new Date().toISOString(), data: { email_id: providerId, to: [email], ...c.extra } })
    assert.equal(hook.status, 200, `${c.label}: ${JSON.stringify(hook.json)}`)
    assert.deepEqual(hook.json, { ok: true, result: `suppressed:${c.reason}` })
    const suppression = await prisma.emailSuppression.findUnique({ where: { email } })
    assert.deepEqual([suppression?.reason, suppression?.scope], [c.reason, 'all'], c.label)
    const [row] = await sendsOf(email, 'lead-nurture-1')
    assert.ok(row[c.column], `${c.label}: ${c.column} recorded on the send`)

    const calls = mail.calls.length
    assert.deepEqual(await runStage(jobs[1], (d) => d.leadId === lead.id && d.template === 'lead-nurture-2'), [], `${c.label}: stage 2 queues nothing`)
    assert.equal(mail.calls.length, calls, `${c.label}: nothing sent`)

    for (const job of jobs) await job.remove().catch(() => undefined)
    const enrollmentsBefore = (await enrollmentsOf(email)).map((e) => e.id)
    const noticesBefore = (await eventsOf(email)).filter((e) => e.kind === 'notice_accepted').length
    const res = await post(routes.contact, '/api/contact', contactBody(email, 'quote', { message: 'Still need help with my move.' }))
    assert.equal(res.status, 200)
    assert.equal((await eventsOf(email)).filter((e) => e.kind === 'notice_accepted').length, noticesBefore + 1, `${c.label}: the new notice is recorded`)
    assert.deepEqual(scenariosFor(email).map((s) => s.outcome).at(-1), { scheduled: false, reason: 'suppressed' }, c.label)
    assert.deepEqual((await enrollmentsOf(email)).map((e) => e.id), enrollmentsBefore, `${c.label}: no new enrollment`)
    await expectNoStages('lead_nurture', lead.id, `${c.label}: nothing re-scheduled`)
    const still = await prisma.emailSuppression.findUnique({ where: { email } })
    assert.deepEqual([still?.reason, still?.scope], [c.reason, 'all'], `${c.label}: the suppression stands`)
    assert.equal(mail.calls.length, calls, `${c.label}: the new submission sends nothing`)
  }
})

// ════════════════════════════════════════════════════════════════════════
//  11. DUPLICATES AND REPEATS
// ════════════════════════════════════════════════════════════════════════

test('11a. the same quote submitted 3 times (same bookingSessionId): one lead, one notice event, one enrollment, one set of jobs, one transactional email', { skip, timeout: 120_000 }, async (t) => {
  const email = address('dup-quote')
  const mail = provider(t)
  const session = `sess-${randomUUID()}`
  const statuses: string[] = []
  for (let i = 0; i < 3; i++) {
    const res = await post(routes.quote, '/api/leads/quote-capture', quoteBody(email, { bookingSessionId: session, moveSize: '2br' }))
    assert.equal(res.status, 200)
    assert.equal(res.json.captured, true)
    statuses.push(res.json.emailStatus)
  }
  assert.deepEqual(statuses, ['queued', 'already_queued', 'already_queued'])
  const lead = await onlyLead(email)
  const events = await eventsOf(email)
  assert.deepEqual(events.map((e) => e.kind), ['notice_accepted'], 'UNIQUE (request_id, kind): one notice')
  assert.ok(scenariosFor(email).every((s) => s.input.basisEventId === events[0].id), 'every repeat names the SAME basis')
  assert.deepEqual((await enrollmentsOf(email)).map((e) => [e.sequenceKind, e.subjectId]), [['quote_followup', lead.id]])
  const anchor = lead.quotedAt!.getTime()
  await expectStages('quote_followup', lead.id, anchor, anchor)
  const stageJobs = await queuedJobs(scheduledQ, (d) => d.leadId === lead.id)
  assert.equal(stageJobs.length, 3, 'one set of stage jobs, nothing else for this lead')

  const replies = await emailJobsFor((d) => d.leadId === lead.id && d.template === 'quote-request-received')
  assert.equal(replies.length, 1, 'one reply queued')
  for (const job of replies) await sendEmailJob(job)
  assert.equal(mail.sent.length, 1, 'one transactional email')
  assert.equal((await sendsOf(email)).length, 1)
})

test('11b. a second, different contact submission from the same notice person within 30 days: the notice is recorded, no second lead_nurture enrollment or jobs (same lead, and a new lead)', { skip, timeout: 120_000 }, async (t) => {
  const email = address('dup-contact')
  const mail = provider(t)
  const { lead, jobs } = await nurtureViaContact(email, 'quote')
  const stamps = jobs.map((j) => j.timestamp)
  const [enrollment] = await enrollmentsOf(email)

  // A different message, days later in real life: it merges into the open lead.
  const second = await post(routes.contact, '/api/contact', contactBody(email, 'other', { message: 'Can you also move a piano?' }))
  assert.equal(second.status, 200)
  const notices = (await eventsOf(email)).filter((e) => e.kind === 'notice_accepted')
  assert.deepEqual(notices.map((e) => e.surface), ['contact', 'contact_support'], 'the second submission is recorded, never withheld per address')
  assert.equal((await onlyLead(email)).id, lead.id)
  assert.deepEqual((await enrollmentsOf(email)).map((e) => e.id), [enrollment.id], 'no second enrollment')
  const again = await Promise.all(stageIds('lead_nurture', lead.id).map((id) => scheduledQ.getJob(id)))
  assert.deepEqual(again.map((j) => j?.timestamp), stamps, 'the stage jobs were not re-added')

  // The owner closes the first lead; the next message opens a NEW lead for the same person.
  await prisma.lead.update({ where: { id: lead.id }, data: { status: 'LOST', lostAt: new Date() } })
  const third = await post(routes.contact, '/api/contact', contactBody(email, 'quote', { message: 'Actually we are moving after all.' }))
  assert.equal(third.status, 200)
  const leads = await leadsOf(email)
  assert.equal(leads.length, 2)
  const newLead = leads.find((l) => l.id !== lead.id)!
  assert.equal((await eventsOf(email)).filter((e) => e.kind === 'notice_accepted').length, 3, 'the notice is recorded on the new lead too')
  assert.equal(newLead.basisEventId, (await eventsOf(email)).filter((e) => e.kind === 'notice_accepted').at(-1)?.id)
  assert.deepEqual(
    scenariosFor(email).filter((s) => s.input.leadId === newLead.id).map((s) => s.outcome),
    [{ scheduled: false, reason: 'already_enrolled' }],
    'one lead nurture per person: the enrollment claim refuses the second subject',
  )
  assert.deepEqual((await enrollmentsOf(email)).map((e) => e.id), [enrollment.id])
  await expectNoStages('lead_nurture', newLead.id, 'no second set of jobs')
  assert.equal(mail.calls.length, 0)
})

// ════════════════════════════════════════════════════════════════════════
//  12. RETRY / IDEMPOTENCY at the provider edge
// ════════════════════════════════════════════════════════════════════════

test('12a. a transient provider rejection (429) on the first attempt, success on the next: exactly one successful provider call and one delivered email_sends row; re-processing sends nothing', { skip, timeout: 120_000 }, async (t) => {
  const email = address('retry')
  const mail = provider(t, (call) => (call === 1 ? 'reject' : 'ok'))
  const { lead, jobs } = await nurtureViaContact(email, 'other')
  const isStage1 = (d: EmailJobData) => d.leadId === lead.id && d.template === 'lead-nurture-1'
  const [job] = await runStage(jobs[0], isStage1)

  // Attempt 1: the provider refuses. The job throws so BullMQ would retry it.
  await assert.rejects(() => sendEmailJob(job), (err: unknown) => err instanceof Error && err.name === 'ProviderRejectedError')
  let rows = await sendsOf(email, 'lead-nurture-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'provider_rejected')
  assert.equal(rows[0].attempts, 1)
  assert.ok(rows[0].nextAttemptAt && rows[0].nextAttemptAt.getTime() > Date.now(), 'the ledger holds the retry until its due time')

  // BullMQ's retry arrives before that due time: nothing is sent, the send is re-queued at the due time.
  const seen = new Set((await emailJobsFor(isStage1)).map((j) => j.id))
  await sendEmailJob(job)
  assert.equal(mail.calls.length, 1, 'not due: no provider call')
  const deferred = (await emailJobsFor(isStage1)).filter((j) => !seen.has(j.id))
  assert.equal(deferred.length, 1)
  assert.ok(String(deferred[0].id).startsWith(`${job.id}__deferred__not_due__`), String(deferred[0].id))

  // Time passes: the ledger's due time is reached (the one direct write in this test).
  await prisma.emailSend.update({ where: { id: rows[0].id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
  await sendEmailJob(deferred[0])
  assert.equal(mail.calls.length, 2)
  assert.equal(mail.sent.length, 1, 'exactly one successful provider call')
  rows = await sendsOf(email, 'lead-nurture-1')
  assert.equal(rows.length, 1, 'ONE logical send')
  assert.equal(rows[0].status, 'delivered')
  assert.equal(rows[0].attempts, 2)
  assert.equal(rows[0].providerId, mail.sent[0].id)

  // Replays of either job after success send nothing.
  await sendEmailJob(job)
  await sendEmailJob(deferred[0])
  assert.equal(mail.calls.length, 2, 'a delivered key is terminal')
  assert.equal((await sendsOf(email, 'lead-nurture-1')).length, 1)
})

test('12b. a THROWN provider error is an unknown outcome: recorded ambiguous and never automatically re-sent', { skip, timeout: 120_000 }, async (t) => {
  const email = address('ambiguous')
  const mail = provider(t, () => 'throw')
  const { lead, jobs } = await nurtureViaContact(email, 'other')
  const [job] = await runStage(jobs[0], (d) => d.leadId === lead.id && d.template === 'lead-nurture-1')
  await sendEmailJob(job)
  assert.equal(mail.calls.length, 1)
  let [row] = await sendsOf(email, 'lead-nurture-1')
  assert.equal(row.status, 'ambiguous')
  await sendEmailJob(job)
  assert.equal(mail.calls.length, 1, 'a possibly-accepted send is never repeated')
  ;[row] = await sendsOf(email, 'lead-nurture-1')
  assert.equal(row.status, 'ambiguous')
  assert.equal(mail.sent.length, 0)
})
