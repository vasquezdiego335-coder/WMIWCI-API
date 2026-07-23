// ════════════════════════════════════════════════════════════════════════
//  EMAIL ATTRIBUTION — did the email make money? (owner spec 2026-07-21)
//  ---------------------------------------------------------------------
//  Connects the email ledger to the EXISTING Stage 3 marketing attribution and
//  Stage 4 financial records. It deliberately builds NO second attribution
//  system: campaign identity, first/last touch and the profit-ROAS arithmetic
//  already live in marketing-profitability.ts and the FinancialSnapshot table,
//  and this module reads them.
//
//  ═══ THE THREE RULES THAT KEEP THIS HONEST ═══
//
//  1. A TRANSACTIONAL EMAIL NEVER CLAIMS A CONVERSION.
//     A payment receipt is sent BECAUSE a booking happened. Counting the
//     booking as the receipt's conversion would make the most reliable
//     transactional templates look like the best marketing in the business.
//     Transactional journeys report reach and delivery only; their conversion
//     figure is `null` with a stated reason, never 0 and never a number.
//
//  2. THE EMAIL MUST PRECEDE THE CONVERSION.
//     A booking that was already paid before the recovery email went out was
//     not recovered by it. Every conversion is time-ordered against the send.
//
//  3. UNCOLLECTED REVENUE IS NOT PROFIT, AND PROVISIONAL PROFIT IS NOT
//     FINALIZED PROFIT. Attributed profit comes only from CURRENT (non-
//     superseded) FinancialSnapshot rows. Moves that completed but are not
//     financially closed out are counted and reported SEPARATELY, exactly as
//     marketing-profitability.ts requires.
//
//  READ-ONLY over the financial tables. This module writes nothing, and it does
//  not touch profit allocation, closeout or distribution logic.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { CAPTURED_PAYMENT_WHERE, netCollectedCentsOf, type PaymentRow } from './money-rules'
import { journeyRegistry, type JourneyEntry } from './email-registry'
import { rangeStart, type RangeKey } from './email-admin'

/** Journeys whose emails are a CAUSE of a booking rather than a consequence. */
const CONVERTING_JOURNEYS = new Set(['abandoned', 'quote', 'post-job'])

/**
 * May this journey be credited with causing a booking? Exported so rule 1 is
 * directly testable without a database: a transactional journey that started
 * claiming conversions is the single most likely way this module goes wrong,
 * and it should fail a unit test rather than quietly inflate a report.
 */
export const canClaimConversions = (journeyKey: string): boolean => CONVERTING_JOURNEYS.has(journeyKey)

export type AttributionRow = {
  journey: string
  name: string
  emailClass: string
  enabled: boolean
  /** Sends the provider accepted. */
  delivered: number
  /** Provider-confirmed deliveries (webhook events). */
  confirmed: number
  opened: number
  clicked: number
  bounced: number
  complained: number
  unsubscribed: number
  /** Distinct recipients reached. */
  recipients: number
  /**
   * Bookings credited to this journey, or null when the journey cannot
   * legitimately claim conversions (see rule 1).
   */
  bookings: number | null
  completedMoves: number | null
  finalizedMoves: number | null
  /** Net collected revenue on attributed moves, in cents. */
  netCollectedRevenueCents: number
  /** FINALIZED company net profit only. The number a decision may rest on. */
  finalizedNetProfitCents: number
  /** Profit on attributed moves that are not yet closed out. Reported, never
   *  folded into the finalized figure. */
  provisionalMoves: number
  /** Why a conversion figure is absent or incomplete. */
  caveat: string | null
}

/** One booking credited to an email, with the evidence for the credit. */
type Credit = {
  bookingId: string
  /** The send that preceded the conversion. */
  sentAt: Date
}

/**
 * Bookings a CONVERTING journey may claim.
 *
 * Evidence chain, per journey shape:
 *  • abandoned  — the email is about a specific booking that was unpaid. The
 *                 booking counts only if it left PENDING_PAYMENT after the send.
 *  • quote      — the email is about a Lead. The credit is the lead's
 *                 convertedBookingId, and only when conversion followed the send.
 *  • post-job   — the email asks for a review/referral/repeat booking. The claim
 *                 is a LATER booking by the same customer, never the move the
 *                 email was about.
 */
async function creditsFor(journey: string, since: Date | null): Promise<{ credits: Credit[]; caveat: string | null }> {
  const sendWhere = {
    journey,
    status: 'delivered',
    // Admin test sends never count as a conversion. Rehearsing a template must
    // not be able to move a marketing number.
    isTest: false,
    ...(since ? { sentAt: { gte: since } } : {}),
  }

  const sends = await prisma.emailSend.findMany({
    where: sendWhere,
    select: { bookingId: true, leadId: true, email: true, sentAt: true },
  })
  if (sends.length === 0) return { credits: [], caveat: null }

  const credits = new Map<string, Credit>()
  const keep = (bookingId: string, sentAt: Date) => {
    const existing = credits.get(bookingId)
    // First qualifying send wins — the one that plausibly caused it.
    if (!existing || existing.sentAt > sentAt) credits.set(bookingId, { bookingId, sentAt })
  }

  if (journey === 'abandoned') {
    const ids = Array.from(new Set(sends.map((s) => s.bookingId).filter((v): v is string => Boolean(v))))
    if (ids.length === 0) return { credits: [], caveat: null }
    const bookings = await prisma.booking.findMany({
      where: { id: { in: ids }, isInternalTest: false, status: { notIn: ['DRAFT', 'PENDING_PAYMENT', 'CANCELLED', 'ARCHIVED'] } },
      select: { id: true, updatedAt: true },
    })
    const recovered = new Set(bookings.map((b) => b.id))
    for (const s of sends) {
      if (s.bookingId && s.sentAt && recovered.has(s.bookingId)) keep(s.bookingId, s.sentAt)
    }
    return {
      credits: Array.from(credits.values()),
      caveat:
        'A recovery credit means the booking left PENDING_PAYMENT after the email was sent. It does not prove the email caused the payment.',
    }
  }

  if (journey === 'quote') {
    const ids = Array.from(new Set(sends.map((s) => s.leadId).filter((v): v is string => Boolean(v))))
    if (ids.length === 0) return { credits: [], caveat: null }
    const leads = await prisma.lead.findMany({
      where: { id: { in: ids }, convertedBookingId: { not: null } },
      select: { id: true, convertedBookingId: true, bookedAt: true },
    })
    const byLead = new Map(leads.map((l) => [l.id, l]))
    for (const s of sends) {
      const lead = s.leadId ? byLead.get(s.leadId) : undefined
      if (!lead?.convertedBookingId || !s.sentAt) continue
      // Rule 2: the conversion must come AFTER the send.
      if (lead.bookedAt && lead.bookedAt < s.sentAt) continue
      keep(lead.convertedBookingId, s.sentAt)
    }
    return { credits: Array.from(credits.values()), caveat: null }
  }

  // post-job: a REPEAT booking by the same customer, created after the ask.
  const emails = Array.from(new Set(sends.map((s) => s.email)))
  const originBookingIds = new Set(sends.map((s) => s.bookingId).filter((v): v is string => Boolean(v)))
  const customers = await prisma.customer.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true },
  })
  if (customers.length === 0) return { credits: [], caveat: null }
  const byEmail = new Map(customers.map((c) => [c.email.toLowerCase(), c.id]))
  const later = await prisma.booking.findMany({
    where: {
      customerId: { in: customers.map((c) => c.id) },
      isInternalTest: false,
      id: { notIn: Array.from(originBookingIds) },
      status: { notIn: ['DRAFT', 'CANCELLED', 'ARCHIVED'] },
    },
    select: { id: true, customerId: true, createdAt: true },
  })
  for (const s of sends) {
    if (!s.sentAt) continue
    const customerId = byEmail.get(s.email.toLowerCase())
    if (!customerId) continue
    for (const b of later) {
      if (b.customerId === customerId && b.createdAt > s.sentAt) keep(b.id, s.sentAt)
    }
  }
  return {
    credits: Array.from(credits.values()),
    caveat: 'A post-move credit is a REPEAT booking by the same customer after the ask — never the move the email was about.',
  }
}

/** Money on a set of bookings: collected revenue + FINALIZED profit only. */
async function moneyFor(bookingIds: string[]): Promise<{
  netCollectedRevenueCents: number
  finalizedNetProfitCents: number
  finalizedMoves: number
  completedMoves: number
  provisionalMoves: number
}> {
  if (bookingIds.length === 0) {
    return { netCollectedRevenueCents: 0, finalizedNetProfitCents: 0, finalizedMoves: 0, completedMoves: 0, provisionalMoves: 0 }
  }

  const [payments, snapshots, completed] = await Promise.all([
    prisma.payment.findMany({
      where: { bookingId: { in: bookingIds }, ...CAPTURED_PAYMENT_WHERE, isInternalTest: false },
      select: {
        amount: true,
        status: true,
        isInternalTest: true,
        refundedAmountCents: true,
        stripeDisputeId: true,
        disputeStatus: true,
        bookingId: true,
      },
    }),
    // CURRENT snapshots only. A superseded snapshot is a previous version of the
    // same move's finances; summing both would double-count the profit.
    prisma.financialSnapshot.findMany({
      where: { bookingId: { in: bookingIds }, supersededAt: null },
      select: { bookingId: true, companyNetProfitCents: true },
    }),
    prisma.booking.count({ where: { id: { in: bookingIds }, status: { in: ['COMPLETED', 'ARCHIVED'] } } }),
  ])

  const netCollectedRevenueCents = payments.reduce((n, p) => n + netCollectedCentsOf(p as unknown as PaymentRow), 0)
  // Defensive: one current snapshot per booking is the invariant, but summing a
  // map keyed by bookingId means a duplicate cannot inflate the total.
  const perBooking = new Map<string, number>()
  for (const s of snapshots) perBooking.set(s.bookingId, s.companyNetProfitCents)
  const finalizedNetProfitCents = Array.from(perBooking.values()).reduce((n, v) => n + v, 0)

  return {
    netCollectedRevenueCents,
    finalizedNetProfitCents,
    finalizedMoves: perBooking.size,
    completedMoves: completed,
    provisionalMoves: Math.max(0, completed - perBooking.size),
  }
}

/** Delivery + engagement counts for one journey. */
async function reachFor(journey: string, since: Date | null) {
  const sendWhere = { journey, isTest: false, ...(since ? { createdAt: { gte: since } } : {}) }
  const [delivered, recipients, events] = await Promise.all([
    prisma.emailSend.count({ where: { ...sendWhere, status: 'delivered' } }),
    prisma.emailSend.findMany({ where: { ...sendWhere, status: 'delivered' }, select: { email: true }, distinct: ['email'] }),
    prisma.emailEvent.groupBy({
      by: ['type'],
      _count: true,
      where: { emailSend: { journey }, ...(since ? { occurredAt: { gte: since } } : {}) },
    }),
  ])
  const byType: Record<string, number> = {}
  for (const e of events) byType[e.type] = e._count
  return {
    delivered,
    recipients: recipients.length,
    confirmed: byType['delivered'] ?? 0,
    opened: byType['opened'] ?? 0,
    clicked: byType['clicked'] ?? 0,
    bounced: byType['bounced'] ?? 0,
    complained: byType['complained'] ?? 0,
    unsubscribed: byType['unsubscribed'] ?? 0,
  }
}

/**
 * The full email → booking → collected revenue → finalized profit table, one
 * row per journey.
 */
export async function attributionByJourney(range: RangeKey = '90d'): Promise<{ rows: AttributionRow[]; error: string | null }> {
  const since = rangeStart(range)
  try {
    const rows = await Promise.all(
      journeyRegistry().map(async (j: JourneyEntry): Promise<AttributionRow> => {
        const reach = await reachFor(j.key, since)
        const base = {
          journey: j.key,
          name: j.name,
          emailClass: j.emailClass,
          enabled: j.enabled,
          ...reach,
        }

        if (!CONVERTING_JOURNEYS.has(j.key)) {
          // Rule 1 — stated, not silently zeroed.
          return {
            ...base,
            bookings: null,
            completedMoves: null,
            finalizedMoves: null,
            netCollectedRevenueCents: 0,
            finalizedNetProfitCents: 0,
            provisionalMoves: 0,
            caveat:
              j.emailClass === 'transactional'
                ? 'Transactional. This email is sent because a booking happened, so it is never credited with causing one.'
                : 'No conversion model defined for this journey.',
          }
        }

        const { credits, caveat } = await creditsFor(j.key, since)
        const money = await moneyFor(credits.map((c) => c.bookingId))
        return {
          ...base,
          bookings: credits.length,
          completedMoves: money.completedMoves,
          finalizedMoves: money.finalizedMoves,
          netCollectedRevenueCents: money.netCollectedRevenueCents,
          finalizedNetProfitCents: money.finalizedNetProfitCents,
          provisionalMoves: money.provisionalMoves,
          caveat:
            money.provisionalMoves > 0
              ? `${money.provisionalMoves} attributed move${money.provisionalMoves === 1 ? '' : 's'} completed but ${money.provisionalMoves === 1 ? 'is' : 'are'} not financially finalized, so ${money.provisionalMoves === 1 ? 'its' : 'their'} profit is not counted here.${caveat ? ' ' + caveat : ''}`
              : caveat,
        }
      })
    )
    return { rows, error: null }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Campaign-level attribution (Stage 3 MarketingCampaign) ──────────────

export type EmailCampaignResult = {
  campaignId: string
  name: string
  sourceKey: string
  status: string
  /** Sends tagged with this campaign in the email ledger. */
  emailsDelivered: number
  clicked: number
  /** Bookings whose Stage 3 attribution names this campaign's sourceKey. */
  bookings: number
  completedMoves: number
  finalizedMoves: number
  netCollectedRevenueCents: number
  finalizedNetProfitCents: number
  spendCents: number
  /** finalized profit − spend. The campaign's contribution. */
  contributionCents: number
  caveat: string | null
}

/**
 * EMAIL campaigns only. A campaign's booking attribution uses the EXISTING
 * Stage 3 source fields — `ownerAssignedSource`, `bookingSource`, `utmCampaign`
 * — so an email campaign is measured on exactly the same evidence as a door
 * hanger, and first-touch is never overwritten by this read.
 */
export async function emailCampaignResults(range: RangeKey = '90d'): Promise<{ rows: EmailCampaignResult[]; error: string | null }> {
  const since = rangeStart(range)
  try {
    const campaigns = await prisma.marketingCampaign.findMany({
      where: { channel: 'EMAIL' },
      include: { spend: { select: { amountCents: true } } },
      orderBy: { createdAt: 'desc' },
    })

    const rows = await Promise.all(
      campaigns.map(async (c): Promise<EmailCampaignResult> => {
        const [emailsDelivered, clickEvents, bookings] = await Promise.all([
          // PREFER THE RELATION, fall back to the legacy string. New campaign
          // sends populate `campaignId`; historical rows only ever had the
          // source-key string, and those were deliberately not backfilled
          // because a string match is not proof of which campaign sent it.
          prisma.emailSend.count({
            where: {
              OR: [{ campaignId: c.id }, { campaignId: null, campaign: c.sourceKey }],
              status: 'delivered',
              isTest: false,
              ...(since ? { createdAt: { gte: since } } : {}),
            },
          }),
          prisma.emailEvent.count({
            where: {
              type: 'clicked',
              emailSend: { OR: [{ campaignId: c.id }, { campaignId: null, campaign: c.sourceKey }], isTest: false },
              ...(since ? { occurredAt: { gte: since } } : {}),
            },
          }),
          prisma.booking.findMany({
            where: {
              isInternalTest: false,
              ...(since ? { createdAt: { gte: since } } : {}),
              OR: [
                { ownerAssignedSource: c.sourceKey },
                { bookingSource: c.sourceKey },
                { utmCampaign: c.sourceKey },
                { source: c.sourceKey },
              ],
            },
            select: { id: true },
          }),
        ])

        const money = await moneyFor(bookings.map((b) => b.id))
        const spendCents = c.spend.reduce((n, s) => n + s.amountCents, 0)

        return {
          campaignId: c.id,
          name: c.name,
          sourceKey: c.sourceKey,
          status: c.status,
          emailsDelivered,
          clicked: clickEvents,
          bookings: bookings.length,
          completedMoves: money.completedMoves,
          finalizedMoves: money.finalizedMoves,
          netCollectedRevenueCents: money.netCollectedRevenueCents,
          finalizedNetProfitCents: money.finalizedNetProfitCents,
          spendCents,
          contributionCents: money.finalizedNetProfitCents - spendCents,
          caveat:
            money.finalizedMoves === 0 && money.completedMoves > 0
              ? `${money.completedMoves} attributed move${money.completedMoves === 1 ? '' : 's'} completed but none are financially finalized, so profit is not yet proven.`
              : money.finalizedMoves === 0
              ? 'No attributed moves have been finalized yet.'
              : null,
        }
      })
    )
    return { rows, error: null }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}
