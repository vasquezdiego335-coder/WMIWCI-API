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
import { CONSENT_VERSION, decideConsent, normaliseConsentSource, type ConsentSource } from './consent'
import { snapshotColumns, reviewOnlyColumns, QUOTE_SNAPSHOT_SELECT, type QuoteSnapshot } from './quote-snapshot'

const OPEN_STATUSES: LeadStatus[] = [LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.QUOTE_SENT, LeadStatus.FOLLOW_UP]

export type LeadInput = {
  name?: string | null
  phone?: string | null
  email?: string | null
  message?: string | null
  /** Free-form source string; mapped to the LeadSource enum. */
  source?: string | null
  /** The customer's own "How did you hear about us?" answer. NOT `source`:
   *  that is the marketing CHANNEL our tracking observed, this is what the
   *  customer said. Kept apart because merging them is what let the column
   *  default `OTHER` be rendered as a customer's choice. */
  foundUs?: string | null
  /** TRUE when that question was actually shown to them. */
  foundUsPrompted?: boolean
  /** TRUE when the marketing checkbox was actually displayed. See the field of
   *  the same name on PartialLeadInput for why this is not `marketingConsent`. */
  marketingConsentPrompted?: boolean
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
  // ── MARKETING CONSENT (owner spec 2026-08-06) ─────────────────────────
  //  Until now this ingestion path — the contact form, the coupon popup, the
  //  marketing tracker, the "not sure" booking — carried NO consent fields at
  //  all. Every lead it created was structurally `null` forever, because there
  //  was nowhere to put an answer even when a form asked the question. That is
  //  why PR #31's honest note said contact-form leads "will receive none": not
  //  because they declined, but because nobody could record that they agreed.
  //
  //  TRI-STATE, and the tri-state is the product: `undefined` means the form
  //  presented no choice and must change nothing. Only `decideConsent` (the one
  //  rule module) is allowed to turn these into column writes.
  /** true / false ONLY when the form actually showed an unchecked checkbox. */
  marketingConsent?: boolean | null
  /** Capture surface from the controlled vocabulary, e.g. 'CONTACT_FORM'. */
  consentSource?: string | null
  /** The disclosure version the person actually read. */
  consentVersion?: string | null
  /**
   * Set by the caller after a suppression lookup. Suppression beats every
   * consent claim a form can make, so a resubscribe can never happen by
   * submitting a form (see decideConsent rule 1).
   */
  isSuppressed?: boolean
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
  // The `src` the marketing tracker actually mints for the printed QR. See the
  // DOOR-HANGER note in mapLeadSource below for why an exact key is not enough.
  door_hanger_5000_batch: LeadSource.DOOR_HANGER,
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
  const raw = (source ?? '').trim()
  if (!raw) return LeadSource.OTHER

  // ── LEGACY CHANNEL WORDS FIRST, and the order is deliberate. ────────────
  // `contact-form` has always meant WEBSITE. Now that CONTACT_FORM exists as
  // an enum value, an enum-first lookup would silently re-point every existing
  // /api/contact submission at a different source — a live behaviour change
  // disguised as a vocabulary addition. Existing callers keep their meaning.
  const legacy = SOURCE_MAP[raw.toLowerCase()]
  if (legacy) return legacy

  // ── Then CONTROLLED CAPTURE SURFACES (owner spec 2026-07-28). ───────────
  // A caller sending `QUICK_QUOTE_FORM` means exactly that. Before this every
  // such submission fell through to `OTHER`, which is why the lead table could
  // not answer "which form is actually working". Matched against the live
  // enum, so adding a value to the schema is all it takes to support it.
  const upper = raw.toUpperCase().replace(/[\s-]+/g, '_')
  if (Object.prototype.hasOwnProperty.call(LeadSource, upper)) {
    return LeadSource[upper as keyof typeof LeadSource]
  }

  // ── DOOR HANGERS: MATCH THE CHANNEL, NOT THE BATCH (fix 2026-08-24) ─────
  //  The printed QR mints `src=door_hanger_5000_batch`. That is a CAMPAIGN
  //  label, and campaign labels grow batch suffixes: the exact-key lookup
  //  above missed it, the enum fallback produced DOOR_HANGER_5000_BATCH which
  //  is not a LeadSource value, and every quick-quote lead from the campaign
  //  was filed as OTHER. The owner's own "Door hanger" admin filter matches on
  //  `source = 'DOOR_HANGER'` exactly, so those leads were invisible on the
  //  page built to find them — while the hangers were in fact producing them.
  //
  //  This was clearly a bug and not a choice, because the OTHER capture
  //  surface already got it right: booking-form.html normalises anything
  //  matching /door[_-]?hanger/ to `door_hanger` before it sends. The two
  //  forms disagreed about what a door-hanger lead is called.
  //
  //  Matching the CHANNEL means run two, or a second town's batch, or a
  //  reprint with a new suffix, all land in the same place without another
  //  deploy — which is the whole reason the label carries a batch in the first
  //  place. The batch itself is not lost: it stays on the lead in `source`'s
  //  sibling columns and in the tracker's own scan rows.
  //
  //  Deliberately LAST, after both exact lookups, so it can only ever catch
  //  what would otherwise have become OTHER.
  const lower = raw.toLowerCase()
  if (/door[_\- ]?hanger/.test(lower)) return LeadSource.DOOR_HANGER
  if (/yard[_\- ]?sign/.test(lower)) return LeadSource.YARD_SIGN

  return LeadSource.OTHER
}

const clean = (v?: string | null): string | null => {
  const s = (v ?? '').trim()
  return s.length ? s : null
}

/**
 * The QR attribution id, or null.
 *
 * SHAPE-CHECKED RATHER THAN TRIMMED, and the difference matters. The value is
 * machine-minted (`os.urandom(16).hex()` in the tracker), so anything that is
 * not lower/upper hex of a sane length did not come from a scan — it came from
 * a mangled shared link, a truncating client, or somebody probing. Storing it
 * anyway would put junk in the column the campaign report JOINS on, and a join
 * that silently matches nothing is worse than a null, because null is
 * obviously "we don't know".
 *
 * Never throws and never rejects: an unusable value simply drops the
 * attribution. A tracking parameter the customer never saw must not be able to
 * fail their lead or their booking.
 */
export const cleanAttributionId = (v?: string | null): string | null => {
  const s = (v ?? '').trim()
  return /^[a-f0-9]{8,64}$/i.test(s) ? s.toLowerCase() : null
}

/** Compose the human-readable notes log (message + "found us" note). */
function composeNotes(input: LeadInput): string | null {
  const parts = [clean(input.message), input.foundUs ? `Found us: ${clean(input.foundUs)}` : null].filter(Boolean)
  return parts.length ? parts.join('\n') : null
}

/**
 * Consent columns for a CREATE. Pure.
 *
 * A create writes all four EXPLICITLY, including the all-null case, so a lead
 * from a form with no checkbox is unambiguously "never asked" rather than
 * "field absent". `decideConsent` is not used here: there is no existing record
 * to reason about, and its rules are all about what may CHANGE.
 */
function consentColumnsForCreate(input: LeadInput, now: Date, defaultSource: ConsentSource) {
  // Suppression beats a fresh claim too — a suppressed address that ticks a box
  // on a new form is still suppressed, and must not be recorded as consenting.
  const asked = typeof input.marketingConsent === 'boolean' && !input.isSuppressed
  return {
    emailMarketingConsent: asked ? (input.marketingConsent as boolean) : null,
    marketingConsentAt: asked ? now : null,
    marketingConsentSource: asked ? (normaliseConsentSource(input.consentSource) ?? defaultSource) : null,
    marketingConsentVersion: asked ? (clean(input.consentVersion) ?? CONSENT_VERSION) : null,
    //  WAS THE QUESTION ASKED? Recorded even for a SUPPRESSED address, whose
    //  decision we refuse to store — we still showed them the box, and
    //  forgetting that would put the record back in the state where "no
    //  consent" and "never asked" are the same null.
    marketingConsentPrompted:
      typeof input.marketingConsent === 'boolean' ? true : (input.marketingConsentPrompted ?? null),
  }
}

/** The row to CREATE from a fresh submission. Pure. */
export function buildLeadCreate(input: LeadInput, now: Date) {
  return {
    ...consentColumnsForCreate(input, now, 'CONTACT_FORM'),
    name: clean(input.name) ?? 'Website lead',
    phone: clean(input.phone),
    email: normalizeEmail(input.email),
    source: mapLeadSource(input.source),
    status: LeadStatus.NEW,
    message: clean(input.message),
    notes: composeNotes(input),
    //  ALSO ITS OWN COLUMN NOW. composeNotes() still writes the human-readable
    //  "Found us: …" line into the notes log the owner reads, but a free-text
    //  log is not a field anything can reason about — which is why no
    //  notification could ever show what the customer actually reported.
    foundUs: clean(input.foundUs),
    foundUsPrompted: input.foundUsPrompted ?? (clean(input.foundUs) ? true : null),
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
  // ── CONSENT, REQUIRED not optional (owner spec 2026-08-06) ────────────
  //  The merge rules can only be applied against what is already on the record
  //  — "an unchecked box on a later form never revokes an earlier opt-in" is a
  //  statement about the EXISTING value. A store that forgets to select these
  //  therefore cannot compile, which is how the rule stays enforced.
  emailMarketingConsent: boolean | null
  marketingConsentSource: string | null
  marketingConsentVersion: string | null
  //  Same reasoning as the consent trio above: "we asked" can only move
  //  forward, and a rule about what may CHANGE needs the current value. A
  //  store that forgets to select these cannot compile.
  marketingConsentPrompted: boolean | null
  foundUs: string | null
  foundUsPrompted: boolean | null
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
  // Consent merge — the SAME rule module the booking form and the quick quote
  // use, so the three capture surfaces cannot drift. `changes` is empty in the
  // common case (no checkbox on this form), which is exactly what "silence
  // changes nothing" has to look like in a patch object.
  const consent = decideConsent(
    {
      consent: existing.emailMarketingConsent,
      consentSource: existing.marketingConsentSource,
      consentVersion: existing.marketingConsentVersion,
    },
    {
      consent: input.marketingConsent,
      source: input.consentSource,
      version: clean(input.consentVersion) ?? CONSENT_VERSION,
      isSuppressed: input.isSuppressed === true,
    },
    now
  )
  return {
    lastActivityAt: now,
    notes: appended,
    ...consent.changes,
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
    //  WHAT WE ASKED, and what they answered — merged forward only, by the
    //  same rules the partial path uses, so the two ingestion routes cannot
    //  disagree about a customer's provenance.
    ...questionProvenancePatch(
      {
        marketingConsentPrompted: existing.marketingConsentPrompted,
        foundUs: existing.foundUs,
        foundUsPrompted: existing.foundUsPrompted,
      },
      {
        //  LeadInput's consent is `boolean | null` (this path accepts an
        //  explicit null from older callers); the patch reads the partial
        //  path's `boolean | undefined`. Both mean "no answer supplied".
        marketingConsent: input.marketingConsent ?? undefined,
        marketingConsentPrompted: input.marketingConsentPrompted,
        foundUs: input.foundUs,
        //  An answer is itself proof the question was shown.
        foundUsPrompted: input.foundUsPrompted ?? (clean(input.foundUs) ? true : undefined),
      },
    ),
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
            // Required by ExistingLead — the consent merge cannot be applied
            // against a record it cannot see.
            emailMarketingConsent: true, marketingConsentSource: true, marketingConsentVersion: true,
            // Same rule, for the question-provenance merge.
            marketingConsentPrompted: true, foundUs: true, foundUsPrompted: true,
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

/**
 * Post a new lead to Discord, fire-and-forget.
 *
 * NOT awaited by callers: a Discord outage or a slow request must never delay
 * the form response or cost the capture. Dynamically imported so this module
 * keeps its light import graph for the offline tests.
 *
 * Re-reads the row rather than trusting the caller's input, so the card shows
 * what was actually STORED -- if a field was dropped on the way in, the owner
 * sees the gap instead of a value that only ever existed in memory.
 */
function notifyOwnerOfNewLead(leadId: string, context: string): void {
  void (async () => {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
          id: true, name: true, email: true, phone: true, source: true, moveSize: true,
          moveDate: true, originZip: true, destinationZip: true,
          emailMarketingConsent: true, landingPage: true, utmSource: true, utmCampaign: true,
          formStep: true,
          // ── PROVENANCE, or the card goes back to guessing ────────────────
          //  Without these the notice cannot tell "we never asked" from "they
          //  were asked and said nothing", which is the whole incident. A
          //  projection that omits one silently re-enables the wrong answer.
          utmMedium: true, referrer: true, attributionId: true,
          marketingConsentPrompted: true, marketingConsentSource: true,
          foundUs: true, foundUsPrompted: true,
          lifecycle: true, convertedBookingId: true, jobType: true,
          // ── THE SNAPSHOT COLUMNS ────────────────────────────────────────
          //  This projection asked for `estimatedValue` and nothing else about
          //  money, so the notice could not know a total was a SUBTOTAL with
          //  the drive unpriced, nor that the quote needed review — it printed
          //  a bare figure that read as final. Spread from the shared constant
          //  so a new column cannot be forgotten here.
          ...QUOTE_SNAPSHOT_SELECT,
        },
      })
      if (!lead) return
      const { notifyNewLead, toLeadAlertInput } = await import('./lead-alert')
      await notifyNewLead(toLeadAlertInput(lead))
    } catch (err) {
      apiLogger.warn({ err: String(err).slice(0, 200), leadId, context }, 'new-lead notice failed (non-fatal)')
    }
  })()
}

/** Convenience wrapper for routes: persist a lead and never throw. Returns the
 *  record on success or null on failure (already logged), so the caller can
 *  still fire its Discord/email alert regardless. */
export async function ingestLeadSafe(input: LeadInput, context: string): Promise<CreateOrUpdateResult | null> {
  try {
    // SUPPRESSION FIRST, and only when this submission actually claims a
    // consent decision — otherwise it is a pointless query on every contact
    // form post. A suppressed address can never be re-subscribed by filling in
    // a form, so the lookup happens BEFORE the pure builders decide anything.
    const suppressed =
      typeof input.marketingConsent === 'boolean' ? await isAddressSuppressed(input.email) : false
    const res = await createOrUpdateLead({ ...input, isSuppressed: suppressed })
    apiLogger.info({ leadId: res.lead.id, isNew: res.isNew, context }, 'lead persisted')
    // lead_created automation trigger — a NEW lead only, never a repeat
    // submission merge. Dynamically imported so this module keeps its
    // queue-free import graph (the offline tests never open Redis), and
    // fire-and-forget so a trigger failure can never lose the lead.
    if (res.isNew) {
      import('./email-automation-runtime')
        .then((m) => m.fireLeadTrigger('lead_created', res.lead.id))
        .catch((err) => apiLogger.warn({ err: String(err) }, 'lead_created trigger failed (non-fatal)'))
      notifyOwnerOfNewLead(res.lead.id, context)
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
  /**
   * TRUE when the originating form actually DISPLAYED the marketing checkbox.
   *
   * WHY IT IS SEPARATE FROM `marketingConsent`. The two answer different
   * questions — "what did they choose" and "were they even asked" — and the
   * booking form conflated them: it sent nothing at all unless the box had
   * been CLICKED, so "shown and left alone" was indistinguishable from "this
   * form has no checkbox". The owner card then reported the second one, and
   * told the owner we had never asked a customer we had asked.
   *
   * `false` is a real claim (this surface carries no marketing question);
   * `undefined` means the client did not say, and nothing may be inferred.
   */
  marketingConsentPrompted?: boolean
  consentSource?: string | null
  consentVersion?: string | null
  /** Free-form source string (utm_source or a client-derived channel). */
  source?: string | null
  /** The customer's own "How did you hear about us?" answer. NOT `source`:
   *  that is the marketing CHANNEL our tracking observed, this is what the
   *  customer said. Stored in its own column since 2026-08-25. */
  foundUs?: string | null
  /** TRUE when that question was put in front of them, FALSE when they had not
   *  reached that step yet, undefined when the client did not say. */
  foundUsPrompted?: boolean
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  landingPage?: string | null
  referrer?: string | null
  promoCode?: string | null
  /**
   * The anonymous visitor id the marketing tracker mints on its `/q/<code>` QR
   * redirect, carried through the landing page and the quote form as `?aid=`.
   *
   * All 2,500 printed door hangers share ONE code, so `source` can say "a door
   * hanger" and can never say "which scan". This is the only value that can
   * tie a lead — and later a booking — back to an individual card, which is
   * what makes "did the hangers pay for themselves" answerable at all.
   *
   * Opaque, random, 32 hex characters. It carries no personal data and
   * identifies nobody on its own.
   */
  attributionId?: string | null
  estimatedValue?: number | null // cents
  /**
   * TRUE when `estimatedValue` came from the SERVER's price book rather than
   * from the browser. Only /api/leads/quote-capture sets it. See
   * mayWriteEstimate — this is what stops the booking form's own figure from
   * undercutting a price we already emailed.
   */
  estimateAuthoritative?: boolean
  /**
   * The SERVER's structured quote, written once at capture.
   *
   * `estimatedValue` is a single number that later writes may raise, so it
   * cannot say what was actually quoted or whether the drive was priced. This
   * carries every component the server computed, so Discord, the email and the
   * admin can each describe the quote honestly instead of re-deriving it —
   * including saying "transportation pending" rather than presenting a package
   * subtotal as a finished estimate.
   */
  quoteSnapshot?: QuoteSnapshot | null
  /** Review reasons when there is NO numeric quote (in-person, 5BR manual
   *  plan). Persisted on their own so the leads most needing a human are not
   *  the ones that record nothing. */
  reviewReasonsOnly?: string[]
  // ── Move details (owner spec 2026-07-28) ──────────────────────────────
  // A quick-quote or homepage estimate carries real intent. Without these a
  // captured lead is a bare address, and the follow-up email cannot say
  // anything specific enough to be worth sending.
  moveDate?: Date | null
  pickupZip?: string | null
  destinationZip?: string | null
  serviceInterest?: string | null
  /** Home size the visitor picked on the quick quote form ("2br"). NOT a job
   *  type: it goes in its own column so `jobType` keeps a single vocabulary. */
  moveSize?: string | null
  // ── Quote-request capture (owner spec 2026-08-03) ──────────────────────
  /** 'call_asap' | 'text' | 'email' | 'customer_will_contact'. */
  contactPreference?: string | null
  /** Free text, e.g. "weekday mornings". */
  bestTimeToCall?: string | null
  /**
   * One human-readable line describing site access, composed by the caller
   * from the quick quote's stairs / heavy-item answers.
   *
   * WRITTEN TO `notes`, FILL-BLANK-ONLY. `notes` is owner-editable free text,
   * so a later capture must never overwrite what a human typed there. That
   * does mean a customer who changes an answer will not rewrite the note —
   * the deliberate trade: a lost correction is recoverable, the owner's own
   * words are not.
   */
  accessDetails?: string | null
}

/** Contact-preference vocabulary. A validated STRING rather than a Prisma enum
 *  so a new option on the form is a copy change, not a migration — but an
 *  unrecognised value is DROPPED rather than stored, so the admin column can
 *  never fill with junk from a crafted request. */
export const CONTACT_PREFERENCES = ['call_asap', 'text', 'email', 'customer_will_contact'] as const
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number]

export function normalizeContactPreference(value?: string | null): ContactPreference | null {
  const v = (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return (CONTACT_PREFERENCES as readonly string[]).includes(v) ? (v as ContactPreference) : null
}

// ── Owner re-alert policy (owner spec 2026-08-03) ─────────────────────────
//  The quote page fires capture on every meaningful edit, so "alert on every
//  save" would put the same person in Discord five times while they pick a
//  date. A re-alert requires a MEANINGFUL change: the move date, the estimated
//  value, the contact preference, or a phone number appearing for the first
//  time (which changes what the owner can actually do with the lead).

/** The facts that justify re-alerting. Pure + stable: same facts produce the
 *  same string, so the comparison survives a redeploy. */
export function alertFingerprint(f: {
  moveDate?: Date | string | null
  estimatedValue?: number | null
  contactPreference?: string | null
  phone?: string | null
}): string {
  const date =
    f.moveDate instanceof Date
      ? f.moveDate.toISOString().slice(0, 10)
      : clean(typeof f.moveDate === 'string' ? f.moveDate : null)?.slice(0, 10) ?? '-'
  return [
    date,
    typeof f.estimatedValue === 'number' ? String(f.estimatedValue) : '-',
    normalizeContactPreference(f.contactPreference) ?? '-',
    normalizePhone(f.phone) ?? '-',
  ].join('|')
}

/** True when the owner should be alerted again. A lead never alerted qualifies. */
export function shouldRealert(previous: string | null | undefined, next: string): boolean {
  return (previous ?? '') !== next
}

/**
 * HOW A REPEAT SUBMISSION IS MERGED — the policy, stated once.
 *
 *   'session'  matched on bookingSessionId: the SAME PERSON in the SAME
 *              sitting, so their latest answer WINS. Someone fixing a typo in
 *              their email or phone is CORRECTING us, and freezing the first
 *              value would have the crew calling a wrong number forever.
 *
 *   'email'    matched only on a shared address against an older open lead.
 *              Far weaker evidence — a household or work address can put two
 *              people on one row — so identity stays FILL-BLANK-ONLY.
 *
 * Blank input never erases a stored value under either policy, and attribution
 * stays first-touch under both.
 */
export type LeadMatchBasis = 'session' | 'email'

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
function partialConsentPatch(
  existing: Pick<ExistingPartialLead, 'emailMarketingConsent'>,
  input: PartialLeadInput,
  now: Date,
): Record<string, unknown> {
  // ── THE SHARED RULES, NOT A SECOND COPY (fix 2026-08-25) ───────────────
  //  This used to write whatever boolean arrived, straight through. That was
  //  survivable only because the browser almost never SENT `false`: every
  //  capture surface gated it behind a click, which is the bug this release
  //  fixes. The moment the booking form started reporting a displayed-but-
  //  unchecked box honestly — on all FIVE of its triggers, including an exit
  //  beacon — this line would have revoked a real opt-in on the next ping.
  //
  //  decideConsent already owns that rule ("an unchecked box on a later form
  //  is not an unsubscribe"), and the other ingestion path has always used it.
  //  Two capture paths must not hold two different consent policies.
  const decision = decideConsent(
    { consent: existing.emailMarketingConsent },
    {
      consent: input.marketingConsent,
      source: input.consentSource ?? 'BOOKING_FORM',
      version: clean(input.consentVersion) ?? CONSENT_VERSION,
    },
    now,
  )
  return decision.changes
}

/** Row to CREATE for a fresh partial lead. Pure. Status NEW keeps it an OPEN,
 *  dedup-able CRM row; `lifecycle` marks it as a partial-booking lead. On CREATE
 *  the consent columns are set explicitly (null when the box was never touched). */
/**
 * The quote-snapshot columns, or nothing at all.
 *
 * Returns an EMPTY object when there is no snapshot, so a capture that carries
 * one (the quick quote) writes all six columns and a capture that does not (the
 * booking form's step-1 ping) leaves every one of them alone. Spreading `{}` is
 * what keeps a later partial save from blanking a snapshot already recorded.
 */
function quoteSnapshotColumns(input: PartialLeadInput): Record<string, unknown> {
  //  A NUMERIC quote writes the whole snapshot, review state included.
  if (input.quoteSnapshot) return snapshotColumns(input.quoteSnapshot)

  //  REVIEW WITHOUT A NUMBER. An in-person request and a 5BR manual plan both
  //  need a human and both deliberately have NO total, so review state used to
  //  be lost on exactly the leads most needing attention — it only travelled
  //  inside the snapshot. Inventing a total merely to have somewhere to put
  //  the flag would be worse than losing it, so the flag travels alone.
  if (input.reviewReasonsOnly && input.reviewReasonsOnly.length) {
    return reviewOnlyColumns(input.reviewReasonsOnly)
  }
  return {}
}

export function buildPartialLeadCreate(input: PartialLeadInput, now: Date) {
  const consented = typeof input.marketingConsent === 'boolean'
  return {
    contactPreference: normalizeContactPreference(input.contactPreference),
    bestTimeToCall: clean(input.bestTimeToCall),
    // Site access from the quick quote's step-4 answers. See accessDetails.
    notes: clean(input.accessDetails),
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
    moveSize: clean(input.moveSize) ?? undefined,
    ...quoteSnapshotColumns(input),
    utmSource: clean(input.utmSource),
    utmMedium: clean(input.utmMedium),
    utmCampaign: clean(input.utmCampaign),
    utmContent: clean(input.utmContent),
    utmTerm: clean(input.utmTerm),
    landingPage: clean(input.landingPage),
    referrer: clean(input.referrer),
    promoCode: clean(input.promoCode),
    attributionId: cleanAttributionId(input.attributionId),
    estimatedValue: input.estimatedValue ?? null,
    lastActivityAt: now,
    emailMarketingConsent: consented ? (input.marketingConsent as boolean) : null,
    marketingConsentAt: consented ? now : null,
    marketingConsentSource: consented ? (normaliseConsentSource(input.consentSource) ?? 'BOOKING_FORM') : null,
    marketingConsentVersion: consented ? clean(input.consentVersion) : null,
    // ── WHETHER WE ASKED, recorded even when they did not answer ──────────
    //  Written whenever the client tells us, INCLUDING alongside a null
    //  consent — that combination ("we showed the box, they left it") is the
    //  exact state the old schema could not hold, and the one that produced
    //  "Marketing: not asked" about somebody who had been asked. A client that
    //  says nothing still stores null, which reads as unknown.
    //
    //  An explicit consent decision is itself proof the question was asked, so
    //  it implies TRUE without the client having to say so twice.
    marketingConsentPrompted: consented ? true : (input.marketingConsentPrompted ?? null),
    // ── THE CUSTOMER'S OWN ANSWER, in its own column ─────────────────────
    //  It used to reach only composeNotes() -> free-text `notes` on the OTHER
    //  ingestion path, and nothing at all on this one, so a partial capture
    //  could never say what the customer reported.
    foundUs: clean(input.foundUs),
    foundUsPrompted: input.foundUsPrompted ?? null,
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
  /** Read so a browser figure cannot undercut a price we already emailed. */
  quoteConfirmationQueuedAt: Date | null
  utmSource: string | null
  utmCampaign: string | null
  landingPage: string | null
  referrer: string | null
  promoCode: string | null
  /** Read so the update can apply first-touch attribution correctly. Without it
   *  fillIfBlank compares against `undefined`, decides the column is empty, and
   *  overwrites a real id with null on the next ping. */
  attributionId: string | null
  notes: string | null
  /** Read so the channel can be UPGRADED off the OTHER placeholder without a
   *  real channel ever being overwritten. See sourceUpgradePatch. */
  source: LeadSource | null
  /** Read so "we asked" can only ever move forward. See questionProvenancePatch. */
  marketingConsentPrompted: boolean | null
  foundUs: string | null
  foundUsPrompted: boolean | null
}

/** Patch to UPDATE an existing lead from a repeat partial submission. Pure:
 *  bumps activity, ADVANCES lifecycle only (never regresses / never leaves
 *  CONVERTED), always tracks the latest step, fills blank attribution, and
 *  applies TRI-STATE consent (a fresh unchecked load — marketingConsent
 *  undefined — leaves any stored consent untouched). */
/**
 * WHAT WE ASKED, merged forward only.
 *
 * "We showed them the question" is a fact that cannot become untrue. Once a
 * step has been reached, a later ping from an earlier step — a back-navigation,
 * a stale tab, an exit beacon that fires after the visitor scrolled back — must
 * not be able to un-ask it. So these are MONOTONIC: false/undefined can raise
 * to true, and nothing lowers.
 *
 * The customer's own answer follows the opposite-but-consistent rule: written
 * only when one actually arrives, so a payload that omits it (every ping before
 * they reach that step) erases nothing.
 *
 * PURE. Returns only the keys it means to change — an absent key leaves the
 * stored column exactly as it was.
 */
export function questionProvenancePatch(
  existing: Pick<ExistingPartialLead, 'marketingConsentPrompted' | 'foundUs' | 'foundUsPrompted'>,
  input: PartialLeadInput,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  //  An explicit consent decision proves the question was asked, whatever the
  //  client claimed about the checkbox.
  const asked = typeof input.marketingConsent === 'boolean' || input.marketingConsentPrompted === true
  if (asked) {
    if (existing.marketingConsentPrompted !== true) patch.marketingConsentPrompted = true
  } else if (input.marketingConsentPrompted === false && existing.marketingConsentPrompted == null) {
    //  Only ever recorded on a lead that had NO answer either way. A surface
    //  saying "I have no checkbox" must not overwrite a surface that did.
    patch.marketingConsentPrompted = false
  }

  const answer = clean(input.foundUs)
  if (answer) patch.foundUs = answer

  if (input.foundUsPrompted === true) {
    if (existing.foundUsPrompted !== true) patch.foundUsPrompted = true
  } else if (input.foundUsPrompted === false && existing.foundUsPrompted == null) {
    patch.foundUsPrompted = false
  }

  return patch
}

/**
 * The marketing CHANNEL, upgraded but never downgraded.
 *
 * `source` was written on CREATE only, so a lead whose first ping carried no
 * detectable channel was stored as `OTHER` — the column default and the
 * mapLeadSource() fallback — and stayed OTHER forever, even when a later ping
 * in the same session arrived with the campaign attached. That is how a
 * door-hanger scan could sit in the CRM as "Other" while the hanger was
 * demonstrably working.
 *
 * ONE DIRECTION ONLY. A real channel is never overwritten by another one: a
 * second value later in the same session is a second touch, not a correction of
 * the first, and first-touch attribution is what the campaign report joins on
 * (the same rule `attributionId` follows above).
 */
export function sourceUpgradePatch(
  existing: Pick<ExistingPartialLead, 'source'>,
  input: PartialLeadInput,
): Record<string, unknown> {
  const known = (existing.source ?? '').trim().toUpperCase()
  //  Only a placeholder may be replaced. OTHER and UNKNOWN are not channels
  //  anybody chose — they are what the system writes when it has nothing.
  if (known && known !== LeadSource.OTHER && known !== 'UNKNOWN') return {}
  if (!clean(input.source)) return {}
  const next = mapLeadSource(input.source)
  return next === LeadSource.OTHER ? {} : { source: next }
}

export function buildPartialLeadUpdate(
  existing: ExistingPartialLead,
  input: PartialLeadInput,
  now: Date,
  matchedBy: LeadMatchBasis = 'email'
) {
  const fillIfBlank = <T>(cur: T | null, next: T | null | undefined): T | null => (cur == null ? (next ?? null) : cur)
  /** Same-session: latest non-empty wins. Email-match: fill blanks only. */
  const correctable = <T>(cur: T | null, next: T | null | undefined): T | null =>
    matchedBy === 'session' && next != null ? next : fillIfBlank(cur, next)

  // Lifecycle: never downgrade. CONVERTED/SUBMITTED are sticky terminal-ish.
  const candidate = lifecycleForStep(input.formStep)
  const curRank = existing.lifecycle ? LIFECYCLE_RANK[existing.lifecycle] ?? 0 : -1
  const nextLifecycle = (LIFECYCLE_RANK[candidate] ?? 0) > curRank ? candidate : (existing.lifecycle ?? candidate)

  const data: Record<string, unknown> = {
    lastActivityAt: now,
    lifecycle: nextLifecycle,
    //  A repeat submission that carries a fresh server-computed quote replaces
    //  the snapshot; one that carries none leaves the stored snapshot intact.
    ...quoteSnapshotColumns(input),
    //  ── THE CURRENT SELECTION (fix 2026-08-22) ──────────────────────────
    //  `moveSize` was written on CREATE only, so a visitor who changed their
    //  mind — or whose first ping arrived before they picked a size — kept the
    //  original value forever, and the CRM disagreed with the quote beside it.
    //  Only ever a CANONICAL key: callers pass the value the price book
    //  returned, and `undefined` for a refused one, which leaves the stored
    //  value untouched rather than blanking it.
    ...(clean(input.moveSize) ? { moveSize: clean(input.moveSize) } : {}),
    // Always keep the LATEST step + estimate (they move forward as the form fills).
    formStep: clean(input.formStep) ?? existing.formStep,
    bookingSessionId: existing.bookingSessionId ?? clean(input.bookingSessionId),
    // Name/phone/attribution: fill blanks only — never clobber curated data.
    // Identity follows the merge policy: in-session the customer's latest name
    // WINS (they are correcting a typo), while a loose email match keeps the
    // stored name unless it is a placeholder — a shared household address must
    // never rename someone.
    name:
      matchedBy === 'session'
        ? (composePartialName(input) ?? existing.name)
        : existing.name && existing.name !== 'Booking lead' && existing.name !== 'Website lead'
          ? existing.name
          : (composePartialName(input) ?? existing.name),
    phone: correctable(existing.phone, clean(input.phone)),
    email: correctable(existing.email, normalizeEmail(input.email)),
    utmSource: fillIfBlank(existing.utmSource, clean(input.utmSource)),
    utmCampaign: fillIfBlank(existing.utmCampaign, clean(input.utmCampaign)),
    landingPage: fillIfBlank(existing.landingPage, clean(input.landingPage)),
    referrer: fillIfBlank(existing.referrer, clean(input.referrer)),
    promoCode: fillIfBlank(existing.promoCode, clean(input.promoCode)),
    /* FILL-BLANK-ONLY, and NOT `correctable`, even in-session.
       Attribution is FIRST-TOUCH here on purpose: the id belongs to the scan
       that produced this lead. A later ping in the same session that happens to
       arrive without one — a bookmark, a back-navigation, a tab the visitor had
       already open — must not be able to blank it, and a DIFFERENT id arriving
       later is a second visit, not a correction of the first. The rest of the
       attribution block on this object follows the same rule for the same
       reason; only name/phone/email are `correctable`, because those are the
       fields a customer actually retypes to fix a typo. */
    attributionId: fillIfBlank(existing.attributionId, cleanAttributionId(input.attributionId)),
    // Access details: FILL-BLANK-ONLY. See PartialLeadInput.accessDetails.
    notes: fillIfBlank(existing.notes, clean(input.accessDetails)),
    ...partialConsentPatch(existing, input, now),
    ...questionProvenancePatch(existing, input),
    ...sourceUpgradePatch(existing, input),
  }
  // The customer's own current answers. Written only when supplied, so a
  // later page that omits them erases nothing.
  const pref = normalizeContactPreference(input.contactPreference)
  if (pref != null) (data as Record<string, unknown>).contactPreference = pref
  const best = clean(input.bestTimeToCall)
  if (best != null) (data as Record<string, unknown>).bestTimeToCall = best
  // See mayWriteEstimate: a browser figure must not undercut a number we have
  // already emailed. (The comment that used to sit here claimed this code
  // "only ever fills in / increases". It did not — it overwrote, always.)
  if (mayWriteEstimate(existing, input.estimatedValue, input.estimateAuthoritative === true)) {
    data.estimatedValue = input.estimatedValue
  }
  return data
}

/**
 * MAY this submission change the lead's stored estimate?
 *
 * THE BUG THIS EXISTS TO STOP. Two capture surfaces write this column and they
 * do not compute the same number:
 *
 *   /api/leads/quote-capture  the SERVER's price for the package, including the
 *                             required truck-size upgrade. This is the number
 *                             we put in the customer's confirmation email.
 *   /api/leads/partial        the BOOKING FORM's own figure — base + labor +
 *                             add-ons + travel, and deliberately WITHOUT the
 *                             truck upgrade (that form treats the truck as a
 *                             move-day line, never part of the total).
 *
 * A customer who quotes and then opens the booking form hits both, in that
 * order. The old rule wrote whatever arrived last, so a lead emailed "$879"
 * ended up stored as "$779" — the CRM disagreeing with the customer's own copy
 * of the quote, in the direction that makes us look like we moved the price.
 *
 * THE RULE, and the reasoning for each branch:
 *   1. A SERVER price always writes. It is the authority; a re-quote is a real
 *      change and must land, up or down.
 *   2. A blank always fills. Something beats nothing.
 *   3. A lead we have never emailed keeps today's behaviour exactly — the
 *      booking form is the only writer, so there is no disagreement to create.
 *   4. Once a confirmation HAS been emailed, a browser figure may only RAISE
 *      the number. A rise is real information (the customer added stairs, a
 *      second location); a fall is almost always the base-only figure racing
 *      the total we already quoted.
 *
 * PURE. `existing` is what is stored, `incoming` what arrived.
 */
export function mayWriteEstimate(
  existing: { estimatedValue: number | null; quoteConfirmationQueuedAt?: Date | null },
  incoming: number | null | undefined,
  authoritative: boolean
): boolean {
  if (typeof incoming !== 'number' || incoming <= 0) return false // never overwrite with null/0
  if (authoritative) return true
  if (existing.estimatedValue == null) return true
  if (existing.quoteConfirmationQueuedAt == null) return true
  return incoming >= existing.estimatedValue
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
  let matchedBy: LeadMatchBasis = 'email'
  if (sessionId) {
    existing = await deps.store.findBySessionId(sessionId)
    if (existing) matchedBy = 'session'
  }
  if (!existing && email) existing = await deps.store.findOpenPartialByEmail(email)

  if (existing) {
    const lead = await deps.store.update(existing.id, buildPartialLeadUpdate(existing, input, now, matchedBy))
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
    quoteConfirmationQueuedAt: true,
    utmSource: true, utmCampaign: true, landingPage: true, referrer: true, promoCode: true,
    attributionId: true,
    // Read so the update can fill `notes` ONLY when it is empty.
    notes: true,
    // Read so the merge rules above can be applied at all: a column the store
    // does not SELECT compares against `undefined`, which every fill-blank
    // helper reads as "empty" — that is how a real attributionId used to be
    // overwritten with null on the next ping.
    source: true,
    marketingConsentPrompted: true,
    foundUs: true,
    foundUsPrompted: true,
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

export type CapturePartialOptions = {
  /**
   * Post the plain new-lead notice to Discord on a NEW lead. Default true.
   * `false` means the CALLER owns the owner-facing notification — today only
   * the quick-quote route, which sends the richer card from quote-capture.ts.
   */
  notifyOwner?: boolean
}

/** Route convenience: capture a partial lead and NEVER throw. Still silent on
 *  the PROMOTIONAL side — no automation trigger fires from here, for any caller
 *  (the quick quote fires its own, consent-gated, from quote-capture.ts).
 *  Returns the record or null. */
export async function capturePartialLeadSafe(
  input: PartialLeadInput,
  context: string,
  deps?: PartialLeadDeps,
  opts: CapturePartialOptions = {}
): Promise<CapturePartialResult> {
  try {
    const res = await capturePartialLead(input, deps)
    if (res) apiLogger.info({ leadId: res.lead.id, isNew: res.isNew, context }, 'partial lead captured')
    // Tell the owner. NEW leads only -- a repeat submission merges into the
    // existing lead and takes the update path, so this cannot double-notify.
    //
    // ONE CALLER OPTS OUT: the quick quote posts a RICHER card (buttons, the
    // estimate, the contact preference) from quote-capture.ts, which also
    // records delivery on the lead and re-alerts when the facts change. Both
    // firing would ping the owner twice for the same lead -- and this plain
    // notice would arrive first, so the useful one would look like the
    // duplicate. quote-capture falls back to this notice if its queue is down,
    // so opting out never costs the owner the lead.
    if (res?.isNew && opts.notifyOwner !== false) notifyOwnerOfNewLead(res.lead.id, context)
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

// ════════════════════════════════════════════════════════════════════════
//  SUPPRESSION + BOOKING HISTORY — two facts the lifecycle keeps asking for.
// ════════════════════════════════════════════════════════════════════════

/** Is this address on the do-not-send list, at any scope? Fails CLOSED (a read
 *  error answers "suppressed"), because the cost of a wrong `false` here is a
 *  form silently re-subscribing somebody who unsubscribed. */
export async function isAddressSuppressed(email?: string | null): Promise<boolean> {
  const normalized = normalizeEmail(email)
  if (!normalized) return false
  try {
    return (await prisma.emailSuppression.findUnique({ where: { email: normalized }, select: { id: true } })) !== null
  } catch (err) {
    apiLogger.warn({ err: String(err).slice(0, 200) }, 'suppression lookup failed — treating as suppressed')
    return true
  }
}

/**
 * PURE: does this booking count as "this person has moved with us before"?
 *
 * DELIBERATELY NOT "a booking row exists". A booking parked in DRAFT or
 * PENDING_PAYMENT is somebody who started a form, which is precisely the
 * first-time customer the welcome sequence is for. What makes someone a
 * previous customer is that a booking was actually taken: a confirmed date, or
 * money captured.
 */
export function countsAsPriorBooking(b: {
  status: string
  depositPaid: boolean
  isInternalTest: boolean
}): boolean {
  if (b.isInternalTest) return false
  if (b.depositPaid) return true
  return ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'].includes(b.status)
}

/**
 * Has this address ever actually booked a move with us?
 *
 * BOOKING HISTORY, NOT LEAD STATUS — owner spec 2026-08-06, and the distinction
 * matters. A returning customer who fills in the quick quote form gets a BRAND
 * NEW lead row with status NEW (the dedupe deliberately starts a fresh lead once
 * the old one is closed), so every lead-status test would call them a first-time
 * enquiry and put them back through the welcome sequence they already had.
 *
 * FAILS CLOSED: a read error answers `true`, so an outage suppresses a welcome
 * sequence rather than sending a returning customer "nice to meet you".
 */
export async function hasEverBooked(email?: string | null): Promise<boolean> {
  const normalized = normalizeEmail(email)
  if (!normalized) return false
  try {
    const bookings = await prisma.booking.findMany({
      where: { customer: { email: normalized } },
      select: { status: true, depositPaid: true, isInternalTest: true },
      take: 25,
    })
    return bookings.some(countsAsPriorBooking)
  } catch (err) {
    apiLogger.warn({ err: String(err).slice(0, 200) }, 'booking-history lookup failed — treating as a previous customer')
    return true
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
