import * as React from 'react'
import {
  Shell,
  LogoHeader,
  IconChip,
  Card,
  Eyebrow,
  HeroBlock,
  Callout,
  Spacer,
  PrimaryButton,
  SupportBlock,
  MarketingFooter,
  C,
  FONT,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  REFERRAL REWARD  ("Your referral reward is here")
//  Sent when someone a customer referred books/completes a move — the referrer
//  earned a reward. PROMOTIONAL (marketing footer + unsubscribe). Reward amount,
//  code, and expiry are DYNAMIC — nothing is invented; the code renders only if
//  supplied. Never promises a discount the booking data doesn't carry.
//  Bilingual EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  friendName?: string // the person they referred (first name)
  /** Human reward label, e.g. "$25 credit" or "15% off". Dynamic — required to
      state a specific reward; otherwise a neutral phrase is used. */
  rewardLabel?: string
  rewardCode?: string // promo/credit code, if any
  expiresLabel?: string // e.g. "through Sept 30" or "within 60 days"
  /** CTA link to redeem / book with the reward. */
  redeemUrl?: string
  unsubscribeUrl?: string
  postalAddress?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
}

export default function ReferralRewardEmail({
  customerName = 'there',
  friendName,
  rewardLabel,
  rewardCode,
  expiresLabel,
  redeemUrl = '#',
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
  const reward = rewardLabel && rewardLabel.trim()
    ? rewardLabel
    : es ? 'una recompensa de agradecimiento' : 'a thank-you reward'

  const t = es
    ? {
        preview: `Tu recompensa por recomendarnos ya está aquí, ${customerName}.`,
        pill: 'Recompensa desbloqueada',
        h1: '¡Ganaste una recompensa!',
        sub: friendName
          ? `Gracias por recomendarnos, ${customerName}. ${friendName} reservó su mudanza con nosotros — y ganaste ${reward}.`
          : `Gracias por recomendarnos, ${customerName}. Alguien que recomendaste reservó su mudanza — y ganaste ${reward}.`,
        rewardTitle: 'Tu recompensa',
        codeLabel: 'Tu código',
        expires: expiresLabel ? `Válido ${expiresLabel}.` : undefined,
        cta: 'Usar mi recompensa',
        thanks: 'Correr la voz sobre un negocio local significa muchísimo — gracias de parte de todo el equipo.',
        supportTitle: '¿Preguntas?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Recibiste este correo porque participas en nuestro programa de recomendaciones.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `Your referral reward is here, ${customerName}.`,
        pill: 'Reward unlocked',
        h1: 'You earned a reward!',
        sub: friendName
          ? `Thanks for spreading the word, ${customerName}. ${friendName} booked their move with us — and you earned ${reward}.`
          : `Thanks for spreading the word, ${customerName}. Someone you referred booked their move — and you earned ${reward}.`,
        rewardTitle: 'Your reward',
        codeLabel: 'Your code',
        expires: expiresLabel ? `Valid ${expiresLabel}.` : undefined,
        cta: 'Use my reward',
        thanks: 'Sending a local business your way means the world — thank you from the whole crew.',
        supportTitle: 'Questions?',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: "You're receiving this because you're part of our referral program.",
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <HeroBlock
        accent={C.gold}
        hero={<IconChip icon="sparkle" color={C.goldInk} size={26} dim={64} bg={C.goldTint} border="none" radius={18} />}
        pill={t.pill}
        pillTone="gold"
        title={t.h1}
        sub={t.sub}
        titleSize={26}
        subMaxWidth={440}
      />

      <Spacer h={16} />

      {/* ── 2 · REWARD ───────────────────────────────────────── */}
      <Card>
        <Eyebrow icon="sparkle" title={t.rewardTitle} tone="gold" />
        <div style={{ fontFamily: FONT, fontSize: '22px', fontWeight: 800, color: C.navy, letterSpacing: '-0.3px' }}>{reward}</div>
        {rewardCode && rewardCode.trim() ? (
          <>
            <Spacer h={14} />
            <Callout tone="gold">
              <div style={{ fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '1.2px', textTransform: 'uppercase' as const, color: C.goldInk, marginBottom: '6px' }}>{t.codeLabel}</div>
              <div style={{ fontFamily: FONT, fontSize: '20px', fontWeight: 800, letterSpacing: '2px', color: C.navy }}>{rewardCode}</div>
            </Callout>
          </>
        ) : null}
        {t.expires ? (
          <div style={{ fontFamily: FONT, fontSize: '12.5px', color: C.muted, marginTop: '12px' }}>{t.expires}</div>
        ) : null}
      </Card>

      {/* ── 3 · CTA ──────────────────────────────────────────── */}
      <Spacer h={26} />
      <PrimaryButton href={redeemUrl} label={t.cta} />
      <Spacer h={22} />

      {/* ── 4 · THANKS ───────────────────────────────────────── */}
      <Callout tone="bone">
        <div style={{ fontFamily: FONT, fontSize: '13.5px', lineHeight: '21px', color: C.body }}>{t.thanks}</div>
      </Callout>

      <Spacer h={16} />

      {/* ── 5 · SUPPORT ──────────────────────────────────────── */}
      <SupportBlock title={t.supportTitle} phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />

      {/* ── 6 · FOOTER (marketing) ───────────────────────────── */}
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
