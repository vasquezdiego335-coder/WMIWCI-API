import 'dotenv/config'
import {
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js'
import { botLogger } from '../lib/logger'
import { prisma } from '../lib/db'
import { approvalCardDataFromBooking, buildLeadCard, type LeadCardData } from '../lib/booking-display'
import { completenessLines } from '../lib/booking-completeness'
import { buildBookingRequestCard, buildDailyDigest, type CrewJobView, type DigestSlot } from '../lib/job-cards'
import { TONE, brandFooter } from '../lib/discord-ui'

// ════════════════════════════════════════════════════════════════════════
//  Discord REST sender — for the WORKER process (and any non-gateway caller)
//  ----------------------------------------------------------------------
//  Why this exists:
//  `discord-actions.ts` boots a full gateway Client (Client.login) at module
//  load. When the BullMQ worker imported it, the worker process opened a
//  SECOND gateway session on the same token → "Cannot read properties of
//  undefined (reading 'on')" crash on startup AND constant ECONNRESET /
//  "shard reconnecting" from the duplicate login.
//
//  Posting a card never needs the gateway. This module sends messages over
//  the plain REST API (HTTP) — no Client, no login, no 'on', stateless.
//  The gateway Client stays ONLY in the bot process (src/bot/index.ts),
//  which needs it to RECEIVE slash commands / interactions.
//
//  EXPORTS: postBookingApprovalCard, postFailureAlert, postDailySchedule,
//    postContactMessage, postLeadCard.
//
//  The job card is NOT posted from here any more. It used to go out the moment
//  a $49 hold was AUTHORIZED, labelled "Scheduled". It is now one living card
//  per booking, created only once the booking is CONFIRMED and edited in place
//  afterwards — see src/lib/booking-cards-sync.ts.
// ════════════════════════════════════════════════════════════════════════

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const errStack = (e: unknown): string | undefined => (e instanceof Error ? e.stack : undefined)

const PLACEHOLDER_VALUES = new Set(['', 'REPLACE_ME', 'placeholder'])
const isConfigured = (v?: string): boolean =>
  !!v && !PLACEHOLDER_VALUES.has(v) && !v.includes('REPLACE_ME')

// ── Lazy REST client (no network/login at import; built on first send) ──────
let _rest: REST | null = null
function getRest(): REST | null {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!isConfigured(token)) {
    botLogger.error('✖ DISCORD_BOT_TOKEN missing/placeholder — Discord card NOT posted (REST disabled). Set it in .env.')
    return null
  }
  if ((token as string).split('.').length !== 3) {
    botLogger.error(
      `✖ DISCORD_BOT_TOKEN looks malformed (expected 3 dot-separated parts, got ${(token as string).split('.').length}) — card NOT posted.`
    )
    return null
  }
  if (!_rest) _rest = new REST({ version: '10' }).setToken(token as string)
  return _rest
}

type MessageBody = { embeds?: unknown[]; components?: unknown[]; content?: string; allowed_mentions?: unknown }

// Resolve a channel id from an env key and POST a message via REST.
// Returns the created message ({ id }) or null (never throws → worker-safe).
async function restSendToChannel(envKey: string, body: MessageBody): Promise<{ id: string } | null> {
  const channelId = process.env[envKey]
  if (!isConfigured(channelId)) {
    botLogger.warn({ envKey }, 'Channel not configured — skipping Discord post')
    return null
  }
  const rest = getRest()
  if (!rest) return null
  try {
    const msg = (await rest.post(Routes.channelMessages(channelId as string), { body })) as { id: string }
    botLogger.info({ envKey, channelId, messageId: msg.id }, '✉ Discord message sent (REST)')
    return msg
  } catch (err) {
    botLogger.error({ envKey, channelId, err: errMsg(err), stack: errStack(err) }, '✖ Discord REST post failed')
    return null
  }
}

// Try a list of channel env keys in order; send to the first configured one.
async function restSendFirst(envKeys: string[], body: MessageBody): Promise<{ id: string } | null> {
  for (const key of envKeys) {
    if (isConfigured(process.env[key])) return restSendToChannel(key, body)
  }
  botLogger.error({ envKeys }, '✖ No configured channel — message DROPPED')
  return null
}

// ══════════════════════════════════════════════════════════════════════════
//  1. Booking approval card  (Approve / Offer New Dates / Deny)
// ══════════════════════════════════════════════════════════════════════════
export async function postBookingApprovalCard(
  bookingId: string,
  payload: Record<string, unknown>
): Promise<void> {
  botLogger.info({ bookingId }, '▶ postBookingApprovalCard (REST)')

  // The booking row is the source of truth — load it so BOTH callers (payment
  // fulfillment and the customer reschedule re-post) render the same full card
  // regardless of how thin their queued payload was. A COMPLETED payment (rare
  // at approval time) carries the captured charge + receipt for display.
  const booking = await prisma.booking
    .findUnique({
      where: { id: bookingId },
      include: {
        customer: true,
        // PENDING is loaded alongside COMPLETED so the card can tell an
        // authorized $49 hold apart from a captured one — they mean different
        // things to the balance, and only one of them is money.
        payments: { where: { status: { in: ['COMPLETED', 'PENDING'] } }, orderBy: { createdAt: 'desc' } },
      },
    })
    .catch((err) => {
      botLogger.warn({ bookingId, err: errMsg(err) }, 'approval card: booking load failed — falling back to payload')
      return null
    })

  const photos = await prisma.file
    .findMany({
      where: { bookingId, type: 'PHOTO_BEFORE' },
      select: { cloudinaryUrl: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    })
    .catch(() => [] as { cloudinaryUrl: string }[])
  const photoUrls = photos.map((p) => ({ url: p.cloudinaryUrl }))

  const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
  const adminUrl = `${appUrl}/admin/bookings`
  // The reschedule route prefixes items with a "🔁 RESCHEDULED" marker.
  const rescheduled = typeof payload.items === 'string' && /RESCHEDULED/i.test(payload.items as string)

  const cardData = booking
    ? approvalCardDataFromBooking(booking, {
        photos: photoUrls,
        photoCount: photos.length,
        adminUrl,
        rescheduled,
        stripeChargeId: booking.payments.find((p) => p.status === 'COMPLETED')?.stripeChargeId ?? null,
        receiptUrl: booking.payments.find((p) => p.status === 'COMPLETED')?.receiptUrl ?? null,
        warnings: completenessLines(booking),
      })
    : {
        // Fallback: booking vanished — render whatever the queued payload carried.
        bookingId,
        displayId: (payload.displayId as string) ?? null,
        customerName: (payload.customerName as string) ?? null,
        customerEmail: (payload.customerEmail as string) ?? null,
        customerPhone: (payload.customerPhone as string) ?? null,
        requestedDate: (payload.requestedDate as string) ?? null,
        originAddress: (payload.originAddress as string) ?? null,
        destAddress: (payload.destAddress as string) ?? null,
        rawDescription: (payload.items as string) ?? null,
        moveTotal: typeof payload.moveTotal === 'number' ? (payload.moveTotal as number) : null,
        balanceAfterJob: typeof payload.balanceAfterJob === 'number' ? (payload.balanceAfterJob as number) : null,
        truckAddonDueOnMoveDay: payload.truckAddonDueOnMoveDay === true,
        agreementAccepted: payload.agreementAccepted === true,
        agreementVersion: (payload.agreementVersion as string) ?? null,
        agreementName: (payload.agreementName as string) ?? null,
        rescheduled,
        photos: photoUrls,
        photoCount: photos.length,
        adminUrl,
      }

  // The REQUEST card: the approval body under the shared header, which says
  // what is true at this moment — "$49 authorized · awaiting approval". The
  // website checkout is capture_method 'manual'; nothing has been paid.
  const card = buildBookingRequestCard(cardData)

  const msg = await restSendToChannel('DISCORD_CHANNEL_SCHEDULING', { ...card, allowed_mentions: { parse: [] } })
  if (!msg) return

  await prisma.booking
    .update({ where: { id: bookingId }, data: { discordApprovalMessageId: msg.id } })
    .catch((err) => botLogger.warn({ bookingId, err: errMsg(err) }, 'DB ✗ could not save Discord message ID'))

  botLogger.info({ bookingId, messageId: msg.id }, '✔ Booking approval card posted (REST)')
}

// ══════════════════════════════════════════════════════════════════════════
//  2. Door-hanger discount approval card — REMOVED 2026-07-21 (owner decision).
//     The 30% approval exceeded the 10% public cap in DISCOUNT_POLICY.
// ══════════════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════════════
//  3. "Payment received" alert — RETIRED 2026-09-20.
//     It announced "Deposit Paid — deposit received" for the website's $49,
//     which is an AUTHORIZATION (capture_method 'manual'). Nothing enqueued it;
//     it is removed so the false claim cannot be wired back in by accident.
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
//  4. System failure / error alert
// ══════════════════════════════════════════════════════════════════════════
export async function postFailureAlert(payload: Record<string, unknown>): Promise<void> {
  botLogger.info({ alertType: payload.alertType }, '▶ postFailureAlert (REST)')
  const embed = new EmbedBuilder()
    .setTitle(`🚨 System Alert — ${payload.alertType ?? 'Error'}`)
    .setColor(0xef4444)
    .setDescription((payload.message as string) || 'An unexpected error occurred.')
    .setTimestamp()
  if (payload.bookingId) embed.addFields({ name: 'Booking', value: payload.bookingId as string, inline: true })
  if (payload.error) embed.addFields({ name: 'Error Detail', value: `\`\`\`${String(payload.error).slice(0, 950)}\`\`\`` })
  await restSendFirst(['DISCORD_CHANNEL_ALERTS', 'DISCORD_CHANNEL_SCHEDULING'], { embeds: [embed.toJSON()] })
}

// ══════════════════════════════════════════════════════════════════════════
//  5. Job card — MOVED to src/lib/booking-cards-sync.ts (one living card per
//     booking, crew-safe, created only once the booking is CONFIRMED).
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
//  6. Daily job digests
//     7:00 AM → #today-jobs      (DISCORD_CHANNEL_TODAY_JOBS)
//     7:00 PM → #upcoming-jobs   (DISCORD_CHANNEL_UPCOMING_JOBS)
//     Both are CREW-VISIBLE, so the payload is a list of CrewJobView — a type
//     with nowhere to put a price, a surname, a phone or a street address.
//     The owner's "last activity" telemetry is NOT crew business and goes to the
//     owner channel as its own message.
// ══════════════════════════════════════════════════════════════════════════
export async function postDailySchedule(payload: Record<string, unknown>): Promise<void> {
  botLogger.info({ slot: payload.slot, title: payload.title }, '▶ postDailySchedule (REST)')

  const jobs = Array.isArray(payload.jobs) ? (payload.jobs as Array<Record<string, unknown>>) : []
  // A job queued by the PREVIOUS release carries full names and street
  // addresses. It may only ever reach the owner channel — never a crew one.
  const legacy = typeof payload.slot !== 'string' || jobs.some((j) => 'customerName' in j || 'originAddress' in j)

  if (legacy) {
    const embed = new EmbedBuilder().setTitle((payload.title as string) || 'Daily Schedule').setColor(TONE.info).setTimestamp()
    if (jobs.length === 0) embed.setDescription('No jobs scheduled.')
    for (const job of jobs.slice(0, 20)) {
      embed.addFields({
        name: `${job.displayId ?? ''} — ${job.customerName ?? ''}`.slice(0, 256),
        value: [job.serviceType, job.scheduledTime, job.originAddress || 'Address TBD'].filter(Boolean).join('\n').slice(0, 1024),
        inline: false,
      })
    }
    await restSendToChannel('DISCORD_CHANNEL_SCHEDULING', { embeds: [embed.toJSON()], allowed_mentions: { parse: [] } })
  } else {
    const slot = payload.slot as DigestSlot
    const digest = buildDailyDigest(slot, String(payload.dayLabel ?? ''), jobs as unknown as CrewJobView[])
    // Falls back to the OWNER channel, which is always safe for crew-safe
    // content; the reverse would not be.
    await restSendFirst([slot === 'today' ? 'DISCORD_CHANNEL_TODAY_JOBS' : 'DISCORD_CHANNEL_UPCOMING_JOBS', 'DISCORD_CHANNEL_SCHEDULING'], {
      ...digest,
      allowed_mentions: { parse: [] },
    })
  }

  // Last-activity lines (src/lib/ops-activity.ts) — owner telemetry, owner channel.
  const activity = Array.isArray(payload.activity) ? (payload.activity as unknown[]).map(String) : []
  if (activity.length > 0) {
    await restSendToChannel('DISCORD_CHANNEL_SCHEDULING', {
      embeds: [{ title: 'Last activity', color: TONE.neutral, description: activity.join('\n').slice(0, 2000), footer: brandFooter('Owner snapshot'), timestamp: new Date().toISOString() }],
      allowed_mentions: { parse: [] },
    })
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  7. Contact-form message (informational)
// ══════════════════════════════════════════════════════════════════════════
export async function postContactMessage(payload: Record<string, unknown>): Promise<void> {
  botLogger.info({ payloadKeys: Object.keys(payload) }, '▶ postContactMessage (REST)')
  const langFlag = String(payload.locale) === 'es' ? '🇪🇸 Español' : '🇺🇸 English'
  const embed = new EmbedBuilder()
    .setTitle('✉️ New Contact Message')
    .setColor(0xff5a1f)
    .addFields(
      { name: '👤 From', value: [`**${payload.name}**`, payload.email as string, payload.phone as string].filter(Boolean).join('\n') || '—', inline: true },
      { name: 'ℹ️ Meta', value: [`Lang: ${langFlag}`, `Source: ${payload.source ?? 'direct'}`].join('\n'), inline: true },
      { name: '📌 Subject', value: String(payload.subject || '(no subject)').slice(0, 256) },
      { name: '💬 Message', value: String(payload.message || '—').slice(0, 1024) }
    )
    .setFooter({ text: 'Reply by email or text — customer got an auto-acknowledgement.' })
    .setTimestamp()
  await restSendFirst(['DISCORD_CHANNEL_OPERATIONS', 'DISCORD_CHANNEL_ALERTS', 'DISCORD_CHANNEL_SCHEDULING'], {
    embeds: [embed.toJSON()],
  })
}

// ══════════════════════════════════════════════════════════════════════════
//  New quick-quote lead (informational, owner spec 2026-08-03)
//  The FIRST Discord card that exists before a deposit is paid. Built by the
//  shared prisma-free builder so REST and gateway paths cannot drift.
// ══════════════════════════════════════════════════════════════════════════
export async function postLeadCard(payload: Record<string, unknown>): Promise<boolean> {
  botLogger.info({ leadId: payload.leadId }, 'postLeadCard (REST)')
  const { embeds, components } = buildLeadCard(payload as unknown as LeadCardData)
  // allowed_mentions:{parse:[]} beside discordSafe()'s neutralisation. A lead
  // name is customer-controlled text and NOTHING a customer types may ping.
  const msg = await restSendFirst(
    ['DISCORD_CHANNEL_LEADS', 'DISCORD_CHANNEL_OPERATIONS', 'DISCORD_CHANNEL_ALERTS', 'DISCORD_CHANNEL_SCHEDULING'],
    { embeds, components, allowed_mentions: { parse: [] } }
  )
  // null means "no channel configured" OR "the POST failed" — both mean the
  // owner was not told, so both are a delivery failure.
  return msg !== null
}
