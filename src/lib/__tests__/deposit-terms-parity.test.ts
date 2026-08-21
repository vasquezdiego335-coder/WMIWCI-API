// ════════════════════════════════════════════════════════════════════════════
//  deposit-terms-parity.test.ts — the deposit page, this app's Terms page, and
//  the PUBLISHED Terms must state one policy.
//  ------------------------------------------------------------------------
//  WHY THIS EXISTS. Until 2026-08-20 there were two Terms of Service documents
//  saying different things, and the deposit page summarised the one customers
//  could not reach:
//
//    · app/terms/page.tsx (this repo)   72 hours' notice; cancellation fee
//                                        equal to 2 hours of labor
//    · WMIWCI-SITE/public/terms         48 hours' notice; one free reschedule
//      (the PUBLISHED document)          within 90 days; the $49 hold is
//                                        forfeited and NO additional charge
//
//  `/terms` is a root-relative link. On moveitclearit.com only /deposit,
//  /api/deposit and /_next are rewritten to this app, so a customer tapping the
//  link from the deposit page lands on the MARKETING SITE's document. The
//  deposit page was therefore printing a cancellation fee directly above a link
//  to the document saying no such fee applies.
//
//  The published document is the one customers agreed to, so it is the truth and
//  the other two were corrected to it (owner decision). This test is what stops
//  them drifting apart again.
//
//  The marketing site is a SEPARATE repository. When it is not checked out beside
//  this one, the assertions that read it SKIP rather than fail — a red here would
//  otherwise be about a developer's folder layout, not about the policy. The
//  in-repo assertions always run.
// ════════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { COPY, LANGS } from '../deposit-copy'

const ROOT = resolve(__dirname, '../../..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** Tags stripped, entities folded, whitespace collapsed — compare PROSE. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&apos;|&#39;|&rsquo;|’/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;|—/g, '-')
    .replace(/\s+/g, ' ')
}

const APP_TERMS = plain(read('app/terms/page.tsx'))

// The marketing site, when it is checked out beside this repo.
const SITE_DIR = process.env.WMIWCI_SITE_DIR ?? 'C:\\WMIWCI-SITE'
const sitePath = resolve(SITE_DIR, 'public/terms/index.html')
const siteAvailable = existsSync(sitePath)
const SITE_TERMS = siteAvailable ? plain(readFileSync(sitePath, 'utf8')) : ''

// ── THE POLICY, as published ────────────────────────────────────────────────

test("this app's Terms state the PUBLISHED notice period, not the retired one", () => {
  assert.match(APP_TERMS, /at least 48 hours' notice/i)
  assert.match(APP_TERMS, /reschedule once within 90 days at no extra cost/i)
  assert.ok(
    !/at least 72 hours/i.test(APP_TERMS),
    'app/terms still carries the retired 72-hour notice period'
  )
})

test("this app's Terms do not invent a cancellation fee", () => {
  assert.match(APP_TERMS, /no additional charge applies/i)
  assert.ok(
    !/cancellation fee equal to 2 hours of labor/i.test(APP_TERMS),
    'app/terms still carries the retired 2-hours-of-labor cancellation fee'
  )
})

test('the deposit page summary agrees with this app\'s Terms', () => {
  // The page is a SUMMARY, so it is checked on the facts a customer acts on:
  // the notice period, the free reschedule, and that nothing extra is charged.
  for (const claim of [/48 hours/, /90 days/, /no additional charge/i]) {
    assert.match(COPY.en.policyBody, claim, `the deposit page must state ${claim}`)
    assert.match(APP_TERMS, claim, `the Terms must state ${claim}`)
  }
})

test('the deposit page makes no claim in EITHER language that the Terms do not', () => {
  for (const lang of LANGS) {
    const body = COPY[lang].policyBody
    assert.ok(!/\b72\b/.test(body), `${lang} states a 72-hour notice the Terms do not`)
    assert.ok(
      !/hours? of labor|horas de mano de obra/i.test(body),
      `${lang} states a labor-hours fee the Terms do not`
    )
    assert.ok(!/\$\s?\d/.test(body), `${lang} states a price; the Terms name the figure in context`)
  }
})

// ── Against the document a customer actually opens ──────────────────────────

test(
  'the PUBLISHED Terms carry the same policy',
  { skip: siteAvailable ? false : `marketing site not checked out at ${SITE_DIR}` },
  () => {
    assert.match(SITE_TERMS, /at least 48 hours' notice/i)
    assert.match(SITE_TERMS, /reschedule once within 90 days at no extra cost/i)
    assert.match(SITE_TERMS, /no additional charge applies/i)
  }
)

test(
  'the PUBLISHED Terms and this app\'s Terms do not contradict each other',
  { skip: siteAvailable ? false : `marketing site not checked out at ${SITE_DIR}` },
  () => {
    // Whatever else the two documents say, they may not disagree on the two
    // numbers a customer plans around.
    const notice = (t: string) => t.match(/at least (\d+) hours' notice/i)?.[1]
    const window_ = (t: string) => t.match(/within (\d+) days at no extra cost/i)?.[1]

    assert.equal(notice(APP_TERMS), notice(SITE_TERMS), 'the notice periods disagree')
    assert.equal(window_(APP_TERMS), window_(SITE_TERMS), 'the reschedule windows disagree')
    assert.equal(notice(APP_TERMS), '48')
    assert.equal(window_(APP_TERMS), '90')
  }
)

test(
  'the PUBLISHED Terms say the same in Spanish',
  { skip: siteAvailable ? false : `marketing site not checked out at ${SITE_DIR}` },
  () => {
    // The marketing site carries its translation in data-es attributes; a policy
    // that changed a number in translation would be a second, unagreed policy.
    const raw = readFileSync(sitePath, 'utf8')
    assert.match(raw, /48 horas de aviso/i)
    assert.match(raw, /90 d[ií]as sin costo adicional/i)
    assert.match(raw, /ning[uú]n cargo adicional/i)
  }
)

// ── The self-service reschedule threshold matches the published notice ──────

test('the self-service reschedule gate is not stricter than the Terms (48h)', () => {
  // The Terms promise "at least 48 hours' notice". The customer self-service
  // portal must not refuse a customer who is within that promise: it was 72h,
  // which turned a 60-hour-notice reschedule the Terms allow into a 422.
  const scheduling = read('src/lib/scheduling.ts')
  assert.match(
    scheduling,
    /export const RESCHEDULE_MIN_NOTICE_HOURS\s*=\s*48\b/,
    'the shared reschedule-notice constant must be 48 hours',
  )

  // Both routes must use the shared constant, and neither may hardcode 72 again.
  const patch = read('app/api/customer/booking/[token]/route.ts')
  const slots = read('app/api/customer/booking/[token]/slots/route.ts')
  for (const [name, src] of [['route', patch], ['slots', slots]] as const) {
    assert.match(src, /RESCHEDULE_MIN_NOTICE_HOURS/, `${name} must use the shared constant`)
    assert.ok(!/\b72\b/.test(src), `${name} must not reference the retired 72-hour threshold`)
  }
})
