// ════════════════════════════════════════════════════════════════════════
//  booking-quote.ts — THE final total. One arithmetic, no second opinion.
//
//  THE BUG (owner spec, booking WMIC-1019): the same booking reported three
//  different numbers depending on where you looked.
//
//      base labor            $550
//      first-time discount   −$55
//      final total           $495     ← the only correct answer
//
//      Discord said          $550     (the discount was displayed, not applied)
//      "Balance after job"   $501     ($550 − $49: the wrong total, and the
//                                      deposit subtracted from it anyway)
//      Admin said            $495     (job-money had it right all along)
//
//  $501 is the number that must never appear again. It is what you get by
//  subtracting the deposit from an UNDISCOUNTED total — a figure that is
//  neither the quote, nor the total, nor the balance.
//
//  THE DEPOSIT IS APPLIED, NEVER ADDED. The $49 is authorized at checkout and
//  captured on approval. It comes OFF the final total; it is not a fee on top
//  of it. So:
//
//      before approval   final $495 · authorized $49 · captured $0 · owed $495
//      after capture     final $495 · paid $49 · remaining $446
//
//  UNITS: integer CENTS throughout. Dollar convenience fields are derived at
//  the end and are the only place a division by 100 happens.
//
//  Pure — no prisma, no imports that touch I/O — so `pricing.ts` (dollars, for
//  cards and emails) and `job-money.ts` (cents, for the admin) can both
//  delegate here and become structurally incapable of disagreeing.
// ════════════════════════════════════════════════════════════════════════

export type QuoteInput = {
  /** DOLLARS. The accepted quote: base labor + access add-ons + travel. */
  totalEstimate?: number | null
  /** DOLLARS. Flat move-size labor price — rebuilds the quote when it is null. */
  baseRate?: number | null
  /** CENTS. Travel fee. Already inside totalEstimate; used only to rebuild. */
  travelFeeCents?: number | null
  /** CENTS. Approved charges that are NOT already inside the quote. */
  additionalCents?: number | null
  /** Whole percent off (10 = 10%). */
  discountPercent?: number | null
  /** CENTS. The Stripe booking authorization. Applied toward the total. */
  depositCents?: number | null
  /** CENTS. Captured − refunds − lost chargebacks. Real money received. */
  collectedCents?: number | null
  /** CENTS. Authorized but NOT captured — a hold, never collected. */
  authorizedNotCapturedCents?: number | null
}

export type Quote = {
  // ── The quote ──
  /** CENTS. What the customer accepted, before add-ons and discount. */
  quotedCents: number
  /** CENTS. Approved charges added on top of the quote. */
  additionalCents: number
  /** Whole percent actually applied. */
  discountPercent: number
  /** CENTS. The money the discount takes off. */
  discountCents: number
  /** CENTS. THE FINAL TOTAL. quoted + additional − discount. */
  finalTotalCents: number

  // ── The deposit ──
  /** CENTS. The authorization amount ($49). */
  depositCents: number
  /** True once any real money has been captured. */
  depositCaptured: boolean
  /** CENTS. The deposit money actually received. 0 until capture. */
  depositAppliedCents: number

  // ── What is left ──
  /** CENTS. Real money received against this booking. */
  collectedCents: number
  /** CENTS. Held but not captured. NOT collected, NOT a payment. */
  authorizedNotCapturedCents: number
  /** CENTS. finalTotal − collected. What the customer still owes TODAY. */
  remainingCents: number
  /**
   * CENTS. What will remain once the pending authorization is captured.
   * Equal to remainingCents after capture. This is the forecast the owner
   * needs on the approval card — and it is computed from the FINAL total, so
   * it can never be the $501 that started all this.
   */
  remainingAfterDepositCents: number

  /** True when no quote is stored — the total is a floor, not the amount. */
  quoteMissing: boolean

  // ── Dollar mirrors. The only division by 100 in the money path. ──
  finalTotalDollars: number
  discountDollars: number
  depositDollars: number
  collectedDollars: number
  remainingDollars: number
  remainingAfterDepositDollars: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const toDollars = (cents: number): number => round2(cents / 100)

/**
 * THE booking total. Every surface — admin, Discord, the booking
 * confirmation, the customer email, the work order, the job page and the
 * payment page — must originate its numbers here.
 */
export function computeQuote(i: QuoteInput): Quote {
  const quoteMissing = i.totalEstimate == null
  // A legacy or "need a quote" row has no stored estimate. Rebuilding it from
  // its parts keeps the base labor billed rather than silently dropped.
  const quotedCents = quoteMissing
    ? Math.round((i.baseRate ?? 0) * 100) + (i.travelFeeCents ?? 0)
    : Math.round((i.totalEstimate ?? 0) * 100)

  const additionalCents = Math.max(0, i.additionalCents ?? 0)
  const discountPercent = Math.max(0, i.discountPercent ?? 0)
  const discountCents = discountPercent > 0
    ? Math.round(((quotedCents + additionalCents) * discountPercent) / 100)
    : 0

  const finalTotalCents = Math.max(0, quotedCents + additionalCents - discountCents)

  const depositCents = Math.max(0, i.depositCents ?? 4900)
  const collectedCents = Math.max(0, i.collectedCents ?? 0)
  const authorizedNotCapturedCents = Math.max(0, i.authorizedNotCapturedCents ?? 0)
  const depositCaptured = collectedCents > 0

  // The deposit counts as applied only once it is real money. An authorization
  // is a promise the bank made to us, not a payment the customer has made.
  const depositAppliedCents = Math.min(depositCents, collectedCents)

  const remainingCents = Math.max(0, finalTotalCents - collectedCents)

  // The forecast: what is left once the pending hold is captured too.
  // Once anything IS captured the forecast has come true, so it stops being a
  // forecast — otherwise the deposit would be credited twice. When a caller
  // passes no payment rows at all (cards and emails often don't), the standing
  // $49 authorization is assumed, which is the state every booking is in
  // between checkout and approval.
  const pendingDepositCents = depositCaptured
    ? 0
    : Math.min(depositCents, authorizedNotCapturedCents || depositCents)
  const remainingAfterDepositCents = Math.max(0, remainingCents - pendingDepositCents)

  return {
    quotedCents,
    additionalCents,
    discountPercent,
    discountCents,
    finalTotalCents,
    depositCents,
    depositCaptured,
    depositAppliedCents,
    collectedCents,
    authorizedNotCapturedCents,
    remainingCents,
    remainingAfterDepositCents,
    quoteMissing,
    finalTotalDollars: toDollars(finalTotalCents),
    discountDollars: toDollars(discountCents),
    depositDollars: toDollars(depositCents),
    collectedDollars: toDollars(collectedCents),
    remainingDollars: toDollars(remainingCents),
    remainingAfterDepositDollars: toDollars(remainingAfterDepositCents),
  }
}

/**
 * The money lines every surface prints, worded once.
 *
 * Returning STRINGS from the same place that does the arithmetic is what
 * stops a card, an email and a page from each inventing their own phrasing
 * for the same figure — which is how "$550" and "$495" ended up describing
 * one booking on two screens.
 */
export function quoteLines(
  q: Quote,
  opts?: { discountLabel?: string | null; baseDollars?: number | null },
): string[] {
  const usd = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const lines: string[] = []

  if (typeof opts?.baseDollars === 'number' && opts.baseDollars > 0) {
    lines.push(`Base labor: ${usd(Math.round(opts.baseDollars * 100))}`)
  }
  if (q.additionalCents > 0) lines.push(`Additional approved charges: ${usd(q.additionalCents)}`)
  if (q.discountCents > 0) {
    const label = opts?.discountLabel ? ` (${opts.discountLabel})` : ''
    lines.push(`Discount ${q.discountPercent}%${label}: −${usd(q.discountCents)}`)
  }
  lines.push(`**Final total: ${usd(q.finalTotalCents)}**`)

  if (q.depositCaptured) {
    lines.push(`Deposit paid: ${usd(q.depositAppliedCents)}`)
    lines.push(`Remaining move-day balance: ${usd(q.remainingCents)}`)
  } else {
    lines.push(`Deposit authorized: ${usd(q.depositCents)} — captured on approval`)
    lines.push(`Amount captured so far: ${usd(q.collectedCents)}`)
    lines.push(`Remaining after the deposit is captured: ${usd(q.remainingAfterDepositCents)}`)
  }
  return lines
}
