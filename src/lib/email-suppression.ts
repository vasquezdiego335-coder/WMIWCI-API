// ════════════════════════════════════════════════════════════════════════
//  EMAIL SUPPRESSION — the ONE global do-not-send list (owner spec 2026-07-20).
//  ---------------------------------------------------------------------
//  Before this module the only opt-out signal in the API was
//  `Customer.marketingOptOut`, set exclusively by the inbound-SMS STOP webhook.
//  There was no way to record an email unsubscribe, and a hard bounce or spam
//  complaint from Resend was not processed at all — so the system would keep
//  writing to a dead or hostile address forever.
//
//  DESIGN
//    • Keyed on the ADDRESS, not on a Customer/Lead id, so one list covers
//      Customers, Leads, and contacts only Leadtracking/SendGrid knows about.
//    • Two scopes:
//        'promotional' — unsubscribe. Marketing stops; transactional booking
//                        mail (receipts, move-day details) still sends. That
//                        distinction is the law's, not a loophole: a receipt
//                        is not an offer.
//        'all'         — hard bounce, complaint, invalid, admin block. NOTHING
//                        sends, transactional included. Writing to a complaining
//                        or dead address damages domain reputation for everyone.
//    • Reads FAIL CLOSED. If the suppression table cannot be read we refuse the
//      send rather than risk mailing a suppressed address.
//    • Idempotent. Re-suppressing never downgrades scope ('all' wins). The
//      row's LABEL (reason) only ever gets harder to lift: a stronger signal
//      relabels a weaker one, never the reverse, and an UNSUBSCRIBED label is
//      never replaced (see suppressionLabelAfter).
// ════════════════════════════════════════════════════════════════════════

import type { SuppressionReason } from '@prisma/client'
import { prisma } from './db'
import { queueLogger } from './logger'
import { normalizeEmail } from './email-tokens'

const log = queueLogger.child({ mod: 'email-suppression' })

export type EmailClass = 'transactional' | 'promotional'
export type SuppressionScope = 'promotional' | 'all'

/** Reasons that block EVERY message, not just marketing. */
const BLOCKS_ALL: ReadonlySet<SuppressionReason> = new Set<SuppressionReason>([
  'HARD_BOUNCE',
  'SPAM_COMPLAINT',
  'INVALID_ADDRESS',
  'ADMIN_BLOCK',
  'PROVIDER_REJECTED',
])

/** The scope a reason implies. UNSUBSCRIBED is promotional-only; all else is total. */
export function scopeForReason(reason: SuppressionReason): SuppressionScope {
  return BLOCKS_ALL.has(reason) ? 'all' : 'promotional'
}

// ── THE ROW'S LABEL (2026-09-16) ───────────────────────────────────────────
//  The admin screen decides what an operator may lift FROM THE LABEL: ADMIN_BLOCK
//  and INVALID_ADDRESS can be lifted, a complaint, a hard bounce or a provider
//  rejection cannot, and an unsubscribe belongs to the person. So when a second
//  reason lands on an existing row the label must never get EASIER to lift:
//    • a stronger reason relabels a weaker one (a hard bounce on an ADMIN_BLOCK
//      row becomes HARD_BOUNCE — otherwise the operator could lift a bounce);
//    • a weaker reason never relabels a stronger one;
//    • UNSUBSCRIBED is never replaced: hidden under another label, the admin
//      could lift the person's own decision.
const LABEL_STRENGTH: Record<SuppressionReason, number> = {
  INVALID_ADDRESS: 1,
  ADMIN_BLOCK: 2,
  PROVIDER_REJECTED: 3,
  HARD_BOUNCE: 4,
  SPAM_COMPLAINT: 5,
  UNSUBSCRIBED: Number.POSITIVE_INFINITY,
}

/** The label a row carries after `incoming` lands on a row labelled `existing`. */
export function suppressionLabelAfter(existing: SuppressionReason, incoming: SuppressionReason): SuppressionReason {
  if (existing === 'UNSUBSCRIBED') return existing
  return LABEL_STRENGTH[incoming] > LABEL_STRENGTH[existing] ? incoming : existing
}

/** The labels `incoming` replaces — the WHERE of the atomic relabel. Never UNSUBSCRIBED. */
export function labelsReplacedBy(incoming: SuppressionReason): SuppressionReason[] {
  return (Object.keys(LABEL_STRENGTH) as SuppressionReason[]).filter(
    (existing) => existing !== incoming && suppressionLabelAfter(existing, incoming) === incoming,
  )
}

export type SuppressionCheck = {
  suppressed: boolean
  /** Machine-readable reason, or 'eligible'. Recorded on blocked EmailSend rows. */
  reason: string
  scope?: SuppressionScope
}

const ELIGIBLE: SuppressionCheck = { suppressed: false, reason: 'eligible' }

/**
 * Is this address suppressed for the given class of message?
 *
 * FAILS CLOSED: a database error returns `suppressed: true` with reason
 * 'suppression_read_failed'. A transient outage must never become a send.
 */
export async function isSuppressed(email: string, emailClass: EmailClass): Promise<SuppressionCheck> {
  const normalized = normalizeEmail(email)
  if (!normalized) return { suppressed: true, reason: 'blank_email' }

  try {
    const row = await prisma.emailSuppression.findUnique({ where: { email: normalized } })
    if (!row) return ELIGIBLE

    const scope = (row.scope === 'promotional' ? 'promotional' : 'all') as SuppressionScope

    // A promotional-only suppression never blocks transactional mail.
    if (scope === 'promotional' && emailClass === 'transactional') return ELIGIBLE

    return { suppressed: true, reason: row.reason.toLowerCase(), scope }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), emailClass },
      'suppression read failed — failing CLOSED (not sending)'
    )
    return { suppressed: true, reason: 'suppression_read_failed' }
  }
}

export type SuppressInput = {
  email: string
  reason: SuppressionReason
  /** 'unsubscribe-link' | 'resend-webhook' | 'leadtracking' | 'admin' | 'sms-stop' */
  source?: string
  detail?: string
}

/**
 * The outcome of a suppression write.
 *
 * WHY THIS IS A UNION AND NOT A BOOLEAN (finding EMAIL-P0-01):
 * `suppress()` used to return `boolean`, where `false` meant BOTH "already
 * covered, nothing to do" AND "the database write failed". Callers could not
 * tell those apart, so the webhook handler treated a failed write as success,
 * returned HTTP 200, and — because the EmailEvent row had already been written
 * with a unique providerEventId — the provider's retry was deduplicated away.
 * The address stayed sendable forever with no trace. A boolean cannot express
 * "I did not do the thing you asked", so it is gone.
 */
export type SuppressionResult =
  | { status: 'created' }
  | { status: 'already_suppressed' }
  | { status: 'escalated' }
  | { status: 'not_required'; reason: string }
  | { status: 'write_failed'; error: unknown }

/** True when the address is definitely on the list at the required scope. */
export function isSuppressionSettled(r: SuppressionResult): boolean {
  return r.status === 'created' || r.status === 'already_suppressed' || r.status === 'escalated'
}

/**
 * Add (or escalate) an address on the suppression list. Idempotent and ATOMIC.
 *
 * Escalation rule: a later, MORE severe signal wins. An address that
 * unsubscribed and then hard-bounced ends up scope 'all'. The reverse never
 * happens — an unsubscribe can never downgrade an existing 'all' block.
 *
 * CONCURRENCY (finding EMAIL-P1-09): the previous implementation did
 * `findUnique` then `create`/`update` outside a transaction, so a concurrent
 * unsubscribe and hard-bounce could interleave and leave the WEAKER state. Both
 * writes are now single atomic statements:
 *   • promotional → `create`, and a unique-violation is re-read (someone else
 *     got there first; their row is at least as strong, because a promotional
 *     write never needs to widen anything).
 *   • all        → `upsert`, whose update branch unconditionally sets
 *     scope='all'. Severity only ever increases.
 *
 * Never throws — it returns `write_failed` instead, because this is called from
 * webhook handlers where a throw would make the provider retry forever.
 */
export async function suppress(input: SuppressInput): Promise<SuppressionResult> {
  const email = normalizeEmail(input.email)
  if (!email) return { status: 'not_required', reason: 'blank_email' }

  const scope = scopeForReason(input.reason)
  const detail = input.detail?.slice(0, 500) ?? null

  // LOCKED STOP RULE: a suppression ends every ACTIVE automation enrollment
  // for the address the moment it lands — unsubscribe/bounce/complaint are
  // never overridable. Dynamic import breaks the guard→suppression→runtime
  // cycle; fire-and-forget because the send guard is the authoritative block
  // even if this cleanup fails.
  import('./email-automation-runtime')
    .then((m) => m.stopEnrollmentsFor({ email }, `suppressed:${String(input.reason).toLowerCase()}`))
    .catch(() => undefined)
  //  …and every form-triggered sequence (quote follow-up, abandoned checkout,
  //  lead nurture) stops. Rows only — no queue access from here: a stopped row
  //  makes every remaining stage skip before it queues an email (the stage
  //  handlers check the enrollment), and the send gate refuses a suppressed
  //  address regardless. Same cycle-breaking dynamic import, same best effort.
  const stopReason = `suppressed:${String(input.reason).toLowerCase()}`.slice(0, 80)
  import('./consent/sequence-enrollment')
    .then((m) => m.stopEnrollmentsForPerson(email, stopReason))
    .catch(() => undefined)

  try {
    if (scope === 'all') {
      // A total block always wins. One statement, no read-modify-write window:
      // if a row exists at ANY scope this widens it; if not, it creates it.
      const before = await prisma.emailSuppression.findUnique({
        where: { email },
        select: { scope: true, reason: true },
      })
      // ── THE LABEL ONLY EVER GETS HARDER TO LIFT (2026-09-16) ──────────────
      //  The update branch used to set `reason` unconditionally, so an
      //  UNSUBSCRIBED row that later received ADMIN_BLOCK or INVALID_ADDRESS
      //  (the Leadtracking bridge accepts any reason) was relabelled and the
      //  admin screen could lift it — and a later ADMIN_BLOCK could even turn a
      //  complaint into something liftable. Now the upsert widens the SCOPE, and
      //  a separate conditional statement relabels only a WEAKER label
      //  (suppressionLabelAfter). The relabel is its own atomic statement, so a
      //  concurrent writer can never leave a bounce under a liftable label, and
      //  the admin DELETE's reason-filter race guard sees the change.
      const escalation = `escalated to all by ${input.reason}${input.source ? ` (${input.source})` : ''}${detail ? `: ${detail}` : ''}`
      await prisma.emailSuppression.upsert({
        where: { email },
        create: { email, reason: input.reason, scope: 'all', source: input.source ?? null, detail },
        update: before?.scope === 'all' ? { scope: 'all' } : { scope: 'all', detail: escalation.slice(0, 500) },
      })
      //  Run even when `before` was null: a row a concurrent writer created in
      //  between is relabelled too, and a row this upsert created carries
      //  input.reason, which the filter never matches.
      const replaced = labelsReplacedBy(input.reason)
      const relabel =
        replaced.length > 0
          ? await prisma.emailSuppression.updateMany({
              where: { email, reason: { in: replaced } },
              data: {
                reason: input.reason,
                source: input.source ?? undefined,
                detail: `relabelled from ${before?.reason ?? 'a weaker reason'} to ${input.reason}${input.source ? ` (${input.source})` : ''}${detail ? `: ${detail}` : ''}`.slice(0, 500),
              },
            })
          : { count: 0 }
      if (relabel.count > 0) {
        log.info({ from: before?.reason ?? null, reason: input.reason, source: input.source }, 'suppression relabelled to the stronger reason')
      }
      if (!before) {
        log.info({ reason: input.reason, source: input.source }, 'address suppressed (all)')
        return { status: 'created' }
      }
      if (before.scope === 'all') return { status: 'already_suppressed' }
      log.info({ reason: input.reason, source: input.source }, 'suppression escalated to scope=all')
      return { status: 'escalated' }
    }

    // Promotional: only ever creates. It must NEVER downgrade an existing row,
    // so a unique violation is a success for our purposes — something at least
    // as strong is already there.
    try {
      await prisma.emailSuppression.create({
        data: { email, reason: input.reason, scope: 'promotional', source: input.source ?? null, detail },
      })
      log.info({ reason: input.reason, source: input.source }, 'address suppressed (promotional)')
      return { status: 'created' }
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') return { status: 'already_suppressed' }
      throw err
    }
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'suppress() FAILED — caller must not report success')
    return { status: 'write_failed', error: err }
  }
}

export type ResubscribeResult =
  /** `mirrored: false` = the list is clean but Customer.marketingOptOut lagged. */
  | { status: 'removed'; mirrored: boolean }
  | { status: 'not_suppressed' }
  | { status: 'hard_suppression_refused' }
  | { status: 'write_failed'; error: unknown }

/**
 * Remove a PROMOTIONAL suppression (a genuine resubscribe).
 *
 * ONLY the unsubscribe route's POST with a verified 'resubscribe' purpose token
 * may call this (DESIGN-v2 §8). It lifts only an UNSUBSCRIBED row, and writing
 * the resubscribed + express_opt_in consent events is the caller's job.
 *
 * Deliberately refuses to lift a scope 'all' block: a hard bounce or spam
 * complaint is not something a customer can click their way out of, and
 * re-mailing a complaining address is how a sending domain gets blocklisted.
 * Those require an explicit admin action with a recorded reason.
 *
 * CONCURRENCY (finding EMAIL-P1-09): this used to read the row, check its
 * scope, then `delete({ where: { email } })`. A hard bounce landing between the
 * read and the delete was silently destroyed — a customer's resubscribe click
 * would erase a complaint suppression. The delete is now a SINGLE conditional
 * statement scoped to `scope: 'promotional'`, so a row that escalated to 'all'
 * in the meantime simply does not match and survives.
 */
export async function resubscribe(email: string): Promise<ResubscribeResult> {
  const normalized = normalizeEmail(email)
  if (!normalized) return { status: 'not_suppressed' }

  try {
    // Conditional delete — the scope filter IS the race guard. The reason
    // filter keeps it to what a resubscribe may lift: the person's own
    // UNSUBSCRIBED row, never a bounce, complaint or admin block.
    const { count } = await prisma.emailSuppression.deleteMany({
      where: { email: normalized, scope: 'promotional', reason: 'UNSUBSCRIBED' },
    })
    if (count > 0) {
      // ── UN-MIRROR (found by a production smoke test, 2026-08-06) ────────
      //  `unsubscribeEmail` sets Customer.marketingOptOut = true. Nothing ever
      //  set it back. So a customer who unsubscribed and then clicked "keep me
      //  subscribed" had their suppression row deleted, was shown "You are back
      //  on the list" — and stayed permanently blocked, because
      //  promotionalConsentBlockReason reads marketingOptOut and classifies
      //  `marketing_opted_out` as TERMINAL. The page was telling them something
      //  that was not true.
      //
      //  A ONE-WAY MIRROR IS THE BUG. This makes it symmetric: the same write
      //  the unsubscribe path makes, undone by the path that undoes it.
      //
      //  CHANNEL CAVEAT, stated rather than hidden: marketingOptOut is also set
      //  by the inbound-SMS STOP webhook, and this cannot tell the two apart —
      //  so an email resubscribe will also clear an SMS STOP. That conflation
      //  already existed in the other direction (an EMAIL unsubscribe sets the
      //  SMS flag); making it symmetric is strictly better than leaving people
      //  silently un-resubscribable. Separating the channels needs its own
      //  column, which is a schema change and a different piece of work.
      let mirrored = true
      await prisma.customer
        .updateMany({ where: { email: normalized }, data: { marketingOptOut: false } })
        .catch((err) => {
          mirrored = false
          log.warn(
            { err: String(err) },
            'suppression removed but Customer.marketingOptOut mirror NOT cleared — follow-ups stay blocked for this address'
          )
        })
      log.info({ mirrored }, 'promotional suppression removed (resubscribe)')
      return { status: 'removed', mirrored }
    }

    // Nothing deleted: either there was no row, or it is an 'all' block we must
    // not touch. Distinguish so the customer gets a truthful page.
    const existing = await prisma.emailSuppression.findUnique({
      where: { email: normalized },
      select: { scope: true },
    })
    return existing ? { status: 'hard_suppression_refused' } : { status: 'not_suppressed' }
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'resubscribe() FAILED')
    return { status: 'write_failed', error: err }
  }
}

export type UnsubscribeResult =
  | { status: 'unsubscribed'; mirrored: boolean }
  | { status: 'already_unsubscribed'; mirrored: boolean }
  | { status: 'write_failed'; error: unknown }

/**
 * Record an email unsubscribe. Also mirrors onto Customer.marketingOptOut so the
 * older SMS/follow-up guards (which read that flag) agree with the list — one
 * opt-out, honoured by every path.
 *
 * TRUTHFULNESS (finding EMAIL-P1-07): this used to return a bare boolean that
 * conflated "already unsubscribed" with "the write failed", and the route showed
 * a success page either way. It now reports what actually happened, and the
 * route is required to act on it.
 *
 * PARTIAL SUCCESS is explicit rather than hidden. The suppression list is the
 * AUTHORITATIVE record and is written first; the Customer mirror is a
 * convenience for older guards. If the MIRROR fails we still report success —
 * the customer IS unsubscribed, because every send path consults the list — but
 * `mirrored: false` is surfaced for operations. If the SUPPRESSION write fails,
 * that is a real failure and is reported as one.
 */
export async function unsubscribeEmail(
  email: string,
  source = 'unsubscribe-link'
): Promise<UnsubscribeResult> {
  const normalized = normalizeEmail(email)
  if (!normalized) return { status: 'write_failed', error: new Error('blank email') }

  const result = await suppress({ email: normalized, reason: 'UNSUBSCRIBED', source })
  if (result.status === 'write_failed') return { status: 'write_failed', error: result.error }
  if (result.status === 'not_required') {
    return { status: 'write_failed', error: new Error(result.reason) }
  }

  let mirrored = true
  await prisma.customer
    .updateMany({ where: { email: normalized }, data: { marketingOptOut: true } })
    .catch((err) => {
      mirrored = false
      log.warn(
        { err: String(err) },
        'suppression WRITTEN but Customer.marketingOptOut mirror failed — sends are still blocked by the list'
      )
    })

  return {
    status: result.status === 'already_suppressed' ? 'already_unsubscribed' : 'unsubscribed',
    mirrored,
  }
}

// ════════════════════════════════════════════════════════════════════════
//  AN OPERATOR CANNOT LIFT AN UNSUBSCRIBE (DESIGN-v2 §8, 2026-09-16)
//  ---------------------------------------------------------------------
//  An unsubscribe is the person's own decision, and only the person may undo
//  it — through the short-lived resubscribe token on the page they reach right
//  after unsubscribing. The admin DELETE used to accept UNSUBSCRIBED, so a
//  support action could quietly re-open marketing to somebody who had asked
//  for it to stop.
//
//  Two checks, because a row's reason alone is not always the whole story:
//    1. reason UNSUBSCRIBED — refused outright.
//    2. an 'unsubscribed' consent event for the address — refused, whatever
//       the row now says. Before 2026-09-16 an escalation overwrote the reason,
//       so an unsubscribe could be sitting under an ADMIN_BLOCK label.
//  A read failure REFUSES: "could not check" is never "nothing to protect".
// ════════════════════════════════════════════════════════════════════════

export type AdminLiftVerdict = { allow: true } | { allow: false; why: string; code: 'unsubscribed' | 'unsubscribe_on_record' | 'check_failed' }

type AdminLiftDb = { emailConsentEvent: { findFirst(args: unknown): Promise<unknown> } }

export async function adminLiftRefusal(
  email: string,
  reason: string,
  db: AdminLiftDb = prisma as unknown as AdminLiftDb
): Promise<AdminLiftVerdict> {
  if (reason === 'UNSUBSCRIBED') {
    return {
      allow: false,
      code: 'unsubscribed',
      why: 'This person unsubscribed. Only they can undo that, from the link in their unsubscribe confirmation page. It cannot be lifted from the admin.',
    }
  }
  try {
    const unsubscribed = await db.emailConsentEvent.findFirst({
      where: { emailNormalized: normalizeEmail(email), kind: 'unsubscribed' },
      select: { id: true },
    })
    if (unsubscribed) {
      return {
        allow: false,
        code: 'unsubscribe_on_record',
        why: 'This address has an unsubscribe on record. Only the person can undo that, so this suppression cannot be lifted from the admin.',
      }
    }
    return { allow: true }
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'admin lift check failed — refusing')
    return { allow: false, code: 'check_failed', why: 'Could not verify this address has no unsubscribe on record. Nothing was lifted; try again.' }
  }
}
