// Winter mode (SEASONAL_CLOSURE). Proves, with no database, Redis, Stripe or
// Google reachable, that:
//   • every public endpoint that creates a booking, lead, quote, deposit or
//     payment answers 503 SEASONAL_CLOSURE while closed;
//   • the Stripe checkout helpers refuse to open a payment from any caller;
//   • old "resume checkout" email links send people to the website;
//   • marketing and reminder email is dropped for good, a receipt is not;
//   • the recurring sweeps skip while closed and run again when reopened;
//   • turning the switch off restores normal behaviour.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// Point every client at addresses that refuse connections, so a guard that
// leaks through would fail loudly instead of reaching a real service.
process.env.DATABASE_URL = 'postgresql://closure:closure@127.0.0.1:1/closure'
process.env.REDIS_URL = 'redis://127.0.0.1:1'
process.env.STRIPE_SECRET_KEY = 'sk_test_seasonal_closure_never_called'
process.env.MARKETING_SITE_URL = 'https://www.moveitclearit.com'

import {
  isSeasonalClosure,
  seasonalClosureBlocksEmail,
  seasonalClosureSkipsSchedule,
  SeasonalClosureError,
  SEASONAL_CLOSURE_CODE,
} from '../seasonal-closure'
import { classifyBlock } from '../email-guard'
import { CRON_SCHEDULES } from '../cron-schedules'

type Handler = (req: Request, ctx?: unknown) => Promise<Response>

const ROUTES: Array<{ file: string; method: 'POST' | 'PATCH' | 'GET'; url: string; params?: Record<string, string> }> = [
  { file: 'bookings/route', method: 'POST', url: 'https://api.test/api/bookings' },
  { file: 'contact/route', method: 'POST', url: 'https://api.test/api/contact' },
  { file: 'leads/route', method: 'POST', url: 'https://api.test/api/leads' },
  { file: 'leads/partial/route', method: 'POST', url: 'https://api.test/api/leads/partial' },
  { file: 'leads/quote-capture/route', method: 'POST', url: 'https://api.test/api/leads/quote-capture' },
  { file: 'leads/offer-signup/route', method: 'POST', url: 'https://api.test/api/leads/offer-signup' },
  { file: 'deposit/[token]/checkout/route', method: 'POST', url: 'https://api.test/api/deposit/tok/checkout', params: { token: 'tok' } },
  { file: 'customer/booking/[token]/route', method: 'PATCH', url: 'https://api.test/api/customer/booking/tok', params: { token: 'tok' } },
  { file: 'route-estimate/route', method: 'POST', url: 'https://api.test/api/route-estimate' },
  { file: 'service-area/check/route', method: 'POST', url: 'https://api.test/api/service-area/check' },
  { file: 'notify/lead/route', method: 'POST', url: 'https://api.test/api/notify/lead' },
  { file: 'admin/deposit-links/route', method: 'POST', url: 'https://api.test/api/admin/deposit-links' },
  { file: 'admin/test-booking/route', method: 'POST', url: 'https://api.test/api/admin/test-booking' },
]

const loaded = new Map<string, Record<string, Handler>>()

before(async () => {
  process.env.SEASONAL_CLOSURE = 'true'
  for (const r of ROUTES) {
    loaded.set(r.file, (await import(`../../../app/api/${r.file}`)) as unknown as Record<string, Handler>)
  }
})

after(() => {
  delete process.env.SEASONAL_CLOSURE
})

function request(r: (typeof ROUTES)[number]): Request {
  return new Request(r.url, {
    method: r.method,
    headers: { 'content-type': 'application/json', origin: 'https://www.moveitclearit.com' },
    body: r.method === 'GET' ? undefined : JSON.stringify({ name: 'Winter Test', email: 'winter@example.com', phone: '8625550100' }),
  })
}

test('the switch reads true/1/yes/on and nothing else', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) assert.equal(isSeasonalClosure({ SEASONAL_CLOSURE: v } as unknown as NodeJS.ProcessEnv), true, v)
  for (const v of ['', 'false', '0', 'off', 'no', 'closed']) assert.equal(isSeasonalClosure({ SEASONAL_CLOSURE: v } as unknown as NodeJS.ProcessEnv), false, v)
  assert.equal(isSeasonalClosure({} as unknown as NodeJS.ProcessEnv), false)
})

for (const r of ROUTES) {
  test(`closed: ${r.method} ${new URL(r.url).pathname} answers 503 without touching a service`, async () => {
    process.env.SEASONAL_CLOSURE = 'true'
    const handler = loaded.get(r.file)![r.method]
    assert.equal(typeof handler, 'function', `${r.file} exports ${r.method}`)
    const ctx = r.params ? { params: Promise.resolve(r.params) } : undefined
    const res = await handler(request(r) as never, ctx)
    assert.equal(res.status, 503)
    const body = (await res.json()) as { error: string; closed: boolean; message: string }
    assert.equal(body.error, SEASONAL_CLOSURE_CODE)
    assert.equal(body.closed, true)
    assert.match(body.message, /closed for the winter season/)
    assert.doesNotMatch(body.message, /\b(reopen|open again) (on|in)\b/i, 'never promises a reopening date')
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })
}

test('closed: an old "resume checkout" email link goes to the website, not to Stripe', async () => {
  process.env.SEASONAL_CLOSURE = 'true'
  const mod = (await import('../../../app/api/stripe/checkout/resume/route')) as unknown as Record<string, Handler>
  const res = await mod.GET(new Request('https://api.test/api/stripe/checkout/resume?token=abc') as never)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://www.moveitclearit.com/')
})

test('closed: the Stripe helpers refuse to create any checkout session', async () => {
  process.env.SEASONAL_CLOSURE = 'true'
  const stripe = await import('../stripe')
  await assert.rejects(
    stripe.createBookingCheckout({
      bookingId: 'b', customerEmail: 'winter@example.com', customerName: 'W', description: 'd',
      successUrl: 'https://x.test/s', cancelUrl: 'https://x.test/c',
    } as never),
    (e: unknown) => e instanceof SeasonalClosureError,
  )
  await assert.rejects(
    stripe.createDepositCheckout({ depositRequestId: 'd', amountCents: 4900, publicToken: 't', successUrl: 'https://x.test/s', cancelUrl: 'https://x.test/c' } as never),
    (e: unknown) => e instanceof SeasonalClosureError,
  )
})

test('closed: marketing and reminders are dropped for good; a receipt still sends', () => {
  process.env.SEASONAL_CLOSURE = 'true'
  for (const template of ['abandoned-checkout', 'quote-followup-1', 'review-request', 'referral-ask', 'reactivation']) {
    assert.equal(seasonalClosureBlocksEmail({ emailClass: 'promotional', template }), true, template)
  }
  for (const template of ['job-reminder', 'pre-approval', 'final-confirmation', 'quote-request-received']) {
    assert.equal(seasonalClosureBlocksEmail({ emailClass: 'transactional', template }), true, template)
  }
  for (const template of ['payment-receipt', 'booking-cancellation', 'booking-declined', 'operational-alert']) {
    assert.equal(seasonalClosureBlocksEmail({ emailClass: 'transactional', template }), false, template)
  }
  // Terminal, so nothing held over the winter is sent when the switch goes off.
  assert.equal(classifyBlock('seasonal_closure'), 'terminal')
})

test('closed: every recurring sweep is skipped', () => {
  process.env.SEASONAL_CLOSURE = 'true'
  assert.ok(CRON_SCHEDULES.length >= 10)
  for (const c of CRON_SCHEDULES) assert.equal(seasonalClosureSkipsSchedule(c.name), true, c.name)
})

test('reopened: email, schedules and the Stripe guard return to normal', async () => {
  process.env.SEASONAL_CLOSURE = 'false'
  assert.equal(seasonalClosureBlocksEmail({ emailClass: 'promotional', template: 'abandoned-checkout' }), false)
  for (const c of CRON_SCHEDULES) assert.equal(seasonalClosureSkipsSchedule(c.name), false, c.name)
  const { assertOpenForPayments } = await import('../seasonal-closure')
  assert.doesNotThrow(() => assertOpenForPayments('A booking checkout'))
})

test('reopened: the closure guard no longer answers for the routes', async () => {
  process.env.SEASONAL_CLOSURE = 'false'
  // With the switch off the handler runs its normal path. Here that path meets
  // an invalid body or the unreachable test services, so any answer is fine
  // EXCEPT the closure response.
  for (const r of ROUTES.filter((x) => ['leads/offer-signup/route', 'route-estimate/route', 'service-area/check/route'].includes(x.file))) {
    const handler = loaded.get(r.file)![r.method]
    const res = await handler(request(r) as never, undefined).catch(() => null)
    if (res) {
      const text = await res.text()
      assert.ok(!text.includes(SEASONAL_CLOSURE_CODE), `${r.file} still answered closed`)
    }
  }
})
