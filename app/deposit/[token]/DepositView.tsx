'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COPY, fill, formatCents, intlLocale, type Lang } from '@/lib/deposit-copy'
// TYPE-ONLY: deposit-links imports node:crypto, which cannot be bundled for a
// browser. A type import is erased at compile time, so nothing follows it here.
import type { PublicDepositView } from '@/lib/deposit-links'

// ════════════════════════════════════════════════════════════════════════════
//  The deposit page a customer actually sees.
//  ------------------------------------------------------------------------
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
//  Checkout Session, no change to the token or any amount. A reload would
//  re-request a page the customer reached from a chat app, which is exactly
//  where links go to die.
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
      <style>{CSS}</style>
      <main className="dp-page">
        <div className="dp-shell">
          <header className="dp-head">
            <a className="dp-brand" href="/" aria-label={t.brand}>
              <span className="dp-mark" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icon.svg" alt="" width={30} height={30} />
              </span>
              <span className="dp-word">{t.brand}</span>
            </a>

            {/* Language: a real control, not a flag. Both options always visible
                so a Spanish speaker never has to guess what a toggle does. */}
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
          </header>

          <div className="dp-grid">
            <section className="dp-intro">
              <h1 className="dp-h1">
                {state === 'paid' ? fill(t.paidTitle, { name: firstName ? `, ${firstName}` : '' }) : t.title}
              </h1>
              {state === 'pay' && <p className="dp-lede">{t.intro}</p>}
              {state === 'pay' && firstName && (
                <p className="dp-greet">{fill(t.greeting, { name: firstName })}</p>
              )}
            </section>

            <section className="dp-cardcol" aria-labelledby="dp-card-h">
              <h2 id="dp-card-h" className="dp-sr">{t.title}</h2>
              <div className="dp-card">
                {state === 'pay' && (
                  <PayState
                    t={t}
                    view={view as PublicDepositView}
                    phase={phase}
                    error={error}
                    canceled={canceled}
                    onPay={pay}
                    fmtDate={fmtDate}
                  />
                )}
                {state === 'paid' && <PaidState t={t} view={view as PublicDepositView} fmtDate={fmtDate} />}
                {state === 'closed' && <ClosedState t={t} status={(view as PublicDepositView).status} phone={phone} />}
                {state === 'unavailable' && <UnavailableState t={t} phone={phone} />}

                <div className="dp-policy">
                  <h3 className="dp-polh">{t.policyTitle}</h3>
                  {/* The APPROVED policy, and nothing more. The Terms'
                      "non-refundable" sentence is about the CAPTURED $49 booking
                      fee and is deliberately not repeated: this deposit is a
                      different instrument, and inventing a refund policy for it
                      would be a term the customer never agreed to. */}
                  <p className="dp-polb">{t.policyBody}</p>
                  <p className="dp-polb">
                    {t.fullTerms}:{' '}
                    <a className="dp-link" href="/terms">{t.terms}</a>
                  </p>
                </div>
              </div>
            </section>

            <section className="dp-reassure" aria-labelledby="dp-reassure-h">
              <h2 id="dp-reassure-h" className="dp-h2">{t.reassureTitle}</h2>
              <ul className="dp-list">
                <li>{t.reassureApplied}</li>
                <li>{t.reassureQuote}</li>
                <li>{t.reassureHelp}</li>
              </ul>

              <div className="dp-help">
                <p className="dp-helph">{t.helpTitle}</p>
                <div className="dp-helpbtns">
                  <a className="dp-ghost" href={`tel:${phone.tel}`}>{t.callUs} {phone.display}</a>
                  <a className="dp-ghost" href={`sms:${phone.sms}`}>{t.textUs}</a>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </>
  )
}

// ── States ──────────────────────────────────────────────────────────────────

type T = (typeof COPY)['en']

function PayState({
  t, view, phase, error, canceled, onPay, fmtDate,
}: {
  t: T
  view: PublicDepositView
  phase: Phase
  error: string | null
  canceled: boolean
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
      {canceled && (
        <p className="dp-notice" role="status">
          <span aria-hidden="true">⚠ </span>{t.canceledNotice}
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
        <div className="dp-hero">
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
          <span aria-hidden="true">⚠ </span>{error}
        </p>
      )}

      <button type="button" className="dp-pay" onClick={onPay} disabled={busy} aria-busy={busy}>
        {busy ? t.paying : fill(t.payButton, { amount: formatCents(view.depositCents) })}
      </button>

      <p className="dp-stripe">
        <span aria-hidden="true">🔒 </span>{t.stripeNote}
      </p>
    </>
  )
}

function PaidState({ t, view, fmtDate }: { t: T; view: PublicDepositView; fmtDate: (d: Date | string | null | undefined) => string | null }) {
  const paid = view.amountPaidCents ?? view.depositCents
  return (
    <>
      <p className="dp-badge"><span aria-hidden="true">✓ </span>{t.paidBadge}</p>
      <div className="dp-money">
        <div className="dp-hero">
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
    <>
      <p className="dp-statush">{status === 'EXPIRED' ? t.expiredTitle : t.canceledTitle}</p>
      <p className="dp-statusb">{t.closedBody}</p>
      <a className="dp-pay dp-paylink" href={`tel:${phone.tel}`}>{t.callUs} {phone.display}</a>
    </>
  )
}

function UnavailableState({ t, phone }: { t: T; phone: Phone }) {
  return (
    <div role="status" aria-live="polite">
      <p className="dp-statush">{t.unavailableTitle}</p>
      <p className="dp-statusb">{t.unavailableBody}</p>
      <a className="dp-pay dp-paylink" href={`tel:${phone.tel}`}>{t.callUs} {phone.display}</a>
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

// ── Styles ──────────────────────────────────────────────────────────────────
//
// A real stylesheet rather than inline styles, because this page needs media
// queries, :focus-visible and prefers-reduced-motion — none of which a style
// object can express. Class names are prefixed dp- so nothing here can reach
// the rest of the admin.
//
// PALETTE is the approved one, no substitutions:
//   navy #0A1628 · deep navy #0D1F3C · orange #FF5A1F · CTA #D2450F
//   gold #C9A961 · bone #F5F1EA · dark bone #EDE8DF · white #FFFFFF
const CSS = `
.dp-page{--navy:#0A1628;--deep:#0D1F3C;--orange:#FF5A1F;--cta:#D2450F;--gold:#C9A961;
  --bone:#F5F1EA;--dbone:#EDE8DF;--white:#FFFFFF;--ink:#1F2937;--muted:#5B6472;
  min-height:100vh;background:linear-gradient(170deg,var(--navy) 0%,var(--deep) 100%);
  padding:20px 16px 48px;box-sizing:border-box;
  font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;}
.dp-page *,.dp-page *::before,.dp-page *::after{box-sizing:border-box;}
.dp-shell{max-width:1100px;margin:0 auto;}
.dp-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0,0,0,0);white-space:nowrap;border:0;}

/* header */
.dp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
  flex-wrap:wrap;margin-bottom:22px;}
.dp-brand{display:inline-flex;align-items:center;gap:11px;text-decoration:none;
  padding:6px 2px;min-height:44px;}
.dp-mark{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;
  background:var(--bone);border-radius:9px;padding:5px;flex:0 0 40px;}
.dp-word{color:var(--bone);font-weight:700;font-size:13px;letter-spacing:.15em;
  text-transform:uppercase;}
.dp-lang{display:inline-flex;align-items:center;gap:2px;}
.dp-langbtn{background:none;border:none;cursor:pointer;color:rgba(245,241,234,.72);
  font-size:15px;font-weight:600;padding:11px 10px;min-height:44px;border-radius:8px;
  font-family:inherit;}
.dp-langbtn.is-on{color:var(--white);text-decoration:underline;text-underline-offset:5px;
  text-decoration-color:var(--orange);text-decoration-thickness:2px;}
.dp-langsep{color:rgba(245,241,234,.35);}

/* layout */
.dp-grid{display:grid;gap:18px;}
.dp-h1{color:var(--white);font-size:32px;line-height:1.12;font-weight:800;margin:0 0 10px;
  letter-spacing:-.02em;}
.dp-lede{color:rgba(245,241,234,.88);font-size:17px;line-height:1.5;margin:0 0 6px;}
.dp-greet{color:rgba(245,241,234,.72);font-size:16px;line-height:1.5;margin:0;}
.dp-h2{color:var(--white);font-size:19px;font-weight:700;margin:0 0 12px;}

/* card */
.dp-card{background:var(--white);border-radius:16px;padding:22px 18px;
  box-shadow:0 18px 44px rgba(0,0,0,.32);}
.dp-details{margin:0 0 16px;padding:0;}
.dp-row{display:flex;justify-content:space-between;gap:14px;padding:11px 0;
  border-bottom:1px solid var(--dbone);}
.dp-row dt{color:var(--muted);font-size:16px;margin:0;}
.dp-row dd{color:var(--ink);font-size:16px;font-weight:600;margin:0;text-align:right;}

/* money */
.dp-money{background:var(--bone);border-radius:13px;padding:16px;margin:0 0 14px;}
.dp-mrow{display:flex;justify-content:space-between;align-items:baseline;gap:14px;padding:7px 0;}
.dp-mlabel{color:var(--muted);font-size:16px;}
.dp-mval{color:var(--ink);font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;}
.dp-hero{display:flex;justify-content:space-between;align-items:baseline;gap:14px;
  padding:13px 0;margin:6px 0;border-top:1px solid var(--dbone);border-bottom:1px solid var(--dbone);}
.dp-herolabel{color:var(--navy);font-size:17px;font-weight:700;}
.dp-heroval{color:var(--cta);font-size:36px;font-weight:800;line-height:1;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em;}
.dp-applied{color:#3F4854;font-size:15px;line-height:1.5;margin:0 0 18px;}

/* action */
.dp-pay{display:block;width:100%;border:none;border-radius:12px;background:var(--cta);
  color:var(--white);font-size:19px;font-weight:700;min-height:56px;padding:16px 20px;
  cursor:pointer;font-family:inherit;-webkit-appearance:none;text-align:center;
  text-decoration:none;line-height:1.25;}
.dp-pay[disabled]{opacity:.72;cursor:progress;}
.dp-paylink{display:block;}
.dp-secondary{margin-top:12px;border:1.5px solid var(--navy);border-radius:10px;
  background:var(--white);color:var(--navy);font-size:16px;font-weight:600;
  min-height:44px;padding:11px 18px;cursor:pointer;font-family:inherit;width:100%;}
.dp-stripe{color:var(--muted);font-size:14px;text-align:center;margin:14px 0 0;}

/* messages — never colour alone: each carries an icon and a border */
.dp-notice{background:#FFFBEB;border:1px solid #F1D48A;border-left:4px solid var(--gold);
  color:#7A5A12;border-radius:10px;padding:12px 14px;font-size:15px;line-height:1.5;margin:0 0 16px;}
.dp-error{background:#FEF2F2;border:1px solid #F5B5B5;border-left:4px solid #B42318;
  color:#8A1C13;border-radius:10px;padding:12px 14px;font-size:15px;line-height:1.5;margin:0 0 14px;}
.dp-status{padding:6px 0 2px;}
.dp-statush{color:var(--navy);font-size:20px;font-weight:700;margin:0 0 8px;}
.dp-statusb{color:#3F4854;font-size:16px;line-height:1.55;margin:0 0 8px;}
.dp-badge{display:inline-block;background:#ECFDF5;border:1px solid #7FD9AE;color:#05603A;
  border-radius:999px;padding:8px 15px;font-size:15px;font-weight:700;margin:0 0 14px;}

/* policy */
.dp-policy{border-top:1px solid var(--dbone);margin-top:20px;padding-top:16px;}
.dp-polh{color:var(--navy);font-size:16px;font-weight:700;margin:0 0 8px;}
.dp-polb{color:#4A5361;font-size:15px;line-height:1.6;margin:0 0 8px;}
.dp-link{color:var(--cta);font-weight:600;}

/* reassurance */
.dp-list{margin:0;padding:0 0 0 22px;color:rgba(245,241,234,.86);font-size:16px;line-height:1.6;}
.dp-list li{margin-bottom:9px;}
.dp-list li::marker{color:var(--gold);}
.dp-help{margin-top:20px;padding-top:18px;border-top:1px solid rgba(245,241,234,.16);}
.dp-helph{color:var(--white);font-size:16px;font-weight:700;margin:0 0 12px;}
.dp-helpbtns{display:flex;gap:10px;flex-wrap:wrap;}
.dp-ghost{flex:1 1 auto;min-width:140px;display:inline-flex;align-items:center;
  justify-content:center;min-height:48px;padding:12px 16px;border-radius:10px;
  border:1.5px solid rgba(245,241,234,.42);color:var(--bone);text-decoration:none;
  font-size:16px;font-weight:600;text-align:center;}

/* focus — visible for everyone, on every control */
.dp-page a:focus-visible,.dp-page button:focus-visible{outline:3px solid var(--orange);
  outline-offset:3px;border-radius:8px;}

/* DESKTOP: a balanced two-column container, not a small card in a navy void.
   The card spans both rows so the intro sits beside it and the reassurance
   fills the space underneath rather than leaving it empty. */
@media (min-width:900px){
  .dp-page{padding:34px 24px 64px;}
  .dp-head{margin-bottom:30px;}
  .dp-grid{grid-template-columns:minmax(0,1fr) minmax(0,1.02fr);gap:44px;align-items:start;}
  .dp-intro{grid-column:1;grid-row:1;}
  .dp-reassure{grid-column:1;grid-row:2;margin-top:6px;}
  .dp-cardcol{grid-column:2;grid-row:1 / span 2;}
  .dp-h1{font-size:42px;margin-bottom:14px;}
  .dp-lede{font-size:19px;}
  .dp-card{padding:28px 26px;}
  .dp-heroval{font-size:42px;}
}
@media (min-width:1200px){ .dp-grid{gap:56px;} }

/* Small phones: keep every price on one line and nothing clipped. */
@media (max-width:360px){
  .dp-page{padding:16px 12px 40px;}
  .dp-h1{font-size:27px;}
  .dp-heroval{font-size:31px;}
  .dp-pay{font-size:17px;}
  .dp-word{font-size:12px;letter-spacing:.10em;}
  .dp-ghost{min-width:100%;}
}

@media (prefers-reduced-motion:reduce){
  .dp-page *{animation:none !important;transition:none !important;}
}
`
