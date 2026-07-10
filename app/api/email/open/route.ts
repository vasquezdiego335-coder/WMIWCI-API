import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'

// ════════════════════════════════════════════════════════════════════════
//  EMAIL OPEN TRACKING  —  GET /api/email/open?token=OPEN_TOKEN
//  ----------------------------------------------------------------------
//  A 1x1 transparent GIF is embedded in every sent email as:
//    <img src="{APP_URL}/api/email/open?token=OPEN_TOKEN" width="1" height="1" />
//  The FIRST time the recipient's client loads it we stamp openedAt +
//  isOpened on the matching Notification; every subsequent load bumps
//  openCount. Tracking never blocks the pixel response — we always return the
//  GIF so the email renders even if the DB is unreachable.
//
//  NOTE (deliverability reality): Gmail/Apple pre-fetch & proxy images, so an
//  "open" means "the client loaded the pixel", which is the industry-standard
//  proxy for a read. Some clients block remote images → no open recorded even
//  though the email was read. Treat opens as a strong signal, not proof.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs' // Prisma needs the Node runtime (not edge)
export const dynamic = 'force-dynamic' // never cache the endpoint itself

// 43-byte 1x1 fully-transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

function pixelResponse(): Response {
  return new Response(PIXEL, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(PIXEL.length),
      // Bust every proxy/cache so re-opens can be counted.
      'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
  })
}

export async function GET(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get('token')?.trim()
  if (token) {
    try {
      // First open: stamp openedAt + isOpened atomically (the WHERE isOpened=false
      // guard makes concurrent pixel loads race-safe — only one row-update wins).
      const first = await prisma.notification.updateMany({
        where: { openToken: token, isOpened: false },
        data: { isOpened: true, openedAt: new Date(), openCount: { increment: 1 } },
      })
      // Already opened before → this is a re-open; just bump the counter.
      if (first.count === 0) {
        await prisma.notification.updateMany({
          where: { openToken: token, isOpened: true },
          data: { openCount: { increment: 1 } },
        })
      }
    } catch {
      // Swallow — a tracking hiccup must never break the pixel.
    }
  }
  return pixelResponse()
}
