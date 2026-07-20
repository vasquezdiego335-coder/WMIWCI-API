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
  SupportBlock,
  Footer,
  IconChip,
  C,
  FONT,
  P,
  money,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  PAYMENT RECEIPT  ("Payment received — receipt enclosed")
//  Shared _ui kit, matching the confirmation email. Price transparency is the
//  point: it separates what was charged TODAY (the deposit) from the move
//  estimate and what's DUE ON MOVE DAY — deposit vs. move total vs. remaining
//  balance vs. truck add-on vs. travel fee. Bilingual EN/ES; every money row
//  renders only when a value is provided.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  bookingDisplayId?: string // legacy alias for displayId
  date?: string
  method?: string
  cardBrand?: string // e.g. 'Visa'
  last4?: string // e.g. '4242'
  captured?: boolean // true = charged; false = authorization hold (not yet captured)
  amountPaid?: string // deposit charged today, e.g. "49.00"
  moveTotal?: string // labor estimate for the move, e.g. "420.00"
  remainingBalance?: string // move total minus deposit
  truckAddon?: string // truck pickup/return add-on, due on move day
  travelFee?: string // service-area travel fee, due on move day
  waitingFee?: string // Late Arrival & Delay Policy fee, due on move day (dollars)
  waitingMinutes?: number // BILLABLE minutes past the 30-min grace (for the label)
  dueOnMoveDay?: string // total collected on move day
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
  date,
  method,
  cardBrand,
  last4,
  captured = true,
  amountPaid,
  moveTotal,
  remainingBalance,
  truckAddon,
  travelFee,
  waitingFee,
  waitingMinutes,
  dueOnMoveDay,
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
        preview: `Recibo de tu pago de ${money(amountPaid, es)} — Move It Clear It.`,
        pill: captured ? 'Pago recibido' : 'Autorización (retención)',
        h1: 'Recibo de pago',
        sub: `Gracias, ${customerName}. Aquí está el desglose de tu pago y lo que queda para el día de la mudanza.`,
        paidToday: 'Pagado hoy',
        capturedYes: 'Cobrado a tu tarjeta',
        capturedNo: 'Autorización — aún no se cobra',
        detTitle: 'Detalles del pago',
        kv: { ref: 'Referencia', date: 'Fecha', method: 'Método', paid: 'Depósito pagado hoy' },
        estTitle: 'Desglose de tu mudanza',
        est: { total: 'Total de la mudanza (mano de obra)', deposit: 'Menos depósito pagado hoy', remain: 'Saldo de mano de obra', truck: 'Cargo por camión (día de mudanza)', travel: 'Cargo por viaje (día de mudanza)', waiting: `Tiempo de espera${waitingMinutes ? ` (${waitingMinutes} min tras la cortesía)` : ''} (día de mudanza)`, due: 'A pagar el día de la mudanza' },
        note: captured
          ? `El depósito de ${money(amountPaid, es)} se cobró para asegurar tu reserva y se aplica al total de tu mudanza. El saldo restante se paga el día de la mudanza.`
          : `El depósito de ${money(amountPaid, es)} es una autorización (retención) en tu tarjeta — solo se cobra cuando se aprueba tu reserva. Se aplica al total de tu mudanza.`,
        cta: 'Ver mi reserva',
        supportTitle: 'Estamos para ayudarte',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Guarda este correo como comprobante. ¿Preguntas sobre tu recibo? Llámanos o escríbenos cuando quieras.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
        methodDefault: 'Tarjeta',
      }
    : {
        preview: `Receipt for your ${money(amountPaid, es)} payment — Move It Clear It.`,
        pill: captured ? 'Payment received' : 'Authorization (hold)',
        h1: 'Payment receipt',
        sub: `Thanks, ${customerName}. Here's the breakdown of what you paid and what's left for move day.`,
        paidToday: 'Paid today',
        capturedYes: 'Charged to your card',
        capturedNo: 'Authorized — not yet charged',
        detTitle: 'Payment details',
        kv: { ref: 'Reference', date: 'Date', method: 'Method', paid: 'Deposit paid today' },
        estTitle: 'Your move breakdown',
        est: { total: 'Move total (labor)', deposit: 'Less deposit paid today', remain: 'Labor balance', truck: 'Truck add-on (move day)', travel: 'Travel fee (move day)', waiting: `Waiting time${waitingMinutes ? ` (${waitingMinutes} min past grace)` : ''} (move day)`, due: 'Due on move day' },
        note: captured
          ? `The ${money(amountPaid, es)} deposit was charged to secure your booking and applies to your move total. Any remaining balance is settled on move day.`
          : `The ${money(amountPaid, es)} deposit is an authorization hold on your card — it is only charged once your booking is approved. It applies to your move total.`,
        cta: 'View booking',
        supportTitle: "We're here to help",
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: 'Keep this email as your proof of payment. Questions about your receipt? Call or text us any time.',
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
        methodDefault: 'Card',
      }

  // Payment method shown to the customer — prefer "Visa ending in 4242" over a
  // generic processor label; never expose "Stripe".
  const methodDisplay =
    cardBrand && last4
      ? es
        ? `${cardBrand} terminada en ${last4}`
        : `${cardBrand} ending in ${last4}`
      : method || t.methodDefault

  // Move-breakdown rows (render only what we have).
  const estRows = [
    { label: t.est.total, value: moveTotal ? `$${moveTotal}` : '' },
    { label: t.est.deposit, value: `-${money(amountPaid, es)}` },
    { label: t.est.remain, value: remainingBalance ? `$${remainingBalance}` : '' },
    { label: t.est.truck, value: truckAddon ? `$${truckAddon}` : '' },
    { label: t.est.travel, value: travelFee ? `$${travelFee}` : '' },
    // Waiting fee is ALWAYS its own line — never folded into labor (owner spec).
    { label: t.est.waiting, value: waitingFee ? `$${waitingFee}` : '' },
    { label: t.est.due, value: dueOnMoveDay ? `$${dueOnMoveDay}` : '', strong: true },
  ].filter((r) => r.value)
  const hasEstimate = Boolean(moveTotal || dueOnMoveDay || truckAddon || travelFee || waitingFee)

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
          <p style={{ ...P, marginBottom: 0, maxWidth: '430px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · PAID-TODAY BAND (auth vs captured is explicit) ── */}
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} className="card" style={{ background: C.navy, borderRadius: '18px' }}>
        <tbody>
          <tr>
            <td className="cardpad" style={{ padding: '22px 30px' }}>
              <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.4px', textTransform: 'uppercase' as const, color: C.gold }}>{t.paidToday}</div>
              <div style={{ fontFamily: FONT, fontSize: '30px', fontWeight: 800, color: '#FFFFFF', margin: '6px 0 8px', letterSpacing: '-0.5px' }}>${amountPaid}</div>
              <span style={{ display: 'inline-block', background: 'rgba(255,255,255,0.10)', color: captured ? C.onNavyStrong : C.gold, border: `1px solid ${captured ? 'rgba(247,247,242,0.45)' : 'rgba(212,162,76,0.4)'}`, borderRadius: '999px', fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '0.4px', padding: '5px 12px' }}>
                {captured ? t.capturedYes : t.capturedNo}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <Spacer h={16} />

      {/* ── 3 · PAYMENT DETAILS ──────────────────────────────── */}
      <Card>
        <Eyebrow icon="clipboard" title={t.detTitle} tone="orange" />
        <KVTable
          rows={[
            { label: t.kv.ref, value: ref },
            { label: t.kv.date, value: dateStr },
            { label: t.kv.method, value: methodDisplay },
            { label: t.kv.paid, value: `${money(amountPaid, es)}`, strong: true },
          ]}
        />

        {/* ── 4 · MOVE BREAKDOWN (only when we have estimate data) ── */}
        {hasEstimate ? (
          <>
            <Divider my={20} />
            <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.2px', textTransform: 'uppercase' as const, color: C.label, marginBottom: '6px' }}>{t.estTitle}</div>
            <KVTable rows={estRows} />
          </>
        ) : null}

        <Divider my={18} />
        <Callout tone="bone">
          <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{t.note}</div>
        </Callout>
      </Card>

      {/* ── 5 · CTA ──────────────────────────────────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={portalUrl} label={t.cta} />
      <Spacer h={26} />

      {/* ── 6 · SUPPORT ──────────────────────────────────────── */}
      <SupportBlock title={t.supportTitle} phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />

      {/* ── 7 · FOOTER ───────────────────────────────────────── */}
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
