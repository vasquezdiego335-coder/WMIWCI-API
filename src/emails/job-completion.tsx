import * as React from 'react'
import {
  Shell,
  LogoHeader,
  Card,
  Eyebrow,
  Pill,
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
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  MOVE COMPLETE / THANK YOU  ("Your move is complete")
//  Rebuilt on the shared _ui kit to match the transactional emails. Closes the
//  loop after the job, points to the receipt, and sets up the review. Bilingual.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  completedAt?: string
  items?: string
  portalUrl?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function JobCompletionEmail({
  customerName = 'there',
  displayId,
  completedAt,
  items,
  portalUrl = '#',
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const dateStr = completedAt
    ? new Date(completedAt).toLocaleDateString(es ? 'es-US' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
    : undefined

  const t = es
    ? {
        preview: `¡Tu mudanza está completa, ${customerName}! Gracias por confiar en nosotros.`,
        pill: 'Mudanza completa',
        h1: '¡Tu mudanza está completa!',
        sub: `Gracias por confiar en nosotros con tus cosas, ${customerName}. Fue un gusto ayudarte${dateStr ? ` el ${dateStr}` : ''}.`,
        detailsTitle: 'Detalles del trabajo',
        cta: 'Ver mi recibo',
        nextTitle: '¿Qué sigue?',
        next: 'Tu recibo y el resumen del trabajo están en tu portal. En unos días te enviaremos un enlace para dejar una reseña — tu opinión significa muchísimo para nuestro equipo local.',
        supportTitle: 'Estamos para ayudarte',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: '¿Algo no quedó perfecto? Responde a este correo — lo resolvemos.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `Your move is complete, ${customerName}! Thank you for trusting us.`,
        pill: 'Move complete',
        h1: 'Your move is complete!',
        sub: `Thank you for trusting us with your belongings, ${customerName}. It was a pleasure helping you${dateStr ? ` on ${dateStr}` : ''}.`,
        detailsTitle: 'Job details',
        cta: 'View my receipt',
        nextTitle: "What's next",
        next: "Your receipt and job summary are in your portal. In a few days we'll send a link to leave a review — your feedback means everything to our small local crew.",
        supportTitle: "We're here to help",
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: "Something not quite right? Just reply to this email — we'll make it right.",
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.orange}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <IconChip icon="checklist" color={C.orange} size={26} dim={64} bg={C.orangeTint} border="none" radius={18} />
          <Spacer h={16} />
          <Pill tone="orange">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '27px', lineHeight: '34px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '430px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · JOB DETAILS (optional) ───────────────────────── */}
      {items ? (
        <>
          <Card>
            <Eyebrow icon="clipboard" title={t.detailsTitle} tone="navy" />
            {displayId ? (
              <div style={{ fontFamily: FONT, fontSize: '12px', fontWeight: 700, letterSpacing: '0.4px', color: C.muted, marginBottom: '10px' }}>{displayId}</div>
            ) : null}
            <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
              <tbody>
                <tr>
                  <td style={{ background: C.inset, borderRadius: '12px', borderLeft: `3px solid ${C.gold}`, padding: '14px 16px', fontFamily: FONT, fontSize: '14px', lineHeight: '21px', color: C.body, whiteSpace: 'pre-line' as const }}>{items}</td>
                </tr>
              </tbody>
            </table>
          </Card>
          <Spacer h={16} />
        </>
      ) : null}

      {/* ── 3 · WHAT'S NEXT ──────────────────────────────────── */}
      <Card>
        <Eyebrow icon="sparkle" title={t.nextTitle} tone="gold" />
        <p style={{ ...P, marginBottom: 0 }}>{t.next}</p>
      </Card>

      {/* ── 4 · CTA ──────────────────────────────────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={portalUrl} label={t.cta} />
      <Spacer h={26} />

      {/* ── 5 · SUPPORT ──────────────────────────────────────── */}
      <SupportBlock title={t.supportTitle} phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />

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
