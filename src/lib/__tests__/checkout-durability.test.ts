// ════════════════════════════════════════════════════════════════════════════
//  checkout-durability.test.ts — RELEASE BLOCKER B9
//
//  THE TWO DEFECTS UNDER TEST
//   1. The public booking form created a live Stripe session and THEN ran one
//      unguarded `booking.update` (DRAFT -> PENDING_PAYMENT + session id). A
//      failure of that single statement threw out of the route: the customer —
//      who had already typed their name as a signature on the Moving Service
//      Agreement and consumed a WMIC reference — got an opaque browser error
//      (the POST wrapper attaches CORS headers only to a RETURNED response),
//      the owner alert never fired, and the row stayed DRAFT, the one status
//      that the resume route, the abandoned-checkout worker and the recovery
//      journey all refuse.
//   2. The resume route minted a fresh payable session on every click, expired
//      nothing and persisted nothing. Two live $49 authorizations could exist
//      at once; if both were completed the second is claimed by nobody
//      (fulfillment's atomic claim matches zero rows), so it would be neither
//      captured nor released, and nobody alerted. That is the money-shaped half.
//
//  WHAT THIS FILE PROVES, AND HOW — stated plainly, because the two halves have
//  different strength:
//   • The DECISIONS run for real. Every function in src/lib/checkout-session.ts
//     is executed here against fakes (including the shipped prisma-backed
//     recorder, driven by a fake `prisma` installed on globalThis exactly like
//     migration-window.test.ts does). Break one and these go red.
//   • The WIRING is pinned STRUCTURALLY. A Next route handler cannot be
//     imported offline (it would build a real Stripe client and go to the
//     network), so the route assertions parse the shipped source: comments and
//     string bodies are blanked, then brace/try depth and statement ORDER are
//     measured. Deleting the try around the recording, reverting the created
//     status to DRAFT, dropping the idempotency key, or redirecting a customer
//     to a session before it is recorded each make these fail.
//
//  Offline: no database, no Stripe, no Redis.
//    npx tsx --test src/lib/__tests__/checkout-durability.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── The fake database, installed BEFORE any app module is imported ──────────
// src/lib/db.ts does `globalForPrisma.prisma ?? new PrismaClient(...)`, so this
// must be in place before the module under test is loaded. Every app import
// below is therefore dynamic.

type Row = Record<string, unknown>

type FakeDb = {
  updates: Array<{ where: Row; data: Row; select?: Row }>
  updateError?: Error
}

let db: FakeDb = { updates: [] }

const fakePrisma = {
  booking: {
    async update(args: { where: Row; data: Row; select?: Row }): Promise<Row> {
      db.updates.push({ where: args.where, data: args.data, select: args.select })
      if (db.updateError) throw db.updateError
      return { id: args.where.id }
    },
  },
}

;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma

type Mod = typeof import('../checkout-session')
let mod: Mod | null = null

async function load(): Promise<Mod> {
  if (mod) return mod
  mod = await import('../checkout-session')
  const dbModule = await import('../db')
  assert.equal(
    dbModule.prisma as unknown,
    fakePrisma,
    'the fake prisma must be the client the shipped module uses — otherwise this file tests nothing',
  )
  return mod
}

// ── Recording fakes for the injected dependencies ───────────────────────────

type Calls = {
  retrieved: string[]
  expired: string[]
  recorded: Array<{ bookingId: string; sessionId: string }>
  alerts: Array<{ title: string; lines: Array<{ message: string; action?: string }> }>
  logs: Array<{ level: 'info' | 'warn' | 'error'; message: string }>
}

type DepsOverrides = Partial<Awaited<ReturnType<Mod['defaultCheckoutSessionDeps']>>>

function fakeDeps(
  overrides: Partial<{
    retrieve: (id: string) => Promise<unknown>
    expire: (id: string) => Promise<void>
    record: (bookingId: string, sessionId: string) => Promise<void>
  }> = {},
): { deps: DepsOverrides; calls: Calls } {
  const calls: Calls = { retrieved: [], expired: [], recorded: [], alerts: [], logs: [] }
  const deps = {
    async retrieveSession(id: string) {
      calls.retrieved.push(id)
      const r = overrides.retrieve ? await overrides.retrieve(id) : null
      return r as never
    },
    async expireSession(id: string) {
      calls.expired.push(id)
      if (overrides.expire) await overrides.expire(id)
    },
    async recordSessionId(bookingId: string, sessionId: string) {
      calls.recorded.push({ bookingId, sessionId })
      if (overrides.record) await overrides.record(bookingId, sessionId)
    },
    async alert(title: string, lines: Array<{ message: string; action?: string }>) {
      calls.alerts.push({ title, lines })
      return { delivered: true }
    },
    log: {
      info: (_f: Record<string, unknown>, m: string) => calls.logs.push({ level: 'info', message: m }),
      warn: (_f: Record<string, unknown>, m: string) => calls.logs.push({ level: 'warn', message: m }),
      error: (_f: Record<string, unknown>, m: string) => calls.logs.push({ level: 'error', message: m }),
    },
    now: () => 1_770_000_000_000,
  }
  return { deps: deps as DepsOverrides, calls }
}

// ════════════════════════════════════════════════════════════════════════════
//  SOURCE ANALYSIS — used by the route sections below.
//
//  `blankNonCode` replaces comment bodies and string/template contents with
//  spaces, PRESERVING every index, so a rule about code is never satisfied by
//  prose that merely mentions the same identifier (`{CHECKOUT_SESSION_ID}` in
//  the success URL is a literal brace pair, and the routes are heavily
//  commented). Section 0 pins that the analyzer itself works.
// ════════════════════════════════════════════════════════════════════════════

function blankNonCode(src: string, opts: { keepStrings?: boolean } = {}): string {
  const out = src.split('')
  const modes: string[] = ['code']
  const tplBrace: number[] = []
  const keep = opts.keepStrings === true
  let braces = 0
  let i = 0
  const top = (): string => modes[modes.length - 1]
  while (i < src.length) {
    const c = src[i]
    const d = i + 1 < src.length ? src[i + 1] : ''
    const m = top()
    if (m === 'code') {
      if (c === '/' && d === '/') { out[i] = ' '; out[i + 1] = ' '; modes.push('line'); i += 2; continue }
      if (c === '/' && d === '*') { out[i] = ' '; out[i + 1] = ' '; modes.push('block'); i += 2; continue }
      if (c === "'") { modes.push('sq'); i++; continue }
      if (c === '"') { modes.push('dq'); i++; continue }
      if (c === '`') { modes.push('tpl'); i++; continue }
      if (c === '{') { braces++; i++; continue }
      if (c === '}') {
        braces--
        i++
        if (tplBrace.length > 0 && braces === tplBrace[tplBrace.length - 1]) {
          tplBrace.pop()
          modes.pop()
        }
        continue
      }
      i++
      continue
    }
    if (m === 'line') {
      if (c === '\n') { modes.pop(); i++; continue }
      out[i] = ' '
      i++
      continue
    }
    if (m === 'block') {
      if (c === '*' && d === '/') { out[i] = ' '; out[i + 1] = ' '; modes.pop(); i += 2; continue }
      if (c !== '\n') out[i] = ' '
      i++
      continue
    }
    if (m === 'sq' || m === 'dq') {
      const q = m === 'sq' ? "'" : '"'
      if (c === '\\') { if (!keep) { out[i] = ' '; if (src[i + 1] !== '\n') out[i + 1] = ' ' } i += 2; continue }
      if (c === q) { modes.pop(); i++; continue }
      if (!keep && c !== '\n') out[i] = ' '
      i++
      continue
    }
    // template literal
    if (c === '\\') { if (!keep) { out[i] = ' '; if (src[i + 1] !== '\n') out[i + 1] = ' ' } i += 2; continue }
    if (c === '`') { modes.pop(); i++; continue }
    if (c === '$' && d === '{') {
      if (!keep) out[i] = ' ' // blank the '$', keep '{' so braces stay balanced
      modes.push('code')
      tplBrace.push(braces)
      braces++
      i += 2
      continue
    }
    if (!keep && c !== '\n') out[i] = ' '
    i++
  }
  return out.join('')
}

/** How many enclosing `try` blocks contain `index`. */
function tryDepthAt(clean: string, index: number): number {
  const stack: boolean[] = []
  for (let i = 0; i < index && i < clean.length; i++) {
    const c = clean[i]
    if (c === '{') stack.push(/\btry\s*$/.test(clean.slice(Math.max(0, i - 12), i)))
    else if (c === '}') stack.pop()
  }
  return stack.filter(Boolean).length
}

const ROOT = resolve(__dirname, '../../..')
const PUBLIC_ROUTE = resolve(ROOT, 'app/api/bookings/route.ts')
const RESUME_ROUTE = resolve(ROOT, 'app/api/stripe/checkout/resume/route.ts')
const STRIPE_LIB = resolve(ROOT, 'src/lib/stripe.ts')

/** Structure view: comments AND string bodies blanked. Brace/try depth and the
 *  position of code tokens are measured on this. */
const cleanOf = (file: string): string => blankNonCode(readFileSync(file, 'utf8'))

/** Value view: comments blanked, string LITERALS kept — so a rule about
 *  `status: 'PENDING_PAYMENT'` can still see the value while prose above it
 *  cannot satisfy anything. Same length as the structure view, so the two share
 *  indexes and may be sliced with each other's positions. */
const valuesOf = (file: string): string => blankNonCode(readFileSync(file, 'utf8'), { keepStrings: true })

/** Index of a code occurrence, asserted to exist. */
function at(clean: string, needle: string, what: string): number {
  const idx = clean.indexOf(needle)
  assert.notEqual(idx, -1, `${what}: expected to find \`${needle}\` in the shipped code`)
  return idx
}

// ════════════════════════════════════════════════════════════════════════════
//  0. PRECONDITIONS — without these, nothing below means anything
// ════════════════════════════════════════════════════════════════════════════

test('0.1 the analyzer blanks comments and strings but keeps code indexes', () => {
  const src = [
    'const a = 1 // try { fake }',
    "const b = 'try {'",
    'try {',
    '  const c = `x${ a }y`',
    '}',
  ].join('\n')
  const clean = blankNonCode(src)
  assert.equal(clean.length, src.length, 'indexes must be preserved')
  assert.equal(clean.indexOf('fake'), -1, 'comment text must not survive')
  assert.equal((clean.match(/try/g) ?? []).length, 1, 'only the REAL try keyword survives')
  // The real try body is at try-depth 1; the line above it is not.
  assert.equal(tryDepthAt(clean, at(clean, 'const c', 'analyzer')), 1)
  assert.equal(tryDepthAt(clean, at(clean, 'const a', 'analyzer')), 0)
})

test('0.2 the analyzer survives the success-URL brace literal the real route uses', () => {
  const src = 'const u = `${app}/success?session_id={CHECKOUT_SESSION_ID}&b=${id}`\nconst after = 1\n'
  const clean = blankNonCode(src)
  assert.equal(clean.indexOf('CHECKOUT_SESSION_ID'), -1, 'the literal must be blanked')
  assert.equal(tryDepthAt(clean, at(clean, 'const after', 'analyzer')), 0, 'braces must still balance')
})

// ════════════════════════════════════════════════════════════════════════════
//  1. THE IDEMPOTENCY KEY (fix plan item 4)
//
//  "Derived from the booking id" is necessary but NOT sufficient: Stripe
//  replays a key for 24h while these sessions expire in 30 minutes, so a key
//  that is ONLY the booking id would hand a customer a dead checkout page.
// ════════════════════════════════════════════════════════════════════════════

test('1.1 the key names the booking and is stable for the same attempt', async () => {
  const m = await load()
  const now = 1_770_000_000_000
  const a = m.checkoutIdempotencyKey({ bookingId: 'bk_1', now })
  const b = m.checkoutIdempotencyKey({ bookingId: 'bk_1', now: now + 1_000 })
  assert.ok(a.includes('bk_1'), 'the key must be derived from the booking id')
  assert.equal(a, b, 'a retry seconds later must reuse the same Stripe session')
  assert.notEqual(a, m.checkoutIdempotencyKey({ bookingId: 'bk_2', now }), 'two bookings never share a key')
})

test('1.2 replacing a session changes the key — a resume click cannot replay the session it just expired', async () => {
  const m = await load()
  const now = 1_770_000_000_000
  const first = m.checkoutIdempotencyKey({ bookingId: 'bk_1', now })
  const second = m.checkoutIdempotencyKey({ bookingId: 'bk_1', previousSessionId: 'cs_old', now })
  const third = m.checkoutIdempotencyKey({ bookingId: 'bk_1', previousSessionId: 'cs_newer', now })
  assert.notEqual(first, second)
  assert.notEqual(second, third)
})

test('1.3 concurrent clicks that saw the SAME recorded session collapse into one session', async () => {
  const m = await load()
  const now = 1_770_000_000_000
  assert.equal(
    m.checkoutIdempotencyKey({ bookingId: 'bk_1', previousSessionId: 'cs_a', now }),
    m.checkoutIdempotencyKey({ bookingId: 'bk_1', previousSessionId: 'cs_a', now: now + 2_000 }),
  )
})

test('1.4 the replay window is shorter than the session lifetime (no dead checkout pages)', async () => {
  const m = await load()
  const now = 1_770_000_000_000
  const later = now + m.CHECKOUT_IDEMPOTENCY_WINDOW_MS * 2
  assert.notEqual(
    m.checkoutIdempotencyKey({ bookingId: 'bk_1', now }),
    m.checkoutIdempotencyKey({ bookingId: 'bk_1', now: later }),
    'a much later attempt must NOT replay an old session',
  )
  assert.ok(
    m.CHECKOUT_IDEMPOTENCY_WINDOW_MS < m.CHECKOUT_SESSION_TTL_MINUTES * 60 * 1000,
    'a replayed session must still have life left',
  )
})

test('1.5 the session TTL constant still matches the shipped expires_at (drift guard)', async () => {
  const m = await load()
  const clean = cleanOf(STRIPE_LIB)
  assert.ok(
    clean.includes(`expires_at: Math.floor(Date.now() / 1000) + ${m.CHECKOUT_SESSION_TTL_MINUTES} * 60`),
    'src/lib/stripe.ts must still expire sessions after CHECKOUT_SESSION_TTL_MINUTES',
  )
})

test('1.6 createBookingCheckout passes the caller key through to Stripe', () => {
  const clean = cleanOf(STRIPE_LIB)
  const create = at(clean, 'checkout.sessions.create(', 'stripe lib')
  const key = clean.indexOf('idempotencyKey: params.idempotencyKey', create)
  assert.notEqual(key, -1, 'the key must reach checkout.sessions.create as a request option')
})

// ════════════════════════════════════════════════════════════════════════════
//  2. THE PREVIOUS SESSION — one payable session per booking
// ════════════════════════════════════════════════════════════════════════════

test('2.1 MANUAL CAPTURE: a completed session is "authorized" even though payment_status is unpaid', async () => {
  const m = await load()
  // This is the whole point. capture_method is 'manual', so Stripe leaves
  // payment_status 'unpaid' until the $49 is captured at approval. Reading
  // payment_status alone would call a live authorization "not paid" and mint a
  // SECOND one on top of it.
  assert.equal(m.previousSessionVerdict({ id: 'cs_1', status: 'complete', payment_status: 'unpaid' }), 'authorized')
  assert.equal(m.previousSessionVerdict({ id: 'cs_1', status: 'open', payment_status: 'unpaid' }), 'open')
  assert.equal(m.previousSessionVerdict({ id: 'cs_1', status: 'expired', payment_status: 'unpaid' }), 'gone')
  assert.equal(m.previousSessionVerdict(null), 'none')
  // A status Stripe has not invented yet is treated as LIVE, never as dead.
  assert.equal(m.previousSessionVerdict({ id: 'cs_1', status: 'something_new' }), 'open')
})

test('2.2 an OPEN session is expired before a replacement may be created', async () => {
  const m = await load()
  const { deps, calls } = fakeDeps({ retrieve: async () => ({ id: 'cs_old', status: 'open', payment_status: 'unpaid' }) })
  const out = await m.retirePreviousCheckoutSession(deps as never, { bookingId: 'bk_1', sessionId: 'cs_old' })
  assert.deepEqual(out, { ok: true, verdict: 'retired' })
  assert.deepEqual(calls.expired, ['cs_old'], 'exactly one expire, on the recorded session')
})

test('2.3 a COMPLETED session refuses the resume and is never expired', async () => {
  const m = await load()
  const { deps, calls } = fakeDeps({ retrieve: async () => ({ id: 'cs_old', status: 'complete', payment_status: 'unpaid' }) })
  const out = await m.retirePreviousCheckoutSession(deps as never, { bookingId: 'bk_1', sessionId: 'cs_old' })
  assert.equal(out.ok, false)
  assert.equal(out.verdict, 'authorized')
  assert.deepEqual(calls.expired, [], 'a completed session must not be touched')
  assert.ok(calls.logs.some((l) => l.level === 'error'), 'the condition must be logged as an error')
})

test('2.4 a Stripe read failure refuses rather than risking two live authorizations', async () => {
  const m = await load()
  const { deps, calls } = fakeDeps({
    retrieve: async () => {
      throw new Error('Stripe API is currently unavailable (503)')
    },
  })
  const out = await m.retirePreviousCheckoutSession(deps as never, { bookingId: 'bk_1', sessionId: 'cs_old' })
  assert.equal(out.ok, false)
  assert.equal(out.verdict, 'unverified')
  assert.deepEqual(calls.expired, [], 'nothing may be assumed about a session we could not read')
})

test('2.5 an expire failure also refuses — "retired" is only ever said when Stripe accepted it', async () => {
  const m = await load()
  const { deps } = fakeDeps({
    retrieve: async () => ({ id: 'cs_old', status: 'open' }),
    expire: async () => {
      throw new Error('rate limited')
    },
  })
  const out = await m.retirePreviousCheckoutSession(deps as never, { bookingId: 'bk_1', sessionId: 'cs_old' })
  assert.equal(out.ok, false)
  assert.equal(out.verdict, 'unverified')
})

test('2.6 a booking with no recorded session makes no Stripe calls at all', async () => {
  const m = await load()
  for (const sessionId of [null, undefined, '', '   ']) {
    const { deps, calls } = fakeDeps()
    const out = await m.retirePreviousCheckoutSession(deps as never, { bookingId: 'bk_1', sessionId })
    assert.deepEqual(out, { ok: true, verdict: 'none' })
    assert.deepEqual(calls.retrieved, [])
    assert.deepEqual(calls.expired, [])
  }
})

test('2.7 a session Stripe no longer knows about is not an obstacle', async () => {
  const m = await load()
  const { deps, calls } = fakeDeps({ retrieve: async () => null })
  const out = await m.retirePreviousCheckoutSession(deps as never, { bookingId: 'bk_1', sessionId: 'cs_gone' })
  assert.equal(out.ok, true)
  assert.deepEqual(calls.expired, [])
})

// ════════════════════════════════════════════════════════════════════════════
//  3. RECORDING — and what happens when it fails
// ════════════════════════════════════════════════════════════════════════════

test('3.1 a successful record reports true and writes the session id once', async () => {
  const m = await load()
  const { deps, calls } = fakeDeps()
  assert.equal(await m.recordCheckoutSession(deps as never, { bookingId: 'bk_1', sessionId: 'cs_new' }), true)
  assert.deepEqual(calls.recorded, [{ bookingId: 'bk_1', sessionId: 'cs_new' }])
})

test('3.2 a failed record reports false and NEVER throws (the caller owns the consequence)', async () => {
  const m = await load()
  const { deps, calls } = fakeDeps({
    record: async () => {
      throw Object.assign(new Error("Can't reach database server"), { code: 'P1001' })
    },
  })
  assert.equal(await m.recordCheckoutSession(deps as never, { bookingId: 'bk_1', sessionId: 'cs_new' }), false)
  assert.ok(calls.logs.some((l) => l.level === 'error'))
})

test('3.3 the shipped recorder writes ONLY the session id, with a select (P0-E rule)', async () => {
  const m = await load()
  db = { updates: [] }
  await m.defaultCheckoutSessionDeps().recordSessionId('bk_1', 'cs_new')
  assert.equal(db.updates.length, 1)
  assert.deepEqual(db.updates[0].where, { id: 'bk_1' })
  assert.deepEqual(db.updates[0].data, { stripeCheckoutId: 'cs_new' }, 'the status is written by the create, not here')
  assert.deepEqual(db.updates[0].select, { id: true }, 'a write whose result is discarded must select')
})

test('3.4 the shipped recorder surfaces a database failure as false, not as a throw', async () => {
  const m = await load()
  db = { updates: [], updateError: Object.assign(new Error('P2022'), { code: 'P2022' }) }
  const deps = m.defaultCheckoutSessionDeps()
  const recorded = await m.recordCheckoutSession(
    { ...deps, log: { info() {}, warn() {}, error() {} } },
    { bookingId: 'bk_1', sessionId: 'cs_new' },
  )
  assert.equal(recorded, false)
  db = { updates: [] }
})

test('3.5 an unrecordable session is torn down, and the outcome is only what Stripe confirmed', async () => {
  const m = await load()
  const ok = fakeDeps()
  assert.equal(await m.abandonCheckoutSession(ok.deps as never, { bookingId: 'bk_1', sessionId: 'cs_new' }), 'yes')
  assert.deepEqual(ok.calls.expired, ['cs_new'])

  const bad = fakeDeps({
    expire: async () => {
      throw new Error('nope')
    },
  })
  assert.equal(await m.abandonCheckoutSession(bad.deps as never, { bookingId: 'bk_1', sessionId: 'cs_new' }), 'unknown')
})

// ════════════════════════════════════════════════════════════════════════════
//  4. ALERT COPY — no message may claim what the code cannot prove
// ════════════════════════════════════════════════════════════════════════════

const FORBIDDEN_CLAIMS = [
  'was captured',
  'has been captured',
  'was charged',
  'has been charged',
  'was refunded',
  'has been refunded',
  'was released',
  'has been released',
]

function textOf(draft: { title: string; lines: Array<{ message: string; action?: string }> }): string {
  return [draft.title, ...draft.lines.flatMap((l) => [l.message, l.action ?? ''])].join(' ').toLowerCase()
}

test('4.1 the completed-session alert names the facts and claims no money movement', async () => {
  const m = await load()
  const draft = m.authorizedSessionAlert({ bookingId: 'bk_1', displayId: 'WMIC-1042', sessionId: 'cs_old' })
  const text = textOf(draft)
  assert.ok(text.includes('wmic-1042'), 'the owner must be told WHICH booking')
  assert.ok(text.includes('cs_old'), 'and which session')
  for (const claim of FORBIDDEN_CLAIMS) {
    assert.equal(text.includes(claim), false, `alert claimed "${claim}" without proof`)
  }
  assert.ok(text.includes('stripe'), 'it must point at the one place the truth lives')
})

test('4.2 the unrecorded-session alert only says "expired" when Stripe confirmed the expiry', async () => {
  const m = await load()
  const base = { context: 'resume' as const, bookingId: 'bk_1', displayId: 'WMIC-1042', sessionId: 'cs_new' }

  const confirmed = textOf(m.unrecordedSessionAlert({ ...base, expired: 'yes', handedToCustomer: false }))
  assert.ok(confirmed.includes('expire'), 'a confirmed expiry may be stated')
  assert.ok(confirmed.includes('no longer be paid'))

  const unconfirmed = textOf(m.unrecordedSessionAlert({ ...base, expired: 'unknown', handedToCustomer: false }))
  assert.ok(unconfirmed.includes('not known'), 'an unconfirmed expiry must say so')
  assert.equal(
    /so it can no longer be paid/.test(unconfirmed),
    false,
    'an unconfirmed expiry must never claim the session is dead',
  )

  const kept = textOf(
    m.unrecordedSessionAlert({ ...base, context: 'public_create', expired: 'kept', handedToCustomer: true }),
  )
  assert.equal(/no longer be paid/.test(kept), false, 'the public form leaves the session OPEN — say so')
  assert.ok(kept.includes('customer was sent to this checkout page'))
})

test('4.3 every alert falls back to the internal id when there is no display id', async () => {
  const m = await load()
  assert.ok(textOf(m.authorizedSessionAlert({ bookingId: 'bk_1', sessionId: 'cs_1' })).includes('bk_1'))
  assert.ok(
    textOf(
      m.unrecordedSessionAlert({
        context: 'resume',
        bookingId: 'bk_1',
        displayId: '  ',
        sessionId: 'cs_1',
        expired: 'yes',
        handedToCustomer: false,
      }),
    ).includes('bk_1'),
  )
})

// ════════════════════════════════════════════════════════════════════════════
//  5. THE PUBLIC BOOKING ROUTE — born recoverable, and never stranded
// ════════════════════════════════════════════════════════════════════════════

test('5.1 the booking is CREATED in the awaiting-deposit state, not DRAFT', () => {
  const clean = cleanOf(PUBLIC_ROUTE)
  const values = valuesOf(PUBLIC_ROUTE)
  const create = at(clean, 'prisma.booking.create(', 'public route')
  const nextStatement = clean.indexOf('createBookingCheckout(', create)
  const createBlock = values.slice(create, nextStatement)
  assert.ok(
    /status:\s*'PENDING_PAYMENT'/.test(createBlock),
    'the create must write PENDING_PAYMENT — DRAFT is the one status nothing can recover',
  )
  assert.equal(
    /status:\s*'DRAFT'/.test(createBlock),
    false,
    'a DRAFT booking is invisible to resume, to the abandoned-checkout worker and to the recovery journey',
  )
})

test('5.2 the session id is recorded INSIDE a guard, and a failure returns no error to the customer', () => {
  const clean = cleanOf(PUBLIC_ROUTE)
  const record = at(clean, 'recordCheckoutSession(', 'public route')
  assert.ok(
    tryDepthAt(clean, record) > 0,
    'recording the session must not be able to throw past the response — that WAS the blocker',
  )
  // Nothing between the Stripe session and the response may return an error.
  const created = at(clean, 'createBookingCheckout(', 'public route')
  const response = at(clean, 'checkoutUrl: checkoutSession.url', 'public route')
  const tail = valuesOf(PUBLIC_ROUTE).slice(created, response)
  const rollback = tail.indexOf("return NextResponse.json({ error: 'Failed to initialize payment' }")
  const errorReturns = tail.match(/return\s+NextResponse\.json\(\s*\{\s*error/g) ?? []
  assert.equal(
    errorReturns.length,
    rollback === -1 ? 0 : 1,
    'the ONLY error return after a session exists is the Stripe-creation rollback',
  )
})

test('5.3 there is no unguarded booking.update left between the session and the response', () => {
  const clean = cleanOf(PUBLIC_ROUTE)
  const created = at(clean, 'createBookingCheckout(', 'public route')
  const response = at(clean, 'checkoutUrl: checkoutSession.url', 'public route')
  for (let i = clean.indexOf('prisma.booking.update(', created); i !== -1 && i < response; ) {
    assert.ok(tryDepthAt(clean, i) > 0, 'every write after the Stripe session must be guarded')
    i = clean.indexOf('prisma.booking.update(', i + 1)
  }
})

test('5.4 the owner alert and the lifecycle hand-over are both unskippable', () => {
  const clean = cleanOf(PUBLIC_ROUTE)
  const handover = at(clean, 'onBookingCreated(', 'public route')
  const notify = at(clean, 'notifyBookingCreated(', 'public route')
  assert.ok(tryDepthAt(clean, handover) > 0, 'the lifecycle hand-over must not be able to skip the owner alert')
  assert.ok(tryDepthAt(clean, notify) > 0, 'the owner alert is the only signal Diego gets — it must be guarded')
  const record = at(clean, 'recordCheckoutSession(', 'public route')
  assert.ok(record < handover && handover < notify, 'the tail must still run in its documented order')
})

test('5.5 the public session is created with an idempotency key derived from the booking', () => {
  const clean = cleanOf(PUBLIC_ROUTE)
  const created = at(clean, 'createBookingCheckout(', 'public route')
  const args = clean.slice(created, clean.indexOf('} catch', created))
  assert.ok(/idempotencyKey:\s*checkoutIdempotencyKey\(\{\s*bookingId:\s*booking\.id/.test(args))
})

// ════════════════════════════════════════════════════════════════════════════
//  6. THE RESUME ROUTE — the money-shaped half
// ════════════════════════════════════════════════════════════════════════════

test('6.1 the recorded session is read from the database — otherwise nothing can be retired', () => {
  const clean = cleanOf(RESUME_ROUTE)
  const select = at(clean, 'select: {', 'resume route')
  const read = clean.slice(select, clean.indexOf('})', select))
  assert.ok(/stripeCheckoutId:\s*true/.test(read), 'the route must load the session it may have to expire')
})

test('6.2 the previous session is retired BEFORE a new one is created', () => {
  const clean = cleanOf(RESUME_ROUTE)
  const retire = at(clean, 'retirePreviousCheckoutSession(', 'resume route')
  const create = at(clean, 'createBookingCheckout(', 'resume route')
  assert.ok(retire < create, 'two payable $49 authorizations must never be able to coexist')
  // and the retire verdict must be able to stop the create
  const between = clean.slice(retire, create)
  assert.ok(/if\s*\(\s*!\s*retired\.ok\s*\)/.test(between), 'a refusal must short-circuit before the create')
  assert.ok(/return\s+NextResponse\.redirect/.test(between), 'and return without creating a session')
})

test('6.3 the retire call is fed the session recorded on THIS booking', () => {
  const clean = cleanOf(RESUME_ROUTE)
  const retire = at(clean, 'retirePreviousCheckoutSession(', 'resume route')
  const args = clean.slice(retire, clean.indexOf('})', retire))
  assert.ok(/sessionId:\s*booking\.stripeCheckoutId/.test(args))
})

test('6.4 the customer is redirected to a session only AFTER it is recorded', () => {
  const clean = cleanOf(RESUME_ROUTE)
  const record = at(clean, 'recordCheckoutSession(', 'resume route')
  const redirect = at(clean, 'NextResponse.redirect(session.url', 'resume route')
  assert.ok(record < redirect, 'an unrecorded session is one nothing can expire, see or reconcile')
  const between = clean.slice(record, redirect)
  assert.ok(/if\s*\(\s*!\s*recorded\s*\)/.test(between), 'a failed record must be handled, not ignored')
  assert.ok(/abandonCheckoutSession\(/.test(between), 'and the unrecordable session must be torn down')
})

test('6.5 an already-completed session alerts the owner instead of creating a second one', () => {
  const clean = cleanOf(RESUME_ROUTE)
  const retire = at(clean, 'retirePreviousCheckoutSession(', 'resume route')
  const create = at(clean, 'createBookingCheckout(', 'resume route')
  const between = valuesOf(RESUME_ROUTE).slice(retire, create)
  assert.ok(/verdict\s*===\s*'authorized'/.test(between), 'the completed case must be recognised')
  assert.ok(/authorizedSessionAlert\(/.test(between), 'and reported to a human')
  assert.ok(/deps\.alert\(/.test(between), 'the alert must actually be posted')
})

test('6.6 the resume session carries an idempotency key that includes the session it replaces', () => {
  const clean = cleanOf(RESUME_ROUTE)
  const create = at(clean, 'createBookingCheckout(', 'resume route')
  const args = clean.slice(create, clean.indexOf('\n    })', create))
  assert.ok(/idempotencyKey:\s*checkoutIdempotencyKey\(\{/.test(args))
  assert.ok(/previousSessionId:\s*booking\.stripeCheckoutId/.test(args))
})

test('6.8 only pre-payment statuses can be resumed, and internal tests are refused first', () => {
  const clean = cleanOf(RESUME_ROUTE)
  const values = valuesOf(RESUME_ROUTE)
  const decl = at(clean, 'const RESUMABLE_STATUSES', 'resume route')
  const list = values.slice(decl, values.indexOf('\n', clean.indexOf(']', decl)))
  assert.ok(/'PENDING_PAYMENT'/.test(list), 'the normal awaiting-deposit status')
  assert.ok(
    /'DRAFT'/.test(list),
    'bookings stranded in DRAFT by B9 are pre-payment and must have a repair path',
  )
  for (const advanced of ['PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ARCHIVED']) {
    assert.equal(
      list.includes(`'${advanced}'`),
      false,
      `${advanced} is past payment — resuming it would walk a customer into a second authorization`,
    )
  }
  // The DRAFT rows this system creates ON PURPOSE are owner test bookings, so
  // that refusal must come first or the repair path would re-open them.
  assert.ok(
    at(clean, 'booking.isInternalTest', 'resume route') < at(clean, 'RESUMABLE_STATUSES.includes', 'resume route'),
    'internal test bookings must be refused before the status gate',
  )
})

test('6.7 the shipped double-charge guards are still in front of everything', () => {
  const clean = cleanOf(RESUME_ROUTE)
  const paid = at(clean, 'booking.depositPaid ||', 'resume route')
  const retire = at(clean, 'retirePreviousCheckoutSession(', 'resume route')
  assert.ok(paid < retire, 'a paid booking must be refused before Stripe is touched at all')
  assert.ok(clean.includes('isInternalTest'), 'internal test bookings stay refused')
  assert.equal(/capture_method/.test(clean), false, 'this route must never take money')
})
