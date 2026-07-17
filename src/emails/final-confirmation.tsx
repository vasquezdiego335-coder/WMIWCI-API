import * as React from 'react'
import {
  Shell,
  LogoHeader,
  AnimatedHero,
  Card,
  Eyebrow,
  Pill,
  KVTable,
  RouteBlock,
  MiniCard,
  Callout,
  Divider,
  Spacer,
  PrimaryButton,
  ContactRow,
  Footer,
  VSteps,
  IconChip,
  WaitingPolicyNote,
  C,
  FONT,
  P,
  money,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  CONFIRMATION EMAIL  ("Your booking is approved")
//  Sent after approval / payment capture. Same premium design system as the
//  pre-confirmation: hero illustration → finalized date band → booking
//  summary (crew, truck, final estimate, payment) → move details → what to
//  expect on move day → keep-driveways-clear → CTA → support → footer.
//  Bilingual EN/ES. Optional fields render only when provided.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  date?: string
  timeLabel?: string
  service?: string
  crewSize?: string | number
  crewLead?: string
  truckLabel?: string
  estimate?: string
  amountPaid?: string
  originAddress?: string
  destAddress?: string
  stairs?: string
  elevator?: string
  parking?: string
  heavyItems?: string
  notes?: string
  portalUrl?: string
  heroGifUrl?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  serviceAreaZone?: string
  travelFee?: number | null
  manualReviewRequired?: boolean
  locale?: string
}

export default function FinalConfirmationEmail({
  customerName = 'there',
  displayId = '',
  date,
  timeLabel,
  service,
  crewSize,
  crewLead,
  truckLabel,
  estimate,
  amountPaid,
  originAddress,
  destAddress,
  stairs,
  elevator,
  parking,
  heavyItems,
  notes,
  portalUrl = '#',
  heroGifUrl = '',
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  serviceAreaZone,
  travelFee,
  manualReviewRequired,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const locStr = es ? 'es-US' : 'en-US'
  const dateOnly = date
    ? new Date(date).toLocaleDateString(locStr, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
    : es ? 'Por confirmar' : 'To be confirmed'
  const timeOnly = timeLabel || (date ? new Date(date).toLocaleTimeString(locStr, { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : undefined)
  const access = [stairs, elevator].filter(Boolean).join(' · ')

  const t = es
    ? {
        preview: `Tu reserva está aprobada${displayId ? ` (${displayId})` : ''} — aquí tienes todo para el día de la mudanza.`,
        pill: 'Aprobada',
        h1: 'Tu reserva está aprobada.',
        sub: `Todo listo, ${customerName}. Aquí tienes todo lo que necesitas para el día de la mudanza — nos encargamos de que sea fácil.`,
        dateLabel: 'Tu mudanza está programada para',
        sumTitle: 'Resumen de la reserva',
        kv: { ref: 'Referencia', service: 'Servicio', crew: 'Equipo asignado', truck: 'Camión', est: 'Total final', pay: 'Pago', travel: 'Cargo por viaje' },
        payVal: (n: string) => `$${n} de depósito · cobrado`,
        travelVal: (fee: number | null | undefined) => fee ? `$${fee} · a pagar el día de la mudanza` : (manualReviewRequired ? 'Revisión pendiente' : 'Incluido'),
        moveTitle: 'Detalles de la mudanza',
        from: 'Recogida', to: 'Destino',
        logi: { access: 'Escaleras / elevador', parking: 'Estacionamiento', heavy: 'Artículos pesados' },
        notesTitle: 'Notas',
        expectTitle: 'Qué esperar el día de la mudanza',
        expect: [
          { title: 'Llega el equipo', desc: 'Puntuales y listos. Te avisamos cuando vamos en camino.' },
          { title: 'Recorrido', desc: 'Revisamos juntos tus artículos, el acceso y el plan.' },
          { title: 'Carga', desc: 'Acolchamos, envolvemos y cargamos todo con seguridad.' },
          { title: 'Transporte', desc: 'Nos dirigimos a tu destino y mantenemos todo a tiempo.' },
          { title: 'Descarga', desc: 'Colocamos cada artículo donde lo quieras.' },
          { title: 'Recorrido final', desc: 'Confirmamos que no falte nada antes de irnos.' },
        ],
        remindTitle: 'Mantén la entrada despejada',
        remindBody: 'Despeja la entrada y los accesos antes de que lleguemos para que podamos estacionar cerca y movernos rápido — mantiene tu mudanza a tiempo.',
        cta: 'Ver mi reserva',
        supportTitle: 'Estamos para ayudarte',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer:
          `¿Necesitas hacer un cambio? Llámanos o escríbenos cuando quieras — con gusto te ayudamos. Tu depósito de ${money(amountPaid, es)} se aplica a tu mudanza; cualquier saldo restante se paga el día de la mudanza.`,
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
        defTruck: 'U-Haul — a tu nombre',
      }
    : {
        preview: `Your booking is approved${displayId ? ` (${displayId})` : ''} — here’s everything for move day.`,
        pill: 'Approved',
        h1: 'Your booking is approved.',
        sub: `You're locked in, ${customerName}. Here’s everything you need for move day — we can’t wait to make it easy.`,
        dateLabel: 'Your move is set for',
        sumTitle: 'Booking summary',
        kv: { ref: 'Reference', service: 'Service', crew: 'Crew assigned', truck: 'Truck', est: 'Final estimate', pay: 'Payment', travel: 'Travel fee' },
        payVal: (n: string) => `$${n} deposit · captured`,
        travelVal: (fee: number | null | undefined) => fee ? `$${fee} · due on move day` : (manualReviewRequired ? 'Pending review' : 'Included'),
        moveTitle: 'Move details',
        from: 'Pickup', to: 'Destination',
        logi: { access: 'Stairs / elevator', parking: 'Parking', heavy: 'Heavy items' },
        notesTitle: 'Notes',
        expectTitle: 'What to expect on move day',
        expect: [
          { title: 'Crew arrives', desc: 'On time and ready. We’ll text you when we’re en route.' },
          { title: 'Walkthrough', desc: 'We review your items, access, and the plan together.' },
          { title: 'Loading', desc: 'We pad, wrap, and load everything securely.' },
          { title: 'Transport', desc: 'We head to your destination and keep things on schedule.' },
          { title: 'Unload', desc: 'We place every item exactly where you want it.' },
          { title: 'Final walkthrough', desc: 'We confirm nothing’s missed before we go.' },
        ],
        remindTitle: 'Please keep driveways clear',
        remindBody: 'Clear your driveway and entryways before we arrive so we can park close and move quickly — it keeps your move right on schedule.',
        cta: 'View booking',
        supportTitle: 'We’re here to help',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer:
          `Need to make a change? Call or text us any time — we’re always happy to help. Your ${money(amountPaid, es)} deposit is applied to your move; any remaining balance is settled on move day.`,
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
        defTruck: 'U-Haul — rented in your name',
      }

  const crewVal = crewSize ? `${crewSize}${crewLead ? ` · ${es ? 'liderado por' : 'led by'} ${crewLead}` : ''}` : ''
  const logistics = [
    { icon: 'steps' as const, label: t.logi.access, value: access },
    { icon: 'truck' as const, label: t.logi.parking, value: parking },
    { icon: 'weight' as const, label: t.logi.heavy, value: heavyItems },
  ].filter((x) => x.value)

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.orange}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <AnimatedHero heroGifUrl={heroGifUrl} />
          <Spacer h={18} />
          <Pill tone="orange">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '28px', lineHeight: '35px', fontWeight: 800, letterSpacing: '-0.5px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '440px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · FINALIZED DATE / TIME BAND ───────────────────── */}
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} className="card" style={{ background: C.navy, borderRadius: '18px' }}>
        <tbody>
          <tr>
            <td className="cardpad" style={{ padding: '22px 30px' }}>
              <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
                <tbody>
                  <tr>
                    <td valign="middle">
                      <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.4px', textTransform: 'uppercase' as const, color: C.gold }}>{t.dateLabel}</div>
                      <div style={{ fontFamily: FONT, fontSize: '21px', fontWeight: 800, color: '#FFFFFF', marginTop: '7px', lineHeight: '27px' }}>{dateOnly}</div>
                      {timeOnly ? <div style={{ fontFamily: FONT, fontSize: '14px', fontWeight: 600, color: '#AEB8C6', marginTop: '4px' }}>{timeOnly}</div> : null}
                    </td>
                    <td width={54} align="right" valign="middle" className="hide-sm" style={{ width: '54px' }}>
                      <IconChip icon="calendar" color={C.gold} size={20} dim={46} border="none" radius={13} bg="rgba(212,162,76,0.16)" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      <Spacer h={16} />

      {/* ── 3 · BOOKING SUMMARY ──────────────────────────────── */}
      <Card>
        <Eyebrow icon="clipboard" title={t.sumTitle} tone="orange" />
        <KVTable
          rows={[
            { label: t.kv.ref, value: displayId },
            { label: t.kv.service, value: service },
            { label: t.kv.crew, value: crewVal },
            { label: t.kv.truck, value: truckLabel || t.defTruck },
            { label: t.kv.est, value: estimate, strong: true },
            { label: t.kv.pay, value: amountPaid ? t.payVal(amountPaid) : '' },
            ...(serviceAreaZone ? [{ label: t.kv.travel, value: t.travelVal(travelFee) }] : []),
          ]}
        />
      </Card>

      <Spacer h={16} />

      {/* ── 4 · MOVE DETAILS ─────────────────────────────────── */}
      {originAddress || destAddress || logistics.length || notes ? (
        <>
          <Card>
            <Eyebrow icon="route" title={t.moveTitle} tone="navy" />
            {originAddress || destAddress ? (
              <RouteBlock fromLabel={t.from} from={originAddress || '—'} toLabel={t.to} to={destAddress || '—'} />
            ) : null}
            {logistics.length ? (
              <>
                <Divider my={18} />
                <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
                  <tbody>
                    <tr>
                      {logistics.slice(0, 2).map((x, i) => (
                        <MiniCard key={i} icon={x.icon} label={x.label} value={x.value as string} />
                      ))}
                    </tr>
                    {logistics.length > 2 ? (
                      <tr>
                        {logistics.slice(2, 4).map((x, i) => (
                          <MiniCard key={i} icon={x.icon} label={x.label} value={x.value as string} />
                        ))}
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </>
            ) : null}
            {notes ? (
              <>
                <Divider my={18} />
                <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.2px', textTransform: 'uppercase' as const, color: C.label, marginBottom: '8px' }}>{t.notesTitle}</div>
                <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
                  <tbody>
                    <tr>
                      <td style={{ background: C.inset, borderRadius: '12px', borderLeft: `3px solid ${C.gold}`, padding: '14px 16px', fontFamily: FONT, fontSize: '14px', lineHeight: '21px', color: C.body, whiteSpace: 'pre-line' as const }}>{notes}</td>
                    </tr>
                  </tbody>
                </table>
              </>
            ) : null}
          </Card>
          <Spacer h={16} />
        </>
      ) : null}

      {/* ── 5 · WHAT TO EXPECT ON MOVE DAY ───────────────────── */}
      <Card>
        <Eyebrow icon="checklist" title={t.expectTitle} tone="orange" />
        <VSteps steps={t.expect} />
      </Card>

      <Spacer h={16} />

      {/* ── 6 · KEEP DRIVEWAYS CLEAR ─────────────────────────── */}
      <Callout tone="orange">
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
          <tbody>
            <tr>
              <td width={44} valign="top" style={{ width: '44px' }}>
                <IconChip icon="truck" color={C.orange} size={19} dim={36} border="1px solid #FBD9C2" radius={10} />
              </td>
              <td valign="top" style={{ paddingLeft: '4px' }}>
                <div style={{ fontFamily: FONT, fontSize: '15px', fontWeight: 800, color: C.navy, marginBottom: '4px' }}>{t.remindTitle}</div>
                <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{t.remindBody}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </Callout>

      {/* ── 6b · ARRIVAL & WAITING-TIME POLICY ───────────────── */}
      <Spacer h={16} />
      <WaitingPolicyNote lang={es ? 'es' : 'en'} variant="confirmation" />

      {/* ── 7 · CTA ──────────────────────────────────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={portalUrl} label={t.cta} />
      <Spacer h={26} />

      {/* ── 8 · SUPPORT ──────────────────────────────────────── */}
      <Card>
        <Eyebrow icon="phone" title={t.supportTitle} tone="navy" />
        <ContactRow phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />
      </Card>

      {/* ── 9 · FOOTER ───────────────────────────────────────── */}
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

// (Hero art now lives in ./_ui as HeroTruckArt, rendered by <AnimatedHero />.)
