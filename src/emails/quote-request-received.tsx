import * as React from 'react'
import {
  Shell,
  LogoHeader,
  Card,
  Pill,
  Callout,
  Spacer,
  SupportBlock,
  Footer,
  IconChip,
  C,
  FONT,
  P,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  QUOTE REQUEST RECEIVED  ("We received your moving estimate request")
//
//  Owner spec 2026-08-03. Sent ONCE, immediately, when someone completes the
//  contact step of the quick quote and an estimate has been produced.
//
//  THIS IS TRANSACTIONAL, NOT MARKETING. It is the reply to a request the
//  customer just made, so it is registered in email-guard's
//  TRANSACTIONAL_TEMPLATES: no unsubscribe row, no frequency cap, no quiet
//  hours, and — critically — sending it NEVER enrols anyone in a promotional
//  sequence. Consent for that is a separate, unticked checkbox on the form.
//
//  THE ESTIMATE PARAGRAPH IS CONDITIONAL BY DESIGN. The owner's rule: "If no
//  estimate exists yet, omit the estimated-price paragraph instead of
//  displaying an empty value." A sentence reading "your preliminary estimate
//  is approximately $" or "... is approximately the amount shown above" would
//  be worse than saying nothing, so `estimatedPrice` absent ⇒ the whole
//  paragraph is dropped. NOTE: this is why the template does NOT use the
//  shared money() helper, which substitutes prose for a missing amount.
//
//  The wording below is the owner's, kept sentence-for-sentence. Do not
//  "improve" it — the preliminary-estimate disclaimer is a commitment about
//  what the number does and does not mean.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  firstName?: string
  /** Pre-formatted display amount, e.g. "$1,049". ABSENT (not empty string)
   *  when no estimate could be produced — see the header note. */
  estimatedPrice?: string
  /** Echoed back so the customer can see what we based the number on. */
  moveDate?: string
  moveSize?: string
  businessPhone?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

/** An estimate is shown only when it is a non-empty, non-zero-looking string.
 *  Guards the exact failure the owner called out: a blank or "$0" price. */
function hasEstimate(value?: string): value is string {
  const s = (value ?? '').trim()
  if (!s) return false
  return /[1-9]/.test(s)
}

export default function QuoteRequestReceivedEmail({
  firstName = 'there',
  estimatedPrice,
  moveDate,
  moveSize,
  businessPhone = '862-640-0625',
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const showEstimate = hasEstimate(estimatedPrice)

  const dateStr = moveDate
    ? new Date(moveDate).toLocaleDateString(es ? 'es-US' : 'en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/New_York',
      })
    : undefined

  const t = es
    ? {
        preview: showEstimate
          ? `Recibimos su solicitud de estimado — aproximadamente ${estimatedPrice}.`
          : 'Recibimos su solicitud de estimado de mudanza.',
        pill: 'Solicitud recibida',
        h1: 'Recibimos su solicitud de estimado de mudanza',
        greeting: `Hola ${firstName},`,
        thanks: 'Gracias por solicitar un estimado a Move It Clear It.',
        estimate: `Según la información que nos dio, su estimado preliminar es de aproximadamente ${estimatedPrice}.`,
        estimateLabel: 'Su estimado preliminar',
        speak: 'Con gusto hablamos con usted para confirmar los detalles de la mudanza y darle su precio final.',
        reply: `Puede responder a este correo con la mejor hora para llamarle, o llamarnos o enviarnos un mensaje directamente al ${businessPhone}.`,
        detailsTitle: 'Lo que nos dio',
        dateLabel: 'Fecha de mudanza',
        sizeLabel: 'Tamaño',
        signOffName: 'Move It Clear It',
        signOffTag: 'Ayuda local de mudanza',
        note: 'Tenga en cuenta que el estimado en línea es preliminar y puede cambiar después de que confirmemos el inventario, las escaleras, las ubicaciones, el tamaño del camión y otros detalles de la mudanza.',
        supportTitle: '¿Hablamos?',
        contactLabels: { phone: 'Llame o escriba', email: 'Correo', website: 'Sitio web' },
        disclaimer:
          'Le enviamos este correo porque solicitó un estimado de mudanza en moveitclearit.com. Es una respuesta a su solicitud, no un correo promocional.',
        footerLabels: { rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: showEstimate
          ? `We received your estimate request — approximately ${estimatedPrice}.`
          : 'We received your moving estimate request.',
        pill: 'Request received',
        h1: 'We received your moving estimate request',
        greeting: `Hi ${firstName},`,
        thanks: 'Thank you for requesting an estimate from Move It Clear It.',
        estimate: `Based on the information you provided, your preliminary estimate is approximately ${estimatedPrice}.`,
        estimateLabel: 'Your preliminary estimate',
        speak: 'We would be happy to speak with you to confirm the move details and provide your final price.',
        reply: `You can reply to this email with the best time to call, or call or text us directly at ${businessPhone}.`,
        detailsTitle: 'What you told us',
        dateLabel: 'Move date',
        sizeLabel: 'Size',
        signOffName: 'Move It Clear It',
        signOffTag: 'Local Moving Help',
        note: 'Please note that the online estimate is preliminary and may change after we confirm the inventory, stairs, locations, truck size, and other move details.',
        supportTitle: 'Let’s talk',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer:
          'You are receiving this because you requested a moving estimate at moveitclearit.com. It is a reply to your request, not a promotional email.',
        footerLabels: { rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.orange}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <IconChip icon="clipboard" color={C.orange} size={26} dim={64} bg={C.orangeTint} border="none" radius={18} />
          <Spacer h={16} />
          <Pill tone="orange">{t.pill}</Pill>
          <h1
            className="h1"
            style={{
              fontFamily: FONT,
              fontSize: '25px',
              lineHeight: '32px',
              fontWeight: 800,
              letterSpacing: '-0.4px',
              color: C.navy,
              margin: '16px 0 10px',
            }}
          >
            {t.h1}
          </h1>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · THE MESSAGE (owner's copy, sentence for sentence) ── */}
      <Card>
        <p style={{ ...P, fontWeight: 700, color: C.navy }}>{t.greeting}</p>
        <p style={P}>{t.thanks}</p>

        {/* THE CONDITIONAL PARAGRAPH. No estimate ⇒ no sentence at all. */}
        {showEstimate ? <p style={P}>{t.estimate}</p> : null}

        <p style={P}>{t.speak}</p>
        <p style={{ ...P, marginBottom: 0 }}>{t.reply}</p>
      </Card>

      {/* ── 3 · THE NUMBER, called out (only when there is one) ── */}
      {showEstimate ? (
        <>
          <Spacer h={16} />
          <Callout tone="bone">
            <div
              style={{
                fontFamily: FONT,
                fontSize: '12px',
                letterSpacing: '0.08em',
                textTransform: 'uppercase' as const,
                color: C.body,
                marginBottom: '4px',
              }}
            >
              {t.estimateLabel}
            </div>
            <div style={{ fontFamily: FONT, fontSize: '30px', lineHeight: '36px', fontWeight: 800, color: C.navy }}>
              {estimatedPrice}
            </div>
          </Callout>
        </>
      ) : null}

      {/* ── 4 · WHAT WE BASED IT ON ──────────────────────────── */}
      {dateStr || moveSize ? (
        <>
          <Spacer h={16} />
          <Card>
            <div style={{ fontFamily: FONT, fontSize: '15px', fontWeight: 800, color: C.navy, marginBottom: '8px' }}>
              {t.detailsTitle}
            </div>
            <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
              <tbody>
                {dateStr ? (
                  <tr>
                    <td style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '22px', color: C.body }}>{t.dateLabel}</td>
                    <td style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '22px', color: C.navy, fontWeight: 700, textAlign: 'right' as const }}>
                      {dateStr}
                    </td>
                  </tr>
                ) : null}
                {moveSize ? (
                  <tr>
                    <td style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '22px', color: C.body }}>{t.sizeLabel}</td>
                    <td style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '22px', color: C.navy, fontWeight: 700, textAlign: 'right' as const }}>
                      {moveSize}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Card>
        </>
      ) : null}

      {/* ── 5 · SIGN-OFF ─────────────────────────────────────── */}
      <Spacer h={16} />
      <Card>
        <div style={{ fontFamily: FONT, fontSize: '15px', fontWeight: 800, color: C.navy }}>{t.signOffName}</div>
        <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{t.signOffTag}</div>
        <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{websiteLabel}</div>
      </Card>

      {/* ── 6 · THE PRELIMINARY-ESTIMATE COMMITMENT ──────────── */}
      <Spacer h={16} />
      <Callout tone="bone">
        <div style={{ fontFamily: FONT, fontSize: '13px', lineHeight: '20px', color: C.body }}>{t.note}</div>
      </Callout>

      {/* ── 7 · SUPPORT ──────────────────────────────────────── */}
      <Spacer h={16} />
      <SupportBlock
        title={t.supportTitle}
        phone={phone}
        email={email}
        website={website}
        websiteLabel={websiteLabel}
        labels={t.contactLabels}
      />

      {/* ── 8 · FOOTER — transactional kind: no unsubscribe row ── */}
      <Footer
        disclaimer={t.disclaimer}
        phone={phone}
        email={email}
        websiteLabel={websiteLabel}
        social={social}
        labels={t.footerLabels}
      />
    </Shell>
  )
}
