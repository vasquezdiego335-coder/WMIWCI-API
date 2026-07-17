import * as React from 'react'
import {
  Shell,
  LogoHeader,
  Card,
  Eyebrow,
  Pill,
  Callout,
  Spacer,
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
//  BOOKING DECLINED  ("About your booking request")
//  Sent when the owner can't accept a request. Honest + kind: what happened,
//  the $49 authorization is RELEASED (never charged), and a warm invitation to
//  rebook. Shared _ui kit; bilingual EN/ES. No invented reasons.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  requestedDate?: string
  amountHold?: string
  reason?: string // optional, owner-provided; shown softly if present
  rebookUrl?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function BookingDeclinedEmail({
  customerName = 'there',
  displayId,
  requestedDate,
  amountHold,
  reason,
  rebookUrl = 'https://moveitclearit.com/book',
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const dateStr = requestedDate
    ? new Date(requestedDate).toLocaleDateString(es ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })
    : undefined

  const t = es
    ? {
        preview: `Sobre tu solicitud de reserva${displayId ? ` (${displayId})` : ''} — tu retención de ${money(amountHold, es)} fue liberada.`,
        pill: 'Actualización',
        h1: 'No pudimos aceptar esta mudanza.',
        sub: `Hola ${customerName}, gracias por pensar en nosotros${dateStr ? ` para el ${dateStr}` : ''}. Lamentablemente no podemos realizar esta mudanza${reason ? ` — ${reason}` : ''}.`,
        releaseTitle: `Tu retención de ${money(amountHold, es)} fue liberada`,
        releaseBody: 'No se te cobró nada. La autorización temporal en tu tarjeta se libera automáticamente (tu banco puede tardar unos días en mostrarlo).',
        cta: 'Reservar otra fecha',
        help: 'Si crees que fue un error o quieres encontrar otra fecha, llámanos o escríbenos — con gusto te ayudamos.',
        supportTitle: '¿Hablamos?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: `Este correo confirma que tu solicitud no fue aprobada y que la autorización de ${money(amountHold, es)} fue liberada.`,
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `About your booking request${displayId ? ` (${displayId})` : ''} — your ${money(amountHold, es)} hold was released.`,
        pill: 'Update',
        h1: "We couldn't take this move.",
        sub: `Hi ${customerName}, thank you for thinking of us${dateStr ? ` for ${dateStr}` : ''}. Unfortunately we're not able to take this one on${reason ? ` — ${reason}` : ''}.`,
        releaseTitle: `Your ${money(amountHold, es)} hold was released`,
        releaseBody: 'You were not charged. The temporary authorization on your card is released automatically (your bank may take a few days to drop it).',
        cta: 'Book another date',
        help: "If you think this was a mistake or you'd like to find another date, call or text us — we're happy to help.",
        supportTitle: 'Let’s talk',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: `This email confirms your request was not approved and the ${money(amountHold, es)} authorization was released.`,
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.navy}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <IconChip icon="shield" color={C.navy} size={26} dim={64} bg={C.navyTint} border="none" radius={18} />
          <Spacer h={16} />
          <Pill tone="navy">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '25px', lineHeight: '32px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '440px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · HOLD RELEASED ────────────────────────────────── */}
      <Callout tone="bone">
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
          <tbody>
            <tr>
              <td width={44} valign="top" style={{ width: '44px' }}>
                <IconChip icon="shield" color={C.goldInk} size={19} dim={36} bg="#FFFFFF" border="1px solid #EAD9B0" radius={10} />
              </td>
              <td valign="top" style={{ paddingLeft: '4px' }}>
                <div style={{ fontFamily: FONT, fontSize: '15px', fontWeight: 800, color: C.navy, marginBottom: '4px' }}>{t.releaseTitle}</div>
                <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{t.releaseBody}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </Callout>

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
        manageUrl={rebookUrl}
        unsubscribeUrl={rebookUrl}
        labels={t.footerLabels}
      />
    </Shell>
  )
}
