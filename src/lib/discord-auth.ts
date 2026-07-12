import { apiLogger } from './logger'

// ════════════════════════════════════════════════════════════════════════
//  Discord owner authorization — the ONE gate for every privileged action.
//  ----------------------------------------------------------------------
//  A Discord user is an authorized owner when, inside the configured guild,
//  EITHER of these is true:
//    • their user ID is in the env allowlist  (DISCORD_OWNER_USER_IDS)
//    • they hold the configured owner role     (DISCORD_OWNER_ROLE_ID)
//
//  Design rules (see the owner spec):
//    • Never hardcode individual IDs — everything comes from env, so adding an
//      owner/manager is a config change, not a code change.
//    • Prefer Role ID / User ID — never usernames (usernames are mutable and
//      not unique enough to authorize money movement).
//    • Fail CLOSED — any missing/mismatched signal denies the action.
//    • Guild-scoped — an interaction from the wrong server is denied.
//    • Every denial is logged (who / where / why) without leaking the config.
//
//  Backward-compat: the pre-existing DISCORD_USER_DIEGO / DISCORD_USER_SEBASTIAN
//  staff IDs are folded into the allowlist so approvals keep working the moment
//  this ships, before the new env vars are set. They are still ENV-configured,
//  not hardcoded.
// ════════════════════════════════════════════════════════════════════════

const PLACEHOLDER_VALUES = new Set(['', 'REPLACE_ME', 'placeholder'])
const isConfigured = (v?: string | null): v is string =>
  !!v && !PLACEHOLDER_VALUES.has(v) && !v.includes('REPLACE_ME')

/** Parse a comma/space/newline separated list of Discord snowflake IDs. */
function parseIdList(raw?: string | null): string[] {
  if (!isConfigured(raw)) return []
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,25}$/.test(s)) // snowflakes are numeric; drop junk/placeholders
}

/** The configured set of owner user IDs (new allowlist + legacy staff IDs). */
export function ownerUserIds(): Set<string> {
  const ids = [
    ...parseIdList(process.env.DISCORD_OWNER_USER_IDS),
    ...parseIdList(process.env.DISCORD_USER_DIEGO),
    ...parseIdList(process.env.DISCORD_USER_SEBASTIAN),
  ]
  return new Set(ids)
}

/** The configured owner role ID, or null when unset. */
export function ownerRoleId(): string | null {
  const raw = process.env.DISCORD_OWNER_ROLE_ID
  return isConfigured(raw) ? raw.trim() : null
}

export interface DiscordActor {
  userId?: string
  username: string
  roleIds: string[]
  guildId?: string
}

/**
 * Normalize the identity fields out of a raw Discord interaction payload
 * (HTTP interactions endpoint shape). In a guild the member object carries the
 * user + their role IDs; in a DM only `user` is present (no roles).
 */
export function actorFromInteraction(interaction: any): DiscordActor {
  const member = interaction?.member
  const user = member?.user ?? interaction?.user
  const roleIds: string[] = Array.isArray(member?.roles) ? member.roles.map(String) : []
  return {
    userId: user?.id ? String(user.id) : undefined,
    username: user?.global_name ?? user?.username ?? 'unknown',
    roleIds,
    guildId: interaction?.guild_id ? String(interaction.guild_id) : undefined,
  }
}

export interface AuthResult {
  ok: boolean
  actor: DiscordActor
  /** Machine-readable denial reason (never shown to the user). */
  reason?: 'wrong_guild' | 'no_user' | 'not_owner'
}

/**
 * THE authorization check. Every privileged owner action must call this and act
 * only when `ok` is true. Returns the normalized actor either way so callers can
 * log the attempt and name the approver.
 */
export function isAuthorizedOwner(interaction: any): AuthResult {
  const actor = actorFromInteraction(interaction)

  // 1) Correct server. If a guild is configured, the interaction must come from
  //    it (fail closed on mismatch / missing guild — e.g. a DM). If DISCORD_GUILD_ID
  //    isn't configured we don't gate on guild (nothing to compare against).
  const expectedGuild = process.env.DISCORD_GUILD_ID
  if (isConfigured(expectedGuild) && actor.guildId !== expectedGuild.trim()) {
    return { ok: false, actor, reason: 'wrong_guild' }
  }

  // 2) Must resolve to a real user.
  if (!actor.userId) return { ok: false, actor, reason: 'no_user' }

  // 3) Owner by explicit user-ID allowlist …
  if (ownerUserIds().has(actor.userId)) return { ok: true, actor }

  // 4) … or by the owner role.
  const role = ownerRoleId()
  if (role && actor.roleIds.includes(role)) return { ok: true, actor }

  // Fail closed.
  return { ok: false, actor, reason: 'not_owner' }
}

/**
 * Convenience wrapper that also emits the audit-friendly "unauthorized attempt"
 * log line on denial. Returns the same AuthResult.
 */
export function authorizeOwnerAction(interaction: any, action: string): AuthResult {
  const result = isAuthorizedOwner(interaction)
  if (!result.ok) {
    apiLogger.warn(
      {
        action,
        userId: result.actor.userId,
        username: result.actor.username,
        guildId: result.actor.guildId,
        reason: result.reason,
      },
      '🔒 Unauthorized Discord owner action blocked'
    )
  }
  return result
}
