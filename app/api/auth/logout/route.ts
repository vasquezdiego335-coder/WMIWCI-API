import { NextRequest, NextResponse } from 'next/server'
import { getSession, clearSessionCookie } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (session) {
    await prisma.auditLog.create({
      data: {
        action: 'USER_LOGOUT',
        userId: session.userId,
        ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown',
      },
    })
  }
  let res: NextResponse = NextResponse.json({ ok: true })
  res = clearSessionCookie(res)
  return res
}
