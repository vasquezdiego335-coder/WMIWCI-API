import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PERMISSION,
  ZERO,
  BOT_LEAST_PRIVILEGE,
  CREW_CHANNELS,
  BUSINESS_CHANNELS,
  MANAGEMENT_CHANNELS,
  START_HERE_CHANNELS,
  auditServerPolicy,
  effectivePermissions,
  has,
  visibleChannelNames,
  type ChannelSnapshot,
  type GuildSnapshot,
  type OverwriteSnapshot,
} from '../discord-permissions'

// ════════════════════════════════════════════════════════════════════════════
//  Who can see what in the company Discord server.
//
//  The fixture below is the server layout the owner approved on 2026-09-20,
//  expressed as the same roles + overwrites the live guild carries. The same
//  auditServerPolicy() runs against the REAL server from
//  scripts/discord-permission-audit.ts, so this file proves the rules and that
//  script proves the server still obeys them.
// ════════════════════════════════════════════════════════════════════════════

const P = PERMISSION
const GUILD = '100'
const OWNER = '201'
const MANAGER = '202'
const LEAD = '203'
const MOVER = '204'
const BOT = '205'
const ROLES = { manager: MANAGER, crewLead: LEAD, mover: MOVER, bot: BOT }

const bits = (...b: bigint[]): string => b.reduce((a, x) => a | x, ZERO).toString()
const ow = (id: string, allow: bigint[], deny: bigint[] = [], type = 0): OverwriteSnapshot => ({ id, type, allow: bits(...allow), deny: bits(...deny) })

const READ = [P.VIEW_CHANNEL, P.READ_MESSAGE_HISTORY]
const TALK = [P.SEND_MESSAGES, P.ATTACH_FILES, P.EMBED_LINKS]
const BOT_POST = [P.VIEW_CHANNEL, P.SEND_MESSAGES, P.EMBED_LINKS, P.READ_MESSAGE_HISTORY]
const HIDDEN = ow(GUILD, [], [P.VIEW_CHANNEL])

const START = [ow(GUILD, READ, [P.SEND_MESSAGES]), ow(MANAGER, [...READ, ...TALK])]
const BOARD = [HIDDEN, ow(MOVER, READ, [P.SEND_MESSAGES]), ow(LEAD, READ, [P.SEND_MESSAGES]), ow(MANAGER, [...READ, ...TALK]), ow(BOT, BOT_POST)]
const CHAT = [HIDDEN, ow(MOVER, [...READ, ...TALK]), ow(LEAD, [...READ, ...TALK]), ow(MANAGER, [...READ, ...TALK]), ow(BOT, BOT_POST)]
const BUSINESS = [HIDDEN, ow(MANAGER, [...READ, ...TALK]), ow(BOT, BOT_POST)]
const MANAGEMENT = [HIDDEN]
const ARCHIVE = [HIDDEN, ow(BOT, BOT_POST)]

let nextId = 1000
const ch = (name: string, permission_overwrites: OverwriteSnapshot[], type = 0): ChannelSnapshot => ({ id: String(nextId++), name, type, parent_id: null, permission_overwrites })

function approvedServer(): GuildSnapshot {
  return {
    id: GUILD,
    roles: [
      // What @everyone holds after the restructure: no invites, no @everyone pings, no slash commands.
      { id: GUILD, name: '@everyone', permissions: bits(P.VIEW_CHANNEL, P.SEND_MESSAGES, P.EMBED_LINKS, P.ATTACH_FILES, P.READ_MESSAGE_HISTORY) },
      { id: OWNER, name: '👑 Owner', permissions: bits(P.ADMINISTRATOR) },
      { id: MANAGER, name: '🧭 Manager', permissions: '0' },
      { id: LEAD, name: '🚚 Crew Lead', permissions: '0' },
      { id: MOVER, name: '📦 Mover', permissions: '0' },
      // The bot still holds Administrator today; the audit simulates it WITHOUT.
      { id: BOT, name: 'Moving Final Bot', permissions: bits(P.ADMINISTRATOR) },
    ],
    channels: [
      ch('welcome', START), ch('announcements', START), ch('crew-guide', START),
      ch('today-jobs', BOARD), ch('upcoming-jobs', BOARD), ch('job-data', BOARD),
      ch('crew-chat', CHAT), ch('job-photos', CHAT),
      ch('bookings', BUSINESS), ch('payments', BUSINESS), ch('leads', BUSINESS), ch('alerts', BUSINESS), ch('marketing', BUSINESS),
      ch('admin', MANAGEMENT), ch('owner-tasks', MANAGEMENT),
      ch('profit-tracking', ARCHIVE), ch('expenses', ARCHIVE), ch('taxes-and-legal', ARCHIVE), ch('General', ARCHIVE, 2),
      ch('🗄 ARCHIVE', [HIDDEN], 4),
    ],
  }
}

const channel = (g: GuildSnapshot, name: string): ChannelSnapshot => g.channels.find((c) => c.name === name) as ChannelSnapshot
const sees = (g: GuildSnapshot, held: string[], name: string): boolean => has(effectivePermissions(g, channel(g, name), held), P.VIEW_CHANNEL)

// ── The approved layout passes ──────────────────────────────────────────────

test('the approved server layout has no policy violations', () => {
  assert.deepEqual(auditServerPolicy(approvedServer(), ROLES), [])
})

// ── 📦 Mover ────────────────────────────────────────────────────────────────

test('a Mover sees exactly the crew channels — and nothing else', () => {
  assert.deepEqual(visibleChannelNames(approvedServer(), [MOVER]), [...CREW_CHANNELS].sort())
})

test('a Mover cannot access Business', () => {
  const g = approvedServer()
  for (const name of BUSINESS_CHANNELS) assert.equal(sees(g, [MOVER], name), false, `a Mover must not see #${name}`)
})

test('a Mover cannot access Management', () => {
  const g = approvedServer()
  for (const name of MANAGEMENT_CHANNELS) assert.equal(sees(g, [MOVER], name), false, `a Mover must not see #${name}`)
})

test('a Mover cannot see archived financial channels', () => {
  const g = approvedServer()
  for (const name of ['profit-tracking', 'expenses', 'taxes-and-legal']) assert.equal(sees(g, [MOVER], name), false, `#${name} must stay hidden`)
})

test('a Mover reads the job boards but can only post in crew-chat and job-photos', () => {
  const g = approvedServer()
  const canPost = (name: string): boolean => has(effectivePermissions(g, channel(g, name), [MOVER]), P.SEND_MESSAGES)
  for (const board of ['today-jobs', 'upcoming-jobs', 'job-data', 'welcome', 'announcements', 'crew-guide']) assert.equal(canPost(board), false, `#${board} is read-only for crew`)
  assert.equal(canPost('crew-chat'), true)
  assert.equal(canPost('job-photos'), true)
})

// ── 🚚 Crew Lead ────────────────────────────────────────────────────────────

test('a Crew Lead sees Start Here and Operations, never Business or Management', () => {
  const g = approvedServer()
  assert.deepEqual(visibleChannelNames(g, [LEAD]), [...CREW_CHANNELS].sort())
  for (const name of [...BUSINESS_CHANNELS, ...MANAGEMENT_CHANNELS]) assert.equal(sees(g, [LEAD], name), false)
})

// ── 🧭 Manager ──────────────────────────────────────────────────────────────

test('a Manager sees Business but NOT the Owner admin channels', () => {
  const g = approvedServer()
  for (const name of BUSINESS_CHANNELS) assert.equal(sees(g, [MANAGER], name), true, `a Manager should see #${name}`)
  for (const name of MANAGEMENT_CHANNELS) assert.equal(sees(g, [MANAGER], name), false, `a Manager must not see #${name}`)
  assert.equal(sees(g, [MANAGER], 'profit-tracking'), false, 'the archive is owner-only')
})

test('the Manager role carries no server-level power: holding it grants no approval or admin ability', () => {
  const g = approvedServer()
  const manager = g.roles.find((r) => r.id === MANAGER)
  assert.equal(manager?.permissions, '0', 'access comes from channel overwrites only; booking approval stays an env allowlist decision')
})

// ── A member with no role yet ───────────────────────────────────────────────

test('someone who just joined, with no role, sees only Start Here', () => {
  assert.deepEqual(visibleChannelNames(approvedServer(), []), [...START_HERE_CHANNELS].sort())
})

// ── 👑 Owner ────────────────────────────────────────────────────────────────

test('the Owner sees every channel', () => {
  const g = approvedServer()
  assert.equal(visibleChannelNames(g, [OWNER]).length, g.channels.filter((c) => c.type !== 4).length)
})

// ── 🤖 The bot, once Administrator is removed ───────────────────────────────

test('the bot can still post to every destination with least privilege instead of Administrator', () => {
  const g = approvedServer()
  g.roles = g.roles.map((r) => (r.id === BOT ? { ...r, permissions: BOT_LEAST_PRIVILEGE.toString() } : r))
  const need = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS | P.READ_MESSAGE_HISTORY
  for (const name of ['today-jobs', 'upcoming-jobs', 'job-data', 'bookings', 'payments', 'leads', 'alerts', 'marketing']) {
    assert.equal(has(effectivePermissions(g, channel(g, name), [BOT]), need), true, `bot must be able to post in #${name}`)
  }
  assert.equal(sees(g, [BOT], 'admin'), false, 'least privilege: the bot has no business in the owner discussion channel')
})

test('the audit catches a private channel that lost its bot overwrite BEFORE Administrator is removed', () => {
  const g = approvedServer()
  channel(g, 'payments').permission_overwrites = [HIDDEN, ow(MANAGER, [...READ, ...TALK])] // bot allow dropped
  const v = auditServerPolicy(g, ROLES)
  assert.ok(v.some((x) => x.channel === 'payments' && /Administrator is removed/.test(x.problem)), 'the deposit card would silently stop posting — this must be flagged')
})

// ── The mistakes this exists to catch ───────────────────────────────────────

test('a Business channel whose overwrites were wiped is reported for every crew persona', () => {
  const g = approvedServer()
  channel(g, 'payments').permission_overwrites = [] // what one careless click in the Discord UI does
  const v = auditServerPolicy(g, ROLES)
  for (const persona of ['no role (just joined)', '📦 Mover', '🚚 Crew Lead']) {
    assert.ok(v.some((x) => x.persona === persona && x.channel === 'payments' && /can SEE/.test(x.problem)), `${persona} seeing #payments must be a violation`)
  }
})

test('a brand-new channel nobody classified fails CLOSED: visible to crew is a violation', () => {
  const g = approvedServer()
  g.channels.push(ch('payroll', []))
  const v = auditServerPolicy(g, ROLES)
  assert.ok(v.some((x) => x.persona === '📦 Mover' && x.channel === 'payroll'))
})

test('two channels with the same policy name are a violation (the old server had two #deposit)', () => {
  const g = approvedServer()
  g.channels.push(ch('payments', BUSINESS))
  assert.ok(auditServerPolicy(g, ROLES).some((x) => x.channel === 'payments' && /share this name/.test(x.problem)))
})

test('a missing policy channel is a violation', () => {
  const g = approvedServer()
  g.channels = g.channels.filter((c) => c.name !== 'job-data')
  assert.ok(auditServerPolicy(g, ROLES).some((x) => x.channel === 'job-data' && /missing/.test(x.problem)))
})

test('@everyone holding slash commands, invites or @everyone pings is a violation', () => {
  for (const [bit, label] of [[P.USE_APPLICATION_COMMANDS, 'USE_APPLICATION_COMMANDS'], [P.CREATE_INSTANT_INVITE, 'CREATE_INSTANT_INVITE'], [P.MENTION_EVERYONE, 'MENTION_EVERYONE']] as Array<[bigint, string]>) {
    const g = approvedServer()
    g.roles[0] = { ...g.roles[0], permissions: (BigInt(g.roles[0].permissions) | bit).toString() }
    assert.ok(auditServerPolicy(g, ROLES).some((x) => x.persona === '📦 Mover' && x.problem === `holds ${label}`), `${label} on @everyone must be flagged`)
  }
})

test('a crew member able to post in a job board is a violation', () => {
  const g = approvedServer()
  channel(g, 'job-data').permission_overwrites = CHAT
  assert.ok(auditServerPolicy(g, ROLES).some((x) => x.persona === '📦 Mover' && x.channel === 'job-data' && /read-only/.test(x.problem)))
})

// ── The algorithm itself ────────────────────────────────────────────────────

test('Administrator bypasses every overwrite', () => {
  const g = approvedServer()
  assert.equal(sees(g, [OWNER], 'admin'), true)
})

test('role overwrites combine: an allow on ANY held role beats a deny on another', () => {
  const g = approvedServer()
  // Mover is denied SEND in #job-data; Manager is allowed it. Someone holding both can post.
  assert.equal(has(effectivePermissions(g, channel(g, 'job-data'), [MOVER, MANAGER]), P.SEND_MESSAGES), true)
})

test('a member overwrite is applied last and wins over role overwrites', () => {
  const g = approvedServer()
  channel(g, 'admin').permission_overwrites = [HIDDEN, ow('999', [P.VIEW_CHANNEL], [], 1)]
  assert.equal(has(effectivePermissions(g, channel(g, 'admin'), [MOVER], '999'), P.VIEW_CHANNEL), true)
  assert.equal(has(effectivePermissions(g, channel(g, 'admin'), [MOVER], '998'), P.VIEW_CHANNEL), false)
})

test('a channel you cannot view grants nothing inside it, whatever else is allowed', () => {
  const g = approvedServer()
  channel(g, 'admin').permission_overwrites = [HIDDEN, ow(MOVER, [P.SEND_MESSAGES])]
  assert.equal(effectivePermissions(g, channel(g, 'admin'), [MOVER]), ZERO)
})

test("a category's own overwrites are never consulted — only the channel's list counts", () => {
  const g = approvedServer()
  const category = channel(g, '🗄 ARCHIVE')
  const orphan = ch('expenses-2', [])
  orphan.parent_id = category.id
  g.channels.push(orphan)
  assert.equal(sees(g, [MOVER], 'expenses-2'), true, 'un-synced channel in a hidden category is VISIBLE — which is exactly why the audit checks channels, not categories')
})
