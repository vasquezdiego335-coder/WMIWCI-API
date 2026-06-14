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
