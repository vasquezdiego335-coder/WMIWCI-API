import * as React from 'react'
import {
  Shell,
  LogoHeader,
  IconChip,
  Card,
  Eyebrow,
  Pill,
  Callout,
  Checklist,
  Spacer,
  PrimaryButton,
  SupportBlock,
  MarketingFooter,
  C,
  FONT,
  P,
  money,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  ABANDONED CHECKOUT  ("Your date is still available")
//  Rebuilt on the shared _ui kit to match the transactional emails. One nudge,
//  one CTA back to checkout, a short reason-to-book. Bilingual EN/ES.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  checkoutUrl?: string
  requestedDate?: string
  amountHold?: string
  portalUrl?: string
  heroGifUrl?: string
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
  /** Recovery stage 1 | 2 | 3 — varies the copy, not the layout. */
  stage?: number
}

export default function AbandonedCheckoutEmail({
  customerName = 'there',
  checkoutUrl = '#',
  requestedDate,
  amountHold,
  portalUrl = '#',
  heroGifUrl,
  unsubscribeUrl,
  stage = 1,
  postalAddress,
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

  // ── STAGE COPY (recovery 1 / 2 / 3) ───────────────────────────────────
  // One template, three send times — the same pattern the 72h/24h reminder
  // uses. Each stage does a DIFFERENT job rather than repeating the nudge:
  //   1 (~45 min) — a helpful link back; they may simply have been interrupted
  //   2 (~24 h)   — answer the objection: what labor-only actually includes
  //   3 (~72 h)   — ask whether plans changed, and make leaving easy
  //
  // NOTHING here claims a countdown, a held slot, or a date about to be taken.
  // We do not check live availability at send time, so any such line would be
  // invented scarcity. The earlier "before someone else takes the slot" copy
  // was removed for exactly that reason.
  const stageCopy = (s: number) =>
    es
      ? {
          1: { pill: 'Casi listo', h1: 'Tu reserva quedó a medias.', lead: 'Aquí está tu enlace para terminarla.' },
          2: { pill: 'Qué incluye', h1: '¿Preguntas antes de reservar?', lead: 'Esto es exactamente lo que hacemos.' },
          3: { pill: '¿Seguimos?', h1: '¿Cambiaron tus planes?', lead: 'Sin problema — solo queremos saber.' },
        }[s] ?? { pill: 'Casi listo', h1: 'Tu reserva quedó a medias.', lead: '' }
      : {
          1: { pill: 'Almost there', h1: 'Your booking is half-finished.', lead: "Here's your link back to it." },
          2: { pill: "What's included", h1: 'Questions before you book?', lead: "Here's exactly what we do." },
          3: { pill: 'Still moving?', h1: 'Did your plans change?', lead: "No problem — we'd just like to know." },
        }[s] ?? { pill: 'Almost there', h1: 'Your booking is half-finished.', lead: '' }

  const sc = stageCopy(stage)

  const t = es
    ? {
        preview: `Termina tu reserva cuando quieras — depósito de ${money(amountHold, es)}.`,
        pill: sc.pill,
        h1: sc.h1,
        sub: `Hola ${customerName}, empezaste tu reserva pero no completaste el depósito de ${money(amountHold, es)}${dateStr ? ` para el ${dateStr}` : ''}. ${sc.lead}`,
        whyTitle: 'Por qué reservar con nosotros',
        why: [
          'Solo mano de obra — pagas por músculo, no por el margen del intermediario.',
          'Cargamos, descargamos, o las dos cosas — tú decides.',
          'Tú pones el camión de alquiler; nosotros ponemos el equipo de trabajo.',
          'Equipo local de Nueva Jersey, no un centro de llamadas nacional.',
        ],
        cta: 'Completar mi reserva',
        holdNote: `El depósito de ${money(amountHold, es)} es una retención, no un cargo — se aplica al total de tu mudanza.`,
        supportTitle: '¿Preguntas?',
        contactLabels: { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' },
        disclaimer: 'Te escribimos porque comenzaste una reserva con nosotros. ¿Ya no la necesitas? Puedes ignorar este correo.',
        footerLabels: { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' },
      }
    : {
        preview: `Finish your booking whenever you're ready — ${money(amountHold, es)} deposit.`,
        pill: sc.pill,
        h1: sc.h1,
        sub: `Hi ${customerName}, you started your booking but didn't finish the ${money(amountHold, es)} deposit${dateStr ? ` for ${dateStr}` : ''}. ${sc.lead}`,
        whyTitle: 'Why book with us',
        why: [
          // CLAIMS REMOVED (finding EMAIL-P1-14). Each of the following was
          // asserted with nothing in configuration or data to back it:
          //  • "moving equipment included" — not a verified service inclusion
          //  • "flat-rate pricing — no hidden fees" — stairs, travel, truck
          //    add-on and access fees can all apply, so this was untrue
          //  • "50+ completed moves across New Jersey" — a hard-coded count
          //    with no source and no counting rule
          // What remains is only what the business model itself guarantees.
          'Labor-only — you pay for muscle, not a middleman markup.',
          'We load, unload, or both — you tell us which.',
          'You keep your own rental truck; we bring the crew.',
          'Local New Jersey crew, not a national call centre.',
        ],
        cta: 'Complete my booking',
        // "secures your slot" removed (finding EMAIL-P1-14): the hold does not
        // reserve capacity — the booking still needs owner approval, so the slot
        // is not guaranteed at this point.
        holdNote: `The ${money(amountHold, es)} deposit is a hold, not a charge — it applies to your move total.`,
        supportTitle: 'Questions?',
        contactLabels: { phone: 'Call or text', email: 'Email', website: 'Website' },
        disclaimer: "You're receiving this because you started a booking with us. Changed your mind? You can ignore this email.",
        footerLabels: { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' },
      }

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.preview}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.orange}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          {/* Static booking-progress icon — NOT the truck animation (this is a
              pre-deposit draft; a moving truck would imply the crew is dispatched). */}
          <IconChip icon="clipboard" color={C.orangeInk} size={26} dim={64} bg={C.orangeTint} border="none" radius={18} />
          <Spacer h={16} />
          <Spacer h={16} />
          <Pill tone="orange">{t.pill}</Pill>
          <h1 className="h1" style={{ fontFamily: FONT, fontSize: '26px', lineHeight: '33px', fontWeight: 800, letterSpacing: '-0.4px', color: C.navy, margin: '16px 0 10px' }}>
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '430px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      {/* ── 2 · CTA ──────────────────────────────────────────── */}
      <Spacer h={24} />
      <PrimaryButton href={checkoutUrl} label={t.cta} />
      <Spacer h={14} />
      <div style={{ textAlign: 'center' as const, fontFamily: FONT, fontSize: '12.5px', lineHeight: '19px', color: C.muted, maxWidth: '420px', margin: '0 auto', padding: '0 10px' }}>
        {t.holdNote}
      </div>
      <Spacer h={24} />

      {/* ── 3 · WHY BOOK WITH US ─────────────────────────────── */}
      <Card>
        <Eyebrow icon="shield" title={t.whyTitle} tone="gold" />
        <Checklist items={t.why} />
      </Card>

      <Spacer h={16} />

      {/* ── 4 · SUPPORT ──────────────────────────────────────── */}
      <SupportBlock title={t.supportTitle} phone={phone} email={email} website={website} websiteLabel={websiteLabel} labels={t.contactLabels} />

      {/* ── 5 · FOOTER ───────────────────────────────────────── */}
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
