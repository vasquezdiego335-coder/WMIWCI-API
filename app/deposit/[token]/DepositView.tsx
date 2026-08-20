'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COPY, fill, formatCents, intlLocale, type Lang } from '@/lib/deposit-copy'
// PURE and browser-safe: move-date.ts uses only Date and Intl. It is THE reason
// this page can no longer print the wrong day — see the file header.
import { formatMoveWhen } from '@/lib/move-date'
// TYPE-ONLY: deposit-links imports node:crypto, which cannot be bundled for a
// browser. A type import is erased at compile time, so nothing follows it here.
import type { PublicDepositView } from '@/lib/deposit-links'

// ════════════════════════════════════════════════════════════════════════════
//  The deposit page a customer actually sees.
//  ------------------------------------------------------------------------
//  THE COMPOSITION IS THE POINT. The customer taps a photographic card in
//  Messenger — movers, Archivo headline, orange accent, gold hairline — and
//  must land somewhere that is obviously the same company. The previous version
//  used the right palette in the wrong shapes: a white card on a flat navy void
//  reads as a payment processor, not as Move It Clear It.
//
//  So the header is cut from THE SAME PHOTOGRAPH the social card is cut from
//  (public/img/move-it-clear-it-hero-poster.webp), carries the same gold
//  hairline and the same "Secure Your / Move." lockup, and the page beneath it
//  is BONE, not navy. One card, generous spacing, no floating boxes.
//
//  THE RULE THIS COMPONENT EXISTS TO KEEP: reaching the success URL is NOT a
//  payment. Stripe redirects the browser the moment the customer finishes, but
//  the money is only confirmed when the signed webhook arrives. So when the
//  customer comes back this shows "Confirming your payment…" and asks the
//  SERVER whether the deposit is paid. It can never render success on its own.
//
//  REDIRECT SAFETY. The checkout URL comes from our own API, but it is still
//  validated against the Stripe Checkout origin before the browser is sent
//  anywhere. An API that was ever tricked into returning another URL must not
//  be able to turn this page into an open redirect.
//
//  MESSENGER. The redirect is a SAME-TAB window.location.assign, never
//  window.open — an in-app browser blocks a popup that happens after an await,
//  and the customer would tap the button and watch nothing happen.
//
//  LANGUAGE. Switching is pure client state: no reload, no refetch, no new
//  Checkout Session, no change to the token or any amount.
// ════════════════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 30_000
/** The ONLY origin this page will ever send a customer to. */
const STRIPE_CHECKOUT_ORIGIN = 'https://checkout.stripe.com'

type Phone = { display: string; tel: string; sms: string }

/**
 * The copyright year, PINNED TO EASTERN.
 *
 * `new Date().getFullYear()` would be read on the server (UTC) and again on the
 * client (the customer's own zone). On the evening of 31 December those two
 * disagree, and this is a file with a long history of hydration mismatches —
 * see the stylesheet's header. Pinning the timezone makes both sides compute
 * the same string.
 */
function easternYear(): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(new Date())
}

type Props = {
  /** null = the record could not be loaded (outage), NOT "does not exist". */
  view: PublicDepositView | null
  token: string
  initialLang: Lang
  returning: boolean
  canceled: boolean
  phone: Phone
}

type Phase = 'ready' | 'starting' | 'confirming' | 'slow'

/**
 * A server refusal, in the customer's language.
 *
 * The checkout route answers with a stable `code` alongside its English
 * sentence. Everything the page can name, it says in Spanish; anything it
 * cannot, it lets the server's own words through rather than inventing a
 * reason. HTTP 429 has no body code of its own, so the status carries it.
 */
function localizedApiError(t: (typeof COPY)['en'], code: string | undefined, status: number): string | null {
  if (status === 429) return t.errorTooMany
  switch (code) {
    case 'already_paid': return t.errorAlreadyPaid
    case 'expired': return t.errorExpired
    case 'inactive': return t.errorInactive
    case 'not_valid': return t.errorNotValid
    case 'busy': return t.errorBusy
    default: return null
  }
}

export default function DepositView({ view, token, initialLang, returning, canceled, phone }: Props) {
  const [lang, setLang] = useState<Lang>(initialLang)
  const [phase, setPhase] = useState<Phase>(returning ? 'confirming' : 'ready')
  const [error, setError] = useState<string | null>(null)
  const stopped = useRef(false)

  const t = COPY[lang]

  useEffect(() => () => { stopped.current = true }, [])

  // Keep <html lang> honest for screen readers and for the browser's own
  // translation prompt. Without this a Spanish page is announced as English.
  useEffect(() => {
    document.documentElement.lang = lang
    try {
      localStorage.setItem('wmic_deposit_lang', lang)
    } catch {
      /* private mode — the toggle still works for this visit */
    }
  }, [lang])

  // Restore a previous choice, but never override an explicit ?lang=.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (new URLSearchParams(window.location.search).has('lang')) return
    try {
      const saved = localStorage.getItem('wmic_deposit_lang')
      if (saved === 'en' || saved === 'es') setLang(saved)
    } catch {
      /* ignore */
    }
  }, [])

  // ── Poll for the webhook-confirmed state ──────────────────────────────────
  useEffect(() => {
    if (!returning) return
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      if (stopped.current) return
      try {
        const res = await fetch(`/api/deposit/${encodeURIComponent(token)}/status`, { cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json()) as { status?: string }
          if (data.status === 'PAID') {
            // Reload so the SERVER re-renders the authoritative paid view — the
            // client never composes a success screen from its own state.
            window.location.replace(`/deposit/${encodeURIComponent(token)}?lang=${lang}`)
            return
          }
        }
      } catch {
        /* a transient network error is not a payment failure — keep polling */
      }
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
        setPhase('slow')
        return
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [returning, token, lang])

  const pay = useCallback(async () => {
    setError(null)
    setPhase('starting')
    try {
      // The language rides in the QUERY STRING, never the body: the route's
      // guarantee is that it reads no body at all, and that is worth keeping
      // literal. It affects only which words Stripe shows and which language
      // the customer is returned in — never the amount.
      const res = await fetch(`/api/deposit/${encodeURIComponent(token)}/checkout?lang=${lang}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // NO AMOUNT IS SENT. The server reads it from the deposit record; there
        // is deliberately nothing here for a tampered client to change.
        body: '{}',
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string; code?: string }

      if (!res.ok || !data.url) {
        // Prefer OUR translation of the server's code; fall back to the
        // server's English sentence only when the code is unknown to us.
        setError(localizedApiError(t, data.code, res.status) ?? data.error ?? t.errorGeneric)
        setPhase('ready') // recoverable — the button comes back
        return
      }

      // Validate before navigating. Our own API produced this, but an open
      // redirect is not a risk worth carrying on a payment page.
      let target: URL
      try {
        target = new URL(data.url)
      } catch {
        setError(t.errorGeneric)
        setPhase('ready')
        return
      }
      if (target.origin !== STRIPE_CHECKOUT_ORIGIN) {
        setError(t.errorGeneric)
        setPhase('ready')
        return
      }

      // SAME TAB. window.open() after an await is blocked by Messenger's in-app
      // browser, and the customer sees a button that does nothing.
      window.location.assign(target.toString())
    } catch {
      setError(t.errorNetwork)
      setPhase('ready')
    }
  }, [token, t, lang])

  // ── What state are we in? ─────────────────────────────────────────────────
  const serverState: 'unavailable' | 'paid' | 'closed' | 'pay' =
    view == null ? 'unavailable'
    : view.status === 'PAID' ? 'paid'
    : view.status === 'ACTIVE' ? 'pay'
    : 'closed'

  // THE PAGE MAY NEVER SAY "NOTHING WAS CHARGED" TO SOMEONE WHO JUST PAID.
  //
  // `?return=1` means the customer came back from Stripe Checkout. The webhook
  // that marks the deposit PAID is asynchronous, so for the first few seconds
  // the row still reads whatever it was — and two live paths make that "not
  // ACTIVE": the link's own `expiresAt` passing while they typed their card, or
  // the owner cancelling the link while they were inside Checkout. Both then
  // rendered ClosedState, whose copy is "Nothing was charged." The money had in
  // fact moved: markDepositPaid deliberately records a capture on an expired or
  // cancelled link, because refusing it would lose money already in the account.
  // The outage path told the same lie via unavailableBody.
  //
  // So a returning customer sees the confirming panel until the SERVER says
  // paid, whatever the stored status is. The one thing this page is certain of
  // on a `?return=1` load is that it is NOT certain nothing was charged.
  const state = returning && serverState !== 'paid' ? 'confirming' : serverState

  // ── Two different kinds of "date", formatted two different ways ───────────
  //
  // A MOVE DATE is a CALENDAR DATE. It goes through move-date.ts, which decides
  // the calendar day first and only then spells it — so no timezone can shift
  // it. Formatting it with `timeZone: 'America/New_York'`, as this page used to,
  // is exactly what printed "August 21" for a move booked on Saturday the 22nd.
  //
  // A PAYMENT TIME is a real INSTANT — the moment Stripe took the money. That
  // one genuinely belongs in the customer's local business timezone, so it keeps
  // an Eastern formatter.
  const fmtWhen = useCallback(
    (d: Date | string | null | undefined, timeMinutes: number | null | undefined): string | null => {
      if (!d) return null
      const dt = typeof d === 'string' ? new Date(d) : d
      return Number.isNaN(dt.getTime()) ? null : formatMoveWhen(dt, timeMinutes ?? null, lang)
    },
    [lang]
  )

  const instantFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale(lang), {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/New_York',
      }),
    [lang]
  )
  const fmtInstant = useCallback(
    (d: Date | string | null | undefined): string | null => {
      if (!d) return null
      const dt = typeof d === 'string' ? new Date(d) : d
      return Number.isNaN(dt.getTime()) ? null : instantFmt.format(dt)
    },
    [instantFmt]
  )

  const firstName = view?.firstName ?? null

  return (
    <>
      {/* Styles live in ./deposit.css, imported by the segment layout. They are
          deliberately NOT an inline style element here: React escapes text when
          it serialises on the server, so every apostrophe in the CSS mismatched
          on hydration, took the whole root down to client rendering, and left
          the hero photograph's url() pointing at a 404. */}

      {/* ── HERO: the same photograph the social card is cut from, so tapping
          the preview and landing here is one continuous moment. ── */}
      {/* LANG ON THE CONTENT, not just on <html>.
          The root layout hard-codes <html lang="en"> and cannot know this
          page's language — it is chosen per request from Accept-Language or
          ?lang=. The effect above corrects documentElement AFTER hydration, but
          a screen reader has already begun announcing Spanish copy with English
          pronunciation by then. Tagging the two top-level landmarks is
          server-rendered, correct on the FIRST paint, and costs nothing. */}
      <header className="dp-hero" lang={lang}>
        <div className="dp-hairline" aria-hidden="true" />
        <div className="dp-heroInner">
          <div className="dp-topbar">
            {/* The mark is used BARE. icon.svg is already a navy tile with an
                orange chevron; wrapping it in a bone box double-tiled it and
                stopped it reading as our logo. */}
            <a className="dp-brand" href="/" aria-label={t.brand}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="dp-mark" src="/icon.svg" alt="" width={44} height={44} />
              <span className="dp-word">{t.brand}</span>
            </a>

            <div className="dp-lang" role="group" aria-label={t.langLabel}>
              <button
                type="button"
                className={`dp-langbtn${lang === 'en' ? ' is-on' : ''}`}
                aria-pressed={lang === 'en'}
                onClick={() => setLang('en')}
                lang="en"
              >
                {t.english}
              </button>
              <span className="dp-langsep" aria-hidden="true">|</span>
              <button
                type="button"
                className={`dp-langbtn${lang === 'es' ? ' is-on' : ''}`}
                aria-pressed={lang === 'es'}
                onClick={() => setLang('es')}
                lang="es"
              >
                {t.spanish}
              </button>
            </div>
          </div>

          <h1 className="dp-h1">
            {state === 'paid' ? (
              fill(t.paidTitle, { name: firstName ? `, ${firstName}` : '' })
            ) : (
              <>
                <span className="dp-h1a">{t.titleLead}</span>
                <span className="dp-h1b">{t.titleAccent}</span>
              </>
            )}
          </h1>
          {state === 'pay' && <p className="dp-lede">{t.intro}</p>}
        </div>
      </header>

      {/* ── BODY: bone, one card. No navy void. ── */}
      <main className="dp-body" lang={lang}>
        <div className="dp-card">
          {/* ONE card, but on a wide screen its CONTENTS split in two. At 1512px
              a single 640px column was 42% of the screen and 1082px tall — a
              narrow ribbon in an empty field, which is what made the desktop
              view feel cramped. Money on the left, reassurance on the right;
              below 1024px it collapses back to the exact mobile order. */}
          <div className="dp-grid">
            <div className="dp-colPay">
              {state === 'confirming' && <ConfirmingState t={t} phase={phase} />}
              {state === 'pay' && (
                <PayState
                  t={t}
                  view={view as PublicDepositView}
                  phase={phase}
                  error={error}
                  canceled={canceled}
                  firstName={firstName}
                  onPay={pay}
                  fmtWhen={fmtWhen}
                />
              )}
              {state === 'paid' && (
                <PaidState t={t} view={view as PublicDepositView} fmtWhen={fmtWhen} fmtInstant={fmtInstant} />
              )}
              {state === 'closed' && <ClosedState t={t} status={(view as PublicDepositView).status} phone={phone} />}
              {state === 'unavailable' && <UnavailableState t={t} phone={phone} />}
            </div>

            <aside className="dp-colInfo">
              {/* Reassurance, and on desktop it sits BESIDE the payment rather
                  than a screen-length below it. */}
              {(state === 'pay' || state === 'paid' || state === 'confirming') && <NextSteps t={t} />}
              {/* Human, local, and compact — the part that says a person answers. */}
              <TrustRow t={t} phone={phone} />
            </aside>
          </div>

          {/* Quiet, last, and still fully readable. */}
          <section className="dp-policy" aria-labelledby="dp-pol-h">
            <h2 id="dp-pol-h" className="dp-polh">{t.policyTitle}</h2>
            {/*
              The APPROVED policy, and nothing more. The Terms' "non-refundable"
              sentence is about the CAPTURED $49 booking fee and is deliberately
              not repeated: this deposit is a different instrument, and inventing
              a refund policy for it would be a term nobody agreed to.
            */}
            {/*
              ONE link, INSIDE the sentence. There used to be a second
              "Full terms: Terms of Service" paragraph directly beneath this
              one — two links, same destination, stacked, in the quietest part
              of the page. The Terms page carries the legal language.
            */}
            <p className="dp-polb">
              {t.policyBody}{' '}
              {t.policySeePre}
              <a className="dp-link" href="/terms">
                {t.terms}
              </a>
              {t.policySeePost}
            </p>

            {/* The whole site footer is suppressed on this route (deposit.css),
                so the Privacy Policy is kept reachable here — one quiet line,
                localized, instead of a second navy block repeating the Terms
                link that is already in the sentence above. */}
            <p className="dp-legal">
              <span>© {easternYear()} {t.brand}</span>
              <a href="/privacy">{t.privacy}</a>
            </p>
          </section>
        </div>
      </main>
    </>
  )
}

// ── Line icons. Proper strokes, never emoji — an emoji lock on a payment page
//    reads as cheaper than the thing it is trying to reassure you about. ──

const IconLock = () => (
  <svg className="dp-i" viewBox="0 0 16 18" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="1.6" y="7.4" width="12.8" height="9.1" rx="2.1" />
    <path d="M4.6 7.4V5.1a3.4 3.4 0 0 1 6.8 0v2.3" />
  </svg>
)

const IconAlert = () => (
  <svg className="dp-i" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="9" cy="9" r="7.4" />
    <path d="M9 5.4v4.4" />
    <circle cx="9" cy="12.6" r=".9" fill="currentColor" stroke="none" />
  </svg>
)

const IconCheck = () => (
  <svg className="dp-i" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.9"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="9" cy="9" r="7.4" strokeWidth="1.5" />
    <path d="M5.6 9.2l2.3 2.3 4.5-4.7" />
  </svg>
)

const IconPhone = () => (
  <svg className="dp-i" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M6.1 2.6 7.5 6 6 7.4a9.4 9.4 0 0 0 4.6 4.6L12 10.5l3.4 1.4v2.6c0 .8-.7 1.5-1.5 1.4C7.2 15.4 2.6 10.8 2.1 4.1 2 3.3 2.7 2.6 3.5 2.6z" />
  </svg>
)

const IconChat = () => (
  <svg className="dp-i" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M15.4 10.3a1.9 1.9 0 0 1-1.9 1.9H6l-3.4 3v-11a1.9 1.9 0 0 1 1.9-1.9h9a1.9 1.9 0 0 1 1.9 1.9z" />
  </svg>
)

// ── States ──────────────────────────────────────────────────────────────────

type T = (typeof COPY)['en']

/**
 * The appointment block: WHO, WHEN, WHAT — in that order, left-aligned, and
 * scannable in one glance.
 *
 * It is a <dl> whose labels are visually hidden. A sighted customer does not
 * need "Move date:" printed in front of a date — that was half the clutter the
 * old two-column rows created — but a screen reader announcing two unlabelled
 * lines in a row genuinely cannot tell which is which.
 */
function Appointment({
  t, when, service,
}: {
  t: T
  when: string | null
  service: string | null
}) {
  if (!when && !service) return null
  return (
    <dl className="dp-appt">
      {when && (
        <div className="dp-apptItem">
          <dt className="dp-vh">{t.moveDate}</dt>
          <dd className="dp-when">{when}</dd>
        </div>
      )}
      {service && (
        <div className="dp-apptItem">
          <dt className="dp-vh">{t.service}</dt>
          <dd className="dp-service">{service}</dd>
        </div>
      )}
    </dl>
  )
}

/**
 * The short bullet list. A LIST, structurally — so it can never again become the
 * single wrapped paragraph that was clipping on a phone.
 */
function MoveDetails({ t, details }: { t: T; details: string[] }) {
  if (details.length === 0) return null
  return (
    <section className="dp-md" aria-labelledby="dp-md-h">
      <h3 id="dp-md-h" className="dp-mdh">{t.moveDetailsTitle}</h3>
      <ul className="dp-mdlist">
        {details.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ul>
    </section>
  )
}

/** The customer's own to-do, called out so it is not skimmed past. */
function NeedFromYou({ t, note }: { t: T; note: string | null }) {
  if (!note) return null
  return (
    <section className="dp-need" aria-labelledby="dp-need-h">
      <h3 id="dp-need-h" className="dp-needh">{t.needFromYou}</h3>
      <p className="dp-needb">{note}</p>
    </section>
  )
}

function PayState({
  t, view, phase, error, canceled, firstName, onPay, fmtWhen,
}: {
  t: T
  view: PublicDepositView
  phase: Phase
  error: string | null
  canceled: boolean
  firstName: string | null
  onPay: () => void
  fmtWhen: (d: Date | string | null | undefined, timeMinutes: number | null | undefined) => string | null
}) {
  const when = fmtWhen(view.moveDate, view.moveTimeMinutes)
  const busy = phase === 'starting'

  return (
    <>
      {/* The greeting is the card's HEADING, not a muted aside. It is the first
          thing the customer reads and it tells them the page is about them. */}
      <h2 className="dp-greet">
        {firstName ? fill(t.greeting, { name: firstName }) : t.greetingNoName}
      </h2>

      {canceled && (
        <p className="dp-notice" role="status">
          <IconAlert />
          <span>{t.canceledNotice}</span>
        </p>
      )}

      <Appointment t={t} when={when} service={view.serviceSummary} />
      <MoveDetails t={t} details={view.moveDetails} />
      <NeedFromYou t={t} note={view.customerNote} />

      <div className="dp-money">
        {/* Quote total and remaining balance are HIDDEN, not zeroed, when the
            total is unknown — a "$0.00 remaining" a customer relies on is worse
            than saying nothing. */}
        {view.quoteTotalCents != null && (
          <MoneyRow label={t.quoteTotal} value={formatCents(view.quoteTotalCents)} />
        )}
        {/* Without this row the three figures do not subtract: on an approved
            booking the $49 hold has already been captured, so quote total minus
            today's deposit is NOT the remaining balance. Naming the money that
            is already in turns an apparent arithmetic error into a fact. */}
        {view.alreadyPaidCents != null && (
          <MoneyRow label={t.alreadyPaid} value={`- ${formatCents(view.alreadyPaidCents)}`} />
        )}
        <div className="dp-hero2">
          <span className="dp-herolabel">{t.depositDue}</span>
          <span className="dp-heroval">{formatCents(view.depositCents)}</span>
        </div>
        {view.remainingCents != null && (
          <MoneyRow label={t.remaining} value={formatCents(view.remainingCents)} />
        )}
      </div>

      <p className="dp-applied">{t.appliedNote}</p>

      {error && (
        <p className="dp-error" role="alert">
          <IconAlert />
          <span>{error}</span>
        </p>
      )}

      <button type="button" className="dp-pay" onClick={onPay} disabled={busy} aria-busy={busy}>
        {busy ? t.paying : fill(t.payButton, { amount: formatCents(view.depositCents) })}
      </button>

      <p className="dp-stripe">
        <IconLock />
        <span>{t.stripeNote}</span>
      </p>
    </>
  )
}

function NextSteps({ t }: { t: T }) {
  const steps = [t.step1, t.step2, t.step3]
  return (
    <section className="dp-next" aria-labelledby="dp-next-h">
      <h2 id="dp-next-h" className="dp-nexth">{t.reassureTitle}</h2>
      <ol className="dp-steps">
        {steps.map((s, i) => (
          <li key={i}>
            <span className="dp-num" aria-hidden="true">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function TrustRow({ t, phone }: { t: T; phone: Phone }) {
  return (
    <section className="dp-trust" aria-labelledby="dp-trust-h">
      <div className="dp-owner">
        <span className="dp-ownerMark" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" width={34} height={34} />
        </span>
        <div className="dp-ownerText">
          <p id="dp-trust-h" className="dp-ownerName">{t.ownerName}</p>
          {/* The role and the Spanish badge sit on ONE line and wrap together.
              "Se habla Español." used to occupy a whole row of its own at the
              bottom of the card — a full row of vertical space to say one
              thing, on the page with the least room to spare. As a badge beside
              the role it says the same thing and costs nothing. */}
          <p className="dp-ownerRole">
            {t.ownerRole}
            <span className="dp-esBadge" lang="es">{t.seHablaEspanol}</span>
          </p>
        </div>
      </div>
      <p className="dp-helpTitle">{t.helpTitle}</p>
      <div className="dp-contact">
        <a className="dp-ghost" href={`tel:${phone.tel}`} aria-label={`${t.callUs} ${phone.display}`}>
          <IconPhone /><span>{phone.display}</span>
        </a>
        <a className="dp-ghost" href={`sms:${phone.sms}`}>
          <IconChat /><span>{t.textUs}</span>
        </a>
      </div>
    </section>
  )
}

function PaidState({
  t, view, fmtWhen, fmtInstant,
}: {
  t: T
  view: PublicDepositView
  fmtWhen: (d: Date | string | null | undefined, timeMinutes: number | null | undefined) => string | null
  fmtInstant: (d: Date | string | null | undefined) => string | null
}) {
  const paid = view.amountPaidCents ?? view.depositCents
  const when = fmtWhen(view.moveDate, view.moveTimeMinutes)
  return (
    <>
      <p className="dp-badge"><IconCheck /><span>{t.paidBadge}</span></p>
      {/* A customer who comes back to a paid link is checking their date, not
          their receipt. Show it. */}
      <Appointment t={t} when={when} service={view.serviceSummary} />
      <div className="dp-money">
        <div className="dp-hero2">
          <span className="dp-herolabel">{t.paidAmount}</span>
          <span className="dp-heroval">{formatCents(paid)}</span>
        </div>
        {/* A real instant — the moment Stripe took the money — so this one IS
            formatted in Eastern, unlike the move date above. */}
        {view.paidAt && <MoneyRow label={t.paidDate} value={fmtInstant(view.paidAt) ?? ''} />}
        {view.remainingCents != null && (
          <MoneyRow label={t.paidRemaining} value={formatCents(view.remainingCents)} />
        )}
      </div>
      <p className="dp-applied">{t.paidApplied}</p>
    </>
  )
}

/**
 * The holding screen for a customer who has come back from Stripe.
 *
 * Rendered for EVERY non-paid status on a `?return=1` load — active, expired,
 * cancelled, or "we could not reach the database" — because none of those
 * states knows whether the customer's card was charged, and three of the four
 * used to answer that question with "Nothing was charged."
 *
 * The `slow` copy is the honest end state: it says the payment may still be
 * confirming, tells them explicitly NOT to pay again, and offers a refresh.
 */
function ConfirmingState({ t, phase }: { t: T; phase: Phase }) {
  const slow = phase === 'slow'
  return (
    <div className="dp-status" role="status" aria-live="polite">
      <h2 className="dp-statush">{slow ? t.slowTitle : t.confirmingTitle}</h2>
      <p className="dp-statusb">{slow ? t.slowBody : t.confirmingBody}</p>
      {slow && (
        <button type="button" className="dp-secondary" onClick={() => window.location.reload()}>
          {t.refresh}
        </button>
      )}
    </div>
  )
}

/** Call AND text. The copy says "Call or text us"; only one of them was there. */
function ReachUs({ t, phone }: { t: T; phone: Phone }) {
  return (
    <>
      <a className="dp-pay dp-paylink" href={`tel:${phone.tel}`}>
        <IconPhone /><span>{t.callUs} {phone.display}</span>
      </a>
      <a className="dp-secondary dp-secondarylink" href={`sms:${phone.sms}`}>
        <IconChat /><span>{t.textUs}</span>
      </a>
    </>
  )
}

function ClosedState({ t, status, phone }: { t: T; status: string; phone: Phone }) {
  return (
    <div className="dp-status">
      {/* A real heading. These were 23px bold PARAGRAPHS, so a screen-reader
          user landing on an expired link found no heading to orient by. */}
      <h2 className="dp-statush">{status === 'EXPIRED' ? t.expiredTitle : t.canceledTitle}</h2>
      <p className="dp-statusb">{t.closedBody}</p>
      <ReachUs t={t} phone={phone} />
    </div>
  )
}

function UnavailableState({ t, phone }: { t: T; phone: Phone }) {
  return (
    <div className="dp-status" role="status" aria-live="polite">
      <h2 className="dp-statush">{t.unavailableTitle}</h2>
      <p className="dp-statusb">{t.unavailableBody}</p>
      <ReachUs t={t} phone={phone} />
    </div>
  )
}

function MoneyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dp-mrow">
      <span className="dp-mlabel">{label}</span>
      <span className="dp-mval">{value}</span>
    </div>
  )
}
