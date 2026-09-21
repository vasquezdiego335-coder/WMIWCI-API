// ════════════════════════════════════════════════════════════════════════════
//  discord-permission-audit.ts — check the LIVE Discord server against the
//  owner-approved access policy in src/lib/discord-permissions.ts.
//
//  WHY THIS EXISTS. Channel permissions are edited by hand in the Discord UI.
//  One "sync with category" click, or one new channel dropped in the wrong
//  place, and a 📦 Mover can read payments. Run this after ANY change to roles,
//  channels or permissions, and before every crew invite.
//
//  READ-ONLY. Two GET requests (roles, channels). It creates, edits and deletes
//  nothing, and it reads no message.
//
//  SAFETY
//   * The bot token is read from the environment and never printed.
//   * Exit 0 = the server matches the policy. Exit 1 = at least one violation,
//     each printed as persona / channel / problem. Exit 2 = not configured.
//
//  Usage:
//    DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npx tsx scripts/discord-permission-audit.ts
// ════════════════════════════════════════════════════════════════════════════
import 'dotenv/config'
import {
  auditServerPolicy,
  visibleChannelNames,
  type GuildSnapshot,
  type PolicyRoles,
} from '../src/lib/discord-permissions'

const TOKEN = process.env.DISCORD_BOT_TOKEN?.trim()
const GUILD = process.env.DISCORD_GUILD_ID?.trim()

type RawRole = { id: string; name: string; permissions: string; managed?: boolean; tags?: { bot_id?: string } }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${TOKEN}` } })
  if (!res.ok) throw new Error(`Discord ${res.status} on GET ${path}`)
  return (await res.json()) as T
}

async function main(): Promise<number> {
  if (!TOKEN || !GUILD || !/^\d{17,20}$/.test(GUILD)) {
    console.error('DISCORD_BOT_TOKEN and a numeric DISCORD_GUILD_ID are both required')
    return 2
  }

  const rawRoles = await get<RawRole[]>(`/guilds/${GUILD}/roles`)
  const channels = await get<GuildSnapshot['channels']>(`/guilds/${GUILD}/channels`)
  const guild: GuildSnapshot = { id: GUILD, roles: rawRoles, channels }

  // Roles are found by NAME SUFFIX so the emoji prefix can change freely. The
  // bot's role is the integration-managed one Discord created for it.
  const find = (suffix: string): string | undefined => rawRoles.find((r) => r.name.trim().endsWith(suffix))?.id
  const roles = {
    manager: find('Manager'),
    crewLead: find('Crew Lead'),
    mover: find('Mover'),
    bot: rawRoles.find((r) => r.managed && r.tags?.bot_id)?.id,
  }
  const missing = Object.entries(roles).filter(([, id]) => !id).map(([k]) => k)
  if (missing.length) {
    console.error(`cannot find role(s): ${missing.join(', ')} — the policy cannot be evaluated`)
    return 1
  }

  console.log('== what each role can see ==')
  const personas: Array<[string, string[]]> = [
    ['no role (just joined)', []],
    ['📦 Mover', [roles.mover as string]],
    ['🚚 Crew Lead', [roles.crewLead as string]],
    ['🧭 Manager', [roles.manager as string]],
  ]
  for (const [label, held] of personas) {
    console.log(`  ${label.padEnd(24)} ${visibleChannelNames(guild, held).map((n) => '#' + n).join('  ')}`)
  }

  const violations = auditServerPolicy(guild, roles as PolicyRoles)
  console.log('')
  if (violations.length === 0) {
    console.log(`PASS — ${channels.filter((c) => c.type !== 4).length} channels checked, the server matches the access policy.`)
    return 0
  }
  console.log(`FAIL — ${violations.length} violation(s):`)
  for (const v of violations) console.log(`  ${v.persona.padEnd(26)} #${v.channel.padEnd(22)} ${v.problem}`)
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
