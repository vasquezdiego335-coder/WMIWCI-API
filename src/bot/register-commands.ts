/**
 * Register Discord slash commands with the Discord API.
 * Run once during deployment:
 *   npm run register-commands
 *   (or: npx tsx src/bot/register-commands.ts)
 *
 * Every command registered here MUST have a handler in command-handler.ts.
 */

import 'dotenv/config'
import { REST, Routes, SlashCommandBuilder } from 'discord.js'

const commands = [
  new SlashCommandBuilder()
    .setName('job')
    .setDescription('Look up a booking by ID')
    .addStringOption((opt) => opt.setName('id').setDescription('Booking ID or display ID').setRequired(true)),

  new SlashCommandBuilder().setName('schedule').setDescription("Show today's and tomorrow's jobs"),

  new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Approve a pending booking')
    .addStringOption((opt) => opt.setName('id').setDescription('Booking ID or display ID').setRequired(true)),

  new SlashCommandBuilder()
    .setName('deny')
    .setDescription('Deny a pending booking')
    .addStringOption((opt) => opt.setName('id').setDescription('Booking ID or display ID').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Reason for denial').setRequired(false)),

  new SlashCommandBuilder().setName('stats').setDescription('Show booking stats for today and this month'),

  new SlashCommandBuilder()
    .setName('setup_business')
    .setDescription('Set up all channels and categories for your moving business'),

  // ── Field logging (manual events) — quick to fill from a phone ──
  // Every one shares the same 4 options; only the meaning differs.
  ...(
    [
      ['quote', 'Log a price quote you gave'],
      ['visit', 'Log an in-person visit'],
      ['onsite', 'Log a customer who wants a quote on-site'],
      ['nobook', 'Log a customer who chose not to book'],
      ['jobaccept', 'Log a job accepted by verbal yes'],
      ['followup', 'Log a customer who needs a follow-up'],
    ] as const
  ).map(([name, description]) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .addStringOption((opt) => opt.setName('name').setDescription('Customer name').setRequired(true))
      .addStringOption((opt) => opt.setName('zip').setDescription('5-digit ZIP code').setRequired(true))
      .addStringOption((opt) => opt.setName('job').setDescription('Job type (studio, 1BR, office…)').setRequired(false))
      .addStringOption((opt) => opt.setName('notes').setDescription('Anything worth remembering').setRequired(false))
  ),

  new SlashCommandBuilder()
    .setName('recent')
    .setDescription('Show the last few manually-logged field events')
    .addStringOption((opt) =>
      opt
        .setName('type')
        .setDescription('Filter by type')
        .setRequired(false)
        .addChoices(
          { name: 'quote', value: 'QUOTE' },
          { name: 'visit', value: 'VISIT' },
          { name: 'onsite', value: 'ONSITE' },
          { name: 'nobook', value: 'NOBOOK' },
          { name: 'jobaccept', value: 'JOBACCEPT' },
          { name: 'followup', value: 'FOLLOWUP' }
        )
    )
    .addIntegerOption((opt) =>
      opt.setName('count').setDescription('How many to show (1–25, default 10)').setRequired(false)
    ),

  // ── Owner task board (#owner-tasks) ──
  new SlashCommandBuilder()
    .setName('task_add')
    .setDescription('Add a task to the owner board')
    .addStringOption((o) =>
      o.setName('owner').setDescription('Who owns it').setRequired(true).addChoices(
        { name: 'Diego', value: 'Diego' },
        { name: 'Sebastian', value: 'Sebastian' }
      )
    )
    .addStringOption((o) => o.setName('title').setDescription('Task title').setRequired(true))
    .addStringOption((o) => o.setName('due').setDescription('Due date (2026-06-25, 6/25, "Jun 25", today, tomorrow)').setRequired(true))
    .addIntegerOption((o) =>
      o.setName('importance').setDescription('1–5 (5 = highest)').setRequired(false).setMinValue(1).setMaxValue(5)
    )
    .addStringOption((o) => o.setName('time').setDescription('Due time, optional (9am, 14:30, 9:00 PM)').setRequired(false))
    .addStringOption((o) => o.setName('notes').setDescription('Description / details').setRequired(false)),

  new SlashCommandBuilder()
    .setName('task_list')
    .setDescription('List open tasks (importance → due date → time)')
    .addStringOption((o) =>
      o.setName('owner').setDescription('Filter by owner').setRequired(false).addChoices(
        { name: 'Diego', value: 'Diego' },
        { name: 'Sebastian', value: 'Sebastian' }
      )
    ),

  new SlashCommandBuilder()
    .setName('task_done')
    .setDescription('Mark a task done')
    .addStringOption((o) => o.setName('id').setDescription('Task id (the 6-char code from /task_list)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('task_delete')
    .setDescription('Delete a task')
    .addStringOption((o) => o.setName('id').setDescription('Task id (the 6-char code from /task_list)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('task_edit')
    .setDescription('Edit any field of a task')
    .addStringOption((o) => o.setName('id').setDescription('Task id (the 6-char code from /task_list)').setRequired(true))
    .addStringOption((o) => o.setName('title').setDescription('New title').setRequired(false))
    .addIntegerOption((o) =>
      o.setName('importance').setDescription('New importance 1–5').setRequired(false).setMinValue(1).setMaxValue(5)
    )
    .addStringOption((o) =>
      o.setName('owner').setDescription('Reassign owner').setRequired(false).addChoices(
        { name: 'Diego', value: 'Diego' },
        { name: 'Sebastian', value: 'Sebastian' }
      )
    )
    .addStringOption((o) => o.setName('due').setDescription('New due date').setRequired(false))
    .addStringOption((o) => o.setName('time').setDescription('New due time').setRequired(false))
    .addStringOption((o) => o.setName('notes').setDescription('New description').setRequired(false)),

  new SlashCommandBuilder().setName('task_today').setDescription('Tasks due today'),

  new SlashCommandBuilder().setName('task_overdue').setDescription('Tasks past their due date'),

  new SlashCommandBuilder().setName('task_setup').setDescription('Create the #owner-tasks channel'),
].map((cmd) => cmd.toJSON())

async function registerCommands(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN
  const applicationId = process.env.DISCORD_APPLICATION_ID
  const guildId = process.env.DISCORD_GUILD_ID

  console.log('▶ Registering slash commands:', commands.map((c) => c.name).join(', '))

  if (!token || !applicationId) {
    console.error('✖ Missing DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID in environment')
    process.exit(1)
  }

  const rest = new REST({ version: '10' }).setToken(token)

  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commands })
      console.log(`✓ Registered ${commands.length} commands to guild ${guildId} (instant)`)
    } else {
      await rest.put(Routes.applicationCommands(applicationId), { body: commands })
      console.log(`✓ Registered ${commands.length} GLOBAL commands (can take up to 1 hour to propagate)`)
    }
  } catch (err) {
    console.error('✖ Failed to register commands:', err)
    process.exit(1)
  }
}

registerCommands()
