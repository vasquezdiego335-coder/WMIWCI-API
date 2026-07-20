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
//    • Idempotent. Re-suppressing never downgrades scope ('all' wins) and never
//      overwrites the original reason.
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
 * Add (or escalate) an address on the suppression list. Idempotent.
 *
 * Escalation rule: a later, MORE severe signal wins. An address that
 * unsubscribed and then hard-bounced ends up scope 'all'. The reverse never
 * happens — an unsubscribe can never downgrade an existing 'all' block.
 *
 * Returns true when the row was created or escalated, false when it was already
 * covered. Never throws: suppression is called from webhook handlers where a
 * throw would make the provider retry forever.
 */
export async function suppress(input: SuppressInput): Promise<boolean> {
  const email = normalizeEmail(input.email)
  if (!email) return false

  const scope = scopeForReason(input.reason)

  try {
    const existing = await prisma.emailSuppression.findUnique({ where: { email } })

    if (!existing) {
      await prisma.emailSuppression.create({
        data: {
          email,
          reason: input.reason,
          scope,
          source: input.source ?? null,
          detail: input.detail?.slice(0, 500) ?? null,
        },
      })
      log.info({ reason: input.reason, scope, source: input.source }, 'address suppressed')
      return true
    }

    // Already blocked at the widest scope — nothing to escalate.
    if (existing.scope === 'all' || scope === 'promotional') return false

    await prisma.emailSuppression.update({
      where: { email },
      data: {
        reason: input.reason,
        scope: 'all',
        source: input.source ?? existing.source,
        detail: input.detail?.slice(0, 500) ?? existing.detail,
      },
    })
    log.info({ reason: input.reason, source: input.source }, 'suppression escalated to scope=all')
    return true
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'suppress() failed')
    return false
  }
}

/**
 * Remove a PROMOTIONAL suppression (a genuine resubscribe).
 *
 * Deliberately refuses to lift a scope 'all' block: a hard bounce or spam
 * complaint is not something a customer can click their way out of, and
 * re-mailing a complaining address is how a sending domain gets blocklisted.
 * Those require an explicit admin action with a recorded reason.
 *
 * Returns 'removed' | 'not_suppressed' | 'refused_hard_suppression' | 'failed'.
 */
export async function resubscribe(
  email: string
): Promise<'removed' | 'not_suppressed' | 'refused_hard_suppression' | 'failed'> {
  const normalized = normalizeEmail(email)
  if (!normalized) return 'failed'

  try {
    const existing = await prisma.emailSuppression.findUnique({ where: { email: normalized } })
    if (!existing) return 'not_suppressed'
    if (existing.scope === 'all') return 'refused_hard_suppression'

    await prisma.emailSuppression.delete({ where: { email: normalized } })
    log.info('promotional suppression removed (resubscribe)')
    return 'removed'
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'resubscribe() failed')
    return 'failed'
  }
}

/**
 * Record an email unsubscribe. Also mirrors onto Customer.marketingOptOut so the
 * existing SMS/follow-up guards (which read that flag) agree with the new list —
 * one opt-out, honoured by every path, in both directions.
 */
export async function unsubscribeEmail(email: string, source = 'unsubscribe-link'): Promise<boolean> {
  const normalized = normalizeEmail(email)
  if (!normalized) return false

  const created = await suppress({ email: normalized, reason: 'UNSUBSCRIBED', source })

  await prisma.customer
    .updateMany({ where: { email: normalized }, data: { marketingOptOut: true } })
    .catch((err) => log.warn({ err: String(err) }, 'mirror to Customer.marketingOptOut failed (non-fatal)'))

  return created
}
