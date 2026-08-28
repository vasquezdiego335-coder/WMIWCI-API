// ════════════════════════════════════════════════════════════════════════
//  contact-route.test.ts — the REAL /api/contact handler, the REAL Zod schema,
//  driven end to end with the effects observed.
//
//  THE FAILURE THIS EXISTS TO CATCH. The route answered `{ok:true, "Message
//  received. We'll reply shortly."}` for an enquiry that was never stored. The
//  customer was told we had their message, HTTP monitoring saw a 200, and the
//  message existed nowhere. Nothing could have caught it: the route called
//  persistence directly, so no test could make the store fail. It can now.
//
//  TWO MORE, both found while writing these:
//
//   • THE HONEYPOT WAS DEAD CODE. `company: z.string().max(0)` meant a FILLED
//     honeypot failed validation, so the request was rejected as a 422 shape
//     error and the silent-accept branch was never reached. The trap reported
//     the wrong reason for every bot that sprang it, and a bot could tell it
//     apart from a genuine submission by the status code.
//
//   • THE PARSED-PAYLOAD LOG CARRIED THE CUSTOMER'S NAME AND EMAIL on every
//     submission.
//
//  Offline: no database, no Redis, no Discord. The effects are recorded through
//  `contact-route-deps`, which is the same seam the quick-quote route uses.
// ════════════════════════════════════════════════════════════════════════
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { __setContactRouteDeps, type ContactAlertJob } from '../contact-route-deps'

type RouteModule = { POST: (req: Request) => Promise<Response> }
let POST: RouteModule['POST']

before(async () => {
  ;({ POST } = (await import('../../../app/api/contact/route')) as unknown as RouteModule)
})

//  SYNTHETIC ONLY. No production customer data reaches a test, a fixture or a
//  snapshot — these are the repo's standing placeholders.
const GOOD = {
  name: 'Test Customer',
  email: 'test.customer@example.com',
  phone: '(862) 555-0100',
  subject: 'Two bedroom move',
  message: 'Looking for help moving a two bedroom on the 14th.',
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request('https://api.example.test/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }) as never,
  )
}

/** Install recording effects. Returns the log and the restore function. */
function harness(over: { captureFails?: boolean; enqueueThrows?: boolean } = {}) {
  const captured: unknown[] = []
  const queued: ContactAlertJob[] = []
  const alerts: { title: string; lines: { message: string }[] }[] = []
  const nurtured: string[] = []
  let n = 0

  const restore = __setContactRouteDeps({
    async capture(input) {
      captured.push(input)
      if (over.captureFails) return null // exactly what ingestLeadSafe does on a DB error
      n += 1
      return { lead: { id: `lead_${n}` }, isNew: true } as never
    },
    async enqueue(job) {
      if (over.enqueueThrows) throw new Error('redis: connection refused')
      queued.push(job)
      return { id: 'job_1' }
    },
    async alert(title, lines) {
      alerts.push({ title, lines })
      return { ok: true }
    },
    async nurture(id) {
      nurtured.push(id)
      return null
    },
  })
  return { captured, queued, alerts, nurtured, restore }
}

// ── 1. SUCCESSFUL SUBMISSION ──────────────────────────────────────────
test('a successful submission stores the enquiry, alerts the team, and says so', async () => {
  const h = harness()
  try {
    const res = await post(GOOD)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.match(body.message, /reply shortly/i)
    assert.equal(body.errorRef, undefined, 'a successful reply carries no incident reference')

    assert.equal(h.captured.length, 1, 'the enquiry is persisted')
    const row = h.captured[0] as Record<string, unknown>
    //  The subject is prefixed onto the message; both survive.
    assert.equal(row.message, `${GOOD.subject}: ${GOOD.message}`)
    assert.equal(row.email, GOOD.email)
    assert.equal(row.consentSource, 'CONTACT_FORM')

    assert.equal(h.queued.length, 1, 'the team is alerted in Discord')
    assert.equal(h.queued[0].type, 'contact-message')
    assert.equal(h.nurtured.length, 1, 'the non-quote nurture is offered the lead')
    assert.equal(h.alerts.length, 0, 'a healthy submission raises no operations alert')
  } finally {
    h.restore()
  }
})

// ── 2. DATABASE FAILURE ───────────────────────────────────────────────
test('a lead database failure returns 503 — never a success the customer will believe', async () => {
  const h = harness({ captureFails: true })
  try {
    const res = await post(GOOD)
    assert.equal(res.status, 503, 'a lost enquiry must not be reported as delivered')
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.error, 'contact_unavailable', 'machine-readable, so the form can react')
    //  The customer is given a way through, not just a failure.
    assert.match(body.message, /862-640-0625/)
    assert.equal(h.nurtured.length, 0, 'nothing is enrolled for a lead that does not exist')
  } finally {
    h.restore()
  }
})

test('the 503 carries ONE non-PII reference, and the operations alert carries the same one', async () => {
  const h = harness({ captureFails: true })
  try {
    const body = await (await post(GOOD)).json()
    const ref: string = body.errorRef
    assert.match(ref, /^[0-9a-f-]{36}$/i, 'a UUID, so it identifies the incident and nothing else')

    //  IT MUST NOT BE DERIVED FROM THE CUSTOMER. A reference built from an email
    //  or a phone number is PII wearing a hash.
    for (const secret of [GOOD.name, GOOD.email, GOOD.phone, GOOD.message, GOOD.subject]) {
      assert.ok(!ref.includes(secret), 'the reference leaks no customer field')
    }

    assert.equal(h.alerts.length, 1, 'a durable operations alert is raised')
    const text = h.alerts[0].lines.map((l) => l.message).join(' ')
    assert.ok(text.includes(ref), 'the alert quotes the SAME reference the customer was given')
    for (const secret of [GOOD.name, GOOD.email, GOOD.phone, GOOD.message]) {
      assert.ok(!text.includes(secret), 'the alert carries no customer data')
    }
  } finally {
    h.restore()
  }
})

test('two failed submissions get DIFFERENT references — one per incident, not per deploy', async () => {
  const h = harness({ captureFails: true })
  try {
    const a = await (await post(GOOD)).json()
    const b = await (await post(GOOD)).json()
    assert.notEqual(a.errorRef, b.errorRef)
  } finally {
    h.restore()
  }
})

test('the Spanish failure reply is Spanish and still carries the phone number', async () => {
  const h = harness({ captureFails: true })
  try {
    const res = await post({ ...GOOD, locale: 'es' })
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.match(body.message, /ll[aá]manos|escr[ií]benos/i)
    assert.match(body.message, /862-640-0625/)
  } finally {
    h.restore()
  }
})

// ── 3. QUEUE FAILURE ──────────────────────────────────────────────────
test('a queue failure does NOT lose the enquiry — it is stored, and the customer is told yes', async () => {
  const h = harness({ enqueueThrows: true })
  try {
    const res = await post(GOOD)
    //  This is the deliberate asymmetry. The DATABASE is the record; Discord is
    //  a convenience. Losing the notice costs us a fast reply. Losing the row
    //  costs us the customer, so only that one is a 503.
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)
    assert.equal(h.captured.length, 1, 'the enquiry was stored before the queue was touched')
    assert.equal(h.queued.length, 0)
    assert.equal(h.alerts.length, 0)
  } finally {
    h.restore()
  }
})

test('BOTH failing still returns 503 — the queue cannot rescue an unstored enquiry', async () => {
  const h = harness({ captureFails: true, enqueueThrows: true })
  try {
    const res = await post(GOOD)
    assert.equal(res.status, 503)
    assert.equal((await res.json()).error, 'contact_unavailable')
  } finally {
    h.restore()
  }
})

// ── 4. HONEYPOT ───────────────────────────────────────────────────────
test('a filled honeypot is silently accepted — and stores nothing', async () => {
  const h = harness()
  try {
    const res = await post({ ...GOOD, company: 'Acme Bots LLC' })
    //  200 and the ordinary body: a bot that can tell rejection from acceptance
    //  simply retries without the trap.
    assert.equal(res.status, 200, 'NOT the 422 the max(0) schema used to produce')
    assert.equal((await res.json()).ok, true)
    assert.equal(h.captured.length, 0, 'nothing is written')
    assert.equal(h.queued.length, 0, 'nobody is alerted')
    assert.equal(h.nurtured.length, 0, 'nothing is enrolled')
  } finally {
    h.restore()
  }
})

test('an EMPTY honeypot is a human, and is processed normally', async () => {
  const h = harness()
  try {
    const res = await post({ ...GOOD, company: '' })
    assert.equal(res.status, 200)
    assert.equal(h.captured.length, 1, 'an empty trap must never be read as sprung')
  } finally {
    h.restore()
  }
})

test('a long honeypot value is accepted by the schema, not rejected as a shape error', async () => {
  const h = harness()
  try {
    const res = await post({ ...GOOD, company: 'x'.repeat(200) })
    assert.equal(res.status, 200)
    assert.equal(h.captured.length, 0)
    //  Bounded, though: unbounded input is free memory for anyone who asks.
    const over = await post({ ...GOOD, company: 'x'.repeat(201) })
    assert.equal(over.status, 422)
  } finally {
    h.restore()
  }
})

// ── 5. DUPLICATE REQUEST ──────────────────────────────────────────────
test('a duplicate submission is passed to persistence identically, for the store to merge', async () => {
  const h = harness()
  try {
    const first = await post(GOOD)
    const second = await post(GOOD)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal((await second.json()).ok, true, 'a resubmit is never punished with an error')

    //  The route does not de-duplicate and must not pretend to: `ingestLeadSafe`
    //  owns the merge, keyed on the email. What is asserted here is that the
    //  SECOND request arrives with the same identity, so the store CAN merge it
    //  — a route that mutated or dropped the repeat would break that silently.
    assert.equal(h.captured.length, 2)
    const [a, b] = h.captured as Record<string, unknown>[]
    assert.equal(a.email, b.email)
    assert.equal(a.message, b.message)
    assert.equal(a.consentSource, b.consentSource)
    assert.equal(h.queued.length, 2, 'the team hears about the resubmit too')
  } finally {
    h.restore()
  }
})

// ── PII AND SEAM GUARDS ───────────────────────────────────────────────
const ROUTE_SRC = readFileSync(resolve(__dirname, '../../../app/api/contact/route.ts'), 'utf8')
/** Comments blanked LENGTH-PRESERVINGLY: a rule about code must not be broken
 *  — or satisfied — by prose that happens to mention the same identifier. */
const CODE = ROUTE_SRC.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).replace(
  /\/\/[^\n]*/g,
  (m) => ' '.repeat(m.length),
)

test('no log line in the contact route carries a customer field', () => {
  const calls = CODE.match(/apiLogger\.\w+\([\s\S]*?\)\n/g) ?? []
  assert.ok(calls.length > 0, 'the route logs something')
  for (const call of calls) {
    for (const field of ['data.name', 'data.email', 'data.phone', 'data.message', 'data.subject']) {
      assert.ok(!call.includes(field), `a log line carries ${field}:\n${call}`)
    }
  }
})

test('the failure log carries the reference and nothing identifying', () => {
  const at = CODE.indexOf('contact_lead_persist')
  assert.ok(at > -1, 'the failure is logged with a stage marker')
  const line = CODE.slice(CODE.lastIndexOf('apiLogger', at), at + 200)
  assert.ok(line.includes('errorRef'), 'the same reference the customer was given')
})

test('the webhook URL is never in the route at all', () => {
  assert.ok(!/discord\.com\/api\/webhooks/i.test(ROUTE_SRC))
})

test('__setContactRouteDeps is called by shipped code nowhere — it is a test seam', () => {
  //  A production caller would turn a test seam into a live configuration hook.
  let hits: string[] = []
  try {
    hits = execFileSync('git', ['grep', '-l', '__setContactRouteDeps', '--', 'app', 'src', 'scripts', 'prisma'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    return // no matches at all -> git grep exits 1, which is also a pass
  }
  for (const f of hits) {
    assert.ok(f.includes('__tests__') || f.endsWith('contact-route-deps.ts'), `${f} calls a test-only seam`)
  }
})
