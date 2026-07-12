import * as React from 'react'
import {
  Shell,
  LogoHeader,
  AnimatedHero,
  Card,
  Eyebrow,
  Pill,
  Callout,
  Checklist,
  Spacer,
  PrimaryButton,
  ContactRow,
  Footer,
  C,
  FONT,
  P,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  ABANDONED CHECKOUT  ("Your date is still available")
//  Rebuilt on the shared _ui kit to match the transactional emails. One nudge,
//  one CTA back to checkout, a short reason-to-book. Bilingual EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  checkoutUrl?: string
  requestedDate?: string
  amountHold?: string
  portalUrl?: string
  heroGifUrl?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function AbandonedCheckoutEmail({
  customerName = 'there',
  checkoutUrl = '#',
  requestedDate,
  amountHold = '49',
  portalUrl = '#',
  heroGifUrl,
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const dateStr = requestedDate
    ? new Date(requestedDate).toLocaleDateString(es ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })
    : undefined

  const t = es
    ? {
        preview: `Tu fecha sigue disponible — termina tu reserva con un depósito de $${amountHold}.`,
        pill: 'Casi listo',
        h1: 'Tu fecha sigue disponible.',
        sub: `Hola ${customerName}, empezaste tu reserva pero no completaste el depósito de $${amountHold}${dateStr ? ` para el ${dateStr}` : ''}. Asegúrala antes de que alguien más la tome.`,
        whyTitle: 'Por qué reservar con nosotros',
        why: [
          'Solo mano de obra — pagas por músculo, no por el margen del intermediario.',
          'Equipo con antecedentes verificados · equipo incluido.',
          'Precio fijo — sin cargos ocultos.',
        ],
        cta: 'Completar mi reserva',
        holdNote: `El depósito de $${amountHold} es una retención — solo asegura tu lugar y se aplica al total de tu mudanza.`,
        supportTitle: '¿Preguntas?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Te escribimos porque comenzaste una reserva con nosotros. ¿Ya no la necesitas? Puedes ignorar este correo.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `Your date is still open — finish your booking with a $${amountHold} deposit.`,
        pill: 'Almost there',
        h1: 'Your date is still available.',
        sub: `Hi ${customerName}, you started your booking but didn't finish the $${amountHold} deposit${dateStr ? ` for ${dateStr}` : ''}. Lock it in before someone else takes the slot.`,
        whyTitle: 'Why book with us',
        why: [
          'Labor-only — you pay for muscle, not a middleman markup.',
          'Background-checked crew · equipment included.',
          'Flat-rate pricing — no hidden fees.',
        ],
        cta: 'Complete my booking',
        holdNote: `The $${amountHold} deposit is a hold — it just secures your slot and applies to your move total.`,
        supportTitle: 'Questions?',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: "You're receiving this because you started a booking with us. Changed your mind? You can ignore this email.",
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.orange}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <AnimatedHero heroGifUrl={heroGifUrl} />
          <Spacer h={16} />
          <Pill tone="orange">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '26px', lineHeight: '33px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '430px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      {/* ── 2 · CTA ──────────────────────────────────────────── */}
      <Spacer h={24} />
      <PrimaryButton href={checkoutUrl} label={t.cta} />
      <Spacer h={14} />
      <div style={{ textAlign: 'center' as const, fontFamily: FONT, fontSize: '12.5px', lineHeight: '19px', color: C.muted, maxWidth: '420px', margin: '0 auto', padding: '0 10px' }}>
        {t.holdNote}
      </div>
      <Spacer h={24} />

      {/* ── 3 · WHY BOOK WITH US ─────────────────────────────── */}
      <Card>
        <Eyebrow icon="shield" title={t.whyTitle} tone="gold" />
        <Checklist items={t.why} />
      </Card>

      <Spacer h={16} />

      {/* ── 4 · SUPPORT ──────────────────────────────────────── */}
      <Card>
        <Eyebrow icon="phone" title={t.supportTitle} tone="navy" />
        <ContactRow phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />
      </Card>

      {/* ── 5 · FOOTER ───────────────────────────────────────── */}
      <Footer
        disclaimer={t.disclaimer}
        phone={phone}
        email={email}
        websiteLabel={websiteLabel}
        social={social}
        manageUrl={portalUrl}
        unsubscribeUrl={portalUrl}
        labels={t.footerLabels}
      />
    </Shell>
  )
}
