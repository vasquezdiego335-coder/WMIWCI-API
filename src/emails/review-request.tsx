import * as React from 'react'
import {
  Shell,
  LogoHeader,
  Card,
  Eyebrow,
  Pill,
  Callout,
  Spacer,
  PrimaryButton,
  ContactRow,
  MarketingFooter,
  C,
  FONT,
  P,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  REVIEW REQUEST  ("How did we do?")
//  Rebuilt on the shared _ui kit to match the transactional emails. Short by
//  design — one warm ask, one gold-star row, one CTA. Bilingual EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  googleReviewUrl?: string
  portalUrl?: string
  heroGifUrl?: string
  /** Promotional unsubscribe URL (NEVER the booking page). Optional until the
      unsubscribe route ships — omitted rather than faked. */
  unsubscribeUrl?: string
  postalAddress?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function ReviewRequestEmail({
  customerName = 'there',
  googleReviewUrl = '#',
  portalUrl = '#',
  unsubscribeUrl,
  postalAddress,
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')

  const t = es
    ? {
        preview: `¿Cómo lo hicimos, ${customerName}? Tu reseña ayuda muchísimo.`,
        pill: 'Gracias',
        h1: '¿Cómo lo hicimos?',
        sub: `Fue un placer ayudarte con tu mudanza, ${customerName}. Si tienes 60 segundos, una reseña en Google hace una gran diferencia para nuestro negocio local.`,
        starNote: 'Toca las estrellas para dejar tu reseña',
        cta: 'Dejar una reseña en Google',
        thanks: 'Gracias por confiar en nosotros — significa mucho para todo el equipo.',
        supportTitle: '¿Algo que podamos mejorar?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Te escribimos porque completamos tu mudanza recientemente. ¿Algún problema? Responde a este correo — lo resolvemos.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `How did we do, ${customerName}? Your review means a lot.`,
        pill: 'Thank you',
        h1: 'How did we do?',
        sub: `It was a pleasure handling your move, ${customerName}. If you have 60 seconds, a Google review makes a huge difference for our small local business.`,
        starNote: 'Tap the stars to leave your review',
        cta: 'Leave a Google review',
        thanks: 'Thank you for trusting us — it means everything to the whole crew.',
        supportTitle: 'Something we could do better?',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: "You're receiving this because we recently completed your move. Something wrong? Just reply to this email — we'll make it right.",
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.gold}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          {/* five gold stars */}
          <div style={{ fontSize: '30px', lineHeight: '30px', letterSpacing: '4px', color: C.gold }}>&#9733;&#9733;&#9733;&#9733;&#9733;</div>
          <Spacer h={16} />
          <Pill tone="gold">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '27px', lineHeight: '34px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '430px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      {/* ── 2 · CTA ──────────────────────────────────────────── */}
      <Spacer h={24} />
      <div style={{ textAlign: 'center' as const, fontFamily: FONT, fontSize: '12px', fontWeight: 700, letterSpacing: '0.4px', color: C.label, textTransform: 'uppercase' as const, marginBottom: '12px' }}>
        {t.starNote}
      </div>
      <PrimaryButton href={googleReviewUrl} label={t.cta} />
      <Spacer h={26} />

      {/* ── 3 · THANK YOU ────────────────────────────────────── */}
      <Callout tone="bone">
        <div style={{ fontFamily: FONT, fontSize: '14px', lineHeight: '22px', color: C.body, textAlign: 'center' as const }}>{t.thanks}</div>
      </Callout>

      <Spacer h={16} />

      {/* ── 4 · SUPPORT ──────────────────────────────────────── */}
      <Card>
        <Eyebrow icon="phone" title={t.supportTitle} tone="navy" />
        <ContactRow phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />
      </Card>

      {/* ── 5 · FOOTER ───────────────────────────────────────── */}
      <MarketingFooter
        disclaimer={t.disclaimer}
        phone={phone}
        email={email}
        websiteLabel={websiteLabel}
        social={social}
        unsubscribeUrl={unsubscribeUrl}
        postalAddress={postalAddress}
        labels={t.footerLabels}
      />
    </Shell>
  )
}
