import * as React from 'react'
import {
  Shell,
  LogoHeader,
  IconChip,
  Card,
  Eyebrow,
  HeroBlock,
  Callout,
  Checklist,
  Spacer,
  PrimaryButton,
  SupportBlock,
  Footer,
  C,
  FONT,
  P,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  INFORMATION REQUIRED  ("We need a few details to schedule your move")
//  Sent when a booking request can't move forward until the customer supplies
//  missing info (exact address, unit/access, inventory, a preferred window…).
//  Transactional. NEVER says "confirmed" — the booking is still pending. The
//  list of what's missing is DYNAMIC (`missing` prop); nothing is invented.
//  Bilingual EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  /** The specific items we still need — rendered as a checklist. Dynamic. */
  missing?: string[]
  /** Secure link back to the booking to supply the details. Required (CTA). */
  portalUrl?: string
  deadline?: string // human deadline, e.g. "within 48 hours"
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function InformationRequiredEmail({
  customerName = 'there',
  displayId,
  missing,
  portalUrl = '#',
  deadline,
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const items = (missing || []).filter((m) => m && m.trim())

  const t = es
    ? {
        preview: `Necesitamos algunos datos para agendar tu mudanza${displayId ? ` (${displayId})` : ''}.`,
        pill: 'Se necesita tu respuesta',
        h1: 'Necesitamos algunos datos más.',
        sub: `Hola ${customerName}, casi listos. Para revisar y agendar tu mudanza necesitamos que completes lo siguiente${deadline ? ` ${deadline}` : ''}.`,
        needTitle: 'Lo que necesitamos',
        genericNeed: 'Faltan algunos datos de tu solicitud. Abre tu reserva y completa lo que aparezca marcado.',
        cta: 'Completar mis datos',
        note: 'Tu solicitud sigue pendiente — no se ha agendado ni cobrado nada hasta que confirmemos estos datos.',
        supportTitle: '¿Necesitas ayuda?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Recibiste este correo porque hay una solicitud de mudanza pendiente a tu nombre.',
        footerLabels: { rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `We need a few details to schedule your move${displayId ? ` (${displayId})` : ''}.`,
        pill: 'Response needed',
        h1: 'We need a few more details.',
        sub: `Hi ${customerName}, we're almost there. To review and schedule your move, we just need you to complete the following${deadline ? ` ${deadline}` : ''}.`,
        needTitle: 'What we need',
        genericNeed: 'A few details on your request are missing. Open your booking and complete anything flagged.',
        cta: 'Complete my details',
        note: "Your request is still pending — nothing is scheduled or charged until we confirm these details.",
        supportTitle: 'Need a hand?',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: "You're receiving this because there's a pending move request under your name.",
        footerLabels: { rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <HeroBlock
        accent={C.orange}
        hero={<IconChip icon="clipboard" color={C.orangeInk} size={26} dim={64} bg={C.orangeTint} border="none" radius={18} />}
        pill={t.pill}
        pillTone="orange"
        title={t.h1}
        sub={t.sub}
        titleSize={25}
        subMaxWidth={440}
      />

      <Spacer h={16} />

      {/* ── 2 · WHAT WE NEED ─────────────────────────────────── */}
      <Card>
        <Eyebrow icon="checklist" title={t.needTitle} tone="orange" />
        {items.length ? (
          <Checklist items={items} />
        ) : (
          <p style={{ ...P, marginBottom: 0 }}>{t.genericNeed}</p>
        )}
      </Card>

      {/* ── 3 · CTA ──────────────────────────────────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={portalUrl} label={t.cta} />
      <Spacer h={22} />

      {/* ── 4 · PENDING NOTE ─────────────────────────────────── */}
      <Callout tone="bone">
        <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{t.note}</div>
      </Callout>

      <Spacer h={16} />

      {/* ── 5 · SUPPORT ──────────────────────────────────────── */}
      <SupportBlock title={t.supportTitle} phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />

      {/* ── 6 · FOOTER (transactional) ───────────────────────── */}
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
