import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { timingSafeEqual } from 'crypto'
import { notifyLead } from '@/lib/notify'
import { apiLogger } from '@/lib/logger'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { ingestLeadSafe } from '@/lib/leads'
import { CONSENT_VERSION, normaliseConsentSource, routeConsentSource } from '@/lib/consent'
import {
  applyCaptureBasis,
  captureBasisDeps,
  captureClient,
  captureRequestId,
  describeCaptureBasis,
  legacyConsentGivenOptOut,
  startCaptureScenario,
  type CaptureContract,
} from '@/lib/capture-basis'

// ════════════════════════════════════════════════════════════════════════
//  POST /api/notify/lead — internal, server-to-server.
//  Called by the marketing-tracker (Railway) whenever a new lead is created,
//  so WMIWCI-API can fan out the owner alert + the customer auto-reply through
//  its existing Resend wiring. EMAIL ONLY — SMS sending was removed 2026-09-15.
//
//  Auth: shared secret in the `x-internal-token` header, compared in constant
//  time against INTERNAL_NOTIFY_TOKEN. Fails CLOSED (401) when the token is
//  unset or mismatched — this route can send real, billable messages.
//  NOTE: server-to-server only, so there is intentionally no CORS here.
//
//  THE TRACKER FORWARD (email consent release 2026-09-16, DESIGN-v2 §4). The
//  tracker's landing form (go.moveitclearit.com/quote) forwards
//  { source:'tracker', externalId, noticeVersion, clientIp, userAgent,
//    submittedAt, emailOptOut }:
//    • externalId is the tracker's own lead id. A forward is recorded ONCE per
//      (source, externalId): a retried forward is answered 200 `duplicate`
//      and neither re-ingests the lead nor re-sends anything.
//    • noticeVersion is resolved against the 'tracker' surface. A granted
//      notice starts the existing general lead nurture, only after every grant
//      safeguard passes. An unknown version, a stale submittedAt or none at all
//      is recorded as basis_withheld and starts nothing.
//    • clientIp is the VISITOR's address, trusted only because this request
//      carries the internal token; it feeds the per-IP grant throttle and is
//      stored only as a keyed HMAC.
//    • emailOptOut: true records opted_out_at_capture and stops the person's
//      sequences.
//  A caller that sends none of these (the legacy shape) behaves exactly as
//  before.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'

const Body = z.object({
  name: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(25).optional(),
  email: z.string().trim().max(200).optional(),
  source: z.string().trim().max(60).optional(),
  found_us: z.string().trim().max(60).optional(),
  message: z.string().trim().max(2000).optional(),
  // Either key works; the tracker posts `language`, the rest of the app uses `locale`.
  language: z.string().trim().max(8).optional(),
  locale: z.string().trim().max(8).optional(),
  // ── MARKETING CONSENT (owner spec 2026-08-06) ────────────────────────
  //  The tracker is a separate application with its own forms. This endpoint
  //  now ACCEPTS a consent decision so a tracker form that shows an unchecked
  //  checkbox can record it — previously there was nowhere to put the answer,
  //  so every tracker lead was structurally `null` no matter what it asked.
  //  TRI-STATE: omit the field entirely when no choice was presented.
  marketing_consent: z.boolean().optional(),
  consent_source: z.string().trim().max(40).optional(),
  consent_version: z.string().trim().max(40).optional(),
  // ── The tracker forward contract (2026-09-16). All optional and lenient. ──
  externalId: z.string().trim().max(80).optional().catch(undefined),
  noticeVersion: z.string().trim().max(64).optional().catch(undefined),
  clientIp: z.string().trim().max(64).optional().catch(undefined),
  userAgent: z.string().trim().max(500).optional().catch(undefined),
  submittedAt: z.string().trim().max(40).optional().catch(undefined),
  emailOptOut: z.boolean().optional().catch(undefined),
  //  The tracker's own campaign code (?src=) — the form source the visitor came
  //  from. Stored as the lead's utm campaign; junk is dropped, never a failure.
  sourceCode: z.string().trim().max(60).optional().catch(undefined),
})

/** `source` value that marks a forward from the tracker landing form. */
const TRACKER_SOURCE = 'tracker'

function tokenOk(req: NextRequest): boolean {
  const expected = process.env.INTERNAL_NOTIFY_TOKEN?.trim()
  if (!expected) return false // fail closed: no token configured → reject
  const got = (req.headers.get('x-internal-token') ?? '').trim()
  // timingSafeEqual requires equal-length buffers; bail early on length mismatch.
  if (got.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!tokenOk(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const rl = await rateLimit(LIMITS.notifyLead, [clientIp(req)])
  if (!rl.ok) return tooManyRequests(rl)


  let json: unknown
  try {
    json = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 })
  }

  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'validation failed', details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  const d = parsed.data
  const fromTracker = d.source === TRACKER_SOURCE
  const externalId = fromTracker ? d.externalId?.replace(/[^A-Za-z0-9_-]/g, '') || null : null
  const contract: CaptureContract = {
    marketingNotice: fromTracker && d.noticeVersion ? { version: d.noticeVersion, trigger: 'submit' } : undefined,
    emailMarketingOptOut: fromTracker ? d.emailOptOut : undefined,
  }

  // ── ONE FORWARD PER (source, externalId) ───────────────────────────────
  //  The tracker retries a forward it did not see acknowledged. Every forward
  //  with an externalId records exactly one consent event under a request id
  //  derived from it, so a replay is recognised before anything is written or
  //  sent again. A read failure proceeds as a first delivery: the lead merge,
  //  the per-day acknowledgement key and the event's own unique key still
  //  prevent duplicates.
  if (externalId && d.email) {
    const requestId = captureRequestId(TRACKER_SOURCE, 'submit', externalId, d.email)
    const seen = await captureBasisDeps()
      .submissionSeen(requestId)
      .catch(() => false)
    if (seen) {
      apiLogger.info('POST /api/notify/lead — duplicate tracker forward ignored')
      return NextResponse.json({ ok: true, duplicate: true })
    }
  }

  // Persist to the admin Lead table BEFORE notifying (marketing tracker feed).
  const lead = await ingestLeadSafe(
    {
      name: d.name,
      phone: d.phone,
      email: d.email,
      message: d.message,
      source: d.source ?? 'marketing-tracker',
      ...(fromTracker ? { utmSource: 'tracker', utmCampaign: d.sourceCode ?? null } : {}),
      foundUs: d.found_us,
      // An old-shape opt-in keeps today's meaning — unless the forward also
      // says the visitor ticked "don't email me", which wins.
      marketingConsent: legacyConsentGivenOptOut(d.marketing_consent, contract),
      // DERIVED FROM THE ROUTE (2026-09-16): every lead here comes from the
      // tracker's landing form, which used to be mislabelled CONTACT_FORM. A
      // staff/import source in the body is never recorded.
      consentSource: routeConsentSource('TRACKER_LANDING', normaliseConsentSource(d.consent_source)),
      consentVersion: d.consent_version || CONSENT_VERSION,
    },
    'notify-lead',
  )

  try {
    // notifyLead is internally guarded (each send is non-fatal); this await just
    // ensures the work is done before the serverless function freezes.
    await notifyLead({
      name: d.name,
      phone: d.phone,
      email: d.email,
      source: d.source,
      foundUs: d.found_us,
      message: d.message,
      locale: d.locale || d.language,
    })
  } catch (err) {
    apiLogger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'POST /api/notify/lead — notifyLead threw (unexpected)'
    )
    return NextResponse.json({ ok: false, error: 'notify failed' }, { status: 500 })
  }

  // ── MARKETING BASIS (tracker forwards only) ────────────────────────────
  //  AFTER the owner alert and the customer acknowledgement, before any
  //  sequence. The event this writes is also what marks the forward as seen
  //  (above), so a forward whose acknowledgement failed (500) is retried in
  //  full, not answered "duplicate". The visitor's clientIp is trusted for the
  //  throttle because this request passed the token check.
  const submittedAt = d.submittedAt ? new Date(d.submittedAt) : null
  const basis =
    lead && fromTracker
      ? await applyCaptureBasis({
          surface: 'tracker',
          //  The tracker landing form's sequence: the general lead nurture.
          scenario: 'lead_nurture',
          email: d.email,
          leadId: lead.lead.id,
          contract,
          acceptTrigger: 'submit',
          locale: d.locale || d.language,
          region: { phone: d.phone },
          client: {
            ip: d.clientIp || null,
            userAgent: d.userAgent ?? null,
            pageUrl: captureClient(req).pageUrl,
          },
          submissionKey: externalId,
          submittedAt: submittedAt && !Number.isNaN(submittedAt.getTime()) ? submittedAt : null,
          //  A forward with an id always leaves one event, so its replay is
          //  recognisable above even when it carried no notice.
          recordAbsentNotice: Boolean(externalId),
        })
      : null
  if (basis && basis.status !== 'none') {
    apiLogger.info({ basis: describeCaptureBasis(basis) }, 'POST /api/notify/lead — marketing basis')
  }

  // ── PROMOTIONAL FOLLOW-UP, only after the requested response is on its way ──
  //  The owner alert and the customer acknowledgement above come first, so a
  //  slow queue can never hold up either one.
  // Sequence B. Self-refusing for anyone without an explicit opt-in, so a
  // tracker that never asks the question enrols nobody.
  if (lead) {
    void import('@/lib/journeys')
      .then((m) => m.onLeadCaptured(lead.lead.id))
      .catch((err) => apiLogger.warn({ err: String(err).slice(0, 200) }, 'lead nurture trigger failed (non-fatal)'))
  }
  // The tracker submission's own sequence: the general lead nurture on its
  // notice. Never throws.
  if (lead && basis) await startCaptureScenario(basis, { surface: 'tracker', email: d.email, leadId: lead.lead.id })

  return NextResponse.json({ ok: true })
}

// Reject other verbs explicitly.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, error: 'method not allowed — use POST' }, { status: 405 })
}
