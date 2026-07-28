import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { rateLimit, LIMITS, clientIp } from '@/lib/rate-limit'

// ════════════════════════════════════════════════════════════════════════
//  POST /api/track/click — PUBLIC, cross-origin (owner spec 2026-07-28)
//
//  Records ONE arrival from a cloaked short link (/m, /fb, /ig, /tt, /qr).
//  The browser fires this once per session — site-copy.js guards it with a
//  sessionStorage flag — so a row means "a visit", not "a page view".
//
//  WHY IT IS ITS OWN ROUTE rather than an alias over /api/leads:
//  a click is not a lead. Writing arrivals into the Lead table would fill the
//  owner's inbox with rows that have no name and no phone, and would corrupt
//  every "how many leads did we get" number on the site. Different meaning,
//  different table.
//
//  FAIL-SOFT, ALWAYS. This is analytics on the critical path of a customer
//  landing on the homepage. It answers 200 for essentially everything:
//  a bad body, a rate-limit trip, even a database outage. Nothing this route
//  does may ever slow down or break a page load. The client already ignores
//  the response.
//
//  NOT PERSONAL DATA. No IP, cookie or fingerprint is stored — clientIp() is
//  used for the rate-limit key only and never written. See the model comment
//  in schema.prisma.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

/** Same sanitizer as the lead routes: strip control chars, collapse whitespace. */
function sanitizeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
}
const str = (max: number) =>
  z.string().transform(sanitizeText).pipe(z.string().max(max)).optional()

const ClickSchema = z.object({
  source: z.string().transform(sanitizeText).pipe(z.string().min(1).max(80)),
  medium: str(80),
  campaign: str(120),
  landingPath: str(200),
  referrer: str(500),
})

/**
 * Only channels we actually publish. An open `source` column would let anyone
 * POST arbitrary strings and pollute the owner's only view of his marketing —
 * the numbers have to be trustworthy or the page is worse than not having it.
 * Unknown values are folded to "other" rather than rejected, so a link we
 * forget to list here still counts as traffic instead of vanishing.
 */
const KNOWN_SOURCES = new Set(['facebook', 'instagram', 'tiktok', 'print', 'google', 'direct', 'other'])

export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = await handle(req)
  for (const [k, v] of Object.entries(corsHeaders(req.headers.get('origin')))) res.headers.set(k, v)
  return res
}

async function handle(req: NextRequest): Promise<NextResponse> {
  // Fail OPEN (see LIMITS.trackClick): a limiter blip must not punch a hole in
  // the traffic numbers, and there is nothing here worth protecting beyond
  // casual flooding. Answers 200 even when it does block — the client ignores
  // the body, and a 429 on a homepage load helps nobody.
  const rl = await rateLimit(LIMITS.trackClick, [clientIp(req)])
  if (!rl.ok) return NextResponse.json({ ok: true, skipped: 'rate_limited' })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: true, skipped: 'bad_json' })
  }

  const parsed = ClickSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ ok: true, skipped: 'invalid' })

  const raw = parsed.data.source.toLowerCase()
  const source = KNOWN_SOURCES.has(raw) ? raw : 'other'

  try {
    await prisma.linkClick.create({
      data: {
        source,
        medium: parsed.data.medium?.toLowerCase() || null,
        campaign: parsed.data.campaign?.toLowerCase() || null,
        landingPath: parsed.data.landingPath || null,
        referrer: parsed.data.referrer || null,
      },
    })
  } catch (err) {
    // A dropped analytics row is an acceptable loss; a 500 on the homepage is not.
    apiLogger.warn({ err }, 'link click not recorded')
    return NextResponse.json({ ok: true, skipped: 'write_failed' })
  }

  return NextResponse.json({ ok: true })
}
