import './deposit.css'
import { headers } from 'next/headers'
import { businessPhone } from '@/lib/business-contact'
import { COPY, pickLang } from '@/lib/deposit-copy'

// A bad or retired token gets the SAME neutral page whether the link never
// existed or was deleted. Distinguishing them would turn this route into an
// oracle for guessing tokens.
//
// It also gets the SAME brand treatment as every other state — photographic
// navy header, gold hairline, bare logo lockup, bone body, one card. A customer
// whose link is wrong should still land somewhere that is obviously us; a bare
// error page is where trust in a payment link dies.
//
// Bilingual, because someone who mistypes a link should not fall out of Spanish
// at the one moment they need to understand what went wrong.
export default function DepositNotFound() {
  const lang = pickLang(headers().get('accept-language'))
  const t = COPY[lang]
  const phone = businessPhone()

  return (
    <>
      {/* Styles come from ./deposit.css via the segment layout — never an
          inline style element, whose text the server HTML-escapes and the
          client does not (React #425), and whose url() the parser never
          decodes. */}
      <header className="nf-hero">
        <div className="nf-hairline" aria-hidden="true" />
        <div className="nf-inner">
          <span className="nf-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="nf-mark" src="/icon.svg" alt="" width={44} height={44} />
            <span className="nf-word">{t.brand}</span>
          </span>
          <h1 className="nf-h1">
            <span>{t.titleLead}</span>
            <span className="nf-accent">{t.titleAccent}</span>
          </h1>
        </div>
      </header>

      <main className="nf-body">
        <div className="nf-card">
          <h2 className="nf-h2">{t.invalidTitle}</h2>
          <p className="nf-p">{t.invalidBody}</p>
          <a className="nf-cta" href={`tel:${phone.tel}`}>
            {t.callUs} {phone.display}
          </a>
          <a className="nf-alt" href={`sms:${phone.sms}`}>{t.textUs}</a>
          <p className="nf-es">{t.seHablaEspanol}</p>
        </div>
      </main>
    </>
  )
}
