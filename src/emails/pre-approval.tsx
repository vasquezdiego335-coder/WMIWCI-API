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
  SupportBlock,
  Footer,
  VSteps,
  HTimeline,
  IconChip,
  C,
  FONT,
  P,
  money,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  PRE-CONFIRMATION EMAIL  ("We've received your booking request")
//  Sent immediately after a booking request, before approval. Premium +
//  reassuring: hero → status & $49 hold → booking summary → move details →
//  what happens next → one CTA → support → footer. Bilingual EN/ES. Real
//  facts only ($49 authorization HOLD, labor-only, customer's own U-Haul).
//  Every enrichment field renders only when provided (backward-compatible).
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  requestedDate?: string
  timeLabel?: string
  service?: string
  estimate?: string
  crewSize?: string | number
  truckLabel?: string
  originAddress?: string
  destAddress?: string
  stairs?: string
  elevator?: string
  parking?: string
  heavyItems?: string
  notes?: string
  photoCount?: number
  amountHold?: string
  portalUrl?: string
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

export default function PreApprovalEmail({
  customerName = 'there',
  displayId = '',
  requestedDate,
  timeLabel,
  service,
  estimate,
  crewSize,
  truckLabel,
  originAddress,
  destAddress,
  stairs,
  elevator,
  parking,
  heavyItems,
  notes,
  photoCount,
  amountHold,
  portalUrl = '#',
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
  const dateOnly = requestedDate
    ? new Date(requestedDate).toLocaleDateString(locStr, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
    : es ? 'Por confirmar' : 'To be confirmed'
  const timeOnly =
    timeLabel || (requestedDate ? new Date(requestedDate).toLocaleTimeString(locStr, { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : undefined)
  const access = [stairs, elevator].filter(Boolean).join(' · ')

  const t = es
    ? {
        preview: `Recibimos tu solicitud de reserva${displayId ? ` (${displayId})` : ''}. La estamos revisando ahora.`,
        pill: 'En revisión',
        h1: 'Recibimos tu solicitud de reserva.',
        sub: 'Nuestro equipo está revisando tu mudanza antes de aprobarla.',
        stTitle: 'Estado y pago',
        tl: [
          { label: 'Reserva recibida', micro: 'Completo', state: 'done' as const },
          { label: 'En revisión', micro: 'En proceso', state: 'active' as const },
          { label: 'Reserva aprobada', micro: 'Sigue', state: 'todo' as const },
          { label: 'Pago procesado', micro: 'Tras aprobar', state: 'todo' as const },
        ],
        payBig: `Retención de ${money(amountHold, es)}`,
        payBadge: 'No es un cargo',
        pay: ['Autorización temporal en tu tarjeta.', 'Se libera si no podemos realizar la mudanza.', 'Solo se cobra después de la aprobación.'],
        sumTitle: 'Resumen de la reserva',
        kv: { ref: 'Referencia', name: 'Nombre', service: 'Servicio', date: 'Fecha', time: 'Hora', crew: 'Equipo', truck: 'Camión', est: 'Total estimado', travel: 'Cargo por viaje' },
        travelVal: (fee: number | null | undefined) => fee ? `$${fee} · a pagar el día de la mudanza` : (manualReviewRequired ? 'Revisión pendiente' : 'Incluido'),
        moveTitle: 'Detalles de la mudanza',
        from: 'Recogida', to: 'Destino',
        logi: { access: 'Escaleras / elevador', parking: 'Estacionamiento', heavy: 'Artículos pesados', photos: 'Fotos' },
        photosVal: (n: number) => `${n} ${n === 1 ? 'adjunta' : 'adjuntas'} · míralas en tu reserva`,
        notesTitle: 'Notas',
        nextTitle: 'Qué sigue',
        steps: [
          { title: 'Revisamos tu solicitud', desc: 'Nuestro equipo confirma los detalles de tu mudanza.' },
          { title: 'Confirmamos disponibilidad', desc: 'Aseguramos equipo y horario para tu fecha.' },
          { title: 'Recibes tu confirmación', desc: 'Te avisamos en cuanto quede aprobada.' },
        ],
        reassure: 'No necesitas hacer nada ahora. Tranquilo — nosotros nos encargamos.',
        cta: 'Ver mi reserva',
        supportTitle: '¿Necesitas ayuda?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer:
          `Este correo confirma que recibimos tu solicitud — no es una confirmación final. El precio es un estimado y puede ajustarse tras revisar acceso y detalles. La autorización de ${money(amountHold, es)} es una retención, no un cargo, y se libera si tu reserva no se aprueba.`,
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
        defTruck: 'U-Haul — a tu nombre',
      }
    : {
        preview: `We've received your booking request${displayId ? ` (${displayId})` : ''}. Our team is reviewing it now.`,
        pill: 'Under review',
        h1: 'We’ve received your booking request.',
        sub: 'Our team is reviewing your move before approval.',
        stTitle: 'Status & payment',
        tl: [
          { label: 'Booking received', micro: 'Complete', state: 'done' as const },
          { label: 'Team reviewing', micro: 'In progress', state: 'active' as const },
          { label: 'Booking approved', micro: 'Up next', state: 'todo' as const },
          { label: 'Payment processed', micro: 'After approval', state: 'todo' as const },
        ],
        payBig: `${money(amountHold, es)} hold`,
        payBadge: 'Not a charge',
        pay: ['Temporary authorization on your card.', 'Released if we can’t take the move.', 'Only captured after approval.'],
        sumTitle: 'Booking summary',
        kv: { ref: 'Reference', name: 'Name', service: 'Service', date: 'Date', time: 'Time', crew: 'Crew', truck: 'Truck', est: 'Estimated total', travel: 'Travel fee' },
        travelVal: (fee: number | null | undefined) => fee ? `$${fee} · due on move day` : (manualReviewRequired ? 'Pending review' : 'Included'),
        moveTitle: 'Move details',
        from: 'Pickup', to: 'Destination',
        logi: { access: 'Stairs / elevator', parking: 'Parking', heavy: 'Heavy items', photos: 'Photos' },
        photosVal: (n: number) => `${n} attached · view in your booking`,
        notesTitle: 'Notes',
        nextTitle: 'What happens next',
        steps: [
          { title: 'We review your request', desc: 'Our team checks the details of your move.' },
          { title: 'We confirm availability', desc: 'We lock in crew and timing for your date.' },
          { title: 'You get your confirmation', desc: 'We let you know the moment you’re approved.' },
        ],
        reassure: 'No action needed right now. Sit tight — we’ve got it from here.',
        cta: 'View booking',
        supportTitle: 'Need a hand?',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer:
          `This email confirms we’ve received your booking request — it is not a final confirmation. Pricing is an estimate and may adjust after we review access and details. The ${money(amountHold, es)} authorization is a hold, not a charge, and is released if your booking isn’t approved.`,
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
        defTruck: 'U-Haul — rented in your name',
      }

  const logistics = [
    { icon: 'steps' as const, label: t.logi.access, value: access },
    { icon: 'truck' as const, label: t.logi.parking, value: parking },
    { icon: 'weight' as const, label: t.logi.heavy, value: heavyItems },
    { icon: 'search' as const, label: t.logi.photos, value: photoCount ? t.photosVal(photoCount) : '' },
  ].filter((x) => x.value)

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.gold}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <AnimatedHero />
          <Spacer h={18} />
          <Pill tone="gold">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '26px', lineHeight: '33px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '420px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · STATUS + PAYMENT ─────────────────────────────── */}
      <Card>
        <Eyebrow icon="search" title={t.stTitle} tone="navy" />
        <Spacer h={4} />
        <HTimeline steps={t.tl} />
        <Divider my={20} />
        <Callout tone="gold">
          <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
            <tbody>
              <tr>
                <td valign="middle">
                  <table role="presentation" cellPadding={0} cellSpacing={0} border={0}>
                    <tbody>
                      <tr>
                        <td valign="middle" style={{ paddingRight: '10px' }}>
                          <IconChip icon="shield" color={C.goldInk} size={18} dim={34} border="1px solid #EAD9B0" radius={9} />
                        </td>
                        <td valign="middle">
                          <div style={{ fontFamily: FONT, fontSize: '22px', fontWeight: 800, color: C.navy, letterSpacing: '-0.3px' }}>{t.payBig}</div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
                <td valign="middle" align="right">
                  <span style={{ display: 'inline-block', background: '#FFFFFF', color: C.goldInk, border: '1px solid #EAD9B0', borderRadius: '999px', fontFamily: FONT, fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase' as const, padding: '7px 12px' }}>
                    {t.payBadge}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <Spacer h={12} />
          {t.pay.map((line, i) => (
            <table key={i} role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
              <tbody>
                <tr>
                  <td width={24} valign="top" style={{ width: '24px', paddingBottom: i === t.pay.length - 1 ? 0 : '8px' }}>
                    <span style={{ display: 'inline-block', width: '16px', height: '16px', lineHeight: '16px', borderRadius: '50%', background: '#FFFFFF', border: '1px solid #EAD9B0', color: C.goldInk, textAlign: 'center' as const, fontSize: '10px', fontWeight: 700 }}>&#10003;</span>
                  </td>
                  <td valign="top" style={{ paddingBottom: i === t.pay.length - 1 ? 0 : '8px', fontFamily: FONT, fontSize: '13.5px', lineHeight: '20px', color: C.body }}>{line}</td>
                </tr>
              </tbody>
            </table>
          ))}
        </Callout>
      </Card>

      <Spacer h={16} />

      {/* ── 3 · BOOKING SUMMARY ──────────────────────────────── */}
      <Card>
        <Eyebrow icon="clipboard" title={t.sumTitle} tone="orange" />
        <KVTable
          rows={[
            { label: t.kv.ref, value: displayId },
            { label: t.kv.name, value: customerName !== 'there' ? customerName : '' },
            { label: t.kv.service, value: service },
            { label: t.kv.date, value: dateOnly },
            { label: t.kv.time, value: timeOnly },
            { label: t.kv.crew, value: crewSize ? `${crewSize}` : '' },
            { label: t.kv.truck, value: truckLabel || t.defTruck },
            { label: t.kv.est, value: estimate, strong: true },
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

      {/* ── 5 · WHAT HAPPENS NEXT ────────────────────────────── */}
      <Card>
        <Eyebrow icon="steps" title={t.nextTitle} tone="orange" />
        <VSteps steps={t.steps} />
        <Spacer h={16} />
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
          <tbody>
            <tr>
              <td style={{ background: C.navy, borderRadius: '12px', padding: '15px 18px', fontFamily: FONT, fontSize: '13.5px', fontWeight: 600, color: C.bone, lineHeight: '20px' }}>
                {t.reassure}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      {/* ── 6 · PRIMARY CTA ──────────────────────────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={portalUrl} label={t.cta} />
      <Spacer h={26} />

      {/* ── 7 · SUPPORT ──────────────────────────────────────── */}
      <SupportBlock title={t.supportTitle} phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />

      {/* ── 8 · FOOTER ───────────────────────────────────────── */}
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
