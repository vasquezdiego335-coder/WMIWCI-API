'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COPY, fill, formatCents, intlLocale, type Lang } from '@/lib/deposit-copy'
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
      const res = await fetch(`/api/deposit/${encodeURIComponent(token)}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // NO AMOUNT IS SENT. The server reads it from the deposit record; there
        // is deliberately nothing here for a tampered client to change.
        body: '{}',
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }

      if (!res.ok || !data.url) {
        setError(data.error ?? t.errorGeneric)
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
  }, [token, t])

  // ── What state are we in? ─────────────────────────────────────────────────
  const state: 'unavailable' | 'paid' | 'closed' | 'pay' =
    view == null ? 'unavailable'
    : view.status === 'PAID' ? 'paid'
    : view.status === 'ACTIVE' ? 'pay'
    : 'closed'

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(intlLocale(lang), { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }),
    [lang]
  )
  const fmtDate = (d: Date | string | null | undefined): string | null => {
    if (!d) return null
    const dt = typeof d === 'string' ? new Date(d) : d
    return Number.isNaN(dt.getTime()) ? null : dateFmt.format(dt)
  }

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
      <header className="dp-hero">
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
      <main className="dp-body">
        <div className="dp-card">
          {/* ONE card, but on a wide screen its CONTENTS split in two. At 1512px
              a single 640px column was 42% of the screen and 1082px tall — a
              narrow ribbon in an empty field, which is what made the desktop
              view feel cramped. Money on the left, reassurance on the right;
              below 1024px it collapses back to the exact mobile order. */}
          <div className="dp-grid">
            <div className="dp-colPay">
              {state === 'pay' && (
                <PayState
                  t={t}
                  view={view as PublicDepositView}
                  phase={phase}
                  error={error}
                  canceled={canceled}
                  firstName={firstName}
                  onPay={pay}
                  fmtDate={fmtDate}
                />
              )}
              {state === 'paid' && <PaidState t={t} view={view as PublicDepositView} fmtDate={fmtDate} />}
              {state === 'closed' && <ClosedState t={t} status={(view as PublicDepositView).status} phone={phone} />}
              {state === 'unavailable' && <UnavailableState t={t} phone={phone} />}
            </div>

            <aside className="dp-colInfo">
              {/* Reassurance, and on desktop it sits BESIDE the payment rather
                  than a screen-length below it. */}
              {(state === 'pay' || state === 'paid') && <NextSteps t={t} />}
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
            <p className="dp-polb">{t.policyBody}</p>
            <p className="dp-polb">
              {t.fullTerms}: <a className="dp-link" href="/terms">{t.terms}</a>
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

function PayState({
  t, view, phase, error, canceled, firstName, onPay, fmtDate,
}: {
  t: T
  view: PublicDepositView
  phase: Phase
  error: string | null
  canceled: boolean
  firstName: string | null
  onPay: () => void
  fmtDate: (d: Date | string | null | undefined) => string | null
}) {
  const moveDate = fmtDate(view.moveDate)
  const busy = phase === 'starting'

  if (phase === 'confirming' || phase === 'slow') {
    const slow = phase === 'slow'
    return (
      <div className="dp-status" role="status" aria-live="polite">
        <p className="dp-statush">{slow ? t.slowTitle : t.confirmingTitle}</p>
        <p className="dp-statusb">{slow ? t.slowBody : t.confirmingBody}</p>
        {slow && (
          <button type="button" className="dp-secondary" onClick={() => window.location.reload()}>
            {t.refresh}
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      {firstName && <p className="dp-greet">{fill(t.greeting, { name: firstName })}</p>}

      {canceled && (
        <p className="dp-notice" role="status">
          <IconAlert />
          <span>{t.canceledNotice}</span>
        </p>
      )}

      {(moveDate || view.serviceSummary) && (
        <dl className="dp-details">
          {moveDate && (
            <div className="dp-row">
              <dt>{t.moveDate}</dt>
              <dd>{moveDate}</dd>
            </div>
          )}
          {view.serviceSummary && (
            <div className="dp-row">
              <dt>{t.service}</dt>
              <dd>{view.serviceSummary}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="dp-money">
        {/* Quote total and remaining balance are HIDDEN, not zeroed, when the
            total is unknown — a "$0.00 remaining" a customer relies on is worse
            than saying nothing. */}
        {view.quoteTotalCents != null && (
          <MoneyRow label={t.quoteTotal} value={formatCents(view.quoteTotalCents)} />
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
        <div>
          <p id="dp-trust-h" className="dp-ownerName">{t.ownerName}</p>
          <p className="dp-ownerRole">{t.ownerRole}</p>
        </div>
      </div>
      <div className="dp-contact">
        <a className="dp-ghost" href={`tel:${phone.tel}`}>
          <IconPhone /><span>{phone.display}</span>
        </a>
        <a className="dp-ghost" href={`sms:${phone.sms}`}>
          <IconChat /><span>{t.textUs}</span>
        </a>
      </div>
      <p className="dp-espanol">{t.seHablaEspanol}</p>
    </section>
  )
}

function PaidState({ t, view, fmtDate }: { t: T; view: PublicDepositView; fmtDate: (d: Date | string | null | undefined) => string | null }) {
  const paid = view.amountPaidCents ?? view.depositCents
  return (
    <>
      <p className="dp-badge"><IconCheck /><span>{t.paidBadge}</span></p>
      <div className="dp-money">
        <div className="dp-hero2">
          <span className="dp-herolabel">{t.paidAmount}</span>
          <span className="dp-heroval">{formatCents(paid)}</span>
        </div>
        {view.paidAt && <MoneyRow label={t.paidDate} value={fmtDate(view.paidAt) ?? ''} />}
        {view.remainingCents != null && (
          <MoneyRow label={t.paidRemaining} value={formatCents(view.remainingCents)} />
        )}
      </div>
      <p className="dp-applied">{t.paidApplied}</p>
    </>
  )
}

function ClosedState({ t, status, phone }: { t: T; status: string; phone: Phone }) {
  return (
    <div className="dp-status">
      <p className="dp-statush">{status === 'EXPIRED' ? t.expiredTitle : t.canceledTitle}</p>
      <p className="dp-statusb">{t.closedBody}</p>
      <a className="dp-pay dp-paylink" href={`tel:${phone.tel}`}>
        <IconPhone /><span>{t.callUs} {phone.display}</span>
      </a>
    </div>
  )
}

function UnavailableState({ t, phone }: { t: T; phone: Phone }) {
  return (
    <div className="dp-status" role="status" aria-live="polite">
      <p className="dp-statush">{t.unavailableTitle}</p>
      <p className="dp-statusb">{t.unavailableBody}</p>
      <a className="dp-pay dp-paylink" href={`tel:${phone.tel}`}>
        <IconPhone /><span>{t.callUs} {phone.display}</span>
      </a>
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
