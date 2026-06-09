import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { UserRole } from '@prisma/client'

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'dev_secret_minimum_32_chars_long!!'
)

const COOKIE_NAME = 'moveit_session'

export interface SessionPayload {
  userId: string
  email: string
  name: string
  role: UserRole
}

// ── Sign a new JWT ─────────────────────────────────────────────
export async function signToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_EXPIRY ?? '7d')
    .setIssuer('moveitclearit.com')
    .setAudience('wmiwci-backend.vercel.app')
    .sign(JWT_SECRET)
}

// ── Verify a JWT string ────────────────────────────────────────
export async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, {
      issuer: 'moveitclearit.com',
      audience: 'wmiwci-backend.vercel.app',
    })
    return payload as unknown as SessionPayload
  } catch {
    return null
  }
}

// ── Read session from HTTP-only cookie ────────────────────────
export async function getSession(): Promise<SessionPayload | null> {
  const token = cookies().get(COOKIE_NAME)?.value
  if (!token) return null
  return verifyToken(token)
}

// ── Set session cookie on a response ─────────────────────────
export function setSessionCookie(res: NextResponse, token: string): NextResponse {
  const isProd = process.env.NODE_ENV === 'production'
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days in seconds
  })
  return res
}

// ── Clear session cookie ──────────────────────────────────────
export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  })
  return res
}

// ── Extract session from request (for middleware) ─────────────
export async function getSessionFromRequest(
  req: NextRequest
): Promise<SessionPayload | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value
  if (!token) return null
  return verifyToken(token)
}

// ── Role guards ───────────────────────────────────────────────
export function requireRole(
  session: SessionPayload | null,
  ...roles: UserRole[]
): session is SessionPayload {
  if (!session) return false
  return roles.includes(session.role)
}

export const isOwner = (s: SessionPayload | null) =>
  requireRole(s, UserRole.OWNER)

export const isManager = (s: SessionPayload | null) =>
  requireRole(s, UserRole.OWNER, UserRole.MANAGER)

export const isCrew = (s: SessionPayload | null) =>
  requireRole(s, UserRole.OWNER, UserRole.MANAGER, UserRole.CREW)

// ── CSRF token (double-submit cookie pattern) ─────────────────
export function generateCsrfToken(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function verifyCsrfToken(req: NextRequest): boolean {
  // Skip CSRF for GET/HEAD/OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true

  const cookieToken = req.cookies.get('moveit_csrf')?.value
  const headerToken = req.headers.get('X-CSRF-Token')

  if (!cookieToken || !headerToken) return false
  return cookieToken === headerToken
}
