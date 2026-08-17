// ════════════════════════════════════════════════════════════════════════════
//  discord-payments.ts — orchestration for the confirmed-deposit notification.
//  ------------------------------------------------------------------------
//  The CARD and the TRANSPORT live in deposit-notify.ts (no prisma, no queues,
//  testable offline). This file is the half that genuinely needs the database:
//  claiming a row so exactly one message is sent, and recording the outcome.
//
//  Everything deposit-notify.ts exports is re-exported below, so a caller only
//  ever needs one import path and the split stays an implementation detail.
// ════════════════════════════════════════════════════════════════════════════
import { prisma } from './db'
import { botLogger } from './logger'
import { discordQueue } from './queues'
import {
  buildDepositPaidEmbed,
  sendPaymentEmbed,
  scrub,
} from './deposit-notify'

export {
  DEFAULT_PAYMENTS_CHANNEL_ID,
  EMBED_COLOR,
  WEBHOOK_USERNAME,
  depositNotifyConfig,
  avatarUrl,
  buildDepositPaidEmbed,
  buildTestEmbed,
  sendPaymentEmbed,
  scrub,
  postWithRetry,
} from './deposit-notify'
export type { NotifyTransport, NotifyConfig, DepositPaidEmbedInput, EmbedJson, SendResult, SendDeps } from './deposit-notify'

const log = botLogger.child({ mod: 'discord-payments' })

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Queue the notification for a paid deposit.
 *
 * The row is already PENDING (written in the same transaction as the payment),
 * so this is an optimisation of when it goes out, not the record that it is
 * owed. If Redis is unreachable we deliver INLINE rather than leave the owner
 * uninformed — and if that fails too, the row stays PENDING/FAILED and the
 * admin list offers Retry.
 */
export async function queueDepositNotification(depositRequestId: string): Promise<void> {
  try {
    await Promise.race([
      discordQueue.add(
        'deposit-paid',
        { type: 'deposit-paid', payload: { depositRequestId } },
        // jobId dedupes at the queue level too: the same deposit can only ever
        // have one live job, whatever calls this.
        { jobId: `deposit-paid:${depositRequestId}`, removeOnComplete: { count: 200 }, removeOnFail: { count: 200 } }
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('queue add timed out after 5s')), 5000)),
    ])
  } catch (err) {
    log.warn(
      { depositRequestId, err: scrub(err instanceof Error ? err.message : String(err)) },
      'discord queue unavailable — delivering deposit notification inline'
    )
    await deliverDepositNotification(depositRequestId).catch((inner) =>
      log.error({ depositRequestId, err: scrub(inner instanceof Error ? inner.message : String(inner)) }, 'inline deposit notification failed')
    )
  }
}

export type DeliverResult = { delivered: boolean; skipped?: string; error?: string }

/**
 * Deliver ONE notification, at most once.
 *
 * `claimDiscordNotification` is the exactly-once lock. Every caller — the
 * worker, the inline fallback, a BullMQ retry, the admin Retry button — passes
 * through it, and a row that is already SENT (or in-flight) is skipped. That is
 * what makes duplicate Stripe events produce exactly one Discord message.
 */
export async function deliverDepositNotification(depositRequestId: string): Promise<DeliverResult> {
  const { claimDiscordNotification, recordDiscordSuccess, recordDiscordFailure } = await import('./deposit-service')

  const row = await prisma.depositRequest.findUnique({
    where: { id: depositRequestId },
    select: {
      id: true,
      customerName: true,
      amountPaidCents: true,
      amountCents: true,
      quoteTotalCents: true,
      balanceBeforeCents: true,
      moveDate: true,
      paidAt: true,
      livemode: true,
      discordStatus: true,
      bookingId: true,
      booking: { select: { bookingReference: true, displayId: true } },
    },
  })
  if (!row) return { delivered: false, skipped: 'deposit-not-found' }
  if (!row.paidAt) return { delivered: false, skipped: 'not-paid' }
  if (row.discordStatus === 'SENT') return { delivered: false, skipped: 'already-sent' }

  const claimed = await claimDiscordNotification(depositRequestId)
  if (!claimed) return { delivered: false, skipped: 'already-sent-or-in-flight' }

  const applied = row.amountPaidCents ?? row.amountCents
  const base = row.balanceBeforeCents ?? row.quoteTotalCents
  const remaining = base == null ? null : Math.max(0, base - applied)

  const appUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '')
  const adminUrl = appUrl ? (row.bookingId ? `${appUrl}/admin/bookings` : `${appUrl}/admin/deposit-links`) : null

  const embed = buildDepositPaidEmbed({
    customerName: row.customerName,
    amountPaidCents: applied,
    quoteTotalCents: row.quoteTotalCents,
    remainingCents: remaining,
    moveDate: row.moveDate,
    bookingReference: row.booking?.bookingReference ?? row.booking?.displayId ?? null,
    paidAt: row.paidAt,
    livemode: row.livemode,
    adminUrl,
  })

  const sent = await sendPaymentEmbed(embed)
  if (sent.delivered) {
    await recordDiscordSuccess(depositRequestId, sent.messageId)
    return { delivered: true }
  }
  await recordDiscordFailure(depositRequestId, scrub(sent.error ?? 'delivery failed'))
  return { delivered: false, error: sent.error }
}
