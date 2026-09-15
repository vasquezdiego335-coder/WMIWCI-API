// ════════════════════════════════════════════════════════════════════════
//  LAST-ACTIVITY SNAPSHOT for the operations digest (incident 2026-09-14)
//  ---------------------------------------------------------------------
//  "Did the emails stop, or did the customers stop?" took a 20-agent
//  investigation to answer, because nothing anywhere put the two facts side by
//  side. The morning digest now carries four lines every day:
//
//      last quick-quote lead · last partial lead · last real email · last booking
//
//  each with its age. It never alerts (email-agent checks do that); it makes a
//  zero-demand week and a broken pipeline look DIFFERENT at a glance.
//
//  No PII: timestamps and ages only.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'

export type ActivitySnapshot = {
  lastQuickQuoteLeadAt: Date | null
  lastPartialLeadAt: Date | null
  lastRealEmailAt: Date | null
  lastBookingAt: Date | null
}

/** PURE: a human age like "3h ago" / "12d ago" / "never". */
export function formatAge(at: Date | null, now: Date = new Date()): string {
  if (!at) return 'never'
  const ms = Math.max(0, now.getTime() - at.getTime())
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** PURE: the digest lines, in a fixed order. */
export function activityLines(s: ActivitySnapshot, now: Date = new Date()): string[] {
  const et = (d: Date | null) =>
    d
      ? d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'
      : '—'
  return [
    `Last quick-quote lead: ${formatAge(s.lastQuickQuoteLeadAt, now)} (${et(s.lastQuickQuoteLeadAt)})`,
    `Last partial lead: ${formatAge(s.lastPartialLeadAt, now)} (${et(s.lastPartialLeadAt)})`,
    `Last real email sent: ${formatAge(s.lastRealEmailAt, now)} (${et(s.lastRealEmailAt)})`,
    `Last booking: ${formatAge(s.lastBookingAt, now)} (${et(s.lastBookingAt)})`,
  ]
}

/** Four indexed aggregate reads. Each failure degrades to null, never throws. */
export async function lastActivitySnapshot(): Promise<ActivitySnapshot> {
  const safe = <T>(p: Promise<T>) => p.catch(() => null)
  const [quick, partial, email, booking] = await Promise.all([
    safe(
      prisma.lead.findFirst({
        where: { OR: [{ source: 'QUICK_QUOTE_FORM' }, { quoteConfirmationQueuedAt: { not: null } }] },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
    ),
    safe(
      prisma.lead.findFirst({
        where: { bookingSessionId: { not: null }, source: { not: 'QUICK_QUOTE_FORM' }, quoteConfirmationQueuedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
    ),
    safe(
      prisma.emailSend.findFirst({
        where: { isTest: false, sentAt: { not: null }, providerId: { not: null } },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
      })
    ),
    safe(
      prisma.booking.findFirst({
        where: { isInternalTest: false },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
    ),
  ])
  return {
    lastQuickQuoteLeadAt: quick?.createdAt ?? null,
    lastPartialLeadAt: partial?.createdAt ?? null,
    lastRealEmailAt: email?.sentAt ?? null,
    lastBookingAt: booking?.createdAt ?? null,
  }
}
