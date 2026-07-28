// ════════════════════════════════════════════════════════════════════════
//  UNIFIED LEAD CAPTURE — POST /api/leads (owner spec 2026-07-28)
//  ---------------------------------------------------------------------
//  ONE public path for every capture surface: the homepage estimate, the quick
//  quote form, the services page, the contact form, the moving-checklist lead
//  magnet, QR landing pages and manual admin entry.
//
//  IT IS A THIN ALIAS OVER /api/leads/partial ON PURPOSE. That handler already
//  carries everything a public write endpoint needs and has been in production:
//  CORS, rate limiting, a honeypot, tri-state consent, full UTM attribution,
//  and a fail-soft posture where a malformed body is logged and answered 200
//  rather than surfacing an error to a customer mid-form.
//
//  Building a second endpoint would have meant a second rate limiter, a second
//  honeypot and a second consent path to keep in step — and the moment they
//  drifted, one of them would be the one quietly accepting a suppressed
//  address. A shared handler cannot drift from itself.
//
//  WHAT A CALLER MUST SEND, beyond the obvious contact fields:
//    source        — the capture surface (QUICK_QUOTE_FORM, HOMEPAGE_ESTIMATE…)
//    consentSource — where the checkbox lived, same controlled vocabulary
//    marketingConsent — OMIT IT unless the visitor actually saw a checkbox.
//                    Sending `false` for "no checkbox on this form" records an
//                    explicit refusal that never happened.
// ════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { POST as capturePartialLead, OPTIONS as partialOptions } from './partial/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Delegates to the hardened partial-lead handler. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return capturePartialLead(req)
}

export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  return partialOptions(req)
}
