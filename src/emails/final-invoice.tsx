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
  money,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  FINAL INVOICE  ("Your final invoice — Move It Clear It")
//  Sent AFTER the job. Itemizes labor + move-day add-ons, credits the deposit
//  and anything already paid, and shows the remaining balance (or "paid in
//  full"). Every money row renders ONLY when a value is supplied — no invented
//  totals, no phantom charges. Labor-only: no equipment/transport line is
//  claimed unless it is a real add-on. Bilingual EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  invoiceNumber?: string
  date?: string // job completion date (ISO)
  laborTotal?: string // labor charge for the completed move
  truckAddon?: string // truck pickup/return add-on
  travelFee?: string // service-area travel fee
  waitingFee?: string // Late Arrival & Delay Policy fee
  waitingMinutes?: number // billable minutes past grace (label only)
  tip?: string // gratuity, if any
  grandTotal?: string // total for the job
  depositApplied?: string // $49-style deposit credited
  amountPaid?: string // total already paid (incl. deposit)
  balanceDue?: string // remaining balance ('' / '0' / undefined = paid in full)
  /** Secure link to pay a remaining balance. Used only when a balance is due. */
  payUrl?: string
  portalUrl?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function FinalInvoiceEmail({
  customerName = 'there',
  displayId,
  invoiceNumber,
  date,
  laborTotal,
  truckAddon,
  travelFee,
  waitingFee,
  waitingMinutes,
  tip,
  grandTotal,
  depositApplied,
  amountPaid,
  balanceDue,
  payUrl,
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
    ? new Date(date).toLocaleDateString(es ? 'es-US' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
    : undefined

  // A balance is "due" only when it is a real positive number.
  const dueNum = balanceDue != null ? parseFloat(String(balanceDue).replace(/[^0-9.]/g, '')) : NaN
  const hasBalance = Number.isFinite(dueNum) && dueNum > 0
  const safePayUrl = payUrl && payUrl.trim() && payUrl.trim() !== '#' ? payUrl : portalUrl

  const t = es
    ? {
        preview: `Tu factura final de Move It Clear It${displayId ? ` (${displayId})` : ''}.`,
        pill: hasBalance ? 'Saldo pendiente' : 'Pagado en su totalidad',
        h1: 'Tu factura final',
        sub: `Gracias por confiar en nosotros, ${customerName}. Aquí está el desglose final de tu mudanza.`,
        headLabel: hasBalance ? 'Saldo pendiente' : 'Total de la mudanza',
        paidBadge: 'Pagado en su totalidad',
        detTitle: 'Detalles de la factura',
        kv: { inv: 'Factura', ref: 'Reserva', date: 'Fecha del servicio' },
        itemsTitle: 'Desglose',
        items: {
          labor: 'Mano de obra',
          truck: 'Cargo por camión',
          travel: 'Cargo por viaje',
          waiting: `Tiempo de espera${waitingMinutes ? ` (${waitingMinutes} min tras la cortesía)` : ''}`,
          tip: 'Propina',
          total: 'Total',
          deposit: 'Menos depósito aplicado',
          paid: 'Menos pagado',
          due: 'Saldo pendiente',
        },
        note: hasBalance
          ? 'Puedes liquidar el saldo restante con el botón de arriba. ¿Alguna pregunta sobre tu factura? Escríbenos.'
          : 'Tu cuenta está saldada — no queda nada por pagar. Guarda este correo como comprobante.',
        cta: hasBalance ? 'Pagar saldo pendiente' : 'Ver mi reserva',
        supportTitle: '¿Preguntas sobre tu factura?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Guarda este correo como tu factura. ¿Dudas? Llámanos o escríbenos cuando quieras.',
        footerLabels: { rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `Your final invoice from Move It Clear It${displayId ? ` (${displayId})` : ''}.`,
        pill: hasBalance ? 'Balance due' : 'Paid in full',
        h1: 'Your final invoice',
        sub: `Thanks for trusting us with your move, ${customerName}. Here's the final breakdown.`,
        headLabel: hasBalance ? 'Balance due' : 'Move total',
        paidBadge: 'Paid in full',
        detTitle: 'Invoice details',
        kv: { inv: 'Invoice', ref: 'Booking', date: 'Service date' },
        itemsTitle: 'Breakdown',
        items: {
          labor: 'Labor',
          truck: 'Truck add-on',
          travel: 'Travel fee',
          waiting: `Waiting time${waitingMinutes ? ` (${waitingMinutes} min past grace)` : ''}`,
          tip: 'Tip',
          total: 'Total',
          deposit: 'Less deposit applied',
          paid: 'Less amount paid',
          due: 'Balance due',
        },
        note: hasBalance
          ? 'You can settle the remaining balance with the button above. Any questions on your invoice? Just reply.'
          : "Your account is settled — nothing else is owed. Keep this email as your record.",
        cta: hasBalance ? 'Pay balance due' : 'View booking',
        supportTitle: 'Questions about your invoice?',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: 'Keep this email as your invoice. Questions? Call or text us any time.',
        footerLabels: { rights: 'All rights reserved.' },
      }

  const headAmount = hasBalance ? money(balanceDue, es) : (grandTotal ? `$${grandTotal}` : money(amountPaid, es))

  const itemRows = [
    { label: t.items.labor, value: laborTotal ? `$${laborTotal}` : '' },
    { label: t.items.truck, value: truckAddon ? `$${truckAddon}` : '' },
    { label: t.items.travel, value: travelFee ? `$${travelFee}` : '' },
    { label: t.items.waiting, value: waitingFee ? `$${waitingFee}` : '' },
    { label: t.items.tip, value: tip ? `$${tip}` : '' },
    { label: t.items.total, value: grandTotal ? `$${grandTotal}` : '', strong: !hasBalance },
    { label: t.items.deposit, value: depositApplied ? `-$${depositApplied}` : '' },
    { label: t.items.paid, value: amountPaid ? `-$${amountPaid}` : '' },
    { label: t.items.due, value: hasBalance ? `$${balanceDue}` : '', strong: true },
  ].filter((r) => r.value)

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${hasBalance ? C.orange : C.gold}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <IconChip icon="clipboard" color={hasBalance ? C.orangeInk : C.goldInk} size={26} dim={64} bg={hasBalance ? C.orangeTint : C.goldTint} border="none" radius={18} />
          <Spacer h={16} />
          <Pill tone={hasBalance ? 'orange' : 'gold'}>{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '26px', lineHeight: '33px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '430px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · HEADLINE AMOUNT BAND ─────────────────────────── */}
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} className="card" style={{ background: C.navy, borderRadius: '18px' }}>
        <tbody>
          <tr>
            <td className="cardpad" style={{ padding: '22px 30px' }}>
              <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.4px', textTransform: 'uppercase' as const, color: C.gold }}>{t.headLabel}</div>
              <div style={{ fontFamily: FONT, fontSize: '30px', fontWeight: 800, color: '#FFFFFF', margin: '6px 0 8px', letterSpacing: '-0.5px' }}>{headAmount}</div>
              {!hasBalance ? (
                <span style={{ display: 'inline-block', background: 'rgba(255,255,255,0.10)', color: '#8FE0B0', border: '1px solid rgba(143,224,176,0.4)', borderRadius: '999px', fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '0.4px', padding: '5px 12px' }}>
                  {t.paidBadge}
                </span>
              ) : null}
            </td>
          </tr>
        </tbody>
      </table>

      <Spacer h={16} />

      {/* ── 3 · INVOICE DETAILS + BREAKDOWN ──────────────────── */}
      <Card>
        <Eyebrow icon="clipboard" title={t.detTitle} tone="orange" />
        <KVTable
          rows={[
            { label: t.kv.inv, value: invoiceNumber },
            { label: t.kv.ref, value: displayId },
            { label: t.kv.date, value: dateStr },
          ]}
        />

        {itemRows.length ? (
          <>
            <Divider my={20} />
            <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.2px', textTransform: 'uppercase' as const, color: C.label, marginBottom: '6px' }}>{t.itemsTitle}</div>
            <KVTable rows={itemRows} />
          </>
        ) : null}

        <Divider my={18} />
        <Callout tone="bone">
          <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{t.note}</div>
        </Callout>
      </Card>

      {/* ── 4 · CTA ──────────────────────────────────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={hasBalance ? safePayUrl : portalUrl} label={t.cta} />
      <Spacer h={26} />

      {/* ── 5 · SUPPORT ──────────────────────────────────────── */}
      <Card>
        <Eyebrow icon="phone" title={t.supportTitle} tone="navy" />
        <ContactRow phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />
      </Card>

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
