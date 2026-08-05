// ════════════════════════════════════════════════════════════════════════
//  quote-capture.ts — what happens the moment a quick-quote lead is saved.
//
//  Owner spec 2026-08-03. Two side effects, both fail-soft, both deduped:
//    1. ONE transactional confirmation email to the customer.
//    2. ONE internal Discord card so the lead can be called quickly.
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
import { isInPersonRequest } from './lead-alert'

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
 * make. Delivery is decided later by the worker + guardedSend + Resend, and is
 * tracked on EmailSend. Nothing here may say "sent".
 */
export type QueueStatus = 'queued' | 'already_queued' | 'unavailable'

export type QuoteCaptureOutcome = {
  emailStatus: QueueStatus
  emailReason?: string
  notificationStatus: QueueStatus
  notificationReason?: string
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

/** The lead columns both side effects need. One read, two decisions. */
const CAPTURE_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  estimatedValue: true,
  moveDate: true,
  moveSize: true,
  zip: true,
  pickupZip: true,
  destinationZip: true,
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

type CaptureLead = {
  id: string
  name: string
  email: string | null
  phone: string | null
  estimatedValue: number | null
  moveDate: Date | null
  moveSize: string | null
  zip: string | null
  pickupZip: string | null
  destinationZip: string | null
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
  opts: { force?: boolean; locale?: string } = {}
): Promise<{ status: QueueStatus; reason?: string }> {
  if (!lead.email) return { status: 'unavailable', reason: 'no_email' }

  const claimedAt = new Date()
  const nextCount = lead.quoteConfirmationCount + 1

  let claim
  try {
    claim = await prisma.lead.updateMany({
      where: opts.force ? { id: lead.id } : { id: lead.id, quoteConfirmationQueuedAt: null },
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
  } catch (err) {
    log.error({ leadId: lead.id, err: errText(err) }, 'confirmation claim failed (non-fatal)')
    return { status: 'unavailable', reason: 'claim_failed' }
  }
  if (claim.count === 0) return { status: 'already_queued', reason: 'already_queued' }

  // Read the MODE off the lead, not off the request that triggered this send.
  // An owner resend months later must still produce the in-person wording.
  const inPerson = isInPersonRequest(lead.formStep)
  const estimatedPrice = inPerson ? null : formatEstimate(lead.estimatedValue)

  try {
    await emailQueue.add('quote-request-received', {
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
    const released = await prisma.lead
      .updateMany({
        where: { id: lead.id, quoteConfirmationQueuedAt: claimedAt, quoteConfirmationCount: nextCount },
        data: {
          quoteConfirmationQueuedAt: lead.quoteConfirmationQueuedAt,
          quoteConfirmationCount: lead.quoteConfirmationCount,
          quoteConfirmationStatus: lead.quoteConfirmationQueuedAt ? 'queued' : null,
        },
      })
      .catch(() => ({ count: 0 }))
    log.error(
      { leadId: lead.id, released: released.count === 1, err: errText(err) },
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
async function queueInternalAlert(lead: CaptureLead): Promise<{ status: QueueStatus; reason?: string }> {
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

  const claimedAt = new Date()
  // Atomic claim: match only rows whose stored fingerprint is still the old
  // one. `not:` alone would skip NULL rows (SQL three-valued logic), so the
  // null case is spelled out — that is the very first alert for a lead.
  let claim
  try {
    claim = await prisma.lead.updateMany({
      where: {
        id: lead.id,
        OR: [{ alertFingerprint: null }, { alertFingerprint: { not: fingerprint } }],
      },
      data: { alertFingerprint: fingerprint, lastAlertedAt: claimedAt, alertStatus: 'queued' },
    })
  } catch (err) {
    log.error({ leadId: lead.id, err: errText(err) }, 'alert claim failed (non-fatal)')
    return { status: 'unavailable', reason: 'claim_failed' }
  }
  if (claim.count === 0) return { status: 'already_queued', reason: 'already_alerted' }

  const payload: LeadCardData = {
    leadId: lead.id,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    estimateDollars: typeof lead.estimatedValue === 'number' ? lead.estimatedValue / 100 : null,
    moveDate: lead.moveDate,
    moveSize: packageLabelOf(lead.moveSize),
    pickup: routeLabel(lead.originCity, lead.pickupZip ?? lead.zip),
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
    await discordQueue.add('lead-created', {
      type: 'lead-created',
      payload: payload as unknown as Record<string, unknown>,
    })
    log.info({ leadId: lead.id, isUpdate }, 'lead alert queued')
    return { status: 'queued' }
  } catch (err) {
    // Release BOTH fields together, and only if the row still holds exactly
    // what we wrote. Restoring the fingerprint while leaving lastAlertedAt set
    // (the previous behaviour) left the row claiming a card that never existed.
    const released = await prisma.lead
      .updateMany({
        where: { id: lead.id, alertFingerprint: fingerprint, lastAlertedAt: claimedAt },
        data: {
          alertFingerprint: lead.alertFingerprint,
          lastAlertedAt: lead.lastAlertedAt,
          alertStatus: lead.alertFingerprint ? 'queued' : null,
        },
      })
      .catch(() => ({ count: 0 }))
    log.error(
      { leadId: lead.id, released: released.count === 1, err: errText(err) },
      'lead alert enqueue failed (non-fatal)'
    )
    return { status: 'unavailable', reason: 'enqueue_failed' }
  }
}

// ════════════════════════════════════════════════════════════════════════
//  3. DELIVERY STATE — written by the WORKERS, not by the API
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
//  4. THE ENTRY POINT
// ════════════════════════════════════════════════════════════════════════

/**
 * Fire both side effects for a freshly captured quote request. NEVER throws.
 *
 * The email is skipped when there is no estimate to report — the owner asked
 * for the confirmation "after the lead reaches the contact-information step
 * AND an estimate has been generated". The internal alert has no such
 * condition: a lead with no estimate is still a person waiting for a call, and
 * that is precisely the one an owner most needs to see.
 */
export async function onQuoteRequestCaptured(
  leadId: string,
  opts: { locale?: string; sendEmail?: boolean } = {}
): Promise<QuoteCaptureOutcome> {
  const fallback: QuoteCaptureOutcome = { emailStatus: 'unavailable', notificationStatus: 'unavailable' }
  try {
    const lead = (await prisma.lead.findUnique({ where: { id: leadId }, select: CAPTURE_SELECT })) as CaptureLead | null
    if (!lead) return { ...fallback, emailReason: 'lead_not_found', notificationReason: 'lead_not_found' }

    let email: { status: QueueStatus; reason?: string }
    if (opts.sendEmail === false) {
      email = { status: 'unavailable', reason: 'suppressed_by_caller' }
    } else {
      email = await queueConfirmationEmail(lead, { locale: opts.locale })
    }

    const alert = await queueInternalAlert(lead)

    return {
      emailStatus: email.status,
      emailReason: email.reason,
      notificationStatus: alert.status,
      notificationReason: alert.reason,
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
  opts: { locale?: string } = {}
): Promise<{ ok: boolean; reason?: string; version?: number }> {
  try {
    const lead = (await prisma.lead.findUnique({ where: { id: leadId }, select: CAPTURE_SELECT })) as CaptureLead | null
    if (!lead) return { ok: false, reason: 'lead_not_found' }
    if (!lead.email) return { ok: false, reason: 'lead_has_no_email' }
    const res = await queueConfirmationEmail(lead, { force: true, locale: opts.locale })
    return res.status === 'queued'
      ? { ok: true, version: lead.quoteConfirmationCount + 1 }
      : { ok: false, reason: res.reason }
  } catch (err) {
    log.error({ leadId, err: errText(err) }, 'resendQuoteConfirmation failed')
    return { ok: false, reason: 'error' }
  }
}
