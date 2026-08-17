#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  deposit-preflight.mjs — READ-ONLY release check for the deposit-link feature.
//  ------------------------------------------------------------------------
//  Run this BEFORE `prisma migrate deploy` and again AFTER deploying, against
//  whichever environment you are about to touch.
//
//  IT WRITES NOTHING. No migration, no Stripe call, no Discord post, no row.
//  Everything below is a read or a presence check, so it is safe to run against
//  production at any moment, including mid-incident.
//
//    node scripts/deposit-preflight.mjs
//
//  Exit code 0 = ready. 1 = something needs attention (details printed).
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs'

const problems = []
const warnings = []
const ok = []

const has = (v) => !!v && !['REPLACE_ME', 'placeholder', ''].includes(v.trim())
const env = (k) => process.env[k]?.trim()

// ── 1. Environment ──────────────────────────────────────────────────────────
function checkEnv() {
  if (has(env('DATABASE_URL'))) ok.push('DATABASE_URL set')
  else problems.push('DATABASE_URL is not set — migrations and the app cannot run')

  const stripe = env('STRIPE_SECRET_KEY')
  if (!has(stripe)) problems.push('STRIPE_SECRET_KEY is not set — no deposit can be taken')
  else if (stripe.startsWith('sk_live_')) ok.push('Stripe is in LIVE mode (real money)')
  else if (stripe.startsWith('sk_test_')) warnings.push('Stripe is in TEST mode — deposits will NOT take real money')
  else problems.push('STRIPE_SECRET_KEY does not look like a Stripe secret key')

  if (has(env('STRIPE_WEBHOOK_SECRET'))) ok.push('STRIPE_WEBHOOK_SECRET set')
  else problems.push('STRIPE_WEBHOOK_SECRET is not set — the webhook cannot be verified, so NO payment would ever be confirmed')

  // Discord: not required for a payment to work, but the owner must know.
  const webhook = env('DISCORD_PAYMENTS_WEBHOOK_URL')
  const bot = env('DISCORD_BOT_TOKEN')
  const channel = env('DISCORD_PAYMENTS_CHANNEL_ID') || '1524853745064869990'
  if (has(webhook)) ok.push(`Discord notifications: webhook transport (channel is chosen by the URL)`)
  else if (has(bot)) ok.push(`Discord notifications: bot transport -> channel ${channel}`)
  else warnings.push('Discord notifications are NOT configured. Payments still work and are still recorded, but nobody is told. Set DISCORD_PAYMENTS_WEBHOOK_URL or DISCORD_BOT_TOKEN.')

  const base = env('DEPOSIT_LINK_BASE_URL')
  const app = env('APP_URL')
  if (has(base)) {
    ok.push(`Deposit links will be built on ${base}`)
    warnings.push(`Confirm ${base}/deposit/<token> actually reaches this app before handing a link to a customer.`)
  } else if (has(app)) {
    ok.push(`Deposit links will be built on APP_URL (${app}) — correct until a proxy exists`)
  } else {
    problems.push('Neither DEPOSIT_LINK_BASE_URL nor APP_URL is set — generated links would be unusable')
  }
}

// ── 2. The social card must be reachable ────────────────────────────────────
function checkCard() {
  const path = 'public/assets/social/move-it-clear-it-deposit-v1.jpg'
  if (!existsSync(path)) {
    problems.push(`${path} is missing — every deposit link would unfurl as a grey box`)
    return
  }
  const buf = readFileSync(path)
  // Minimal JPEG frame-header read, so this needs no image library.
  let w = 0, h = 0, i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const m = buf[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  if (w === 1200 && h === 630) ok.push(`social card present and ${w}x${h} (${Math.round(buf.length / 1024)}KB)`)
  else problems.push(`social card is ${w}x${h}, expected 1200x630`)
}

// ── 3. The migration must be present and additive ───────────────────────────
function checkMigration() {
  const path = 'prisma/migrations/20260815120000_deposit_links/migration.sql'
  if (!existsSync(path)) { problems.push(`${path} is missing`); return }
  const sql = readFileSync(path, 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  if (/\bDROP\b/i.test(sql)) problems.push('the deposit migration contains a DROP — it must be additive only')
  else if (/\bUPDATE\s+"?\w+"?\s+SET\b/i.test(sql)) problems.push('the deposit migration back-fills data — it must be additive only')
  else ok.push('deposit migration is additive (no DROP, no back-fill)')
}

checkEnv()
checkCard()
checkMigration()

const line = '─'.repeat(72)
console.log(`\n${line}\n  DEPOSIT-LINK PREFLIGHT  (read-only)\n${line}`)
for (const o of ok) console.log(`  [ OK ]   ${o}`)
for (const w of warnings) console.log(`  [WARN]   ${w}`)
for (const p of problems) console.log(`  [FAIL]   ${p}`)
console.log(line)

if (problems.length) {
  console.log(`  ${problems.length} problem(s) must be resolved before release.\n`)
  process.exit(1)
}
console.log(`  Ready.${warnings.length ? ` ${warnings.length} warning(s) above — read them.` : ''}\n`)
