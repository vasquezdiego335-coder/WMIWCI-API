// ════════════════════════════════════════════════════════════════════════
//  booking-review.ts - why a booking needs the owner's eyes.
//
//  Extracted from app/api/bookings/route.ts on 2026-07-28 (App Router route
//  files may export only handlers). Pure function, no I/O - covered by
//  src/lib/__tests__/booking-access-review.test.ts.
// ════════════════════════════════════════════════════════════════════════

/**
 * THE one place a booking is judged to need owner review, and the ONLY place
 * the reasons are worded.
 *
 * Before this, `manualReviewRequired` was set from the service-area and address
 * checks alone. `computeEstimate()` already returned `requiresReview` and
 * `reviewReasons` — covering pianos, safes, 400lb+ items, 4+ flights, "starting
 * at" packages and New York — and the route read neither. A customer could book
 * a piano move, see a settled-looking total, authorize the hold, and land in the
 * queue with no signal that the job had never been priced.
 *
 * Returns readable sentences, not codes: they are shown verbatim to the owner in
 * the admin booking detail and must stand alone at 6am on a phone.
 */
export function buildReviewReasons(input: {
  estimate: { requiresReview: boolean; reviewReasons: string[] }
  serviceArea: { manualReviewRequired?: boolean; zone?: string | null; message?: string | null } | null
  addressNeedsReview: boolean
  manualEntryReason?: string
  difficultElevatorPickup?: boolean
  difficultElevatorDropoff?: boolean
  difficultBuildingPickup?: boolean
  difficultBuildingDropoff?: boolean
}): string[] {
  const reasons: string[] = []

  // 1. Everything the estimator already worked out (piano, safe, heavy items,
  //    4+ flights, unpriced "starting at" packages, >90min travel, New York).
  for (const r of input.estimate.reviewReasons) reasons.push(r)

  // 2. Access difficulty the customer declared. These are the five fields that
  //    used to be discarded — each one is a promise the form made to review it.
  if (input.difficultElevatorPickup) reasons.push('Difficult elevator at pickup — slow or freight-restricted')
  if (input.difficultElevatorDropoff) reasons.push('Difficult elevator at destination — slow or freight-restricted')
  if (input.difficultBuildingPickup) reasons.push('Difficult building access at pickup — loading dock or truck-access restriction')
  if (input.difficultBuildingDropoff) reasons.push('Difficult building access at destination — loading dock or truck-access restriction')

  // 3. Service area — the server's own verdict, not the browser's.
  if (input.serviceArea?.manualReviewRequired) {
    reasons.push(input.serviceArea.message?.trim() || 'Service area requires owner review — travel price pending')
  }

  // 4. Address quality.
  if (input.manualEntryReason) {
    reasons.push(`Address entered manually — ${input.manualEntryReason}`)
  } else if (input.addressNeedsReview) {
    reasons.push('Address could not be verified — confirm it with the customer before dispatch')
  }

  // Stable order, no duplicates (the estimator and the service area can both
  // legitimately raise New York). Array.from rather than spread — this tsconfig
  // targets below es2015 and does not set downlevelIteration.
  return Array.from(new Set(reasons))
}
