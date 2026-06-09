// ============================================================
//  MARKETING AUTOMATION — external tool integration
//
//  STATUS: STUB. Wired into the booking flow but does nothing
//  until you provide your marketing tool's details.
//
//  Pattern mirrors the SMS integration (src/workers/sms.worker.ts):
//  it no-ops safely when not configured, so the rest of the flow
//  never breaks.
//
//  TO ACTIVATE — set these env vars (see .env.example):
//    MARKETING_API_KEY   — API key/token for your tool
//    MARKETING_LIST_ID   — audience/list/segment ID to enroll into
//  Then fill in the `TODO` block below with your tool's API call
//  (Mailchimp, HubSpot, Klaviyo, etc.).
// ============================================================

import { queueLogger } from './logger'

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

/**
 * Enroll a paying customer into the marketing automation / audience.
 * Safe to call always — it skips cleanly when not configured.
 */
export async function enrollCustomer(contact: MarketingContact): Promise<void> {
  if (!isMarketingConfigured()) {
    queueLogger.info(
      { email: contact.email },
      'Marketing not configured — skipping (set MARKETING_API_KEY + MARKETING_LIST_ID to activate)'
    )
    return
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
}
