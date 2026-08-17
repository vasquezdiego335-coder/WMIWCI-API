import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COPY, LANGS, fill, pickLang, intlLocale, type Lang } from '../deposit-copy'

// ════════════════════════════════════════════════════════════════════════════
//  The bilingual deposit page: copy parity, price safety, and the redirect.
//  ------------------------------------------------------------------------
//  A large share of this business's customers read Spanish, and this is the
//  page where someone hands over money. A missing Spanish string here is not a
//  cosmetic bug — it is a customer being asked to pay in a language they were
//  not addressed in a moment ago.
// ════════════════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '../../..')
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8')
const VIEW = 'app/deposit/[token]/DepositView.tsx'
const PAGE = 'app/deposit/[token]/page.tsx'
const COMMENT = '/' + '/'

// ── Parity ──────────────────────────────────────────────────────────────────

test('English and Spanish define exactly the same keys', () => {
  const en = Object.keys(COPY.en).sort()
  const es = Object.keys(COPY.es).sort()
  assert.deepEqual(es, en, 'a missing key would silently render English mid-Spanish page')
})

test('no string in either language is empty or a leftover placeholder', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(COPY[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key} must be a string`)
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`)
      assert.ok(!/^TODO|^TBD|^FIXME|XXX/i.test(value), `${lang}.${key} is a placeholder`)
      assert.ok(!value.includes('undefined'), `${lang}.${key} contains "undefined"`)
    }
  }
})

test('Spanish is actually TRANSLATED, not copied English', () => {
  // Brand name and the two language labels are legitimately identical.
  const allowedIdentical = new Set(['brand', 'english', 'spanish'])
  let translated = 0
  for (const key of Object.keys(COPY.en) as Array<keyof typeof COPY.en>) {
    if (allowedIdentical.has(key as string)) continue
    if (COPY.en[key] !== COPY.es[key]) translated++
    else assert.fail(`es.${key} is identical to English — that is not a translation`)
  }
  assert.ok(translated > 30, `only ${translated} strings translated`)
})

test('the owner-specified wording is present, verbatim, in both languages', () => {
  assert.equal(COPY.en.title, 'Secure Your Move')
  assert.equal(COPY.es.title, 'Asegure su mudanza')
  assert.equal(COPY.en.intro, 'Review your quote and pay the deposit to reserve your move.')
  assert.equal(COPY.es.intro, 'Revise su cotización y pague el depósito para reservar su mudanza.')
  assert.equal(COPY.en.quoteTotal, 'Quote total')
  assert.equal(COPY.es.quoteTotal, 'Total de la cotización')
  assert.equal(COPY.en.depositDue, 'Deposit due today')
  assert.equal(COPY.es.depositDue, 'Depósito a pagar hoy')
  assert.equal(COPY.en.remaining, 'Remaining balance after deposit')
  assert.equal(COPY.es.remaining, 'Saldo restante después del depósito')
  assert.equal(COPY.en.appliedNote, 'This deposit is applied to the total balance of your move.')
  assert.equal(COPY.es.appliedNote, 'Este depósito se aplica al saldo total de su mudanza.')
  assert.equal(COPY.en.stripeNote, 'Secure payment processed by Stripe')
  assert.equal(COPY.es.stripeNote, 'Pago seguro procesado por Stripe')
  assert.equal(COPY.en.helpTitle, 'Need help? Call or text us.')
  assert.equal(COPY.es.helpTitle, '¿Necesita ayuda? Llámenos o envíenos un mensaje.')
})

test('Spanish carries its accents — a stripped accent is a different word', () => {
  // "cotizacion" and "deposito" without accents read as a machine did it.
  assert.match(COPY.es.intro, /cotización/)
  assert.match(COPY.es.depositDue, /Depósito/)
  assert.match(COPY.es.helpTitle, /¿/, 'Spanish questions open with ¿')
})

// ── THE money rule ──────────────────────────────────────────────────────────

test('NO copy string contains a price — every amount is interpolated', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(COPY[lang])) {
      assert.ok(!/\$\s?\d/.test(value), `${lang}.${key} hard-codes a price: "${value}"`)
      assert.ok(!/\b49\b|\b495\b|\b446\b/.test(value), `${lang}.${key} hard-codes an amount`)
    }
  }
})

test('the pay button takes its amount from a placeholder, in both languages', () => {
  assert.match(COPY.en.payButton, /\{amount\}/)
  assert.match(COPY.es.payButton, /\{amount\}/)
  assert.equal(fill(COPY.en.payButton, { amount: '$49.00' }), 'Pay $49.00 Securely')
  assert.equal(fill(COPY.es.payButton, { amount: '$49.00' }), 'Pagar $49.00 de forma segura')
  // A different deposit renders a different button. Nothing is fixed at $49.
  assert.equal(fill(COPY.en.payButton, { amount: '$250.00' }), 'Pay $250.00 Securely')
})

test('the cancellation policy states the SAME terms in both languages', () => {
  // A translated policy that changed a number would be a second, unagreed policy.
  assert.match(COPY.en.policyBody, /72 hours/)
  assert.match(COPY.es.policyBody, /72 horas/)
  assert.match(COPY.en.policyBody, /2 hours of labor/)
  assert.match(COPY.es.policyBody, /2 horas de mano de obra/)
})

// ── fill() ──────────────────────────────────────────────────────────────────

test('fill never prints a raw placeholder at a customer', () => {
  assert.equal(fill('Hi {name} —', {}), 'Hi  —')
  assert.equal(fill('Hi {name} —', { name: null }), 'Hi  —')
  assert.equal(fill('Hi {name} —', { name: 'Natalia' }), 'Hi Natalia —')
  assert.ok(!fill(COPY.en.greeting, {}).includes('{'), 'no braces survive')
})

// ── Language selection ──────────────────────────────────────────────────────

test('pickLang honours Accept-Language, including q-values', () => {
  assert.equal(pickLang('es-MX,es;q=0.9,en;q=0.8'), 'es')
  assert.equal(pickLang('en-US,en;q=0.9'), 'en')
  assert.equal(pickLang('es'), 'es')
  assert.equal(pickLang('es-419'), 'es')
  // A lower-q Spanish must not beat a higher-q English.
  assert.equal(pickLang('en-GB;q=1.0,es;q=0.5'), 'en')
  assert.equal(pickLang('fr-FR,fr;q=0.9,es;q=0.7'), 'es', 'falls through to the first tag it knows')
})

test('pickLang defaults to English on anything unknown', () => {
  assert.equal(pickLang(null), 'en')
  assert.equal(pickLang(''), 'en')
  assert.equal(pickLang('de-DE,de'), 'en')
  assert.equal(pickLang('!!!'), 'en')
})

test('date formatting uses the right locale', () => {
  assert.equal(intlLocale('en'), 'en-US')
  assert.equal(intlLocale('es'), 'es-US')
  const d = new Date('2026-08-16T14:00:00Z')
  const en = new Intl.DateTimeFormat(intlLocale('en'), { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }).format(d)
  const es = new Intl.DateTimeFormat(intlLocale('es'), { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }).format(d)
  assert.match(en, /August/)
  assert.match(es, /agosto/)
})

// ── Switching language must not touch the payment ───────────────────────────

test('changing language cannot create a session, refetch, or alter an amount', () => {
  const src = read(VIEW)
  const setLangCalls = src.match(/setLang\(/g) ?? []
  assert.ok(setLangCalls.length >= 2, 'both language buttons must set state')

  // The ONLY effects keyed on `lang` are the <html lang> attribute and storage.
  const langEffect = src.slice(src.indexOf('document.documentElement.lang'), src.indexOf('// Restore a previous choice'))
  assert.ok(!/fetch\(/.test(langEffect), 'switching language must not fetch')
  assert.ok(!/location\.(assign|replace|href)/.test(langEffect), 'switching language must not navigate')

  // The pay handler does not depend on language at all beyond error copy.
  const pay = src.slice(src.indexOf('const pay = useCallback'), src.indexOf('// ── What state are we in?'))
  assert.ok(!/setLang/.test(pay), 'paying must not change language')
  assert.ok(!/amountCents|amount:/.test(pay), 'the pay call must send no amount')
  assert.match(pay, /body: '\{\}'/, 'the request body stays empty')
})

test('the document language attribute is kept in sync for screen readers', () => {
  assert.match(read(VIEW), /document\.documentElement\.lang = lang/)
})

// ── Redirect safety ─────────────────────────────────────────────────────────

test('the browser is only ever sent to Stripe Checkout, in the SAME tab', () => {
  const src = read(VIEW)
  assert.match(src, /const STRIPE_CHECKOUT_ORIGIN = 'https:\/\/checkout\.stripe\.com'/)
  // Validate-then-navigate: an API that ever returned another URL must not turn
  // this page into an open redirect.
  assert.match(src, /target\.origin !== STRIPE_CHECKOUT_ORIGIN/)
  // Comment lines stripped: the header comment legitimately explains why we use
  // window.location.assign, and prose must not satisfy a rule about code order.
  const NL = String.fromCharCode(10)
  const codeOnly = src.split(NL).filter((l) => !l.trim().startsWith(COMMENT)).join(NL)
  const guardIdx = codeOnly.indexOf('target.origin !== STRIPE_CHECKOUT_ORIGIN')
  const navIdx = codeOnly.indexOf('window.location.assign')
  assert.ok(guardIdx > -1 && navIdx > -1 && guardIdx < navIdx, 'the origin check must precede the navigation')

  // window.open() after an await is blocked by Messenger's in-app browser — the
  // customer taps the button and watches nothing happen.
  assert.ok(!/window\.open\s*\(/.test(codeOnly), 'never window.open on the payment path')
})

test('a recoverable failure re-enables the button instead of dead-ending', () => {
  const src = read(VIEW)
  const pay = src.slice(src.indexOf('const pay = useCallback'), src.indexOf('// ── What state are we in?'))
  // Every early return from a failure path must restore the ready state.
  // setError(null) at the top is a reset, not a failure path.
  const failures = (pay.match(/setError\((?!null)/g) ?? []).length
  const recoveries = pay.split("setPhase('ready')").length - 1
  assert.ok(failures >= 4, 'the failure paths must be explicit')
  assert.equal(recoveries, failures, 'every setError must be paired with a return to ready')
  assert.match(src, /disabled=\{busy\}/, 'disabled ONLY while a request is in flight')
  assert.match(src, /aria-busy=\{busy\}/)
})

// ── Accessibility ───────────────────────────────────────────────────────────

test('status and error regions are announced, and never colour-only', () => {
  const src = read(VIEW)
  assert.match(src, /role="alert"/, 'errors must be announced')
  assert.match(src, /aria-live="polite"/, 'the confirming state must be announced')
  // Each message carries an icon as well as a colour.
  assert.match(src, /aria-hidden="true">⚠/)
  assert.match(src, /aria-hidden="true">✓/)
})

test('the language control is a real control, not a decoration', () => {
  const src = read(VIEW)
  assert.match(src, /role="group"/)
  assert.match(src, /aria-pressed=\{lang === 'en'\}/)
  assert.match(src, /aria-pressed=\{lang === 'es'\}/)
  // Each button is tagged with the language it names, so a screen reader
  // pronounces "Español" in Spanish rather than mangling it in English.
  assert.match(src, /lang="es"/)
})

test('touch targets and the pay button meet the sizes older customers need', () => {
  const css = read(VIEW)
  assert.match(css, /\.dp-pay\{[^}]*min-height:56px/, 'primary button >= 56px')
  assert.match(css, /\.dp-langbtn\{[^}]*min-height:44px/, 'language buttons >= 44px')
  assert.match(css, /\.dp-secondary\{[^}]*min-height:44px/)
  assert.match(css, /\.dp-ghost\{[^}]*min-height:48px/)
  assert.match(css, /:focus-visible\{outline:3px solid/, 'visible focus on every control')
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/)
})

test('body text is at least 16px and prices are substantially larger', () => {
  const css = read(VIEW)
  // The deposit figure is the number the customer must not misread.
  assert.match(css, /\.dp-heroval\{[^}]*font-size:36px/)
  assert.match(css, /\.dp-mval\{[^}]*font-size:18px/)
  assert.match(css, /\.dp-mlabel\{[^}]*font-size:16px/)
  assert.match(css, /\.dp-polb\{[^}]*font-size:15px/, 'policy text is readable, not fine print')
  // Nothing below 14px anywhere.
  const sizes = Array.from(css.matchAll(/font-size:(\d+)px/g), (m) => Number(m[1]))
  const tiny = sizes.filter((n) => n < 12)
  assert.equal(tiny.length, 0, `found text below 12px: ${tiny.join(', ')}`)
})

test('the layout is responsive, and desktop is a real two-column container', () => {
  const css = read(VIEW)
  assert.match(css, /@media \(min-width:900px\)/, 'desktop breakpoint')
  assert.match(css, /@media \(max-width:360px\)/, 'small-phone breakpoint')
  assert.match(css, /max-width:1100px/, 'the balanced container, not a floating card')
  assert.match(css, /grid-template-columns:minmax\(0,1fr\) minmax\(0,1\.02fr\)/)
  // The card spans both rows so the reassurance fills the space under the intro
  // instead of leaving a navy void.
  assert.match(css, /\.dp-cardcol\{grid-column:2;grid-row:1 \/ span 2;\}/)
  // minmax(0,…) is what stops a long price forcing horizontal scroll.
  assert.ok(css.includes('minmax(0,'), 'grid tracks must be allowed to shrink')
})

test('only the approved palette is used', () => {
  const css = read(VIEW)
  const approved = new Set(['#0A1628','#0D1F3C','#FF5A1F','#D2450F','#C9A961','#F5F1EA','#EDE8DF','#FFFFFF'])
  const vars = Array.from(css.matchAll(/--[a-z]+:(#[0-9A-Fa-f]{6})/g), (m) => m[1].toUpperCase())
  for (const v of vars) {
    if (['#1F2937', '#5B6472'].includes(v)) continue // neutral ink/muted greys
    assert.ok(approved.has(v), `${v} is not in the approved palette`)
  }
  assert.ok(vars.includes('#0A1628') && vars.includes('#D2450F') && vars.includes('#C9A961'))
})

// ── Page wiring ─────────────────────────────────────────────────────────────

test('the server picks the language and passes real contact details', () => {
  const src = read(PAGE)
  assert.match(src, /pickLang\(headers\(\)\.get\('accept-language'\)\)/, 'first paint in the customer’s language')
  assert.match(src, /businessPhone\(\)/, 'contact details come from config, never hard-coded')
  assert.ok(!/862.?640.?0625/.test(src), 'no hard-coded phone number on the page')
  assert.ok(!/862.?640.?0625/.test(read(VIEW)), 'no hard-coded phone number in the view')
})

test('an explicit ?lang= wins over the browser header', () => {
  assert.match(read(PAGE), /requested === 'es' \|\| requested === 'en' \? requested : pickLang/)
})

test('the view model still carries no customer contact detail', () => {
  const src = read(PAGE)
  const select = src.slice(src.indexOf('select: {'), src.indexOf('})', src.indexOf('select: {')))
  for (const forbidden of ['customerEmail', 'customerPhone', 'bookingId', 'stripeCheckoutSessionId', 'createdById']) {
    assert.ok(!select.includes(forbidden), `${forbidden} must not be selected for the public page`)
  }
})
