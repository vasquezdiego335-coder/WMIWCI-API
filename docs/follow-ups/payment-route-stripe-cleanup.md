# Follow-up: unguarded booking rollback in the Stripe failure path

**Status:** OPEN — not fixed. Requires human review on the payment path.
**Raised:** 2026-07-21, during P1-2 (financial-history FK hardening).
**Not attempted again by tooling.** Edits to this file were blocked by the
permission classifier; that restriction was respected, not worked around.

---

## Location

`app/api/bookings/route.ts`, line **586**, inside the `catch` block that handles
a failure to create the Stripe checkout session:

```ts
} catch (err) {
  apiLogger.error({ err, bookingId: booking.id }, 'Failed to create Stripe checkout')
  await prisma.booking.delete({ where: { id: booking.id } })   // <-- line 586, unguarded
  return NextResponse.json({ error: 'Failed to initialize payment' }, { status: 500 })
}
```

## The issue

The rollback `delete` has no `.catch()`. It is the last statement before the
customer-facing response, and it is running **inside an error handler** — so if
the delete itself throws, that exception replaces the one being handled.

The customer stops seeing `"Failed to initialize payment"` (accurate, and the
reason they should retry or call) and instead gets an opaque unhandled 500. The
real Stripe error is still written to `apiLogger` above, so it is not lost from
the logs — but the response no longer describes what actually went wrong, and
the booking row survives in an indeterminate state either way.

## Why the risk changed

Before P1-2 the delete could only fail on an infrastructure fault (connection
drop, timeout). Since P1-2, `move_closeouts.booking_id` is
`ON DELETE RESTRICT`, so the database will now **refuse** to delete a booking
that carries financial history.

That new refusal is correct and deliberate — protecting immutable
`FinancialSnapshot` rows is the entire point of P1-2 — but it adds a second,
deterministic way for line 586 to throw.

## Actual likelihood: low

The booking being deleted was created seconds earlier in the same request and
cannot yet have a `MoveCloseout`, so the RESTRICT path is currently
unreachable in practice. This is a latent defect, not a live incident. It is
worth fixing because the guard is one line and the failure mode is
"payment error becomes unreadable", which is expensive to diagnose from a
customer report.

## Recommended correction

Do not change the delete's intent — only stop it from masking the original
error:

```ts
} catch (err) {
  apiLogger.error({ err, bookingId: booking.id }, 'Failed to create Stripe checkout')
  // Roll back the just-created booking, but never let a cleanup failure
  // replace the payment error the customer needs to see. Since P1-2 the
  // closeout FK is RESTRICT, so this delete can legitimately refuse.
  await prisma.booking.delete({ where: { id: booking.id } }).catch((cleanupErr) => {
    apiLogger.error(
      { cleanupErr, bookingId: booking.id },
      'Could not roll back booking after Stripe failure — left in place for manual review',
    )
  })
  return NextResponse.json({ error: 'Failed to initialize payment' }, { status: 500 })
}
```

A booking left behind is strictly better than a misreported payment error: it is
visible, it is logged with its id, and it can be cleaned up by hand.

## Required tests before this ships

Payment-path changes should not land on a green typecheck alone.

1. Stripe session creation fails → response body is exactly
   `{ error: 'Failed to initialize payment' }` with status 500.
2. Stripe fails **and** the rollback delete also throws → the response is still
   that same 500 body, not an unhandled error.
3. That second case writes the cleanup-failure log line, including the booking
   id, so an orphan is traceable.
4. Stripe fails and the rollback succeeds → no booking row remains.
5. Stripe succeeds → no delete is attempted (guard against a regression that
   rolls back a good booking).
6. A booking carrying a `MoveCloseout` cannot be deleted at all — asserts the
   P1-2 RESTRICT constraint directly, so the protection cannot be silently
   removed later.

Tests 1-5 belong with the booking route tests; test 6 is a database-level
assertion and needs a real PostgreSQL connection, so it should run in the
integration suite rather than the offline unit suite.

## Handling

Treat as a **separate, human-reviewed payment-path change**. Do not bundle it
with reporting or financial-closeout work.
