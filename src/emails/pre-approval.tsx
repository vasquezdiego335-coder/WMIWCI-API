import * as React from 'react'
import {
  Shell,
  LogoHeader,
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
  HTimeline,
  IconChip,
  C,
  FONT,
  P,
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
  amountHold = '49',
  portalUrl = '#',
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
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
        payBig: `Retención de $${amountHold}`,
        payBadge: 'No es un cargo',
        pay: ['Autorización temporal en tu tarjeta.', 'Se libera si no podemos realizar la mudanza.', 'Solo se cobra después de la aprobación.'],
        sumTitle: 'Resumen de la reserva',
        kv: { ref: 'Referencia', name: 'Nombre', service: 'Servicio', date: 'Fecha', time: 'Hora', crew: 'Equipo', truck: 'Camión', est: 'Total estimado' },
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
          'Este correo confirma que recibimos tu solicitud — no es una confirmación final. El precio es un estimado y puede ajustarse tras revisar acceso y detalles. La autorización de $49 es una retención, no un cargo, y se libera si tu reserva no se aprueba.',
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
        payBig: `$${amountHold} hold`,
        payBadge: 'Not a charge',
        pay: ['Temporary authorization on your card.', 'Released if we can’t take the move.', 'Only captured after approval.'],
        sumTitle: 'Booking summary',
        kv: { ref: 'Reference', name: 'Name', service: 'Service', date: 'Date', time: 'Time', crew: 'Crew', truck: 'Truck', est: 'Estimated total' },
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
          'This email confirms we’ve received your booking request — it is not a final confirmation. Pricing is an estimate and may adjust after we review access and details. The $49 authorization is a hold, not a charge, and is released if your booking isn’t approved.',
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
          <HeroArt />
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
      <Card>
        <Eyebrow icon="phone" title={t.supportTitle} tone="navy" />
        <ContactRow phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />
      </Card>

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

// ── Hero illustration — flat, geometric, brand-colored moving scene.
// Renders in Apple Mail / iOS (inline SVG). Gmail/Outlook strip inline SVG and
// simply show the copy below; host a PNG of this art and add it as an <img>
// fallback for pixel-parity in every client (see component notes).
function HeroArt() {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} border={0} align="center" style={{ margin: '0 auto' }}>
      <tbody>
        <tr>
          <td align="center" style={{ padding: '4px 0' }}>
            <svg width="300" height="128" viewBox="0 0 520 200" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Move It Clear It — moving in progress" style={{ display: 'block', maxWidth: '100%' }}>
              {/* ground */}
              <rect x="44" y="168" width="432" height="4" rx="2" fill="#EDE6D9" />
              {/* dashed route to destination pin */}
              <path d="M300 170 H436" stroke="#D4A24C" strokeWidth="4" strokeLinecap="round" strokeDasharray="2 12" />
              {/* boxes being loaded */}
              <rect x="20" y="118" width="46" height="42" rx="7" fill="#D4A24C" />
              <path d="M43 118 V160 M20 132 H66" stroke="#F7F1E4" strokeWidth="3" />
              <rect x="30" y="86" width="40" height="36" rx="7" fill="#FF6A00" />
              <path d="M50 86 V122 M30 100 H70" stroke="#FFE3CE" strokeWidth="3" />
              {/* truck cargo */}
              <rect x="86" y="72" width="150" height="76" rx="13" fill="#0D1A2D" />
              <rect x="86" y="120" width="150" height="11" fill="#FF6A00" />
              {/* chevron badge on cargo */}
              <path d="M138 88 L170 105 L138 122" stroke="#FF6A00" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              {/* cab */}
              <path d="M236 92 h34 l20 20 v36 a4 4 0 0 1 -4 4 h-50 z" fill="#0D1A2D" />
              <rect x="252" y="100" width="26" height="20" rx="4" fill="#FF6A00" opacity="0.9" />
              <rect x="288" y="140" width="8" height="12" rx="2" fill="#D4A24C" />
              {/* wheels */}
              <circle cx="132" cy="150" r="18" fill="#0D1A2D" />
              <circle cx="132" cy="150" r="8" fill="#F7F7F2" />
              <circle cx="256" cy="150" r="18" fill="#0D1A2D" />
              <circle cx="256" cy="150" r="8" fill="#F7F7F2" />
              {/* destination pin */}
              <circle cx="452" cy="118" r="18" fill="#0D1A2D" />
              <path d="M436 130 L452 158 L468 130 Z" fill="#0D1A2D" />
              <circle cx="452" cy="116" r="7" fill="#FF6A00" />
              {/* gold accent dots */}
              <circle cx="330" cy="150" r="3" fill="#D4A24C" />
              <circle cx="360" cy="150" r="3" fill="#D4A24C" />
              <circle cx="390" cy="150" r="3" fill="#D4A24C" />
            </svg>
          </td>
        </tr>
      </tbody>
    </table>
  )
}
