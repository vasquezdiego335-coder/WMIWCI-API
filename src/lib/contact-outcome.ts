// Pure decision logic for the /api/contact customer-facing response.
// Kept side-effect free (no prisma/queue imports) so it is unit-testable.
//
// The one rule that matters: a failed database write must NEVER be reported to
// the customer as a normal success. Otherwise they believe we received a
// message that was actually lost. A Discord alert is not a durable record — it
// can silently fail on the worker — so it does not change the customer contract.

export interface ContactOutcome {
  httpStatus: number
  ok: boolean
  recoverable: boolean
}

export function decideContactOutcome(persisted: boolean, _discordOk: boolean): ContactOutcome {
  if (persisted) return { httpStatus: 200, ok: true, recoverable: false }
  return { httpStatus: 503, ok: false, recoverable: true }
}
