import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit, tooManyRequests, clientIp, LIMITS } from '@/lib/rate-limit'
import { isValidPublicToken, effectiveStatus } from '@/lib/deposit-links'

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/deposit/[token]/status
//  ------------------------------------------------------------------------
//  The ONE question the returning-from-Stripe page is allowed to ask: has the
//  webhook confirmed this deposit yet?
//
//  It reports the stored state and nothing else. It cannot mark anything paid,
//  it never calls Stripe, and it returns no name, amount, balance, booking or
//  contact detail — so polling it reveals nothing beyond a status word the
//  holder of the link already sees on the page.
// ════════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { token: string } }): Promise<NextResponse> {
  const token = params.token
  if (!isValidPublicToken(token)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const limited = await rateLimit(LIMITS.depositStatus, [clientIp(req), `token:${token}`])
  if (!limited.ok) return tooManyRequests(limited)

  const row = await prisma.depositRequest.findUnique({
    where: { publicToken: token },
    select: { status: true, expiresAt: true, paidAt: true },
  })
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json(
    { status: effectiveStatus(row) },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
