// ════════════════════════════════════════════════════════════════════════
//  quote-access-details.ts — the one human-readable line about site access.
//
//  WHY THIS FILE EXISTS. This lived in app/api/leads/quote-capture/route.ts
//  and was exported from there so its tests could reach it. A Next.js App
//  Router route file may export ONLY route handlers and a fixed set of config
//  keys; anything else fails `next build` with
//
//      Property 'composeAccessDetails' is incompatible with index signature.
//        Type '(input: {...}) => string | null' is not assignable to 'never'.
//
//  `tsc --noEmit` passes it, every test passes, and the build still breaks —
//  which is exactly how it reached main and failed the deploy. A route file is
//  a route file; shared logic belongs in lib.
// ════════════════════════════════════════════════════════════════════════

/** ONE string, so the lead notes, the Discord card, the confirmation email and
 *  the admin list cannot drift into three different names for one thing.
 *  Mirrored by IN_PERSON_ALERT_LABEL in ./lead-alert. */
export const IN_PERSON_LABEL = 'In-Person Estimate Requested'

/** "not_sure" is a REAL answer, not a missing one. The quote form used to say
 *  "if you're not sure, choose No", which files a guess as a fact and sends a
 *  crew expecting no stairs. */
export type YesNoUnsure = 'yes' | 'no' | 'not_sure'

const SAY: Record<YesNoUnsure, string> = { yes: 'yes', no: 'no', not_sure: 'not sure' }

export type AccessDetailsInput = {
  stairsPickup?: YesNoUnsure
  stairsDestination?: YesNoUnsure
  heavyItems?: YesNoUnsure
  dateFlexible?: boolean
  quoteMode?: 'instant' | 'in_person'
  preferredDay?: string
  preferredTime?: string
  pickupAddress?: string
  visitNotes?: string
}

/**
 * One human-readable access line for the owner's notes, or null when the
 * customer answered nothing. Deliberately plain English: it gets read on a
 * phone, in a van, by whoever is loading the truck.
 */
export function composeAccessDetails(input: AccessDetailsInput): string | null {
  const blocks: string[] = []

  // The label leads, so whoever opens the lead sees what kind of request this
  // is before they read anything else.
  if (input.quoteMode === 'in_person') blocks.push(IN_PERSON_LABEL)

  const visit: string[] = []
  if (input.pickupAddress) visit.push(`Address: ${input.pickupAddress}`)
  if (input.preferredDay) visit.push(`Preferred day: ${input.preferredDay}`)
  if (input.preferredTime) visit.push(`Preferred time: ${input.preferredTime}`)
  if (visit.length) blocks.push(visit.join('; ') + '.')

  const access: string[] = []
  if (input.stairsPickup) access.push(`Stairs at pickup: ${SAY[input.stairsPickup]}`)
  if (input.stairsDestination) access.push(`Stairs at destination: ${SAY[input.stairsDestination]}`)
  if (input.heavyItems) access.push(`Large or heavy items: ${SAY[input.heavyItems]}`)
  if (input.dateFlexible) access.push('Moving date is flexible')
  if (access.length) blocks.push(`From the quick quote — ${access.join('; ')}.`)

  if (input.visitNotes) blocks.push(`Notes: ${input.visitNotes}`)

  return blocks.length ? blocks.join('\n') : null
}
