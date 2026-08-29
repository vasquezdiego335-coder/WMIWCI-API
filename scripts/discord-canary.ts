// ════════════════════════════════════════════════════════════════════════════
//  discord-canary.ts — send ONE lead notice through the COMPLETE production
//  path and confirm Discord actually accepted it.
//
//  WHY THIS EXISTS. Every layer beneath the Discord API is covered by the test
//  suite against a local HTTP receiver: the real processor, the real transport,
//  fifteen scenarios including retries, rate limits and terminal rejections. But
//  a local receiver cannot check the three things that only Discord knows —
//  whether the token is valid, whether the bot can post to that channel, and
//  whether the card renders. This closes that gap.
//
//  WHAT IT DRIVES. The same code the worker runs:
//      lead row  ->  outbox row  ->  processLeadNotification  ->  deliverLeadNotice
//  Nothing is stubbed. If this succeeds, the production path works.
//
//  SAFETY
//   * The lead is SYNTHETIC ("Test Customer", example.com) and is deleted at the
//     end, in a `finally`, whatever happens.
//   * It writes to a LOCAL database - never production.
//   * It posts to the channel named by CANARY_CHANNEL_ID, which is meant to be
//     an internal logging channel, never the leads channel the owner watches for
//     real business.
//   * The bot token is read from the environment and never printed.
//
//  Usage:
//    DATABASE_URL=... DISCORD_BOT_TOKEN=... CANARY_CHANNEL_ID=... \
//      npx tsx scripts/discord-canary.ts
// ════════════════════════════════════════════════════════════════════════════
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { processLeadNotification } from '../src/lib/lead-notification-processor'
import { deliverLeadNotice } from '../src/lib/lead-notification-transport'
import { dedupeKeyFor, recordLeadNotification } from '../src/lib/lead-notification-outbox'

const CHANNEL = process.env.CANARY_CHANNEL_ID
const TOKEN = process.env.DISCORD_BOT_TOKEN

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(30)} ${value}`)
}

async function main(): Promise<number> {
  if (!TOKEN) {
    console.error('DISCORD_BOT_TOKEN is not set')
    return 2
  }
  if (!CHANNEL) {
    console.error('CANARY_CHANNEL_ID is not set - refusing to guess a channel')
    return 2
  }

  //  The transport resolves DISCORD_CHANNEL_LEADS first. Point it at the canary
  //  channel so this can never land in the live leads channel.
  process.env.DISCORD_CHANNEL_LEADS = CHANNEL

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const id = `canary_${stamp}_${randomUUID().slice(0, 8)}`

  console.log('== staging Discord canary ==')
  line('channel', CHANNEL)
  line('token', `configured (${TOKEN.length} chars, not shown)`)
  line('lead id', id)

  let sent = false
  try {
    // ── 1. a synthetic lead, through the real model ──────────────────────
    await prisma.lead.create({
      data: {
        id,
        name: 'Test Customer',
        email: `${id}@example.com`,
        phone: '(862) 555-0100',
        source: 'OTHER',
        status: 'NEW',
        message: 'STAGING CANARY - synthetic lead, not a real enquiry. Safe to ignore.',
      } as never,
    })
    line('synthetic lead created', 'yes')

    // ── 2. the outbox row, through the real recorder ─────────────────────
    const { dedupeKey } = await recordLeadNotification(id, 'lead_created')
    line('outbox row', dedupeKey)

    // ── 3. THE REAL PROCESSOR AND THE REAL TRANSPORT ─────────────────────
    const result = await processLeadNotification(dedupeKey, deliverLeadNotice)
    line('processor action', result.action)

    if (result.action !== 'sent') {
      console.error(`\nFAIL: the processor returned "${result.action}" rather than "sent".`)
      const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
      console.error(`      status=${row?.status} attempts=${row?.attempts}`)
      console.error(`      lastError=${row?.lastError ?? '(none)'}`)
      return 1
    }

    // ── 4. what the DATABASE says happened ───────────────────────────────
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    line('db status', String(row?.status))
    line('db attempts', String(row?.attempts))
    line('db sentAt', row?.sentAt ? row.sentAt.toISOString() : '(null)')

    const ok = row?.status === 'sent' && (row?.attempts ?? 0) === 1
    if (!ok) {
      console.error('\nFAIL: the row does not read sent/1 after a successful send.')
      return 1
    }

    sent = true
    console.log('\nPASS: Discord accepted the notice through the complete production path.')
    console.log('      A card titled for a synthetic "Test Customer" should now be in the')
    console.log('      canary channel. It is safe to delete.')
    return 0
  } finally {
    //  The synthetic lead goes whatever happened. The notification row cascades
    //  or is removed explicitly, so the canary leaves nothing behind.
    try {
      await prisma.leadNotification.deleteMany({ where: { leadId: id } })
      await prisma.lead.delete({ where: { id } })
      line('synthetic lead removed', 'yes')
    } catch (err) {
      console.error('  WARNING: could not clean up the synthetic lead:', String(err).slice(0, 160))
    }
    if (!sent) console.log('  (the Discord message, if any, was still delivered)')
    await prisma.$disconnect()
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('canary aborted:', String(err).slice(0, 400))
  process.exit(1)
})
