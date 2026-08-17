// ════════════════════════════════════════════════════════════════════════
//  R6 — THE SCHEDULED MONEY DETECTOR WAS DEAD ON ARRIVAL (2026-08-15)
//  ---------------------------------------------------------------------
//  `vercel.json` runs the payment reconciliation daily. The route requires
//  `CRON_SECRET` — which appeared NOWHERE else in the repo: not in
//  `.env.example` (19KB and otherwise exhaustive), not in DEPLOY.md, not in the
//  runbook. So the schedule 403'd every day and left one log line, and every
//  detection credited to the B1 repair never ran. A refused schedule is
//  indistinguishable from a clean day, which is what makes it a MONITORING
//  OUTAGE rather than a config nit.
//
//  Two halves are tested here, both against shipped artefacts:
//    1. DOCUMENTED — the variable is named everywhere the other variables are,
//       and each place states what does not run until it is set. The check is
//       derived from `vercel.json`, so adding a schedule without documenting it
//       fails; and the placeholder in `.env.example` is fed to the real
//       authorizer to prove that copying the example never authenticates.
//    2. ALERTED — a refused scheduled run reaches the ops channel. The route
//       handler is driven for real, with `fetch` stubbed at the boundary, so
//       this proves the wiring and not a comment.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isScheduledRunAuthorized } from '../reconciliation'
import {
  alertScheduledRefusal,
  classifyScheduledRefusal,
  resetScheduledRefusalThrottle,
} from '../scheduled-run-guard'

const ROOT = join(__dirname, '..', '..', '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

// ════════════════════════════════════════════════════════════════════════
//  1. DOCUMENTED — everywhere the other variables are.
// ════════════════════════════════════════════════════════════════════════

test('R6: CRON_SECRET is documented in .env.example, DEPLOY.md, the runbook and ARCHITECTURE', () => {
  for (const file of ['.env.example', 'DEPLOY.md', 'docs/deployment.md', 'ARCHITECTURE.md']) {
    const text = read(...file.split('/'))
    assert.ok(text.includes('CRON_SECRET'), `${file} never mentions CRON_SECRET`)
  }
  // ...and .env.example carries it as a real, copyable entry, not just prose.
  assert.match(read('.env.example'), /^CRON_SECRET=/m, '.env.example must carry the variable itself')
})

test('R6: each place states what does NOT run until it is set', () => {
  // The failure this variable causes is silent, so naming the variable is not
  // enough — the cost has to be written down next to it.
  const claims = [/no Payment row|Payment` row|Payment row/i, /captur/i]
  for (const file of ['.env.example', 'DEPLOY.md', 'docs/deployment.md', 'ARCHITECTURE.md']) {
    const text = read(...file.split('/'))
    const section = text.slice(Math.max(0, text.indexOf('CRON_SECRET') - 2000))
    for (const claim of claims) {
      assert.match(section, claim, `${file} names CRON_SECRET but not what stops working`)
    }
  }
})

test('R6: every schedule in vercel.json is documented by path (derived, not typed)', () => {
  const vercel = JSON.parse(read('vercel.json')) as { crons?: Array<{ path: string; schedule: string }> }
  const crons = vercel.crons ?? []
  assert.ok(crons.length > 0, 'this guard is pointless if the crons block is gone — remove it deliberately')
  for (const cron of crons) {
    for (const file of ['DEPLOY.md', 'docs/deployment.md']) {
      assert.ok(
        read(...file.split('/')).includes(cron.path),
        `${file} does not mention the scheduled endpoint ${cron.path}`,
      )
    }
  }
})

test('R6: the .env.example value cannot authenticate — copying the example is not configuring it', () => {
  const line = read('.env.example').split(/\r?\n/).find((l) => l.startsWith('CRON_SECRET='))
  assert.ok(line, 'CRON_SECRET= not found in .env.example')
  const placeholder = line!.slice('CRON_SECRET='.length).trim()
  assert.equal(
    isScheduledRunAuthorized(`Bearer ${placeholder}`, placeholder),
    false,
    'the shipped placeholder authenticates — an unconfigured deploy would look configured',
  )
})

test('R6: the runbook does not claim the daily check is running on a platform that ignores vercel.json', () => {
  // The service deploys on Railway (nixpacks.toml); `crons` in vercel.json only
  // run on Vercel. The runbook must say so rather than implying coverage.
  const runbook = read('docs', 'deployment.md')
  assert.match(runbook, /only run on Vercel/i, 'the platform caveat is the whole point of this section')
})

// ════════════════════════════════════════════════════════════════════════
//  2. CLASSIFICATION — who is a refused SCHEDULER, and who is just a visitor.
// ════════════════════════════════════════════════════════════════════════

test('R6: an authorized run is not a refusal', () => {
  assert.equal(
    classifyScheduledRefusal({ authHeader: 'Bearer x', userAgent: 'vercel-cron/1.0', secret: 'x', authorized: true }),
    null,
  )
})

test('R6: an ordinary browser hit is NOT a refused schedule (the channel stays usable)', () => {
  assert.equal(
    classifyScheduledRefusal({ authHeader: null, userAgent: 'Mozilla/5.0', secret: 'sec', authorized: false }),
    null,
  )
  assert.equal(classifyScheduledRefusal({ authorized: false }), null)
})

test('R6: Vercel Cron with no secret set ⇒ cron_secret_unset', () => {
  const r = classifyScheduledRefusal({
    authHeader: null,
    userAgent: 'vercel-cron/1.0',
    secret: undefined,
    authorized: false,
  })
  assert.equal(r?.reason, 'cron_secret_unset')
  assert.equal(r?.caller, 'vercel_cron')
  assert.equal(r?.secretPresent, false)
  assert.match(r!.action, /CRON_SECRET/)
})

test('R6: a presented credential that fails ⇒ credential_rejected, and the copy does not guess which rule', () => {
  const r = classifyScheduledRefusal({
    authHeader: 'Bearer wrong-value-wrong-value',
    userAgent: 'vercel-cron/1.0',
    secret: 'a-properly-long-secret-value',
    authorized: false,
  })
  assert.equal(r?.reason, 'credential_rejected')
  assert.equal(r?.secretPresent, true)
  // It must not assert "the secret is a placeholder" or "it is too short" — the
  // rule lives in reconciliation.ts and a second copy of it would drift.
  assert.match(r!.detail, /does not match CRON_SECRET, or CRON_SECRET is a placeholder or shorter/)
})

test('R6: a secret is set but the caller sent nothing ⇒ no_credential_presented', () => {
  const r = classifyScheduledRefusal({
    authHeader: '',
    userAgent: 'vercel-cron/1.0',
    secret: 'a-properly-long-secret-value',
    authorized: false,
  })
  assert.equal(r?.reason, 'no_credential_presented')
})

test('R6: a bearer credential from an unknown agent still counts as a scheduler', () => {
  const r = classifyScheduledRefusal({
    authHeader: 'Bearer something',
    userAgent: 'curl/8.0',
    secret: null,
    authorized: false,
  })
  assert.equal(r?.caller, 'bearer_credential')
  assert.equal(r?.reason, 'cron_secret_unset')
})

// ════════════════════════════════════════════════════════════════════════
//  3. ALERTING — the refusal reaches a human, and cannot flood or throw.
// ════════════════════════════════════════════════════════════════════════

const refusal = () =>
  classifyScheduledRefusal({ authHeader: null, userAgent: 'vercel-cron/1.0', secret: null, authorized: false })!

test('R6: a refused run posts an alert that names the cause and the cost', async () => {
  resetScheduledRefusalThrottle()
  const posted: Array<{ title: string; lines: Array<{ message: string; action?: string }> }> = []
  const res = await alertScheduledRefusal('Payment reconciliation', refusal(), async (title, lines) => {
    posted.push({ title, lines })
    return { delivered: true }
  })

  assert.deepEqual(res, { delivered: true, throttled: false })
  assert.equal(posted.length, 1)
  assert.match(posted[0].title, /Payment reconciliation REFUSED/)
  assert.match(posted[0].lines[0].message, /CRON_SECRET is not set/)
  // The cost, stated: this is the sentence that turns a config nit into an
  // incident the owner acts on.
  assert.match(JSON.stringify(posted[0].lines), /detected by nothing/)
  // ...and it claims nothing about what the report WOULD have found.
  assert.ok(!/found|issue|critical/i.test(JSON.stringify(posted[0].lines)))
})

test('R6: the same refusal does not flood the channel, and a DIFFERENT one still gets through', async () => {
  resetScheduledRefusalThrottle()
  let calls = 0
  const post = async () => {
    calls++
    return { delivered: true }
  }
  await alertScheduledRefusal('Payment reconciliation', refusal(), post)
  const second = await alertScheduledRefusal('Payment reconciliation', refusal(), post)
  assert.equal(calls, 1)
  assert.deepEqual(second, { delivered: false, throttled: true, reason: 'throttled' })

  const other = classifyScheduledRefusal({
    authHeader: 'Bearer nope',
    userAgent: 'vercel-cron/1.0',
    secret: 'a-properly-long-secret-value',
    authorized: false,
  })!
  await alertScheduledRefusal('Payment reconciliation', other, post)
  assert.equal(calls, 2, 'a different failure reason is a different incident')
})

test('R6: an undeliverable alert is reported as undeliverable, never as sent', async () => {
  resetScheduledRefusalThrottle()
  const res = await alertScheduledRefusal('Payment reconciliation', refusal(), async () => ({
    delivered: false,
    reason: 'DISCORD_BOT_TOKEN is not configured',
  }))
  assert.equal(res.delivered, false)
  assert.equal(res.throttled, false)
  assert.match(res.reason ?? '', /DISCORD_BOT_TOKEN/)
})

test('R6: alerting never throws — a broken sender cannot break the endpoint', async () => {
  resetScheduledRefusalThrottle()
  const res = await alertScheduledRefusal('Payment reconciliation', refusal(), async () => {
    throw new Error('channel exploded')
  })
  assert.deepEqual(res, { delivered: false, throttled: false, reason: 'channel exploded' })
})

// ════════════════════════════════════════════════════════════════════════
//  4. THE ROUTE — driven for real, with fetch stubbed at the boundary.
// ════════════════════════════════════════════════════════════════════════

type FetchCall = { url: string; body: string }

async function driveRoute(headers: Record<string, string>, env: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const calls: FetchCall[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => ({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({}),
    ...(calls.push({ url: String(url), body: String(init?.body ?? '') }) ? {} : {}),
  })) as unknown as typeof fetch

  resetScheduledRefusalThrottle()
  try {
    const { GET } = await import('../../../app/api/admin/reconciliation/route')
    const res = await GET(new Request('https://admin.test/api/admin/reconciliation', { headers }))
    return { res, calls }
  } finally {
    globalThis.fetch = realFetch
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('R6: a Vercel cron hit with no CRON_SECRET is refused 403 AND raises the ops alert', async () => {
  const { res, calls } = await driveRoute(
    { 'user-agent': 'vercel-cron/1.0' },
    {
      CRON_SECRET: undefined,
      DISCORD_BOT_TOKEN: 'bot-token-for-the-test',
      DISCORD_CHANNEL_ALERTS: '123456789',
    },
  )

  assert.equal(res.status, 403)
  assert.equal(calls.length, 1, 'exactly one alert was posted')
  assert.match(calls[0].url, /discord\.com\/api\/v10\/channels\/123456789\/messages/)
  assert.match(calls[0].body, /REFUSED/)
  assert.match(calls[0].body, /CRON_SECRET is not set/)
  // The 403 body stays generic: which credential rule failed is owner
  // information, not something to hand an unauthenticated caller.
  const body = (await res.json()) as { error?: string; reason?: string }
  assert.equal(body.reason, undefined)
  assert.match(body.error ?? '', /refused/i)
})

test('R6: the refusal is decided BEFORE any session lookup — a cron request never needs cookies', async () => {
  // Proof by construction: this test runs outside a Next request scope, where
  // getSession() throws. Reaching a 403 (rather than a rejection) means the
  // refusal branch answered first — which is what lets a scheduler be alerted
  // on at all.
  const { res } = await driveRoute({ 'user-agent': 'vercel-cron/1.0' }, { CRON_SECRET: undefined })
  assert.equal(res.status, 403)
})

test('R6: an ordinary unauthenticated visitor raises NO alert (it is not an outage)', async () => {
  // Same environment, no scheduler markers: the handler must fall through to the
  // owner-session check instead. Outside a request scope that lookup throws, and
  // that rejection is the evidence the refusal branch did NOT claim this one.
  const previous = process.env.CRON_SECRET
  delete process.env.CRON_SECRET
  const calls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url))
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) }
  }) as unknown as typeof fetch
  try {
    resetScheduledRefusalThrottle()
    const { GET } = await import('../../../app/api/admin/reconciliation/route')
    await assert.rejects(
      () => GET(new Request('https://admin.test/api/admin/reconciliation', { headers: { 'user-agent': 'Mozilla/5.0' } })),
      /request scope/,
      'a plain visitor must reach the session check, not the scheduled-refusal branch',
    )
    assert.equal(calls.length, 0, 'no ops alert may be raised for a browser hit')
  } finally {
    globalThis.fetch = realFetch
    if (previous === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previous
  }
})

test('R6: a VALID secret is not refused and raises no alert', async () => {
  const secret = 'a-properly-long-cron-secret-value'
  const { res, calls } = await driveRoute(
    { 'user-agent': 'vercel-cron/1.0', authorization: `Bearer ${secret}` },
    {
      CRON_SECRET: secret,
      DISCORD_BOT_TOKEN: 'bot-token-for-the-test',
      DISCORD_CHANNEL_ALERTS: '123456789',
      // No Stripe key here, so the RUN fails and the route answers 500. That is
      // fine: what this asserts is that authorization passed — 403 would mean
      // the scheduler was turned away.
      STRIPE_SECRET_KEY: undefined,
    },
  )
  assert.notEqual(res.status, 403)
  assert.equal(calls.length, 0, 'an authorized run must not report a refusal')
})
