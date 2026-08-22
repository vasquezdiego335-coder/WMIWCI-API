// ════════════════════════════════════════════════════════════════════════
//  quote-capture-deps.ts — the seam the quick-quote ROUTE persists through.
//
//  WHY THIS EXISTS. The route called `capturePartialLeadSafe` and
//  `onQuoteRequestCaptured` directly, so the only way to test it without a
//  database was to let persistence fail and then assert `quoteEstimate()`
//  separately. That proves the price book is right; it proves nothing about
//  what the route actually stored — and "captured at $550" was exactly the
//  claim being made.
//
//  So the route now resolves those two calls through here. In production the
//  values are the real functions and nothing changes. A test installs its own,
//  drives the REAL Zod schema and the REAL handler, and reads the EXACT input
//  the route handed to persistence.
//
//  DELIBERATELY NARROW. Only the two effectful calls are swappable. Pricing,
//  validation, the retired-package refusal and the response shape are NOT —
//  a test that could stub those would stop testing the thing under test.
//
//  `__setQuoteCaptureRouteDeps` is a TEST-ONLY entry point. It is not called
//  from any route, worker or script; `quote-capture-route.test.ts` asserts
//  that, so it cannot quietly become a production configuration hook.
// ════════════════════════════════════════════════════════════════════════
import { capturePartialLeadSafe } from './leads'
import { onQuoteRequestCaptured } from './quote-capture'

export type QuoteCaptureRouteDeps = {
  /** Persist a PARTIAL lead (the booking form's step-1 ping). Same function,
   *  named separately so a test can record one route without the other. */
  partialCapture: typeof capturePartialLeadSafe
  /** Persist the lead. Never throws; returns null when the write failed. */
  capture: typeof capturePartialLeadSafe
  /** Fire the side effects (confirmation email, owner card, automation). */
  onCaptured: typeof onQuoteRequestCaptured
}

const PRODUCTION: QuoteCaptureRouteDeps = {
  capture: capturePartialLeadSafe,
  partialCapture: capturePartialLeadSafe,
  onCaptured: onQuoteRequestCaptured,
}

let current: QuoteCaptureRouteDeps = PRODUCTION

/** What the route uses. Production unless a test has replaced it. */
export function quoteCaptureRouteDeps(): QuoteCaptureRouteDeps {
  return current
}

/** TEST ONLY. Returns a restore function; always call it in a `finally`, or
 *  the next test in the same process inherits the stub. */
export function __setQuoteCaptureRouteDeps(next: Partial<QuoteCaptureRouteDeps>): () => void {
  const previous = current
  current = { ...current, ...next }
  return () => {
    current = previous
  }
}
