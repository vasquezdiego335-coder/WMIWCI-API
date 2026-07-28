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
import { LeadSource, LeadStatus, LeadLifecycle } from '@prisma/client'
import { prisma } from './db'
import { apiLogger } from './logger'
import { CONSENT_VERSION, decideConsent, normaliseConsentSource } from './consent'

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
 * A booking was created → convert a matching OPEN lead so quote follow-ups stop,
 * and the conversion is visible to audiences and attribution (both already READ
 * convertedBookingId / bookedAt). Idempotent and best-effort: returns the
 * converted leadId, or null when there was no open lead (the common case — most
 * bookings are not from a tracked lead).
 *
 * PARTIAL-LEAD AWARE (owner spec 2026-07-24): matches a partial-booking lead by
 * `bookingSessionId` FIRST (the form's dedup key), then falls back to email;
 * stamps `lifecycle=CONVERTED`; and propagates the person's promotional consent
 * onto the durable Customer record. Consent propagation is TRI-STATE and never
 * touches suppression: a value is written only when one is known (from the
 * booking payload or already stored on the lead).
 */
export async function markLeadConverted(
  email: string | null | undefined,
  bookingId: string,
  opts: {
    now?: Date
    bookingSessionId?: string | null
    /** From the booking payload's Step-1 checkbox; undefined = not re-sent. */
    marketingConsent?: boolean | null
    consentSource?: string | null
    consentVersion?: string | null
  } = {}
): Promise<string | null> {
  const now = opts.now ?? new Date()
  const normalized = normalizeEmail(email)
  const sessionId = clean(opts.bookingSessionId)
  if (!normalized && !sessionId) return null
  try {
    // Session first (a partial lead may not yet carry the final email), then email.
    let lead =
      sessionId
        ? await prisma.lead.findFirst({
            where: { bookingSessionId: sessionId, status: { in: OPEN_STATUSES } },
            orderBy: { createdAt: 'desc' },
            select: { id: true, email: true, emailMarketingConsent: true, marketingConsentSource: true, marketingConsentVersion: true },
          })
        : null
    if (!lead && normalized) {
      lead = await prisma.lead.findFirst({
        where: { email: normalized, status: { in: OPEN_STATUSES } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, emailMarketingConsent: true, marketingConsentSource: true, marketingConsentVersion: true },
      })
    }

    // Effective consent to propagate: an explicit booking-payload value wins,
    // otherwise whatever the partial lead already recorded. `undefined` ⇒ leave
    // both records untouched (do not infer a decision — owner spec S2).
    const explicit = typeof opts.marketingConsent === 'boolean' ? opts.marketingConsent : undefined
    const effectiveConsent = explicit ?? (lead ? lead.emailMarketingConsent ?? undefined : undefined)

    // A SUPPRESSED address is never marketable, whatever this form claims.
    // Checked here so neither the Lead nor the Customer write below can
    // resurrect somebody who unsubscribed or complained.
    const suppressed = normalized
      ? (await prisma.emailSuppression.findUnique({ where: { email: normalized }, select: { id: true } }).catch(() => null)) !== null
      : false

    if (lead) {
      const data: Record<string, unknown> = {
        status: LeadStatus.BOOKED,
        bookedAt: now,
        convertedBookingId: bookingId,
        lastActivityAt: now,
        lifecycle: LeadLifecycle.CONVERTED,
      }
      // Consent rules live in ONE place (src/lib/consent.ts) so this route and
      // the lead endpoint cannot drift. It decides whether anything changes at
      // all: silence changes nothing, an unchecked box never revokes an earlier
      // opt-in, and suppression overrides everything.
      const decision = decideConsent(
        {
          consent: lead.emailMarketingConsent,
          consentSource: lead.marketingConsentSource,
          consentVersion: lead.marketingConsentVersion,
        },
        {
          consent: explicit,
          source: opts.consentSource,
          version: opts.consentVersion ?? CONSENT_VERSION,
          isSuppressed: suppressed,
        },
        now
      )
      Object.assign(data, decision.changes)
      await prisma.lead.update({ where: { id: lead.id }, data })
      apiLogger.info({ leadId: lead.id, bookingId }, 'lead converted (booking created)')
    }

    // Propagate positive/negative consent to the durable Customer record so
    // promotional audiences can honor it after the lead is closed. Only writes a
    // known boolean; never creates or clears an EmailSuppression row.
    if (effectiveConsent !== undefined && normalized && !suppressed) {
      const existingCustomer = await prisma.customer
        .findFirst({
          where: { email: normalized },
          select: { emailMarketingConsent: true, marketingConsentSource: true, marketingConsentVersion: true },
        })
        .catch(() => null)

      const customerDecision = decideConsent(
        {
          consent: existingCustomer?.emailMarketingConsent,
          consentSource: existingCustomer?.marketingConsentSource,
          consentVersion: existingCustomer?.marketingConsentVersion,
        },
        {
          consent: effectiveConsent,
          source: opts.consentSource,
          version: opts.consentVersion ?? CONSENT_VERSION,
          isSuppressed: suppressed,
        },
        now
      )

      // The FULL evidence travels with the boolean. Source and version were
      // previously written only to the Lead, so a customer who consented with
      // no prior lead carried a bare `true` and nothing that could show where
      // it came from or what wording they saw.
      if (Object.keys(customerDecision.changes).length > 0) {
        await prisma.customer
          .updateMany({ where: { email: normalized }, data: customerDecision.changes })
          .catch((err) =>
            apiLogger.warn({ err: String(err), bookingId }, 'customer consent propagation failed (non-fatal)')
          )
      }
    }

    return lead ? lead.id : null
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId }, 'markLeadConverted failed (non-fatal)')
    return null
  }
}

// ════════════════════════════════════════════════════════════════════════
//  PARTIAL BOOKING LEAD CAPTURE (owner spec 2026-07-24)
//  ---------------------------------------------------------------------
//  Fires the moment a valid email is entered in the booking form's Step 1 —
//  BEFORE Continue / pricing / Stripe — so a door-hanger scan that abandons
//  still becomes ONE properly-attributed lead. Separate from createOrUpdateLead
//  because:
//    • it dedups by bookingSessionId FIRST (a stable per-request id the form
//      keeps in localStorage), so refreshes / re-typing never spawn duplicates;
//    • it records the partial LIFECYCLE + furthest step + TRI-STATE marketing
//      consent, none of which the CRM ingestion path carries;
//    • it is SILENT — it never fires the `lead_created` promotional automation
//      trigger, so a self-abandoned Step-1 email is never enrolled in a
//      marketing sequence. Consent is required for promotional reach (the
//      audience resolver gates PARTIAL/IN_PROGRESS/ABANDONED leads on it).
//
//  Pure builders + an injectable PartialLeadStore keep the dedup decision and
//  field mapping unit-tested offline, exactly like createOrUpdateLead.
// ════════════════════════════════════════════════════════════════════════

export type PartialLeadInput = {
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  /** Stable per-request id from the form (localStorage). PRIMARY dedup key. */
  bookingSessionId?: string | null
  /** Furthest booking step reached, e.g. "card1".."card5" / "submitted". */
  formStep?: string | null
  /** TRI-STATE: true = opted in, false = explicit withdrawal, undefined = the
   *  visitor never touched the checkbox (leave any stored value untouched). */
  marketingConsent?: boolean
  consentSource?: string | null
  consentVersion?: string | null
  /** Free-form source string (utm_source or a client-derived channel). */
  source?: string | null
  foundUs?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  landingPage?: string | null
  referrer?: string | null
  promoCode?: string | null
  estimatedValue?: number | null // cents
  // ── Move details (owner spec 2026-07-28) ──────────────────────────────
  // A quick-quote or homepage estimate carries real intent. Without these a
  // captured lead is a bare address, and the follow-up email cannot say
  // anything specific enough to be worth sending.
  moveDate?: Date | null
  pickupZip?: string | null
  destinationZip?: string | null
  serviceInterest?: string | null
}

/** Order used to only ever ADVANCE lifecycle, never regress it. */
const LIFECYCLE_RANK: Record<string, number> = {
  PARTIAL: 0,
  IN_PROGRESS: 1,
  ABANDONED: 1, // a sibling terminal-ish state; never overrides a real advance
  SUBMITTED: 2,
  CONVERTED: 3,
}

/** Map the furthest step reached to a partial lifecycle. `card1` (just the email)
 *  is PARTIAL; any later step is IN_PROGRESS; an explicit "submitted" is SUBMITTED. */
export function lifecycleForStep(formStep?: string | null): LeadLifecycle {
  const s = (formStep ?? '').trim().toLowerCase()
  if (s === 'submitted') return LeadLifecycle.SUBMITTED
  if (!s || s === 'card1' || s === 'contact' || s === '1') return LeadLifecycle.PARTIAL
  return LeadLifecycle.IN_PROGRESS
}

/** Compose the Lead.name (required, non-null) from first/last. */
function composePartialName(input: PartialLeadInput): string | null {
  const parts = [clean(input.firstName), clean(input.lastName)].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

/** The consent columns to MERGE into an update — ONLY when a boolean is supplied.
 *  Pure; returns an empty object when the visitor never interacted (leave stored
 *  consent untouched). Update-path only (create always sets an explicit value). */
function partialConsentPatch(input: PartialLeadInput, now: Date): Record<string, unknown> {
  if (typeof input.marketingConsent !== 'boolean') return {}
  return {
    emailMarketingConsent: input.marketingConsent,
    marketingConsentAt: now,
    marketingConsentSource: normaliseConsentSource(input.consentSource) ?? 'BOOKING_FORM',
    marketingConsentVersion: clean(input.consentVersion),
  }
}

/** Row to CREATE for a fresh partial lead. Pure. Status NEW keeps it an OPEN,
 *  dedup-able CRM row; `lifecycle` marks it as a partial-booking lead. On CREATE
 *  the consent columns are set explicitly (null when the box was never touched). */
export function buildPartialLeadCreate(input: PartialLeadInput, now: Date) {
  const consented = typeof input.marketingConsent === 'boolean'
  return {
    name: composePartialName(input) ?? 'Booking lead',
    phone: clean(input.phone),
    email: normalizeEmail(input.email),
    source: mapLeadSource(input.source),
    status: LeadStatus.NEW,
    lifecycle: lifecycleForStep(input.formStep),
    bookingSessionId: clean(input.bookingSessionId),
    formStep: clean(input.formStep),
    jobType: clean(input.serviceInterest) ?? 'booking-form',
    moveDate: input.moveDate ?? undefined,
    originZip: clean(input.pickupZip) ?? undefined,
    destinationZip: clean(input.destinationZip) ?? undefined,
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
    emailMarketingConsent: consented ? (input.marketingConsent as boolean) : null,
    marketingConsentAt: consented ? now : null,
    marketingConsentSource: consented ? (normaliseConsentSource(input.consentSource) ?? 'BOOKING_FORM') : null,
    marketingConsentVersion: consented ? clean(input.consentVersion) : null,
  }
}

export type ExistingPartialLead = {
  id: string
  status: LeadStatus
  name: string
  phone: string | null
  email: string | null
  bookingSessionId: string | null
  lifecycle: LeadLifecycle | null
  emailMarketingConsent: boolean | null
  formStep: string | null
  estimatedValue: number | null
  utmSource: string | null
  utmCampaign: string | null
  landingPage: string | null
  referrer: string | null
  promoCode: string | null
}

/** Patch to UPDATE an existing lead from a repeat partial submission. Pure:
 *  bumps activity, ADVANCES lifecycle only (never regresses / never leaves
 *  CONVERTED), always tracks the latest step, fills blank attribution, and
 *  applies TRI-STATE consent (a fresh unchecked load — marketingConsent
 *  undefined — leaves any stored consent untouched). */
export function buildPartialLeadUpdate(existing: ExistingPartialLead, input: PartialLeadInput, now: Date) {
  const fillIfBlank = <T>(cur: T | null, next: T | null | undefined): T | null => (cur == null ? (next ?? null) : cur)

  // Lifecycle: never downgrade. CONVERTED/SUBMITTED are sticky terminal-ish.
  const candidate = lifecycleForStep(input.formStep)
  const curRank = existing.lifecycle ? LIFECYCLE_RANK[existing.lifecycle] ?? 0 : -1
  const nextLifecycle = (LIFECYCLE_RANK[candidate] ?? 0) > curRank ? candidate : (existing.lifecycle ?? candidate)

  const data: Record<string, unknown> = {
    lastActivityAt: now,
    lifecycle: nextLifecycle,
    // Always keep the LATEST step + estimate (they move forward as the form fills).
    formStep: clean(input.formStep) ?? existing.formStep,
    bookingSessionId: existing.bookingSessionId ?? clean(input.bookingSessionId),
    // Name/phone/attribution: fill blanks only — never clobber curated data.
    name: existing.name && existing.name !== 'Booking lead' && existing.name !== 'Website lead'
      ? existing.name
      : (composePartialName(input) ?? existing.name),
    phone: fillIfBlank(existing.phone, clean(input.phone)),
    email: fillIfBlank(existing.email, normalizeEmail(input.email)),
    utmSource: fillIfBlank(existing.utmSource, clean(input.utmSource)),
    utmCampaign: fillIfBlank(existing.utmCampaign, clean(input.utmCampaign)),
    landingPage: fillIfBlank(existing.landingPage, clean(input.landingPage)),
    referrer: fillIfBlank(existing.referrer, clean(input.referrer)),
    promoCode: fillIfBlank(existing.promoCode, clean(input.promoCode)),
    ...partialConsentPatch(input, now),
  }
  // A real estimate only ever fills in / increases; never overwrite with null.
  if (typeof input.estimatedValue === 'number' && input.estimatedValue > 0) {
    data.estimatedValue = input.estimatedValue
  }
  return data
}

export type CapturePartialResult = { lead: LeadRecord; isNew: boolean } | null

export interface PartialLeadStore {
  findBySessionId(sessionId: string): Promise<ExistingPartialLead | null>
  findOpenPartialByEmail(email: string): Promise<ExistingPartialLead | null>
  create(data: ReturnType<typeof buildPartialLeadCreate>): Promise<LeadRecord>
  update(id: string, data: ReturnType<typeof buildPartialLeadUpdate>): Promise<LeadRecord>
}

export type PartialLeadDeps = { store: PartialLeadStore; now: () => Date }

/** THE partial-lead writer. Dedup priority: (1) bookingSessionId, (2) normalized
 *  email on an OPEN lead. Returns null when there is nothing to key on (no
 *  session id AND no valid email) — an incomplete email never creates a lead. */
export async function capturePartialLead(
  input: PartialLeadInput,
  deps: PartialLeadDeps = defaultPartialLeadDeps()
): Promise<CapturePartialResult> {
  const now = deps.now()
  const sessionId = clean(input.bookingSessionId)
  const email = normalizeEmail(input.email)
  if (!sessionId && !email) return null

  let existing: ExistingPartialLead | null = null
  if (sessionId) existing = await deps.store.findBySessionId(sessionId)
  if (!existing && email) existing = await deps.store.findOpenPartialByEmail(email)

  if (existing) {
    const lead = await deps.store.update(existing.id, buildPartialLeadUpdate(existing, input, now))
    return { lead, isNew: false }
  }
  // Need at least a valid email to CREATE (a bare session id is not a person).
  if (!email) return null

  // RACE WINDOW (owner review 2026-07-24): the booking form fires capture from
  // FIVE triggers (debounce, blur, nav, consent toggle, exit beacon). Two of
  // them can land within milliseconds, so both can miss the lookup above and
  // both reach CREATE — producing exactly the duplicate lead this feature
  // promises never to make. If the create fails for ANY reason, re-run the
  // lookup: the sibling request has almost certainly committed its row by now,
  // and we update that instead of losing the capture.
  try {
    const lead = await deps.store.create(buildPartialLeadCreate(input, now))
    return { lead, isNew: true }
  } catch (err) {
    const raced = (sessionId ? await deps.store.findBySessionId(sessionId) : null) ??
      (await deps.store.findOpenPartialByEmail(email))
    if (raced) {
      const lead = await deps.store.update(raced.id, buildPartialLeadUpdate(raced, input, now))
      return { lead, isNew: false }
    }
    throw err // genuinely failed (DB down) — capturePartialLeadSafe logs + swallows
  }
}

let _partialDeps: PartialLeadDeps | undefined
export function defaultPartialLeadDeps(): PartialLeadDeps {
  if (_partialDeps) return _partialDeps
  const SELECT = {
    id: true, status: true, name: true, phone: true, email: true, bookingSessionId: true,
    lifecycle: true, emailMarketingConsent: true, formStep: true, estimatedValue: true,
    utmSource: true, utmCampaign: true, landingPage: true, referrer: true, promoCode: true,
  } as const
  _partialDeps = {
    now: () => new Date(),
    store: {
      async findBySessionId(sessionId) {
        return prisma.lead.findFirst({
          where: { bookingSessionId: sessionId, status: { in: OPEN_STATUSES } },
          orderBy: { createdAt: 'desc' },
          select: SELECT,
        })
      },
      async findOpenPartialByEmail(email) {
        return prisma.lead.findFirst({
          where: { email, status: { in: OPEN_STATUSES } },
          orderBy: { createdAt: 'desc' },
          select: SELECT,
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
  return _partialDeps
}

/** Route convenience: capture a partial lead and NEVER throw. Silent by design —
 *  no notification, no promotional automation. Returns the record or null. */
export async function capturePartialLeadSafe(
  input: PartialLeadInput,
  context: string,
  deps?: PartialLeadDeps
): Promise<CapturePartialResult> {
  try {
    const res = await capturePartialLead(input, deps)
    if (res) apiLogger.info({ leadId: res.lead.id, isNew: res.isNew, context }, 'partial lead captured')
    return res
  } catch (err) {
    apiLogger.error(
      { err: err instanceof Error ? err.message : String(err), context },
      'partial lead capture failed (non-fatal)'
    )
    return null
  }
}

// ── ABANDONMENT + RETENTION (owner review 2026-07-24) ────────────────────────
//  Two gaps found in review:
//    • lifecycle ABANDONED was defined and filterable in the admin but NOTHING
//      ever set it, so the "Abandoned" view was permanently empty and stale
//      partial leads sat in PARTIAL forever.
//    • nothing ever cleaned up self-abandoned captures, so a form that anyone
//      can type an email into grows without bound (spec Stage 17).
//  Both are deliberately CONSERVATIVE: they only ever touch self-captured
//  partial leads that were never quoted and never converted, and they NEVER
//  delete consent or suppression proof (that must outlive the lead itself).

/** Days of inactivity before a partial capture is considered abandoned. */
export const ABANDON_AFTER_DAYS = Math.max(1, Number(process.env.LEAD_ABANDON_AFTER_DAYS) || 14)
/** Days an ABANDONED partial lead is retained before purge. 0 disables purging. */
export const PURGE_ABANDONED_AFTER_DAYS = Math.max(0, Number(process.env.LEAD_PURGE_AFTER_DAYS) || 180)

/** PURE: may this lead be marked ABANDONED? Only an untouched partial capture —
 *  never one that was quoted, booked, converted, or already closed. */
export function isAbandonable(
  lead: { lifecycle?: string | null; status?: string | null; quotedAt?: Date | null; convertedBookingId?: string | null; lastActivityAt?: Date | null; createdAt?: Date | null },
  now: Date,
  afterDays: number = ABANDON_AFTER_DAYS
): boolean {
  if (lead.lifecycle !== 'PARTIAL' && lead.lifecycle !== 'IN_PROGRESS') return false
  if (lead.quotedAt || lead.convertedBookingId) return false // a real quote/booking is not abandonment
  if (lead.status === 'BOOKED' || lead.status === 'LOST') return false
  const last = lead.lastActivityAt ?? lead.createdAt
  if (!last) return false
  return now.getTime() - last.getTime() > afterDays * 24 * 60 * 60 * 1000
}

/** Transition inactive partial captures to ABANDONED. Idempotent, bounded, and
 *  non-destructive (a status/consent/quote is never altered). Returns the count. */
export async function markStaleLeadsAbandoned(now: Date = new Date(), afterDays: number = ABANDON_AFTER_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - afterDays * 24 * 60 * 60 * 1000)
  try {
    const res = await prisma.lead.updateMany({
      where: {
        lifecycle: { in: [LeadLifecycle.PARTIAL, LeadLifecycle.IN_PROGRESS] },
        quotedAt: null,
        convertedBookingId: null,
        status: { notIn: [LeadStatus.BOOKED, LeadStatus.LOST] },
        OR: [{ lastActivityAt: { lt: cutoff } }, { lastActivityAt: null, createdAt: { lt: cutoff } }],
      },
      data: { lifecycle: LeadLifecycle.ABANDONED },
    })
    if (res.count) apiLogger.info({ count: res.count, afterDays }, 'partial leads marked abandoned')
    return res.count
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'markStaleLeadsAbandoned failed (non-fatal)')
    return 0
  }
}

/** Purge long-abandoned partial captures (privacy/retention). Deletes ONLY
 *  self-captured leads that were never quoted, never converted, and never
 *  expressed a marketing choice — so consent proof is never destroyed.
 *  EmailSuppression rows live in their own table and are untouched by design. */
export async function purgeAbandonedLeads(now: Date = new Date(), afterDays: number = PURGE_ABANDONED_AFTER_DAYS): Promise<number> {
  if (afterDays <= 0) return 0 // purging disabled
  const cutoff = new Date(now.getTime() - afterDays * 24 * 60 * 60 * 1000)
  try {
    const res = await prisma.lead.deleteMany({
      where: {
        lifecycle: LeadLifecycle.ABANDONED,
        quotedAt: null,
        convertedBookingId: null,
        // Never delete a record that carries a consent DECISION — that is the
        // evidence we relied on to email (or not email) this person.
        emailMarketingConsent: null,
        updatedAt: { lt: cutoff },
      },
    })
    if (res.count) apiLogger.info({ count: res.count, afterDays }, 'abandoned leads purged (retention)')
    return res.count
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'purgeAbandonedLeads failed (non-fatal)')
    return 0
  }
}

/** PURE promotional-consent gate (owner spec 2026-07-24). A person is promotable
 *  ONLY with an explicit positive consent AND no active suppression. Used by the
 *  audience layer + unit tests. `emailMarketingConsent` is tri-state: null/false
 *  both fail. Suppression always wins. */
export function hasPromotionalConsent(subject: {
  emailMarketingConsent?: boolean | null
  suppressed?: boolean | { reason?: string } | null
}): boolean {
  if (subject.suppressed) return false
  return subject.emailMarketingConsent === true
}

/** The tested definition of the partial-lead promotional exclusion. A self-
 *  captured PARTIAL/IN_PROGRESS/ABANDONED booking lead is blocked from
 *  promotional audiences UNLESS it explicitly opted in. Ordinary CRM leads
 *  (lifecycle null) and CONVERTED leads are never blocked by this rule.
 *  MIRRORS the Prisma `NOT` clause in email-audience.leadWhere() — keep both in
 *  sync (the SQL cannot call this per-row, so the rule is stated in both). */
export function partialLeadBlockedFromPromo(lead: {
  lifecycle?: string | null
  emailMarketingConsent?: boolean | null
}): boolean {
  const partial = lead.lifecycle === 'PARTIAL' || lead.lifecycle === 'IN_PROGRESS' || lead.lifecycle === 'ABANDONED'
  return partial && lead.emailMarketingConsent !== true
}
