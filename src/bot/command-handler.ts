import {
  Collection,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js'
import fs from 'fs'
import path from 'path'

import { ManualEventType } from '@prisma/client'

import { botLogger } from '../lib/logger'
import { prisma } from '../lib/db'

// ════════════════════════════════════════════════════════════════════════
//  Slash command registry + dispatcher
//  ----------------------------------------------------------------------
//  Every command registered in register-commands.ts MUST resolve to a
//  handler here — there is no more "Unknown command". Handlers come from
//  two sources, merged into one Collection:
//    1. File-based commands in ./commands  (e.g. setup_business)
//    2. Inline handlers below              (job, schedule, approve, deny, stats)
// ════════════════════════════════════════════════════════════════════════

export interface CommandModule {
  // file-based commands carry a SlashCommandBuilder under `data`
  data?: { name: string }
  // inline handlers carry a plain `name`
  name?: string
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>
}

export const commands = new Collection<string, CommandModule>()

// ── logging helpers ───────────────────────────────────────────────────────
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const errStack = (e: unknown): string | undefined => (e instanceof Error ? e.stack : undefined)

function serializeOptions(interaction: ChatInputCommandInteraction): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const opt of interaction.options.data) out[opt.name] = opt.value
  return out
}

// Reply without ever throwing "interaction already replied/deferred".
async function respondSafely(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred) {
      await interaction.editReply({ content })
    } else if (interaction.replied) {
      await interaction.followUp({ content, ephemeral: true })
    } else {
      await interaction.reply({ content, ephemeral: true })
    }
  } catch (err) {
    botLogger.error({ err: errMsg(err) }, 'respondSafely → failed to deliver response')
  }
}

const fmtDate = (d?: Date | null): string =>
  d
    ? new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })
    : 'TBD'

// ══════════════════════════════════════════════════════════════════════════
//  1) Load file-based commands from ./commands
// ══════════════════════════════════════════════════════════════════════════
function loadFileCommands(): void {
  const dir = path.join(__dirname, 'commands')
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts'))
  } catch (err) {
    botLogger.warn({ dir, err: errMsg(err) }, 'No ./commands directory — skipping file commands')
    return
  }

  for (const file of files) {
    const filePath = path.join(dir, file)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(filePath) as CommandModule
      const name = mod?.data?.name ?? mod?.name
      if (name && typeof mod.execute === 'function') {
        commands.set(name, mod)
        botLogger.info({ file, command: name }, 'Loaded file command')
      } else {
        botLogger.warn({ file }, '⚠ Command file missing "data"/"name" or "execute" — skipped')
      }
    } catch (err) {
      botLogger.error({ file, err: errMsg(err), stack: errStack(err) }, '✖ Failed to load command file')
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  2) Inline handlers (one per remaining registered command)
// ══════════════════════════════════════════════════════════════════════════

// Build the same Approve/Deny buttons used on the booking card so that
// /approve and /deny route through the REAL approval workflow (the HTTP
// interactions endpoint) instead of duplicating that logic here.
function bookingActionRow(bookingId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`approve_booking:${bookingId}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`deny_booking:${bookingId}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger)
  )
}

// /job id:<bookingId|displayId> — look up and display a booking (read-only)
async function handleJob(interaction: ChatInputCommandInteraction): Promise<void> {
  const id = interaction.options.getString('id', true).trim()
  await interaction.deferReply({ ephemeral: true })

  botLogger.debug({ id }, 'DB → booking.findFirst (/job)')
  const booking = await prisma.booking.findFirst({
    where: { OR: [{ id }, { displayId: id }] },
    include: { customer: true },
  })
  botLogger.debug({ id, found: !!booking }, 'DB ✓ booking.findFirst (/job)')

  if (!booking) {
    await interaction.editReply(`❌ No booking found for \`${id}\`.`)
    return
  }

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${booking.displayId} — ${booking.status}`)
    .setColor(0xff5a1f)
    .addFields(
      { name: '👤 Customer', value: `${booking.customer.name}\n${booking.customer.email}\n${booking.customer.phone}`, inline: true },
      { name: '📅 Requested', value: fmtDate(booking.requestedDate), inline: true },
      { name: '📅 Confirmed', value: fmtDate(booking.confirmedDate), inline: true },
      { name: '📍 Route', value: `${booking.originAddress}\n→ ${booking.destAddress}`, inline: false },
      { name: '📝 Details', value: (booking.itemsDescription ?? '—').slice(0, 1024), inline: false }
    )
    .setFooter({ text: `Booking ID: ${booking.id}` })
    .setTimestamp()

  await interaction.editReply({ embeds: [embed] })
}

// /schedule — today's + tomorrow's confirmed/scheduled jobs (read-only)
async function handleSchedule(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setDate(end.getDate() + 2) // through end of tomorrow

  botLogger.debug({ start, end }, 'DB → booking.findMany (/schedule)')
  const jobs = await prisma.booking.findMany({
    where: { status: { in: ['CONFIRMED', 'SCHEDULED'] }, scheduledStart: { gte: start, lt: end } },
    include: { customer: true },
    orderBy: { scheduledStart: 'asc' },
  })
  botLogger.debug({ count: jobs.length }, 'DB ✓ booking.findMany (/schedule)')

  const embed = new EmbedBuilder().setTitle('📅 Schedule — Today & Tomorrow').setColor(0x0a1628).setTimestamp()
  if (jobs.length === 0) {
    embed.setDescription('No confirmed jobs in the next 48 hours. 🏖️')
  } else {
    for (const j of jobs) {
      embed.addFields({
        name: `${j.displayId} — ${j.customer.name}`,
        value: `⏰ ${fmtDate(j.scheduledStart)}\n📍 ${j.originAddress || 'Address TBD'}`,
        inline: false,
      })
    }
    embed.setFooter({ text: `${jobs.length} job${jobs.length === 1 ? '' : 's'}` })
  }

  await interaction.editReply({ embeds: [embed] })
}

// /approve id:<bookingId|displayId>
// Surfaces the booking + the real Approve/Deny buttons. We intentionally do
// NOT mutate state here: the booking-card buttons run the full workflow
// (scheduling, customer email + SMS, card edit) via the HTTP interactions
// route. Doing a bare status flip here would confirm a job WITHOUT notifying
// the customer — so we route the operator through the proper path instead.
async function handleApprove(interaction: ChatInputCommandInteraction): Promise<void> {
  const id = interaction.options.getString('id', true).trim()
  await interaction.deferReply({ ephemeral: true })

  botLogger.debug({ id }, 'DB → booking.findFirst (/approve)')
  const booking = await prisma.booking.findFirst({
    where: { OR: [{ id }, { displayId: id }] },
    include: { customer: true },
  })
  botLogger.debug({ id, found: !!booking, status: booking?.status }, 'DB ✓ booking.findFirst (/approve)')

  if (!booking) {
    await interaction.editReply(`❌ No booking found for \`${id}\`.`)
    return
  }
  if (booking.status !== 'PENDING_APPROVAL') {
    await interaction.editReply(`⚠️ ${booking.displayId} is **${booking.status}**, not PENDING_APPROVAL.`)
    return
  }

  await interaction.editReply({
    content: `Approve **${booking.displayId}** for ${booking.customer.name}? This sends the customer their confirmation.`,
    components: [bookingActionRow(booking.id)],
  })
}

// /deny id:<bookingId|displayId> reason?:<text> — same routing as /approve
async function handleDeny(interaction: ChatInputCommandInteraction): Promise<void> {
  const id = interaction.options.getString('id', true).trim()
  const reason = interaction.options.getString('reason') ?? undefined
  await interaction.deferReply({ ephemeral: true })

  botLogger.debug({ id, reason }, 'DB → booking.findFirst (/deny)')
  const booking = await prisma.booking.findFirst({
    where: { OR: [{ id }, { displayId: id }] },
    include: { customer: true },
  })
  botLogger.debug({ id, found: !!booking, status: booking?.status }, 'DB ✓ booking.findFirst (/deny)')

  if (!booking) {
    await interaction.editReply(`❌ No booking found for \`${id}\`.`)
    return
  }

  await interaction.editReply({
    content:
      `Deny **${booking.displayId}** for ${booking.customer.name}?` +
      (reason ? `\nReason noted: _${reason}_` : '') +
      '\nUse the button below to send the denial + alternative times.',
    components: [bookingActionRow(booking.id)],
  })
}

// /stats — quick counts for today + this month (read-only)
async function handleStats(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  botLogger.debug('DB → aggregate stats (/stats)')
  const [todayCount, pendingCount, monthCount, monthRevenue] = await Promise.all([
    prisma.booking.count({ where: { createdAt: { gte: dayStart } } }),
    prisma.booking.count({ where: { status: 'PENDING_APPROVAL' } }),
    prisma.booking.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.payment.aggregate({
      where: { status: 'COMPLETED', createdAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
  ])
  botLogger.debug({ todayCount, pendingCount, monthCount }, 'DB ✓ aggregate stats (/stats)')

  const revenue = ((monthRevenue._sum.amount ?? 0) / 100).toFixed(2)

  const embed = new EmbedBuilder()
    .setTitle('📊 Booking Stats')
    .setColor(0x22c55e)
    .addFields(
      { name: 'New bookings today', value: String(todayCount), inline: true },
      { name: 'Pending approval', value: String(pendingCount), inline: true },
      { name: 'Bookings this month', value: String(monthCount), inline: true },
      { name: 'Revenue this month', value: `$${revenue}`, inline: true }
    )
    .setTimestamp()

  await interaction.editReply({ embeds: [embed] })
}

// ══════════════════════════════════════════════════════════════════════════
//  Field logging — /quote /visit /onsite /nobook /jobaccept /followup
//  Each writes one manual_events row (see ManualEvent in schema.prisma) and
//  confirms back ephemerally. All six share one handler factory.
// ══════════════════════════════════════════════════════════════════════════
const EVENT_UI: Record<ManualEventType, { emoji: string; label: string }> = {
  QUOTE: { emoji: '💵', label: 'Quote given' },
  VISIT: { emoji: '🚚', label: 'In-person visit' },
  ONSITE: { emoji: '📍', label: 'Wants on-site quote' },
  NOBOOK: { emoji: '❌', label: 'Did not book' },
  JOBACCEPT: { emoji: '✅', label: 'Job accepted (verbal)' },
  FOLLOWUP: { emoji: '🔁', label: 'Follow-up' },
}

function makeLogHandler(eventType: ManualEventType): CommandModule['execute'] {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const name = interaction.options.getString('name', true).trim()
    const zip = interaction.options.getString('zip', true).trim()
    const job = interaction.options.getString('job')?.trim() || null
    const notes = interaction.options.getString('notes')?.trim() || null
    await interaction.deferReply({ ephemeral: true })

    botLogger.debug({ eventType, zip }, 'DB → manualEvent.create')
    const ev = await prisma.manualEvent.create({
      data: { eventType, customerName: name, zip, jobType: job, notes, loggedBy: interaction.user.tag },
    })
    botLogger.info({ eventType, id: ev.id }, 'DB ✓ manualEvent.create')

    const { emoji, label } = EVENT_UI[eventType]
    const embed = new EmbedBuilder()
      .setTitle(`${emoji} ${label} — logged`)
      .setColor(0xff5a1f)
      .addFields(
        { name: '👤 Customer', value: name, inline: true },
        { name: '📍 ZIP', value: zip, inline: true },
        ...(job ? [{ name: '📦 Job', value: job, inline: true }] : []),
        ...(notes ? [{ name: '📝 Notes', value: notes.slice(0, 1024), inline: false }] : [])
      )
      .setFooter({ text: `Event ID: ${ev.id}` })
      .setTimestamp()

    await interaction.editReply({ embeds: [embed] })
  }
}

// /recent type?:<TYPE> count?:<n> — read the latest field events back (read-only)
async function handleRecent(interaction: ChatInputCommandInteraction): Promise<void> {
  const type = (interaction.options.getString('type') as ManualEventType | null) ?? undefined
  const count = Math.min(Math.max(interaction.options.getInteger('count') ?? 10, 1), 25)
  await interaction.deferReply({ ephemeral: true })

  botLogger.debug({ type, count }, 'DB → manualEvent.findMany (/recent)')
  const events = await prisma.manualEvent.findMany({
    where: type ? { eventType: type } : undefined,
    orderBy: { createdAt: 'desc' },
    take: count,
  })
  botLogger.debug({ found: events.length }, 'DB ✓ manualEvent.findMany (/recent)')

  const embed = new EmbedBuilder().setTitle('🗒️ Recent field events').setColor(0x0a1628).setTimestamp()
  if (events.length === 0) {
    embed.setDescription(type ? `No \`${type}\` events logged yet.` : 'No events logged yet.')
  } else {
    embed.setDescription(
      events
        .map((e) => {
          const ui = EVENT_UI[e.eventType]
          const loc = e.zip ? ` · ${e.zip}` : ''
          const note = e.notes ? ` · ${e.notes}` : ''
          return `${ui.emoji} **${e.customerName ?? '—'}**${loc} _(${ui.label})_${note}\n⏱ ${fmtDate(e.createdAt)}`
        })
        .join('\n')
        .slice(0, 4000)
    )
    embed.setFooter({ text: `${events.length} event${events.length === 1 ? '' : 's'}` })
  }

  await interaction.editReply({ embeds: [embed] })
}

function registerInlineCommand(name: string, execute: CommandModule['execute']): void {
  if (commands.has(name)) {
    botLogger.debug({ command: name }, 'Inline command skipped — already provided by a file command')
    return
  }
  commands.set(name, { name, execute })
  botLogger.info({ command: name }, 'Registered inline command')
}

function registerInlineCommands(): void {
  registerInlineCommand('job', handleJob)
  registerInlineCommand('schedule', handleSchedule)
  registerInlineCommand('approve', handleApprove)
  registerInlineCommand('deny', handleDeny)
  registerInlineCommand('stats', handleStats)

  // Field logging
  registerInlineCommand('quote', makeLogHandler(ManualEventType.QUOTE))
  registerInlineCommand('visit', makeLogHandler(ManualEventType.VISIT))
  registerInlineCommand('onsite', makeLogHandler(ManualEventType.ONSITE))
  registerInlineCommand('nobook', makeLogHandler(ManualEventType.NOBOOK))
  registerInlineCommand('jobaccept', makeLogHandler(ManualEventType.JOBACCEPT))
  registerInlineCommand('followup', makeLogHandler(ManualEventType.FOLLOWUP))
  registerInlineCommand('recent', handleRecent)
}

// ── Build the registry once at module load ────────────────────────────────
loadFileCommands()
registerInlineCommands()
botLogger.info({ count: commands.size, commands: Array.from(commands.keys()) }, '✅ Command registry ready')

// ══════════════════════════════════════════════════════════════════════════
//  Dispatcher — bulletproof, fully logged, with execution timing
// ══════════════════════════════════════════════════════════════════════════
export async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const start = Date.now()
  const ctx = {
    command: interaction.commandName,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    options: serializeOptions(interaction),
  }

  botLogger.info(ctx, '▶ Slash command received')

  const command = commands.get(interaction.commandName)

  // Should never happen now (every registered command has a handler), but if
  // a command is registered with Discord and not wired here, fail loudly + safely.
  if (!command) {
    botLogger.warn({ ...ctx, known: Array.from(commands.keys()) }, '❓ No handler for command')
    await respondSafely(
      interaction,
      `⚠️ \`/${interaction.commandName}\` isn't wired up yet. Ping the dev — this was logged.`
    )
    return
  }

  try {
    botLogger.debug(ctx, '→ executing handler')
    await command.execute(interaction)
    botLogger.info({ ...ctx, ms: Date.now() - start }, '✔ Slash command completed')
  } catch (err) {
    botLogger.error(
      { ...ctx, ms: Date.now() - start, err: errMsg(err), stack: errStack(err) },
      '✖ Slash command threw'
    )
    await respondSafely(interaction, '⚠️ Error executing command. The issue has been logged.')
  }
}
