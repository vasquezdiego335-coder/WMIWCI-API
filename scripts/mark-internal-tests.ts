// ════════════════════════════════════════════════════════════════════════
//  mark-internal-tests.ts — flag the owner's checkout-test PaymentIntents as
//  internal tests, in Stripe (metadata + description) AND the local DB
//  (payments.is_internal_test + metadata), so revenue reporting excludes them.
//
//  SAFETY CONTRACT (owner spec 2026-07-12):
//    • DRY-RUN by default — pass --apply to write.
//    • Each PI is retrieved and VERIFIED (exact id + exact amount) first;
//      any mismatch = skipped with a loud warning, never guessed.
//    • Idempotent: already-marked PIs are skipped.
//    • ONLY metadata + description are touched. Never status, capture, refund,
//      cancel, or delete. Secrets are read from env and never printed.
//
//  Run:  npx tsx scripts/mark-internal-tests.ts           (dry run)
//        npx tsx scripts/mark-internal-tests.ts --apply   (write)
// ════════════════════════════════════════════════════════════════════════
import Stripe from 'stripe'
import { prisma } from '../src/lib/db'

// Full IDs recovered from the production payments table and matched against the
// owner's list (amount + date + prefix all agree).
const TARGETS: { id: string; amountCents: number; note: string }[] = [
  { id: 'pi_3TrhQCGYEusZjJ0W3o24Xwiz', amountCents: 100, note: '$1.00 — Jul 10, 2026' },
  { id: 'pi_3ThbGKGeaKwP2tbN1BQAVHf9', amountCents: 4900, note: '$49.00 — Jun 12, 2026' },
  { id: 'pi_3ThbIxGeaKwP2tbN1ivXjvFc', amountCents: 4900, note: '$49.00 — Jun 12, 2026' },
]

const META = { internal_test: 'true', tested_by: 'Diego', reason: 'Checkout flow testing' }
const DESC_TAG = '[INTERNAL TEST — not customer revenue]'

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY not set')
  const stripe = new Stripe(key, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion })

  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

  for (const t of TARGETS) {
    let pi: Stripe.PaymentIntent
    try {
      pi = await stripe.paymentIntents.retrieve(t.id)
    } catch {
      console.log(`✗ ${t.id} — NOT FOUND in this Stripe account, skipped`)
      continue
    }
    // ── Identity verification: exact id + exact amount, or we refuse. ──
    if (pi.id !== t.id || pi.amount !== t.amountCents) {
      console.log(`✗ ${t.id} — VERIFICATION FAILED (amount ${pi.amount} != ${t.amountCents}), skipped`)
      continue
    }
    const already = pi.metadata?.internal_test === 'true'
    console.log(`✓ ${t.id} (${t.note}) — verified: $${(pi.amount / 100).toFixed(2)} ${pi.status}${already ? ' [already marked]' : ''}`)

    if (already) continue
    if (!apply) {
      console.log(`  would set metadata ${JSON.stringify(META)} + description tag`)
      continue
    }
    const description = pi.description ? `${pi.description} ${DESC_TAG}` : DESC_TAG
    await stripe.paymentIntents.update(t.id, { metadata: { ...pi.metadata, ...META }, description })
    console.log('  → Stripe updated (metadata + description only)')
  }

  // ── Local DB backfill (idempotent; requires the is_internal_test column) ──
  const ids = TARGETS.map((t) => t.id)
  if (apply) {
    const res = await prisma.payment.updateMany({
      where: { stripePaymentIntentId: { in: ids } },
      data: { isInternalTest: true },
    })
    for (const id of ids) {
      await prisma.payment.update({
        where: { stripePaymentIntentId: id },
        data: { metadata: META },
      }).catch(() => console.log(`  (no local Payment row for ${id})`))
    }
    console.log(`\nLocal DB: ${res.count} payment row(s) flagged is_internal_test=true`)
  } else {
    const rows = await prisma.payment.findMany({ where: { stripePaymentIntentId: { in: ids } }, select: { stripePaymentIntentId: true, amount: true, isInternalTest: true } })
    console.log(`\nLocal DB rows that would be flagged: ${rows.map((r) => `${r.stripePaymentIntentId} ($${(r.amount / 100).toFixed(2)}, currently ${r.isInternalTest})`).join('; ')}`)
  }
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
