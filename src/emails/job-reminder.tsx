import * as React from 'react'
import {
  Shell,
  LogoHeader,
  AnimatedHero,
  Card,
  Eyebrow,
  Pill,
  Callout,
  Checklist,
  Spacer,
  Divider,
  PrimaryButton,
  ContactRow,
  Footer,
  IconChip,
  WaitingPolicyNote,
  C,
  FONT,
  P,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  MOVE REMINDER  ("Your move is almost here")
//  Rebuilt on the shared _ui kit to match the confirmation email. Works for
//  both the 72h and 24h reminders — pass `leadLabel` ("in 3 days" / "tomorrow")
//  to tune the copy; otherwise it reads off the date. Bilingual EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  scheduledStart?: string
  timeLabel?: string
  leadLabel?: string
  originAddress?: string
  displayId?: string
  portalUrl?: string
  heroGifUrl?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  /** '72_hours' = prep reminder (movement OK); '24_hours' = imminent move-day (static). */
  stage?: '72_hours' | '24_hours'
  locale?: string
}

export default function JobReminderEmail({
  customerName = 'there',
  scheduledStart,
  timeLabel,
  leadLabel,
  originAddress,
  displayId,
  portalUrl = '#',
  heroGifUrl,
  stage = '24_hours',
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const locStr = es ? 'es-US' : 'en-US'
  const dateStr = scheduledStart
    ? new Date(scheduledStart).toLocaleDateString(locStr, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })
    : es ? 'muy pronto' : 'coming up soon'
  const timeStr = timeLabel || (scheduledStart ? new Date(scheduledStart).toLocaleTimeString(locStr, { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : undefined)

  const t = es
    ? {
        preview: `Tu mudanza es ${leadLabel || dateStr}. Aquí tienes cómo prepararte.`,
        pill: leadLabel || 'Próxima mudanza',
        h1: 'Tu mudanza ya casi llega.',
        sub: `Hola ${customerName}, tu equipo llega ${leadLabel ? leadLabel + ' — ' : ''}${dateStr}${timeStr ? ` a las ${timeStr}` : ''}. Prepárate y lo hacemos rápido.`,
        whenLabel: 'Tu mudanza está programada para',
        prepTitle: 'Antes de que llegue el equipo',
        prep: [
          'Ten el camión en el lugar de recogida.',
          'Desconecta electrodomésticos y arma las cajas.',
          'Despeja pasillos, puertas y la entrada.',
          'Ten listo el pago del saldo restante.',
        ],
        cta: 'Ver mi reserva',
        reschedule: '¿Necesitas reprogramar? Llámanos o escríbenos lo antes posible.',
        supportTitle: 'Estamos para ayudarte',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Te enviamos este recordatorio porque tienes una mudanza reservada con nosotros.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `Your move is ${leadLabel || dateStr}. Here's how to get ready.`,
        pill: leadLabel || 'Upcoming move',
        h1: 'Your move is almost here.',
        sub: `Hi ${customerName}, your crew arrives ${leadLabel ? leadLabel + ' — ' : ''}${dateStr}${timeStr ? ` at ${timeStr}` : ''}. A little prep keeps everything fast.`,
        whenLabel: 'Your move is scheduled for',
        prepTitle: 'Before the crew arrives',
        prep: [
          'Have the truck at the pickup location.',
          'Disconnect appliances and finish packing boxes.',
          'Clear pathways, doorways, and the driveway.',
          'Have payment ready for the remaining balance.',
        ],
        cta: 'View booking',
        reschedule: 'Need to reschedule? Call or text us as soon as you can.',
        supportTitle: "We're here to help",
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: "You're receiving this reminder because you have a move booked with us.",
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  // Stage-specific: 72h = prep focus (truck movement OK); 24h = imminent, static.
  const is72 = stage === '72_hours'
  const h1Text = is72 ? (es ? 'Es hora de preparar tu mudanza.' : 'Time to prep for your move.') : t.h1
  const ctaText = is72
    ? es ? 'Ver lista de preparación' : 'Review preparation checklist'
    : es ? 'Confirmar detalles de la mudanza' : 'Confirm move-day details'

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.orange}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          {is72 ? (
            <AnimatedHero heroGifUrl={heroGifUrl} />
          ) : (
            <IconChip icon="calendar" color={C.orangeInk} size={26} dim={64} bg={C.orangeTint} border="none" radius={18} />
          )}
          <Spacer h={16} />
          <Pill tone="orange">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '26px', lineHeight: '33px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {h1Text}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '430px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · WHEN BAND ────────────────────────────────────── */}
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} className="card" style={{ background: C.navy, borderRadius: '18px' }}>
        <tbody>
          <tr>
            <td className="cardpad" style={{ padding: '22px 30px' }}>
              <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
                <tbody>
                  <tr>
                    <td valign="middle">
                      <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.4px', textTransform: 'uppercase' as const, color: C.gold }}>{t.whenLabel}</div>
                      <div style={{ fontFamily: FONT, fontSize: '21px', fontWeight: 800, color: '#FFFFFF', marginTop: '7px', lineHeight: '27px' }}>{dateStr}</div>
                      {timeStr ? <div style={{ fontFamily: FONT, fontSize: '14px', fontWeight: 600, color: '#AEB8C6', marginTop: '4px' }}>{timeStr}{originAddress ? ` · ${originAddress}` : ''}</div> : null}
                    </td>
                    <td width={54} align="right" valign="middle" className="hide-sm" style={{ width: '54px' }}>
                      <IconChip icon="clock" color={C.gold} size={20} dim={46} border="none" radius={13} bg="rgba(212,162,76,0.16)" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      <Spacer h={16} />

      {/* ── 3 · PREP CHECKLIST ───────────────────────────────── */}
      <Card>
        <Eyebrow icon="checklist" title={t.prepTitle} tone="orange" />
        <Checklist items={t.prep} />
      </Card>

      {/* ── 3b · ARRIVAL & WAITING-TIME POLICY ───────────────── */}
      <Spacer h={16} />
      <WaitingPolicyNote lang={es ? 'es' : 'en'} variant="reminder" />

      {/* ── 4 · CTA ──────────────────────────────────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={portalUrl} label={ctaText} />
      <Spacer h={22} />

      {/* ── 5 · RESCHEDULE NOTE ──────────────────────────────── */}
      <Callout tone="gold">
        <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body, fontWeight: 600 }}>{t.reschedule}</div>
      </Callout>

      <Spacer h={16} />

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
