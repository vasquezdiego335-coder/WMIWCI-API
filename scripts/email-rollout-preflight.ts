// ════════════════════════════════════════════════════════════════════════
//  EMAIL ROLLOUT PREFLIGHT  (owner spec 2026-08-06)
//    npx tsx scripts/email-rollout-preflight.ts
//  ---------------------------------------------------------------------
//  Answers ONE question, against the real database, before a journey flag is
//  ever turned on: IF I FLIP THE SWITCH RIGHT NOW, WHO GETS EMAIL?
//
//  Reading a matrix tells you the rules. This tells you the numbers — how many
//  real people are on the other side of them, which configuration is missing,
//  and how wide the canary currently is.
//
//  STRICTLY READ-ONLY. It opens no queue, enqueues nothing, sends nothing, and
//  writes nothing. Every query below is a `count` or a `findMany` with a
//  `select`. That is not a convention you should relax: a preflight that can
//  change state is a preflight nobody dares to run.
//
//  It also never prints an email address. The counts are the useful part, and
//  a rollout report that fills a terminal with customer addresses is a report
//  that ends up pasted into a chat window.
// ════════════════════════════════════════════════════════════════════════
import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { rolloutAllowlist, inRolloutAllowlist, CAPS } from '../src/lib/email-guard'
import { buildMarketingContext } from '../src/lib/marketing-context'
import { isSafeUrl } from '../src/emails/validation'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const OFF = '\x1b[0m'

const ok = (s: string) => `${GREEN}✓${OFF} ${s}`
const bad = (s: string) => `${RED}✗${OFF} ${s}`
const warn = (s: string) => `${YELLOW}!${OFF} ${s}`
const head = (s: string) => `\n${BOLD}${s}${OFF}\n${DIM}${'─'.repeat(s.length)}${OFF}`

const flag = (name: string) => process.env[name] === 'true'
const OPEN_STATUSES = ['NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP'] as const

/** True when a problem was found that should stop a rollout. */
let blockers = 0
const blocker = (s: string) => {
  blockers++
  return bad(s)
}

async function main() {
  console.log(`${BOLD}Email rollout preflight${OFF} ${DIM}(read-only)${OFF}`)
  console.log(
    `${YELLOW}READ THIS FIRST.${OFF} Sections 1–3 describe ${BOLD}the environment this command is\n` +
      `running in${OFF} — your laptop, unless you ran it on the server. Sections 4–8 describe\n` +
      `${BOLD}the database${OFF}, which is shared, so those numbers are real either way.\n` +
      `${DIM}A green section 3 on a laptop proves nothing about Railway. Run it there too:${OFF}\n` +
      `${DIM}  railway run --service <api> npx tsx scripts/email-rollout-preflight.ts${OFF}`
  )

  // ── 1. THE SWITCHES ───────────────────────────────────────────────────
  console.log(head('1. Switches, as THIS process sees them'))
  const journeys = flag('EMAIL_JOURNEYS_ENABLED')
  const followups = flag('MARKETING_FOLLOWUPS_ENABLED')
  const killed = process.env.EMAIL_SENDING_ENABLED === 'false'

  console.log(`   EMAIL_JOURNEYS_ENABLED       ${journeys ? `${GREEN}on${OFF}` : `${DIM}off${OFF}`}   (quote follow-up, lead nurture, abandoned recovery, move reminders)`)
  console.log(`   MARKETING_FOLLOWUPS_ENABLED  ${followups ? `${GREEN}on${OFF}` : `${DIM}off${OFF}`}   (review, referral, repeat)`)
  console.log(`   EMAIL_SENDING_ENABLED        ${killed ? `${RED}FALSE — every email is held${OFF}` : `${DIM}unset (normal)${OFF}`}`)
  for (const j of ['QUOTE', 'LEAD_NURTURE', 'ABANDONED', 'REMINDERS', 'BALANCE']) {
    const k = `EMAIL_JOURNEY_${j}_DISABLED`
    if (process.env[k] === 'true') console.log(`   ${DIM}${k}=true → that journey stays off${OFF}`)
  }

  // ── 2. THE CANARY ─────────────────────────────────────────────────────
  console.log(head('2. Rollout allowlist'))
  const allowlist = rolloutAllowlist()
  if (allowlist === null) {
    console.log(
      warn(
        'EMAIL_PROMOTIONAL_ALLOWLIST is unset — NO RESTRICTION. Every eligible\n' +
          '     person receives promotional mail the moment a journey flag is on.'
      )
    )
  } else {
    console.log(ok(`${allowlist.length} entr${allowlist.length === 1 ? 'y' : 'ies'} — promotional mail reaches ONLY these:`))
    for (const e of allowlist) console.log(`     ${e}`)
  }

  // ── 3. CONFIGURATION THAT BLOCKS PROMOTIONAL SENDS ────────────────────
  console.log(head('3. Configuration a promotional send requires'))
  const ctx = buildMarketingContext('preflight@example.com', 'lead-nurture-1', 'en')
  if (ctx.ok) console.log(ok('marketing context complete (unsubscribe link + postal address + reason)'))
  else console.log(blocker(`marketing context INCOMPLETE — every promotional send is blocked. Missing: ${ctx.missing.join(', ')}`))

  const review = process.env.GOOGLE_REVIEW_URL?.trim() ?? ''
  if (isSafeUrl(review)) console.log(ok('GOOGLE_REVIEW_URL is a usable destination'))
  else console.log(followups ? blocker('GOOGLE_REVIEW_URL missing/unsafe — review requests will NOT queue') : warn('GOOGLE_REVIEW_URL missing/unsafe — needed before MARKETING_FOLLOWUPS_ENABLED'))

  for (const k of ['EMAIL_TOKEN_SECRET', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'APP_URL', 'MARKETING_SITE_URL']) {
    console.log(process.env[k]?.trim() ? ok(`${k} set`) : blocker(`${k} MISSING`))
  }
  console.log(`   ${DIM}caps: ${CAPS.perDay}/day · ${CAPS.perWeek}/week · ${CAPS.perMonth}/month · quiet ${CAPS.quietStartHour}:00–${CAPS.quietEndHour}:00 ET${OFF}`)

  // ── 4. WHO IS ON THE OTHER SIDE OF THE SWITCH ─────────────────────────
  console.log(head('4. The audience, right now'))
  const [leadTrue, leadFalse, leadNull, custTrue, custFalse, custNull, suppressed] = await Promise.all([
    prisma.lead.count({ where: { emailMarketingConsent: true } }),
    prisma.lead.count({ where: { emailMarketingConsent: false } }),
    prisma.lead.count({ where: { emailMarketingConsent: null } }),
    prisma.customer.count({ where: { emailMarketingConsent: true } }),
    prisma.customer.count({ where: { emailMarketingConsent: false } }),
    prisma.customer.count({ where: { emailMarketingConsent: null } }),
    prisma.emailSuppression.count(),
  ])
  console.log(`   leads     opted in ${BOLD}${leadTrue}${OFF} · declined ${leadFalse} · never asked ${leadNull}`)
  console.log(`   customers opted in ${BOLD}${custTrue}${OFF} · declined ${custFalse} · never asked ${custNull}`)
  console.log(`   suppressed addresses ${suppressed}`)
  console.log(
    `   ${DIM}"never asked" is the historical population. Nothing enrols them — no backfill,${OFF}\n` +
      `   ${DIM}no retroactive send. They become reachable only by opting in on a form.${OFF}`
  )

  // ── 5. WHAT WOULD ENROL FROM A LIVE CAPTURE ───────────────────────────
  console.log(head('5. Would be eligible on the next capture'))
  const eligibleQuote = await prisma.lead.count({
    where: {
      emailMarketingConsent: true,
      email: { not: null },
      quotedAt: { not: null },
      bookedAt: null,
      lostAt: null,
      convertedBookingId: null,
      status: { in: [...OPEN_STATUSES] },
    },
  })
  const eligibleNurture = await prisma.lead.count({
    where: {
      emailMarketingConsent: true,
      email: { not: null },
      quotedAt: null,
      bookedAt: null,
      lostAt: null,
      convertedBookingId: null,
      status: { in: [...OPEN_STATUSES] },
    },
  })
  console.log(`   quote follow-up (Sequence A)  ${BOLD}${eligibleQuote}${OFF} open quoted lead(s)`)
  console.log(`   lead nurture   (Sequence B)  ${BOLD}${eligibleNurture}${OFF} open unquoted lead(s)`)
  console.log(
    `   ${DIM}These are NOT enrolled by turning the flag on. Both sequences are anchored${OFF}\n` +
      `   ${DIM}to a live event (a quote being recorded, a lead being captured), so existing${OFF}\n` +
      `   ${DIM}rows stay untouched until that person acts again.${OFF}`
  )

  // ── 6. HOW MANY OF THOSE THE CANARY WOULD ACTUALLY REACH ──────────────
  if (allowlist !== null) {
    console.log(head('6. Of those, inside the canary'))
    const consented = await prisma.lead.findMany({
      where: { emailMarketingConsent: true, email: { not: null } },
      select: { email: true },
      take: 5000,
    })
    const inside = consented.filter((l) => inRolloutAllowlist(l.email ?? '', allowlist)).length
    console.log(`   ${BOLD}${inside}${OFF} of ${consented.length} opted-in lead address(es) are inside the allowlist`)
    if (inside === 0) console.log(warn('nobody matches — a canary that reaches no one proves nothing. Add your own address.'))
  }

  // ── 7. WHAT THE LEDGER ALREADY SHOWS ──────────────────────────────────
  console.log(head('7. Recent send ledger (last 7 days)'))
  const since = new Date(Date.now() - 7 * 24 * 3_600_000)
  const recent = await prisma.emailSend.groupBy({
    by: ['status', 'emailClass'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  })
  if (recent.length === 0) console.log(`   ${DIM}no sends recorded${OFF}`)
  for (const r of recent.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`   ${String(r._count._all).padStart(5)}  ${r.emailClass.padEnd(14)} ${r.status}`)
  }
  const blockedReasons = await prisma.emailSend.groupBy({
    by: ['blockedReason'],
    where: { createdAt: { gte: since }, blockedReason: { not: null } },
    _count: { _all: true },
  })
  if (blockedReasons.length > 0) {
    console.log(`\n   ${DIM}why sends were refused:${OFF}`)
    for (const r of blockedReasons.sort((a, b) => b._count._all - a._count._all)) {
      console.log(`   ${String(r._count._all).padStart(5)}  ${r.blockedReason}`)
    }
  }

  // ── 8. STUCK STATE WORTH CLEARING FIRST ───────────────────────────────
  console.log(head('8. Anything to clear before turning a flag on'))
  const [ambiguous, deadLetter, stale] = await Promise.all([
    prisma.emailSend.count({ where: { status: 'ambiguous' } }),
    prisma.emailEvent.count({ where: { processingStatus: 'dead_letter' } }),
    prisma.emailSend.count({ where: { status: 'sending', updatedAt: { lt: new Date(Date.now() - 30 * 60_000) } } }),
  ])
  console.log(ambiguous === 0 ? ok('no ambiguous sends awaiting reconciliation') : warn(`${ambiguous} ambiguous send(s) — reconcile against the Resend dashboard first`))
  console.log(
    deadLetter === 0
      ? ok('no dead-lettered bounce/complaint events')
      : blocker(`${deadLetter} bounce/complaint event(s) exhausted every suppression retry — those addresses are STILL SENDABLE`)
  )
  console.log(stale === 0 ? ok('no stale in-flight claims') : warn(`${stale} send(s) stuck mid-attempt for over 30 minutes`))

  // ── VERDICT ───────────────────────────────────────────────────────────
  console.log(head('Verdict'))
  if (blockers > 0) {
    console.log(bad(`${blockers} blocker(s). Fix these before enabling any journey.`))
    process.exitCode = 1
  } else if (allowlist === null && (journeys || followups)) {
    console.log(
      warn(
        'No blockers — but a journey is ON with no allowlist, so promotional mail\n' +
          '     reaches every eligible person. That is a full launch, not a canary.'
      )
    )
  } else {
    console.log(ok('No blockers.'))
  }
  console.log(`${DIM}Runbook: docs/email-marketing/controlled-rollout.md${OFF}\n`)
}

main()
  .catch((err) => {
    console.error(`${RED}preflight failed:${OFF}`, err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
