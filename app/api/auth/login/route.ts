import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { signToken, setSessionCookie } from '@/lib/auth'
import { authLogger } from '@/lib/logger'
import { prisma as db } from '@/lib/db'

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = LoginSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { email, password } = parsed.data

  const user = await prisma.user.findUnique({ where: { email } })

  // Constant-time comparison to prevent timing attacks
  const hash = user?.passwordHash ?? '$2b$12$invalidhashforthisconstanttime'
  const match = await bcrypt.compare(password, hash)

  if (!user || !match || !user.active) {
    authLogger.warn({ email, ip }, 'Failed login attempt')
    // Artificial delay to slow brute force
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 500))
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  const token = await signToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  })

  // Audit log
  await db.auditLog.create({
    data: {
      action: 'USER_LOGIN',
      userId: user.id,
      ipAddress: ip,
      details: { email: user.email },
    },
  })

  authLogger.info({ userId: user.id, role: user.role, ip }, 'Login successful')

  let res: NextResponse = NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  })
  res = setSessionCookie(res, token)
  return res
}
