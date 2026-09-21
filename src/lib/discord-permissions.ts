// ════════════════════════════════════════════════════════════════════════════
//  discord-permissions.ts — who can see what in the company Discord server.
//  ------------------------------------------------------------------------
//  PURE. No network, no discord.js, no env. It takes a snapshot of a guild
//  (roles + channels + overwrites) and answers two questions:
//
//    1. effectivePermissions() — what Discord's own algorithm grants a member
//       holding a given set of roles in a given channel.
//    2. auditServerPolicy()    — does the server match the access policy the
//       owner approved on 2026-09-20? Returns every violation, never throws.
//
//  WHY THIS IS CODE AND NOT A CHECKLIST. The 2026-09-20 audit found 39 of 40
//  channels with no permission overwrites at all: anyone invited would have
//  read #profit-tracking, #expenses and #taxes-and-legal. Channel permissions
//  are edited by hand in the Discord UI, where one "sync with category" click
//  silently undoes a restriction. The policy below is therefore asserted two
//  ways from this one module: offline in discord-permissions.test.ts, and
//  against the LIVE server by scripts/discord-permission-audit.ts.
// ════════════════════════════════════════════════════════════════════════════

// The project targets ES2017: the bigint type and BigInt() exist (lib: esnext)
// but bigint LITERALS (1n) do not compile, so bits are built with BigInt().
export const ZERO = BigInt(0)
const bit = (n: number): bigint => BigInt(1) << BigInt(n)

/** The permission bits this module reasons about (Discord API v10). */
export const PERMISSION = {
  CREATE_INSTANT_INVITE: bit(0),
  ADMINISTRATOR: bit(3),
  MANAGE_CHANNELS: bit(4),
  VIEW_CHANNEL: bit(10),
  SEND_MESSAGES: bit(11),
  EMBED_LINKS: bit(14),
  ATTACH_FILES: bit(15),
  READ_MESSAGE_HISTORY: bit(16),
  MENTION_EVERYONE: bit(17),
  USE_APPLICATION_COMMANDS: bit(31),
} as const

const ALL_PERMISSIONS = (bit(53)) - BigInt(1)

export type RoleSnapshot = { id: string; name: string; permissions: string }
/** type 0 = role overwrite, 1 = member overwrite. */
export type OverwriteSnapshot = { id: string; type: number; allow: string; deny: string }
export type ChannelSnapshot = {
  id: string
  name: string
  /** 0 text · 2 voice · 4 category · 5 announcement */
  type: number
  parent_id?: string | null
  permission_overwrites?: OverwriteSnapshot[]
}
export type GuildSnapshot = { id: string; roles: RoleSnapshot[]; channels: ChannelSnapshot[] }

/**
 * Discord's permission algorithm, exactly as documented:
 *   base  = @everyone | every held role          (ADMINISTRATOR ⇒ everything)
 *   then  the channel's @everyone overwrite      (deny, then allow)
 *   then  ALL held-role overwrites together      (union of denies, then union of allows)
 *   then  the member's own overwrite             (deny, then allow)
 *
 * A category's overwrites are NOT consulted: they are a template Discord copies
 * onto a channel when it is "synced", and a channel's own list is what counts.
 * The @everyone role's id is the guild id.
 */
export function effectivePermissions(
  guild: GuildSnapshot,
  channel: ChannelSnapshot,
  roleIds: string[],
  memberId?: string
): bigint {
  const held = new Set([guild.id, ...roleIds])
  let base = ZERO
  for (const role of guild.roles) if (held.has(role.id)) base |= BigInt(role.permissions)
  if (base & PERMISSION.ADMINISTRATOR) return ALL_PERMISSIONS

  const overwrites = channel.permission_overwrites ?? []
  let perms = base

  const everyone = overwrites.find((o) => o.id === guild.id)
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow)

  let allow = ZERO
  let deny = ZERO
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guild.id && held.has(o.id)) {
      allow |= BigInt(o.allow)
      deny |= BigInt(o.deny)
    }
  }
  perms = (perms & ~deny) | allow

  const own = memberId ? overwrites.find((o) => o.type === 1 && o.id === memberId) : undefined
  if (own) perms = (perms & ~BigInt(own.deny)) | BigInt(own.allow)

  // Implicit rule: a channel you cannot view grants you nothing inside it.
  if (!(perms & PERMISSION.VIEW_CHANNEL)) return ZERO
  return perms
}

export const has = (perms: bigint, bit: bigint): boolean => (perms & bit) === bit

/** Names of the non-category channels a holder of `roleIds` can see, sorted. */
export function visibleChannelNames(guild: GuildSnapshot, roleIds: string[]): string[] {
  return guild.channels
    .filter((c) => c.type !== 4 && has(effectivePermissions(guild, c, roleIds), PERMISSION.VIEW_CHANNEL))
    .map((c) => c.name)
    .sort()
}

// ── THE POLICY (owner-approved 2026-09-20) ──────────────────────────────────

export const START_HERE_CHANNELS = ['welcome', 'announcements', 'crew-guide'] as const
/** Bot-fed boards: crew read them, crew do not chat in them. */
export const CREW_BOARD_CHANNELS = ['today-jobs', 'upcoming-jobs', 'job-data'] as const
export const CREW_TALK_CHANNELS = ['crew-chat', 'job-photos'] as const
/** Everything a 📦 Mover or 🚚 Crew Lead may see. NOTHING else, ever. */
export const CREW_CHANNELS = [...START_HERE_CHANNELS, ...CREW_BOARD_CHANNELS, ...CREW_TALK_CHANNELS] as const
/** Owner + 🧭 Manager. Money, customer contact details, alerts. */
export const BUSINESS_CHANNELS = ['bookings', 'payments', 'leads', 'alerts', 'marketing'] as const
/** 👑 Owner only. */
export const MANAGEMENT_CHANNELS = ['admin', 'owner-tasks'] as const
/** Channels the application posts into with its bot token. */
export const BOT_DESTINATION_CHANNELS = [...CREW_BOARD_CHANNELS, 'bookings', 'payments', 'leads', 'alerts', 'marketing'] as const

/**
 * What the bot's own role should hold once Administrator is removed. Channel
 * access on top of this comes from explicit allow-overwrites, because every
 * private category denies @everyone.
 */
export const BOT_LEAST_PRIVILEGE =
  PERMISSION.VIEW_CHANNEL |
  PERMISSION.SEND_MESSAGES |
  PERMISSION.EMBED_LINKS |
  PERMISSION.READ_MESSAGE_HISTORY |
  PERMISSION.USE_APPLICATION_COMMANDS

/** Base permissions no ordinary member may hold: each is a way to widen the server. */
export const FORBIDDEN_FOR_EVERYONE = {
  CREATE_INSTANT_INVITE: PERMISSION.CREATE_INSTANT_INVITE,
  MENTION_EVERYONE: PERMISSION.MENTION_EVERYONE,
  // Slash commands (/job, /stats, /schedule) read booking data; a channel
  // restriction does not stop a command, so the power is withheld at the root.
  USE_APPLICATION_COMMANDS: PERMISSION.USE_APPLICATION_COMMANDS,
  ADMINISTRATOR: PERMISSION.ADMINISTRATOR,
} as const

export type PolicyRoles = { manager: string; crewLead: string; mover: string; bot: string }
export type PolicyViolation = { persona: string; channel: string; problem: string }

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])

/**
 * Check a guild against the policy. Every channel that is not named in a list
 * above is, by definition, ARCHIVE — and must be invisible to every persona
 * that is not the owner. That is what makes a newly added channel fail closed.
 */
export function auditServerPolicy(guild: GuildSnapshot, roles: PolicyRoles): PolicyViolation[] {
  const out: PolicyViolation[] = []
  const byName = (name: string): ChannelSnapshot[] => guild.channels.filter((c) => c.type !== 4 && c.name === name)

  // Every policy channel must exist exactly once: a duplicate name is how the
  // old server ended up with two #deposit channels and nobody sure which was live.
  for (const name of [...CREW_CHANNELS, ...BUSINESS_CHANNELS, ...MANAGEMENT_CHANNELS]) {
    const n = byName(name).length
    if (n !== 1) out.push({ persona: 'server', channel: name, problem: n === 0 ? 'channel is missing' : `${n} channels share this name` })
  }

  const expectView: Array<[string, string[], readonly string[]]> = [
    ['no role (just joined)', [], START_HERE_CHANNELS],
    ['📦 Mover', [roles.mover], CREW_CHANNELS],
    ['🚚 Crew Lead', [roles.crewLead], CREW_CHANNELS],
    ['🧭 Manager', [roles.manager], [...CREW_CHANNELS, ...BUSINESS_CHANNELS]],
  ]
  for (const [persona, held, expected] of expectView) {
    const seen = visibleChannelNames(guild, held)
    if (!sameSet(seen, expected)) {
      for (const extra of seen.filter((n) => !expected.includes(n))) out.push({ persona, channel: extra, problem: 'can SEE a channel the policy hides from them' })
      for (const missing of expected.filter((n) => !seen.includes(n))) out.push({ persona, channel: missing, problem: 'cannot see a channel the policy grants them' })
    }
  }

  // Crew write only where conversation belongs.
  for (const [persona, held] of [['📦 Mover', [roles.mover]], ['🚚 Crew Lead', [roles.crewLead]]] as Array<[string, string[]]>) {
    for (const c of guild.channels.filter((c) => c.type !== 4)) {
      const canSend = has(effectivePermissions(guild, c, held), PERMISSION.SEND_MESSAGES)
      const should = (CREW_TALK_CHANNELS as readonly string[]).includes(c.name)
      if (canSend && !should) out.push({ persona, channel: c.name, problem: 'can POST in a read-only channel' })
      if (!canSend && should) out.push({ persona, channel: c.name, problem: 'cannot post in a crew conversation channel' })
    }
  }

  // No ordinary persona may hold a server-widening power anywhere.
  for (const [persona, held] of [['no role (just joined)', []], ['📦 Mover', [roles.mover]], ['🚚 Crew Lead', [roles.crewLead]], ['🧭 Manager', [roles.manager]]] as Array<[string, string[]]>) {
    let base = ZERO
    for (const r of guild.roles) if (r.id === guild.id || held.includes(r.id)) base |= BigInt(r.permissions)
    for (const [label, bit] of Object.entries(FORBIDDEN_FOR_EVERYONE)) {
      if (has(base, bit)) out.push({ persona, channel: '(server)', problem: `holds ${label}` })
    }
  }

  // The bot must still reach every destination WITHOUT Administrator. This is
  // evaluated against BOT_LEAST_PRIVILEGE rather than the bot role's current
  // bitfield, so it answers "is it safe to remove Administrator?" beforehand.
  const asLeastPrivilege: GuildSnapshot = {
    ...guild,
    roles: guild.roles.map((r) => (r.id === roles.bot ? { ...r, permissions: BOT_LEAST_PRIVILEGE.toString() } : r)),
  }
  const need = PERMISSION.VIEW_CHANNEL | PERMISSION.SEND_MESSAGES | PERMISSION.EMBED_LINKS | PERMISSION.READ_MESSAGE_HISTORY
  for (const name of BOT_DESTINATION_CHANNELS) {
    for (const c of byName(name)) {
      if (!has(effectivePermissions(asLeastPrivilege, c, [roles.bot]), need)) {
        out.push({ persona: '🤖 bot (least privilege)', channel: name, problem: 'could NOT post here once Administrator is removed' })
      }
    }
  }

  return out
}
