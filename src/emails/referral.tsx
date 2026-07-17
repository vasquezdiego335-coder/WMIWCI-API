import * as React from 'react'
import {
  Shell,
  LogoHeader,
  Card,
  Eyebrow,
  Pill,
  Spacer,
  PrimaryButton,
  ContactRow,
  MarketingFooter,
  C,
  FONT,
  P,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  REFERRAL  ("Give 15%. Get 15%.")
//  Sent a few days after a completed move. Short, warm, one action. Shows the
//  referral code prominently. Shared _ui kit; bilingual EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  referralCode?: string
  referralUrl?: string
  rewardPercent?: string
  portalUrl?: string
  /** Promotional unsubscribe URL (NEVER the booking page). Optional until the
      unsubscribe route ships. */
  unsubscribeUrl?: string
  postalAddress?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function ReferralEmail({
  customerName = 'there',
  referralCode = 'REFER15',
  referralUrl = 'https://moveitclearit.com/refer',
  rewardPercent = '15',
  portalUrl = '#',
  unsubscribeUrl,
  postalAddress,
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')

  const t = es
    ? {
        preview: `Da ${rewardPercent}%. Recibe ${rewardPercent}%. Comparte Move It Clear It.`,
        pill: 'Recomienda y ahorra',
        h1: `Da ${rewardPercent}%. Recibe ${rewardPercent}%.`,
        sub: `Gracias por confiar en nosotros, ${customerName}. ¿Conoces a alguien que se muda? Cuando reserve con tu código, ambos ahorran ${rewardPercent}%.`,
        codeLabel: 'Tu código para compartir',
        cta: 'Compartir con un amigo',
        how: 'Comparte tu código → tu amigo reserva y ahorra → tú recibes tu descuento en tu próxima mudanza o limpieza.',
        supportTitle: '¿Preguntas?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Te escribimos porque completamos tu mudanza recientemente. El descuento aplica cuando tu referido completa una mudanza pagada.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `Give ${rewardPercent}%. Get ${rewardPercent}%. Share Move It Clear It.`,
        pill: 'Refer & save',
        h1: `Give ${rewardPercent}%. Get ${rewardPercent}%.`,
        sub: `Thanks for trusting us, ${customerName}. Know someone who's moving? When they book with your code, you both save ${rewardPercent}%.`,
        codeLabel: 'Your code to share',
        cta: 'Refer a friend',
        how: 'Share your code → your friend books and saves → you get your discount on your next move or cleanout.',
        supportTitle: 'Questions?',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: "You're receiving this because we recently completed your move. The discount applies once your referral completes a paid move.",
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.orange}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          <div style={{ fontSize: '30px', lineHeight: '30px' }}>&#127873;</div>
          <Spacer h={14} />
          <Pill tone="orange">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '30px', lineHeight: '36px', fontWeight: 800, letterSpacing: '-0.6px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '430px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · CODE ─────────────────────────────────────────── */}
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} className="card" style={{ background: C.navy, borderRadius: '18px' }}>
        <tbody>
          <tr>
            <td className="cardpad" align="center" style={{ padding: '26px 30px', textAlign: 'center' as const }}>
              <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.4px', textTransform: 'uppercase' as const, color: C.gold, marginBottom: '12px' }}>{t.codeLabel}</div>
              <div style={{ display: 'inline-block', background: 'rgba(255,255,255,0.06)', border: `1.5px dashed ${C.gold}`, borderRadius: '12px', padding: '14px 26px' }}>
                <span style={{ fontFamily: FONT, fontSize: '26px', fontWeight: 800, letterSpacing: '4px', color: '#FFFFFF' }}>{referralCode}</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── 3 · CTA ──────────────────────────────────────────── */}
      <Spacer h={24} />
      <PrimaryButton href={referralUrl} label={t.cta} />
      <Spacer h={24} />

      {/* ── 4 · HOW IT WORKS ─────────────────────────────────── */}
      <Card>
        <Eyebrow icon="sparkle" title={es ? 'Cómo funciona' : 'How it works'} tone="gold" />
        <p style={{ ...P, marginBottom: 0 }}>{t.how}</p>
      </Card>

      <Spacer h={16} />

      {/* ── 5 · SUPPORT ──────────────────────────────────────── */}
      <Card>
        <Eyebrow icon="phone" title={t.supportTitle} tone="navy" />
        <ContactRow phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />
      </Card>

      {/* ── 6 · FOOTER ───────────────────────────────────────── */}
      <MarketingFooter
        disclaimer={t.disclaimer}
        phone={phone}
        email={email}
        websiteLabel={websiteLabel}
        social={social}
        unsubscribeUrl={unsubscribeUrl}
        postalAddress={postalAddress}
        labels={t.footerLabels}
      />
    </Shell>
  )
}
