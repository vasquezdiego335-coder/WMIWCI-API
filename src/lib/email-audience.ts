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
import { activeLifecycleReason, activeRecoveryReason, reactivationCutoff } from './email-reactivation'

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
  // ── Reactivation pool (owner spec 2026-08-07) ─────────────────────────
  //  The 14-day rule lives in email-reactivation.ts. These segments are the
  //  SQL half: leads whose lifecycle has finished and who have aged into the
  //  campaign pool. They are DISTINCT audiences on purpose — "requested a
  //  quote and went quiet" and "wrote to us and went quiet" deserve different
  //  copy, and neither is "abandoned checkout", which requires a real booking.
  quick_quote_reactivation: 'Quoted 14+ days ago, opted in, never booked',
  contact_lead_reactivation: 'Contacted us 14+ days ago, opted in, never quoted or booked',
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
  // ── PROMOTIONAL CONSENT GATE (owner spec 2026-07-24) ──────────────────────
  // A self-captured partial-booking lead (PARTIAL / IN_PROGRESS / ABANDONED) is
  // NOT promotable unless it explicitly opted in. Entering an email to request a
  // move is not consent to marketing. Excludes those rows unless
  // emailMarketingConsent === true. Ordinary CRM leads (lifecycle null) and
  // CONVERTED leads are UNAFFECTED — so no existing audience changes. Prisma's
  // `not: true` on a nullable boolean matches both false and null.
  // Mirrors leads.partialLeadBlockedFromPromo() (the unit-tested definition).
  where.NOT = {
    lifecycle: { in: ['PARTIAL', 'IN_PROGRESS', 'ABANDONED'] },
    emailMarketingConsent: { not: true },
  }
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

    // ── Reactivation pool (owner spec 2026-08-07) ─────────────────────────
    //  Consent is enforced IN THE SQL here, unlike the legacy segments —
    //  these two exist only for people we may market to, so matching anyone
    //  else is wasted work the shared consent gate would discard anyway.
    //  The 14-day age + "not converted/lost" mirror
    //  email-reactivation.reactivationBlockReason; the active-lifecycle
    //  exclusion runs in resolveAudienceDetailed for every segment.
    case 'quick_quote_reactivation':
    case 'contact_lead_reactivation': {
      const quoted = def.segment === 'quick_quote_reactivation'
      const cutoff = reactivationCutoff(new Date())
      const leads = await prisma.lead.findMany({
        where: {
          ...leadWhere(f),
          emailMarketingConsent: true,
          convertedBookingId: null,
          bookedAt: null,
          lostAt: null,
          status: { notIn: ['BOOKED', 'LOST'] },
          // "Still planning your move?" must not land after the move.
          OR: [{ moveDate: null }, { moveDate: { gte: new Date() } }],
          ...(quoted
            ? { quotedAt: { not: null, lte: cutoff } }
            : { quotedAt: null, lastActivityAt: { lte: cutoff } }),
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

/**
 * THE PROMOTIONAL CONSENT GATE (near-miss 2026-07-25).
 *
 * The consent requirement was previously enforced only inside `leadWhere()`, so
 * it covered LEAD-based segments and nothing else. `bookingWhere()` filters on
 * `isInternalTest` alone — so every BOOKING-based segment (abandoned_booking,
 * completed_customers, repeat/first_time, review_eligible, referral_eligible,
 * reengagement_eligible) resolved real customers who had NEVER opted in.
 *
 * Caught while rehearsing a 1-recipient campaign: `abandoned_booking` returned
 * SIX people, five with `emailMarketingConsent = null`, two of them real
 * customers with June/July bookings.
 *
 * Enforcing here — at the shared, email-keyed choke point both `previewAudience`
 * and `resolveAudienceDetailed` run — makes the rule true for EVERY segment at
 * once, present and future, rather than relying on each resolver to remember.
 *
 * Consent may live on either record (a person can be a Lead, a Customer, or
 * both), so an explicit `true` on EITHER grants it. Anything else — false, null,
 * or no record at all — is NOT consent. Entering an email is not opting in.
 */
async function consentingEmails(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set()
  const [customers, leads] = await Promise.all([
    prisma.customer.findMany({
      where: { email: { in: emails }, emailMarketingConsent: true },
      select: { email: true },
    }),
    prisma.lead.findMany({
      where: { email: { in: emails }, emailMarketingConsent: true },
      select: { email: true },
    }),
  ])
  const set = new Set<string>()
  for (const r of customers) set.add(normalizeEmail(r.email))
  for (const r of leads) if (r.email) set.add(normalizeEmail(r.email))
  return set
}

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
    /** No explicit promotional opt-in (fails closed — absence is not consent). */
    noConsent: number
    duplicate: number
    /** A lifecycle journey currently owns them — the campaign waits its turn. */
    activeLifecycle: number
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
    excluded: { invalidAddress: 0, unsubscribed: 0, hardBounce: 0, complaint: 0, otherSuppression: 0, marketingOptOut: 0, noConsent: 0, duplicate: 0, activeLifecycle: 0 },
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
    const [suppressions, optedOut, consenting, lifecycleOwned] = await Promise.all([
      prisma.emailSuppression.findMany({ where: { email: { in: emails } }, select: { email: true, reason: true } }),
      prisma.customer.findMany({ where: { email: { in: emails }, marketingOptOut: true }, select: { email: true } }),
      consentingEmails(emails),
      lifecycleOwnedEmails(emails),
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
      // PROMOTIONAL CONSENT — required for every segment. Absence of an explicit
      // opt-in is NOT permission, so this fails closed.
      if (!consenting.has(c.email)) {
        base.excluded.noConsent++
        continue
      }
      // LIFECYCLE BEATS CAMPAIGNS — the preview shows the same exclusion the
      // dispatch applies, so the owner's count is the count that sends.
      const owned = lifecycleOwned.get(c.email)
      if (owned && !(c.bookingId && owned === 'active_checkout_recovery')) {
        base.excluded.activeLifecycle++
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

/**
 * How far back an unresolved ambiguous send blocks a re-send of the same
 * campaign. Long enough to cover a realistic reconciliation window; not
 * unbounded, because an address must not be permanently unreachable because of
 * one provider timeout a year ago.
 */
export const AMBIGUOUS_WINDOW_DAYS = Number(process.env.EMAIL_AMBIGUOUS_WINDOW_DAYS) || 30

/**
 * Addresses with an UNRESOLVED send for this campaign — the provider request
 * left us and we never learned the outcome.
 *
 * Only 'ambiguous' qualifies. A 'delivered' send does NOT exclude anyone: a
 * customer may legitimately receive a campaign twice if an owner deliberately
 * re-dispatches. The danger is exclusively the send we cannot rule out.
 *
 * Fails CLOSED on a database error: if we cannot prove the outcome is known,
 * we do not send. An empty set here would silently reopen the duplicate path
 * this function exists to close.
 */
export async function priorAmbiguousEmails(
  emails: string[],
  campaignId: string | null,
  windowDays: number = AMBIGUOUS_WINDOW_DAYS
): Promise<Set<string>> {
  if (!campaignId || emails.length === 0) return new Set()
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  try {
    const rows = await prisma.emailSend.findMany({
      where: { campaignId, email: { in: emails }, status: 'ambiguous', createdAt: { gte: since } },
      select: { email: true },
    })
    return new Set(rows.map((r) => normalizeEmail(r.email)))
  } catch (err) {
    // Fail closed: treat every candidate as possibly ambiguous rather than
    // risk a duplicate to a real customer.
    throw new Error(`ambiguous-outcome check failed, refusing to send: ${err instanceof Error ? err.message : String(err)}`)
  }
}

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
export async function resolveAudienceDetailed(
  def: AudienceDefinition,
  opts: { campaignId?: string | null; ambiguousWindowDays?: number } = {}
): Promise<DetailedAudience> {
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
  const [suppressions, optedOut, consenting, priorAmbiguous, lifecycleOwned] = await Promise.all([
    prisma.emailSuppression.findMany({ where: { email: { in: emails } }, select: { email: true, reason: true } }),
    prisma.customer.findMany({ where: { email: { in: emails }, marketingOptOut: true }, select: { email: true } }),
    consentingEmails(emails),
    priorAmbiguousEmails(emails, opts.campaignId ?? null, opts.ambiguousWindowDays ?? AMBIGUOUS_WINDOW_DAYS),
    lifecycleOwnedEmails(emails),
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
    // PROMOTIONAL CONSENT — required for every segment; fails closed.
    if (!consenting.has(c.email)) {
      excluded.push({ candidate: c, reason: 'no_consent' })
      continue
    }
    // ── LIFECYCLE BEATS CAMPAIGNS (owner spec 2026-08-07) ─────────────────
    // Someone a journey currently owns — an active quote follow-up, an active
    // nurture, an active checkout recovery — must not also receive a generic
    // campaign the same week. Before this, the ONLY thing separating the two
    // was the daily frequency cap at send time, which DEFERS rather than
    // drops: the person got both, a day apart. Excluding them here means the
    // campaign simply never claims them; when the lifecycle lets go and they
    // age into the reactivation pool, the next dispatch may.
    // Booking-scoped segments are exempt for their OWN booking's recovery —
    // an abandoned_booking campaign IS the recovery conversation.
    const owned = lifecycleOwned.get(c.email)
    if (owned && !(c.bookingId && owned === 'active_checkout_recovery')) {
      excluded.push({ candidate: c, reason: `active_lifecycle:${owned}` })
      continue
    }
    // CROSS-RUN AMBIGUOUS OUTCOME (audit E-03). Within one run the idempotency
    // key makes a resend impossible, but the key is scoped PER RUN — a second
    // dispatch of the same campaign mints a new key, so someone whose previous
    // outcome was unknown (the provider may already have delivered it) would
    // receive a DUPLICATE. That is the exact harm the ambiguous state exists to
    // prevent, so they are held out for human reconciliation instead.
    if (priorAmbiguous.has(c.email)) {
      excluded.push({ candidate: c, reason: 'prior_ambiguous_outcome' })
      continue
    }
    eligible.push(c)
  }

  return { eligible, excluded, truncated }
}

/**
 * Which of these addresses does a LIFECYCLE currently own?
 *
 * Answered from DATE MATH on the database rows (email-reactivation.ts owns the
 * windows), deliberately not from the Redis queue: the answer is deterministic,
 * testable, and survives a queue wipe. Erring a day on the side of "still
 * owned" is the safe error — the campaign waits, nobody is double-mailed.
 *
 * FAILS OPEN on a read error: the shared consent/suppression gates and the
 * send-time frequency caps still stand, and losing a whole campaign to a
 * transient read failure is the worse outcome.
 */
async function lifecycleOwnedEmails(emails: string[]): Promise<Map<string, string>> {
  const owned = new Map<string, string>()
  if (emails.length === 0) return owned
  const now = new Date()
  try {
    const [leads, bookings] = await Promise.all([
      prisma.lead.findMany({
        where: { email: { in: emails }, bookedAt: null, convertedBookingId: null, lostAt: null },
        select: { email: true, quotedAt: true, lastActivityAt: true, createdAt: true },
      }),
      prisma.booking.findMany({
        where: {
          status: 'PENDING_PAYMENT',
          depositPaid: false,
          isInternalTest: false,
          customer: { email: { in: emails } },
        },
        select: { createdAt: true, status: true, depositPaid: true, customer: { select: { email: true } } },
      }),
    ])
    for (const l of leads) {
      const email = normalizeEmail(l.email ?? '')
      if (!email || owned.has(email)) continue
      const reason = activeLifecycleReason(l, now)
      if (reason) owned.set(email, reason)
    }
    for (const b of bookings) {
      const email = normalizeEmail(b.customer.email)
      if (!email || owned.has(email)) continue
      const reason = activeRecoveryReason(b, now)
      if (reason) owned.set(email, reason)
    }
  } catch (err) {
    // Logged by the caller's own diagnostics; an empty map means "no exclusions".
    console.warn(`lifecycle-owned lookup failed (fails open): ${err instanceof Error ? err.message : String(err)}`)
  }
  return owned
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
