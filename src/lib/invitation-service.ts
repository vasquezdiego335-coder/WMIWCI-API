// ============================================================================
// invitation-service.ts — crew invitations (Stage 5, C3).
//
// The invitation MODEL and admin flow are complete. Turning an accepted
// invitation into a login account depends on the auth onboarding flow, which
// does not exist as a self-serve path yet (accounts are created by the
// hash-password + seed script). That external dependency is documented, not
// faked: an accepted invitation records who it is for and is picked up by the
// account-creation step; it never silently creates credentials.
//
// Pure helpers here; the route owns Prisma + audit.
// ============================================================================

import { randomBytes } from 'crypto'

export const INVITATION_TTL_DAYS = 14

export function newInvitationToken(): string {
  return randomBytes(24).toString('base64url')
}

export function invitationExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000)
}

export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime()
}

export type InviteDecision =
  | { allow: true }
  | { allow: false; status: 409 | 422; error: string }

/**
 * Is it safe to create this invitation? Refuses an existing account, an active
 * duplicate invitation, and (belt-and-braces alongside the guard) an OWNER role.
 */
export function evaluateInvite(i: {
  existingUser: boolean
  activePendingInvite: boolean
  role: string
}): InviteDecision {
  if (i.role === 'OWNER') return { allow: false, status: 422, error: 'Crew cannot be invited as an owner.' }
  if (i.existingUser) return { allow: false, status: 409, error: 'A staff account already exists for this email.' }
  if (i.activePendingInvite) return { allow: false, status: 409, error: 'An invitation is already pending for this email.' }
  return { allow: true }
}
