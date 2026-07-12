import * as React from 'react'
import {
  Shell,
  LogoHeader,
  Card,
  Eyebrow,
  Pill,
  KVTable,
  Callout,
  Spacer,
  Divider,
  PrimaryButton,
  ContactRow,
  Footer,
  IconChip,
  C,
  FONT,
  P,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  PAYMENT RECEIPT  ("Payment received — receipt enclosed")
//  Rebuilt on the shared _ui kit to match the pre-confirmation / confirmation
//  emails (locked palette, Inter, cards, one CTA). Sent by the admin "Resend
//  receipt" action. Bilingual EN/ES; every enrichment field is optional.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  bookingDisplayId?: string // legacy prop name — accepted as an alias for displayId
  amountPaid?: string
  date?: string
  method?: string
  service?: string
  portalUrl?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function PaymentReceiptEmail({
  customerName = 'there',
  displayId,
  bookingDisplayId,
  amountPaid = '49.00',
  date,
  method,
  service,
  portalUrl = '#',
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const ref = displayId || bookingDisplayId || ''
  const dateStr = date
    ? new Date(date).toLocaleDateString(es ? 'es-US' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
    : undefined

  const t = es
    ? {
        preview: `Recibo de tu depósito de $${amountPaid} — Move It Clear It.`,
        pill: 'Pago recibido',
        h1: 'Recibo de pago',
        sub: `Gracias, ${customerName}. Registramos tu depósito de reserva — aquí tienes tu recibo.`,
        recTitle: 'Detalles del recibo',
        kv: { ref: 'Referencia', service: 'Servicio', date: 'Fecha de pago', method: 'Método', amount: 'Monto pagado' },
        note: 'Tu depósito de $49 se aplica al total de tu mudanza. Cualquier saldo restante se paga el día de la mudanza.',
        cta: 'Ver mi reserva',
        supportTitle: 'Estamos para ayudarte',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Guarda este correo como comprobante de pago. ¿Alguna pregunta sobre tu recibo? Llámanos o escríbenos cuando quieras.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
        methodDefault: 'Tarjeta (Stripe)',
      }
    : {
        preview: `Receipt for your $${amountPaid} deposit — Move It Clear It.`,
        pill: 'Payment received',
        h1: 'Payment receipt',
        sub: `Thanks, ${customerName}. We've recorded your booking deposit — here's your receipt.`,
        recTitle: 'Receipt details',
        kv: { ref: 'Reference', service: 'Service', date: 'Date paid', method: 'Method', amount: 'Amount paid' },
        note: 'Your $49 deposit is applied to your move total. Any remaining balance is settled on move day.',
        cta: 'View booking',
        supportTitle: "We're here to help",
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: 'Keep this email as your proof of payment. Questions about your receipt? Call or text us any time.',
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
        methodDefault: 'Card (Stripe)',
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.gold}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <IconChip icon="shield" color={C.goldInk} size={26} dim={64} bg={C.goldTint} border="none" radius={18} />
          <Spacer h={16} />
          <Pill tone="gold">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '26px', lineHeight: '33px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '420px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · AMOUNT BAND ──────────────────────────────────── */}
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} className="card" style={{ background: C.navy, borderRadius: '18px' }}>
        <tbody>
          <tr>
            <td className="cardpad" style={{ padding: '22px 30px' }}>
              <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.4px', textTransform: 'uppercase' as const, color: C.gold }}>{t.kv.amount}</div>
              <div style={{ fontFamily: FONT, fontSize: '30px', fontWeight: 800, color: '#FFFFFF', marginTop: '6px', letterSpacing: '-0.5px' }}>${amountPaid}</div>
            </td>
          </tr>
        </tbody>
      </table>

      <Spacer h={16} />

      {/* ── 3 · RECEIPT DETAILS ──────────────────────────────── */}
      <Card>
        <Eyebrow icon="clipboard" title={t.recTitle} tone="orange" />
        <KVTable
          rows={[
            { label: t.kv.ref, value: ref },
            { label: t.kv.service, value: service },
            { label: t.kv.date, value: dateStr },
            { label: t.kv.method, value: method || t.methodDefault },
            { label: t.kv.amount, value: `$${amountPaid}`, strong: true },
          ]}
        />
        <Divider my={18} />
        <Callout tone="bone">
          <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{t.note}</div>
        </Callout>
      </Card>

      {/* ── 4 · CTA ──────────────────────────────────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={portalUrl} label={t.cta} />
      <Spacer h={26} />

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
