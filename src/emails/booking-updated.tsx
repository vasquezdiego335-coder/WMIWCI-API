import * as React from 'react'
import {
  Shell,
  LogoHeader,
  Card,
  Eyebrow,
  Pill,
  KVTable,
  RouteBlock,
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
//  BOOKING UPDATED / RESCHEDULED  ("Your booking has been updated")
//  ONE reusable change-confirmation email — date, time, address, service, or
//  any booking-detail change. Pass `changedLabel` ("date", "pickup address") to
//  tune the headline and `note` for a plain-language summary of what changed.
//  Shared _ui kit; bilingual EN/ES. Merges the old reschedule-offer +
//  booking-rescheduled templates.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  changedLabel?: string
  note?: string
  date?: string
  timeLabel?: string
  service?: string
  originAddress?: string
  destAddress?: string
  portalUrl?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  /** Deposit hold amount shown in the disclaimer. Defaults to the standard $49. */
  amountHold?: string
  locale?: string
}

export default function BookingUpdatedEmail({
  customerName = 'there',
  displayId,
  changedLabel,
  note,
  date,
  timeLabel,
  service,
  originAddress,
  destAddress,
  portalUrl = '#',
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  amountHold,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const locStr = es ? 'es-US' : 'en-US'
  const dateOnly = date
    ? new Date(date).toLocaleDateString(locStr, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
    : undefined
  const timeOnly = timeLabel || (date ? new Date(date).toLocaleTimeString(locStr, { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : undefined)

  const t = es
    ? {
        preview: `Actualizamos tu reserva${displayId ? ` (${displayId})` : ''}. Aquí están los detalles al día.`,
        pill: 'Reserva actualizada',
        h1: changedLabel ? `Actualizamos ${changedLabel} de tu reserva.` : 'Actualizamos tu reserva.',
        sub: `Hola ${customerName}, hicimos el cambio. Aquí están los detalles al día de tu mudanza.`,
        changeTitle: 'Qué cambió',
        detTitle: 'Detalles actualizados',
        kv: { ref: 'Referencia', date: 'Fecha', time: 'Hora', service: 'Servicio' },
        from: 'Recogida', to: 'Destino',
        reassure: 'Todo lo demás sigue igual. Si algo no se ve bien, avísanos de inmediato.',
        cta: 'Ver mi reserva',
        supportTitle: 'Estamos para ayudarte',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: `Este correo confirma un cambio en tu reserva. Tu depósito de ${money(amountHold, es)} permanece aplicado a tu mudanza.`,
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `We've updated your booking${displayId ? ` (${displayId})` : ''}. Here are the current details.`,
        pill: 'Booking updated',
        h1: changedLabel ? `We've updated your booking ${changedLabel}.` : "We've updated your booking.",
        sub: `Hi ${customerName}, the change is done. Here are the current details for your move.`,
        changeTitle: "What changed",
        detTitle: 'Updated details',
        kv: { ref: 'Reference', date: 'Date', time: 'Time', service: 'Service' },
        from: 'Pickup', to: 'Destination',
        reassure: "Everything else stays the same. If anything doesn't look right, let us know right away.",
        cta: 'View booking',
        supportTitle: "We're here to help",
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: `This email confirms a change to your booking. Your ${money(amountHold, es)} deposit stays applied to your move.`,
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.gold}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <IconChip icon="calendar" color={C.goldInk} size={26} dim={64} bg={C.goldTint} border="none" radius={18} />
          <Spacer h={16} />
          <Pill tone="gold">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '25px', lineHeight: '32px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '440px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · WHAT CHANGED (optional) ──────────────────────── */}
      {note ? (
        <>
          <Card>
            <Eyebrow icon="sparkle" title={t.changeTitle} tone="orange" />
            <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
              <tbody>
                <tr>
                  <td style={{ background: C.inset, borderRadius: '12px', borderLeft: `3px solid ${C.orange}`, padding: '14px 16px', fontFamily: FONT, fontSize: '14px', lineHeight: '21px', color: C.body, whiteSpace: 'pre-line' as const }}>{note}</td>
                </tr>
              </tbody>
            </table>
          </Card>
          <Spacer h={16} />
        </>
      ) : null}

      {/* ── 3 · UPDATED DETAILS ──────────────────────────────── */}
      <Card>
        <Eyebrow icon="clipboard" title={t.detTitle} tone="navy" />
        <KVTable
          rows={[
            { label: t.kv.ref, value: displayId },
            { label: t.kv.date, value: dateOnly },
            { label: t.kv.time, value: timeOnly },
            { label: t.kv.service, value: service },
          ]}
        />
        {originAddress || destAddress ? (
          <>
            <Divider my={18} />
            <RouteBlock fromLabel={t.from} from={originAddress || '—'} toLabel={t.to} to={destAddress || '—'} />
          </>
        ) : null}
      </Card>

      <Spacer h={16} />

      {/* ── 4 · REASSURE ─────────────────────────────────────── */}
      <Callout tone="bone">
        <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{t.reassure}</div>
      </Callout>

      {/* ── 5 · CTA ──────────────────────────────────────────── */}
      <Spacer h={24} />
      <PrimaryButton href={portalUrl} label={t.cta} />
      <Spacer h={26} />

      {/* ── 6 · SUPPORT ──────────────────────────────────────── */}
      <Card>
        <Eyebrow icon="phone" title={t.supportTitle} tone="navy" />
        <ContactRow phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />
      </Card>

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
