import { prisma } from './db'

// ════════════════════════════════════════════════════════════════════════
//  booking-reference.ts — the public, human-friendly booking reference.
//
//    Public reference : WMIC-1000, WMIC-1001, …   (customers, owners, crew)
//    Internal id      : the existing cuid          (relationships, webhooks)
//
//  References are minted from an ATOMIC Postgres sequence (booking_reference_seq,
//  created in migration 20260713120000_booking_reference). nextval() is
//  transactional and concurrency-safe by construction, so two simultaneous
//  bookings can NEVER receive the same reference — no count+1, no random ids.
//  A reference is assigned once at creation and never changes.
// ════════════════════════════════════════════════════════════════════════

export const BOOKING_REF_PREFIX = 'WMIC-'

/** Format a raw sequence value as a public reference (min 4 digits: WMIC-1000). */
export function formatBookingReference(n: number | bigint): string {
  return `${BOOKING_REF_PREFIX}${String(n).padStart(4, '0')}`
}

/** True for a well-formed reference. Case-insensitive; tolerates a missing dash. */
export function isBookingReference(s: string): boolean {
  return /^wmic-?\d{3,}$/i.test(s.trim())
}

/**
 * Normalise user input to the canonical stored form for lookup. Accepts
 * "WMIC-1042", "wmic1042", "WMIC 1042", or a bare "1042". Returns null when the
 * input is not a plausible reference (so search can fall through to other fields).
 */
export function normalizeBookingReference(input: string): string | null {
  const t = input.trim().toUpperCase().replace(/\s+/g, '')
  if (!t) return null
  const m = t.match(/^(?:WMIC-?)?(\d{3,})$/)
  return m ? `${BOOKING_REF_PREFIX}${m[1]}` : null
}

/**
 * Reserve the next public booking reference from the atomic sequence.
 * Concurrency-safe: nextval() serialises at the database, so callers racing to
 * create bookings each get a distinct value.
 */
export async function nextBookingReference(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('booking_reference_seq') AS n`
  return formatBookingReference(rows[0].n)
}

/** The value to SHOW on any customer/owner surface: the public reference, with a
 *  safe fallback to display_id/id for historical rows that predate the column. */
export function publicRef(b: { bookingReference?: string | null; displayId?: string | null; id?: string }): string {
  return b.bookingReference ?? b.displayId ?? b.id ?? '—'
}
