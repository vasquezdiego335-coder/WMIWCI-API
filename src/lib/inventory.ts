// ════════════════════════════════════════════════════════════════════════
//  inventory.ts — WHAT IS ACTUALLY BEING MOVED, and whether the package the
//  customer picked can hold it.
//
//  THE BUG (owner spec, booking WMIC-1019): the customer selected "1 Bedroom"
//  and then listed 15 boxes, 2 beds, 3 dressers, 2 sofas, 2 tables, 2 TVs and
//  2 standing mirrors. That is a two-bedroom load. The system priced the
//  selection and never looked at the list, so a $550 flat rate was quoted
//  against a job the crew would have discovered on the doorstep.
//
//  THE RULE: the customer's selection is a REQUEST, not a measurement. When
//  the disclosed inventory does not fit the selected package the booking goes
//  to manual review — it is never auto-approved at the smaller price, and it
//  is never silently re-priced at the larger one either. An owner decides.
//
//  WHERE THE DATA COMES FROM. The booking form has collected structured
//  counts for a while, but the API had no columns for them, so the browser
//  folded them into the free-text notes as an "Inventory: …" line. This
//  module reads BOTH: structured input when present, and that legacy line
//  (plus loose phrases in the customer's own words) otherwise — which is what
//  makes an existing booking like WMIC-1019 reviewable today, with no
//  re-submission and no back-fill.
//
//  Pure and offline-testable.
// ════════════════════════════════════════════════════════════════════════

import { PACKAGES, type PackageKey } from './pricing-config'

export type Inventory = {
  boxes: number
  beds: number
  dressers: number
  sofas: number
  tables: number
  tvs: number
  mirrors: number
  appliances: number
  wardrobes: number
  desks: number
  /** Declared flags — each one is its own review signal. */
  piano: boolean
  safe: boolean
  oversized: boolean
  assembly: boolean
  /** True when nothing at all was disclosed. Not the same as an empty load. */
  empty: boolean
}

export const EMPTY_INVENTORY: Inventory = {
  boxes: 0, beds: 0, dressers: 0, sofas: 0, tables: 0, tvs: 0,
  mirrors: 0, appliances: 0, wardrobes: 0, desks: 0,
  piano: false, safe: false, oversized: false, assembly: false, empty: true,
}

/** Human labels, used in every warning this module produces. */
export const ITEM_LABELS: Record<CountKey, string> = {
  boxes: 'boxes',
  beds: 'beds/mattresses',
  dressers: 'dressers',
  sofas: 'sofas',
  tables: 'tables/chairs',
  tvs: 'TVs',
  mirrors: 'standing mirrors',
  appliances: 'appliances',
  wardrobes: 'wardrobes/armoires',
  desks: 'desks',
}

type CountKey = 'boxes' | 'beds' | 'dressers' | 'sofas' | 'tables' | 'tvs' | 'mirrors' | 'appliances' | 'wardrobes' | 'desks'

// ── VOLUME MODEL ──────────────────────────────────────────────────────────
//
// Approximate CUBIC FEET per item, at the sizes a residential move actually
// produces. These are deliberately mid-range rather than worst-case: the
// output is a REVIEW TRIGGER, and a model that flags every booking teaches
// the owner to ignore it.
const CUBIC_FEET: Record<CountKey, number> = {
  boxes: 3,        // a medium carton
  beds: 60,        // mattress, box spring and frame
  dressers: 30,
  sofas: 50,       // a standard three-seat sofa
  tables: 40,      // table plus its chairs
  tvs: 8,
  mirrors: 8,      // a floor-standing mirror: little volume, lots of care
  appliances: 25,
  wardrobes: 45,
  desks: 25,
}

/**
 * What each package is scoped to hold, in cubic feet. Derived from the same
 * room counts the price book publishes, so a package cannot be re-priced here
 * without also being re-scoped there.
 */
export const PACKAGE_CAPACITY_CUFT: Record<PackageKey, number> = {
  'little-studio': 150,
  'half-studio': 220,
  'full-studio': 300,
  '1br': 400,
  '2br': 700,
  '3br': 1000,
  '4br': 1400,
  '5br': 1800,
  'not-sure': 0, // no scope was ever selected — nothing to exceed
}

/** Bedrooms each package is scoped to. A load with more beds than this is a
 *  second, independent signal that the wrong package was selected. */
const PACKAGE_BEDROOMS: Record<PackageKey, number> = {
  'little-studio': 1, 'half-studio': 1, 'full-studio': 1,
  '1br': 1, '2br': 2, '3br': 3, '4br': 4, '5br': 5, 'not-sure': 0,
}

/** Headroom before a load counts as "too big". A flat rate already absorbs
 *  normal variance; this is the point past which it stops being variance. */
export const OVERSIZE_TOLERANCE = 1.10

const ORDERED_PACKAGES: PackageKey[] = [
  'little-studio', 'half-studio', 'full-studio', '1br', '2br', '3br', '4br', '5br',
]

// ── PARSING ───────────────────────────────────────────────────────────────

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Build an Inventory from structured input (the booking form's fields). */
export function toInventory(raw?: Partial<Record<CountKey, unknown>> & Partial<Record<'piano' | 'safe' | 'oversized' | 'assembly', unknown>> | null): Inventory {
  if (!raw) return { ...EMPTY_INVENTORY }
  const inv: Inventory = {
    boxes: num(raw.boxes), beds: num(raw.beds), dressers: num(raw.dressers),
    sofas: num(raw.sofas), tables: num(raw.tables), tvs: num(raw.tvs),
    mirrors: num(raw.mirrors), appliances: num(raw.appliances),
    wardrobes: num(raw.wardrobes), desks: num(raw.desks),
    piano: !!raw.piano, safe: !!raw.safe, oversized: !!raw.oversized, assembly: !!raw.assembly,
    empty: true,
  }
  inv.empty = !hasAnything(inv)
  return inv
}

function hasAnything(inv: Inventory): boolean {
  return (
    countKeys.some((k) => inv[k] > 0) ||
    inv.piano || inv.safe || inv.oversized || inv.assembly
  )
}

const countKeys: CountKey[] = ['boxes', 'beds', 'dressers', 'sofas', 'tables', 'tvs', 'mirrors', 'appliances', 'wardrobes', 'desks']

/** Phrases that identify each counted item in free text. Longest-first inside
 *  each entry so "box spring" can never be read as a carton. */
const TEXT_PATTERNS: { key: CountKey; re: RegExp }[] = [
  { key: 'beds', re: /\b(?:bed(?:s)?(?:\s*\/\s*mattress(?:es)?)?|mattress(?:es)?|bed\s*frames?|box\s*springs?)\b/i },
  { key: 'boxes', re: /\b(?:boxes|box(?!\s*spring))\b/i },
  { key: 'dressers', re: /\b(?:dressers?|chest(?:s)?\s*of\s*drawers)\b/i },
  { key: 'sofas', re: /\b(?:sofas?|couch(?:es)?|loveseats?|sectionals?)\b/i },
  { key: 'tables', re: /\b(?:tables?(?:\s*\/\s*chairs?)?|dining\s*sets?|chairs?)\b/i },
  { key: 'tvs', re: /\b(?:tvs?|televisions?|flat\s*screens?)\b/i },
  { key: 'mirrors', re: /\b(?:standing\s*mirrors?|floor\s*mirrors?|mirrors?)\b/i },
  { key: 'appliances', re: /\b(?:appliances?|refrigerators?|fridges?|washers?|dryers?|stoves?)\b/i },
  { key: 'wardrobes', re: /\b(?:wardrobes?|armoires?)\b/i },
  { key: 'desks', re: /\b(?:desks?)\b/i },
]

const FLAG_PATTERNS: { key: 'piano' | 'safe' | 'oversized' | 'assembly'; re: RegExp }[] = [
  { key: 'piano', re: /\bpianos?\b/i },
  { key: 'safe', re: /\b(?:safes?|gun\s*safes?)\b/i },
  { key: 'oversized', re: /\boversiz(?:e|ed)\b/i },
  { key: 'assembly', re: /\b(?:assembl(?:y|e|ing)|disassembl(?:y|e|ing)|re-?assembl(?:y|e|ing)|take\s*apart|put\s*(?:it\s*)?back\s*together)\b/i },
]

/**
 * Read an inventory out of free text — the "Inventory: 15 boxes, 2 beds…"
 * line the browser writes, or the customer's own sentences.
 *
 * A phrase only contributes a COUNT when a number sits directly in front of
 * it ("2 sofas"). A bare mention ("we have a sofa") is real information but
 * not a measurement, so it counts as one and nothing more. Deliberately
 * conservative: this feeds a review flag, and inventing quantities would
 * produce warnings nobody can act on.
 */
export function parseInventoryText(text?: string | null): Inventory {
  const src = (text ?? '').replace(/\s+/g, ' ')
  if (!src.trim()) return { ...EMPTY_INVENTORY }

  const inv: Inventory = { ...EMPTY_INVENTORY }
  // Split on commas / semicolons / newlines so "2 beds, 3 dressers" yields two
  // independent phrases and a count can never leak across an item boundary.
  const phrases = src.split(/[,;\n.]+/).map((p) => p.trim()).filter(Boolean)

  for (const phrase of phrases) {
    // Each item TYPE contributes at most once per phrase — "2 tables/chairs"
    // is one entry, not a table plus a chair — but a sentence naming two
    // different things ("a sofa and some boxes") counts both.
    for (const { key, re } of TEXT_PATTERNS) {
      const m = phrase.match(re)
      if (!m) continue
      // A number immediately before the item word is its quantity.
      const before = phrase.slice(0, m.index ?? 0)
      const qty = before.match(/(\d{1,3})\s*(?:x\s*)?$/)
      inv[key] += qty ? Math.min(999, parseInt(qty[1], 10)) : 1
    }
    for (const { key, re } of FLAG_PATTERNS) {
      if (re.test(phrase)) inv[key] = true
    }
  }

  inv.empty = !hasAnything(inv)
  return inv
}

/** Structured input wins; free text fills the gaps. Used on every read path so
 *  a booking taken before the columns existed still reviews correctly. */
export function mergeInventory(structured: Inventory, fromText: Inventory): Inventory {
  if (structured.empty) return fromText
  if (fromText.empty) return structured
  const out: Inventory = { ...structured }
  for (const k of countKeys) if (out[k] === 0) out[k] = fromText[k]
  out.piano ||= fromText.piano
  out.safe ||= fromText.safe
  out.oversized ||= fromText.oversized
  out.assembly ||= fromText.assembly
  out.empty = !hasAnything(out)
  return out
}

// ── SIZING ────────────────────────────────────────────────────────────────

/** Estimated volume of the disclosed load, in cubic feet. */
export function inventoryCubicFeet(inv: Inventory): number {
  return countKeys.reduce((sum, k) => sum + inv[k] * CUBIC_FEET[k], 0)
}

/** The smallest package scoped to hold this load. Null when nothing was
 *  disclosed — an unknown load has no suggested size, only an unknown one. */
export function suggestedPackage(inv: Inventory): PackageKey | null {
  if (inv.empty) return null
  const cuft = inventoryCubicFeet(inv)
  const byVolume = ORDERED_PACKAGES.find((k) => cuft <= PACKAGE_CAPACITY_CUFT[k]) ?? '5br'
  // Beds are the load-bearing signal for bedroom count: two beds is a
  // two-bedroom home however tidily it packs.
  const byBeds = inv.beds > 0
    ? ORDERED_PACKAGES.find((k) => PACKAGE_BEDROOMS[k] >= inv.beds) ?? '5br'
    : null
  if (!byBeds) return byVolume
  return ORDERED_PACKAGES.indexOf(byBeds) > ORDERED_PACKAGES.indexOf(byVolume) ? byBeds : byVolume
}

export type InventoryAssessment = {
  inventory: Inventory
  cubicFeet: number
  /** Capacity of the package the customer selected. 0 when none was selected. */
  capacityCubicFeet: number
  /** cubicFeet / capacity. >1 means the load does not fit the selection. */
  ratio: number
  selectedKey: PackageKey | null
  selectedLabel: string | null
  suggestedKey: PackageKey | null
  suggestedLabel: string | null
  /** THE verdict: the disclosed load is bigger than the selected package. */
  exceedsSelected: boolean
  /** Why — one plain sentence per signal, shown verbatim to the owner. */
  reasons: string[]
  /** The banner text, ready to render. Null when nothing is wrong. */
  warning: string | null
  /** Large / fragile / awkward items that photographs would resolve, with the
   *  reasoning. For the admin page, which has room for sentences. */
  photoReasons: string[]
  /** The same items, named only — for a Discord field with a character cap. */
  photoItems: string[]
  photosRecommended: boolean
}

export const INVENTORY_WARNING = '⚠️ INVENTORY EXCEEDS SELECTED MOVE SIZE — MANUAL REVIEW REQUIRED'

/**
 * Items whose real size cannot be judged from a count alone.
 *
 * Two wordings on purpose. `item` is the bare name, for a Discord card where
 * four banners share a 1024-character field and the long form got truncated
 * mid-sentence. `why` is the reasoning, for the admin page, which has room.
 */
const PHOTO_TRIGGERS: { test: (i: Inventory) => boolean; item: string; why: string }[] = [
  { test: (i) => i.sofas > 0, item: 'sofas', why: 'sofas (sectional vs. loveseat changes the crew and the truck)' },
  { test: (i) => i.beds > 0, item: 'beds/mattresses', why: 'beds/mattresses (frame type decides whether it comes apart)' },
  { test: (i) => i.dressers >= 2, item: 'large dressers', why: 'multiple dressers (weight and drawer contents)' },
  { test: (i) => i.mirrors > 0, item: 'standing mirrors', why: 'standing mirrors (fragile, need crating or blankets)' },
  { test: (i) => i.tvs > 0, item: 'TVs', why: 'TVs (screen size decides the box and the handling)' },
  { test: (i) => i.assembly, item: 'assembly/disassembly', why: 'assembly/disassembly (we need to see the joints and hardware)' },
  { test: (i) => i.piano, item: 'a piano', why: 'a piano' },
  { test: (i) => i.safe, item: 'a safe', why: 'a safe' },
  { test: (i) => i.oversized, item: 'oversized furniture', why: 'oversized furniture' },
]

/**
 * THE inventory verdict for one booking. Never re-prices anything and never
 * changes the selection — it reports, and the owner decides.
 */
export function assessInventory(inv: Inventory, selectedKey?: PackageKey | string | null): InventoryAssessment {
  const selected = (selectedKey && Object.prototype.hasOwnProperty.call(PACKAGES, selectedKey))
    ? (selectedKey as PackageKey)
    : null
  const cubicFeet = inventoryCubicFeet(inv)
  const capacity = selected ? PACKAGE_CAPACITY_CUFT[selected] : 0
  const suggested = suggestedPackage(inv)
  const reasons: string[] = []

  // Signal 1 — volume. The load simply does not fit what was bought.
  const ratio = capacity > 0 ? cubicFeet / capacity : 0
  if (selected && capacity > 0 && ratio > OVERSIZE_TOLERANCE) {
    reasons.push(
      `Disclosed inventory is about ${Math.round(cubicFeet)} cu ft; ${PACKAGES[selected].label} is scoped to about ${capacity} cu ft (${Math.round((ratio - 1) * 100)}% over).`
    )
  }

  // Signal 2 — bedrooms. Independent of how well the load packs.
  if (selected && inv.beds > PACKAGE_BEDROOMS[selected] && PACKAGE_BEDROOMS[selected] > 0) {
    reasons.push(
      `${inv.beds} beds/mattresses were listed, but ${PACKAGES[selected].label} is scoped to ${PACKAGE_BEDROOMS[selected]}.`
    )
  }

  // Signal 3 — the suggestion disagrees with the selection.
  if (selected && suggested && ORDERED_PACKAGES.indexOf(suggested) > ORDERED_PACKAGES.indexOf(selected) && reasons.length === 0) {
    reasons.push(`The disclosed items are typical of a ${PACKAGES[suggested].label} move.`)
  }

  const exceedsSelected = reasons.length > 0

  const triggered = PHOTO_TRIGGERS.filter((t) => t.test(inv))
  const photoReasons = triggered.map((t) => t.why)
  const photoItems = triggered.map((t) => t.item)

  return {
    inventory: inv,
    cubicFeet: Math.round(cubicFeet),
    capacityCubicFeet: capacity,
    ratio: Math.round(ratio * 100) / 100,
    selectedKey: selected,
    selectedLabel: selected ? PACKAGES[selected].label : null,
    suggestedKey: suggested,
    suggestedLabel: suggested ? PACKAGES[suggested].label : null,
    exceedsSelected,
    reasons,
    warning: exceedsSelected ? INVENTORY_WARNING : null,
    photoReasons,
    photoItems,
    photosRecommended: photoReasons.length > 0,
  }
}

/** "15 boxes, 2 beds/mattresses, 3 dressers" — the disclosed load, in order. */
export function describeInventory(inv: Inventory): string {
  const parts = countKeys.filter((k) => inv[k] > 0).map((k) => `${inv[k]} ${ITEM_LABELS[k]}`)
  if (inv.piano) parts.push('piano')
  if (inv.safe) parts.push('safe')
  if (inv.oversized) parts.push('oversized furniture')
  if (inv.assembly) parts.push('assembly/disassembly')
  return parts.join(', ')
}
