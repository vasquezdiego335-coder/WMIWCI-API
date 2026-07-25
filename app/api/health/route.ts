import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkEnv } from '@/lib/env'
import { unsafeUrlReason } from '@/emails/validation'

export const revalidate = 0

// ── APP_URL SELF-CHECK (production incident 2026-07-24) ────────────────────
// APP_URL sat in production as `https://PASTE_YOUR_LIVE_URL_HERE`, so every
// portal / checkout-resume / unsubscribe link in every email 404'd — and
// nothing surfaced it, because `checkEnv()` only ever reported that the var was
// PRESENT, never whether its value was usable. Presence is not configuration.
//
// APP_URL is public by definition (it is printed in customer emails), so
// reporting its host here discloses nothing secret while making a placeholder
// or wrong-host value instantly visible to an operator — and to any uptime
// check watching this endpoint.
function urlVarHealth(name: string) {
  const raw = process.env[name]?.trim() ?? ''
  if (!raw) return { configured: false, reason: 'unset' as string | null, host: null as string | null }
  const reason = unsafeUrlReason(raw) // catches placeholders, http://, localhost, …
  let host: string | null = null
  try {
    host = new URL(raw).host
  } catch {
    /* unparseable — reason above already says so */
  }
  return { configured: reason === null, reason, host }
}

const appUrlHealth = () => urlVarHealth('APP_URL')

/**
 * Every env var that becomes a LINK IN A CUSTOMER EMAIL.
 *
 * Reported because presence is not configuration: MARKETING_SITE_URL feeds
 * bookingUrl, redeemUrl and the referral fallback, so a stale value silently
 * mails dead links to customers (it was pointing at a retired domain when this
 * was added). Hosts are public by definition — they are printed in the emails.
 *
 * Advisory only: these do NOT fail the readiness probe, because a link var can
 * be legitimately unset (the code has live fallbacks). APP_URL stays a hard
 * requirement above since nothing can substitute for it.
 */
function linkVarsHealth() {
  return {
    MARKETING_SITE_URL: urlVarHealth('MARKETING_SITE_URL'),
    REFERRAL_URL: urlVarHealth('REFERRAL_URL'),
    GOOGLE_REVIEW_URL: urlVarHealth('GOOGLE_REVIEW_URL'),
  }
}

// GET /api/health — liveness + readiness probe.
// Returns 200 when the DB is reachable AND all required env vars are present
// AND APP_URL is a usable URL; 503 otherwise. Only env-var PRESENCE is
// reported, never secret values (APP_URL's host is public by design).
export async function GET(): Promise<NextResponse> {
  const env = checkEnv()
  const appUrl = appUrlHealth()
  const timestamp = new Date().toISOString()

  let db: 'connected' | 'unreachable' = 'unreachable'
  try {
    await prisma.$queryRaw`SELECT 1`
    db = 'connected'
  } catch {
    db = 'unreachable'
  }

  // A placeholder/unusable APP_URL is a DEGRADED system: the app runs, but every
  // link it mails is broken. That must fail the readiness probe, not hide.
  const ok = db === 'connected' && env.ok && appUrl.configured
  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      db,
      appUrl,
      linkVars: linkVarsHealth(),
      env: {
        ok: env.ok,
        missingRequired: env.missingRequired,
        groups: env.groups,
      },
      timestamp,
    },
    { status: ok ? 200 : 503 }
  )
}
