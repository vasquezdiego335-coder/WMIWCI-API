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
      <style>{CSS}</style>
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

const CSS = `
.nf-hero,.nf-body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;}
.nf-hero *,.nf-body *{box-sizing:border-box;}
.nf-hero{position:relative;background:
  linear-gradient(100deg,rgba(10,22,40,1) 0%,rgba(10,22,40,1) 26%,rgba(10,22,40,.92) 44%,
    rgba(10,22,40,.66) 58%,rgba(10,22,40,.44) 76%,rgba(10,22,40,.5) 100%),
  linear-gradient(to bottom,rgba(10,22,40,.55) 0%,rgba(10,22,40,.06) 40%,rgba(10,22,40,.6) 100%),
  url('/img/move-it-clear-it-hero-poster-mobile.webp') center 28%/cover no-repeat,#0A1628;
  padding:0 0 30px;}
.nf-hairline{height:4px;background:linear-gradient(90deg,#C9A961 0%,#C9A961 44%,
  rgba(201,169,97,.5) 72%,rgba(201,169,97,0) 100%);}
.nf-inner{max-width:640px;margin:0 auto;padding:16px 18px 0;}
.nf-brand{display:inline-flex;align-items:center;gap:11px;margin-bottom:26px;}
.nf-mark{display:block;width:44px;height:44px;border-radius:10px;
  box-shadow:0 0 0 1px rgba(245,241,234,.14),0 6px 16px rgba(0,0,0,.34);}
.nf-word{color:#F5F1EA;font-weight:700;font-size:13px;letter-spacing:.17em;
  text-transform:uppercase;text-shadow:0 1px 3px rgba(0,0,0,.5);}
.nf-h1{font-family:Archivo,Inter,sans-serif;font-weight:800;font-size:40px;line-height:.99;
  letter-spacing:-.022em;color:#F5F1EA;margin:0;text-shadow:0 2px 14px rgba(0,0,0,.45);}
.nf-h1 span{display:block;}
.nf-accent{color:#FF5A1F;}
.nf-body{background:#F5F1EA;padding:0 16px 48px;min-height:40vh;}
.nf-card{max-width:640px;margin:-18px auto 0;background:#FFFFFF;border-radius:16px;
  padding:26px 20px;box-shadow:0 16px 40px rgba(10,22,40,.16),0 2px 6px rgba(10,22,40,.06);}
.nf-h2{font-family:Archivo,Inter,sans-serif;font-size:23px;font-weight:700;color:#0A1628;
  margin:0 0 12px;line-height:1.2;}
.nf-p{font-size:16px;color:#3F4854;margin:0 0 22px;line-height:1.55;}
.nf-cta{display:flex;align-items:center;justify-content:center;background:#D2450F;
  color:#FFFFFF;border-radius:12px;padding:16px 20px;min-height:56px;font-weight:700;
  font-size:18px;font-family:Archivo,Inter,sans-serif;text-decoration:none;text-align:center;}
.nf-alt{display:flex;align-items:center;justify-content:center;margin-top:10px;
  min-height:48px;padding:12px 16px;border-radius:10px;border:1.5px solid rgba(10,22,40,.22);
  color:#0A1628;text-decoration:none;font-size:16px;font-weight:600;}
.nf-es{color:#5A6473;font-size:15px;margin:14px 0 0;}
.nf-body a:focus-visible,.nf-hero a:focus-visible{outline:3px solid #FF5A1F;outline-offset:3px;border-radius:8px;}
@media (min-width:700px){
  .nf-hero{background:
    linear-gradient(100deg,rgba(10,22,40,1) 0%,rgba(10,22,40,1) 24%,rgba(10,22,40,.93) 42%,
      rgba(10,22,40,.6) 56%,rgba(10,22,40,.32) 74%,rgba(10,22,40,.42) 100%),
    linear-gradient(to bottom,rgba(10,22,40,.5) 0%,rgba(10,22,40,.04) 40%,rgba(10,22,40,.58) 100%),
    url('/img/move-it-clear-it-hero-poster.webp') center 30%/cover no-repeat,#0A1628;
    padding-bottom:42px;}
  .nf-inner{padding:20px 24px 0;}
  .nf-h1{font-size:54px;}
  .nf-card{margin-top:-24px;padding:32px;}
}
@media (max-width:360px){
  .nf-h1{font-size:33px;}
  .nf-inner{padding:14px 14px 0;}
  .nf-card{padding:22px 16px;}
}
@media (prefers-reduced-motion:reduce){.nf-hero *,.nf-body *{animation:none !important;transition:none !important;}}
`
