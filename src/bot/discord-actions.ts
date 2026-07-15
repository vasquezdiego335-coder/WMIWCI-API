import 'dotenv/config'
import {
  Client,
  GatewayIntentBits,
  Events,
  Interaction,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js'

import { botLogger } from '../lib/logger'
import { prisma } from '../lib/db'
import { handleSlashCommand } from './command-handler'
import {
  buildJobCard,
  buildBookingApprovalCard,
  approvalCardDataFromBooking,
  serviceLabelFromDescription,
  truckLabelFromDescription,
  TRUCK_OPTION_LABELS,
} from '../lib/booking-display'

// ════════════════════════════════════════════════════════════════════════
//  We Move It. We Clear It. — Discord bot actions + gateway client
//  ----------------------------------------------------------------------
//  EXPORTS (do not rename — the discord worker imports these by name):
//    getDiscordClient, postBookingApprovalCard, postDiscountApprovalCard,
//    postPaymentAlert, postFailureAlert, createJobChannels, postDailySchedule
//
//  Button business logic (approve/deny/job_start/…) lives in the HTTP
//  interactions endpoint at app/api/discord/interactions/route.ts. When
//  Discord delivers components over the GATEWAY instead (no interactions
//  URL configured), the handler below logs + acknowledges them so the
//  operator is never left with a dead "interaction failed".
// ════════════════════════════════════════════════════════════════════════

// ── Small logging helpers ─────────────────────────────────────────────────
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const errStack = (e: unknown): string | undefined => (e instanceof Error ? e.stack : undefined)

// Values that mean "not configured" so we never try to log in with junk.
const PLACEHOLDER_VALUES = new Set(['', 'REPLACE_ME', 'placeholder'])
const isConfigured = (v?: string): boolean =>
  !!v && !PLACEHOLDER_VALUES.has(v) && !v.includes('REPLACE_ME')

// ── Env presence banner (never prints secret VALUES, only ✓ / ✗) ──────────
const ENV_GROUPS: Record<string, string[]> = {
  Core: ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_GUILD_ID'],
  Channels: [
    'DISCORD_CHANNEL_SCHEDULING',
    'DISCORD_CHANNEL_JOBS',
    'DISCORD_CHANNEL_ALERTS',
    'DISCORD_CHANNEL_OPERATIONS',
    'DISCORD_CHANNEL_PAYMENTS',
    'DISCORD_CHANNEL_RECEIPTS',
    'DISCORD_CHANNEL_PAPERWORK',
    'DISCORD_CHANNEL_PHOTOS',
    'DISCORD_CHANNEL_NEWS',
    'DISCORD_CHANNEL_BOT_LOGS',
  ],
  Staff: ['DISCORD_USER_DIEGO', 'DISCORD_USER_SEBASTIAN'],
  Integrations: ['DATABASE_URL', 'REDIS_URL', 'STRIPE_SECRET_KEY'],
}

function buildEnvSummary(): { loaded: number; total: number; lines: string[] } {
  const lines: string[] = []
  let loaded = 0
  let total = 0
  for (const [group, keys] of Object.entries(ENV_GROUPS)) {
    const marks = keys
      .map((k) => {
        total++
        const ok = isConfigured(process.env[k])
        if (ok) loaded++
        return `   ${ok ? '✓' : '✗'} ${k}`
      })
      .join('\n')
    lines.push(`  ${group}:\n${marks}`)
  }
  return { loaded, total, lines }
}

// ── Startup debug banner (bot username, guild count, env loaded) ───────────
function printStartupBanner(c: Client): void {
  const guilds = c.guilds.cache
  const env = buildEnvSummary()
  const guildList =
    guilds.size === 0
      ? '   (none — invite the bot to a server)'
      : guilds.map((g) => `   • ${g.name} (${g.id}) — ${g.memberCount} members`).join('\n')

  const banner = [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║   WE MOVE IT. WE CLEAR IT. — DISCORD BOT ONLINE                ║',
    '╠══════════════════════════════════════════════════════════════╣',
    `║   Bot:     ${c.user?.tag ?? 'unknown'}`,
    `║   Bot ID:  ${c.user?.id ?? 'unknown'}`,
    `║   Guilds:  ${guilds.size}`,
    `║   Env:     ${env.loaded}/${env.total} variables loaded`,
    `║   Node:    ${process.version} | ${process.env.NODE_ENV ?? 'development'}`,
    '╠══ GUILDS ════════════════════════════════════════════════════╣',
    guildList,
    '╠══ ENVIRONMENT ═══════════════════════════════════════════════╣',
    env.lines.join('\n'),
    '╚══════════════════════════════════════════════════════════════╝',
    '',
  ].join('\n')

  // Human-readable box + structured log line.
  console.log(banner)
  botLogger.info(
    {
      botTag: c.user?.tag,
      botId: c.user?.id,
      guildCount: guilds.size,
      guildIds: Array.from(guilds.keys()),
      envLoaded: env.loaded,
      envTotal: env.total,
    },
    'Discord bot ready — startup banner printed'
  )
}

// ── Singleton Discord client ──────────────────────────────────────────────
let client: Client | null = null

export function getDiscordClient(): Client {
  if (client) {
    botLogger.debug('getDiscordClient() → returning existing singleton')
    return client
  }

  botLogger.debug('getDiscordClient() → creating new Discord client')
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  })

  // ── ready ──
  client.once(Events.ClientReady, (c) => {
    try {
      printStartupBanner(c)
    } catch (err) {
      botLogger.error({ err: errMsg(err), stack: errStack(err) }, 'Failed to print startup banner')
    }
  })

  // ── gateway diagnostics ──
  client.on(Events.Error, (err) => botLogger.error({ err: errMsg(err) }, 'Discord client error'))
  client.on(Events.Warn, (message) => botLogger.warn({ message }, 'Discord client warning'))
  client.on(Events.ShardError, (err) => botLogger.error({ err: errMsg(err) }, 'Discord shard error'))
  client.on(Events.ShardDisconnect, (_e, id) => botLogger.warn({ shardId: id }, 'Discord shard disconnected'))
  client.on(Events.ShardReconnecting, (id) => botLogger.warn({ shardId: id }, 'Discord shard reconnecting'))

  // ── the global interaction entrypoint (wrapped in try/catch below) ──
  client.on(Events.InteractionCreate, onInteractionCreate)

  // ── log in (guarded so a missing/malformed token never crash-loops) ──
  // NOTE: this gateway client lives ONLY in the bot process. The worker posts
  // approval cards over REST (src/bot/discord-rest.ts), so a bad token HERE does
  // NOT block cards — it only disables slash commands / gateway interactions.
  const token = process.env.DISCORD_BOT_TOKEN
  if (!isConfigured(token)) {
    botLogger.error(
      '✖ DISCORD_BOT_TOKEN is missing/placeholder — gateway login SKIPPED. ' +
        'Set a real bot token to enable slash commands (cards still post via REST).'
    )
  } else if ((token as string).split('.').length !== 3) {
    // A real bot token is "<appId>.<timestamp>.<hmac>" — exactly 3 dot-separated
    // parts. A wrong value (client secret, public key, or a truncated paste)
    // makes discord.js throw "Cannot read properties of undefined (reading 'on')"
    // deep in the WebSocket layer. Fail loudly here instead of crash-looping.
    botLogger.error(
      `✖ DISCORD_BOT_TOKEN looks malformed — expected 3 dot-separated parts, got ${(token as string).split('.').length}. ` +
        'Copy the BOT TOKEN (not the client secret / public key) from Discord Developer Portal → Bot. Gateway login SKIPPED.'
    )
  } else {
    botLogger.info('Logging in to Discord gateway…')
    client.login(token).catch((err) =>
      botLogger.error({ err: errMsg(err) }, '✖ Discord login failed — check DISCORD_BOT_TOKEN (regenerate it if needed)')
    )
  }

  return client
}

// ── GLOBAL interaction handler — every interaction passes through here ─────
async function onInteractionCreate(interaction: Interaction): Promise<void> {
  const ctx = {
    interactionId: interaction.id,
    type: interaction.type,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
  }

  botLogger.debug(ctx, '⇢ interactionCreate received')

  // Bulletproof: nothing thrown here can take the bot process down.
  try {
    if (interaction.isChatInputCommand()) {
      botLogger.info({ ...ctx, command: interaction.commandName }, 'Branch: slash command')
      await handleSlashCommand(interaction)
      return
    }

    if (interaction.isButton()) {
      botLogger.info(
        { ...ctx, customId: interaction.customId, messageId: interaction.message?.id },
        'Branch: button press (gateway delivery)'
      )
      // Canonical button logic = app/api/discord/interactions/route.ts (HTTP).
      // If a button arrives here, the gateway is delivering it; acknowledge so
      // the click does not show "interaction failed".
      await interaction
        .reply({
          content:
            '🔘 Button received. Approvals/denials are processed through the web interactions endpoint — ' +
            'if nothing happens, confirm the Interactions Endpoint URL is set in the Discord Developer Portal.',
          ephemeral: true,
        })
        .catch((err) => botLogger.error({ ...ctx, err: errMsg(err) }, 'Button acknowledge failed'))
      return
    }

    if (interaction.isStringSelectMenu()) {
      botLogger.info({ ...ctx, customId: interaction.customId }, 'Branch: select menu (gateway)')
      await interaction
        .reply({ content: '📋 Selection received.', ephemeral: true })
        .catch((err) => botLogger.error({ ...ctx, err: errMsg(err) }, 'Select-menu acknowledge failed'))
      return
    }

    botLogger.debug({ ...ctx }, 'Branch: unhandled interaction type — ignored')
  } catch (err) {
    botLogger.error(
      { ...ctx, err: errMsg(err), stack: errStack(err) },
      '✖ Unhandled error in interactionCreate'
    )
    // Best-effort user-facing error, only if we can still respond.
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Something went wrong handling that.', ephemeral: true })
      }
    } catch (replyErr) {
      botLogger.error({ ...ctx, err: errMsg(replyErr) }, 'Failed to send error reply')
    }
  }
}

// ── Resolve a channel by env key ──────────────────────────────────────────
async function getChannel(envKey: string): Promise<TextChannel | null> {
  const channelId = process.env[envKey]
  if (!isConfigured(channelId)) {
    botLogger.debug({ envKey }, 'getChannel → not configured, returning null')
    return null
  }

  const c = getDiscordClient()
  try {
    botLogger.debug({ envKey, channelId }, 'getChannel → fetching channel')
    const channel = await c.channels.fetch(channelId as string)
    if (!channel) {
      botLogger.warn({ envKey, channelId }, 'getChannel → channel not found')
      return null
    }
    botLogger.debug({ envKey, channelId }, 'getChannel → resolved')
    return channel as TextChannel
  } catch (err) {
    botLogger.error({ envKey, channelId, err: errMsg(err) }, 'getChannel → fetch failed')
    return null
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  1. Booking approval card  (Approve / Deny)
//     Job type: 'booking-created'
// ══════════════════════════════════════════════════════════════════════════
export async function postBookingApprovalCard(
  bookingId: string,
  payload: Record<string, unknown>
): Promise<void> {
  botLogger.info({ bookingId, payloadKeys: Object.keys(payload) }, '▶ postBookingApprovalCard')

  const channel = await getChannel('DISCORD_CHANNEL_SCHEDULING')
  if (!channel) {
    botLogger.warn({ bookingId }, 'Scheduling channel not configured — skipping approval card')
    return
  }

  // Load the booking (source of truth) and render the SHARED premium card so
  // the gateway path is byte-for-byte identical to the REST worker path.
  const booking = await prisma.booking
    .findUnique({
      where: { id: bookingId },
      include: {
        customer: true,
        payments: { where: { status: 'COMPLETED' }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    .catch(() => null)

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
  const rescheduled = typeof payload.items === 'string' && /RESCHEDULED/i.test(payload.items as string)

  const cardData = booking
    ? approvalCardDataFromBooking(booking, {
        photos: photoUrls,
        photoCount: photos.length,
        adminUrl: `${appUrl}/admin/bookings`,
        rescheduled,
        stripeChargeId: booking.payments[0]?.stripeChargeId ?? null,
        receiptUrl: booking.payments[0]?.receiptUrl ?? null,
      })
    : {
        bookingId,
        displayId: (payload.displayId as string) ?? null,
        customerName: (payload.customerName as string) ?? null,
        customerEmail: (payload.customerEmail as string) ?? null,
        customerPhone: (payload.customerPhone as string) ?? null,
        requestedDate: (payload.requestedDate as string) ?? null,
        originAddress: (payload.originAddress as string) ?? null,
        destAddress: (payload.destAddress as string) ?? null,
        rawDescription: (payload.items as string) ?? null,
        agreementAccepted: payload.agreementAccepted === true,
        agreementVersion: (payload.agreementVersion as string) ?? null,
        agreementName: (payload.agreementName as string) ?? null,
        rescheduled,
        photos: photoUrls,
        photoCount: photos.length,
        adminUrl: `${appUrl}/admin/bookings`,
      }

  const card = buildBookingApprovalCard(cardData)

  let msg
  try {
    // channel.send accepts raw API embed/component JSON (what the builder emits).
    msg = await channel.send({ embeds: card.embeds as any, components: card.components as any })
    botLogger.info({ bookingId, messageId: msg.id, channelId: channel.id }, '✉ Booking card sent')
  } catch (err) {
    botLogger.error({ bookingId, err: errMsg(err), stack: errStack(err) }, '✖ Failed to send booking card')
    return
  }

  // Persist message ID so the interactions handler can edit the card in-place.
  botLogger.debug({ bookingId, messageId: msg.id }, 'DB → booking.update (discordApprovalMessageId)')
  await prisma.booking
    .update({ where: { id: bookingId }, data: { discordApprovalMessageId: msg.id } })
    .then(() => botLogger.debug({ bookingId }, 'DB ✓ saved discordApprovalMessageId'))
    .catch((err) =>
      botLogger.warn({ err: errMsg(err), bookingId }, 'DB ✗ could not save Discord message ID')
    )

  botLogger.info({ bookingId, messageId: msg.id }, '✔ Booking approval card posted')
}

// ══════════════════════════════════════════════════════════════════════════
//  2. Door-hanger discount approval card  (Approve 30% / Deny → 10%)
//     Job type: 'discount-request'
// ══════════════════════════════════════════════════════════════════════════
export async function postDiscountApprovalCard(
  bookingId: string,
  payload: Record<string, unknown>
): Promise<void> {
  botLogger.info({ bookingId, payloadKeys: Object.keys(payload) }, '▶ postDiscountApprovalCard')

  const channel = await getChannel('DISCORD_CHANNEL_SCHEDULING')
  if (!channel) {
    botLogger.warn({ bookingId }, 'Scheduling channel not configured — skipping discount card')
    return
  }

  const embed = new EmbedBuilder()
    .setTitle(`🏷️ Door Hanger Discount Request — ${payload.displayId}`)
    .setColor(0xfbbf24) // amber
    .setDescription(
      'Customer submitted a door hanger code. Approve for **30% off** or deny for **10% first-time fallback**.'
    )
    .addFields(
      {
        name: '👤 Customer',
        value: [`**${payload.customerName}**`, payload.customerEmail as string].filter(Boolean).join('\n') || '—',
        inline: true,
      },
      { name: '🎟️ Code', value: (payload.discountCode as string) || 'N/A', inline: true },
      { name: '📦 Service', value: (payload.serviceType as string) || 'Unknown', inline: true }
    )
    .setFooter({ text: `Booking ID: ${bookingId}` })
    .setTimestamp()

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_discount:${bookingId}`)
      .setLabel('✅ Approve 30%')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny_discount:${bookingId}`)
      .setLabel('❌ Deny → 10%')
      .setStyle(ButtonStyle.Danger)
  )

  try {
    const msg = await channel.send({ embeds: [embed], components: [row] })
    botLogger.info({ bookingId, messageId: msg.id }, '✔ Discount approval card posted')
  } catch (err) {
    botLogger.error({ bookingId, err: errMsg(err), stack: errStack(err) }, '✖ Failed to send discount card')
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  3. Payment received alert  (informational — no buttons)
//     Job type: 'payment-received'
// ══════════════════════════════════════════════════════════════════════════
export async function postPaymentAlert(
  bookingId: string,
  payload: Record<string, unknown>
): Promise<void> {
  botLogger.info({ bookingId, payloadKeys: Object.keys(payload) }, '▶ postPaymentAlert')

  const channel = await getChannel('DISCORD_CHANNEL_SCHEDULING')
  if (!channel) {
    botLogger.warn({ bookingId }, 'Scheduling channel not configured — skipping payment alert')
    return
  }

  const embed = new EmbedBuilder()
    .setTitle(`💳 Deposit Paid — ${payload.displayId}`)
    .setColor(0x22c55e) // green
    .setDescription(
      'Deposit received. Booking is **PENDING_APPROVAL** — approve or deny using the original card above.'
    )
    .addFields(
      {
        name: '👤 Customer',
        value: [`**${payload.customerName}**`, payload.customerEmail as string].filter(Boolean).join('\n') || '—',
        inline: true,
      },
      { name: '💵 Amount', value: `$${payload.amount ?? 49} deposit`, inline: true },
      { name: '📦 Service', value: (payload.serviceType as string) || 'Unknown', inline: true }
    )
    .setFooter({ text: `Booking ID: ${bookingId}` })
    .setTimestamp()

  try {
    const msg = await channel.send({ embeds: [embed] })
    botLogger.info({ bookingId, messageId: msg.id }, '✔ Payment alert posted')
  } catch (err) {
    botLogger.error({ bookingId, err: errMsg(err), stack: errStack(err) }, '✖ Failed to send payment alert')
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  4. System failure / error alert
//     Job type: 'failure-alert'  (alerts channel, falls back to scheduling)
// ══════════════════════════════════════════════════════════════════════════
export async function postFailureAlert(payload: Record<string, unknown>): Promise<void> {
  botLogger.info({ payloadKeys: Object.keys(payload), alertType: payload.alertType }, '▶ postFailureAlert')

  const channel =
    (await getChannel('DISCORD_CHANNEL_ALERTS')) ?? (await getChannel('DISCORD_CHANNEL_SCHEDULING'))

  if (!channel) {
    botLogger.error({ payload }, '✖ No Discord channel configured — failure alert DROPPED')
    return
  }

  const embed = new EmbedBuilder()
    .setTitle(`🚨 System Alert — ${payload.alertType ?? 'Error'}`)
    .setColor(0xef4444) // red
    .setDescription((payload.message as string) || 'An unexpected error occurred.')
    .setTimestamp()

  if (payload.bookingId) {
    embed.addFields({ name: 'Booking', value: payload.bookingId as string, inline: true })
  }
  if (payload.error) {
    embed.addFields({ name: 'Error Detail', value: `\`\`\`${String(payload.error).slice(0, 950)}\`\`\`` })
  }

  try {
    const msg = await channel.send({ embeds: [embed] })
    botLogger.info({ alertType: payload.alertType, messageId: msg.id }, '✔ Failure alert posted')
  } catch (err) {
    botLogger.error({ err: errMsg(err), stack: errStack(err) }, '✖ Failed to send failure alert')
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  5. Worker dispatch card — "MOVE DAY JOB" (Start / Complete, links)
//     Job type: 'create-job-channels'
//     Same shared builder as discord-rest.ts so the two transports can't drift.
// ══════════════════════════════════════════════════════════════════════════
export async function createJobChannels(
  bookingId: string,
  payload: Record<string, unknown>
): Promise<void> {
  botLogger.info({ bookingId, payloadKeys: Object.keys(payload) }, '▶ createJobChannels')

  const channel = await getChannel('DISCORD_CHANNEL_JOBS')
  if (!channel) {
    botLogger.warn({ bookingId }, 'Jobs channel not configured — skipping job card creation')
    return
  }

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

  try {
    const msg = await channel.send({ embeds: card.embeds as any, components: card.components as any })
    botLogger.info({ bookingId, messageId: msg.id }, '✔ Job card created')
  } catch (err) {
    botLogger.error({ bookingId, err: errMsg(err), stack: errStack(err) }, '✖ Failed to create job card')
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  6. Daily schedule digest
//     Job type: 'daily-schedule'  (7 AM = today, 7 PM = tomorrow)
// ══════════════════════════════════════════════════════════════════════════
export async function postDailySchedule(payload: Record<string, unknown>): Promise<void> {
  botLogger.info({ payloadKeys: Object.keys(payload), title: payload.title }, '▶ postDailySchedule')

  const channel = await getChannel('DISCORD_CHANNEL_SCHEDULING')
  if (!channel) {
    botLogger.warn('Scheduling channel not configured — skipping daily digest')
    return
  }

  type JobSummary = {
    displayId: string
    customerName: string
    serviceType: string
    scheduledTime: string
    originAddress: string
  }

  const jobs = (payload.jobs as JobSummary[]) ?? []
  const title = (payload.title as string) || '📅 Daily Schedule'

  const embed = new EmbedBuilder().setTitle(title).setColor(0x0a1628).setTimestamp()

  if (jobs.length === 0) {
    botLogger.debug('Daily schedule branch: no jobs')
    embed.setDescription('No jobs scheduled. 🏖️')
  } else {
    botLogger.debug({ count: jobs.length }, 'Daily schedule branch: rendering jobs')
    for (const job of jobs) {
      embed.addFields({
        name: `${job.displayId} — ${job.customerName}`,
        value: [`📦 ${job.serviceType}`, `⏰ ${job.scheduledTime}`, `📍 ${job.originAddress || 'Address TBD'}`].join('\n'),
        inline: false,
      })
    }
    embed.setFooter({ text: `${jobs.length} job${jobs.length === 1 ? '' : 's'} scheduled` })
  }

  try {
    const msg = await channel.send({ embeds: [embed] })
    botLogger.info({ count: jobs.length, title, messageId: msg.id }, '✔ Daily schedule posted')
  } catch (err) {
    botLogger.error({ err: errMsg(err), stack: errStack(err) }, '✖ Failed to post daily schedule')
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  7. Contact-form message  (informational — no buttons)
//     Job type: 'contact-message'  → operations channel, falls back to alerts
// ══════════════════════════════════════════════════════════════════════════
export async function postContactMessage(payload: Record<string, unknown>): Promise<void> {
  botLogger.info({ payloadKeys: Object.keys(payload) }, '▶ postContactMessage')

  const channel =
    (await getChannel('DISCORD_CHANNEL_OPERATIONS')) ??
    (await getChannel('DISCORD_CHANNEL_ALERTS')) ??
    (await getChannel('DISCORD_CHANNEL_SCHEDULING'))

  if (!channel) {
    botLogger.error({ payload }, '✖ No Discord channel configured — contact message DROPPED')
    return
  }

  const langFlag = String(payload.locale) === 'es' ? '🇪🇸 Español' : '🇺🇸 English'

  const embed = new EmbedBuilder()
    .setTitle('✉️ New Contact Message')
    .setColor(0xff5a1f) // brand orange
    .addFields(
      {
        name: '👤 From',
        value:
          [`**${payload.name}**`, payload.email as string, payload.phone as string]
            .filter(Boolean)
            .join('\n') || '—',
        inline: true,
      },
      {
        name: 'ℹ️ Meta',
        value: [
          `Lang: ${langFlag}`,
          `Source: ${payload.source ?? 'direct'}`,
          payload.attribution && payload.attribution !== '—' ? `Ads: ${payload.attribution}` : null,
          payload.landingPage ? `Landing: ${String(payload.landingPage).slice(0, 200)}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        inline: true,
      },
      { name: '📌 Subject', value: String(payload.subject || '(no subject)').slice(0, 256) },
      { name: '💬 Message', value: String(payload.message || '—').slice(0, 1024) }
    )
    .setFooter({ text: 'Reply by email or text — customer got an auto-acknowledgement.' })
    .setTimestamp()

  try {
    const msg = await channel.send({ embeds: [embed] })
    botLogger.info({ messageId: msg.id, channelId: channel.id }, '✔ Contact message posted')
  } catch (err) {
    botLogger.error({ err: errMsg(err), stack: errStack(err) }, '✖ Failed to post contact message')
  }
}

// ── Start the bot (kept from the original; idempotent singleton) ───────────
// The discord worker imports the post* functions above; importing this module
// boots the gateway client so the bot is online to receive slash commands.
getDiscordClient()
