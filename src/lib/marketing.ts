// ============================================================
//  MARKETING AUTOMATION — external tool integration
//
//  STATUS: STUB. Wired into the booking flow but does nothing
//  until you provide your marketing tool's details.
//
//  It no-ops safely when not configured, so the rest of the flow
//  never breaks.
//
//  TO ACTIVATE — set these env vars (see .env.example):
//    MARKETING_API_KEY   — API key/token for your tool
//    MARKETING_LIST_ID   — audience/list/segment ID to enroll into
//  Then fill in the `TODO` block below with your tool's API call
//  (Mailchimp, HubSpot, Klaviyo, etc.).
// ============================================================

import { queueLogger } from './logger'
import { prisma } from './db'
import {
  promotionalEligibility,
  type EligibilityDb,
  type EligibilityDeps,
} from './consent/marketing-eligibility'

export type MarketingContact = {
  email: string
  name?: string
  phone?: string
  displayId?: string
  requestedDate?: string
}

export function isMarketingConfigured(): boolean {
  return Boolean(process.env.MARKETING_API_KEY && process.env.MARKETING_LIST_ID)
}

export type EnrollCustomerResult =
  | { status: 'not_configured' }
  | { status: 'refused'; reason: string }
  | { status: 'enrolled' }

// ════════════════════════════════════════════════════════════════════════
//  WHO MAY BE ADDED TO AN EXTERNAL MARKETING LIST (DESIGN-v2 §5, 2026-09-16)
//  ---------------------------------------------------------------------
//  fulfillment.ts enqueues this for EVERY paid deposit, and the example below
//  subscribes the address outright. Paying for a move is not consent to a
//  marketing list, so before any provider call:
//    • an internal test booking is refused (looked up by displayId);
//    • promotionalEligibility() must permit it in the 'automation' context —
//      EXPRESS consent only, never a notice or EBR basis — with the customer
//      as the subject. That also refuses a suppressed, unsubscribed, opted-out
//      or declined person and any test/staff/role identity.
//  Every refusal FAILS CLOSED, including a read error: an address that could
//  not be checked is not enrolled.
// ════════════════════════════════════════════════════════════════════════

type EnrollDb = EligibilityDb

/**
 * Enroll a paying customer into the marketing automation / audience.
 * Safe to call always — it skips cleanly when not configured, and refuses
 * anybody the shared gate does not permit.
 */
export async function enrollCustomer(
  contact: MarketingContact,
  deps: EligibilityDeps & { db?: EnrollDb } = {}
): Promise<EnrollCustomerResult> {
  if (!isMarketingConfigured()) {
    queueLogger.info(
      { email: contact.email },
      'Marketing not configured — skipping (set MARKETING_API_KEY + MARKETING_LIST_ID to activate)'
    )
    return { status: 'not_configured' }
  }

  const refusal = await enrollRefusal(contact, deps)
  if (refusal) {
    queueLogger.info({ displayId: contact.displayId, reason: refusal }, 'enrollCustomer(): refused by the marketing eligibility gate')
    return { status: 'refused', reason: refusal }
  }

  // ────────────────────────────────────────────────────────────
  // TODO: Replace this block with your marketing tool's API call.
  //
  // Example shape (Mailchimp-style) — adjust to your provider:
  //
  //   const res = await fetch(
  //     `https://<dc>.api.mailchimp.com/3.0/lists/${process.env.MARKETING_LIST_ID}/members`,
  //     {
  //       method: 'POST',
  //       headers: {
  //         Authorization: `Bearer ${process.env.MARKETING_API_KEY}`,
  //         'Content-Type': 'application/json',
  //       },
  //       body: JSON.stringify({
  //         email_address: contact.email,
  //         status: 'subscribed',
  //         merge_fields: { FNAME: contact.name, PHONE: contact.phone },
  //         tags: ['paid-booking'],
  //       }),
  //     }
  //   )
  //   if (!res.ok) throw new Error(`Marketing API ${res.status}: ${await res.text()}`)
  // ────────────────────────────────────────────────────────────

  queueLogger.warn(
    { email: contact.email },
    'enrollCustomer(): configured but no provider call implemented yet — fill in the TODO in src/lib/marketing.ts'
  )
  return { status: 'enrolled' }
}

/** Why this contact may not be enrolled, or null. Never throws; fails closed. */
export async function enrollRefusal(contact: MarketingContact, deps: EligibilityDeps & { db?: EnrollDb } = {}): Promise<string | null> {
  const db = (deps.db ?? prisma) as EnrollDb
  if (!contact.email || !contact.email.trim()) return 'no_email'
  try {
    if (contact.displayId) {
      const booking = await db.booking.findUnique({ where: { displayId: contact.displayId }, select: { isInternalTest: true } })
      if (booking?.isInternalTest) return 'internal_test_booking'
    }
    const customer = await db.customer.findMany({
      where: { email: { equals: contact.email.trim(), mode: 'insensitive' } },
      select: { id: true },
      take: 1,
    })
    const decision = await promotionalEligibility(
      {
        context: 'automation',
        email: contact.email,
        subject: customer[0] ? { type: 'customer', id: customer[0].id } : { type: 'none' },
      },
      deps
    )
    return decision.eligible ? null : decision.reason
  } catch (err) {
    queueLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'enrollCustomer(): eligibility read failed — refusing')
    return 'eligibility_read_failed'
  }
}
