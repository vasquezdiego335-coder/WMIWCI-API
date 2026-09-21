import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CARD_CLAIM_STALE_MS,
  planCardSync,
  syncBookingCards,
  type CardAudience,
  type CardRow,
  type CardSyncDeps,
  type DiscordResult,
  type SyncBooking,
} from '../booking-cards-sync'
import type { CardJson } from '../job-cards'

// ════════════════════════════════════════════════════════════════════════════
//  ONE living Discord card per booking, per audience.
//
//  Everything here runs offline against in-memory edges: a fake card store with
//  the same UNIQUE (booking_id, audience) behaviour as the real table, and a
//  fake Discord that records every POST and PATCH. The questions are:
//    • is a card created exactly ONCE, whatever is retried or raced?
//    • does "JOB CONFIRMED" appear only for a booking that really is?
//    • can a Discord or database problem ever escape as an exception?
// ════════════════════════════════════════════════════════════════════════════

const OWNER_CHANNEL = '111111111111111111'
const CREW_CHANNEL = '222222222222222222'
const APPROVAL_MESSAGE = '900000000000000001'

type Call = { kind: 'post' | 'edit'; channelId: string; messageId?: string; card: CardJson }

function harness(opts: {
  status: string
  approvalMessageId?: string | null
  channels?: { crew?: string | null; owner?: string | null }
  post?: (n: number) => DiscordResult
  edit?: (call: Call) => DiscordResult
  tableMissing?: boolean
} ) {
  const calls: Call[] = []
  const rows = new Map<string, CardRow>()
  let clock = new Date('2026-09-22T12:00:00Z')
  let posted = 0
  const booking: SyncBooking = {
    id: 'bk_1019',
    displayId: 'WMIC-1019',
    status: opts.status,
    customer: { name: 'John Smith', phone: '9735550142' },
    requestedDate: new Date('2026-09-22T18:00:00Z'),
    originCity: 'Orange', originState: 'NJ', destCity: 'Philadelphia', destState: 'PA',
    depositAmount: 4900,
    totalEstimate: 1250,
    payments: opts.status === 'PENDING_APPROVAL' ? [{ amount: 4900, status: 'PENDING' }] : [{ amount: 4900, status: 'COMPLETED' }],
    discordApprovalMessageId: opts.approvalMessageId === undefined ? APPROVAL_MESSAGE : opts.approvalMessageId,
  }
  const key = (b: string, a: CardAudience) => `${b}:${a}`
  const missing = () => Object.assign(new Error('The table `public.booking_discord_cards` does not exist'), { code: 'P2021' })

  const deps: CardSyncDeps = {
    loadBooking: async () => booking,
    extras: async () => ({}),
    store: {
      async find(b, a) { if (opts.tableMissing) throw missing(); return rows.get(key(b, a)) ?? null },
      async claim(b, a, channelId, now) {
        if (opts.tableMissing) throw missing()
        if (rows.has(key(b, a))) return 'exists' // the UNIQUE constraint
        rows.set(key(b, a), { channelId, messageId: null, claimedAt: now })
        return 'won'
      },
      async takeOverStale(b, a, channelId, staleBefore, now) {
        const r = rows.get(key(b, a))
        if (!r || r.messageId || (r.claimedAt && r.claimedAt >= staleBefore)) return false
        rows.set(key(b, a), { channelId, messageId: null, claimedAt: now })
        return true
      },
      async setMessage(b, a, channelId, messageId) { rows.set(key(b, a), { channelId, messageId, claimedAt: rows.get(key(b, a))?.claimedAt ?? null }) },
      async release(b, a) { if (!rows.get(key(b, a))?.messageId) rows.delete(key(b, a)) },
      async forget(b, a) { rows.delete(key(b, a)) },
      async touch() {},
    },
    discord: {
      async post(channelId, card) {
        calls.push({ kind: 'post', channelId, card })
        posted++
        return opts.post ? opts.post(posted) : { ok: true, status: 200, id: `msg_${posted}` }
      },
      async edit(channelId, messageId, card) {
        const call: Call = { kind: 'edit', channelId, messageId, card }
        calls.push(call)
        return opts.edit ? opts.edit(call) : { ok: true, status: 200, id: messageId }
      },
    },
    channels: opts.channels ?? { crew: CREW_CHANNEL, owner: OWNER_CHANNEL },
    now: () => clock,
  }
  return {
    deps, calls, rows, booking,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms) },
    posts: () => calls.filter((c) => c.kind === 'post'),
    edits: () => calls.filter((c) => c.kind === 'edit'),
    text: (c: Call) => JSON.stringify(c.card),
  }
}

// ── The plan is a pure function of BookingStatus ────────────────────────────

test('a crew card is never CREATED for a booking that is not confirmed', () => {
  assert.deepEqual(planCardSync('PENDING_APPROVAL'), { crew: 'edit-only', owner: 'skip' })
  assert.deepEqual(planCardSync('PENDING_PAYMENT'), { crew: 'skip', owner: 'skip' })
  assert.deepEqual(planCardSync('DRAFT'), { crew: 'skip', owner: 'skip' })
  assert.deepEqual(planCardSync(undefined), { crew: 'skip', owner: 'skip' })
  for (const s of ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED']) assert.deepEqual(planCardSync(s), { crew: 'ensure', owner: 'ensure' })
  for (const s of ['CANCELLED', 'ARCHIVED']) assert.deepEqual(planCardSync(s), { crew: 'edit-only', owner: 'edit-only' }, 'a dead booking never gets a NEW card')
})

// ── The $49: authorization vs capture ───────────────────────────────────────

test('$49 AUTHORIZED (PENDING_APPROVAL): nothing is posted, nothing is labelled paid or confirmed', async () => {
  const h = harness({ status: 'PENDING_APPROVAL' })
  const out = await syncBookingCards('bk_1019', h.deps)
  assert.equal(h.calls.length, 0, 'the request card owns #bookings; the crew are told nothing about an unapproved request')
  assert.ok(out.outcomes.every((o) => o.result === 'skipped'))
})

test('successful capture → CONFIRMED: the request card becomes JOB CONFIRMED in place, and the crew card is created', async () => {
  const h = harness({ status: 'CONFIRMED' })
  const out = await syncBookingCards('bk_1019', h.deps)

  const [ownerEdit] = h.edits()
  assert.equal(ownerEdit.channelId, OWNER_CHANNEL)
  assert.equal(ownerEdit.messageId, APPROVAL_MESSAGE, 'the ORIGINAL approval message is edited — #bookings keeps one message per booking')
  assert.match(h.text(ownerEdit), /JOB CONFIRMED/)
  assert.match(h.text(ownerEdit), /\$49 captured/)

  const [crewPost] = h.posts()
  assert.equal(h.posts().length, 1)
  assert.equal(crewPost.channelId, CREW_CHANNEL)
  assert.doesNotMatch(h.text(crewPost), /\$/, 'the crew card carries no money')
  assert.deepEqual(out.outcomes.map((o) => `${o.audience}:${o.result}`), ['owner:edited', 'crew:created'])
})

test('a FAILED capture leaves the booking PENDING_APPROVAL — so no sync can ever produce "Confirmed" for it', async () => {
  // approveBooking() rolls its claim back when stripe.capture() throws, and the
  // notifier (the only trigger) is never reached. Even if a stray job ran:
  const h = harness({ status: 'PENDING_APPROVAL' })
  await syncBookingCards('bk_1019', h.deps)
  assert.equal(h.calls.filter((c) => /CONFIRMED|captured/.test(h.text(c))).length, 0)
})

// ── Exactly once ────────────────────────────────────────────────────────────

test('duplicate / retried sync jobs create ONE crew card and edit it thereafter', async () => {
  const h = harness({ status: 'CONFIRMED' })
  for (let i = 0; i < 5; i++) await syncBookingCards('bk_1019', h.deps) // a replayed Stripe event, a BullMQ retry, the digest…
  assert.equal(h.posts().length, 1, 'exactly one crew card, however many times the job runs')
  assert.equal(h.edits().filter((c) => c.channelId === CREW_CHANNEL).length, 4)
  assert.ok(h.edits().filter((c) => c.channelId === CREW_CHANNEL).every((c) => c.messageId === 'msg_1'), 'every later sync edits THE SAME message')
})

test('two workers racing: the UNIQUE claim lets exactly one of them post', async () => {
  const h = harness({ status: 'CONFIRMED' })
  await Promise.all([syncBookingCards('bk_1019', h.deps), syncBookingCards('bk_1019', h.deps), syncBookingCards('bk_1019', h.deps)])
  assert.equal(h.posts().length, 1)
})

test('the card follows the booking through its lifecycle on ONE message', async () => {
  const h = harness({ status: 'CONFIRMED' })
  await syncBookingCards('bk_1019', h.deps)
  for (const [status, label] of [['IN_PROGRESS', 'IN PROGRESS'], ['COMPLETED', 'COMPLETED']] as const) {
    h.booking.status = status
    await syncBookingCards('bk_1019', h.deps)
    const lastCrew = h.edits().filter((c) => c.channelId === CREW_CHANNEL).at(-1) as Call
    assert.equal(lastCrew.messageId, 'msg_1')
    assert.match(h.text(lastCrew), new RegExp(label))
  }
  assert.equal(h.posts().length, 1, 'still one crew message after three states')
})

test('a cancelled job repaints an existing crew card but never creates one', async () => {
  const fresh = harness({ status: 'CANCELLED', approvalMessageId: null })
  await syncBookingCards('bk_1019', fresh.deps)
  assert.equal(fresh.posts().length, 0)

  const live = harness({ status: 'CONFIRMED' })
  await syncBookingCards('bk_1019', live.deps)
  live.booking.status = 'CANCELLED'
  await syncBookingCards('bk_1019', live.deps)
  assert.match(live.text(live.edits().at(-1) as Call), /CANCELLED/)
  assert.equal(live.posts().length, 1)
})

// ── Recovery ────────────────────────────────────────────────────────────────

test('a worker that died mid-post cannot wedge the card: its claim is taken over once stale', async () => {
  const h = harness({ status: 'CONFIRMED' })
  // A claim exists, but no message was ever recorded.
  await h.deps.store.claim('bk_1019', 'crew', CREW_CHANNEL, h.deps.now())

  let out = await syncBookingCards('bk_1019', h.deps)
  assert.equal(h.posts().length, 0, 'a FRESH claim belongs to a live worker — do not double-post')
  assert.match(String((out.outcomes.find((o) => o.audience === 'crew') as { reason?: string }).reason), /another worker/)

  h.advance(CARD_CLAIM_STALE_MS + 1000)
  out = await syncBookingCards('bk_1019', h.deps)
  assert.equal(h.posts().length, 1, 'after the stale window the claim is taken over and the card goes out')
})

test('a post that Discord rejects releases the claim so the retry can post', async () => {
  const h = harness({ status: 'CONFIRMED', post: (n) => (n === 1 ? { ok: false, status: 503, error: 'discord 503' } : { ok: true, status: 200, id: 'msg_ok' }) })
  const first = await syncBookingCards('bk_1019', h.deps)
  assert.equal(first.outcomes.find((o) => o.audience === 'crew')?.result, 'failed')
  assert.equal(h.rows.has('bk_1019:crew'), false, 'no orphan claim left behind')

  const second = await syncBookingCards('bk_1019', h.deps)
  assert.equal(second.outcomes.find((o) => o.audience === 'crew')?.result, 'created')
})

test('a card somebody deleted by hand is replaced, not mourned', async () => {
  const h = harness({ status: 'CONFIRMED', edit: (c) => (c.channelId === CREW_CHANNEL ? { ok: false, status: 404, error: 'Unknown Message' } : { ok: true, status: 200 }) })
  h.rows.set('bk_1019:crew', { channelId: CREW_CHANNEL, messageId: 'msg_deleted', claimedAt: null })
  const out = await syncBookingCards('bk_1019', h.deps)
  assert.equal(out.outcomes.find((o) => o.audience === 'crew')?.result, 'created')
})

test('when the ORIGINAL approval message is gone, the owner gets a replacement card — recorded, so it too is posted once', async () => {
  const h = harness({ status: 'CONFIRMED', edit: (c) => (c.messageId === APPROVAL_MESSAGE ? { ok: false, status: 404 } : { ok: true, status: 200 }) })
  await syncBookingCards('bk_1019', h.deps)
  await syncBookingCards('bk_1019', h.deps)
  assert.equal(h.posts().filter((c) => c.channelId === OWNER_CHANNEL).length, 1)
})

// ── Nothing here can hurt a booking or a payment ────────────────────────────

test('Discord being down is reported as a failed outcome — never thrown', async () => {
  const h = harness({ status: 'CONFIRMED', post: () => ({ ok: false, status: 0, error: 'fetch failed' }), edit: () => ({ ok: false, status: 503, error: 'discord 503' }) })
  const out = await syncBookingCards('bk_1019', h.deps)
  assert.deepEqual(out.outcomes.map((o) => o.result), ['failed', 'failed'])
})

test('before the migration is applied: nothing is posted (it could not be recorded), the owner edit still works, nothing throws', async () => {
  const h = harness({ status: 'CONFIRMED', tableMissing: true })
  const out = await syncBookingCards('bk_1019', h.deps)
  assert.equal(h.posts().length, 0, 'an unrecorded post would be repeated on every later sync')
  assert.equal(out.outcomes.find((o) => o.audience === 'owner')?.result, 'edited', 'the approval message needs no table')
  assert.match(String((out.outcomes.find((o) => o.audience === 'crew') as { reason?: string }).reason), /migration not applied/)
})

test('an unconfigured crew channel skips the crew card and still updates the owner', async () => {
  const h = harness({ status: 'CONFIRMED', channels: { crew: null, owner: OWNER_CHANNEL } })
  const out = await syncBookingCards('bk_1019', h.deps)
  assert.equal(h.posts().length, 0)
  assert.equal(out.outcomes.find((o) => o.audience === 'owner')?.result, 'edited')
})

test('a booking that no longer exists is a quiet no-op', async () => {
  const h = harness({ status: 'CONFIRMED' })
  h.deps.loadBooking = async () => null
  const out = await syncBookingCards('missing', h.deps)
  assert.equal(h.calls.length, 0)
  assert.equal(out.status, null)
})

// ── The wiring (source-level, like deposit-routes.test.ts) ──────────────────

const src = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')

test('the ONLY thing that announces a confirmed job is the approval notifier — after capture + commit', () => {
  const approval = src('src/lib/booking-approval.ts')
  const capture = approval.indexOf("intent = await stripe.capture(pi, `capture:${pi}`)")
  const commit = approval.indexOf('await store.commitApproval({')
  const notify = approval.indexOf('notifier.sendApproved(booking, capturedCents, actor.name)')
  assert.ok(capture > 0 && commit > capture && notify > commit, 'order must stay: capture → commitApproval → notify')
  assert.match(approval, /queueBookingCardSync\(booking\.id, 'approved'\)/)

  // A capture failure returns BEFORE the notifier, with the claim rolled back.
  const failure = approval.indexOf("return errResult('capture_failed'")
  assert.ok(failure > capture && failure < commit, 'the capture_failed return must sit between capture and commit')
})

test('Stripe webhook handling never triggers a job announcement: checkout.session.completed proves an AUTHORIZATION', () => {
  for (const file of ['src/lib/stripe-events.ts', 'src/lib/fulfillment.ts']) {
    const code = src(file)
    assert.doesNotMatch(code, /queueBookingCardSync|booking-card-sync/, `${file} must not announce jobs`)
    assert.doesNotMatch(code, /type: 'create-job-channels'/, `${file} must not post a job card at authorization time`)
  }
})

test('the sync job carries only a booking id — never a status or an amount it could replay', () => {
  const code = src('src/lib/booking-cards-sync.ts')
  assert.match(code, /discordQueue\.add\('booking-card-sync', \{ type: 'booking-card-sync', bookingId, payload: \{ reason \} \}\)/)
  assert.doesNotMatch(code, /jobId:/, 'a deterministic jobId would make every sync after the first a silent no-op')
})

test('the crew card reads ONLY DISCORD_CHANNEL_JOB_DATA — never the legacy variable the PII card used', () => {
  const code = src('src/lib/booking-cards-sync.ts')
  assert.ok(code.includes('crew: configuredId(process.env.DISCORD_CHANNEL_JOB_DATA)'), 'the crew channel comes from DISCORD_CHANNEL_JOB_DATA')
  // Drop comment lines: the explanation may NAME the legacy variable; the code may not READ it.
  const executable = code
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n')
  assert.ok(!executable.includes('DISCORD_CHANNEL_JOBS'), 'the retired job card read DISCORD_CHANNEL_JOBS; a crew channel must never be reachable through it')
})

test('an unset crew channel SKIPS the crew card — it never falls back to another channel', async () => {
  const h = harness({ status: 'CONFIRMED', channels: { crew: undefined, owner: OWNER_CHANNEL } })
  const out = await syncBookingCards('bk_1019', h.deps)
  assert.equal(h.posts().length, 0)
  assert.equal(h.rows.has('bk_1019:crew'), false, 'nothing is recorded, so the first sync after the variable is set creates the card in the right place')
  assert.match(String((out.outcomes.find((o) => o.audience === 'crew') as { reason?: string }).reason), /no channel configured/)
})

test('every Discord request from the sync disables mention parsing', () => {
  assert.match(src('src/lib/booking-cards-sync.ts'), /allowed_mentions: \{ parse: \[\] \}/)
})

test('a legacy create-job-channels job is routed through the sync, never the old card', () => {
  const worker = src('src/workers/discord.worker.ts')
  assert.match(worker, /case 'create-job-channels':[\s\S]{0,900}case 'booking-card-sync':/)
  assert.doesNotMatch(worker, /createJobChannels\(/)
  assert.doesNotMatch(src('src/bot/discord-rest.ts'), /export async function createJobChannels|export async function postPaymentAlert/)
})
