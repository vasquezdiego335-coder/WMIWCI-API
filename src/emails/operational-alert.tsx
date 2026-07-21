import * as React from 'react'
import {
  Shell,
  LogoHeader,
  IconChip,
  Card,
  Eyebrow,
  HeroBlock,
  Callout,
  Spacer,
  PrimaryButton,
  SupportBlock,
  Footer,
  C,
  FONT,
  P,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  OPERATIONAL ALERT  ("An update about your move")
//  A customer-facing operational notice: a crew running late, a weather delay,
//  or a needed reschedule. The BODY (`message`) is DYNAMIC and supplied by the
//  sender — the template never invents a reason, a new time, or an apology it
//  can't back. Transactional. Reschedule details render ONLY when provided.
//  Bilingual EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  alertType?: 'delay' | 'reschedule' | 'weather' | 'general'
  /** The actual operational message. Required — the alert is empty without it. */
  message?: string
  newDate?: string // reschedule: proposed/updated date (ISO)
  newTimeLabel?: string // reschedule: arrival window label
  /** Link to view or manage the booking. */
  portalUrl?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function OperationalAlertEmail({
  customerName = 'there',
  displayId,
  alertType = 'general',
  message,
  newDate,
  newTimeLabel,
  portalUrl = '#',
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const newDateStr = newDate
    ? new Date(newDate).toLocaleDateString(es ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })
    : undefined

  const heading = es
    ? { delay: 'Tu equipo va con retraso.', reschedule: 'Necesitamos reprogramar tu mudanza.', weather: 'El clima afecta tu mudanza.', general: 'Una actualización sobre tu mudanza.' }
    : { delay: 'Your crew is running late.', reschedule: 'We need to reschedule your move.', weather: 'Weather is affecting your move.', general: 'An update about your move.' }

  const icon = ({ delay: 'clock', reschedule: 'calendar', weather: 'shield', general: 'shield' } as const)[alertType]

  const t = es
    ? {
        preview: `Una actualización sobre tu mudanza${displayId ? ` (${displayId})` : ''}.`,
        pill: 'Actualización de tu mudanza',
        h1: heading[alertType],
        sub: `Hola ${customerName}, queremos mantenerte al tanto sobre tu mudanza.`,
        detailTitle: 'Qué está pasando',
        genericMsg: 'Necesitamos comunicarnos contigo sobre tu mudanza. Por favor llámanos o escríbenos y lo resolvemos.',
        newTitle: 'Nueva fecha propuesta',
        cta: 'Ver mi reserva',
        supportTitle: 'Hablemos',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Recibiste este correo porque tienes una mudanza activa con nosotros.',
        footerLabels: { rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `An update about your move${displayId ? ` (${displayId})` : ''}.`,
        pill: 'Move update',
        h1: heading[alertType],
        sub: `Hi ${customerName}, we want to keep you in the loop about your move.`,
        detailTitle: "What's going on",
        genericMsg: 'We need to reach you about your move. Please call or text us and we’ll sort it out together.',
        newTitle: 'Proposed new date',
        cta: 'View booking',
        supportTitle: "Let's talk",
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: "You're receiving this because you have an active move with us.",
        footerLabels: { rights: 'All rights reserved.' },
      }

  const body = message && message.trim() ? message : t.genericMsg

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <HeroBlock
        accent={C.orange}
        hero={<IconChip icon={icon} color={C.orangeInk} size={26} dim={64} bg={C.orangeTint} border="none" radius={18} />}
        pill={t.pill}
        pillTone="orange"
        title={t.h1}
        sub={t.sub}
        titleSize={25}
        subMaxWidth={440}
      />

      <Spacer h={16} />

      {/* ── 2 · MESSAGE (dynamic) ────────────────────────────── */}
      <Card>
        <Eyebrow icon={icon} title={t.detailTitle} tone="navy" />
        <p style={{ ...P, marginBottom: 0, whiteSpace: 'pre-line' as const }}>{body}</p>
      </Card>

      {/* ── 3 · RESCHEDULE DETAILS (only if provided) ────────── */}
      {alertType === 'reschedule' && (newDateStr || newTimeLabel) ? (
        <>
          <Spacer h={16} />
          <Callout tone="gold">
            <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.2px', textTransform: 'uppercase' as const, color: C.goldInk, marginBottom: '6px' }}>{t.newTitle}</div>
            <div style={{ fontFamily: FONT, fontSize: '17px', fontWeight: 800, color: C.navy }}>
              {newDateStr}
              {newTimeLabel ? <span style={{ fontWeight: 600, color: C.body }}>{newDateStr ? ' · ' : ''}{newTimeLabel}</span> : null}
            </div>
          </Callout>
        </>
      ) : null}

      {/* ── 4 · CTA ──────────────────────────────────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={portalUrl} label={t.cta} />
      <Spacer h={26} />

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
