import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { discordQueue } from '@/lib/queues'
import { apiLogger } from '@/lib/logger'
import { normalizeLocale } from '@/lib/i18n'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { ingestLeadSafe } from '@/lib/leads'
import { CONSENT_VERSION, normaliseConsentSource } from '@/lib/consent'

export const runtime = 'nodejs'

// ── CORS ──────────────────────────────────────────────────────
// Mirrors /api/bookings: env-driven allowlist, defaults cover local dev and
// both marketing domains so the static site's contact form can POST here.
const ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ??
  'http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000,https://www.wemoveitweclearit.com,https://wemoveitweclearit.com,https://www.moveitclearit.com,https://moveitclearit.com,https://wmiwci-backend.vercel.app'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

// ── Sanitizers (shared style with /api/bookings) ──────────────
// Strip ASCII control characters, collapse whitespace.
function sanitizeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
}
// Notes: strip control chars except common whitespace, collapse spaces/tabs.
function sanitizeNotes(value: string): string {
  return value
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

const cleanString = (min: number, max: number) =>
  z.string().transform(sanitizeText).pipe(z.string().min(min).max(max))

const ContactSchema = z.object({
  name: cleanString(2, 100),
  email: z.string().transform((v) => sanitizeText(v).toLowerCase()).pipe(z.string().email()),
  phone: z.string().transform(sanitizeText).pipe(z.string().max(25)).optional(),
  subject: z.string().transform(sanitizeText).pipe(z.string().max(120)).optional(),
  message: z.string().transform(sanitizeNotes).pipe(z.string().min(1).max(2000)),
  // EN/ES toggle on the marketing site posts this; defaults to English.
  locale: z.string().transform(sanitizeText).pipe(z.string().max(8)).optional(),
  // ?src= attribution from the landing URL.
  source: z.string().transform(sanitizeText).pipe(z.string().max(60)).optional(),
  // ── MARKETING CONSENT (owner spec 2026-08-06) ────────────────────────
  //  TRI-STATE, and `.optional()` is the whole design: the field is present
  //  ONLY when the visitor actually interacted with the checkbox. An absent
  //  value means "no choice was submitted" and changes nothing — it must never
  //  be coerced to `false`, which would record a refusal that never happened.
  //  A cached page that predates the checkbox therefore keeps working and keeps
  //  writing nothing.
  marketingConsent: z.boolean().optional(),
  /* WAS THE CHECKBOX ON SCREEN? Same tri-state pathology as the booking form
     and the quick quote: contact.html only sends a value once #msg-optin has
     been clicked. See app/api/leads/partial/route.ts for the full reasoning. */
  marketingConsentPresented: z.boolean().optional(),
  consentSource: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  consentVersion: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  // Honeypot — bots fill hidden fields; humans leave them empty.
  /* HONEYPOT — BOUNDED, not max(0).
     `max(0)` made a FILLED honeypot fail the schema, so the request was
     rejected as `invalid_shape` and the silent-accept branch below was
     unreachable dead code. The trap reported the wrong reason for every bot
     that sprang it. A bounded value is accepted so the branch can own the
     decision; it is never stored or echoed, and the bound matters because an
     unbounded string is free memory for anyone who asks. */
  company: z.string().max(200).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = await handleContact(req)
  for (const [k, v] of Object.entries(corsHeaders(req.headers.get('origin')))) {
    res.headers.set(k, v)
  }
  return res
}

async function handleContact(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  const rl = await rateLimit(LIMITS.contact, [clientIp(req)])
  if (!rl.ok) return tooManyRequests(rl) // only blocks when Upstash-backed

  const ua = req.headers.get('user-agent') ?? ''

  // ── MAX DEBUG: log request envelope (never log raw secrets) ──
  apiLogger.info({ ip, ua, origin: req.headers.get('origin') }, 'POST /api/contact received')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    apiLogger.warn({ ip }, '/api/contact — invalid JSON')
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = ContactSchema.safeParse(body)
  if (!parsed.success) {
    apiLogger.warn({ ip, issues: parsed.error.flatten() }, '/api/contact — validation failed')
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  const data = parsed.data

  // Honeypot tripped → pretend success, drop silently (don't tip off bots).
  if (data.company && data.company.length > 0) {
    apiLogger.warn({ ip }, '/api/contact — honeypot tripped, dropping silently')
    return NextResponse.json({ ok: true })
  }

  const locale = normalizeLocale(data.locale)
  apiLogger.debug(
    { name: data.name, email: data.email, hasPhone: !!data.phone, locale, source: data.source },
    '/api/contact — parsed payload',
  )

  // ── Persist the lead FIRST so no inquiry is lost if Discord is down ──
  //  CONSENT EVIDENCE travels with the boolean: the surface it was captured on
  //  and the disclosure version the person actually read. Normalised against
  //  the controlled vocabulary here so an unrecognised value falls back to THIS
  //  form rather than being stored raw. ingestLeadSafe checks the suppression
  //  list before any of it is written, so a form can never re-subscribe someone
  //  who unsubscribed.
  //  One correlation id, shared by the response, the structured log and the
  //  operations alert, so a customer saying "it failed" can be matched to the
  //  exact incident without asking them for anything identifying.
  const errorRef = randomUUID()
  let leadFailed = false
  const lead = await ingestLeadSafe(
    {
      name: data.name,
      email: data.email,
      phone: data.phone,
      message: data.subject ? `${data.subject}: ${data.message}` : data.message,
      source: data.source ?? 'contact-form',
      landingPage: req.headers.get('referer') ?? undefined,
      referrer: req.headers.get('referer') ?? undefined,
      marketingConsent: data.marketingConsent,
      marketingConsentPrompted: data.marketingConsentPresented,
      consentSource: normaliseConsentSource(data.consentSource) ?? 'CONTACT_FORM',
      consentVersion: data.consentVersion || CONSENT_VERSION,
    },
    'contact-form',
  )
  if (!lead) leadFailed = true

  // ── Non-quote nurture (Sequence B) ──────────────────────────────────
  //  A contact-form lead has an intent and an email and NO calculated quote,
  //  which is exactly what this sequence is for. It refuses itself for anyone
  //  without an explicit opt-in, anyone who already has a quote, and anyone who
  //  has booked with us before — so this call is a no-op for most submissions,
  //  and that is the correct, expected outcome. Fire-and-forget: a Redis stall
  //  must never cost us the message.
  if (lead) {
    void import('@/lib/journeys')
      .then((m) => m.onLeadCaptured(lead.lead.id))
      .catch((err) => apiLogger.warn({ err: String(err).slice(0, 200) }, 'lead nurture trigger failed (non-fatal)'))
  }

  // ── 1) Alert the team in Discord (reliable, always attempted) ──
  try {
    await discordQueue.add('contact-message', {
      type: 'contact-message',
      payload: {
        name: data.name,
        email: data.email,
        phone: data.phone ?? '—',
        subject: data.subject ?? '(no subject)',
        message: data.message,
        locale,
        source: data.source ?? 'direct',
        ip,
      },
    })
    apiLogger.debug('/api/contact — queued Discord contact-message')
  } catch (err) {
    apiLogger.error({ err }, '/api/contact — Discord queue failed (non-fatal)')
  }

  // ── 2) NO customer auto-reply email/SMS ──
  // MESSAGING POLICY: the system sends exactly four customer messages
  // (pre-approval + final-confirmation, each as email + SMS). The contact-form
  // acknowledgement is NOT one of them, so we only alert the team in Discord
  // above; the customer's confirmation is the inline JSON response below.
  // (To re-enable: add 'contact-ack' to ALLOWED_TEMPLATES in the email worker
  //  and restore the smsQueue.add for contact-ack-sms.)

  // ── A LOST CONTACT MESSAGE MUST NOT LOOK LIKE A DELIVERED ONE ────────
  //  This route answered {ok:true} even when the lead was never persisted, so
  //  HTTP monitoring saw a healthy request while the customer's enquiry existed
  //  nowhere. The customer is told plainly, given the phone number, and handed
  //  a reference; the SYSTEM records the same reference for correlation.
  if (leadFailed) {
    apiLogger.error(
      { errorRef, locale, stage: 'contact_lead_persist' },
      '/api/contact — the enquiry was NOT persisted',
    )
    void import('@/lib/ops-alert')
      .then((m) => m.postOpsAlert?.('Contact form is failing', [
        { message: `A contact enquiry could not be persisted. Reference ${errorRef}.` },
        { message: 'Enquiries are being LOST while this continues. Check the database connection.' },
      ]))
      .catch(() => { /* the alert must never mask the 503 */ })
    return NextResponse.json(
      {
        ok: false,
        error: 'contact_unavailable',
        errorRef,
        message:
          locale === 'es'
            ? 'No pudimos guardar tu mensaje. Por favor llámanos o escríbenos al 862-640-0625.'
            : "We couldn't save your message. Please call or text us at 862-640-0625.",
      },
      { status: 503 },
    )
  }

  apiLogger.info({ locale }, '/api/contact handled OK (team alerted via Discord; no customer auto-reply per messaging policy)')
  return NextResponse.json({
    ok: true,
    message:
      locale === 'es'
        ? 'Mensaje recibido. Te responderemos pronto.'
        : "Message received. We'll reply shortly.",
  })
}
