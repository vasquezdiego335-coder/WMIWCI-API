// ════════════════════════════════════════════════════════════════════════════
//  bot-command-dates.test.ts — ITEM P0-C
//
//  THE DEFECT: `src/bot/command-handler.ts` had ONE date formatter,
//      dateStyle: 'medium', timeStyle: 'short'
//  and pointed it at booking DATE COLUMNS. When the owner books a job on the
//  phone and commits to a DATE rather than an hour, `requestedDate` /
//  `confirmedDate` hold a 00:00 ET DAY ANCHOR — so Discord told Diego the job
//  ran at **12:00 AM**. THREE call sites leaked, not one:
//      /job      "📅 Requested"  (command-handler.ts)
//      /job      "📅 Confirmed"
//      /schedule the "⏰ …" row
//  and the /schedule one was worse than a formatter swap: it coalesced the row
//  to a bare Date (`effectiveMoveDate(j)`) BEFORE rendering, throwing away
//  `startTimeKnown` — the same mistake the admin jobs-list guard already calls
//  "the defect" (day-anchor-display.test.ts, surface 7).
//
//  WHY THREE ROUNDS MISSED IT — the reason this file exists at all:
//    1. R3-1 fixed SEVEN surfaces, and its file list was copied from a contract
//       that only ever named Next.js files. The gateway bot is a separate
//       process (`bot:start`), and the HTTP interactions route explicitly logs
//       "gateway bot owns it" for /job and /schedule.
//    2. Every source guard in day-anchor-display.test.ts hard-codes ONE path
//       through `codeOf(...)`. There is no sweep, so a file outside the seven
//       is structurally invisible.
//    3. Before this file, NO test in the repo referenced `src/bot` at all.
//  So the last test here is a repo-wide SWEEP: the ninth surface must not be
//  able to leak the same way in silence.
//
//  HOW IT TESTS: behaviourally, through the bot's OWN registry — `commands`
//  is driven with a fake interaction and the assertions read the EmbedBuilder
//  output Discord would receive. Nothing is asserted about a formatter in
//  isolation. That is possible because `src/lib/db.ts` is
//  `globalForPrisma.prisma ?? new PrismaClient(...)`, so a fake installed on
//  `globalThis` BEFORE the first repo import is the client the shipped handlers
//  use (pinned in the first test). Every import below is therefore dynamic —
//  `scheduling.ts` imports db.ts too, so a single static repo import at the top
//  of this file would construct a real client and silently test nothing.
//
//  Fixtures are the row the SHIPPED WRITER persists (Method §3): the real zod
//  schema → `recommendEstimate` → `resolveMoveSchedule` → `buildBookingCreateData`
//  on the DEFAULT owner path (deposit `stripe_link`), and the CONFIRMED variants
//  come from the shipped `confirmationScheduleData`. Nothing is hand-shaped.
//
//  Offline: no database, no Discord, no network. Run:
//    npx tsx --test src/lib/__tests__/bot-command-dates.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// ── The fake database, installed FIRST ──────────────────────────────────────
// Nothing above this line may import from '../' — see the header.

type Row = Record<string, unknown>

const db: { bookings: Row[]; events: Row[] } = { bookings: [], events: [] }

const fakePrisma = {
  booking: {
    // The real /job where is `{ OR: [{ id }, { displayId: id }] }`.
    async findFirst(args?: { where?: { OR?: Array<Record<string, unknown>> } }): Promise<Row | null> {
      const wanted = (args?.where?.OR ?? []).map((c) => Object.values(c)[0])
      return db.bookings.find((b) => wanted.includes(b.id) || wanted.includes(b.displayId)) ?? null
    },
    // /schedule's `where` is status + `moveDateInRange`, which is scheduling's
    // own logic and is tested there. What is under test HERE is what the rows
    // RENDER as, so every seeded row is returned.
    async findMany(): Promise<Row[]> {
      return db.bookings
    },
    async count(): Promise<number> {
      return db.bookings.length
    },
  },
  payment: {
    async aggregate(): Promise<{ _sum: { amount: number } }> {
      return { _sum: { amount: 0 } }
    },
  },
  manualEvent: {
    async findMany(): Promise<Row[]> {
      return db.events
    },
    async create(args: { data: Row }): Promise<Row> {
      return { id: 'ev_1', ...args.data }
    },
  },
}

;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma

// ── Modules under test (loaded only AFTER the fake is installed) ────────────

type Mods = {
  adminBooking: typeof import('../admin-booking')
  scheduling: typeof import('../scheduling')
  estimate: typeof import('../estimate')
  assistant: typeof import('../estimate-assistant')
  display: typeof import('../booking-display')
  bot: typeof import('../../bot/command-handler')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    adminBooking: await import('../admin-booking'),
    scheduling: await import('../scheduling'),
    estimate: await import('../estimate'),
    assistant: await import('../estimate-assistant'),
    display: await import('../booking-display'),
    bot: await import('../../bot/command-handler'),
  }
  return mods
}

// ── Clocks ──────────────────────────────────────────────────────────────────

/** Any clock reading at all — stronger than "no AM/PM", so a 24h locale slip
 *  would still fail. Same three probes day-anchor-display.test.ts uses. */
const CLOCK = /\d{1,2}:\d{2}/
const MERIDIEM = /\b[AP]\.?M\.?\b/i
const MIDNIGHT = /12:00\s?[ ]?AM/i

function assertNoTimeOfDay(label: string, rendered: string): void {
  assert.ok(!MIDNIGHT.test(rendered), `${label} printed the day anchor as midnight: ${rendered}`)
  assert.ok(!MERIDIEM.test(rendered), `${label} printed an AM/PM time for a day-level move: ${rendered}`)
  assert.ok(!CLOCK.test(rendered), `${label} printed a clock time for a day-level move: ${rendered}`)
}

/** The WHOLE serialized embed. The embed's own `timestamp` is the render
 *  instant (an ISO string), not the move, so — exactly as the R3-1 whole-card
 *  test does — this checks midnight and AM/PM rather than any-clock. */
function assertNoMidnightAnywhere(label: string, embed: Record<string, unknown>): void {
  const json = JSON.stringify(embed)
  assert.ok(!MIDNIGHT.test(json), `${label} printed midnight somewhere:\n${json}`)
  assert.ok(!MERIDIEM.test(json), `${label} printed an AM/PM time somewhere:\n${json}`)
}

// ── The row the shipped writer persists ─────────────────────────────────────

const EDT_DAY = '2027-07-15' // a Thursday, EDT (UTC-4) → anchor 04:00Z
const EST_DAY = '2027-01-15' // a Friday, EST (UTC-5) → anchor 05:00Z

async function createdRow(over: { startTime?: string; moveDate?: string } = {}): Promise<Row> {
  const m = await load()
  const parsed = m.adminBooking.AdminBookingSchema.safeParse({
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100', email: 'maria@example.com' },
    move: {
      serviceType: '2br',
      moveDate: over.moveDate ?? EDT_DAY,
      // THE DEFAULT: on the phone the owner leaves this blank.
      ...(over.startTime ? { startTime: over.startTime } : {}),
      originAddress: { street: '12 Main St', city: 'Newark', state: 'NJ', zip: '07102' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
    },
    services: { serviceMode: 'full_service' },
    inventory: [],
    deposit: { mode: 'stripe_link' }, // the DEFAULT path → PENDING_PAYMENT
    pricing: { ownerTotal: 700, overrideReason: 'phone quote' },
  })
  assert.ok(parsed.success, `fixture must satisfy the real schema: ${JSON.stringify(parsed.error?.flatten())}`)
  const input = parsed.data

  // The hours the Book Move assistant recommends for THIS payload — derived,
  // never typed in. (A hand-typed hours constant in truck-hold.test.ts is what
  // hid item P0-A behind a green suite.)
  const estimatedHours = m.assistant.recommendEstimate({
    serviceType: input.move.serviceType,
    inventory: [],
  }).estimatedHoursMax

  const schedule = m.adminBooking.resolveMoveSchedule(input.move, {
    estimatedHours,
    helpers: { toInstant: m.scheduling.etDateTimeToInstant, endTime: m.scheduling.calculateEndTime },
  })
  assert.ok(schedule.requestedDate, 'the move date must resolve')

  const data = m.adminBooking.buildBookingCreateData(
    input,
    {
      estimate: m.estimate.computeEstimate({ serviceType: input.move.serviceType, travelFeeCents: 0 }),
      travel: { zone: 'primary', travelFeeCents: 0 },
      reference: 'WMIC-1001',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate,
      schedule,
      estimatedHours,
    },
    [],
  ) as Row

  // The shape a `findFirst({ include: { customer: true } })` returns.
  return {
    id: 'bk_1',
    displayId: 'WMIC-1001',
    status: 'PENDING_APPROVAL',
    requestedDate: data.requestedDate ?? null,
    confirmedDate: data.confirmedDate ?? null,
    scheduledStart: data.scheduledStart ?? null,
    scheduledEnd: data.scheduledEnd ?? null,
    startTimeKnown: data.startTimeKnown,
    estimatedHours,
    originAddress: data.originAddress ?? null,
    destAddress: data.destAddress ?? null,
    itemsDescription: data.itemsDescription ?? null,
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100' },
  }
}

/** The same row after the SHIPPED approval writer confirms it. */
async function confirmedRow(base: Row): Promise<Row> {
  const m = await load()
  const sched = m.scheduling.confirmationScheduleData(base as unknown as Parameters<typeof m.scheduling.confirmationScheduleData>[0])
  assert.ok(sched, 'confirmationScheduleData must produce a schedule for a booking with a date')
  return { ...base, status: 'CONFIRMED', ...sched }
}

// ── A fake slash-command interaction ────────────────────────────────────────

type EmbedLike = { toJSON: () => Record<string, unknown> }
type ReplyPayload = { embeds?: EmbedLike[]; content?: string }

async function runCommand(
  name: string,
  opts: Record<string, string | number> = {},
): Promise<Record<string, unknown>> {
  const m = await load()
  const cmd = m.bot.commands.get(name)
  if (!cmd) assert.fail(`/${name} must be registered — the bot's OWN registry is the surface under test`)

  let captured: ReplyPayload | string | null = null
  const interaction = {
    commandName: name,
    deferred: true,
    replied: false,
    guildId: 'g_1',
    channelId: 'c_1',
    user: { id: 'u_1', tag: 'diego#0001' },
    options: {
      data: [] as unknown[],
      getString: (n: string): string | null => (typeof opts[n] === 'string' ? (opts[n] as string) : null),
      getInteger: (n: string): number | null => (typeof opts[n] === 'number' ? (opts[n] as number) : null),
    },
    async deferReply(): Promise<void> {},
    async editReply(p: ReplyPayload | string): Promise<void> {
      captured = p
    },
    async reply(): Promise<void> {},
    async followUp(): Promise<void> {},
  }

  await cmd.execute(interaction as unknown as Parameters<typeof cmd.execute>[0])

  const payload = captured as ReplyPayload | string | null
  if (payload === null || typeof payload === 'string') {
    assert.fail(`/${name} replied with no embed: ${String(payload)}`)
  }
  const embed = payload.embeds?.[0]
  if (!embed) assert.fail(`/${name} replied without an embed`)
  return embed.toJSON()
}

function fieldValue(embed: Record<string, unknown>, name: string): string {
  const fields = (embed.fields ?? []) as Array<{ name: string; value: string }>
  const found = fields.find((f) => f.name === name)
  if (!found) assert.fail(`no embed field named "${name}" — found: ${fields.map((f) => f.name).join(', ')}`)
  return found.value
}

/** The one job row /schedule rendered. */
function onlyScheduleRow(embed: Record<string, unknown>): string {
  const fields = (embed.fields ?? []) as Array<{ name: string; value: string }>
  assert.equal(fields.length, 1, `expected exactly one job row, got ${fields.length}`)
  return fields[0].value
}

async function seed(...rows: Row[]): Promise<void> {
  db.bookings = rows
}

// ════════════════════════════════════════════════════════════════════════════
//  0. The harness is real
// ════════════════════════════════════════════════════════════════════════════

test('P0-C: the shipped bot handlers run against the fake prisma, on writer-built rows', async () => {
  const m = await load()
  const dbModule = await import('../db')
  assert.equal(
    dbModule.prisma as unknown,
    fakePrisma,
    'the fake must be the client the shipped handlers use — otherwise this file tests nothing',
  )

  // The registry is the bot's own, not a list this test invented.
  for (const name of ['job', 'schedule', 'recent']) {
    assert.ok(m.bot.commands.get(name), `/${name} must be registered by command-handler itself`)
  }
  // The owner's spec says "/booking"; that command does not exist. Pin the real
  // name so a future search by the wrong one cannot come up empty and reassure.
  assert.equal(m.bot.commands.get('booking'), undefined, 'there is no /booking command — the lookup is /job')

  const day = await createdRow()
  assert.equal(day.startTimeKnown, false, 'buildBookingCreateData must record that no hour was given')
  assert.equal(day.scheduledStart, null, 'stripe_link writes no start (R2-1, must not regress)')
  assert.equal((day.requestedDate as Date).toISOString(), '2027-07-15T04:00:00.000Z') // 00:00 EDT
  assert.ok(m.display.isDayAnchor(day.requestedDate as Date), 'the stored value IS an ET midnight anchor')

  const timed = await createdRow({ startTime: '09:30' })
  assert.equal(timed.startTimeKnown, true)
  assert.equal((timed.requestedDate as Date).toISOString(), '2027-07-15T13:30:00.000Z') // 9:30 EDT
})

// ════════════════════════════════════════════════════════════════════════════
//  1. /job — the two leaking date fields
// ════════════════════════════════════════════════════════════════════════════

test('P0-C surface 8: /job shows the DATE for a day-level move, never 12:00 AM', async () => {
  await seed(await createdRow())
  const embed = await runCommand('job', { id: 'WMIC-1001' })

  const requested = fieldValue(embed, '📅 Requested')
  assert.equal(requested, 'Jul 15, 2027', 'the date must still be stated — losing it is not a fix')
  assertNoTimeOfDay('/job "Requested"', requested)
  assertNoMidnightAnywhere('/job', embed)
})

test('P0-C surface 8: /job on a CONFIRMED day-level job leaks through the OTHER field', async () => {
  // confirmationScheduleData keeps the anchor in `confirmedDate` and leaves
  // scheduledStart NULL for a day-level job (R2-1), so this is the field that
  // printed "Jul 15, 2027, 12:00 AM" to the owner after approval.
  const row = await confirmedRow(await createdRow())
  assert.equal(row.scheduledStart, null, 'a day-level confirmation must invent no start')
  assert.ok(row.confirmedDate, 'the confirmation must set the confirmed DATE')

  await seed(row)
  const embed = await runCommand('job', { id: 'WMIC-1001' })

  const confirmed = fieldValue(embed, '📅 Confirmed')
  assert.equal(confirmed, 'Jul 15, 2027')
  assertNoTimeOfDay('/job "Confirmed"', confirmed)
  assertNoTimeOfDay('/job "Requested"', fieldValue(embed, '📅 Requested'))
  assertNoMidnightAnywhere('/job (confirmed day-level)', embed)
})

test('P0-C surface 8: a TIMED job still shows its real hour on /job', async () => {
  // The mutation trap for an over-broad fix: strip the hour from everything and
  // this goes red.
  await seed(await createdRow({ startTime: '09:30' }))
  const embed = await runCommand('job', { id: 'WMIC-1001' })
  assert.match(fieldValue(embed, '📅 Requested'), /^Jul 15, 2027, 9:30\s?[ ]?AM$/)

  await seed(await confirmedRow(await createdRow({ startTime: '09:30' })))
  const confirmed = await runCommand('job', { id: 'WMIC-1001' })
  assert.match(fieldValue(confirmed, '📅 Confirmed'), /9:30\s?[ ]?AM/)
})

test('P0-C surface 8: /job is right on BOTH sides of DST', async () => {
  // An EST anchor is 05:00Z, not 04:00Z — the naive "is the UTC time 04:00"
  // check breaks here, which is why the shared rule formats in ET.
  await seed(await createdRow({ moveDate: EST_DAY }))
  const winter = await runCommand('job', { id: 'WMIC-1001' })
  assert.equal(fieldValue(winter, '📅 Requested'), 'Jan 15, 2027')
  assertNoMidnightAnywhere('/job (EST day-level)', winter)

  await seed(await createdRow({ moveDate: EST_DAY, startTime: '09:30' }))
  const timed = await runCommand('job', { id: 'WMIC-1001' })
  assert.match(fieldValue(timed, '📅 Requested'), /9:30\s?[ ]?AM/)
})

test('P0-C surface 8: /job survives the migration window — an unreadable flag still reads as a DATE', async () => {
  // `startTimeKnown` is added by migration 20260812010000, and /job reads the
  // whole row (`include: { customer: true }`), so during a code-before-SQL
  // deploy the column can be absent. The anchor's SHAPE must still decide —
  // the bot must not gain a hard dependency on the new column.
  const row = await createdRow()
  delete row.startTimeKnown
  await seed(row)

  const embed = await runCommand('job', { id: 'WMIC-1001' })
  assert.equal(fieldValue(embed, '📅 Requested'), 'Jul 15, 2027')
  assertNoMidnightAnywhere('/job (flag unreadable)', embed)
})

test('P0-C surface 8: each /job field states its OWN column, not the row\'s best time', async () => {
  // THE OPPOSITE MISTAKE, and it is available: `moveTimeKnown` treats ANY
  // stored scheduledStart as proof of a crew hour. Hand it the whole booking
  // and the "Requested" field starts speaking for a different column — either
  // printing the anchor's 12:00 AM (if only the flag is taken from the row) or
  // the scheduled 9:30 (if the instant is too). Both are wrong; exact equality
  // catches both.
  //
  // The row is what the shipped confirmation writer produces for a day-level
  // booking an admin LATER gave a real start (scheduling.ts:244-246 documents
  // exactly that case).
  const m = await load()
  const base = await createdRow()
  const withAdminStart = { ...base, scheduledStart: m.scheduling.etDateTimeToInstant(EDT_DAY, '09:30') }
  const row = await confirmedRow(withAdminStart)
  assert.ok(row.scheduledStart, 'a start the admin set must survive confirmation')
  assert.equal(row.startTimeKnown, false, 'the flag still records that the OWNER gave no hour')
  assert.equal(
    m.display.moveTimeKnown(row as unknown as Parameters<typeof m.display.moveTimeKnown>[0]),
    true,
    'this is why the row must not be handed to the formatter: the stored start makes it "timed"',
  )

  await seed(row)
  const embed = await runCommand('job', { id: 'WMIC-1001' })
  assert.equal(fieldValue(embed, '📅 Requested'), 'Jul 15, 2027')
  assert.equal(fieldValue(embed, '📅 Confirmed'), 'Jul 15, 2027')
  assertNoMidnightAnywhere('/job (day-level with a later admin start)', embed)
})

test('P0-C surface 8: /job with no dates at all still says TBD rather than nothing', async () => {
  const row = await createdRow()
  row.requestedDate = null
  await seed(row)
  const embed = await runCommand('job', { id: 'WMIC-1001' })
  assert.equal(fieldValue(embed, '📅 Requested'), 'TBD')
  assert.equal(fieldValue(embed, '📅 Confirmed'), 'TBD')
})

// ════════════════════════════════════════════════════════════════════════════
//  2. /schedule — the listing
// ════════════════════════════════════════════════════════════════════════════

test('P0-C surface 9: /schedule shows the DATE for a day-level job, never 12:00 AM', async () => {
  await seed(await confirmedRow(await createdRow()))
  const embed = await runCommand('schedule')

  const row = onlyScheduleRow(embed)
  assert.match(row, /Jul 15, 2027/, 'the date must still be stated')
  assertNoTimeOfDay('/schedule', row)
  assertNoMidnightAnywhere('/schedule', embed)
  // A clock emoji would re-assert the hour the text just declined to state.
  assert.ok(row.startsWith('📅 '), `a date-only job must not be flagged with a clock: ${row}`)
})

test('P0-C surface 9: a TIMED job keeps its hour on /schedule', async () => {
  await seed(await confirmedRow(await createdRow({ startTime: '09:30' })))
  const row = onlyScheduleRow(await runCommand('schedule'))
  assert.match(row, /^⏰ Jul 15, 2027, 9:30\s?[ ]?AM/)
})

test('P0-C surface 9: /schedule reads the ROW, so a later admin start is what it shows', async () => {
  // The coalesced `when` is still what SORTS the list; what it must no longer
  // do is RENDER. `moveWhenInstant` uses the same scheduledStart → confirmedDate
  // → requestedDate precedence as `effectiveMoveDate`, so the instant shown is
  // unchanged — only the invented hour is gone.
  const m = await load()
  const base = await createdRow()
  const row = await confirmedRow({ ...base, scheduledStart: m.scheduling.etDateTimeToInstant(EDT_DAY, '14:00') })
  await seed(row)
  assert.match(onlyScheduleRow(await runCommand('schedule')), /^⏰ Jul 15, 2027, 2:00\s?[ ]?PM/)
})

test('P0-C surface 9: /schedule keeps its empty state and does not crash', async () => {
  await seed()
  const embed = await runCommand('schedule')
  assert.match(String(embed.description ?? ''), /No confirmed jobs/i)
})

// ════════════════════════════════════════════════════════════════════════════
//  3. The anti-blanket-fix guard — /recent is NOT a move
// ════════════════════════════════════════════════════════════════════════════

test('P0-C: /recent still prints the HOUR — an event instant is not a move date', async () => {
  // `ManualEvent.createdAt` is `@default(now())`: a genuine instant whose hour
  // IS the fact being logged. Route it through the booking rule and every field
  // log loses its time — and `isDayAnchor` would false-positive on an event
  // logged at exactly 00:00:00.000 ET. This is why the handler keeps TWO
  // formatters. Reverting the split turns this red.
  db.events = [
    {
      id: 'ev_1',
      eventType: 'QUOTE',
      customerName: 'Bob Ruiz',
      zip: '07102',
      notes: null,
      createdAt: new Date('2027-07-15T18:05:00.000Z'), // 2:05 PM ET
    },
  ]
  const embed = await runCommand('recent')
  const text = String(embed.description ?? '')
  assert.match(text, /2:05\s?[ ]?PM/, 'a logged event must keep the hour it was logged at')

  // And an event logged at exactly the anchor instant keeps its hour too.
  db.events = [
    {
      id: 'ev_2',
      eventType: 'QUOTE',
      customerName: 'Ana Diaz',
      zip: '07042',
      notes: null,
      createdAt: new Date('2027-07-15T04:00:00.000Z'), // 12:00 AM ET — a real log time
    },
  ]
  assert.match(String((await runCommand('recent')).description ?? ''), MIDNIGHT)
  db.events = []
})

// ════════════════════════════════════════════════════════════════════════════
//  4. Source guards + the SWEEP that stops surface ten leaking in silence
// ════════════════════════════════════════════════════════════════════════════

const ROOT = process.cwd()

/** Source with `//` and block comments removed. CRLF is normalised FIRST and
 *  that is load-bearing: in a JS regex `.` does not match `\r`, so on a CRLF
 *  checkout the line-comment strip could never reach `$` and silently stripped
 *  NOTHING — every negative guard would then be satisfiable by a comment that
 *  merely NAMES the banned code. (Round 3 lost to exactly that.) The stripper
 *  is self-checked in the test below before anything relies on it. */
function codeOf(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

test('P0-C: the comment stripper this file depends on actually strips', () => {
  const file = ['src', 'bot', 'command-handler.ts']
  const raw = readFileSync(join(ROOT, ...file), 'utf8')
  const stripped = codeOf(...file)

  // A sentence that exists ONLY in a comment there.
  assert.match(raw, /12:00 AM/, 'fixture: command-handler must still DISCUSS the defect in a comment')
  assert.ok(!/12:00 AM/.test(stripped), 'codeOf must strip comments — every guard below depends on it')
  // …and real code must survive, so a stripper that deleted everything (which
  // would satisfy every negative guard) fails here instead.
  assert.match(stripped, /fmtMoveDate/, 'codeOf must keep the code')
  assert.match(stripped, /smsMoveWhen/, 'codeOf must keep the code')
})

test('P0-C: command-handler formats booking date columns through the shared rule', () => {
  const code = codeOf('src', 'bot', 'command-handler.ts')

  assert.match(code, /from '\.\.\/lib\/booking-display'/, 'the bot must import the ONE shared rule, not keep a copy')
  assert.match(
    code,
    /fmtMoveDate\(booking\.requestedDate,\s*booking\.startTimeKnown\)/,
    'the Requested field must pass its own column AND the flag',
  )
  assert.match(
    code,
    /fmtMoveDate\(booking\.confirmedDate,\s*booking\.startTimeKnown\)/,
    'the Confirmed field must pass its own column AND the flag',
  )
  assert.ok(
    !/fmtMoveDate\(\s*booking\s*[,)]/.test(code),
    'passing the whole row lets a stored scheduledStart vouch for a different column',
  )
  assert.ok(
    !/smsMoveWhen\(when\)|fmtMoveDate\(when\)|\$\{fmtDate\(when\)\}/.test(code),
    'rendering the coalesced `when` throws away startTimeKnown — that is the /schedule defect',
  )
  // The bot must not gain a hard dependency on a column the migration window
  // may not have (a `select` naming it would raise P2022 where the full-row
  // read merely returns it as undefined, which the shape fallback handles).
  assert.ok(
    !/select:\s*\{[^}]*startTimeKnown/.test(code),
    'do not select startTimeKnown here — rely on the shape fallback during the migration window',
  )
})

// ── The sweep ───────────────────────────────────────────────────────────────

const SWEEP_SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', '__tests__', 'email-previews'])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SWEEP_SKIP.has(entry)) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

/** A formatter option that prints an hour. */
const HOUR_FORMAT = /timeStyle|hour:\s*['"]/
/** The shared booking-aware rule — the ONLY thing allowed to gate one. */
const SHARED_RULE = /(moveTimeKnown|moveWhenParts|smsMoveWhen|formatMoveWhen|jobDateTime|moveTimeLabel)\s*\(/

/** Every `name(` call in `code`, with its balanced argument text. */
function callSites(code: string, name: string): Array<{ at: number; args: string }> {
  const out: Array<{ at: number; args: string }> = []
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const open = code.indexOf('(', m.index)
    let depth = 0
    for (let i = open; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')' && --depth === 0) {
        out.push({ at: m.index, args: code.slice(open + 1, i) })
        break
      }
    }
  }
  return out
}

/** Helpers DECLARED in this file whose own body prints an hour. */
function hourPrintingHelpers(code: string): string[] {
  const names = new Set<string>()
  let m: RegExpExecArray | null
  const arrow = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s*)?\(/g
  while ((m = arrow.exec(code))) {
    const w = code.slice(m.index, m.index + 600)
    const stop = w.search(/\n(?:const|let|function|export|class)\s/)
    if (HOUR_FORMAT.test(stop > 0 ? w.slice(0, stop) : w)) names.add(m[1])
  }
  const fn = /function\s+([A-Za-z_$][\w$]*)\s*\(/g
  while ((m = fn.exec(code))) {
    const w = code.slice(m.index, m.index + 900)
    const stop = w.search(/\n(?:export |function )/)
    if (HOUR_FORMAT.test(stop > 0 ? w.slice(0, stop) : w)) names.add(m[1])
  }
  return Array.from(names)
}

/** Locals bound to an `effectiveMoveDate(...)` result — the coalesced form that
 *  hides the flag, and precisely how /schedule leaked. */
function moveDateAliases(code: string): string[] {
  const out = new Set<string>()
  const re = /\b([A-Za-z_$][\w$]*)\s*[:=]\s*effectiveMoveDate\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) out.add(m[1])
  return Array.from(out)
}

function bookingDateRe(aliases: string[]): RegExp {
  return new RegExp(
    `\\b(requestedDate|confirmedDate|effectiveMoveDate\\s*\\(${aliases.map((a) => `|${a}\\b`).join('')})`,
  )
}

/** Every place a booking DATE COLUMN reaches an hour-printing formatter without
 *  the shared rule standing in front of it. */
function leaks(): string[] {
  const found: string[] = []
  for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'app'))]) {
    const code = codeOf(relative(ROOT, file))
    const COLUMN = bookingDateRe(moveDateAliases(code))
    if (!COLUMN.test(code)) continue
    const rel = relative(ROOT, file).replace(/\\/g, '/')

    // (a) inline — the column and the hour format in one statement
    const lines = code.split('\n')
    lines.forEach((line, i) => {
      if (!COLUMN.test(line) || !HOUR_FORMAT.test(line)) return
      if (SHARED_RULE.test(lines.slice(Math.max(0, i - 2), i + 1).join('\n'))) return
      found.push(`${rel}:${i + 1}  ${line.trim().slice(0, 150)}`)
    })

    // (b) indirect — a local hour-printing helper applied to the column
    for (const helper of hourPrintingHelpers(code)) {
      for (const { at, args } of callSites(code, helper)) {
        if (!COLUMN.test(args)) continue
        if (SHARED_RULE.test(code.slice(Math.max(0, at - 260), at))) continue
        found.push(`${rel}  ${helper}(${args.trim().slice(0, 120)})`)
      }
    }
  }
  return found
}

test('P0-C: NO surface anywhere formats a booking date column with an invented hour', () => {
  // WHY A SWEEP AND NOT ANOTHER PATH-BY-PATH GUARD: every source guard in
  // day-anchor-display.test.ts hard-codes one path, so the gateway bot — a
  // whole process — was structurally invisible to all of them for three rounds.
  // This walks src/ and app/ instead, so surface ten cannot leak in silence.
  //
  // It is a BACKSTOP, not the primary guard: it catches a column handed to an
  // hour-printing formatter directly or through a local helper or an
  // `effectiveMoveDate` alias, and it exempts a formatter the shared rule
  // already gates (the customer portal's "Around 4:00 PM" line is the one
  // legitimate case in the repo today). The behavioural tests above are what
  // actually prove the rendering.
  const found = leaks()
  assert.deepEqual(
    found,
    [],
    `a booking date column is being formatted with an hour. A day-level move has no hour to print —\n` +
      `route it through booking-display (moveWhenParts / smsMoveWhen / formatMoveWhen) or gate it with\n` +
      `moveTimeKnown:\n  ${found.join('\n  ')}`,
  )
})

test('P0-C: the sweep can actually see the defect it exists to catch', () => {
  // A sweep that finds nothing is worthless unless it is proved to find
  // something. These are the three shapes P0-C shipped, run through the same
  // matchers on synthetic source.
  const legacy = [
    "const fmtDate = (d) => d ? new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'TBD'",
    "const when = effectiveMoveDate(j)",
    "value: `${fmtDate(booking.requestedDate)} / ${fmtDate(when)}`",
  ].join('\n')

  const COLUMN = bookingDateRe(moveDateAliases(legacy))
  const helpers = hourPrintingHelpers(legacy)
  assert.deepEqual(helpers, ['fmtDate'], 'the helper detector must see an hour-printing local formatter')
  const hits = callSites(legacy, 'fmtDate').filter(({ args }) => COLUMN.test(args))
  assert.equal(hits.length, 2, 'both the raw column AND the coalesced effectiveMoveDate alias must be caught')

  // And it must NOT fire on the two legitimate shapes.
  const eventLog = "const fmtTimestamp = (d) => new Date(d).toLocaleString('en-US', { timeStyle: 'short' })\nfmtTimestamp(e.createdAt)"
  assert.equal(
    callSites(eventLog, 'fmtTimestamp').filter(({ args }) => bookingDateRe([]).test(args)).length,
    0,
    'an event instant is not a booking date column',
  )
  const gated = "const t = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric' })\nmoveTimeKnown(b) ? t(b.requestedDate) : null"
  const gatedHit = callSites(gated, 't').find(({ args }) => bookingDateRe([]).test(args))
  assert.ok(gatedHit, 'fixture: the gated call must be a candidate…')
  assert.ok(SHARED_RULE.test(gated.slice(0, gatedHit.at)), '…and the shared-rule gate must exempt it')
})
