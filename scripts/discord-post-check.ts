// ════════════════════════════════════════════════════════════════════════════
//  discord-post-check.ts — prove the bot can still POST everywhere it needs to.
//
//  WHY THIS EXISTS. The bot ran with Administrator, which bypasses every channel
//  permission — so "it works" proved nothing about the overwrites. Once
//  Administrator is replaced with least privilege (View Channels, Send Messages,
//  Embed Links, Read Message History, Use Application Commands), whether a card
//  reaches #payments depends entirely on that channel's allow-overwrite for the
//  bot. scripts/discord-permission-audit.ts PREDICTS the answer from the
//  permission maths; this script ASKS DISCORD.
//
//  WHAT IT DOES. For each channel the application posts into, it sends one small
//  clearly-labelled check message and deletes it again straight away. Deleting
//  your own message needs no extra permission.
//
//  SAFETY
//   * Channels are found by NAME from the policy list — it cannot post anywhere
//     the application does not already post.
//   * It never reads a message, and never touches a message it did not send.
//   * The bot token is read from the environment and never printed.
//   * Exit 0 = every destination accepted a post. Exit 1 = at least one refused.
//
//  Usage:
//    DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npx tsx scripts/discord-post-check.ts
// ════════════════════════════════════════════════════════════════════════════
import 'dotenv/config'
import { BOT_DESTINATION_CHANNELS, PERMISSION, has } from '../src/lib/discord-permissions'

const TOKEN = process.env.DISCORD_BOT_TOKEN?.trim()
const GUILD = process.env.DISCORD_GUILD_ID?.trim()

type Channel = { id: string; name: string; type: number }
type Role = { id: string; name: string; permissions: string; managed?: boolean; tags?: { bot_id?: string } }

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json }
}

async function main(): Promise<number> {
  if (!TOKEN || !GUILD || !/^\d{17,20}$/.test(GUILD)) {
    console.error('DISCORD_BOT_TOKEN and a numeric DISCORD_GUILD_ID are both required')
    return 2
  }

  const roles = (await call('GET', `/guilds/${GUILD}/roles`)).json as Role[]
  const bot = roles.find((r) => r.managed && r.tags?.bot_id)
  const isAdmin = !!bot && has(BigInt(bot.permissions), PERMISSION.ADMINISTRATOR)
  console.log(`bot role: ${bot?.name ?? '(not found)'} — ${isAdmin ? 'STILL HOLDS ADMINISTRATOR' : 'least privilege'}`)
  if (isAdmin) {
    console.log('  Administrator bypasses channel permissions, so a pass below proves only that Discord is reachable.')
    console.log('  Remove Administrator from the bot role, then run this again for the real answer.')
  }

  const channels = (await call('GET', `/guilds/${GUILD}/channels`)).json as Channel[]
  let failures = 0
  for (const name of BOT_DESTINATION_CHANNELS) {
    const target = channels.find((c) => c.type !== 4 && c.name === name)
    if (!target) {
      console.log(`  ✖ #${name.padEnd(16)} channel not found`)
      failures++
      continue
    }
    const posted = await call('POST', `/channels/${target.id}/messages`, {
      embeds: [{ description: 'Permission check — this message deletes itself.', color: 0x6b7280 }],
      // Silent: a check must not buzz anybody's phone.
      flags: 1 << 12,
      allowed_mentions: { parse: [] },
    })
    const id = (posted.json as { id?: string } | null)?.id
    if (posted.status !== 200 || !id) {
      const why = (posted.json as { message?: string } | null)?.message ?? ''
      console.log(`  ✖ #${name.padEnd(16)} REFUSED — HTTP ${posted.status} ${why}`)
      failures++
      continue
    }
    const removed = await call('DELETE', `/channels/${target.id}/messages/${id}`)
    console.log(`  ✔ #${name.padEnd(16)} posted${removed.status === 204 ? ' and cleaned up' : ` (cleanup returned ${removed.status} — delete it by hand)`}`)
  }

  console.log('')
  if (failures) {
    console.log(`FAIL — ${failures} destination(s) refused the bot. Add a View/Send/Embed/History allow-overwrite for the bot role on each.`)
    return 1
  }
  console.log(isAdmin ? 'PASS (but see the Administrator note above).' : `PASS — the bot posts to all ${BOT_DESTINATION_CHANNELS.length} destinations with least privilege.`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
