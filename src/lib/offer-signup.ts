// ════════════════════════════════════════════════════════════════════════
//  offer-signup.ts — the 10%-off popup (owner direction 2026-09-16)
//  ---------------------------------------------------------------------
//  THE PROBLEM WITH THE OLD POPUP. It posted `{email}` to the legacy
//  Leadtracking service, which emailed the code and then a weekly drip from its
//  own list, with its own unsubscribes, where the API's suppression list and
//  send gate never saw any of it.
//
//  THE FLOW NOW (POST /api/leads/offer-signup) — the popup is an ordinary form:
//    1. The code is shown ON SCREEN straight away (next to the popup's own
//       terms copy), in a response
//       that is IDENTICAL whatever the address is — new, known, suppressed,
//       throttled, a test identity — so the endpoint cannot be used to learn
//       anything about an address.
//    2. A bot (the honeypot) or an unusable address: nothing is saved.
//    3. THE LEAD IS SAVED FIRST, with the popup's attribution.
//    4. The popup notice is recorded exactly like every other form's
//       (applyCaptureBasis): the registered version, locale and time, every
//       grant safeguard, and a `notice_accepted` event. NEVER an opt-in — the
//       owner's direction is no separate opt-in or confirmation step, and a
//       form submission is never labelled an explicit opt-in.
//    5. THE GENERAL LEAD NURTURE STARTS on that notice (owner direction
//       2026-09-16: every genuine submission enters the most relevant existing
//       sequence). The code itself is shown on screen, never emailed; the
//       sequence runs behind the same consent, suppression and sending gates
//       as every other form. Scheduling is bounded (START_SCENARIO_WAIT_MS) so
//       a slow queue never holds up the code the visitor is waiting for.
//
//  There is no confirmation email and no confirmation page.
//  Nothing here throws, and nothing here writes a Lead/Customer consent column.
//  `__setOfferSignupDeps` is a TEST-ONLY seam.
// ════════════════════════════════════════════════════════════════════════
import { apiLogger } from './logger'
import { normalizeEmail } from './email-tokens'
import { ingestLeadSafe } from './leads'
import { isPlausibleEmail } from './consent/consent-events'
import {
  applyCaptureBasis,
  describeCaptureBasis,
  startCaptureScenario,
  type CaptureBasisInput,
  type CaptureBasisOutcome,
  type CaptureClient,
} from './capture-basis'
import type { EnrolmentOutcome } from './journeys'
import { PROMO_CODES } from './discount-rules'

const log = apiLogger.child({ mod: 'offer-signup' })

/** Route-derived consent surface for the popup (never from the request). */
export const OFFER_SURFACE = 'popup' as const
/** The lead source the popup records; maps to LeadSource OTHER. */
export const OFFER_LEAD_SOURCE = 'popup-offer'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200)

// ── THE RESPONSE ────────────────────────────────────────────────────────────

export type OfferSignupResponse = {
  ok: true
  code: string
}

/**
 * THE ONE BODY every accepted signup gets. Built from nothing about the
 * request, so it cannot differ between a new, known, suppressed or throttled
 * address. The code comes from the coupon book; the popup shows its own,
 * existing terms copy next to it.
 */
export function offerSignupResponseBody(): OfferSignupResponse {
  return { ok: true, code: PROMO_CODES.MOVE10.code }
}

// ── SIGNUP ──────────────────────────────────────────────────────────────────

export type OfferSignupAttribution = {
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  referrer?: string | null
  landingPage?: string | null
}

export type OfferSignupInput = {
  email: string
  locale?: string | null
  /** The hidden `company` field. */
  honeypot?: string | null
  turnstileToken?: string | null
  marketingNotice?: { version: string; trigger?: string } | null
  emailUserTyped?: boolean | null
  attribution?: OfferSignupAttribution
  client: CaptureClient
}

/** How long the popup response waits for the nurture to be scheduled. */
export const START_SCENARIO_WAIT_MS = 3000

export type OfferSignupDeps = {
  /** Save (or merge into) the lead. Null when it could not be saved. */
  captureLead: (email: string, attribution: OfferSignupAttribution) => Promise<string | null>
  /** capture-basis applyCaptureBasis — records the notice (never throws). */
  applyBasis: (input: CaptureBasisInput) => Promise<CaptureBasisOutcome>
  /** capture-basis startCaptureScenario — starts the lead nurture (never throws). */
  startScenario: (outcome: CaptureBasisOutcome, subject: { surface: typeof OFFER_SURFACE; email: string; leadId: string }) => Promise<EnrolmentOutcome | null>
}

export type OfferSignupOutcome =
  | { status: 'discarded'; reason: 'honeypot' | 'invalid_email' }
  | { status: 'saved'; leadId: string; basis: string; scheduled: boolean | null }
  | { status: 'error'; reason: string }

const clean = (v: string | null | undefined, max: number): string | null => {
  const t = typeof v === 'string' ? v.trim() : ''
  return t ? t.slice(0, max) : null
}

const PRODUCTION_SIGNUP: OfferSignupDeps = {
  async captureLead(email, a) {
    //  No consent fields: a lead is a CRM record. What the person was shown and
    //  when lives in the notice event, never in a checkbox column.
    const res = await ingestLeadSafe(
      {
        email,
        source: OFFER_LEAD_SOURCE,
        message: 'Asked for the 10% code in the website popup.',
        utmSource: clean(a.utmSource, 80),
        utmMedium: clean(a.utmMedium, 80),
        utmCampaign: clean(a.utmCampaign, 120),
        utmContent: clean(a.utmContent, 120),
        utmTerm: clean(a.utmTerm, 120),
        referrer: clean(a.referrer, 500),
        landingPage: clean(a.landingPage, 500),
      },
      'offer-signup',
    )
    return res ? res.lead.id : null
  },
  applyBasis: (input) => applyCaptureBasis(input),
  startScenario: (outcome, subject) => startCaptureScenario(outcome, subject),
}

let currentSignup: OfferSignupDeps = PRODUCTION_SIGNUP

export function offerSignupDeps(): OfferSignupDeps {
  return currentSignup
}

/** TEST ONLY. Returns a restore function; always call it in a `finally`. */
export function __setOfferSignupDeps(next: Partial<OfferSignupDeps>): () => void {
  const previous = currentSignup
  currentSignup = { ...currentSignup, ...next }
  return () => {
    currentSignup = previous
  }
}

/**
 * Handle one popup submission. NEVER throws, and its result never reaches the
 * visitor (the route always answers offerSignupResponseBody()).
 */
export async function processOfferSignup(input: OfferSignupInput, deps: OfferSignupDeps = offerSignupDeps()): Promise<OfferSignupOutcome> {
  try {
    //  A bot: nothing written, nothing sent, nothing throttled on its behalf.
    if (typeof input.honeypot === 'string' && input.honeypot.trim() !== '') return { status: 'discarded', reason: 'honeypot' }
    const email = normalizeEmail(input.email)
    if (!isPlausibleEmail(email)) return { status: 'discarded', reason: 'invalid_email' }

    //  1. THE LEAD FIRST — the record the notice and the sequence point at.
    let leadId: string | null
    try {
      leadId = await deps.captureLead(email, input.attribution ?? {})
    } catch (err) {
      log.error({ err: errText(err) }, 'popup lead save threw — nothing recorded')
      return { status: 'error', reason: 'lead_not_saved' }
    }
    if (!leadId) return { status: 'error', reason: 'lead_not_saved' }

    //  2. THE NOTICE — the same rules as every other form.
    const basis = await deps.applyBasis({
      surface: OFFER_SURFACE,
      scenario: 'lead_nurture',
      email,
      leadId,
      contract: {
        marketingNotice: input.marketingNotice ?? undefined,
        emailUserTyped: typeof input.emailUserTyped === 'boolean' ? input.emailUserTyped : undefined,
        turnstileToken: input.turnstileToken ?? undefined,
      },
      acceptTrigger: 'submit',
      locale: input.locale ?? null,
      honeypot: input.honeypot ?? null,
      client: input.client,
    })

    //  3. The lead nurture. Bounded: if the queue is slow the visitor still gets
    //     the code, and the scheduling carries on in the background (the API is
    //     a long-lived process, and scheduling is idempotent and never throws).
    const scheduling = deps.startScenario(basis, { surface: OFFER_SURFACE, email, leadId })
    const started = await Promise.race([
      scheduling,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), START_SCENARIO_WAIT_MS).unref?.()),
    ])
    return { status: 'saved', leadId, basis: describeCaptureBasis(basis), scheduled: started ? started.scheduled : null }
  } catch (err) {
    log.error({ err: errText(err) }, 'processOfferSignup failed (non-fatal)')
    return { status: 'error', reason: 'exception' }
  }
}
