// ════════════════════════════════════════════════════════════════════════
//  leads.ts — THE ONE lead-ingestion path. createOrUpdateLead() is the single
//  writer for the Lead table, used by every public inquiry source so nothing
//  disappears into a Discord message or an inbox:
//     • website contact form        (/api/contact)
//     • coupon / promo popup         (/api/coupons)
//     • "not sure" quote booking     (/api/bookings, serviceType='not-sure')
//     • marketing tracker            (/api/notify/lead, server-to-server)
//
//  PERSIST-BEFORE-NOTIFY: callers save the Lead here FIRST, then fire their
//  Discord/email/SMS alert. A notification failure never loses the Lead.
//
//  DEDUPE (architecture review Q11 — avoid wrongly merging distinct people):
//    • Email-first. If the submission has an email AND there is an OPEN lead
//      (NEW/CONTACTED/QUOTE_SENT/FOLLOW_UP) with that normalized email, we UPDATE
//      it (bump last activity, append the new message, fill blank fields) rather
//      than spawn a duplicate. A closed lead (BOOKED/LOST) starts a fresh one.
//    • No email → always CREATE. We deliberately do NOT dedupe by phone: a shared
//      family/business number would wrongly merge two different customers. Phone
//      duplicates are a nuisance to clean later, not a data-loss risk.
//
//  Dependency-injected (LeadDeps) so the dedupe decision + field mapping are
//  unit-tested offline with an in-memory store.
// ════════════════════════════════════════════════════════════════════════
import { LeadSource, LeadStatus } from '@prisma/client'
import { prisma } from './db'
import { apiLogger } from './logger'

const OPEN_STATUSES: LeadStatus[] = [LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.QUOTE_SENT, LeadStatus.FOLLOW_UP]

export type LeadInput = {
  name?: string | null
  phone?: string | null
  email?: string | null
  message?: string | null
  /** Free-form source string; mapped to the LeadSource enum. */
  source?: string | null
  foundUs?: string | null
  jobType?: string | null
  moveDate?: Date | null
  zip?: string | null
  originCity?: string | null
  destCity?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  landingPage?: string | null
  referrer?: string | null
  promoCode?: string | null
  estimatedValue?: number | null // cents
}

export type LeadRecord = { id: string; status: LeadStatus }
export type CreateOrUpdateResult = { lead: LeadRecord; isNew: boolean }

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

export function normalizeEmail(email?: string | null): string | null {
  const e = (email ?? '').trim().toLowerCase()
  return e.length > 3 && e.includes('@') ? e : null
}

/** Digits only, for comparison — never used as a dedupe key (see header). */
export function normalizePhone(phone?: string | null): string | null {
  const d = (phone ?? '').replace(/\D/g, '')
  return d.length >= 7 ? d : null
}

const SOURCE_MAP: Record<string, LeadSource> = {
  google: LeadSource.GOOGLE,
  'google-business': LeadSource.GOOGLE,
  gbp: LeadSource.GOOGLE,
  facebook: LeadSource.FACEBOOK,
  fb: LeadSource.FACEBOOK,
  instagram: LeadSource.INSTAGRAM,
  ig: LeadSource.INSTAGRAM,
  door_hanger: LeadSource.DOOR_HANGER,
  'door-hanger': LeadSource.DOOR_HANGER,
  doorhanger: LeadSource.DOOR_HANGER,
  yard_sign: LeadSource.YARD_SIGN,
  'yard-sign': LeadSource.YARD_SIGN,
  referral: LeadSource.REFERRAL,
  craigslist: LeadSource.CRAIGSLIST,
  offerup: LeadSource.OFFERUP,
  returning: LeadSource.RETURNING_CUSTOMER,
  returning_customer: LeadSource.RETURNING_CUSTOMER,
  website: LeadSource.WEBSITE,
  contact: LeadSource.WEBSITE,
  'contact-form': LeadSource.WEBSITE,
  web: LeadSource.WEBSITE,
}

export function mapLeadSource(source?: string | null): LeadSource {
  const key = (source ?? '').trim().toLowerCase()
  return SOURCE_MAP[key] ?? LeadSource.OTHER
}

const clean = (v?: string | null): string | null => {
  const s = (v ?? '').trim()
  return s.length ? s : null
}

/** Compose the human-readable notes log (message + "found us" note). */
function composeNotes(input: LeadInput): string | null {
  const parts = [clean(input.message), input.foundUs ? `Found us: ${clean(input.foundUs)}` : null].filter(Boolean)
  return parts.length ? parts.join('\n') : null
}

/** The row to CREATE from a fresh submission. Pure. */
export function buildLeadCreate(input: LeadInput, now: Date) {
  return {
    name: clean(input.name) ?? 'Website lead',
    phone: clean(input.phone),
    email: normalizeEmail(input.email),
    source: mapLeadSource(input.source),
    status: LeadStatus.NEW,
    message: clean(input.message),
    notes: composeNotes(input),
    jobType: clean(input.jobType),
    moveDate: input.moveDate ?? null,
    zip: clean(input.zip),
    originCity: clean(input.originCity),
    destCity: clean(input.destCity),
    utmSource: clean(input.utmSource),
    utmMedium: clean(input.utmMedium),
    utmCampaign: clean(input.utmCampaign),
    utmContent: clean(input.utmContent),
    utmTerm: clean(input.utmTerm),
    landingPage: clean(input.landingPage),
    referrer: clean(input.referrer),
    promoCode: clean(input.promoCode),
    estimatedValue: input.estimatedValue ?? null,
    lastActivityAt: now,
  }
}

export type ExistingLead = {
  id: string
  status: LeadStatus
  name: string // Lead.name is required (non-null) in the schema
  phone: string | null
  notes: string | null
  message: string | null
  moveDate: Date | null
  zip: string | null
  originCity: string | null
  destCity: string | null
  jobType: string | null
  promoCode: string | null
}

/** The patch to UPDATE an existing OPEN lead with a repeat submission. Pure:
 *  bumps activity, appends the new message, and fills ONLY blank fields (never
 *  overwrites data the owner may have curated). */
export function buildLeadUpdate(existing: ExistingLead, input: LeadInput, now: Date) {
  const newMsg = clean(input.message)
  const appended = newMsg
    ? [existing.notes, `[${now.toISOString().slice(0, 10)}] ${newMsg}`].filter(Boolean).join('\n')
    : existing.notes
  const fillIfBlank = <T>(cur: T | null, next: T | null | undefined): T | null => (cur == null ? (next ?? null) : cur)
  return {
    lastActivityAt: now,
    notes: appended,
    // Fill blanks only — don't clobber existing values.
    name: existing.name && existing.name !== 'Website lead' ? existing.name : (clean(input.name) ?? existing.name),
    phone: fillIfBlank(existing.phone, clean(input.phone)),
    message: fillIfBlank(existing.message, newMsg),
    moveDate: fillIfBlank(existing.moveDate, input.moveDate ?? null),
    zip: fillIfBlank(existing.zip, clean(input.zip)),
    originCity: fillIfBlank(existing.originCity, clean(input.originCity)),
    destCity: fillIfBlank(existing.destCity, clean(input.destCity)),
    jobType: fillIfBlank(existing.jobType, clean(input.jobType)),
    promoCode: fillIfBlank(existing.promoCode, clean(input.promoCode)),
  }
}

// ── Injectable store ──────────────────────────────────────────────────────────

export interface LeadStore {
  findOpenByEmail(email: string): Promise<ExistingLead | null>
  create(data: ReturnType<typeof buildLeadCreate>): Promise<LeadRecord>
  update(id: string, data: ReturnType<typeof buildLeadUpdate>): Promise<LeadRecord>
}

export type LeadDeps = { store: LeadStore; now: () => Date }

/** THE shared lead writer. Never throws for a business reason — callers persist
 *  first, then notify. */
export async function createOrUpdateLead(input: LeadInput, deps: LeadDeps = defaultLeadDeps()): Promise<CreateOrUpdateResult> {
  const now = deps.now()
  const email = normalizeEmail(input.email)

  if (email) {
    const existing = await deps.store.findOpenByEmail(email)
    if (existing) {
      const lead = await deps.store.update(existing.id, buildLeadUpdate(existing, input, now))
      return { lead, isNew: false }
    }
  }

  const lead = await deps.store.create(buildLeadCreate(input, now))
  return { lead, isNew: true }
}

// ── Production wiring ──────────────────────────────────────────────────────────

let _deps: LeadDeps | undefined
export function defaultLeadDeps(): LeadDeps {
  if (_deps) return _deps
  _deps = {
    now: () => new Date(),
    store: {
      async findOpenByEmail(email) {
        return prisma.lead.findFirst({
          where: { email, status: { in: OPEN_STATUSES } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, status: true, name: true, phone: true, notes: true, message: true,
            moveDate: true, zip: true, originCity: true, destCity: true, jobType: true, promoCode: true,
          },
        })
      },
      async create(data) {
        return prisma.lead.create({ data, select: { id: true, status: true } })
      },
      async update(id, data) {
        return prisma.lead.update({ where: { id }, data, select: { id: true, status: true } })
      },
    },
  }
  return _deps
}

/** Convenience wrapper for routes: persist a lead and never throw. Returns the
 *  record on success or null on failure (already logged), so the caller can
 *  still fire its Discord/email alert regardless. */
export async function ingestLeadSafe(input: LeadInput, context: string): Promise<CreateOrUpdateResult | null> {
  try {
    const res = await createOrUpdateLead(input)
    apiLogger.info({ leadId: res.lead.id, isNew: res.isNew, context }, 'lead persisted')
    // lead_created automation trigger — a NEW lead only, never a repeat
    // submission merge. Dynamically imported so this module keeps its
    // queue-free import graph (the offline tests never open Redis), and
    // fire-and-forget so a trigger failure can never lose the lead.
    if (res.isNew) {
      import('./email-automation-runtime')
        .then((m) => m.fireLeadTrigger('lead_created', res.lead.id))
        .catch((err) => apiLogger.warn({ err: String(err) }, 'lead_created trigger failed (non-fatal)'))
    }
    return res
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err), context }, 'lead persistence failed (non-fatal)')
    return null
  }
}

// ════════════════════════════════════════════════════════════════════════
//  LEAD LIFECYCLE TRANSITIONS (email-journey trigger sites, 2026-07-21)
//  ---------------------------------------------------------------------
//  These write the previously-unwritten conversion columns (quotedAt / bookedAt
//  / convertedBookingId). They own the DB write ONLY — never the queue side
//  effect, so leads.ts stays free of any journeys/queue import and its offline
//  tests never open a Redis connection. The caller (an API route) fires
//  onQuoteCreated / onLeadClosed after a truthy return. Both fail SOFT: a lead
//  transition is a convenience over the authoritative booking record.
// ════════════════════════════════════════════════════════════════════════

/**
 * PURE: the patch that records a genuine quote on a lead. `quotedAt` is stamped
 * only if it was not already set (so a re-quote does not restart the recovery
 * clock), the lead advances to QUOTE_SENT from an OPEN status, and a real
 * estimate is filled only when one is supplied and none exists yet.
 */
export function buildQuoteUpdate(
  existing: { status: LeadStatus; quotedAt: Date | null; estimatedValue: number | null },
  now: Date,
  estimatedValueCents?: number | null
): { data: Record<string, unknown>; newlyQuoted: boolean } {
  const data: Record<string, unknown> = { lastActivityAt: now }
  const newlyQuoted = existing.quotedAt == null
  if (newlyQuoted) data.quotedAt = now
  if (OPEN_STATUSES.includes(existing.status) && existing.status !== LeadStatus.QUOTE_SENT) {
    data.status = LeadStatus.QUOTE_SENT
  }
  if (existing.estimatedValue == null && typeof estimatedValueCents === 'number' && estimatedValueCents > 0) {
    data.estimatedValue = estimatedValueCents
  }
  return { data, newlyQuoted }
}

/**
 * Record that a real quote was given to a lead. Returns true only when this call
 * NEWLY stamped `quotedAt` — the signal the caller uses to decide whether to
 * start the quote follow-up sequence (a re-quote must not re-fire it). A lead
 * already closed (BOOKED/LOST) is refused: there is nothing left to quote.
 */
export async function markLeadQuoted(
  leadId: string,
  opts: { estimatedValueCents?: number | null; now?: Date } = {}
): Promise<{ newlyQuoted: boolean; leadId: string } | null> {
  const now = opts.now ?? new Date()
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, status: true, quotedAt: true, estimatedValue: true },
    })
    if (!lead) return null
    if (lead.status === LeadStatus.BOOKED || lead.status === LeadStatus.LOST) return null
    const { data, newlyQuoted } = buildQuoteUpdate(lead, now, opts.estimatedValueCents)
    await prisma.lead.update({ where: { id: lead.id }, data })
    apiLogger.info({ leadId: lead.id, newlyQuoted }, 'lead marked quoted')
    return { newlyQuoted, leadId: lead.id }
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err), leadId }, 'markLeadQuoted failed (non-fatal)')
    return null
  }
}

/**
 * A booking was created for this email → convert a matching OPEN lead so quote
 * follow-ups stop, and the conversion is visible to audiences and attribution
 * (both already READ convertedBookingId / bookedAt). Idempotent and best-effort:
 * returns the converted leadId, or null when there was no open lead (the common
 * case — most bookings are not from a tracked lead).
 */
export async function markLeadConverted(
  email: string | null | undefined,
  bookingId: string,
  now: Date = new Date()
): Promise<string | null> {
  const normalized = normalizeEmail(email)
  if (!normalized) return null
  try {
    const lead = await prisma.lead.findFirst({
      where: { email: normalized, status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (!lead) return null
    await prisma.lead.update({
      where: { id: lead.id },
      data: { status: LeadStatus.BOOKED, bookedAt: now, convertedBookingId: bookingId, lastActivityAt: now },
    })
    apiLogger.info({ leadId: lead.id, bookingId }, 'lead converted (booking created)')
    return lead.id
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId }, 'markLeadConverted failed (non-fatal)')
    return null
  }
}
