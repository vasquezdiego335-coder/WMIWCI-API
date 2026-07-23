// ════════════════════════════════════════════════════════════════════════
//  RECIPIENT CONTEXT REGISTRY (owner spec 2026-07-22)
//  ---------------------------------------------------------------------
//  THE GAP THIS CLOSES: the only payload builders that existed for the
//  promotional templates were the admin test-send SYNTHETIC values
//  ("Test Customer", "TEST-0000"). A campaign executor that reused those
//  would mail real customers fake booking references. This module is the
//  LIVE counterpart: for every template a campaign may broadcast, it builds
//  the payload from the recipient's REAL rows — and refuses when it cannot.
//
//  RULES, enforced structurally:
//   • Only templates registered here are campaign-sendable. A transactional
//     template has no entry, so a campaign cannot broadcast a receipt.
//   • Each entry names the entity it REQUIRES (lead / booking / completed
//     booking / customer). A recipient without that entity fails CLOSED with
//     a machine-readable reason — never a made-up value.
//   • Each entry names the audience segments it accepts. A quote follow-up
//     pointed at "completed_customers" is refused at PREFLIGHT, before a
//     single recipient row exists.
//   • The built payload is checked against REQUIRED_FIELDS before queueing,
//     and guardedSend re-validates it again at send time.
//   • Nothing here invents quotes, discounts, payments or rewards. If the
//     data does not exist, the send does not happen.
//
//  Dependency-injected (ContextDeps) so every builder is offline-testable
//  with an in-memory store, exactly like leads.ts.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { REQUIRED_FIELDS } from '../emails/validation'
import type { Candidate } from './email-audience'
import type { SegmentKey } from './email-audience'

// ── Entity loaders (injectable) ─────────────────────────────────────────

export type LeadContextRow = {
  id: string
  name: string | null
  email: string | null
  status: string
  quotedAt: Date | null
  bookedAt: Date | null
  lostAt: Date | null
  moveDate: Date | null
  convertedBookingId: string | null
  jobType: string | null
}

export type BookingContextRow = {
  id: string
  status: string
  displayId: string
  customerToken: string
  requestedDate: Date | null
  isInternalTest: boolean
  completedAt: Date | null
  customer: { id: string; name: string; email: string; locale: string }
  review: { isPositive: boolean } | null
}

export type ContextDeps = {
  loadLead(id: string): Promise<LeadContextRow | null>
  loadBooking(id: string): Promise<BookingContextRow | null>
  env(name: string): string | undefined
}

let _deps: ContextDeps | undefined
export function defaultContextDeps(): ContextDeps {
  if (_deps) return _deps
  _deps = {
    loadLead: (id) =>
      prisma.lead.findUnique({
        where: { id },
        select: {
          id: true, name: true, email: true, status: true, quotedAt: true, bookedAt: true,
          lostAt: true, moveDate: true, convertedBookingId: true, jobType: true,
        },
      }),
    loadBooking: (id) =>
      prisma.booking.findUnique({
        where: { id },
        select: {
          id: true, status: true, displayId: true, customerToken: true, requestedDate: true,
          isInternalTest: true, completedAt: true,
          customer: { select: { id: true, name: true, email: true, locale: true } },
          review: { select: { isPositive: true } },
        },
      }),
    env: (name) => process.env[name],
  }
  return _deps
}

// ── Result type ─────────────────────────────────────────────────────────

export type ContextResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string }

const fail = (reason: string): ContextResult => ({ ok: false, reason })

// ── URL helpers (fail closed — a missing base URL is a refusal) ─────────

const trimSlash = (u: string): string => u.replace(/\/+$/, '')

function appUrl(deps: ContextDeps): string | null {
  const raw = deps.env('APP_URL')?.trim()
  return raw ? trimSlash(raw) : null
}

function marketingSiteUrl(deps: ContextDeps): string {
  return trimSlash(deps.env('MARKETING_SITE_URL')?.trim() || 'https://www.moveitclearit.com')
}

function bookingFormUrl(deps: ContextDeps, utmContent: string): string {
  return `${marketingSiteUrl(deps)}/booking-form.html?utm_source=email&utm_medium=campaign&utm_content=${encodeURIComponent(utmContent)}`
}

// ── Registry ────────────────────────────────────────────────────────────

export type ContextRequirement = 'lead' | 'booking' | 'completed_booking' | 'customer'

export type CampaignTemplateEntry = {
  template: string
  /** Which entity the payload is built FROM. */
  requires: ContextRequirement
  /** Audience segments whose candidates can honestly receive this template. */
  allowedSegments: readonly SegmentKey[]
  /** Build the LIVE payload for one candidate. Fails closed. */
  build(candidate: Candidate, deps: ContextDeps): Promise<ContextResult>
}

/** Shared quote-followup builder — stage varies, requirements do not. */
function quoteFollowupBuilder(stage: 1 | 2 | 3) {
  return async (candidate: Candidate, deps: ContextDeps): Promise<ContextResult> => {
    if (!candidate.leadId) return fail('context_missing:leadId')
    const lead = await deps.loadLead(candidate.leadId)
    if (!lead) return fail('context_missing:lead')
    if (!lead.email) return fail('context_missing:lead_email')
    // A quote follow-up asserts a quote EXISTS. No quotedAt, no email — the
    // same rule journeys.onQuoteCreated enforces, not a looser one for bulk.
    if (!lead.quotedAt) return fail('context_ineligible:no_quote')
    if (lead.bookedAt || lead.convertedBookingId) return fail('context_ineligible:lead_converted')
    if (lead.lostAt) return fail('context_ineligible:lead_lost')
    return {
      ok: true,
      payload: {
        customerName: lead.name ?? 'there',
        jobType: lead.jobType ?? undefined,
        moveDate: lead.moveDate?.toISOString(),
        bookingUrl: bookingFormUrl(deps, `quote-followup-stage-${stage}`),
        locale: 'en',
        journey: 'quote',
        stage,
      },
    }
  }
}

/** Shared abandoned-checkout builder — the booking must STILL be unpaid. */
function abandonedCheckoutBuilder(stage: 1 | 2 | 3) {
  return async (candidate: Candidate, deps: ContextDeps): Promise<ContextResult> => {
    if (!candidate.bookingId) return fail('context_missing:bookingId')
    const booking = await deps.loadBooking(candidate.bookingId)
    if (!booking) return fail('context_missing:booking')
    if (booking.isInternalTest) return fail('context_ineligible:internal_test')
    if (booking.status !== 'PENDING_PAYMENT') return fail(`context_ineligible:status_${booking.status}`)
    const base = appUrl(deps)
    // The continuation link must be REAL — an unusable "finish your booking"
    // button is worse than no email.
    if (!base) return fail('context_missing:APP_URL')
    return {
      ok: true,
      payload: {
        customerName: booking.customer.name,
        displayId: booking.displayId,
        requestedDate: booking.requestedDate?.toISOString(),
        checkoutUrl: `${base}/api/stripe/checkout?resume=${booking.id}`,
        portalUrl: `${base}/my-booking/${booking.customerToken}`,
        locale: booking.customer.locale,
        journey: 'abandoned',
        stage,
      },
    }
  }
}

/** Shared completed-move loader used by every post-move builder. */
async function loadCompletedBooking(candidate: Candidate, deps: ContextDeps): Promise<BookingContextRow | ContextResult> {
  if (!candidate.bookingId) return fail('context_missing:bookingId')
  const booking = await deps.loadBooking(candidate.bookingId)
  if (!booking) return fail('context_missing:booking')
  if (booking.isInternalTest) return fail('context_ineligible:internal_test')
  if (booking.status !== 'COMPLETED' && booking.status !== 'ARCHIVED') {
    return fail(`context_ineligible:status_${booking.status}`)
  }
  return booking
}

const CAMPAIGN_TEMPLATES: CampaignTemplateEntry[] = [
  {
    template: 'quote-followup-1',
    requires: 'lead',
    allowedSegments: ['quoted_leads_no_booking'],
    build: quoteFollowupBuilder(1),
  },
  {
    template: 'quote-followup-2',
    requires: 'lead',
    allowedSegments: ['quoted_leads_no_booking'],
    build: quoteFollowupBuilder(2),
  },
  {
    template: 'quote-followup-final',
    requires: 'lead',
    allowedSegments: ['quoted_leads_no_booking'],
    build: quoteFollowupBuilder(3),
  },
  {
    template: 'abandoned-checkout',
    requires: 'booking',
    allowedSegments: ['abandoned_booking'],
    build: abandonedCheckoutBuilder(1),
  },
  {
    template: 'abandoned-checkout-2',
    requires: 'booking',
    allowedSegments: ['abandoned_booking'],
    build: abandonedCheckoutBuilder(2),
  },
  {
    template: 'abandoned-checkout-3',
    requires: 'booking',
    allowedSegments: ['abandoned_booking'],
    build: abandonedCheckoutBuilder(3),
  },
  {
    template: 'review-request',
    requires: 'completed_booking',
    allowedSegments: ['review_eligible'],
    async build(candidate, deps) {
      const booking = await loadCompletedBooking(candidate, deps)
      if ('ok' in booking) return booking
      if (booking.review) return fail('context_ineligible:review_exists')
      // NO FALLBACK (finding EMAIL-P1-15): without a verified review
      // destination there is no honest review email.
      const reviewUrl = deps.env('GOOGLE_REVIEW_URL')?.trim()
      if (!reviewUrl) return fail('context_missing:GOOGLE_REVIEW_URL')
      const base = appUrl(deps)
      return {
        ok: true,
        payload: {
          customerName: booking.customer.name,
          googleReviewUrl: reviewUrl,
          ...(base ? { portalUrl: `${base}/my-booking/${booking.customerToken}` } : {}),
          locale: booking.customer.locale,
        },
      }
    },
  },
  {
    template: 'referral',
    requires: 'completed_booking',
    allowedSegments: ['referral_eligible'],
    async build(candidate, deps) {
      const booking = await loadCompletedBooking(candidate, deps)
      if ('ok' in booking) return booking
      // A referral ask requires the PROOF — a positive review. Same rule as
      // followups.ts, not a looser one for bulk sending.
      if (!booking.review?.isPositive) return fail('context_ineligible:no_positive_review')
      const referralUrl = deps.env('REFERRAL_URL')?.trim() || `${marketingSiteUrl(deps)}/referral`
      const referralCode = deps.env('REFERRAL_CODE')?.trim() || 'MOVE15'
      return {
        ok: true,
        payload: {
          customerName: booking.customer.name,
          referralUrl,
          referralCode,
          locale: booking.customer.locale,
        },
      }
    },
  },
  {
    // Re-engagement / win-back. Rendered from the QuoteFollowup shell exactly
    // as followups.ts does ("Moving again?"), so it carries the compliant
    // MarketingFooter. Claims NOTHING about the recipient beyond a past move —
    // which is what the allowed segments prove.
    template: 'repeat-reminder',
    requires: 'completed_booking',
    allowedSegments: ['completed_customers', 'repeat_customers', 'first_time_customers', 'reengagement_eligible'],
    async build(candidate, deps) {
      const booking = await loadCompletedBooking(candidate, deps)
      if ('ok' in booking) return booking
      return {
        ok: true,
        payload: {
          customerName: booking.customer.name,
          bookingUrl: bookingFormUrl(deps, 'repeat-reminder'),
          stage: 3,
          locale: booking.customer.locale,
        },
      }
    },
  },
]

const BY_TEMPLATE = new Map(CAMPAIGN_TEMPLATES.map((e) => [e.template, e]))

// ── Public API ──────────────────────────────────────────────────────────

export function campaignTemplateEntry(template: string): CampaignTemplateEntry | undefined {
  return BY_TEMPLATE.get(template)
}

export function campaignSafeTemplates(): string[] {
  return CAMPAIGN_TEMPLATES.map((e) => e.template)
}

export function isCampaignSafeTemplate(template: string): boolean {
  return BY_TEMPLATE.has(template)
}

/**
 * PREFLIGHT check: may this template be pointed at this audience segment at
 * all? Refusing here — before a single recipient row exists — is what stops
 * "quote follow-up to completed customers" from ever reaching per-recipient
 * processing.
 */
export function templateAllowsSegment(template: string, segment: SegmentKey): { ok: true } | { ok: false; error: string } {
  const entry = BY_TEMPLATE.get(template)
  if (!entry) {
    return {
      ok: false,
      error: `"${template}" has no live recipient-context builder, so it cannot be broadcast. Campaign-safe templates: ${campaignSafeTemplates().join(', ')}.`,
    }
  }
  if (!entry.allowedSegments.includes(segment)) {
    return {
      ok: false,
      error: `${template} cannot honestly be sent to the "${segment}" segment. Allowed segments: ${entry.allowedSegments.join(', ')}.`,
    }
  }
  return { ok: true }
}

/**
 * Build the LIVE payload for one candidate, then verify it satisfies the
 * template's declared required fields. Every refusal carries a
 * machine-readable reason for the recipient row.
 */
export async function buildRecipientContext(
  template: string,
  candidate: Candidate,
  deps: ContextDeps = defaultContextDeps()
): Promise<ContextResult> {
  const entry = BY_TEMPLATE.get(template)
  if (!entry) return fail('context_invalid:not_campaign_safe')

  let result: ContextResult
  try {
    result = await entry.build(candidate, deps)
  } catch (err) {
    return fail(`context_error:${err instanceof Error ? err.message : String(err)}`.slice(0, 200))
  }
  if (!result.ok) return result

  // Schema validation: the declared required fields must ALL be present. The
  // guard re-runs assertEmailPayload at send time; this earlier check turns a
  // builder bug into a named refusal instead of a queued dud.
  const required = (REQUIRED_FIELDS as Record<string, readonly string[]>)[template] ?? []
  const missing = required.filter((f) => {
    const v = result.ok ? result.payload[f] : undefined
    return v === undefined || v === null || v === ''
  })
  if (missing.length > 0) return fail(`context_missing:${missing.join(',')}`)

  return result
}
