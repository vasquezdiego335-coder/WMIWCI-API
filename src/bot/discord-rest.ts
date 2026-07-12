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
import {
  buildJobCard,
  buildBookingApprovalCard,
  approvalCardDataFromBooking,
  serviceLabelFromDescription,
  truckLabelFromDescription,
  TRUCK_OPTION_LABELS,
} from '../lib/booking-display'

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
//  EXPORTS match discord-actions.ts so the worker just swaps the import path:
//    postBookingApprovalCard, postDiscountApprovalCard, postPaymentAlert,
//    postFailureAlert, createJobChannels, postDailySchedule, postContactMessage
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

type MessageBody = { embeds?: unknown[]; components?: unknown[]; content?: string }

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
        payments: { where: { status: 'COMPLETED' }, orderBy: { createdAt: 'desc' }, take: 1 },
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
        stripeChargeId: booking.payments[0]?.stripeChargeId ?? null,
        receiptUrl: booking.payments[0]?.receiptUrl ?? null,
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

  const card = buildBookingApprovalCard(cardData)

  const msg = await restSendToChannel('DISCORD_CHANNEL_SCHEDULING', card)
  if (!msg) return

  await prisma.booking
    .update({ where: { id: bookingId }, data: { discordApprovalMessageId: msg.id } })
    .catch((err) => botLogger.warn({ bookingId, err: errMsg(err) }, 'DB ✗ could not save Discord message ID'))

  botLogger.info({ bookingId, messageId: msg.id }, '✔ Booking approval card posted (REST)')
}

// ══════════════════════════════════════════════════════════════════════════
//  2. Door-hanger discount approval card
// ══════════════════════════════════════════════════════════════════════════
export async function postDiscountApprovalCard(
  bookingId: string,
  payload: Record<string, unknown>
): Promise<void> {
  botLogger.info({ bookingId }, '▶ postDiscountApprovalCard (REST)')
  const embed = new EmbedBuilder()
    .setTitle(`🏷️ Door Hanger Discount Request — ${payload.displayId}`)
    .setColor(0xfbbf24)
    .setDescription('Customer submitted a door hanger code. Approve for **30% off** or deny for **10% first-time fallback**.')
    .addFields(
      { name: '👤 Customer', value: [`**${payload.customerName}**`, payload.customerEmail as string].filter(Boolean).join('\n') || '—', inline: true },
      { name: '🎟️ Code', value: (payload.discountCode as string) || 'N/A', inline: true },
      { name: '📦 Service', value: (payload.serviceType as string) || 'Unknown', inline: true }
    )
    .setFooter({ text: `Booking ID: ${bookingId}` })
    .setTimestamp()

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`approve_discount:${bookingId}`).setLabel('✅ Approve 30%').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`deny_discount:${bookingId}`).setLabel('❌ Deny → 10%').setStyle(ButtonStyle.Danger)
  )
  await restSendToChannel('DISCORD_CHANNEL_SCHEDULING', { embeds: [embed.toJSON()], components: [row.toJSON()] })
}

// ══════════════════════════════════════════════════════════════════════════
//  3. Payment received alert (informational)
// ══════════════════════════════════════════════════════════════════════════
export async function postPaymentAlert(bookingId: string, payload: Record<string, unknown>): Promise<void> {
  botLogger.info({ bookingId }, '▶ postPaymentAlert (REST)')
  const embed = new EmbedBuilder()
    .setTitle(`💳 Deposit Paid — ${payload.displayId}`)
    .setColor(0x22c55e)
    .setDescription('Deposit received. Booking is **PENDING_APPROVAL** — approve or deny using the original card above.')
    .addFields(
      { name: '👤 Customer', value: [`**${payload.customerName}**`, payload.customerEmail as string].filter(Boolean).join('\n') || '—', inline: true },
      { name: '💵 Amount', value: `$${payload.amount ?? 49} deposit`, inline: true },
      { name: '📦 Service', value: (payload.serviceType as string) || 'Unknown', inline: true }
    )
    .setFooter({ text: `Booking ID: ${bookingId}` })
    .setTimestamp()
  await restSendToChannel('DISCORD_CHANNEL_SCHEDULING', { embeds: [embed.toJSON()] })
}

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
//  5. Worker dispatch card — "MOVE DAY JOB" (Start / Complete, links)
//     Built by the shared, tested builder in lib/booking-display.ts so the
//     interactions endpoint re-renders the exact same card on button presses.
//     Worker-facing: human statuses, short ref, no payment breakdown.
// ══════════════════════════════════════════════════════════════════════════
export async function createJobChannels(bookingId: string, payload: Record<string, unknown>): Promise<void> {
  botLogger.info({ bookingId }, '▶ createJobChannels (REST)')

  const items = payload.items ? String(payload.items) : null
  const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'

  const photoCount = await prisma.file
    .count({ where: { bookingId, type: 'PHOTO_BEFORE' } })
    .catch(() => 0)

  const card = buildJobCard({
    bookingId,
    displayId: payload.displayId as string | undefined,
    status: 'CONFIRMED',
    customerName: payload.customerName as string | undefined,
    customerPhone: payload.customerPhone as string | undefined,
    serviceType: serviceLabelFromDescription(items) ?? undefined,
    moveDate: (payload.requestedDate as string | undefined) ?? (payload.confirmedDate as string | undefined),
    originAddress: payload.originAddress as string | undefined,
    destAddress: payload.destAddress as string | undefined,
    truckOptionLabel:
      payload.truckAddonDueOnMoveDay === true
        ? TRUCK_OPTION_LABELS['truck-pickup-return']
        : truckLabelFromDescription(items) ?? undefined,
    rawDescription: items,
    photoCount,
    laborEstimate: typeof payload.laborEstimate === 'number' ? payload.laborEstimate : null,
    travelFeeDollars: typeof payload.travelFeeDollars === 'number' ? payload.travelFeeDollars : null,
    manualReviewRequired: payload.manualReviewRequired === true,
    adminUrl: `${appUrl}/admin/bookings`,
  })

  // Button presses edit the clicked card in place (RES_UPDATE_MESSAGE) and the
  // booking id rides in each button's custom_id, so no message id is persisted.
  await restSendToChannel('DISCORD_CHANNEL_JOBS', card)
}

// ══════════════════════════════════════════════════════════════════════════
//  6. Daily schedule digest
// ══════════════════════════════════════════════════════════════════════════
export async function postDailySchedule(payload: Record<string, unknown>): Promise<void> {
  botLogger.info({ title: payload.title }, '▶ postDailySchedule (REST)')
  type JobSummary = { displayId: string; customerName: string; serviceType: string; scheduledTime: string; originAddress: string }
  const jobs = (payload.jobs as JobSummary[]) ?? []
  const embed = new EmbedBuilder()
    .setTitle((payload.title as string) || '📅 Daily Schedule')
    .setColor(0x0a1628)
    .setTimestamp()
  if (jobs.length === 0) {
    embed.setDescription('No jobs scheduled. 🏖️')
  } else {
    for (const job of jobs) {
      embed.addFields({
        name: `${job.displayId} — ${job.customerName}`,
        value: [`📦 ${job.serviceType}`, `⏰ ${job.scheduledTime}`, `📍 ${job.originAddress || 'Address TBD'}`].join('\n'),
        inline: false,
      })
    }
    embed.setFooter({ text: `${jobs.length} job${jobs.length === 1 ? '' : 's'} scheduled` })
  }
  await restSendToChannel('DISCORD_CHANNEL_SCHEDULING', { embeds: [embed.toJSON()] })
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
