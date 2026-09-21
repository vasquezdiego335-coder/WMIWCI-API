// ════════════════════════════════════════════════════════════════════════════
//  booking-cards-sync.ts — ONE living Discord card per booking, per audience.
//  ------------------------------------------------------------------------
//  The cards themselves are pure (job-cards.ts). This file is the half that
//  needs the database and Discord: deciding whether a card should exist,
//  creating it EXACTLY once, and editing it in place afterwards.
//
//      first time a booking qualifies  →  POST the message, store its id
//      every later change              →  PATCH that same message
//
//  WHAT TRIGGERS A SYNC (each enqueues `booking-card-sync` and nothing more):
//    • approveBooking() — AFTER stripe.capture() succeeded and commitApproval()
//      committed. This is the booked moment, and the only thing that can turn a
//      request into "JOB CONFIRMED". checkout.session.completed cannot: for the
//      website's manual-capture checkout it proves an AUTHORIZATION, not money.
//    • declineBooking(), the move-day buttons, crew assignment changes, and the
//      two daily digests (which makes every listed card self-heal twice a day).
//
//  A SYNC READS THE BOOKING AND RENDERS WHAT IS TRUE NOW. The job carries only
//  a booking id — never a status, never an amount — so a delayed, duplicated or
//  retried job can only ever repaint the current truth. That is what makes a
//  replayed Stripe event or a BullMQ retry harmless here.
//
//  EXACTLY-ONCE CREATION is the UNIQUE (booking_id, audience) constraint on
//  booking_discord_cards: the first INSERT wins the right to post; everyone
//  else gets a unique violation and edits instead. A claim whose poster died
//  mid-flight is taken over after CARD_CLAIM_STALE_MS, so a card is never
//  wedged — the same shape as claimDiscordNotification() for deposits.
//
//  NOTHING HERE IS ON A PAYMENT'S CRITICAL PATH. A Discord outage, a missing
//  channel, a missing table: each is logged and reported; none can change a
//  booking or a payment. Secrets are scrubbed by the same scrub() the deposit
//  notice uses, and every request carries allowed_mentions: { parse: [] }.
// ════════════════════════════════════════════════════════════════════════════
import { botLogger } from './logger'
import { postWithRetry, scrub } from './deposit-notify'
import { buildCrewJobCard, buildOwnerJobCard, type CardJson, type JobBookingInput, type JobCardOptions } from './job-cards'

const log = botLogger.child({ mod: 'booking-cards-sync' })

export type CardAudience = 'crew' | 'owner'

/** A claim with no message id older than this belongs to a dead worker. */
export const CARD_CLAIM_STALE_MS = 2 * 60 * 1000

// ── PURE: should this audience have a card right now? ───────────────────────

export type CardAction =
  /** Make sure the card exists and shows the current truth. */
  | 'ensure'
  /** Repaint a card that already exists; never create one. */
  | 'edit-only'
  | 'skip'

/**
 * Decided by BookingStatus alone.
 *
 *  crew   A mover is told about a job only once it IS one. A PENDING_APPROVAL
 *         request is not a job — the $49 is merely authorized and the owner may
 *         still decline — so no crew card is ever CREATED for it.
 *  owner  While PENDING_APPROVAL the request card (with Approve / Deny) owns
 *         the message; this module leaves it alone.
 */
export function planCardSync(status: string | null | undefined): Record<CardAudience, CardAction> {
  switch (status) {
    case 'CONFIRMED':
    case 'SCHEDULED':
    case 'IN_PROGRESS':
    case 'COMPLETED':
      return { crew: 'ensure', owner: 'ensure' }
    case 'ARCHIVED':
    case 'CANCELLED':
      return { crew: 'edit-only', owner: 'edit-only' }
    case 'PENDING_APPROVAL':
      // e.g. a confirmed job the customer rescheduled: an existing crew card
      // must stop saying CONFIRMED, but none is created.
      return { crew: 'edit-only', owner: 'skip' }
    default:
      return { crew: 'skip', owner: 'skip' }
  }
}

// ── Edges (injectable, so every path below runs offline in tests) ───────────

export type CardRow = { channelId: string; messageId: string | null; claimedAt: Date | null }
export type DiscordResult = { ok: boolean; status: number; id?: string | null; error?: string }

export type SyncBooking = JobBookingInput & { discordApprovalMessageId?: string | null }

export interface CardStore {
  find(bookingId: string, audience: CardAudience): Promise<CardRow | null>
  /** INSERT the claim. 'exists' when another job already holds (or held) it. */
  claim(bookingId: string, audience: CardAudience, channelId: string, now: Date): Promise<'won' | 'exists'>
  /** Take over a claim that never produced a message. True when THIS caller won it. */
  takeOverStale(bookingId: string, audience: CardAudience, channelId: string, staleBefore: Date, now: Date): Promise<boolean>
  setMessage(bookingId: string, audience: CardAudience, channelId: string, messageId: string, status: string | null): Promise<void>
  /** Drop a claim that never posted, so a retry can claim again. */
  release(bookingId: string, audience: CardAudience): Promise<void>
  /** Forget a card whose Discord message no longer exists. */
  forget(bookingId: string, audience: CardAudience): Promise<void>
  touch(bookingId: string, audience: CardAudience, status: string | null): Promise<void>
}

export interface CardSyncDeps {
  loadBooking(bookingId: string): Promise<SyncBooking | null>
  extras(booking: SyncBooking): Promise<JobCardOptions>
  store: CardStore
  discord: {
    post(channelId: string, card: CardJson): Promise<DiscordResult>
    edit(channelId: string, messageId: string, card: CardJson): Promise<DiscordResult>
  }
  channels: { crew?: string | null; owner?: string | null }
  now(): Date
}

export type AudienceOutcome =
  | { audience: CardAudience; result: 'created' | 'edited'; messageId: string }
  | { audience: CardAudience; result: 'skipped'; reason: string }
  | { audience: CardAudience; result: 'failed'; error: string }

export type SyncOutcome = { bookingId: string; status: string | null; outcomes: AudienceOutcome[] }

/** Prisma's "table does not exist": the migration has not reached this database yet. */
const isMissingTable = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2021'

/** Discord's "Unknown Message": someone deleted the card by hand. */
const isGone = (r: DiscordResult): boolean => r.status === 404

const render = (audience: CardAudience, booking: SyncBooking, extras: JobCardOptions): CardJson =>
  audience === 'crew' ? buildCrewJobCard(booking, extras) : buildOwnerJobCard(booking, extras)

async function syncAudience(audience: CardAudience, action: CardAction, booking: SyncBooking, extras: JobCardOptions, deps: CardSyncDeps): Promise<AudienceOutcome> {
  if (action === 'skip') return { audience, result: 'skipped', reason: 'status does not call for a card' }
  const card = render(audience, booking, extras)
  const status = booking.status ?? null

  // 1) A card we already own → edit it in place.
  let row: CardRow | null = null
  let tableMissing = false
  try {
    row = await deps.store.find(booking.id, audience)
  } catch (err) {
    if (!isMissingTable(err)) throw err
    tableMissing = true
  }
  if (row?.messageId) {
    const edited = await deps.discord.edit(row.channelId, row.messageId, card)
    if (edited.ok) {
      await deps.store.touch(booking.id, audience, status).catch(() => undefined)
      return { audience, result: 'edited', messageId: row.messageId }
    }
    if (!isGone(edited)) return { audience, result: 'failed', error: edited.error ?? `discord ${edited.status}` }
    await deps.store.forget(booking.id, audience) // deleted by hand — fall through and replace it
    row = null
  }

  // 2) Owner only: the ORIGINAL approval message becomes the job card, so the
  //    owner's channel keeps one message per booking, not two.
  if (audience === 'owner' && !row && booking.discordApprovalMessageId && deps.channels.owner) {
    const edited = await deps.discord.edit(deps.channels.owner, booking.discordApprovalMessageId, card)
    if (edited.ok) return { audience, result: 'edited', messageId: booking.discordApprovalMessageId }
    if (!isGone(edited)) return { audience, result: 'failed', error: edited.error ?? `discord ${edited.status}` }
  }

  // 3) Nothing to edit. Create — if this status is allowed to create at all.
  if (action === 'edit-only') return { audience, result: 'skipped', reason: 'no existing card, and this status never creates one' }
  if (tableMissing) {
    // Without the table a post cannot be recorded, so every later sync would
    // post AGAIN. Refusing is the only safe answer.
    log.warn({ bookingId: booking.id, audience }, 'booking_discord_cards table is missing — apply migration 20260920120000; card NOT posted')
    return { audience, result: 'skipped', reason: 'booking_discord_cards table missing (migration not applied)' }
  }
  const channelId = deps.channels[audience]
  if (!channelId) return { audience, result: 'skipped', reason: `no channel configured for the ${audience} card` }

  const now = deps.now()
  let won = (await deps.store.claim(booking.id, audience, channelId, now)) === 'won'
  if (!won) {
    const current = await deps.store.find(booking.id, audience)
    if (current?.messageId) {
      // Lost the race to a job that has already posted: paint the truth onto ITS message.
      const edited = await deps.discord.edit(current.channelId, current.messageId, card)
      return edited.ok ? { audience, result: 'edited', messageId: current.messageId } : { audience, result: 'failed', error: edited.error ?? `discord ${edited.status}` }
    }
    won = await deps.store.takeOverStale(booking.id, audience, channelId, new Date(now.getTime() - CARD_CLAIM_STALE_MS), now)
    if (!won) return { audience, result: 'skipped', reason: 'another worker is posting this card right now' }
  }

  const posted = await deps.discord.post(channelId, card)
  if (!posted.ok || !posted.id) {
    await deps.store.release(booking.id, audience).catch(() => undefined)
    return { audience, result: 'failed', error: posted.error ?? `discord ${posted.status}` }
  }
  await deps.store.setMessage(booking.id, audience, channelId, posted.id, status)
  return { audience, result: 'created', messageId: posted.id }
}

/**
 * Bring both cards in line with the booking as it is RIGHT NOW. Never throws for
 * a Discord or configuration condition — the caller decides whether a 'failed'
 * outcome is worth a retry.
 */
export async function syncBookingCards(bookingId: string, deps: CardSyncDeps = defaultCardSyncDeps()): Promise<SyncOutcome> {
  const booking = await deps.loadBooking(bookingId)
  if (!booking) return { bookingId, status: null, outcomes: [{ audience: 'crew', result: 'skipped', reason: 'booking not found' }] }

  const plan = planCardSync(booking.status)
  const extras = plan.crew === 'skip' && plan.owner === 'skip' ? {} : await deps.extras(booking).catch(() => ({}))
  const outcomes: AudienceOutcome[] = []
  for (const audience of ['owner', 'crew'] as const) {
    try {
      outcomes.push(await syncAudience(audience, plan[audience], booking, extras, deps))
    } catch (err) {
      outcomes.push({ audience, result: 'failed', error: scrub(err instanceof Error ? err.message : String(err)) })
    }
  }
  log.info({ bookingId, status: booking.status, outcomes: outcomes.map((o) => `${o.audience}:${o.result}`) }, 'booking cards synced')
  return { bookingId, status: booking.status ?? null, outcomes }
}

// ── Enqueue (what every trigger calls) ──────────────────────────────────────

/**
 * Ask the worker to repaint a booking's cards. NEVER throws and is time-boxed:
 * it is called from inside the approval path and Discord's 3-second interaction
 * window, and a Redis stall must not be able to touch either.
 *
 * No custom jobId on purpose. BullMQ silently drops an add whose id matches a
 * retained COMPLETED job, so a deterministic id would make every sync after the
 * first a no-op. Duplicates are harmless instead: a sync only repaints.
 */
export async function queueBookingCardSync(bookingId: string, reason: string): Promise<boolean> {
  try {
    const { discordQueue } = await import('./queues')
    await Promise.race([
      discordQueue.add('booking-card-sync', { type: 'booking-card-sync', bookingId, payload: { reason } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('queue add timed out after 2s')), 2000)),
    ])
    return true
  } catch (err) {
    log.warn({ bookingId, reason, err: scrub(err instanceof Error ? err.message : String(err)) }, 'booking card sync could not be queued (the daily digest will repaint it)')
    return false
  }
}

// ── Production edges ────────────────────────────────────────────────────────

const PLACEHOLDERS = /^(|REPLACE_ME|placeholder)$|REPLACE_ME|^PASTE_/i
const configuredId = (v?: string | null): string | null => {
  const t = (v ?? '').trim()
  return /^\d{17,20}$/.test(t) && !PLACEHOLDERS.test(t) ? t : null
}

async function discordCall(method: 'POST' | 'PATCH', path: string, card: CardJson): Promise<DiscordResult> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  if (!token || PLACEHOLDERS.test(token)) return { ok: false, status: 0, error: 'DISCORD_BOT_TOKEN is not configured' }
  const r = await postWithRetry(() =>
    fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
      // parse: [] — nothing a customer typed can resolve to a ping, whatever
      // syntax it uses. discordSafe() has already broken the text itself.
      body: JSON.stringify({ embeds: card.embeds, components: card.components, allowed_mentions: { parse: [] } }),
    }),
  )
  return { ok: r.ok, status: r.status, id: (r.body as { id?: string } | null)?.id ?? null, error: r.error }
}

export function defaultCardSyncDeps(): CardSyncDeps {
  return {
    async loadBooking(bookingId) {
      const { prisma } = await import('./db')
      return (await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          customer: { select: { name: true, phone: true, email: true } },
          payments: { where: { status: { in: ['COMPLETED', 'PENDING'] } }, select: { amount: true, status: true, isInternalTest: true, receiptUrl: true } },
          job: {
            select: {
              crewNotes: true,
              staffingReq: { select: { requiredWorkers: true } },
              crew: { select: { assignmentStatus: true, role: true, crewLeader: true, isDriver: true, reportTime: true, user: { select: { name: true } } } },
            },
          },
        },
      })) as SyncBooking | null
    },
    extras: loadJobCardExtras,
    store: prismaCardStore(),
    discord: {
      post: (channelId, card) => discordCall('POST', `/channels/${channelId}/messages`, card),
      edit: (channelId, messageId, card) => discordCall('PATCH', `/channels/${channelId}/messages/${messageId}`, card),
    },
    channels: {
      // DELIBERATELY A NEW VARIABLE, not DISCORD_CHANNEL_JOBS. The code this
      // replaced posted a job card carrying the customer's full name, phone,
      // street addresses and labor price to DISCORD_CHANNEL_JOBS, so that
      // variable could not point at a crew-visible channel until the old code
      // was gone — and any crew card created in the gap would have been recorded
      // in the old (archived) channel and edited there forever. A variable only
      // this code reads removes both problems: until it is set, crew cards are
      // SKIPPED (never misplaced); once set, the next sync creates them here.
      crew: configuredId(process.env.DISCORD_CHANNEL_JOB_DATA),
      owner: configuredId(process.env.DISCORD_CHANNEL_SCHEDULING),
    },
    now: () => new Date(),
  }
}

function prismaCardStore(): CardStore {
  const where = (bookingId: string, audience: CardAudience) => ({ bookingId_audience: { bookingId, audience } })
  return {
    async find(bookingId, audience) {
      const { prisma } = await import('./db')
      return prisma.bookingDiscordCard.findUnique({ where: where(bookingId, audience), select: { channelId: true, messageId: true, claimedAt: true } })
    },
    async claim(bookingId, audience, channelId, now) {
      const { prisma } = await import('./db')
      try {
        await prisma.bookingDiscordCard.create({ data: { bookingId, audience, channelId, claimedAt: now } })
        return 'won'
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') return 'exists'
        throw err
      }
    },
    async takeOverStale(bookingId, audience, channelId, staleBefore, now) {
      const { prisma } = await import('./db')
      const r = await prisma.bookingDiscordCard.updateMany({
        where: { bookingId, audience, messageId: null, OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }] },
        data: { claimedAt: now, channelId },
      })
      return r.count > 0
    },
    async setMessage(bookingId, audience, channelId, messageId, status) {
      const { prisma } = await import('./db')
      await prisma.bookingDiscordCard.update({ where: where(bookingId, audience), data: { channelId, messageId, lastStatus: status } })
    },
    async release(bookingId, audience) {
      const { prisma } = await import('./db')
      await prisma.bookingDiscordCard.deleteMany({ where: { bookingId, audience, messageId: null } })
    },
    async forget(bookingId, audience) {
      const { prisma } = await import('./db')
      await prisma.bookingDiscordCard.deleteMany({ where: { bookingId, audience } })
    },
    async touch(bookingId, audience, status) {
      const { prisma } = await import('./db')
      await prisma.bookingDiscordCard.updateMany({ where: { bookingId, audience }, data: { lastStatus: status } })
    },
  }
}

/**
 * Who pressed Start / Complete, and the waiting FEE line (owner card only).
 * Shared with the interactions route so a button press and a queued sync paint
 * the same card.
 */
export async function loadJobCardExtras(booking: SyncBooking): Promise<JobCardOptions> {
  const { prisma } = await import('./db')
  const { timeOfDay } = await import('./booking-display')
  const out: JobCardOptions = {}
  const appUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '')
  if (appUrl) out.adminUrl = `${appUrl}/admin/bookings`

  const rows = await prisma.auditLog
    .findMany({
      where: { bookingId: booking.id, action: { in: ['JOB_STARTED', 'JOB_COMPLETED', 'PAYMENT_RECEIVED', 'BOOKING_STATE_CHANGED'] } },
      orderBy: { createdAt: 'asc' },
    })
    .catch(() => [])
  for (const row of rows) {
    const details = (row.details ?? {}) as Record<string, unknown>
    // Who decided. approveBooking()/declineBooking() write these; two owners
    // share the channel, so "who approved this?" must survive the repaint.
    if (details.event === 'approve_booking' && typeof details.approvedBy === 'string') out.decisionLine = `Approved by ${details.approvedBy}`
    if (details.event === 'decline_booking' && typeof details.deniedBy === 'string') out.decisionLine = `Declined by ${details.deniedBy}`
    const by = typeof details.by === 'string' ? details.by : 'crew'
    if (row.action === 'JOB_STARTED' && !out.startedBy) {
      out.startedBy = by
      out.startedAtLabel = timeOfDay(row.createdAt)
    }
    if (row.action === 'JOB_COMPLETED') {
      out.completedBy = by
      out.completedAtLabel = timeOfDay(row.createdAt)
    }
  }

  // The fee is money, so it is computed here for the OWNER card and handed to
  // the renderer as an owner-only option; the crew card never receives it.
  try {
    const { resolveWaiting, feeDollars, WAITING_GRACE_MINUTES } = await import('./waiting-time')
    const w = resolveWaiting(booking as never)
    if (w.source !== 'none' && w.totalMinutes > 0) {
      out.waitingFeeLine = w.ongoing
        ? w.billableMinutes > 0
          ? `Waiting ${w.totalMinutes} min — billable, running fee ${feeDollars(w.feeCents)}`
          : `Waiting ${w.totalMinutes} min — within the free ${WAITING_GRACE_MINUTES}-min grace`
        : w.feeCents > 0
          ? `Waited ${w.totalMinutes} min → ${w.billableMinutes} min billable · waiting fee ${feeDollars(w.feeCents)} (move day)`
          : `Waited ${w.totalMinutes} min — within the free ${WAITING_GRACE_MINUTES}-min grace · no fee`
    }
  } catch {
    // Waiting-time is a convenience line; its absence must not cost the card.
  }
  return out
}
