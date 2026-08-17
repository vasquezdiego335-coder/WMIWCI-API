import { headers } from 'next/headers'
import { businessPhone } from '@/lib/business-contact'
import { COPY, pickLang } from '@/lib/deposit-copy'

// A bad or retired token gets the SAME neutral page whether the link never
// existed or was deleted. Distinguishing them would turn this route into an
// oracle for guessing tokens.
//
// Bilingual like the rest of the flow — a Spanish speaker who mistypes a link
// should not fall out of Spanish at the one moment they need to understand what
// went wrong.
export default function DepositNotFound() {
  const lang = pickLang(headers().get('accept-language'))
  const t = COPY[lang]
  const phone = businessPhone()

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(170deg, #0A1628 0%, #0D1F3C 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <div style={{ background: '#FFFFFF', borderRadius: '16px', padding: '30px 24px', maxWidth: '460px', width: '100%' }}>
        <h1 style={{ fontSize: '25px', fontWeight: 800, color: '#0A1628', margin: '0 0 12px', lineHeight: 1.2 }}>
          {t.invalidTitle}
        </h1>
        <p style={{ fontSize: '16px', color: '#3F4854', margin: '0 0 22px', lineHeight: 1.55 }}>{t.invalidBody}</p>
        <a
          href={`tel:${phone.tel}`}
          style={{
            display: 'block', background: '#D2450F', color: '#FFFFFF', borderRadius: '12px',
            padding: '16px 20px', minHeight: '56px', fontWeight: 700, fontSize: '18px',
            textDecoration: 'none', textAlign: 'center', boxSizing: 'border-box',
          }}
        >
          {t.callUs} {phone.display}
        </a>
      </div>
    </main>
  )
}
