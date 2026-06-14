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

const fmtDate = (v: unknown): string =>
  v
    ? new Date(v as string).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'Date TBD'

// ══════════════════════════════════════════════════════════════════════════
//  1. Booking approval card  (Approve / Offer New Dates / Deny)
// ══════════════════════════════════════════════════════════════════════════
export async function postBookingApprovalCard(
  bookingId: string,
  payload: Record<string, unknown>
): Promise<void> {
  botLogger.info({ bookingId }, '▶ postBookingApprovalCard (REST)')

  const agreementValue = payload.agreementAccepted
    ? `✅ Accepted${payload.agreementVersion ? ` (${payload.agreementVersion})` : ''}` +
      (payload.agreementName ? `\nby **${payload.agreementName}**` : '')
    : '⚠️ NOT accepted'

  const money = (n: unknown): string | null =>
    typeof n === 'number' ? `$${n.toLocaleString('en-US')}` : null

  const embed = new EmbedBuilder()
    .setTitle(`📋 New Booking — ${payload.displayId}`)
    .setColor(0xc9a961)
    .addFields(
      {
        name: '👤 Customer',
        value:
          [`**${payload.customerName}**`, payload.customerEmail as string, payload.customerPhone as string]
            .filter(Boolean)
            .join('\n') || '—',
        inline: true,
      },
      {
        name: '📦 Booking',
        value:
          [
            `📅 ${fmtDate(payload.requestedDate)}`,
            payload.amountPaid ? `💳 $${payload.amountPaid} authorized (hold)` : '',
            payload.discountType ? `🏷️ ${payload.discountType}` : '',
          ]
            .filter(Boolean)
            .join('\n') || '—',
        inline: true,
      },
      { name: '📜 Agreement', value: agreementValue, inline: true }
    )
    .setFooter({ text: `Booking ID: ${bookingId}` })
    .setTimestamp()

  const paymentValue =
    [
      '💳 $49 authorized today (hold — captured on approval)',
      money(payload.moveTotal) ? `Move total: ${money(payload.moveTotal)}` : '',
      money(payload.balanceAfterJob) ? `Balance after job: ${money(payload.balanceAfterJob)}` : '',
      payload.truckAddonDueOnMoveDay
        ? `🚚 Truck add-on (move day): ${money(((payload.truckAddonAmount as number) ?? 5000) / 100)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n') || '—'
  embed.addFields({ name: '💰 Payment & Balance', value: paymentValue })
  if (payload.items) embed.addFields({ name: '📝 Details', value: String(payload.items).slice(0, 1024) })

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`approve_booking:${bookingId}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`offer_reschedule:${bookingId}`).setLabel('📅 Offer New Dates').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`deny_booking:${bookingId}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger)
  )

  const msg = await restSendToChannel('DISCORD_CHANNEL_SCHEDULING', {
    embeds: [embed.toJSON()],
    components: [row.toJSON()],
  })
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
//  5. Job-coordination card (Start / Complete / Archive)
// ══════════════════════════════════════════════════════════════════════════
export async function createJobChannels(bookingId: string, payload: Record<string, unknown>): Promise<void> {
  botLogger.info({ bookingId }, '▶ createJobChannels (REST)')
  const embed = new EmbedBuilder()
    .setTitle(`🚛 Job — ${payload.displayId}`)
    .setColor(0x0a1628)
    .addFields(
      {
        name: '👤 Customer',
        value: [`**${payload.customerName}**`, payload.customerEmail as string, payload.customerPhone as string].filter(Boolean).join('\n') || '—',
        inline: true,
      },
      {
        name: '📋 Details',
        value:
          [
            payload.serviceType ? `Service: **${payload.serviceType}**` : '',
            payload.confirmedDate ? `📅 ${payload.confirmedDate}` : '',
            payload.originAddress ? `📍 From: ${payload.originAddress}` : '',
          ]
            .filter(Boolean)
            .join('\n') || '—',
        inline: true,
      }
    )
    .setDescription('Track the job on move day. Mark **Start** when the crew departs, **Complete** when done.')
    .setFooter({ text: `Booking ID: ${bookingId}` })

  // Job details (service, truck, access difficulty, customer notes).
  if (payload.items) embed.addFields({ name: '📝 Job Details', value: String(payload.items).slice(0, 1024) })

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`job_start:${bookingId}`).setLabel('▶️ Start Job').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`job_complete:${bookingId}`).setLabel('✅ Complete').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`archive_job:${bookingId}`).setLabel('🗃️ Archive').setStyle(ButtonStyle.Secondary)
  )
  await restSendToChannel('DISCORD_CHANNEL_JOBS', { embeds: [embed.toJSON()], components: [row.toJSON()] })
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
