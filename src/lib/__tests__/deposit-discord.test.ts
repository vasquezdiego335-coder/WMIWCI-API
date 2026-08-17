import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildDepositPaidEmbed,
  buildTestEmbed,
  depositNotifyConfig,
  sendPaymentEmbed,
  postWithRetry,
  scrub,
  avatarUrl,
  DEFAULT_PAYMENTS_CHANNEL_ID,
  EMBED_COLOR,
  WEBHOOK_USERNAME,
} from '../deposit-notify'

// ════════════════════════════════════════════════════════════════════════════
//  The confirmed-deposit Discord card: what it says, what it must never say,
//  where it goes, and how it behaves when Discord is rate-limiting or down.
//
//  This file imports deposit-notify.ts, which touches no database and no queue,
//  so every path below runs offline against a stub `fetch`.
// ════════════════════════════════════════════════════════════════════════════

const noSleep = async () => {}

/** Restore every env key this file mutates, whatever the test did. */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k]
    if (patch[k] === undefined) delete process.env[k]
    else process.env[k] = patch[k] as string
  }
  try {
    return fn()
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k] as string
    }
  }
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

// ── The destination ─────────────────────────────────────────────────────────

test('the owner-specified channel is the documented default destination', () => {
  // The channel the owner named in the specification. A channel id is not a
  // secret — it is public inside the server — so it lives in code as a default
  // and stays overridable by env.
  assert.equal(DEFAULT_PAYMENTS_CHANNEL_ID, '1524853745064869990')
})

test('a channel id ALONE is not configuration — it cannot authenticate anything', () => {
  withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: undefined, DISCORD_BOT_TOKEN: undefined, DISCORD_PAYMENTS_CHANNEL_ID: '1524853745064869990' }, () => {
    const cfg = depositNotifyConfig()
    assert.equal(cfg.configured, false, 'a channel id without a credential is NOT configured')
    assert.equal(cfg.transport, null)
    assert.equal(cfg.channelId, '1524853745064869990')
    assert.match(cfg.reason ?? '', /cannot authenticate/i)
  })
})

test('a webhook URL is preferred; a bot token is the fallback', () => {
  withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc', DISCORD_BOT_TOKEN: 'aaa.bbb.ccc' }, () => {
    assert.equal(depositNotifyConfig().transport, 'webhook')
  })
  withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: undefined, DISCORD_BOT_TOKEN: 'aaa.bbb.ccc' }, () => {
    const cfg = depositNotifyConfig()
    assert.equal(cfg.transport, 'bot')
    assert.equal(cfg.configured, true)
  })
})

test('a placeholder env value is treated as absent, not as configuration', () => {
  withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: 'REPLACE_ME', DISCORD_BOT_TOKEN: '' }, () => {
    assert.equal(depositNotifyConfig().configured, false)
  })
})

// ── The card ────────────────────────────────────────────────────────────────

const PAID_AT = new Date('2026-08-15T19:04:00Z')

const fullEmbed = () =>
  buildDepositPaidEmbed({
    customerName: 'Natalia Reyes',
    amountPaidCents: 4900,
    quoteTotalCents: 49500,
    remainingCents: 44600,
    moveDate: new Date('2026-08-16T14:00:00Z'),
    bookingReference: 'WMIC-1019',
    paidAt: PAID_AT,
    livemode: true,
    adminUrl: 'https://admin.example/admin/bookings',
  })

const fieldValue = (embed: Record<string, unknown>, name: string): string | undefined =>
  (embed.fields as Array<{ name: string; value: string }>).find((f) => f.name === name)?.value

test('the card carries the owner-specified layout and the brand accent', () => {
  const e = fullEmbed()
  assert.equal(e.title, '✅ Deposit Paid')
  assert.equal(e.color, EMBED_COLOR)
  assert.equal(EMBED_COLOR, 0xff5a1f, 'brand orange #FF5A1F')
  assert.equal((e.footer as { text: string }).text, 'Stripe-confirmed payment • Move It Clear It')
  assert.equal(typeof e.timestamp, 'string')
  assert.equal(e.url, 'https://admin.example/admin/bookings')

  assert.equal(fieldValue(e, 'Customer'), 'Natalia')
  assert.equal(fieldValue(e, 'Deposit received'), '$49.00')
  assert.equal(fieldValue(e, 'Quote total'), '$495.00')
  assert.equal(fieldValue(e, 'Remaining balance'), '$446.00')
  assert.equal(fieldValue(e, 'Move date'), 'August 16, 2026')
  assert.equal(fieldValue(e, 'Booking'), 'WMIC-1019')
  assert.equal(fieldValue(e, 'Payment status'), 'Confirmed')
  assert.match(fieldValue(e, 'Payment time') ?? '', /ET$/, 'the time is in the company timezone')
  assert.match(fieldValue(e, 'Open booking') ?? '', /^\[View in admin\]\(https:\/\//)
})

test('TEST MODE is unmistakable on the card', () => {
  const e = buildDepositPaidEmbed({ amountPaidCents: 4900, livemode: false })
  assert.equal(e.title, '🧪 TEST — Deposit Paid')
})

test('an UNKNOWN field is OMITTED — never "undefined", never a misleading $0.00', () => {
  const e = buildDepositPaidEmbed({ amountPaidCents: 4900, livemode: true })
  const names = (e.fields as Array<{ name: string }>).map((f) => f.name)
  assert.ok(!names.includes('Quote total'))
  assert.ok(!names.includes('Remaining balance'))
  assert.ok(!names.includes('Move date'))
  assert.ok(!names.includes('Booking'))
  assert.ok(!names.includes('Customer'))
  assert.ok(!names.includes('Open booking'))
  const json = JSON.stringify(e)
  assert.ok(!json.includes('undefined'), 'no "undefined" anywhere in the payload')
  assert.ok(!/\$0\.00/.test(json), 'no placeholder $0.00')
  // What IS known is still there.
  assert.equal(fieldValue(e, 'Deposit received'), '$49.00')
})

test('the card NEVER carries an address, contact detail, token or Stripe id', () => {
  const e = buildDepositPaidEmbed({
    customerName: 'Natalia Reyes',
    amountPaidCents: 4900,
    quoteTotalCents: 49500,
    remainingCents: 44600,
    bookingReference: 'WMIC-1019',
    paidAt: PAID_AT,
    livemode: true,
    adminUrl: 'https://admin.example/admin/bookings',
  })
  const json = JSON.stringify(e).toLowerCase()
  for (const forbidden of ['@', 'street', 'ave', 'sk_live', 'sk_test', 'cs_', 'pi_', 'whsec', 'card', '862']) {
    assert.ok(!json.includes(forbidden), `"${forbidden}" must never appear on the card`)
  }
  // The public deposit token is not on the card: it is a payment credential and
  // anyone in the channel could otherwise open the customer's payment page.
  assert.ok(!json.includes('deposit/'))
})

test('customer-entered text cannot ping the server from the card', () => {
  const e = buildDepositPaidEmbed({ customerName: '@everyone Natalia', amountPaidCents: 4900, livemode: true })
  const customer = fieldValue(e, 'Customer') ?? ''
  // The literal, pingable "@everyone" must not survive into the payload.
  assert.ok(!/(^|[^​])@everyone/.test(customer), `"${customer}" must not contain a live @everyone`)
})

test('the test card says TEST and states that it is not a payment', () => {
  const e = buildTestEmbed('Diego')
  assert.match(e.title as string, /TEST/)
  assert.match(e.description as string, /No payment was created, changed or refunded/i)
  assert.equal(fieldValue(e, 'Payment status'), 'Not a payment')
  assert.equal((e.footer as { text: string }).text, 'Test message • Move It Clear It')
})

// ── Delivery ────────────────────────────────────────────────────────────────

test('mentions are DISABLED on every send, by structure not by hope', async () => {
  const bodies: string[] = []
  const stub: typeof fetch = async (_url, init) => {
    bodies.push(String((init as RequestInit).body))
    return jsonResponse(200, { id: 'msg_1' })
  }

  await withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc', DISCORD_BOT_TOKEN: undefined }, () =>
    sendPaymentEmbed(fullEmbed(), { fetchImpl: stub, sleepImpl: noSleep })
  )
  await withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: undefined, DISCORD_BOT_TOKEN: 'aaa.bbb.ccc' }, () =>
    sendPaymentEmbed(fullEmbed(), { fetchImpl: stub, sleepImpl: noSleep })
  )

  assert.equal(bodies.length, 2, 'both transports were exercised')
  for (const body of bodies) {
    const parsed = JSON.parse(body) as { allowed_mentions?: { parse?: string[] } }
    assert.deepEqual(parsed.allowed_mentions, { parse: [] }, 'allowed_mentions must disable everything')
  }
})

test('the webhook transport carries the owner-specified name and the logo avatar', async () => {
  let body: Record<string, unknown> = {}
  const stub: typeof fetch = async (_url, init) => {
    body = JSON.parse(String((init as RequestInit).body))
    return jsonResponse(200, { id: 'msg_9' })
  }
  const result = await withEnv(
    { DISCORD_PAYMENTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc', APP_URL: 'https://app.example' },
    () => sendPaymentEmbed(fullEmbed(), { fetchImpl: stub, sleepImpl: noSleep })
  )
  assert.equal(result.delivered, true)
  assert.equal(result.messageId, 'msg_9')
  assert.equal(body.username, WEBHOOK_USERNAME)
  assert.equal(WEBHOOK_USERNAME, 'Move It Clear It Payments')
  assert.equal(body.avatar_url, 'https://app.example/logo/icon.png')
})

test('the bot transport posts to the configured channel with bot auth', async () => {
  let seenUrl = ''
  let auth = ''
  const stub: typeof fetch = async (url, init) => {
    seenUrl = String(url)
    auth = String((init as RequestInit).headers ? ((init as RequestInit).headers as Record<string, string>).Authorization : '')
    return jsonResponse(200, { id: 'msg_2' })
  }
  const result = await withEnv(
    { DISCORD_PAYMENTS_WEBHOOK_URL: undefined, DISCORD_BOT_TOKEN: 'aaa.bbb.ccc', DISCORD_PAYMENTS_CHANNEL_ID: undefined },
    () => sendPaymentEmbed(fullEmbed(), { fetchImpl: stub, sleepImpl: noSleep })
  )
  assert.equal(result.delivered, true)
  assert.equal(result.transport, 'bot')
  assert.ok(seenUrl.endsWith(`/channels/${DEFAULT_PAYMENTS_CHANNEL_ID}/messages`), `posted to ${seenUrl}`)
  assert.equal(auth, 'Bot aaa.bbb.ccc')
})

test('with nothing configured, delivery FAILS honestly instead of pretending', async () => {
  let called = false
  const stub: typeof fetch = async () => {
    called = true
    return jsonResponse(200, {})
  }
  const result = await withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: undefined, DISCORD_BOT_TOKEN: undefined }, () =>
    sendPaymentEmbed(fullEmbed(), { fetchImpl: stub, sleepImpl: noSleep })
  )
  assert.equal(called, false, 'no request is attempted without a credential')
  assert.equal(result.delivered, false)
  assert.equal(result.transport, null)
  assert.match(result.error ?? '', /webhook|bot token/i)
})

// ── Rate limits and retries ─────────────────────────────────────────────────

test('a 429 is retried after the Retry-After Discord names', async () => {
  let calls = 0
  const stub: typeof fetch = async () => {
    calls++
    if (calls === 1) return jsonResponse(429, { retry_after: 1.5 }, { 'retry-after': '2' })
    return jsonResponse(200, { id: 'msg_3' })
  }
  const waits: number[] = []
  const result = await withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, () =>
    sendPaymentEmbed(fullEmbed(), {
      fetchImpl: stub,
      sleepImpl: async (ms) => {
        waits.push(ms)
      },
    })
  )
  assert.equal(result.delivered, true)
  assert.equal(calls, 2)
  // The BODY value (1.5s, more precise) wins over the header (2s).
  assert.deepEqual(waits, [1500])
})

test('a pathological Retry-After is CAPPED so a worker cannot hang', async () => {
  const stub: typeof fetch = async () => jsonResponse(429, { retry_after: 86_400 })
  const waits: number[] = []
  const result = await withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, () =>
    sendPaymentEmbed(fullEmbed(), { fetchImpl: stub, sleepImpl: async (ms) => void waits.push(ms) })
  )
  assert.equal(result.delivered, false)
  for (const w of waits) assert.ok(w <= 10_000, `wait ${w}ms must be capped`)
})

test('a 5xx is retried with backoff; a persistent one gives up bounded', async () => {
  let calls = 0
  const stub: typeof fetch = async () => {
    calls++
    return jsonResponse(503, {})
  }
  const result = await withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, () =>
    sendPaymentEmbed(fullEmbed(), { fetchImpl: stub, sleepImpl: noSleep })
  )
  assert.equal(result.delivered, false)
  assert.equal(calls, 3, 'bounded at 3 attempts — not an infinite loop')
  assert.equal(result.attempts, 3)
})

test('a transient 5xx that then succeeds is delivered', async () => {
  let calls = 0
  const stub: typeof fetch = async () => {
    calls++
    return calls < 3 ? jsonResponse(500, {}) : jsonResponse(200, { id: 'msg_4' })
  }
  const result = await withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, () =>
    sendPaymentEmbed(fullEmbed(), { fetchImpl: stub, sleepImpl: noSleep })
  )
  assert.equal(result.delivered, true)
  assert.equal(result.messageId, 'msg_4')
})

test('a network error is retried, then reported', async () => {
  let calls = 0
  const stub: typeof fetch = async () => {
    calls++
    throw new Error('ECONNRESET')
  }
  const result = await withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, () =>
    sendPaymentEmbed(fullEmbed(), { fetchImpl: stub, sleepImpl: noSleep })
  )
  assert.equal(result.delivered, false)
  assert.equal(calls, 3)
  assert.match(result.error ?? '', /ECONNRESET/)
})

test('a permanent 4xx is NOT retried — it would fail identically forever', async () => {
  let calls = 0
  const stub: typeof fetch = async () => {
    calls++
    return new Response('Unknown Channel', { status: 404 })
  }
  const result = await withEnv({ DISCORD_PAYMENTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, () =>
    sendPaymentEmbed(fullEmbed(), { fetchImpl: stub, sleepImpl: noSleep })
  )
  assert.equal(result.delivered, false)
  assert.equal(calls, 1)
})

test('postWithRetry backs off exponentially and bounds the wait', async () => {
  const waits: number[] = []
  const r = await postWithRetry(async () => jsonResponse(500, {}), 4, async (ms) => void waits.push(ms))
  assert.equal(r.ok, false)
  assert.deepEqual(waits, [500, 1000, 2000])
})

// ── Secret hygiene ──────────────────────────────────────────────────────────

test('a webhook URL or bot token can never reach a log, the DB or a screen', () => {
  const leak = 'failed to POST https://discord.com/api/webhooks/123456789/abcDEF-ghiJKL_mnoPQR'
  const cleaned = scrub(leak)
  assert.ok(!cleaned.includes('abcDEF'), 'the webhook secret must be redacted')
  assert.match(cleaned, /\[discord webhook url redacted\]/)

  // The fake token is ASSEMBLED at run time rather than written as a literal.
  // A token-shaped string in source trips GitHub's push protection — correctly,
  // because a scanner cannot tell a specimen from the real thing. Building it
  // from parts keeps the assertion honest (scrub still sees a full
  // three-segment token) without committing anything that looks like a secret.
  const fakeToken = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GhIjKl', 'abcdefghijklmnopqrstuvwxyz123'].join('.')
  assert.match(scrub(`Bot ${fakeToken} rejected`), /\[token redacted\]/)

  // And it is length-bounded, so a huge provider error cannot fill a column.
  assert.ok(scrub('x'.repeat(5000)).length <= 300)
})

test('the avatar is an absolute, public URL', () => {
  withEnv({ DISCORD_PAYMENTS_AVATAR_URL: undefined, APP_URL: 'https://app.example/' }, () => {
    assert.equal(avatarUrl(), 'https://app.example/logo/icon.png')
  })
  withEnv({ DISCORD_PAYMENTS_AVATAR_URL: 'https://cdn.example/logo.png' }, () => {
    assert.equal(avatarUrl(), 'https://cdn.example/logo.png')
  })
})

// ── Wiring guarantees, asserted against the SOURCE ──────────────────────────
//
// These are the rules that cannot be proven by calling a function, because the
// thing being asserted is WHERE a call sits relative to another one.

const read = (p: string): string => readFileSync(resolve(__dirname, '../../..', p), 'utf8')
/** Source with `//` comments stripped, so prose cannot satisfy a rule about code. */
const code = (p: string): string =>
  read(p)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')

test('the notification is queued ONLY after the payment was applied', () => {
  const src = code('src/lib/stripe-events.ts')
  const gateIdx = src.indexOf('isConfirmedDepositSession')
  const applyIdx = src.indexOf('markDepositPaid({')
  const guardIdx = src.indexOf('if (!result.applied)')
  const notifyIdx = src.indexOf('queueDepositNotification')

  assert.ok(gateIdx > -1 && applyIdx > -1 && guardIdx > -1 && notifyIdx > -1, 'all four steps must exist')
  assert.ok(gateIdx < applyIdx, 'the paid gate must precede the ledger write')
  assert.ok(applyIdx < guardIdx, 'the already-applied guard follows the write')
  assert.ok(guardIdx < notifyIdx, 'the notification is queued only past that guard')
})

test('a duplicate Stripe event produces NO second Discord message', () => {
  const src = code('src/lib/stripe-events.ts')
  // The early return on !applied is what stops a replayed event notifying twice.
  assert.match(src, /if \(!result\.applied\)[\s\S]{0,400}?return/, 'an unapplied (duplicate) event must return before notifying')

  // And a second, independent lock: the delivery itself claims the row.
  const deliver = code('src/lib/discord-payments.ts')
  const claimIdx = deliver.indexOf('claimDiscordNotification(')
  const sendIdx = deliver.indexOf('sendPaymentEmbed(')
  assert.ok(claimIdx > -1 && sendIdx > -1)
  assert.ok(claimIdx < sendIdx, 'the exactly-once claim must precede the send')
  assert.match(deliver, /if \(!claimed\) return/, 'a lost claim must return without sending')
})

test('a Discord failure can never roll back or delay the payment', () => {
  const src = code('src/lib/stripe-events.ts')
  // The notify call is OUTSIDE the transaction and its rejection is swallowed.
  assert.match(src, /queueDepositNotification\([\s\S]{0,120}?\.catch\(/, 'the notify call must be .catch()-guarded')
  assert.ok(!/await prisma\.\$transaction[\s\S]*queueDepositNotification/.test(src), 'notification must not sit inside the money transaction')

  const service = code('src/lib/deposit-service.ts')
  assert.ok(
    !service.includes('sendPaymentEmbed') && !service.includes('discordQueue'),
    'the transactional money path must not call Discord at all'
  )
})

test('the deposit-paid worker case retries on real failure and never on a skip', () => {
  const worker = code('src/workers/discord.worker.ts')
  assert.match(worker, /case 'deposit-paid'/)
  assert.match(worker, /deliverDepositNotification/)
  assert.match(worker, /if \(!outcome\.delivered && !outcome\.skipped\)[\s\S]{0,200}?throw new Error/)
})

test('the TEST notification route cannot touch a payment record', () => {
  const src = read('app/api/admin/deposit-links/test-notification/route.ts')
  // Not "is careful not to write" — there is no database client in the file at all.
  assert.ok(!src.includes('@/lib/db'), 'the test route must not import prisma')
  assert.ok(!src.includes('prisma.'), 'the test route must not use prisma')
  assert.ok(!src.includes('markDepositPaid'), 'the test route must not apply a payment')
  assert.match(src, /buildTestEmbed/, 'it must send the TEST card')
  assert.match(src, /deposit\.notify_test/, 'it must check the permission')
})
