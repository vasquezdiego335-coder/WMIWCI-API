import * as React from 'react'
import {
  Shell,
  LogoHeader,
  Card,
  Pill,
  Callout,
  Spacer,
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
  /**
   * ITEM C2 (release blocker B2) — DID THE RELEASE ACTUALLY HAPPEN?
   *
   * Every string in this template used to assert it. `declineBooking` cancels
   * the booking FIRST and then calls Stripe inside a try/catch that only warns,
   * so a Stripe 503 sent a customer "You were not charged. The temporary
   * authorization on your card is released" while $49 sat pending on their
   * statement for up to seven days — with the portal, the owner's Discord card
   * and the audit row all agreeing with the email.
   *
   * UNDEFINED IS UNPROVEN AND RENDERS THE HONEST VARIANT. That direction is
   * deliberate: a sender that has not been taught to prove the release gets the
   * copy that claims nothing, rather than the copy that claims everything.
   */
  holdReleased?: boolean
  /** FALSE when this booking never had an authorization at all (no payment
   *  intent) — then there is nothing to release and nothing to reassure about
   *  beyond "you were not charged", which IS provable. */
  holdEverExisted?: boolean
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
  holdReleased,
  holdEverExisted = true,
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

  // ── ITEM C1/C2 — THE PAYMENT SENTENCES, DERIVED ─────────────────────────
  //  `amt` is null when nobody proved an authorized figure: the sentences then
  //  name no amount instead of rendering money()'s "the amount shown above"
  //  filler inside "Your … hold was released".
  //  `released` / `noHold` are the two things that can be PROVEN; everything
  //  else is the honest third case, which claims the cancellation only.
  const amt = amountHold != null && String(amountHold).trim() !== '' ? money(amountHold, es) : null
  const released = holdReleased === true
  const noHold = holdEverExisted === false

  const release = es
    ? released
      ? {
          previewTail: amt ? `tu retención de ${amt} fue liberada.` : 'tu autorización fue liberada.',
          title: amt ? `Tu retención de ${amt} fue liberada` : 'Tu autorización fue liberada',
          body: 'No se te cobró nada. La autorización temporal en tu tarjeta se libera automáticamente (tu banco puede tardar unos días en mostrarlo).',
          disclaimer: amt
            ? `Este correo confirma que tu solicitud no fue aprobada y que la autorización de ${amt} fue liberada.`
            : 'Este correo confirma que tu solicitud no fue aprobada y que la autorización fue liberada.',
        }
      : noHold
        ? {
            previewTail: 'no se te cobró nada.',
            title: 'No se te cobró nada',
            body: 'Esta solicitud nunca generó un cargo ni una retención en tu tarjeta.',
            disclaimer: 'Este correo confirma que tu solicitud no fue aprobada. No hubo cargo ni retención en tu tarjeta.',
          }
        : {
            previewTail: 'tu reserva fue cancelada.',
            title: 'Estamos liberando la autorización de tu tarjeta',
            body: amt
              ? `Tu reserva está cancelada y estamos liberando la autorización de ${amt} en tu tarjeta. Si después de unos días sigue apareciendo como pendiente, llámanos o escríbenos y lo resolvemos de inmediato.`
              : 'Tu reserva está cancelada y estamos liberando la autorización temporal en tu tarjeta. Si después de unos días sigue apareciendo como pendiente, llámanos o escríbenos y lo resolvemos de inmediato.',
            disclaimer:
              'Este correo confirma que tu solicitud no fue aprobada y que tu reserva está cancelada. La autorización en tu tarjeta se está liberando.',
          }
    : released
      ? {
          previewTail: amt ? `your ${amt} hold was released.` : 'your authorization hold was released.',
          title: amt ? `Your ${amt} hold was released` : 'Your authorization hold was released',
          body: 'You were not charged. The temporary authorization on your card is released automatically (your bank may take a few days to drop it).',
          disclaimer: amt
            ? `This email confirms your request was not approved and the ${amt} authorization was released.`
            : 'This email confirms your request was not approved and the authorization was released.',
        }
      : noHold
        ? {
            previewTail: 'you were not charged.',
            title: 'You were not charged',
            body: 'This request never placed a charge or a hold on your card.',
            disclaimer: 'This email confirms your request was not approved. No charge and no hold were placed on your card.',
          }
        : {
            previewTail: 'your booking is cancelled.',
            title: 'We’re releasing the authorization on your card',
            body: amt
              ? `Your booking is cancelled and we’re releasing the ${amt} authorization on your card. If it is still showing as pending after a few days, call or text us and we’ll clear it right away.`
              : 'Your booking is cancelled and we’re releasing the temporary authorization on your card. If it is still showing as pending after a few days, call or text us and we’ll clear it right away.',
            disclaimer:
              'This email confirms your request was not approved and that your booking is cancelled. The authorization on your card is being released.',
          }

  const t = es
    ? {
        preview: `Sobre tu solicitud de reserva${displayId ? ` (${displayId})` : ''} — ${release.previewTail}`,
        pill: 'Actualización',
        h1: 'No pudimos aceptar esta mudanza.',
        sub: `Hola ${customerName}, gracias por pensar en nosotros${dateStr ? ` para el ${dateStr}` : ''}. Lamentablemente no podemos realizar esta mudanza${reason ? ` — ${reason}` : ''}.`,
        releaseTitle: release.title,
        releaseBody: release.body,
        cta: 'Reservar otra fecha',
        help: 'Si crees que fue un error o quieres encontrar otra fecha, llámanos o escríbenos — con gusto te ayudamos.',
        supportTitle: '¿Hablamos?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: release.disclaimer,
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `About your booking request${displayId ? ` (${displayId})` : ''} — ${release.previewTail}`,
        pill: 'Update',
        h1: "We couldn't take this move.",
        sub: `Hi ${customerName}, thank you for thinking of us${dateStr ? ` for ${dateStr}` : ''}. Unfortunately we're not able to take this one on${reason ? ` — ${reason}` : ''}.`,
        releaseTitle: release.title,
        releaseBody: release.body,
        cta: 'Book another date',
        help: "If you think this was a mistake or you'd like to find another date, call or text us — we're happy to help.",
        supportTitle: 'Let’s talk',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: release.disclaimer,
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
                <IconChip icon="shield" color={C.goldInk} size={19} dim={36} bg="#FFFFFF" border={`1px solid ${C.goldEdge}`} radius={10} />
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
      <SupportBlock title={t.supportTitle} phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />

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
