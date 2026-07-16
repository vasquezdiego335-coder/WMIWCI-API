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
  gclid?: string | null
  gbraid?: string | null
  wbraid?: string | null
  firstTouchAt?: Date | null
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
    gclid: clean(input.gclid),
    gbraid: clean(input.gbraid),
    wbraid: clean(input.wbraid),
    firstTouchAt: input.firstTouchAt ?? null,
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
    return res
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err), context }, 'lead persistence failed (non-fatal)')
    return null
  }
}
