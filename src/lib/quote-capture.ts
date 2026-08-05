// ════════════════════════════════════════════════════════════════════════
//  quote-capture.ts — what happens the moment a quick-quote lead is saved.
//
//  Owner spec 2026-08-03. THREE side effects, all fail-soft, all deduped:
//    1. ONE transactional confirmation email to the customer.
//    2. ONE internal Discord card so the lead can be called quickly.
//    3. ONE promotional automation enrollment — ONLY with explicit consent.
//
//  (3) is new. It is listed last because it runs last and matters least: it is
//  the only one the customer did not ask for, and the only one that is skipped
//  outright for most leads. Consent lives in its own gate (section 3) and never
//  touches (1) — asking for an estimate earns you the estimate.
//
//  THE HARD RULE THIS FILE EXISTS TO KEEP: neither side effect may delay,
//  block, or fail the customer's estimate. Every function returns an outcome
//  and never throws — the route shows the price regardless of what Resend or
//  Redis are doing. That is the owner's requirement 8 ("If the confirmation
//  email fails, still show the customer's estimate") expressed as a type.
//
//  IDEMPOTENCY IS TWO-LAYERED, ON PURPOSE:
//    • The DB claim below (`quoteRequestConfirmationSentAt IS NULL`) is what
//      stops a second ENQUEUE. It is an atomic conditional updateMany, so two
//      concurrent submits from the same page produce exactly one job.
//    • guardedSend's EmailSend.idempotencyKey is what stops a second SEND
//      even if a job is somehow duplicated (a BullMQ retry, a manual replay).
//  Either alone is a race; together they are exactly-once.
//
//  This module owns the QUEUE side effects, so — unlike leads.ts, which stays
//  import-free of queues so its tests never open Redis — it is imported only
//  from the route, and the route wraps it.
// ════════════════════════════════════════════════════════════════════════
import { prisma } from './db'
import { apiLogger } from './logger'
import { emailQueue, discordQueue } from './queues'
import { alertFingerprint, shouldRealert } from './leads'
import { businessPhone } from './business-contact'
import { MOVE_SIZES } from './estimate'
import type { LeadCardData } from './booking-display'
import { isInPersonRequest, notifyNewLead } from './lead-alert'
import { fireLeadTrigger, type LeadTriggerResult } from './email-automation-runtime'

const log = apiLogger.child({ mod: 'quote-capture' })

/** Message only — never a stack trace or a provider payload. */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Business phone for the confirmation email. Resolved through the single
 *  source in ./business-contact so an env change reaches every surface. */
const BUSINESS_PHONE_DISPLAY = businessPhone().display

/**
 * Internal package key -> the label a customer should read. A confirmation
 * email that says "Size: 2br" leaks our vocabulary; MOVE_SIZES already holds
 * the human name, so there is no second table to drift.
 * Returns null for the booking-form sentinel and for anything unrecognised.
 */
function packageLabelOf(moveSize?: string | null): string | null {
  const key = (moveSize ?? '').trim()
  if (!key) return null
  return MOVE_SIZES[key]?.label ?? null
}

/**
 * What actually happened to each side effect.
 *
 *   queued          the job is IN the queue (BullMQ confirmed the insert)
 *   already_queued  a previous request already queued it; nothing re-sent
 *   unavailable     we could not queue it (Redis down, no address, error)
 *
 * NOTE THE VOCABULARY: 'queued' is the strongest claim this layer can honestly
 * make about the EMAIL. Delivery is decided later by the worker + guardedSend +
 * Resend, and is tracked on EmailSend. Nothing here may say "sent".
 *
 * For the owner NOTIFICATION, 'queued' means "the owner will be told" — either
 * a BullMQ job exists, or (when the queue refused it) the direct Discord notice
 * was accepted. The distinction is in the `reason`, because what the caller
 * needs to know is whether anyone is going to hear about this lead.
 */
export type QueueStatus = 'queued' | 'already_queued' | 'unavailable'

export type QuoteCaptureOutcome = {
  emailStatus: QueueStatus
  emailReason?: string
  notificationStatus: QueueStatus
  notificationReason?: string
  /**
   * What the PROMOTIONAL trigger did. INTERNAL — logged by the route, never
   * returned to the browser. Whether we enrolled someone in marketing is not
   * the browser's business, and a visitor must never be able to probe our
   * consent state by reading a response body.
   */
  automation?: LeadTriggerResult
}

/**
 * THE public response contract for POST /api/leads.
 *
 * A discriminated union so the browser cannot accidentally treat "saved but the
 * email queue was down" as "a copy is on the way". `leadId?: never` documents
 * that no internal identifier is ever returned.
 */
export type QuoteLeadCaptureResponse =
  | {
      ok: true
      captured: true
      emailStatus: QueueStatus
      notificationStatus: QueueStatus
      /** The SERVER's price, so a stale browser can correct itself. */
      estimate: {
        totalDollars: number
        baseDollars: number
        isStarting: boolean
        packageLabel: string
        truckSize: string
        truckMinimum: string
        truckUpgrade: number
        truckCorrected: boolean
      } | null
      /** True when this move is quoted by a human rather than automatically:
       *  5+ bedrooms, or the customer asked for an in-person visit. The lead
       *  is captured either way; it simply carries no number. */
      manualReview?: boolean
      leadId?: never
    }
  | { ok: true; captured: false; reason: 'spam_discarded' | 'feature_disabled' }
  | {
      ok: false
      captured: false
      error: 'validation_error' | 'rate_limited' | 'server_error'
      /** Our own field NAMES only — never submitted values. */
      fields?: string[]
    }

/**
 * The lead columns the side effects need. One read, three decisions.
 *
 * EVERY KEY HERE MUST BE A REAL FIELD ON `model Lead`. Prisma rejects an
 * unknown `select` key at RUNTIME, not at compile time — `CAPTURE_SELECT` is a
 * named `as const`, so TypeScript's excess-property check never sees it at the
 * call site. This file shipped with `pickupZip: true` (the column is
 * `originZip`), which made `prisma.lead.findUnique` throw on every quick-quote
 * submission. The throw was caught by onQuoteRequestCaptured's own catch and
 * reported as `emailStatus: 'unavailable'` — so the endpoint captured leads and
 * silently queued NOTHING: no confirmation email, no owner card, no
 * `quoteConfirmationQueuedAt`, for every lead, forever. See quote-lead-flow
 * tests, which assert this shape against the generated Prisma types.
 */
const CAPTURE_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  estimatedValue: true,
  moveDate: true,
  moveSize: true,
  zip: true,
  originZip: true,
  destinationZip: true,
  emailMarketingConsent: true,
  originCity: true,
  destCity: true,
  contactPreference: true,
  bestTimeToCall: true,
  formStep: true,
  source: true,
  referrer: true,
  landingPage: true,
  utmSource: true,
  utmCampaign: true,
  quoteConfirmationQueuedAt: true,
  quoteConfirmationCount: true,
  quoteConfirmationStatus: true,
  alertFingerprint: true,
  lastAlertedAt: true,
} as const

export type CaptureLead = {
  id: string
  name: string
  email: string | null
  phone: string | null
  estimatedValue: number | null
  moveDate: Date | null
  moveSize: string | null
  zip: string | null
  originZip: string | null
  destinationZip: string | null
  /** TRI-STATE. Gates the PROMOTIONAL trigger only — never the confirmation. */
  emailMarketingConsent: boolean | null
  originCity: string | null
  destCity: string | null
  contactPreference: string | null
  bestTimeToCall: string | null
  formStep: string | null
  source: string | null
  referrer: string | null
  landingPage: string | null
  utmSource: string | null
  utmCampaign: string | null
  quoteConfirmationQueuedAt: Date | null
  quoteConfirmationCount: number
  quoteConfirmationStatus: string | null
  alertFingerprint: string | null
  lastAlertedAt: Date | null
}

/** First word of the stored name. The quick quote now always collects a first
 *  name, but a legacy or partial lead may only carry "Website lead" — never
 *  render an empty greeting. */
export function firstNameOf(name?: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
  if (!first || /^(website|booking)$/i.test(first)) return 'there'
  return first
}

/** Cents → the display string the email prints, e.g. "$1,049". Returns
 *  undefined when there is no real estimate, which is what makes the template
 *  DROP the estimate paragraph instead of printing an empty value. */
export function formatEstimate(cents?: number | null): string | undefined {
  if (typeof cents !== 'number' || cents <= 0) return undefined
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`
}

function adminLeadUrl(): string | null {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '')
  return base ? `${base}/admin/leads` : null
}

/** Human route line for the alert card. */
function routeLabel(city?: string | null, zip?: string | null): string | null {
  const parts = [city, zip].map((p) => (p ?? '').trim()).filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

// ════════════════════════════════════════════════════════════════════════
//  0. THE INJECTABLE EDGE
//  ---------------------------------------------------------------------
//  Every effect that leaves this process — the four conditional lead writes,
//  the two queue inserts, the direct Discord post, the automation trigger —
//  goes through QuoteCaptureDeps. Production wiring is `defaultQuoteCaptureDeps`
//  below and is a literal transcription of the prisma/BullMQ calls this file
//  has always made; nothing about the ORDER, the compare-and-set predicates or
//  the failure handling changed.
//
//  It exists because none of this had a single test. The one bug that mattered
//  (see CAPTURE_SELECT) was invisible precisely because the whole chain could
//  only be exercised against a live database and a live Redis. leads.ts already
//  solves this with LeadStore/LeadDeps; this is the same pattern, same reasons.
// ════════════════════════════════════════════════════════════════════════

/** The queued confirmation-email job, exactly as the email worker reads it. */
export type ConfirmationEmailJob = {
  template: 'quote-request-received'
  to: string
  leadId: string
  businessEventKey: string
  payload: Record<string, unknown>
}

export interface QuoteCaptureDeps {
  loadLead(leadId: string): Promise<CaptureLead | null>
  /** Conditional claim of the confirmation send. Returns rows MATCHED (0 or 1). */
  claimConfirmation(input: { leadId: string; force: boolean; claimedAt: Date; nextCount: number }): Promise<number>
  /** Compare-and-set rollback — must only undo a claim THIS request wrote. */
  releaseConfirmation(input: {
    leadId: string
    claimedAt: Date
    nextCount: number
    previousQueuedAt: Date | null
    previousCount: number
  }): Promise<number>
  claimAlert(input: { leadId: string; fingerprint: string; claimedAt: Date }): Promise<number>
  releaseAlert(input: {
    leadId: string
    fingerprint: string
    claimedAt: Date
    previousFingerprint: string | null
    previousAlertedAt: Date | null
  }): Promise<number>
  enqueueConfirmationEmail(job: ConfirmationEmailJob): Promise<void>
  enqueueLeadCard(payload: LeadCardData): Promise<void>
  /** Direct Discord REST post. The fallback for a dead queue — see queueInternalAlert. */
  postLeadNoticeDirect(lead: CaptureLead): Promise<boolean>
  /** Promotional enrollment. Consent is enforced INSIDE fireLeadTrigger. */
  fireLeadCreated(leadId: string, snapshot: Record<string, unknown>): Promise<LeadTriggerResult>
  now(): Date
}

let _deps: QuoteCaptureDeps | undefined
export function defaultQuoteCaptureDeps(): QuoteCaptureDeps {
  if (_deps) return _deps
  _deps = {
    now: () => new Date(),
    async loadLead(leadId) {
      return (await prisma.lead.findUnique({ where: { id: leadId }, select: CAPTURE_SELECT })) as CaptureLead | null
    },
    async claimConfirmation({ leadId, force, claimedAt, nextCount }) {
      const res = await prisma.lead.updateMany({
        where: force ? { id: leadId } : { id: leadId, quoteConfirmationQueuedAt: null },
        data: {
          quoteConfirmationQueuedAt: claimedAt,
          quoteConfirmationCount: nextCount,
          quoteConfirmationStatus: 'queued',
          // A retry clears the previous terminal failure — otherwise the admin
          // would keep reading a stale error beside a fresh attempt.
          quoteConfirmationFailedAt: null,
          quoteConfirmationLastError: null,
        },
      })
      return res.count
    },
    async releaseConfirmation({ leadId, claimedAt, nextCount, previousQueuedAt, previousCount }) {
      const res = await prisma.lead
        .updateMany({
          where: { id: leadId, quoteConfirmationQueuedAt: claimedAt, quoteConfirmationCount: nextCount },
          data: {
            quoteConfirmationQueuedAt: previousQueuedAt,
            quoteConfirmationCount: previousCount,
            quoteConfirmationStatus: previousQueuedAt ? 'queued' : null,
          },
        })
        .catch(() => ({ count: 0 }))
      return res.count
    },
    async claimAlert({ leadId, fingerprint, claimedAt }) {
      const res = await prisma.lead.updateMany({
        // `not:` alone would skip NULL rows (SQL three-valued logic), so the
        // null case is spelled out — that is the very first alert for a lead.
        where: { id: leadId, OR: [{ alertFingerprint: null }, { alertFingerprint: { not: fingerprint } }] },
        data: { alertFingerprint: fingerprint, lastAlertedAt: claimedAt, alertStatus: 'queued' },
      })
      return res.count
    },
    async releaseAlert({ leadId, fingerprint, claimedAt, previousFingerprint, previousAlertedAt }) {
      const res = await prisma.lead
        .updateMany({
          where: { id: leadId, alertFingerprint: fingerprint, lastAlertedAt: claimedAt },
          data: {
            alertFingerprint: previousFingerprint,
            lastAlertedAt: previousAlertedAt,
            alertStatus: previousFingerprint ? 'queued' : null,
          },
        })
        .catch(() => ({ count: 0 }))
      return res.count
    },
    async enqueueConfirmationEmail(job) {
      await emailQueue.add('quote-request-received', job)
    },
    async enqueueLeadCard(payload) {
      await discordQueue.add('lead-created', {
        type: 'lead-created',
        payload: payload as unknown as Record<string, unknown>,
      })
    },
    async postLeadNoticeDirect(lead) {
      const res = await notifyNewLead({
        id: lead.id,
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        source: lead.source,
        moveSize: lead.moveSize,
        moveDate: lead.moveDate,
        originZip: lead.originZip ?? lead.zip,
        destinationZip: lead.destinationZip,
        estimatedValue: lead.estimatedValue,
        emailMarketingConsent: lead.emailMarketingConsent,
        landingPage: lead.landingPage,
        utmSource: lead.utmSource,
        utmCampaign: lead.utmCampaign,
        formStep: lead.formStep,
      })
      return res.delivered
    },
    async fireLeadCreated(leadId, snapshot) {
      return fireLeadTrigger('lead_created', leadId, { snapshot })
    },
  }
  return _deps
}

// ════════════════════════════════════════════════════════════════════════
//  1. THE CONFIRMATION EMAIL
// ════════════════════════════════════════════════════════════════════════

/**
 * Enqueue the "We received your moving estimate request" email exactly once.
 *
 * THE CLAIM IS COMPARE-AND-SET, NOT A BLIND WRITE.
 *
 *   1. claim   conditional updateMany -> only ONE concurrent request wins
 *   2. enqueue BullMQ
 *   3. on failure, release the claim ONLY IF the row still holds the exact
 *      values this request wrote
 *
 * Step 3 is the important one. The previous version rolled back with an
 * unconditional `updateMany({ where: { id } })`, so a slow failing request
 * could erase a newer successful claim made by a second request in between —
 * turning a queued email into "never requested" and allowing a duplicate.
 * Matching on the exact claimed timestamp AND count makes that impossible:
 * if anything changed underneath us, we leave it alone.
 *
 * `force` is the owner's manual resend: it skips the already-queued guard and
 * bumps the count, which becomes guardedSend's `version` so the resend is a
 * genuinely new idempotency key rather than a refused duplicate.
 */
async function queueConfirmationEmail(
  lead: CaptureLead,
  opts: { force?: boolean; locale?: string } = {},
  deps: QuoteCaptureDeps = defaultQuoteCaptureDeps()
): Promise<{ status: QueueStatus; reason?: string }> {
  // NOTE: consent is deliberately NOT consulted here. This is the reply to a
  // request the customer just made — transactional by classification
  // (email-guard's TRANSACTIONAL_TEMPLATES) and by common sense. Someone who
  // asked for an estimate gets their estimate whether or not they ticked a
  // marketing box.
  if (!lead.email) return { status: 'unavailable', reason: 'no_email' }

  const claimedAt = deps.now()
  const nextCount = lead.quoteConfirmationCount + 1

  let claimed: number
  try {
    claimed = await deps.claimConfirmation({ leadId: lead.id, force: !!opts.force, claimedAt, nextCount })
  } catch (err) {
    log.error({ leadId: lead.id, err: errText(err) }, 'confirmation claim failed (non-fatal)')
    return { status: 'unavailable', reason: 'claim_failed' }
  }
  if (claimed === 0) return { status: 'already_queued', reason: 'already_queued' }

  // Read the MODE off the lead, not off the request that triggered this send.
  // An owner resend months later must still produce the in-person wording.
  const inPerson = isInPersonRequest(lead.formStep)
  const estimatedPrice = inPerson ? null : formatEstimate(lead.estimatedValue)

  try {
    await deps.enqueueConfirmationEmail({
      template: 'quote-request-received',
      to: lead.email,
      leadId: lead.id,
      // Stable business event: the lead plus the send version. A BullMQ retry
      // reuses it (so guardedSend dedupes); an owner resend bumps the version
      // (so guardedSend lets it through).
      businessEventKey: `lead:${lead.id}:quote-request-received:v${nextCount}`,
      payload: {
        firstName: firstNameOf(lead.name),
        // ABSENT, not empty — the template drops the whole paragraph when the
        // key is missing (owner rule: never display an empty value).
        ...(estimatedPrice ? { estimatedPrice } : {}),
        ...(inPerson ? { inPerson: true } : {}),
        ...(lead.moveDate ? { moveDate: lead.moveDate.toISOString() } : {}),
        ...(packageLabelOf(lead.moveSize) ? { moveSize: packageLabelOf(lead.moveSize) } : {}),
        businessPhone: BUSINESS_PHONE_DISPLAY,
        locale: opts.locale || 'en',
      },
    })
    log.info({ leadId: lead.id, version: nextCount }, 'quote confirmation email queued')
    return { status: 'queued' }
  } catch (err) {
    // ── COMPARE-AND-SET RELEASE ──────────────────────────────────────────
    // Only undo what WE wrote. If another request has since claimed the row
    // (different timestamp or count), `count` is 0 and we touch nothing.
    const released = await deps.releaseConfirmation({
      leadId: lead.id,
      claimedAt,
      nextCount,
      previousQueuedAt: lead.quoteConfirmationQueuedAt,
      previousCount: lead.quoteConfirmationCount,
    })
    log.error(
      { leadId: lead.id, released: released === 1, err: errText(err) },
      'quote confirmation enqueue failed (non-fatal)'
    )
    return { status: 'unavailable', reason: 'enqueue_failed' }
  }
}

// ════════════════════════════════════════════════════════════════════════
//  2. THE INTERNAL ALERT
// ════════════════════════════════════════════════════════════════════════

/**
 * Post the owner card, but only when this lead is new to the owner OR has
 * changed in a way that changes how they should call it (move date, estimate,
 * contact preference, or a phone number appearing for the first time).
 *
 * Same compare-and-set discipline as the email. The previous version released
 * ONLY `alertFingerprint` and left `lastAlertedAt` pointing at a card that was
 * never queued — an internally contradictory row.
 */
async function queueInternalAlert(
  lead: CaptureLead,
  deps: QuoteCaptureDeps = defaultQuoteCaptureDeps()
): Promise<{ status: QueueStatus; reason?: string }> {
  const fingerprint = alertFingerprint({
    moveDate: lead.moveDate,
    estimatedValue: lead.estimatedValue,
    contactPreference: lead.contactPreference,
    phone: lead.phone,
  })
  const isUpdate = !!lead.alertFingerprint
  if (!shouldRealert(lead.alertFingerprint, fingerprint)) {
    return { status: 'already_queued', reason: 'no_meaningful_change' }
  }

  const claimedAt = deps.now()
  // Atomic claim: match only rows whose stored fingerprint is still the old one.
  let claimed: number
  try {
    claimed = await deps.claimAlert({ leadId: lead.id, fingerprint, claimedAt })
  } catch (err) {
    log.error({ leadId: lead.id, err: errText(err) }, 'alert claim failed (non-fatal)')
    return { status: 'unavailable', reason: 'claim_failed' }
  }
  if (claimed === 0) return { status: 'already_queued', reason: 'already_alerted' }

  const payload: LeadCardData = {
    leadId: lead.id,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    estimateDollars: typeof lead.estimatedValue === 'number' ? lead.estimatedValue / 100 : null,
    moveDate: lead.moveDate,
    moveSize: packageLabelOf(lead.moveSize),
    pickup: routeLabel(lead.originCity, lead.originZip ?? lead.zip),
    destination: routeLabel(lead.destCity, lead.destinationZip),
    contactPreference: lead.contactPreference,
    bestTimeToCall: lead.bestTimeToCall,
    formStep: lead.formStep,
    source: lead.source,
    referrer: lead.referrer,
    landingPage: lead.landingPage,
    utmSource: lead.utmSource,
    utmCampaign: lead.utmCampaign,
    adminUrl: adminLeadUrl(),
    isUpdate,
  }

  try {
    await deps.enqueueLeadCard(payload)
    log.info({ leadId: lead.id, isUpdate }, 'lead alert queued')
    return { status: 'queued' }
  } catch (err) {
    // Release BOTH fields together, and only if the row still holds exactly
    // what we wrote. Restoring the fingerprint while leaving lastAlertedAt set
    // (the previous behaviour) left the row claiming a card that never existed.
    const released = await deps.releaseAlert({
      leadId: lead.id,
      fingerprint,
      claimedAt,
      previousFingerprint: lead.alertFingerprint,
      previousAlertedAt: lead.lastAlertedAt,
    })

    // ── QUEUE DOWN ⇒ POST IT DIRECTLY ────────────────────────────────────
    // The rich card needs Redis; the owner needs the lead. When BullMQ cannot
    // take the job we fall back to the plain REST notice — the same one
    // capturePartialLeadSafe sends for every other capture surface. This is why
    // the quote route asks capture NOT to notify: exactly one card per lead,
    // and still one when the queue is dead. (A Redis outage is not theoretical
    // here — it is the shape of the outage this whole flow already survives.)
    const fallback = await deps.postLeadNoticeDirect(lead).catch(() => false)
    log.error(
      { leadId: lead.id, released: released === 1, fallbackDelivered: fallback, err: errText(err) },
      'lead alert enqueue failed — direct notice attempted'
    )
    return {
      status: fallback ? 'queued' : 'unavailable',
      reason: fallback ? 'direct_fallback' : 'enqueue_failed',
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
//  3. THE MARKETING TRIGGER  (promotional — consent required)
//  ---------------------------------------------------------------------
//  The quick quote is the one capture surface that ASKS for marketing consent
//  and gets an explicit answer, and until now that answer went nowhere: the
//  lead was flagged `email_marketing_consent = true` and no automation could
//  ever see it, because the partial-capture path is silent by design (it also
//  serves the booking form, where a half-typed Step-1 email is not a request
//  for anything).
//
//  So the trigger fires HERE — in the quote-specific side-effect module — and
//  the partial path stays exactly as silent as it was.
//
//  FOUR PROPERTIES, in the order they matter:
//    1. CONSENT. Enforced inside fireLeadTrigger (mayEnrollLeadSubject), not
//       here, so every lead trigger in the system inherits it. A lead with
//       consent null/false is never enrolled — and never reaches suppression
//       lookup or automation query either.
//    2. IDEMPOTENT. The enrollment's `dedupeKey`
//       (automation + version + leadId) is UNIQUE; a re-fired trigger hits
//       P2002 and is swallowed. The quote page fires capture on every
//       meaningful edit, so this WILL fire repeatedly for one lead — by design,
//       because consent may be given on a later edit than the one that created
//       the lead. Repeats cost one indexed insert attempt and change nothing.
//    3. NON-FATAL. It cannot throw (fireLeadTrigger swallows), and its result
//       is reported, never acted on. A dead automation table must not cost a
//       customer their confirmation email.
//    4. SEPARATE FROM TRANSACTIONAL. It runs AFTER the confirmation email is
//       queued, and its outcome never touches `emailStatus`.
// ════════════════════════════════════════════════════════════════════════

/**
 * PURE: the facts that qualified this lead, recorded on the enrollment.
 *
 * Automations read the lead LIVE at every stage, so this is not the source of
 * truth for anything — it is the answer to "why was this person enrolled, and
 * what did we know at the time?", plus the fields a future automation would
 * segment on before it has any reason to load the row.
 */
export function quoteLeadTriggerSnapshot(lead: CaptureLead): Record<string, unknown> {
  return {
    leadId: lead.id,
    email: lead.email,
    firstName: firstNameOf(lead.name),
    source: lead.source,
    capturedVia: 'quick_quote_form',
    formStep: lead.formStep,
    // Cents is how the column stores it; dollars is what a human segment rule
    // ("worth more than $1,000") will be written against. Both, spelled out.
    estimatedValueCents: lead.estimatedValue,
    estimatedValueDollars: typeof lead.estimatedValue === 'number' ? lead.estimatedValue / 100 : null,
    moveDate: lead.moveDate ? lead.moveDate.toISOString() : null,
    moveSize: lead.moveSize,
    moveSizeLabel: packageLabelOf(lead.moveSize),
    pickupZip: lead.originZip ?? lead.zip,
    pickupCity: lead.originCity,
    destinationZip: lead.destinationZip,
    destinationCity: lead.destCity,
    contactPreference: lead.contactPreference,
    // The consent state AT ENROLLMENT. A later withdrawal is honoured live by
    // suppression + the audience layer; this records what we relied on.
    marketingConsent: lead.emailMarketingConsent === true,
  }
}

/**
 * Fire the `lead_created` promotional trigger for a captured quote lead.
 * NEVER throws. Returns what happened so the route can log it honestly.
 */
async function fireMarketingTrigger(
  lead: CaptureLead,
  deps: QuoteCaptureDeps = defaultQuoteCaptureDeps()
): Promise<LeadTriggerResult> {
  try {
    return await deps.fireLeadCreated(lead.id, quoteLeadTriggerSnapshot(lead))
  } catch (err) {
    log.warn({ leadId: lead.id, err: errText(err) }, 'lead_created trigger failed (non-fatal)')
    return { status: 'unavailable', reason: 'error' }
  }
}

// ════════════════════════════════════════════════════════════════════════
//  4. DELIVERY STATE — written by the WORKERS, not by the API
// ════════════════════════════════════════════════════════════════════════

/** Truncate to a short, safe category. Never a stack trace, never a provider
 *  payload, never anything that could carry customer data. */
export function safeErrorLabel(value: unknown, max = 120): string {
  const s = typeof value === 'string' ? value : value instanceof Error ? value.name + ': ' + value.message : String(value)
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * Record the OUTCOME of a queued quote confirmation. Called by the email
 * worker once the provider has actually answered — this is the only place
 * 'delivered' is ever written.
 */
export async function recordQuoteConfirmationOutcome(
  leadId: string,
  outcome: { delivered: boolean; error?: unknown }
): Promise<void> {
  try {
    await prisma.lead.updateMany({
      where: { id: leadId },
      data: outcome.delivered
        ? {
            quoteConfirmationStatus: 'delivered',
            quoteConfirmationDeliveredAt: new Date(),
            quoteConfirmationFailedAt: null,
            quoteConfirmationLastError: null,
          }
        : {
            quoteConfirmationStatus: 'failed',
            quoteConfirmationFailedAt: new Date(),
            quoteConfirmationLastError: safeErrorLabel(outcome.error ?? 'unknown'),
          },
    })
  } catch (err) {
    // Never fail a send because we could not annotate the lead.
    log.warn({ leadId, err: errText(err) }, 'could not record confirmation outcome (non-fatal)')
  }
}

/** Discord twin of the above. */
export async function recordLeadAlertOutcome(leadId: string, delivered: boolean): Promise<void> {
  try {
    await prisma.lead.updateMany({
      where: { id: leadId },
      data: delivered
        ? { alertStatus: 'delivered', alertDeliveredAt: new Date() }
        : { alertStatus: 'failed' },
    })
  } catch (err) {
    log.warn({ leadId, err: errText(err) }, 'could not record alert outcome (non-fatal)')
  }
}

// ════════════════════════════════════════════════════════════════════════
//  5. THE ENTRY POINT
// ════════════════════════════════════════════════════════════════════════

/**
 * Fire the side effects for a freshly captured quote request. NEVER throws.
 *
 * ORDER IS THE CONTRACT: the customer's transactional email first, then the
 * owner's card, then the promotional trigger. Each is independent, each fails
 * soft, and a failure of a LATER one can never undo an earlier one.
 */
export async function onQuoteRequestCaptured(
  leadId: string,
  opts: { locale?: string; sendEmail?: boolean } = {},
  deps: QuoteCaptureDeps = defaultQuoteCaptureDeps()
): Promise<QuoteCaptureOutcome> {
  const fallback: QuoteCaptureOutcome = { emailStatus: 'unavailable', notificationStatus: 'unavailable' }
  try {
    const lead = await deps.loadLead(leadId)
    if (!lead) return { ...fallback, emailReason: 'lead_not_found', notificationReason: 'lead_not_found' }

    let email: { status: QueueStatus; reason?: string }
    if (opts.sendEmail === false) {
      email = { status: 'unavailable', reason: 'suppressed_by_caller' }
    } else {
      email = await queueConfirmationEmail(lead, { locale: opts.locale }, deps)
    }

    const alert = await queueInternalAlert(lead, deps)

    // LAST, and deliberately so. Marketing is the only one of the three the
    // customer did not ask for, and the only one that may be skipped outright.
    const automation = await fireMarketingTrigger(lead, deps)

    return {
      emailStatus: email.status,
      emailReason: email.reason,
      notificationStatus: alert.status,
      notificationReason: alert.reason,
      automation,
    }
  } catch (err) {
    log.error({ leadId, err: errText(err) }, 'onQuoteRequestCaptured failed (non-fatal)')
    return { ...fallback, emailReason: 'error', notificationReason: 'error' }
  }
}

/**
 * Owner-triggered manual resend (admin only — the route enforces that).
 * Deliberately separate from the automatic path so a resend is always an
 * explicit human act with its own audit entry.
 */
export async function resendQuoteConfirmation(
  leadId: string,
  opts: { locale?: string } = {},
  deps: QuoteCaptureDeps = defaultQuoteCaptureDeps()
): Promise<{ ok: boolean; reason?: string; version?: number }> {
  try {
    const lead = await deps.loadLead(leadId)
    if (!lead) return { ok: false, reason: 'lead_not_found' }
    if (!lead.email) return { ok: false, reason: 'lead_has_no_email' }
    const res = await queueConfirmationEmail(lead, { force: true, locale: opts.locale }, deps)
    return res.status === 'queued'
      ? { ok: true, version: lead.quoteConfirmationCount + 1 }
      : { ok: false, reason: res.reason }
  } catch (err) {
    log.error({ leadId, err: errText(err) }, 'resendQuoteConfirmation failed')
    return { ok: false, reason: 'error' }
  }
}
