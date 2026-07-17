import * as React from 'react'
import {
  Shell,
  LogoHeader,
  IconChip,
  Card,
  Eyebrow,
  Pill,
  Callout,
  Spacer,
  PrimaryButton,
  ContactRow,
  Footer,
  money,
  C,
  FONT,
  P,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  PAYMENT / AUTHORIZATION FAILED  ("Action required — update your payment")
//  One template for three failure points: the initial $49 authorization, the
//  deposit capture on approval, and a final move-day payment. Action-required,
//  static, honest. The CTA is the SECURE payment-update URL (required — the send
//  is blocked without it). Bilingual EN/ES. Never claims a booking is confirmed.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  failureType?: 'authorization' | 'capture' | 'final_payment'
  amount?: string // the amount that failed, when known
  /** Secure, signed URL to update the payment method. Required (CTA). */
  updatePaymentUrl?: string
  dateHeld?: boolean // is the requested date temporarily held while they fix it?
  deadline?: string // human deadline to update, e.g. "within 24 hours"
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  locale?: string
}

export default function PaymentFailedEmail({
  customerName = 'there',
  displayId,
  failureType = 'authorization',
  amount,
  updatePaymentUrl = '#',
  dateHeld = false,
  deadline,
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')

  const t = es
    ? {
        preview: `Acción requerida — actualiza tu método de pago${displayId ? ` (${displayId})` : ''}.`,
        pill: 'Acción requerida',
        h1: {
          authorization: 'No pudimos autorizar tu tarjeta.',
          capture: 'No pudimos procesar tu depósito.',
          final_payment: 'No pudimos procesar tu pago final.',
        }[failureType],
        sub: `Hola ${customerName}, hubo un problema con tu ${failureType === 'final_payment' ? 'pago' : 'autorización de tarjeta'}${amount ? ` de ${money(amount, es)}` : ''}. Actualiza tu método de pago para continuar.`,
        whatTitle: 'Qué pasó',
        held: dateHeld
          ? `Mantenemos tu fecha solicitada por ahora${deadline ? `, pero necesitas actualizar tu pago ${deadline}` : ''}. No podemos revisar ni programar tu mudanza hasta que se complete.`
          : 'No se realizó ningún cargo. Necesitamos un método de pago válido para continuar con tu solicitud.',
        cta: 'Actualizar método de pago',
        supportTitle: '¿Necesitas ayuda?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Recibiste este correo porque una acción de pago en tu solicitud no se completó. Es un mensaje operativo de tu reserva.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `Action required — update your payment method${displayId ? ` (${displayId})` : ''}.`,
        pill: 'Action required',
        h1: {
          authorization: "We couldn't authorize your card.",
          capture: "We couldn't process your deposit.",
          final_payment: "We couldn't process your final payment.",
        }[failureType],
        sub: `Hi ${customerName}, there was a problem with your ${failureType === 'final_payment' ? 'payment' : 'card authorization'}${amount ? ` of ${money(amount, es)}` : ''}. Update your payment method to continue.`,
        whatTitle: 'What happened',
        held: dateHeld
          ? `We're holding your requested date for now${deadline ? `, but you'll need to update your payment ${deadline}` : ''}. We can't review or schedule your move until this is resolved.`
          : "No charge was made. We need a valid payment method to move your request forward.",
        cta: 'Update payment method',
        supportTitle: 'Need a hand?',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: "You're receiving this because a payment action on your booking request didn't complete. This is an operational message about your booking.",
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.orange}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <IconChip icon="shield" color={C.orangeInk} size={26} dim={64} bg={C.orangeTint} border="none" radius={18} />
          <Spacer h={16} />
          <Pill tone="orange">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '25px', lineHeight: '32px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '440px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · WHAT HAPPENED ────────────────────────────────── */}
      <Card>
        <Eyebrow icon="shield" title={t.whatTitle} tone="navy" />
        <p style={{ ...P, marginBottom: 0 }}>{t.held}</p>
      </Card>

      {/* ── 3 · CTA (secure payment-update URL) ──────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={updatePaymentUrl} label={t.cta} />
      <Spacer h={26} />

      {/* ── 4 · SUPPORT ──────────────────────────────────────── */}
      <Card>
        <Eyebrow icon="phone" title={t.supportTitle} tone="navy" />
        <ContactRow phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />
      </Card>

      {/* ── 5 · FOOTER (transactional/operational) ───────────── */}
      <Footer
        disclaimer={t.disclaimer}
        phone={phone}
        email={email}
        websiteLabel={websiteLabel}
        manageUrl={updatePaymentUrl}
        unsubscribeUrl={updatePaymentUrl}
        labels={t.footerLabels}
      />
    </Shell>
  )
}
