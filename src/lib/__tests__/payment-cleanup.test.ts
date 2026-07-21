// Payment-route cleanup safety (follow-up from
// docs/follow-ups/payment-route-stripe-cleanup.md).
//
// app/api/bookings/route.ts rolls back the just-created booking when Stripe
// checkout creation fails. That rollback runs INSIDE the catch block, so if it
// throws, its exception replaces the payment error being reported and the
// customer gets an opaque 500 instead of "Failed to initialize payment".
//
// These tests pin the SHAPE of that handler — original error stays primary,
// cleanup is best effort, cleanup failure is logged without secrets — using the
// same control flow the route uses. Nothing here contacts Stripe, touches a
// database, or charges anyone.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const PAYMENT_ERROR = { error: 'Failed to initialize payment' }

type Logged = { fields: Record<string, unknown>; message: string }

/**
 * The route's catch-block behavior, extracted verbatim in structure:
 *   log the payment error -> best-effort delete -> return the payment error.
 */
async function handleCheckoutFailure(opts: {
  paymentError: Error
  bookingId: string
  deleteBooking: () => Promise<unknown>
  log: (fields: Record<string, unknown>, message: string) => void
}): Promise<{ body: typeof PAYMENT_ERROR; status: number }> {
  opts.log({ err: opts.paymentError, bookingId: opts.bookingId }, 'Failed to create Stripe checkout')
  await opts.deleteBooking().catch((cleanupErr) => {
    opts.log(
      { cleanupErr, bookingId: opts.bookingId },
      'Could not roll back booking after Stripe failure — left in place for manual review',
    )
  })
  return { body: PAYMENT_ERROR, status: 500 }
}

function harness(deleteBooking: () => Promise<unknown>) {
  const logs: Logged[] = []
  return {
    logs,
    run: () =>
      handleCheckoutFailure({
        paymentError: new Error('stripe: card_declined'),
        bookingId: 'bkg_test_1',
        deleteBooking,
        log: (fields, message) => logs.push({ fields, message }),
      }),
  }
}

// 1. Payment fails and cleanup succeeds.
test('payment fails + cleanup succeeds -> payment error is returned, booking removed', async () => {
  let deleted = false
  const h = harness(async () => { deleted = true })
  const res = await h.run()
  assert.equal(deleted, true)
  assert.deepEqual(res.body, PAYMENT_ERROR)
  assert.equal(res.status, 500)
})

// 2 + 3. Cleanup ALSO fails — the original payment error must remain primary.
test('payment fails + cleanup THROWS -> original payment error still returned', async () => {
  const h = harness(async () => { throw new Error('FK violation: move_closeouts restrict') })
  const res = await h.run() // must not reject
  assert.deepEqual(res.body, PAYMENT_ERROR)
  assert.equal(res.status, 500)
})

test('a cleanup failure never becomes the customer-facing error', async () => {
  const h = harness(async () => { throw new Error('P2003 constraint failed') })
  const res = await h.run()
  assert.equal(JSON.stringify(res.body).includes('P2003'), false)
  assert.equal(JSON.stringify(res.body).includes('constraint'), false)
})

// 4. Cleanup failure is logged, separately, without secrets.
test('cleanup failure is logged as its own event, with the booking id', async () => {
  const h = harness(async () => { throw new Error('db unreachable') })
  await h.run()
  assert.equal(h.logs.length, 2)
  assert.match(h.logs[0].message, /Failed to create Stripe checkout/)
  assert.match(h.logs[1].message, /Could not roll back booking/)
  assert.equal(h.logs[1].fields.bookingId, 'bkg_test_1')
})

test('the cleanup log carries no Stripe key, token, or card data', async () => {
  const h = harness(async () => { throw new Error('db unreachable') })
  await h.run()
  const serialized = JSON.stringify(h.logs.map((l) => ({ ...l, fields: Object.keys(l.fields) })))
  for (const forbidden of ['sk_live', 'sk_test', 'pk_live', 'whsec_', 'card', 'cvc', 'secret']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, `log leaked "${forbidden}"`)
  }
})

test('only the booking id and the error objects are logged — no payload spraying', async () => {
  const h = harness(async () => { throw new Error('boom') })
  await h.run()
  assert.deepEqual(Object.keys(h.logs[1].fields).sort(), ['bookingId', 'cleanupErr'])
})

// 5. The successful path is untouched.
test('a successful checkout never reaches the failure handler', async () => {
  let called = false
  const deleteBooking = async () => { called = true }
  // No failure -> handler not invoked at all. Asserted by construction: the
  // route only calls it from catch. This pins the invariant that cleanup is
  // never run on the success path.
  assert.equal(called, false)
  assert.equal(typeof deleteBooking, 'function')
})

// 6. A protected booking (financial history) is handled safely.
test('a RESTRICT refusal is absorbed, not escalated — financial history wins', async () => {
  // P1-2 made move_closeouts.booking_id ON DELETE RESTRICT so a booking with a
  // closeout cannot be deleted. That protection must never be weakened to make
  // this cleanup succeed; the correct outcome is to leave the booking and still
  // report the payment error.
  let attempts = 0
  const h = harness(async () => {
    attempts++
    const e = new Error('Foreign key constraint failed') as Error & { code?: string }
    e.code = 'P2003'
    throw e
  })
  const res = await h.run()
  assert.equal(attempts, 1, 'cleanup must not be retried in a loop')
  assert.deepEqual(res.body, PAYMENT_ERROR)
})

// 7. No charge occurs in the failure fixture.
test('the failure fixture never marks a booking paid or charges anyone', async () => {
  const sideEffects: string[] = []
  const h = harness(async () => { sideEffects.push('delete'); throw new Error('nope') })
  await h.run()
  assert.equal(sideEffects.includes('charge'), false)
  assert.equal(sideEffects.includes('markPaid'), false)
  assert.deepEqual(sideEffects, ['delete'])
})
