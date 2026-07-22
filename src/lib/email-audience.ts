// ════════════════════════════════════════════════════════════════════════
//  AUDIENCE BUILDER — who a campaign may be sent to (owner spec 2026-07-21)
//  ---------------------------------------------------------------------
//  THE THREAT THIS MODULE EXISTS TO CLOSE: an audience builder is the natural
//  place for someone to reach for "just let the owner write a query". That
//  would put arbitrary database access behind a web form, and a mistake in it
//  mails the wrong people — which, unlike a bad report, cannot be undone.
//
//  So the design is CLOSED, not open:
//    • A segment is chosen from a fixed list of named, hand-written queries.
//    • Filters are chosen from a fixed list of keys with validated value types.
//    • Anything unrecognised is REJECTED on write and again on read. There is
//      no "pass-through" branch, no string interpolation into a query, and no
//      place a caller can supply a Prisma fragment.
//    • Every query is BOUNDED by a hard take limit. There is no unbounded scan.
//
//  A PREVIEW IS NOT AUTHORIZATION. `previewAudience` reports what a send WOULD
//  reach; `resolveAudienceForDispatch` recomputes it from scratch at send time.
//  The two are separate functions on purpose — an audience previewed on Monday
//  and dispatched on Friday must not mail the Monday list.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { normalizeEmail } from './email-tokens'

/** Hard ceiling on any audience query. No segment may scan without a bound. */
export const MAX_AUDIENCE = 5000

// ── Approved segments ───────────────────────────────────────────────────

export const SEGMENTS = {
  new_leads_no_booking: 'New leads with no booking',
  quoted_leads_no_booking: 'Quoted leads with no booking',
  abandoned_booking: 'Started a booking, never paid the deposit',
  completed_customers: 'Customers whose move is complete',
  repeat_customers: 'Customers with more than one completed move',
  first_time_customers: 'Customers with exactly one completed move',
  review_eligible: 'Completed move, no review recorded',
  referral_eligible: 'Positive review, no referral ask sent',
  reengagement_eligible: 'No activity for the selected number of days',
} as const

export type SegmentKey = keyof typeof SEGMENTS

export const isSegmentKey = (v: unknown): v is SegmentKey =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(SEGMENTS, v)

// ── Approved filters ────────────────────────────────────────────────────
//  Each entry declares the ONLY shape its value may take. `parse` returns the
//  cleaned value or null to reject. There is deliberately no generic
//  "string filter" — every key names a real column and a real meaning.

type FilterSpec = {
  label: string
  parse: (raw: unknown) => unknown | null
}

const str = (max: number) => (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  return v.length > 0 && v.length <= max ? v : null
}

const int = (min: number, max: number) => (raw: unknown): number | null => {
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

const isoDate = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const oneOf = (allowed: readonly string[]) => (raw: unknown): string | null =>
  typeof raw === 'string' && allowed.includes(raw) ? raw : null

/** Service labels the booking form actually produces. Closed list. */
export const SERVICE_TYPES = ['Studio', '1 Bedroom', '2 Bedrooms', '3 Bedrooms', '4+ Bedrooms', 'Office', 'Single Item', 'Junk Removal'] as const

export const SERVICE_AREA_ZONES = ['CORE', 'EXTENDED', 'OUTER', 'OUT_OF_AREA'] as const

export const LOCALES = ['en', 'es'] as const

export const FILTERS: Record<string, FilterSpec> = {
  serviceType: { label: 'Service type', parse: oneOf(SERVICE_TYPES) },
  serviceAreaZone: { label: 'Service area zone', parse: oneOf(SERVICE_AREA_ZONES) },
  originCity: { label: 'Origin city', parse: str(80) },
  originZip: { label: 'Origin ZIP', parse: (raw) => (typeof raw === 'string' && /^\d{5}$/.test(raw.trim()) ? raw.trim() : null) },
  marketingSource: { label: 'Marketing source', parse: str(80) },
  campaignSourceKey: { label: 'Campaign source key', parse: str(80) },
  locale: { label: 'Customer language', parse: oneOf(LOCALES) },
  movedAfter: { label: 'Move completed after', parse: isoDate },
  movedBefore: { label: 'Move completed before', parse: isoDate },
  inactiveDays: { label: 'Inactive for at least (days)', parse: int(1, 3650) },
}

export type AudienceDefinition = {
  segment: SegmentKey
  filters: Record<string, unknown>
}

export type ValidationResult =
  | { ok: true; definition: AudienceDefinition }
  | { ok: false; errors: string[] }

/**
 * Validate a definition from ANY source — an API body, or a row read back out
 * of the database. Reading is validated too: a row written before a filter was
 * retired, or edited directly in the database, must not silently widen who gets
 * mailed.
 */
export function validateAudienceDefinition(raw: unknown): ValidationResult {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['An audience definition must be an object.'] }
  }
  const input = raw as Record<string, unknown>

  if (!isSegmentKey(input.segment)) {
    return {
      ok: false,
      errors: [`Unknown segment "${String(input.segment)}". Approved segments: ${Object.keys(SEGMENTS).join(', ')}.`],
    }
  }

  const rawFilters = input.filters
  if (rawFilters !== undefined && (typeof rawFilters !== 'object' || rawFilters === null || Array.isArray(rawFilters))) {
    return { ok: false, errors: ['`filters` must be an object.'] }
  }

  const filters: Record<string, unknown> = {}
  for (const [key, value] of Object.entries((rawFilters ?? {}) as Record<string, unknown>)) {
    const spec = FILTERS[key]
    // NO pass-through. An unknown key is a rejection, never an ignored extra —
    // silently dropping it would let a caller believe their audience is
    // narrower than the one that actually sends.
    if (!spec) {
      errors.push(`Unknown filter "${key}". Approved filters: ${Object.keys(FILTERS).join(', ')}.`)
      continue
    }
    const parsed = spec.parse(value)
    if (parsed === null) {
      errors.push(`Filter "${key}" has an invalid value.`)
      continue
    }
    filters[key] = parsed
  }

  if (input.segment === 'reengagement_eligible' && filters.inactiveDays === undefined) {
    errors.push('The re-engagement segment requires `inactiveDays`.')
  }
  if (filters.movedAfter && filters.movedBefore && String(filters.movedAfter) > String(filters.movedBefore)) {
    errors.push('`movedAfter` is later than `movedBefore`.')
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, definition: { segment: input.segment, filters } }
}

// ── Candidate resolution ────────────────────────────────────────────────

export type Candidate = {
  email: string
  name: string | null
  customerId: string | null
  leadId: string | null
  bookingId: string | null
}

const DAY = 24 * 60 * 60 * 1000

/** Booking-side filters, expressed as a Prisma `where` fragment we build. */
function bookingWhere(f: Record<string, unknown>): Record<string, unknown> {
  const where: Record<string, unknown> = { isInternalTest: false }
  if (f.serviceType) where.itemsDescription = { contains: String(f.serviceType), mode: 'insensitive' }
  if (f.serviceAreaZone) where.serviceAreaZone = f.serviceAreaZone
  if (f.originCity) where.originCity = { equals: String(f.originCity), mode: 'insensitive' }
  if (f.originZip) where.originZip = f.originZip
  if (f.marketingSource) {
    where.OR = [
      { source: f.marketingSource },
      { bookingSource: f.marketingSource },
      { ownerAssignedSource: f.marketingSource },
      { utmSource: f.marketingSource },
    ]
  }
  if (f.campaignSourceKey) where.utmCampaign = f.campaignSourceKey
  if (f.movedAfter || f.movedBefore) {
    const range: Record<string, Date> = {}
    if (f.movedAfter) range.gte = new Date(String(f.movedAfter))
    if (f.movedBefore) range.lte = new Date(String(f.movedBefore))
    where.completedAt = range
  }
  return where
}

function leadWhere(f: Record<string, unknown>): Record<string, unknown> {
  const where: Record<string, unknown> = { email: { not: null } }
  if (f.originCity) where.originCity = { equals: String(f.originCity), mode: 'insensitive' }
  if (f.originZip) where.zip = f.originZip
  if (f.marketingSource) where.utmSource = f.marketingSource
  if (f.campaignSourceKey) where.utmCampaign = f.campaignSourceKey
  return where
}

/**
 * Run the named segment. Every branch is a HAND-WRITTEN query — there is no
 * generic query builder here, and therefore no way to express a query nobody
 * reviewed.
 */
export async function resolveCandidates(def: AudienceDefinition): Promise<Candidate[]> {
  const f = def.filters
  const take = MAX_AUDIENCE

  switch (def.segment) {
    case 'new_leads_no_booking':
    case 'quoted_leads_no_booking': {
      const quoted = def.segment === 'quoted_leads_no_booking'
      const leads = await prisma.lead.findMany({
        where: {
          ...leadWhere(f),
          convertedBookingId: null,
          bookedAt: null,
          lostAt: null,
          status: { notIn: ['BOOKED', 'LOST'] },
          ...(quoted ? { quotedAt: { not: null } } : { quotedAt: null }),
        },
        select: { id: true, email: true, name: true },
        take,
      })
      return leads
        .filter((l) => l.email)
        .map((l) => ({ email: l.email as string, name: l.name, customerId: null, leadId: l.id, bookingId: null }))
    }

    case 'abandoned_booking': {
      const rows = await prisma.booking.findMany({
        where: { ...bookingWhere(f), status: 'PENDING_PAYMENT', depositPaid: false },
        select: { id: true, customer: { select: { id: true, email: true, name: true, locale: true } } },
        take,
      })
      return rows
        .filter((b) => (f.locale ? b.customer.locale === f.locale : true))
        .map((b) => ({ email: b.customer.email, name: b.customer.name, customerId: b.customer.id, leadId: null, bookingId: b.id }))
    }

    case 'completed_customers': {
      const rows = await prisma.booking.findMany({
        where: { ...bookingWhere(f), status: { in: ['COMPLETED', 'ARCHIVED'] } },
        select: { id: true, customer: { select: { id: true, email: true, name: true, locale: true } } },
        take,
      })
      return dedupe(rows, f)
    }

    case 'repeat_customers':
    case 'first_time_customers': {
      const rows = await prisma.booking.findMany({
        where: { ...bookingWhere(f), status: { in: ['COMPLETED', 'ARCHIVED'] } },
        select: { id: true, customerId: true, customer: { select: { id: true, email: true, name: true, locale: true } } },
        take,
      })
      const counts = new Map<string, number>()
      for (const r of rows) counts.set(r.customerId, (counts.get(r.customerId) ?? 0) + 1)
      const wantRepeat = def.segment === 'repeat_customers'
      return dedupe(
        rows.filter((r) => (wantRepeat ? (counts.get(r.customerId) ?? 0) > 1 : (counts.get(r.customerId) ?? 0) === 1)),
        f
      )
    }

    case 'review_eligible': {
      const rows = await prisma.booking.findMany({
        where: { ...bookingWhere(f), status: { in: ['COMPLETED', 'ARCHIVED'] }, review: null },
        select: { id: true, customer: { select: { id: true, email: true, name: true, locale: true } } },
        take,
      })
      return dedupe(rows, f)
    }

    case 'referral_eligible': {
      // A positive review is the proof. Without one there is no referral ask —
      // the same rule followups.ts applies, not a looser one for bulk sending.
      const rows = await prisma.booking.findMany({
        where: { ...bookingWhere(f), status: { in: ['COMPLETED', 'ARCHIVED'] }, review: { isPositive: true } },
        select: { id: true, customer: { select: { id: true, email: true, name: true, locale: true } } },
        take,
      })
      const already = await prisma.emailSend.findMany({
        where: { template: 'referral', bookingId: { in: rows.map((r) => r.id) }, status: 'delivered' },
        select: { bookingId: true },
      })
      const asked = new Set(already.map((a) => a.bookingId))
      return dedupe(rows.filter((r) => !asked.has(r.id)), f)
    }

    case 'reengagement_eligible': {
      const days = Number(f.inactiveDays)
      const cutoff = new Date(Date.now() - days * DAY)
      const rows = await prisma.booking.findMany({
        where: { ...bookingWhere(f), status: { in: ['COMPLETED', 'ARCHIVED'] }, completedAt: { lt: cutoff } },
        select: { id: true, customerId: true, customer: { select: { id: true, email: true, name: true, locale: true } } },
        take,
      })
      // Exclude anyone with ANY booking activity since the cutoff.
      const recent = await prisma.booking.findMany({
        where: { customerId: { in: rows.map((r) => r.customerId) }, createdAt: { gte: cutoff }, isInternalTest: false },
        select: { customerId: true },
      })
      const active = new Set(recent.map((r) => r.customerId))
      return dedupe(rows.filter((r) => !active.has(r.customerId)), f)
    }
  }
}

type BookingRow = { id: string; customer: { id: string; email: string; name: string; locale: string } }

function dedupe(rows: BookingRow[], f: Record<string, unknown>): Candidate[] {
  const seen = new Map<string, Candidate>()
  for (const r of rows) {
    if (f.locale && r.customer.locale !== f.locale) continue
    const key = normalizeEmail(r.customer.email)
    if (!key || seen.has(key)) continue
    seen.set(key, { email: r.customer.email, name: r.customer.name, customerId: r.customer.id, leadId: null, bookingId: r.id })
  }
  return Array.from(seen.values())
}

// ── Preview (with every exclusion named) ────────────────────────────────

export type AudiencePreview = {
  segment: SegmentKey
  segmentLabel: string
  /** Everyone the segment matched before any exclusion. */
  totalCandidates: number
  excluded: {
    invalidAddress: number
    unsubscribed: number
    hardBounce: number
    complaint: number
    otherSuppression: number
    marketingOptOut: number
    duplicate: number
  }
  /** Who would actually be mailed. */
  eligible: number
  /** True when the segment hit the hard bound — the real audience is larger. */
  truncated: boolean
  sample: Array<{ email: string; name: string | null }>
  error: string | null
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

/**
 * What a send WOULD reach right now, with every exclusion counted separately.
 * An owner about to mail people deserves to see "412 matched, 38 suppressed,
 * 374 will receive it" — not one number they have to trust.
 */
export async function previewAudience(def: AudienceDefinition): Promise<AudiencePreview> {
  const base: AudiencePreview = {
    segment: def.segment,
    segmentLabel: SEGMENTS[def.segment],
    totalCandidates: 0,
    excluded: { invalidAddress: 0, unsubscribed: 0, hardBounce: 0, complaint: 0, otherSuppression: 0, marketingOptOut: 0, duplicate: 0 },
    eligible: 0,
    truncated: false,
    sample: [],
    error: null,
  }

  try {
    const candidates = await resolveCandidates(def)
    base.totalCandidates = candidates.length
    base.truncated = candidates.length >= MAX_AUDIENCE

    const seen = new Set<string>()
    const unique: Candidate[] = []
    for (const c of candidates) {
      const key = normalizeEmail(c.email)
      if (!key || !EMAIL_RE.test(key)) {
        base.excluded.invalidAddress++
        continue
      }
      if (seen.has(key)) {
        base.excluded.duplicate++
        continue
      }
      seen.add(key)
      unique.push({ ...c, email: key })
    }

    const emails = unique.map((c) => c.email)
    const [suppressions, optedOut] = await Promise.all([
      prisma.emailSuppression.findMany({ where: { email: { in: emails } }, select: { email: true, reason: true } }),
      prisma.customer.findMany({ where: { email: { in: emails }, marketingOptOut: true }, select: { email: true } }),
    ])

    const byEmail = new Map(suppressions.map((s) => [s.email, s.reason as string]))
    const optOut = new Set(optedOut.map((c) => normalizeEmail(c.email)))

    const eligible: Candidate[] = []
    for (const c of unique) {
      const reason = byEmail.get(c.email)
      if (reason === 'UNSUBSCRIBED') {
        base.excluded.unsubscribed++
        continue
      }
      if (reason === 'HARD_BOUNCE') {
        base.excluded.hardBounce++
        continue
      }
      if (reason === 'SPAM_COMPLAINT') {
        base.excluded.complaint++
        continue
      }
      if (reason) {
        base.excluded.otherSuppression++
        continue
      }
      // TCPA/marketing opt-out is a separate signal from the email suppression
      // list and must be honoured for promotional mail too.
      if (optOut.has(c.email)) {
        base.excluded.marketingOptOut++
        continue
      }
      eligible.push(c)
    }

    base.eligible = eligible.length
    base.sample = eligible.slice(0, 5).map((c) => ({ email: c.email, name: c.name }))
    return base
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err)
    return base
  }
}

/** One candidate excluded at dispatch, with the machine-readable why. */
export type ExcludedCandidate = { candidate: Candidate; reason: string }

export type DetailedAudience = {
  /** Deduped, valid, unsuppressed — the people a dispatch may mail. */
  eligible: Candidate[]
  /** Everyone else the segment matched, each with a named reason. */
  excluded: ExcludedCandidate[]
  /** True when the segment hit MAX_AUDIENCE — the real audience is larger. */
  truncated: boolean
}

/**
 * The DISPATCH-time audience, with every exclusion kept as a ROW rather than
 * a count — the campaign run records each skipped person and why, so "why
 * didn't X get this?" has an answer. Suppression is re-checked here AND again
 * inside the send guard for every individual message.
 */
export async function resolveAudienceDetailed(def: AudienceDefinition): Promise<DetailedAudience> {
  const candidates = await resolveCandidates(def)
  const truncated = candidates.length >= MAX_AUDIENCE

  const seen = new Set<string>()
  const unique: Candidate[] = []
  const excluded: ExcludedCandidate[] = []
  for (const c of candidates) {
    const key = normalizeEmail(c.email)
    if (!key || !EMAIL_RE.test(key)) {
      excluded.push({ candidate: c, reason: 'invalid_address' })
      continue
    }
    if (seen.has(key)) {
      excluded.push({ candidate: { ...c, email: key }, reason: 'duplicate' })
      continue
    }
    seen.add(key)
    unique.push({ ...c, email: key })
  }

  const emails = unique.map((c) => c.email)
  const [suppressions, optedOut] = await Promise.all([
    prisma.emailSuppression.findMany({ where: { email: { in: emails } }, select: { email: true, reason: true } }),
    prisma.customer.findMany({ where: { email: { in: emails }, marketingOptOut: true }, select: { email: true } }),
  ])
  const suppressionByEmail = new Map(suppressions.map((s) => [s.email, s.reason as string]))
  const optOut = new Set(optedOut.map((c) => normalizeEmail(c.email)))

  const eligible: Candidate[] = []
  for (const c of unique) {
    const suppressionReason = suppressionByEmail.get(c.email)
    if (suppressionReason === 'UNSUBSCRIBED') {
      excluded.push({ candidate: c, reason: 'unsubscribed' })
      continue
    }
    if (suppressionReason) {
      excluded.push({ candidate: c, reason: `suppressed:${suppressionReason.toLowerCase()}` })
      continue
    }
    if (optOut.has(c.email)) {
      excluded.push({ candidate: c, reason: 'marketing_opt_out' })
      continue
    }
    eligible.push(c)
  }

  return { eligible, excluded, truncated }
}

/**
 * The DISPATCH-time audience. Deliberately a separate function from
 * `previewAudience`, and deliberately returns the recipients rather than a
 * count: an audience previewed on Monday must never be the list that sends on
 * Friday.
 */
export async function resolveAudienceForDispatch(def: AudienceDefinition): Promise<{ recipients: Candidate[]; preview: AudiencePreview }> {
  const preview = await previewAudience(def)
  if (preview.error) return { recipients: [], preview }
  const detailed = await resolveAudienceDetailed(def)
  return { recipients: detailed.eligible, preview }
}
