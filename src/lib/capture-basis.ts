// ════════════════════════════════════════════════════════════════════════
//  capture-basis.ts — what a PUBLIC capture route records about marketing
//  email, and the scenario sequence it may start (email consent release
//  2026-09-16, DESIGN-v2 §1, §4, §6).
//  ---------------------------------------------------------------------
//  ONE implementation for every capture route (quick quote, booking-form
//  Continue, booking submit, contact form, tracker forward, 10%-off popup), so
//  the rules below cannot drift between six handlers:
//
//    • THE SURFACE COMES FROM THE ROUTE, never the body. A notice version the
//      registry does not know, or knows for a different surface or locale, is
//      ABSENT: the submission is recorded as `basis_withheld`.
//    • THE TRIGGER MUST BE THE ROUTE'S OWN. The booking form pings its route
//      from debounce, blur, a toggle and exit beacons; only the Step-1 Continue
//      click ('continue') may carry a notice. A notice on any other trigger is
//      ignored outright — no event, no basis.
//    • THE OPT-OUT BOX ALWAYS WINS. `emailMarketingOptOut: true` records
//      `opted_out_at_capture` (which stops the person's enrollments in the same
//      transaction), cancels their queued jobs, and never grants anything.
//      Honoured on any trigger: opting someone OUT is the safe direction.
//    • FAIL CLOSED FOR MARKETING, FAIL SOFT FOR THE CUSTOMER. Nothing here
//      throws, and nothing here can stop the lead being saved or the
//      transactional email going out — every failure is an outcome to log.
//    • NEVER a consent column. A notice is not an opt-in; Lead and Customer
//      `emailMarketingConsent` are not touched from here, and no form — the
//      popup included — records an opt-in (owner direction 2026-09-16).
//    • ANSWER FIRST. A contact message about an existing booking or anything
//      else (surface 'contact_support') is queued for the team before the
//      route starts the person's marketing sequence.
//
//  OLD PAGES (no `marketingNotice`, no opt-out field) get today's semantics
//  exactly: this returns `none` without a single database call.
//
//  `__setCaptureBasisDeps` is a TEST-ONLY seam, in the same style as
//  quote-capture-deps.ts and contact-route-deps.ts.
// ════════════════════════════════════════════════════════════════════════
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prisma } from './db'
import { apiLogger } from './logger'
import { normalizeEmail } from './email-tokens'
import {
  resolveNotice,
  normalizeNoticeLocale,
  SURFACE_SEQUENCE_KINDS,
  leadBasisReplaceableBy,
  type NoticeSurface,
  type SequenceKind,
} from './consent/notice-registry'
import {
  consentClientIp,
  consentIpHmac,
  deriveRegionSignal,
  evaluateGrantSafeguards,
  hashUserAgent,
  type GrantDecision,
  type GrantSafeguardInput,
} from './consent/grant-safeguards'
import {
  isPlausibleEmail,
  recordConsentEvent,
  type ConsentEventInput,
  type RecordConsentEventResult,
} from './consent/consent-events'
import type { EnrollmentRef } from './consent/sequence-enrollment'
import type { EnrolmentOutcome, NoticeSubmissionInput } from './journeys'

const log = apiLogger.child({ mod: 'capture-basis' })

// ── THE PAYLOAD CONTRACT (DESIGN-v2 §4) ─────────────────────────────────────
//  Every field is optional AND lenient: a malformed value is dropped (`catch`),
//  never a 422. A customer's lead must not be lost over a marketing field.

const NoticeClaimSchema = z.object({
  version: z.string().trim().max(64),
  trigger: z.string().trim().max(20).optional(),
})

/** Spread into a route's Zod object so every capture route accepts the same fields. */
export const CAPTURE_CONTRACT_FIELDS = {
  marketingNotice: NoticeClaimSchema.optional().catch(undefined),
  emailMarketingOptOut: z.boolean().optional().catch(undefined),
  emailUserTyped: z.boolean().optional().catch(undefined),
  turnstileToken: z.string().max(2048).optional().catch(undefined),
}

/** The contract on its own — for a route whose main schema lives elsewhere (bookings). */
export const CaptureContractSchema = z.object(CAPTURE_CONTRACT_FIELDS)
export type CaptureContract = z.infer<typeof CaptureContractSchema>

/** Parse the contract out of any request body. Never throws; junk → {}. */
export function parseCaptureContract(body: unknown): CaptureContract {
  const parsed = CaptureContractSchema.safeParse(body)
  return parsed.success ? parsed.data : {}
}

/**
 * The legacy checkbox value a route may still forward to the consent columns.
 * A ticked opt-out box and an old-page `true` in the same payload contradict
 * each other; the opt-out wins, so the `true` is dropped (never turned into a
 * decline either — the opt-out event is the record of what happened).
 */
export function legacyConsentGivenOptOut(marketingConsent: boolean | undefined, contract: CaptureContract): boolean | undefined {
  if (contract.emailMarketingOptOut === true && marketingConsent === true) return undefined
  return marketingConsent
}

/**
 * Was the legacy opt-in CHECKBOX on the page? An old page says so itself
 * (`marketingConsentPresented`). A notice-era page — it sends the notice or the
 * opt-out box state — has no checkbox at all: false, so the owner's lead card
 * reads "Not opted in" instead of "Unknown — captured before we recorded
 * whether the box was shown". Nothing else reads this column.
 */
export function legacyCheckboxPresented(presented: boolean | undefined, contract: CaptureContract): boolean | undefined {
  if (typeof presented === 'boolean') return presented
  if (contract.marketingNotice || typeof contract.emailMarketingOptOut === 'boolean') return false
  return undefined
}

// ── REQUEST CONTEXT ─────────────────────────────────────────────────────────

export type CaptureClient = {
  /** For throttling only; stored as a keyed HMAC, never raw. */
  ip: string | null
  userAgent: string | null
  /** Stored as origin + path only (see sanitizePageUrl). */
  pageUrl: string | null
}

/** The client facts of a browser request. */
export function captureClient(req: { headers: { get(name: string): string | null } }): CaptureClient {
  return {
    ip: consentClientIp(req.headers),
    userAgent: req.headers.get('user-agent'),
    pageUrl: req.headers.get('referer'),
  }
}

// ── DEPENDENCIES ────────────────────────────────────────────────────────────

export type CaptureBasisDeps = {
  evaluate: (input: GrantSafeguardInput) => Promise<GrantDecision>
  record: (input: ConsentEventInput) => Promise<RecordConsentEventResult>
  /**
   * Point Lead.basisEventId at this notice, unless the lead's CURRENT basis
   * permits a lead sequence this surface does not (leadBasisReplaceableBy).
   * Resolves true when the lead now points at `eventId`. May throw; the caller
   * contains it.
   */
  storeLeadBasis: (leadId: string, eventId: string, opts: { surface: NoticeSurface }) => Promise<boolean>
  /** Write Booking.basisEventId. May throw; the caller contains it. */
  storeBookingBasis: (bookingId: string, eventId: string) => Promise<void>
  /** journeys.onNoticeSubmission. */
  startScenario: (input: NoticeSubmissionInput) => Promise<EnrolmentOutcome>
  /** journeys.onPersonOptedOut — cancels the person's queued jobs. */
  personOptedOut: (email: string, stopped: EnrollmentRef[]) => Promise<unknown>
  /** True when a consent event with this exact request id exists (tracker replay). */
  submissionSeen: (requestId: string) => Promise<boolean>
  now: () => Date
}

const PRODUCTION: CaptureBasisDeps = {
  evaluate: (input) => evaluateGrantSafeguards(input),
  record: (input) => recordConsentEvent(input),
  async storeLeadBasis(leadId, eventId, opts) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { basisEventId: true } })
    if (!lead) throw new Error('lead not found')
    if (lead.basisEventId === eventId) return true
    if (lead.basisEventId) {
      const current = await prisma.emailConsentEvent.findUnique({ where: { id: lead.basisEventId }, select: { surface: true } })
      if (current && !leadBasisReplaceableBy(current.surface, opts.surface)) return false
    }
    //  Compare-and-set on the value just read: a concurrent form on the same
    //  lead that wrote first is re-read and the rule applied to ITS notice.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = attempt === 0 ? lead.basisEventId : (await prisma.lead.findUnique({ where: { id: leadId }, select: { basisEventId: true } }))?.basisEventId ?? null
      if (current === eventId) return true
      if (attempt > 0 && current) {
        const ev = await prisma.emailConsentEvent.findUnique({ where: { id: current }, select: { surface: true } })
        if (ev && !leadBasisReplaceableBy(ev.surface, opts.surface)) return false
      }
      const res = await prisma.lead.updateMany({ where: { id: leadId, basisEventId: current }, data: { basisEventId: eventId } })
      if (res.count === 1) return true
    }
    return false
  },
  async storeBookingBasis(bookingId, eventId) {
    await prisma.booking.update({ where: { id: bookingId }, data: { basisEventId: eventId }, select: { id: true } })
  },
  //  Imported lazily: journeys pulls in the queues, and a capture route's
  //  offline tests must never open a Redis connection.
  async startScenario(input) {
    const { onNoticeSubmission } = await import('./journeys')
    return onNoticeSubmission(input)
  },
  async personOptedOut(email, stopped) {
    const { onPersonOptedOut } = await import('./journeys')
    return onPersonOptedOut(email, { stopped, reason: 'opted_out_at_capture' })
  },
  async submissionSeen(requestId) {
    const rows = await prisma.emailConsentEvent.findMany({ where: { requestId }, select: { id: true }, take: 1 })
    return rows.length > 0
  },
  now: () => new Date(),
}

let current: CaptureBasisDeps = PRODUCTION

/** What the routes use. Production unless a test has replaced it. */
export function captureBasisDeps(): CaptureBasisDeps {
  return current
}

/** TEST ONLY. Returns a restore function; always call it in a `finally`. */
export function __setCaptureBasisDeps(next: Partial<CaptureBasisDeps>): () => void {
  const previous = current
  current = { ...current, ...next }
  return () => {
    current = previous
  }
}

// ── REQUEST IDS ─────────────────────────────────────────────────────────────

/**
 * The consent event request id for one submission.
 *
 * `<surface>:<trigger>:<key>:<sha256(email)[0..16]>`. With a stable `key` (the
 * booking session id, the tracker's own lead id) a double click, a retried
 * request or a replayed forward records ONCE — UNIQUE (request_id, kind) —
 * and returns the original event. Without one each request is its own. The
 * address is part of the id, so a corrected address is a new submission and
 * never collides with the old one. No PII: the key is opaque, the email hashed.
 */
export function captureRequestId(surface: string, trigger: string, key: string | null | undefined, email: string): string {
  const cleanKey = String(key ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || randomUUID()
  const hash = createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 16)
  return `${surface}:${trigger}:${cleanKey}:${hash}`
}

// ── THE DECISION ────────────────────────────────────────────────────────────

/** How long a forwarded submission may take to arrive before its notice is refused. */
export const MAX_SUBMISSION_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type CaptureBasisInput = {
  /** DERIVED BY THE ROUTE. */
  surface: NoticeSurface
  /**
   * The sequence this submission starts, decided by the route. Null records
   * the notice and starts nothing (no current route passes null).
   */
  scenario: SequenceKind | null
  email: string | null | undefined
  leadId?: string | null
  bookingId?: string | null
  customerId?: string | null
  contract: CaptureContract
  /** The ONE trigger this route accepts a notice from. */
  acceptTrigger: 'submit' | 'continue'
  /** Booking-form Continue: the address must have been typed on this page load. */
  requireEmailUserTyped?: boolean
  /** The locale the page rendered. Missing or unsupported = no notice. */
  locale?: string | null
  honeypot?: string | null
  region?: { phone?: string | null; postalCodes?: Array<string | null | undefined>; country?: string | null }
  client: CaptureClient
  /** Stable key for idempotency (session id, tracker lead id). */
  submissionKey?: string | null
  /** When the visitor actually submitted, if a forwarder says so (tracker). */
  submittedAt?: Date | null
  /** Record `basis_withheld: no_notice` when the submission carries no notice (tracker forwards). */
  recordAbsentNotice?: boolean
}

export type CaptureBasisOutcome =
  | { status: 'none'; reason: 'no_email' | 'no_notice' | 'trigger_not_accepted' }
  | { status: 'opted_out'; eventId: string | null; stopped: number }
  | { status: 'withheld'; reason: string; eventId: string | null }
  | { status: 'granted'; eventId: string; created: boolean; stored: boolean; scenario: SequenceKind | null }
  | { status: 'error'; reason: string }

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200)

/**
 * Record what this submission says about marketing email. NEVER throws.
 *
 * Call AFTER the lead or booking is saved (the event names it) and BEFORE any
 * sequence is started, so the stored basis is what the journeys read.
 */
export async function applyCaptureBasis(
  input: CaptureBasisInput,
  deps: CaptureBasisDeps = captureBasisDeps(),
): Promise<CaptureBasisOutcome> {
  try {
    const email = normalizeEmail(input.email ?? '')
    if (!email || !isPlausibleEmail(email)) return { status: 'none', reason: 'no_email' }

    const contract = input.contract ?? {}
    const notice = contract.marketingNotice
    const now = deps.now()
    //  The trigger the PAGE claims. A notice without one is not accepted: the
    //  booking form must say 'continue', and nothing may default into it.
    const claimedTrigger = notice?.trigger ?? null
    const trigger = claimedTrigger ?? input.acceptTrigger
    const locale = normalizeNoticeLocale(input.locale)
    const userAgentHash = hashUserAgent(input.client.userAgent)
    const common = {
      email,
      surface: input.surface,
      leadId: input.leadId ?? null,
      bookingId: input.bookingId ?? null,
      customerId: input.customerId ?? null,
      locale,
      trigger: claimedTrigger,
      emailUserTyped: typeof contract.emailUserTyped === 'boolean' ? contract.emailUserTyped : null,
      pageUrl: input.client.pageUrl,
      uaHash: userAgentHash,
      occurredAt: now,
    }
    const requestIdFor = (t: string) => captureRequestId(input.surface, t, input.submissionKey, email)

    // ── 1. THE OPT-OUT BOX ────────────────────────────────────────────────
    if (contract.emailMarketingOptOut === true) {
      const shown = notice ? resolveNotice({ version: notice.version, surface: input.surface, locale: input.locale, now }) : null
      const res = await deps.record({
        ...common,
        kind: 'opted_out_at_capture',
        requestId: requestIdFor(trigger),
        optOutBox: true,
        noticeVersion: shown?.ok ? shown.version : null,
        noticeCopySha256: shown?.ok ? shown.copySha256 : null,
        ipHmac: consentIpHmac(input.client.ip),
      })
      //  Cancel queued jobs whatever the event write did: if it failed, the
      //  journeys' own stop still marks enrollments stopped, and the send-time
      //  gate is the enforcement either way.
      const stopped = res.ok ? res.stoppedEnrollments : []
      try {
        await deps.personOptedOut(email, stopped)
      } catch (err) {
        log.warn({ surface: input.surface, err: errText(err) }, 'opt-out: queued jobs not cancelled (the send-time gate still refuses)')
      }
      if (!res.ok) {
        log.error({ surface: input.surface, reason: res.reason, detail: res.detail }, 'capture opt-out NOT recorded')
        return { status: 'error', reason: res.reason }
      }
      return { status: 'opted_out', eventId: res.event.id, stopped: stopped.length }
    }

    // ── 2. NO NOTICE: today's behaviour, untouched ────────────────────────
    const withhold = async (
      reason: string,
      extra: { turnstileOk?: boolean | null; ipHmac?: string | null; noticeCopySha256?: string | null } = {},
    ): Promise<CaptureBasisOutcome> => {
      const res = await deps.record({
        ...common,
        kind: 'basis_withheld',
        requestId: requestIdFor(trigger),
        withheldReason: reason,
        //  The CLAIMED version is kept as evidence, even when it is forged.
        noticeVersion: notice?.version ?? null,
        noticeCopySha256: extra.noticeCopySha256 ?? null,
        optOutBox: contract.emailMarketingOptOut === false ? false : null,
        turnstileOk: extra.turnstileOk ?? null,
        ipHmac: extra.ipHmac ?? consentIpHmac(input.client.ip),
      })
      if (!res.ok) log.warn({ surface: input.surface, reason, recordFailure: res.reason }, 'basis_withheld event not recorded')
      log.info({ surface: input.surface, reason }, 'marketing basis withheld — the lead is saved as normal')
      return { status: 'withheld', reason, eventId: res.ok ? res.event.id : null }
    }

    if (!notice) {
      if (input.recordAbsentNotice) return await withhold('no_notice')
      return { status: 'none', reason: 'no_notice' }
    }
    if (claimedTrigger !== input.acceptTrigger) {
      //  A debounce, blur, toggle or beacon ping. Not a submission, so not even
      //  worth an event: ignored as though the field were absent.
      return { status: 'none', reason: 'trigger_not_accepted' }
    }

    // ── 3. A FORWARDED SUBMISSION MUST BE RECENT ──────────────────────────
    const submittedAt = input.submittedAt && !Number.isNaN(input.submittedAt.getTime()) ? input.submittedAt : null
    if (submittedAt) {
      const age = now.getTime() - submittedAt.getTime()
      if (age > MAX_SUBMISSION_AGE_MS || age < -5 * 60 * 1000) return await withhold('stale_submission')
    }

    // ── 4. THE REGISTRY: exact version, surface, locale, and live on the day ─
    const resolved = resolveNotice({
      version: notice.version,
      surface: input.surface,
      locale: input.locale,
      now: submittedAt ?? now,
    })
    if (!resolved.ok || resolved.basis !== 'notice') return await withhold('unknown_notice_version')

    // ── 5. A NOTICE ONLY EVER PERMITS THIS SUBMISSION'S OWN SEQUENCE ──────
    //  No sequence (null): the notice is still recorded, and nothing starts.
    //  A named sequence must be one this surface may start.
    const scenarioOk = input.scenario === null || SURFACE_SEQUENCE_KINDS[input.surface].includes(input.scenario)
    if (!scenarioOk) {
      return await withhold('no_scenario', { noticeCopySha256: resolved.copySha256 })
    }

    // ── 6. SAFEGUARDS: flag, honeypot, identities, Turnstile, throttles ───
    const decision = await deps.evaluate({
      grant: 'notice',
      surface: input.surface,
      email,
      sequenceKind: input.scenario,
      ip: input.client.ip,
      turnstileToken: contract.turnstileToken ?? null,
      honeypot: input.honeypot ?? null,
      emailUserTyped: contract.emailUserTyped ?? null,
      requireEmailUserTyped: input.requireEmailUserTyped === true,
      now,
    })
    if (!decision.grant) {
      return await withhold(decision.reason, {
        turnstileOk: decision.turnstileOk,
        ipHmac: decision.ipHmac,
        noticeCopySha256: resolved.copySha256,
      })
    }

    // ── 7. THE GRANT, then the subject points at it ───────────────────────
    const res = await deps.record({
      ...common,
      kind: 'notice_accepted',
      requestId: requestIdFor(trigger),
      noticeVersion: resolved.version,
      noticeCopySha256: resolved.copySha256,
      locale: resolved.locale,
      regionSignal: deriveRegionSignal(input.region ?? {}),
      optOutBox: false,
      turnstileOk: decision.turnstileOk,
      ipHmac: decision.ipHmac,
    })
    if (!res.ok) {
      log.error({ surface: input.surface, reason: res.reason, detail: res.detail }, 'notice event NOT recorded — no basis granted')
      return { status: 'error', reason: res.reason }
    }

    let stored = false
    try {
      if (input.leadId) {
        //  Forms merge into the person's newest open lead. A newer notice that
        //  permits fewer lead sequences (a contact message on a quote lead)
        //  leaves the lead's basis alone — replacing it would end the running
        //  quote follow-ups at send time — and starts nothing of its own: the
        //  lead already runs the more specific sequence. The event itself is
        //  recorded either way, and the person's latest notice (for campaigns)
        //  lives on the status row.
        stored = (await deps.storeLeadBasis(input.leadId, res.event.id, { surface: input.surface })) !== false
      } else if (input.bookingId) {
        await deps.storeBookingBasis(input.bookingId, res.event.id)
        stored = true
      }
    } catch (err) {
      log.error({ surface: input.surface, err: errText(err) }, 'notice recorded but the subject basis was NOT stored — no sequence will start')
    }
    return { status: 'granted', eventId: res.event.id, created: res.created, stored, scenario: input.scenario }
  } catch (err) {
    log.error({ surface: input.surface, err: errText(err) }, 'applyCaptureBasis failed (non-fatal) — no basis granted')
    return { status: 'error', reason: 'exception' }
  }
}

/**
 * Start the scenario sequence a GRANTED, STORED notice permits. Call after the
 * route's own transactional side effects. Returns null when there is nothing
 * to start. NEVER throws.
 */
export async function startCaptureScenario(
  outcome: CaptureBasisOutcome,
  subject: { surface: NoticeSurface; email: string | null | undefined; leadId?: string | null; bookingId?: string | null },
  deps: CaptureBasisDeps = captureBasisDeps(),
): Promise<EnrolmentOutcome | null> {
  //  Nothing to start: not granted, not stored, or a surface with no sequence.
  if (outcome.status !== 'granted' || !outcome.stored || outcome.scenario === null) return null
  try {
    const result = await deps.startScenario({
      surface: subject.surface,
      scenario: outcome.scenario,
      leadId: subject.leadId ?? null,
      bookingId: subject.bookingId ?? null,
      basisEventId: outcome.eventId,
      email: normalizeEmail(subject.email ?? ''),
    })
    log.info(
      { surface: subject.surface, scenario: outcome.scenario, scheduled: result.scheduled, reason: result.scheduled ? undefined : result.reason },
      'scenario sequence requested',
    )
    return result
  } catch (err) {
    log.warn({ surface: subject.surface, err: errText(err) }, 'scenario sequence not started (non-fatal)')
    return null
  }
}

/** A short, PII-free line for a route's own log. */
export function describeCaptureBasis(outcome: CaptureBasisOutcome): string {
  switch (outcome.status) {
    case 'granted':
      return `granted:${outcome.scenario ?? 'no_sequence'}${outcome.stored ? '' : ':not_stored'}`
    case 'withheld':
      return `withheld:${outcome.reason}`
    case 'none':
      return `none:${outcome.reason}`
    case 'opted_out':
      return 'opted_out'
    default:
      return `error:${outcome.reason}`
  }
}
