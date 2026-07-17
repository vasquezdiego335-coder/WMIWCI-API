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
  Footer,
  IconChip,
  C,
  FONT,
  P,
  money,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  BOOKING CANCELLATION  ("Your booking has been cancelled")
//  Confirms a cancellation and states the payment outcome plainly. refundStatus:
//    'released'  → hold was never captured; nothing charged
//    'refunded'  → the $49 (or `amount`) was refunded
//    'retained'  → deposit kept per policy (only if literally true)
//    'custom'    → use `statusText`
//  Shared _ui kit; bilingual EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  date?: string
  amount?: string
  refundStatus?: 'released' | 'refunded' | 'retained' | 'custom'
  statusText?: string
  rebookUrl?: string
  portalUrl?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function BookingCancellationEmail({
  customerName = 'there',
  displayId,
  date,
  amount,
  refundStatus = 'released',
  statusText,
  rebookUrl = 'https://moveitclearit.com/book',
  portalUrl = '#',
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const dateStr = date
    ? new Date(date).toLocaleDateString(es ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })
    : undefined

  const statusMap = es
    ? {
        released: { title: 'No se te cobró', body: `La retención de ${money(amount, es)} en tu tarjeta fue liberada. Tu banco puede tardar unos días en reflejarlo.` },
        refunded: { title: `Reembolso de ${money(amount, es)} emitido`, body: 'Emitimos el reembolso a tu método de pago original. Puede tardar 5–10 días hábiles en aparecer.' },
        retained: { title: 'Sobre tu depósito', body: `Según nuestra política, el depósito de ${money(amount, es)} no es reembolsable. Si tienes preguntas, contáctanos.` },
        custom: { title: 'Estado del pago', body: statusText || '' },
      }
    : {
        released: { title: 'You were not charged', body: `The ${money(amount, es)} hold on your card was released. Your bank may take a few days to reflect it.` },
        refunded: { title: `${money(amount, es)} refund issued`, body: 'We issued the refund to your original payment method. It can take 5–10 business days to appear.' },
        retained: { title: 'About your deposit', body: `Per our policy, the ${money(amount, es)} deposit is non-refundable. If you have questions, reach out any time.` },
        custom: { title: 'Payment status', body: statusText || '' },
      }
  const status = statusMap[refundStatus]

  const t = es
    ? {
        preview: `Tu reserva${displayId ? ` (${displayId})` : ''} fue cancelada. ${status.title}.`,
        pill: 'Cancelada',
        h1: 'Tu reserva fue cancelada.',
        sub: `Hola ${customerName}, confirmamos la cancelación de tu mudanza${dateStr ? ` del ${dateStr}` : ''}.`,
        cta: 'Reservar de nuevo',
        help: 'Si esto fue un error o quieres reprogramar, llámanos o escríbenos — estamos aquí para ayudarte.',
        supportTitle: '¿Necesitas ayuda?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Este correo confirma la cancelación de tu reserva y el estado de tu pago.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `Your booking${displayId ? ` (${displayId})` : ''} has been cancelled. ${status.title}.`,
        pill: 'Cancelled',
        h1: 'Your booking has been cancelled.',
        sub: `Hi ${customerName}, we've confirmed the cancellation of your move${dateStr ? ` on ${dateStr}` : ''}.`,
        cta: 'Book again',
        help: "If this was a mistake or you'd like to reschedule, call or text us — we're here to help.",
        supportTitle: 'Need a hand?',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: 'This email confirms your booking cancellation and your payment status.',
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.navy}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <IconChip icon="calendar" color={C.navy} size={26} dim={64} bg={C.navyTint} border="none" radius={18} />
          <Spacer h={16} />
          <Pill tone="navy">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '25px', lineHeight: '32px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '440px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · PAYMENT / REFUND STATUS ──────────────────────── */}
      {status.body ? (
        <Callout tone={refundStatus === 'refunded' ? 'gold' : 'bone'}>
          <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
            <tbody>
              <tr>
                <td width={44} valign="top" style={{ width: '44px' }}>
                  <IconChip icon="shield" color={C.goldInk} size={19} dim={36} bg="#FFFFFF" border="1px solid #EAD9B0" radius={10} />
                </td>
                <td valign="top" style={{ paddingLeft: '4px' }}>
                  <div style={{ fontFamily: FONT, fontSize: '15px', fontWeight: 800, color: C.navy, marginBottom: '4px' }}>{status.title}</div>
                  <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{status.body}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </Callout>
      ) : null}

      {/* ── 3 · CTA ──────────────────────────────────────────── */}
      <Spacer h={24} />
      <PrimaryButton href={rebookUrl} label={t.cta} />
      <Spacer h={22} />

      {/* ── 4 · HELP ─────────────────────────────────────────── */}
      <Card>
        <p style={{ ...P, marginBottom: 0 }}>{t.help}</p>
      </Card>

      <Spacer h={16} />

      {/* ── 5 · SUPPORT ──────────────────────────────────────── */}
      <Card>
        <Eyebrow icon="phone" title={t.supportTitle} tone="navy" />
        <ContactRow phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />
      </Card>

      {/* ── 6 · FOOTER ───────────────────────────────────────── */}
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
