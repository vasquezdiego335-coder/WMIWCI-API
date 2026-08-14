// ════════════════════════════════════════════════════════════════════════
//  booking-scope.ts — EVERYTHING UNRESOLVED ABOUT ONE BOOKING, in one read.
//
//  THE BUG (owner spec, booking WMIC-1019): the top of the booking page said
//
//      1 Bedroom — $550
//
//  and that was the whole story. It was wrong four times over. The customer
//  was supplying the truck (so this was labor, not a package). The disclosed
//  inventory was a two-bedroom load. Assembly was requested with no furniture
//  named. Nobody had asked either building about a certificate of insurance.
//  A confident headline over four open questions is worse than no headline —
//  it invites an approval.
//
//  This module answers the question the owner is actually asking: *what do I
//  still not know?* It composes the service shape, the inventory verdict, the
//  assembly scope, the COI status, the discount decision and the canonical
//  total into one object, and words each open item in a sentence.
//
//  IT DECIDES NOTHING ABOUT MONEY. It re-prices nothing, applies no discount
//  it was not handed, and changes no selection. It reports; the owner decides;
//  approval-guards.ts enforces that the owner actually did.
//
//  Pure — shared by the admin page, the Discord approval card, the emails and
//  the approval guards, so all four describe the same booking identically.
// ════════════════════════════════════════════════════════════════════════

import { PACKAGES, type PackageKey } from './pricing-config'
import { resolveServiceShape, laborOnlyChargeViolations, type ServiceShape, type ServiceShapeInput, type LaborChargeInput, type ChargeViolation } from './service-shape'
import { assessInventory, mergeInventory, parseInventoryText, toInventory, describeInventory, INVENTORY_WARNING, type Inventory, type InventoryAssessment } from './inventory'
import { computeQuote, type Quote } from './booking-quote'
import { normalizeAddressAndUnit } from './address'

// ── Certificate of insurance ──────────────────────────────────────────────
//
// Tri-state on purpose. "We have not asked the building" is a different fact
// from "the building said no", and only one of them is safe to dispatch on.
export type CoiStatus = 'yes' | 'no' | 'unknown'

export const COI_LABELS: Record<CoiStatus, string> = {
  yes: 'Required',
  no: 'Not required',
  unknown: 'Unknown — not confirmed with the building',
}

export function normalizeCoi(v?: string | null): CoiStatus | null {
  const s = (v ?? '').trim().toLowerCase()
  if (!s) return null // never asked — distinct from 'unknown', which was asked
  if (['yes', 'y', 'true', 'required'].includes(s)) return 'yes'
  if (['no', 'n', 'false', 'not required', 'none'].includes(s)) return 'no'
  return 'unknown'
}

export type ScopeSeverity = 'block' | 'review' | 'info'

export type ScopeFlag = {
  code: string
  /** The banner, exactly as it should render. */
  banner: string
  /** One sentence of detail beneath it. */
  detail: string
  severity: ScopeSeverity
  /** True when an owner has already looked at this and accepted it. */
  cleared?: boolean
}

export const BANNERS = {
  inventory: INVENTORY_WARNING,
  assembly: '⚠️ ASSEMBLY SCOPE UNKNOWN',
  photos: '⚠️ PHOTOS RECOMMENDED BEFORE APPROVAL',
  coi: '⚠️ COI REQUIRED — REVIEW BEFORE APPROVAL',
  coiUnknown: '⚠️ COI STATUS UNKNOWN — CONFIRM WITH BOTH BUILDINGS',
  truckCost: '⚠️ TRUCK COST ON A LABOR-ONLY JOB',
  unit: '⚠️ APARTMENT / UNIT FOUND INSIDE THE STREET ADDRESS',
  discount: 'ℹ️ DISCOUNT NOT APPLIED',
} as const

export type ScopeInput = ServiceShapeInput & LaborChargeInput & {
  // Inventory — structured when we have it, the notes blob when we do not.
  inventoryDetail?: unknown
  customerNotes?: string | null
  numBoxes?: number | null
  bedrooms?: number | null
  inventoryReviewCleared?: boolean | null

  // Assembly
  needsAssembly?: boolean | null
  needsDisassembly?: boolean | null
  assemblyItems?: string | null
  disassemblyItems?: string | null
  assemblyFee?: number | null // CENTS
  disassemblyFee?: number | null // CENTS
  assemblyApprovalRequired?: boolean | null

  // COI
  coiRequiredOrigin?: string | null
  coiRequiredDest?: string | null
  coiNotes?: string | null

  // Addresses / units
  originAddress?: string | null
  destAddress?: string | null
  originUnit?: string | null
  destUnit?: string | null

  // Photos
  photoCount?: number | null

  // Money — passed straight through to the ONE quote calculation.
  totalEstimate?: number | null
  travelFee?: number | null // CENTS
  additionalCents?: number | null
  discountPercent?: number | null
  discountCode?: string | null
  discountType?: string | null
  discountRejected?: unknown
  depositAmount?: number | null // CENTS
  collectedCents?: number | null
  authorizedNotCapturedCents?: number | null

  // Crew
  crewNames?: string[] | null
}

export type AssemblyScope = {
  required: boolean
  disassemblyRequired: boolean
  reassemblyRequired: boolean
  disassemblyItems: string | null
  reassemblyItems: string | null
  /** CENTS. The additional fee, when one has been set. */
  feeCents: number
  approvalRequired: boolean
  /** False when assembly was asked for but no furniture was named. */
  scopeKnown: boolean
  /** "Needs clarification" / "Bed frames, desk" / "Not required". */
  label: string
}

export type BookingScope = {
  shape: ServiceShape
  inventory: InventoryAssessment
  assembly: AssemblyScope
  coi: { origin: CoiStatus | null; dest: CoiStatus | null; required: boolean; unknown: boolean; notes: string | null; label: string }
  quote: Quote
  discountRejected: { code: string; message: string }[]
  truckCostViolations: ChargeViolation[]
  addresses: {
    origin: { address: string; unit: string | null; embeddedUnitFound: boolean }
    dest: { address: string; unit: string | null; embeddedUnitFound: boolean }
  }
  photoCount: number
  crew: string[]
  flags: ScopeFlag[]
  /** True when anything is still open. Gates the "Final quote" line. */
  hasOpenQuestions: boolean
  /** The block that replaces "1 Bedroom — $550" at the top of the page. */
  summary: { label: string; value: string; alert?: boolean }[]
  headline: string
  /** The one-paragraph brief the owner reads first. Null when all is clear. */
  alertParagraph: string | null
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** THE booking scope. One call, every open question. */
export function resolveBookingScope(b: ScopeInput): BookingScope {
  const shape = resolveServiceShape(b)

  // ── Inventory: structured first, the notes blob as the fallback that makes
  //    bookings taken before the columns existed reviewable today. ──
  const structured = toInventory(asRecord(b.inventoryDetail) as never)
  const fromNotes = parseInventoryText([b.customerNotes, b.itemsDescription].filter(Boolean).join('\n'))
  let inv: Inventory = mergeInventory(structured, fromNotes)
  // numBoxes has its own column and predates all of this.
  if (inv.boxes === 0 && (b.numBoxes ?? 0) > 0) inv = { ...inv, boxes: b.numBoxes!, empty: false }
  const inventory = assessInventory(inv, shape.moveSizeKey)

  // ── Assembly ────────────────────────────────────────────────────────────
  const disItems = (b.disassemblyItems ?? '').trim()
  const reItems = (b.assemblyItems ?? '').trim()
  const disassemblyRequired = b.needsDisassembly === true
  const reassemblyRequired = b.needsAssembly === true
  // The customer ticking "assembly or disassembly needed" is a request even
  // when neither specific flag was stored — that checkbox is one control.
  const required = disassemblyRequired || reassemblyRequired || inv.assembly
  const scopeKnown = !required || !!(disItems || reItems)
  const assembly: AssemblyScope = {
    required,
    disassemblyRequired: disassemblyRequired || (inv.assembly && !reassemblyRequired),
    reassemblyRequired,
    disassemblyItems: disItems || null,
    reassemblyItems: reItems || null,
    feeCents: (b.assemblyFee ?? 0) + (b.disassemblyFee ?? 0),
    approvalRequired: b.assemblyApprovalRequired === true || (required && !scopeKnown),
    scopeKnown,
    label: !required ? 'Not required' : scopeKnown ? [disItems, reItems].filter(Boolean).join(' · ') : 'Needs clarification',
  }

  // ── COI ─────────────────────────────────────────────────────────────────
  const coiOrigin = normalizeCoi(b.coiRequiredOrigin)
  const coiDest = normalizeCoi(b.coiRequiredDest)
  const coiRequired = coiOrigin === 'yes' || coiDest === 'yes'
  // Never asked and asked-but-unknown are both "we do not know".
  const coiUnknown = coiOrigin == null || coiDest == null || coiOrigin === 'unknown' || coiDest === 'unknown'
  const coi = {
    origin: coiOrigin,
    dest: coiDest,
    required: coiRequired,
    unknown: coiUnknown && !coiRequired,
    notes: (b.coiNotes ?? '').trim() || null,
    label: coiRequired ? 'Required — review before approval' : coiUnknown ? 'Needs clarification' : 'Not required',
  }

  // ── Addresses / units ───────────────────────────────────────────────────
  const originParsed = normalizeAddressAndUnit(b.originAddress, b.originUnit)
  const destParsed = normalizeAddressAndUnit(b.destAddress, b.destUnit)
  const originEmbedded = originParsed.address !== (b.originAddress ?? '').trim()
  const destEmbedded = destParsed.address !== (b.destAddress ?? '').trim()

  // ── Money — the ONE calculation, never a local sum ──────────────────────
  const quote = computeQuote({
    totalEstimate: b.totalEstimate,
    baseRate: b.baseRate,
    travelFeeCents: b.travelFee,
    additionalCents: b.additionalCents,
    discountPercent: b.discountPercent,
    depositCents: b.depositAmount,
    collectedCents: b.collectedCents,
    authorizedNotCapturedCents: b.authorizedNotCapturedCents,
  })

  const discountRejected = Array.isArray(b.discountRejected)
    ? (b.discountRejected as { code?: unknown; message?: unknown }[])
        .map((r) => ({ code: String(r?.code ?? ''), message: String(r?.message ?? '') }))
        .filter((r) => r.code && r.message)
    : []

  const truckCostViolations = laborOnlyChargeViolations(b)
  const photoCount = b.photoCount ?? 0
  const crew = (b.crewNames ?? []).filter(Boolean)

  // ── The flags, most serious first ───────────────────────────────────────
  const flags: ScopeFlag[] = []

  if (truckCostViolations.length) {
    flags.push({
      code: 'labor_only_truck_cost',
      banner: BANNERS.truckCost,
      detail: `This is a labor-only job on the customer's truck, but it carries ${truckCostViolations
        .map((v) => `${v.label} ($${(v.cents / 100).toFixed(2)})`)
        .join(', ')}. Remove the charge before approving — we supply no truck on this job.`,
      severity: 'block',
    })
  }

  if (inventory.exceedsSelected) {
    flags.push({
      code: 'inventory_exceeds_size',
      banner: BANNERS.inventory,
      detail: `${inventory.reasons.join(' ')} Do not approve at the ${inventory.selectedLabel ?? 'selected'} price without deciding the size first.`,
      severity: 'review',
      cleared: b.inventoryReviewCleared === true,
    })
  }

  if (assembly.required && !assembly.scopeKnown) {
    flags.push({
      code: 'assembly_scope_unknown',
      banner: BANNERS.assembly,
      detail: 'The customer asked for assembly or disassembly but did not say which furniture. The quote cannot be finalized until we know what needs to be worked on.',
      severity: 'review',
    })
  }

  if (coi.required) {
    flags.push({
      code: 'coi_required',
      banner: BANNERS.coi,
      detail: `A certificate of insurance is required by ${[coiOrigin === 'yes' ? 'the pickup building' : null, coiDest === 'yes' ? 'the destination building' : null].filter(Boolean).join(' and ')}. Issue it before move day — buildings turn crews away at the dock.${coi.notes ? ` ${coi.notes}` : ''}`,
      severity: 'review',
    })
  } else if (coi.unknown) {
    flags.push({
      code: 'coi_unknown',
      banner: BANNERS.coiUnknown,
      detail: 'Neither building has confirmed whether a certificate of insurance is required. Ask before move day.',
      severity: 'info',
    })
  }

  if (inventory.photosRecommended && photoCount === 0) {
    flags.push({
      code: 'photos_recommended',
      banner: BANNERS.photos,
      // Named, not explained: four banners share one Discord field with a
      // 1024-character cap, and the long form was being cut mid-sentence.
      // The reasoning is still on the admin page via inventory.photoReasons.
      detail: `No photos are attached, and this booking lists ${inventory.photoItems.join(', ')}. Photos are not required to approve, but they are the difference between a quote and a guess.`,
      severity: 'info',
    })
  }

  if (originEmbedded || destEmbedded) {
    flags.push({
      code: 'unit_in_address',
      banner: BANNERS.unit,
      detail: `The unit was typed into the street address${originEmbedded && destEmbedded ? ' at both ends' : originEmbedded ? ' at pickup' : ' at the destination'}. It has been split out for display; save the booking to store it properly.`,
      severity: 'info',
    })
  }

  for (const r of discountRejected) {
    flags.push({ code: `discount_rejected_${r.code}`, banner: BANNERS.discount, detail: r.message, severity: 'info' })
  }

  const openFlags = flags.filter((f) => f.severity !== 'info' && !f.cleared)
  const hasOpenQuestions = openFlags.length > 0

  // ── The top block ───────────────────────────────────────────────────────
  const moveSizeValue = inventory.exceedsSelected && inventory.suggestedLabel
    ? `${shape.moveSizeLabel ?? 'Not selected'} (selected) — inventory suggests ${inventory.suggestedLabel}`
    : shape.moveSizeLabel ?? 'Not selected'

  const summary: { label: string; value: string; alert?: boolean }[] = [
    { label: 'Service Type', value: shape.serviceTypeLabel },
    { label: 'Move Size', value: moveSizeValue, alert: inventory.exceedsSelected },
    { label: 'Crew', value: crew.length ? crew.join(', ') : 'Not assigned', alert: crew.length === 0 },
  ]
  if (shape.serviceType === 'labor_only') {
    summary.push({
      label: 'Customer Truck',
      value: shape.truckProviderDetail ? `Yes — ${shape.truckProviderDetail}` : 'Yes',
    })
  } else {
    summary.push({ label: 'Truck Provider', value: shape.truckProviderLabel })
  }
  summary.push({ label: 'Inventory Review', value: inventory.exceedsSelected ? (b.inventoryReviewCleared ? 'Cleared by owner' : 'Required') : 'Not needed', alert: inventory.exceedsSelected && !b.inventoryReviewCleared })
  summary.push({ label: 'Assembly', value: assembly.label, alert: assembly.required && !assembly.scopeKnown })
  summary.push({ label: 'COI', value: coi.label, alert: coi.required || coi.unknown })
  summary.push({
    label: 'Final Quote',
    value: hasOpenQuestions ? 'Pending review' : `$${quote.finalTotalDollars.toFixed(2)}`,
    alert: hasOpenQuestions,
  })

  return {
    shape,
    inventory,
    assembly,
    coi,
    quote,
    discountRejected,
    truckCostViolations,
    addresses: {
      origin: { address: originParsed.address, unit: originParsed.unit, embeddedUnitFound: originEmbedded },
      dest: { address: destParsed.address, unit: destParsed.unit, embeddedUnitFound: destEmbedded },
    },
    photoCount,
    crew,
    flags,
    hasOpenQuestions,
    summary,
    headline: shape.serviceType === 'labor_only' ? 'LABOR ONLY' : 'FULL SERVICE',
    alertParagraph: buildAlertParagraph(shape, inventory, assembly, coi, hasOpenQuestions),
  }
}

/**
 * The paragraph the owner reads before anything else — the whole problem in
 * one breath, in the order the owner would ask about it.
 *
 * For WMIC-1019 this produces, verbatim:
 *   "⚠️ Customer selected 1 Bedroom, but inventory appears to be
 *    approximately 2-bedroom-sized. Customer provides truck.
 *    Assembly/disassembly scope is unknown. COI may be required.
 *    Review pricing before approval."
 */
function buildAlertParagraph(
  shape: ServiceShape,
  inventory: InventoryAssessment,
  assembly: AssemblyScope,
  coi: { required: boolean; unknown: boolean },
  hasOpenQuestions: boolean,
): string | null {
  const parts: string[] = []

  if (inventory.exceedsSelected && inventory.selectedLabel && inventory.suggestedLabel) {
    parts.push(
      `Customer selected ${inventory.selectedLabel}, but inventory appears to be approximately ${sizeInWords(inventory.suggestedKey)}-sized.`,
    )
  }
  if (shape.serviceType === 'labor_only') parts.push('Customer provides truck.')
  if (assembly.required && !assembly.scopeKnown) parts.push('Assembly/disassembly scope is unknown.')
  if (coi.required) parts.push('COI is required.')
  else if (coi.unknown) parts.push('COI may be required.')

  if (parts.length === 0) return null
  if (hasOpenQuestions) parts.push('Review pricing before approval.')
  return `⚠️ ${parts.join(' ')}`
}

/** '2br' → "2-bedroom", so the sentence reads like a person wrote it. */
function sizeInWords(key: PackageKey | null): string {
  if (!key) return 'larger'
  const m = key.match(/^(\d)br$/)
  if (m) return `${m[1]}-bedroom`
  if (key.endsWith('studio')) return PACKAGES[key].label.toLowerCase()
  return PACKAGES[key].label.toLowerCase()
}

/** One-line inventory recap for a card or an email. */
export const scopeInventoryLine = (s: BookingScope): string => describeInventory(s.inventory.inventory)
