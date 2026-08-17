import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { depositOgImageUrl, depositUrl } from '../deposit-links'

// ════════════════════════════════════════════════════════════════════════════
//  Link previews: the tags, the images, and the crawler access that makes them
//  actually appear in Messenger and Discord.
//
//  Context that makes these tests worth having: this site once shipped an
//  og:image that 404'd for two months, and Facebook cached the imageless scrape
//  and served it long after the bytes were fixed. A 200 on the image proves
//  nothing on its own — the declared dimensions, the reachable crawler and the
//  versioned filename are all part of the same failure.
// ════════════════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '../../..')
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8')

const DEPOSIT_PAGE = 'app/deposit/[token]/page.tsx'
const DEPOSIT_IMAGE = 'public/assets/social/move-it-clear-it-deposit-v1.jpg'

// The marketing site is a SEPARATE repository. When it is not checked out
// beside this one these assertions SKIP rather than fail — a false red here
// would be about the developer's folder layout, not about the site.
const SITE_DIR = process.env.WMIWCI_SITE_DIR ?? 'C:\\WMIWCI-SITE'
const homepagePath = resolve(SITE_DIR, 'public/index.html')
const siteAvailable = existsSync(homepagePath)

// ── Deposit-page metadata ───────────────────────────────────────────────────

test('the deposit page is SERVER-rendered — a preview crawler runs no JS', () => {
  const src = read(DEPOSIT_PAGE)
  assert.ok(!src.includes("'use client'"), 'the page must be a server component')
  assert.match(src, /export async function generateMetadata/, 'tags must be produced server-side')
  // Never statically cached: a paid link must not serve a stale "pay now" page.
  assert.match(src, /export const dynamic = 'force-dynamic'/)
})

test('generateMetadata does NOT depend on the database', () => {
  // The tags must survive a DB blip: a preview that fails once gets CACHED as a
  // grey box by Facebook and Discord, and there is no way to ask them to retry.
  const src = read(DEPOSIT_PAGE)
  const fn = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('// ── Data'))
  assert.ok(!fn.includes('prisma'), 'metadata must not query the database')
  assert.ok(!fn.includes('await load'), 'metadata must not await a data load')
})

test('a database outage renders a page rather than losing the preview', () => {
  const src = read(DEPOSIT_PAGE)
  assert.match(src, /kind: 'unavailable'/)
  assert.match(read('app/deposit/[token]/DepositView.tsx'), /UnavailableState/)
  // And it must NOT tell a real customer their link is invalid.
  assert.match(read('src/lib/deposit-copy.ts'), /Your link is fine/)
})

test('the deposit page declares the full Open Graph set the spec requires', () => {
  const src = read(DEPOSIT_PAGE)
  assert.match(src, /title: 'Secure Your Move \| Move It Clear It'/)
  assert.match(src, /description: 'Review your quote and securely pay your booking deposit\.'/)
  assert.match(src, /siteName: 'Move It Clear It'/)
  assert.match(src, /type: 'website'/)
  assert.match(src, /alternates: \{ canonical: url \}/)
  assert.match(src, /width: 1200/)
  assert.match(src, /height: 630/)
  assert.match(src, /type: 'image\/jpeg'/)
  assert.match(src, /alt: 'Move It Clear It — secure online deposit payment'/)
  assert.match(src, /card: 'summary_large_image'/)
  // themeColor lives in generateViewport, not metadata. Next 14 ignores it in the
  // metadata export and warns on every request; asserting the export keeps the
  // brand colour from silently reverting to a no-op.
  assert.match(src, /export function generateViewport\(\): Viewport/)
  const vp = src.slice(src.indexOf('export function generateViewport'))
  assert.match(vp, /themeColor: ORANGE/)
  // The page must not zoom-lock — older customers pinch to read a price.
  assert.match(vp, /width: 'device-width'/)
  assert.ok(!/maximum-scale|user-scalable/.test(src), 'never disable pinch zoom on a payment page')
  // Scoped to generateMetadata ONLY. A file-wide scan also matches the
  // legitimate themeColor inside generateViewport, which is where it belongs.
  // Comment lines stripped: the explanation ABOVE generateViewport legitimately
  // contains the word themeColor, and prose must not fail a rule about code.
  const codeOnly = src
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  const meta = codeOnly.slice(
    codeOnly.indexOf('export async function generateMetadata'),
    codeOnly.indexOf('export function generateViewport')
  )
  assert.ok(!/themeColor/.test(meta), 'themeColor must NOT be in the metadata export — Next 14 ignores it and warns')
  assert.ok(!/'theme-color'/.test(meta), 'no other: theme-color fallback either — one source only')
  assert.match(src, /const ORANGE = '#FF5A1F'/)
})

test('deposit metadata is GENERIC — it can never leak a customer detail', () => {
  const src = read(DEPOSIT_PAGE)
  const fn = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('// ── Data'))
  // Messenger and Discord cache an unfurl per URL and serve it to anyone the
  // link is forwarded to. Nothing customer-specific may be in these tags.
  for (const leak of ['firstName', 'customerName', 'amountCents', 'quoteTotal', 'moveDate', 'bookingReference', 'serviceSummary', 'view.']) {
    assert.ok(!fn.includes(leak), `${leak} must never appear in social metadata`)
  }
  // The only per-link value in the tags is the canonical URL, which the
  // recipient already has.
  assert.match(fn, /const url = depositUrl\(params\.token\)/)
})

test('deposit pages are noindex — but crawlers are NOT blocked from them', () => {
  const src = read(DEPOSIT_PAGE)
  assert.match(src, /robots: \{ index: false, follow: false, noarchive: true \}/)

  // A `Disallow: /deposit` in robots.txt WOULD block Facebook and Discord, which
  // honour robots.txt, and kill every preview. The two mechanisms are not
  // interchangeable — meta robots keeps it out of search, robots.txt lets the
  // unfurl crawlers in.
  const robots = read('app/robots.ts')
  assert.match(robots, /allow: '\/deposit'/)
  const disallowLine = robots.slice(robots.indexOf('disallow:'), robots.indexOf('\n', robots.indexOf('disallow:')))
  assert.ok(!disallowLine.includes('/deposit'), 'robots.txt must not disallow /deposit')
  assert.match(disallowLine, /'\/admin'/, 'the admin surface IS disallowed')
  assert.match(disallowLine, /'\/api'/)

  // There is exactly ONE rule and it applies to every crawler, so no unfurl bot
  // can be singled out and blocked. (Naming a bot in a COMMENT is fine — this
  // asserts on the rules.)
  const userAgents = robots.match(/userAgent:\s*'([^']+)'/g) ?? []
  assert.deepEqual(userAgents, ["userAgent: '*'"], 'one rule, applying to all crawlers')

  // And nothing user-agent-sniffs in the request path.
  const mw = read('middleware.ts')
  for (const bot of ['Discordbot', 'facebookexternalhit', 'WhatsApp', 'Twitterbot', 'Slackbot', 'user-agent']) {
    assert.ok(!mw.toLowerCase().includes(bot.toLowerCase()), `${bot} must not be referenced by middleware`)
  }
})

test('middleware does not intercept the public deposit routes', () => {
  const mw = read('middleware.ts')
  const matcher = mw.slice(mw.indexOf('export const config'))
  assert.ok(!matcher.includes("'/deposit"), 'the public page must not be behind auth')
  assert.ok(!matcher.includes("'/api/deposit"), 'the public API must not be behind the admin CSRF gate')
})

test('the og:image URL is absolute, https and overridable', () => {
  const url = depositOgImageUrl({ APP_URL: 'https://app.example' } as never)
  assert.equal(url, 'https://app.example/assets/social/move-it-clear-it-deposit-v1.jpg')
  assert.match(url, /^https:\/\//, 'a relative og:image is ignored by every crawler')

  const override = depositOgImageUrl({ DEPOSIT_OG_IMAGE_URL: 'https://cdn.example/card-v2.jpg' } as never)
  assert.equal(override, 'https://cdn.example/card-v2.jpg')

  // Even with nothing configured it is still absolute, never a bare path.
  assert.match(depositOgImageUrl({} as never), /^https:\/\/\S+\.jpg$/)
})

test('the image filename is VERSIONED so a cached preview can be refreshed', () => {
  // Facebook caches per IMAGE URL as well as per page URL. Editing a card in
  // place leaves the stale bytes cached; a new filename is the only lever.
  assert.match(depositOgImageUrl({ APP_URL: 'https://x' } as never), /-v\d+\.jpg$/)
})

test('the deposit canonical URL matches the page it describes', () => {
  const url = depositUrl('ABCDEFGH1234', { DEPOSIT_LINK_BASE_URL: 'https://moveitclearit.com' } as never)
  assert.equal(url, 'https://moveitclearit.com/deposit/ABCDEFGH1234')
})

// ── The image files themselves ──────────────────────────────────────────────

/** Read enough of a JPEG/PNG header to get its real pixel dimensions. */
function imageSize(file: string): { w: number; h: number; type: 'jpeg' | 'png' } {
  const buf = readFileSync(file)
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' }
  }
  assert.equal(buf[0], 0xff, 'must be a JPEG or a PNG')
  assert.equal(buf[1], 0xd8, 'must be a JPEG or a PNG')
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), type: 'jpeg' }
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  throw new Error('no JPEG frame header found')
}

test('the deposit social image is a REAL 1200x630 JPEG, shipped with this app', () => {
  const file = resolve(ROOT, DEPOSIT_IMAGE)
  assert.ok(existsSync(file), `${DEPOSIT_IMAGE} must exist — the og:image points at it`)

  const { w, h, type } = imageSize(file)
  assert.equal(w, 1200, 'width must match the declared og:image:width')
  assert.equal(h, 630, 'height must match the declared og:image:height')
  assert.equal(type, 'jpeg')

  const bytes = statSync(file).size
  assert.ok(bytes > 20_000, 'suspiciously small — a placeholder, not a card')
  // Facebook and WhatsApp are documented to prefer images under ~8MB, and a
  // heavy card is slow to fetch on the mobile connection that will render it.
  assert.ok(bytes < 1_000_000, `card is ${Math.round(bytes / 1024)}KB — keep it small for mobile previews`)
})

test('the card is served from the app itself, so it deploys with the page', () => {
  // og:image defaults to ${APP_URL}/assets/social/... and the file lives in this
  // app's public/. If it only existed in the marketing-site repo, the preview
  // would 404 whenever the deposit page is served from the app host.
  const expectedPath = depositOgImageUrl({ APP_URL: 'https://app.example' } as never).replace('https://app.example/', '')
  assert.equal(expectedPath, 'assets/social/move-it-clear-it-deposit-v1.jpg')
  assert.ok(existsSync(resolve(ROOT, 'public', expectedPath)), 'the og:image path must resolve inside public/')
})

// ── Homepage (marketing site repo) ──────────────────────────────────────────

test('homepage Open Graph metadata is complete and correct', { skip: siteAvailable ? false : `marketing site not found at ${SITE_DIR}` }, () => {
  const html = readFileSync(homepagePath, 'utf8')
  const head = html.slice(0, html.indexOf('</head>'))

  const meta = (prop: string): string | null => {
    const m = new RegExp(`<meta\\s+(?:property|name)="${prop}"\\s+content="([^"]*)"`, 'i').exec(head)
    return m ? m[1] : null
  }

  assert.equal(meta('og:title'), 'Professional Movers in North Jersey')
  assert.equal(meta('og:site_name'), 'Move It Clear It')
  assert.equal(meta('og:type'), 'website')
  assert.equal(meta('og:url'), 'https://www.moveitclearit.com/')
  assert.match(meta('og:description') ?? '', /North Jersey/)
  assert.equal(meta('og:image:width'), '1200')
  assert.equal(meta('og:image:height'), '630')
  assert.equal(meta('og:image:type'), 'image/jpeg')
  assert.ok((meta('og:image:alt') ?? '').length > 10, 'the image needs a descriptive alt')
  assert.equal(meta('twitter:card'), 'summary_large_image')
  assert.equal(meta('theme-color'), '#FF5A1F')

  const image = meta('og:image') ?? ''
  assert.match(image, /^https:\/\//, 'og:image must be an ABSOLUTE url')
  assert.match(image, /-v\d+\.(jpg|jpeg|png)$/, 'the filename must be versioned for cache-busting')

  assert.match(head, /<link rel="canonical" href="https:\/\/www\.moveitclearit\.com\/">/)

  // ONE authoritative set — a scraper that finds two og:image tags picks one
  // arbitrarily, and that is how a fixed card keeps rendering the old one.
  assert.equal((head.match(/property="og:image"/g) ?? []).length, 1, 'exactly one og:image tag')
  assert.equal((head.match(/property="og:title"/g) ?? []).length, 1, 'exactly one og:title tag')
})

test('the homepage image exists and is a real 1200x630 file', { skip: siteAvailable ? false : `marketing site not found at ${SITE_DIR}` }, () => {
  const html = readFileSync(homepagePath, 'utf8')
  const m = /<meta property="og:image" content="https:\/\/www\.moveitclearit\.com\/([^"]+)"/.exec(html)
  assert.ok(m, 'og:image must point at the marketing domain')
  const file = resolve(SITE_DIR, 'public', m[1])
  assert.ok(existsSync(file), `${m[1]} must exist in the site repo — an og:image 404 is the original bug`)
  const { w, h } = imageSize(file)
  assert.equal(w, 1200)
  assert.equal(h, 630)
})

test('no customer information appears in homepage social metadata', { skip: siteAvailable ? false : `marketing site not found at ${SITE_DIR}` }, () => {
  const html = readFileSync(homepagePath, 'utf8')
  const head = html.slice(0, html.indexOf('</head>'))
  const ogTags = (head.match(/<meta\s+(?:property|name)="(?:og|twitter):[^"]*"[^>]*>/gi) ?? []).join('\n')
  assert.ok(ogTags.length > 0)
  // No price, no name, no address, no phone number in a CACHED public card.
  assert.ok(!/\$\d/.test(ogTags), 'no price in social metadata')
  assert.ok(!/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(ogTags), 'no phone number')
  assert.ok(!/@[\w.]+\.\w+/.test(ogTags), 'no email address')
  assert.ok(!/\b\d+\s+[A-Z][a-z]+\s+(St|Street|Ave|Avenue|Rd|Road)\b/.test(ogTags), 'no street address')
})

test('the two cards are built from ONE pipeline, not hand-edited', { skip: siteAvailable ? false : `marketing site not found at ${SITE_DIR}` }, () => {
  const script = resolve(SITE_DIR, 'design/render-social-preview.py')
  assert.ok(existsSync(script), 'the render script is the source of truth for both cards')
  const src = readFileSync(script, 'utf8')
  assert.match(src, /social-preview-source\.html/)
  assert.match(src, /deposit-preview-source\.html/)
  assert.ok(existsSync(resolve(SITE_DIR, 'design/deposit-preview-source.html')), 'the deposit card has a design source')
})
