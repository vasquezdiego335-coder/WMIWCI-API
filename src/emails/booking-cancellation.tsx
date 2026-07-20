import * as React from 'react'
import {
  Shell,
  LogoHeader,
  Card,
  Eyebrow,
  Pill,
  Callout,
  KVTable,
  Divider,
  Spacer,
  PrimaryButton,
  SupportBlock,
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
//    'refunded'  → the $49 (or `amount`) was refunded in full
//    'partial'   → PART refunded, part retained per policy (PARTIALLY_REFUNDED);
//                  itemized: amountCharged − nonRefundable = refundedAmount
//    'retained'  → deposit kept per policy (only if literally true)
//    'custom'    → use `statusText`
//  Every money figure is dynamic — no invented totals. Shared _ui kit; EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  date?: string
  amount?: string
  refundStatus?: 'released' | 'refunded' | 'partial' | 'retained' | 'custom'
  statusText?: string
  // Partial-refund itemization (refundStatus === 'partial'). All dynamic.
  amountCharged?: string // what was actually captured
  nonRefundable?: string // amount retained per cancellation policy
  refundedAmount?: string // amount returned to the customer
  refundMethod?: string // e.g. "Visa ending in 4242" — never "Stripe"
  refundEta?: string // human ETA, e.g. "5–10 business days"
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
  amountCharged,
  nonRefundable,
  refundedAmount,
  refundMethod,
  refundEta,
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

  const etaEs = refundEta || '5–10 días hábiles'
  const etaEn = refundEta || '5–10 business days'
  const statusMap = es
    ? {
        released: { title: 'No se te cobró', body: `La retención de ${money(amount, es)} en tu tarjeta fue liberada. Tu banco puede tardar unos días en reflejarlo.` },
        refunded: { title: `Reembolso de ${money(amount, es)} emitido`, body: `Emitimos el reembolso a ${refundMethod || 'tu método de pago original'}. Puede tardar ${etaEs} en aparecer.` },
        partial: { title: `Reembolso parcial de ${money(refundedAmount, es)}`, body: `Reembolsamos ${money(refundedAmount, es)} a ${refundMethod || 'tu método de pago original'}. El resto se retuvo según nuestra política de cancelación. Puede tardar ${etaEs} en aparecer.` },
        retained: { title: 'Sobre tu depósito', body: `Según nuestra política, el depósito de ${money(amount, es)} no es reembolsable. Si tienes preguntas, contáctanos.` },
        custom: { title: 'Estado del pago', body: statusText || '' },
      }
    : {
        released: { title: 'You were not charged', body: `The ${money(amount, es)} hold on your card was released. Your bank may take a few days to reflect it.` },
        refunded: { title: `${money(amount, es)} refund issued`, body: `We issued the refund to ${refundMethod || 'your original payment method'}. It can take ${etaEn} to appear.` },
        partial: { title: `${money(refundedAmount, es)} partial refund issued`, body: `We refunded ${money(refundedAmount, es)} to ${refundMethod || 'your original payment method'}. The remainder was retained per our cancellation policy. It can take ${etaEn} to appear.` },
        retained: { title: 'About your deposit', body: `Per our policy, the ${money(amount, es)} deposit is non-refundable. If you have questions, reach out any time.` },
        custom: { title: 'Payment status', body: statusText || '' },
      }
  const status = statusMap[refundStatus]

  // Partial-refund itemization — render only the rows we actually have.
  const refundRows = [
    { label: es ? 'Cobrado' : 'Amount charged', value: amountCharged ? `$${amountCharged}` : '' },
    { label: es ? 'Retenido (política)' : 'Retained (policy)', value: nonRefundable ? `-$${nonRefundable}` : '' },
    { label: es ? 'Reembolsado' : 'Refunded', value: refundedAmount ? `$${refundedAmount}` : '', strong: true },
  ].filter((r) => r.value)
  const showItemization = refundStatus === 'partial' && refundRows.length > 0

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
                  <IconChip icon="shield" color={C.goldInk} size={19} dim={36} bg="#FFFFFF" border={`1px solid ${C.goldEdge}`} radius={10} />
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

      {/* ── 2b · PARTIAL-REFUND ITEMIZATION (dynamic) ────────── */}
      {showItemization ? (
        <>
          <Spacer h={16} />
          <Card>
            <Eyebrow icon="clipboard" title={es ? 'Desglose del reembolso' : 'Refund breakdown'} tone="gold" />
            <KVTable rows={refundRows} />
            <Divider my={16} />
            <div style={{ fontFamily: FONT, fontSize: '12.5px', lineHeight: '20px', color: C.muted }}>
              {es
                ? 'La parte retenida cubre la reserva y preparación según nuestra política de cancelación.'
                : 'The retained portion covers scheduling and prep per our cancellation policy.'}
            </div>
          </Card>
        </>
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
      <SupportBlock title={t.supportTitle} phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />

      {/* ── 6 · FOOTER ───────────────────────────────────────── */}
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
