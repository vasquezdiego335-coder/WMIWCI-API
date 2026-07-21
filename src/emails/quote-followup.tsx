import * as React from 'react'
import {
  Shell,
  LogoHeader,
  IconChip,
  Card,
  Eyebrow,
  Pill,
  Checklist,
  Spacer,
  PrimaryButton,
  SupportBlock,
  MarketingFooter,
  C,
  FONT,
  P,
} from './_ui'

// ════════════════════════════════════════════════════════════════════════
//  QUOTE FOLLOW-UP  (stages 1 / 2 / final)
//  ---------------------------------------------------------------------
//  Sent to a LEAD who was given a real quote and has not booked.
//
//  HARD CONSTRAINT — READ BEFORE EDITING:
//  This schema has NO Quote model. A Lead carries `quotedAt`, `estimatedValue`,
//  `jobType` and `moveDate` — and NOTHING else about the quote. There is no
//  stored crew size, no service breakdown, no line items, no validity window.
//
//  So this email DOES NOT RESTATE THE QUOTE. It cannot: any figure or detail it
//  printed would be invented. It references the fact that a quote was given and
//  drives back to the booking form, where the real numbers live. If a Quote
//  model is added later (see docs/email-marketing/segmentation.md), this
//  template gains a quote-details block — until then, silence is the honest
//  option.
//
//  Also absent by design: countdowns, "your quote expires in N days", and any
//  availability claim. We do not check live capacity when this sends.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  /** Free-text job type from the lead record, when we have one. */
  jobType?: string
  /** ISO date. Rendered only when present — never guessed. */
  moveDate?: string
  bookingUrl?: string
  /** Promotional unsubscribe URL. Required for a promotional send. */
  unsubscribeUrl?: string
  postalAddress?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
  /** 1 = did you get it · 2 = objections · 3 = still moving? */
  stage?: number
}

export default function QuoteFollowupEmail({
  customerName = 'there',
  jobType,
  moveDate,
  bookingUrl = '#',
  unsubscribeUrl,
  postalAddress,
  phone = '862-640-0625',
  email = 'hello@moveitclearit.com',
  website = 'https://moveitclearit.com',
  websiteLabel = 'moveitclearit.com',
  social,
  locale = 'en',
  stage = 1,
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const dateStr = moveDate
    ? new Date(moveDate).toLocaleDateString(es ? 'es-US' : 'en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/New_York',
      })
    : undefined

  // Stage 1 — did it arrive, can we help.
  // Stage 2 — the real objection: people do not know what "labor-only" means.
  // Stage 3 — permission to say no. Plans genuinely change.
  const copy = es
    ? {
        1: {
          pill: 'Tu presupuesto',
          h1: '¿Recibiste tu presupuesto?',
          sub: `Hola ${customerName}, te enviamos un presupuesto${dateStr ? ` para el ${dateStr}` : ''}. Solo queremos confirmar que te llegó.`,
          body: 'Si tienes preguntas sobre el precio o lo que incluye, respóndenos o llámanos. Contestamos nosotros mismos.',
        },
        2: {
          pill: 'Cómo funciona',
          h1: 'Qué significa “solo mano de obra”.',
          sub: `Hola ${customerName}, la pregunta más común que recibimos es qué pones tú y qué ponemos nosotros.`,
          body: 'Aquí está la respuesta corta:',
        },
        3: {
          pill: '¿Seguimos?',
          h1: '¿Todavía te mudas?',
          sub: `Hola ${customerName}, no queremos seguir escribiéndote si tus planes cambiaron.`,
          body: 'Si ya no necesitas ayuda, ignora este correo y no te escribimos más sobre esto. Si la fecha cambió, avísanos y lo ajustamos.',
        },
      }
    : {
        1: {
          pill: 'Your quote',
          h1: 'Did your quote come through?',
          sub: `Hi ${customerName}, we sent you a quote${dateStr ? ` for ${dateStr}` : ''}. We just want to make sure it reached you.`,
          body: 'If you have questions about the price or what it covers, reply here or give us a call. You get one of us, not a call centre.',
        },
        2: {
          pill: 'How it works',
          h1: 'What "labor-only" actually means.',
          sub: `Hi ${customerName}, the question we get most is which parts are ours and which parts are yours.`,
          body: "Here's the short version:",
        },
        3: {
          pill: 'Still moving?',
          h1: 'Are you still planning your move?',
          sub: `Hi ${customerName}, we don't want to keep emailing you if your plans have changed.`,
          body: "If you don't need help any more, ignore this and we'll stop writing about it. If the date moved, tell us and we'll work around it.",
        },
      }

  const t = (copy as Record<number, (typeof copy)[1]>)[stage] ?? copy[1]

  // ONLY facts about the service model — nothing about price, crew size, or
  // availability, none of which this record contains.
  const included = es
    ? [
        'Nosotros ponemos: los movers, el equipo y el trabajo pesado.',
        'Tú pones: el camión de alquiler (o el espacio de almacenamiento).',
        'Cargamos, descargamos, o las dos cosas — tú decides.',
        'No transportamos ni empacamos por ti.',
      ]
    : [
        'We bring: the movers, the equipment, and the heavy lifting.',
        'You bring: the rental truck (or the storage unit).',
        'We load, unload, or both — your call.',
        "We don't drive the truck and we don't pack for you.",
      ]

  return (
    <Shell lang={es ? 'es' : 'en'} preview={t.sub}>
      <LogoHeader />

      {/* ── 1 · HERO ─────────────────────────────────────────── */}
      <Card style={{ borderTop: `3px solid ${C.orange}` }}>
        <div className="heropad" style={{ textAlign: 'center' as const }}>
          {/* Static icon, not the truck animation — no crew is dispatched. */}
          <IconChip
            icon={stage === 2 ? 'checklist' : stage === 3 ? 'calendar' : 'clipboard'}
            color={C.orangeInk}
            size={26}
            dim={64}
            bg={C.orangeTint}
            border="none"
            radius={18}
          />
          <Spacer h={16} />
          <Pill tone="orange">{t.pill}</Pill>
          <h1
            className="h1"
            style={{
              fontFamily: FONT,
              fontSize: '26px',
              lineHeight: '33px',
              fontWeight: 800,
              letterSpacing: '-0.4px',
              color: C.navy,
              margin: '16px 0 10px',
            }}
          >
            {t.h1}
          </h1>
          <p style={{ ...P, marginBottom: 0, maxWidth: '430px', marginLeft: 'auto', marginRight: 'auto' }}>{t.sub}</p>
        </div>
      </Card>

      <Spacer h={16} />

      {/* ── 2 · BODY ─────────────────────────────────────────── */}
      <Card>
        <p style={{ ...P }}>{t.body}</p>
        {stage === 2 ? (
          <>
            <Spacer h={6} />
            <Checklist items={included} />
          </>
        ) : null}
        {jobType && stage === 1 ? (
          <>
            <Spacer h={10} />
            {/* The job type is a stored lead field — safe to echo back. */}
            <Eyebrow icon="clipboard" title={es ? 'Lo que nos dijiste' : 'What you told us'} tone="navy" />
            <p style={{ ...P, marginBottom: 0 }}>{jobType}</p>
          </>
        ) : null}
      </Card>

      {/* ── 3 · CTA ──────────────────────────────────────────── */}
      <Spacer h={22} />
      <div style={{ textAlign: 'center' as const }}>
        <PrimaryButton href={bookingUrl} label={es ? 'Reservar mi mudanza' : 'Book my move'} />
      </div>

      <Spacer h={26} />
      <SupportBlock
        title={es ? '¿Preguntas?' : 'Questions?'}
        phone={phone}
        email={email}
        website={website}
        websiteLabel={websiteLabel}
        labels={
          es
            ? { phone: 'Llama o escribe', email: 'Correo', website: 'Sitio web' }
            : { phone: 'Call or text', email: 'Email', website: 'Website' }
        }
      />

      <MarketingFooter
        disclaimer={
          es
            ? 'Te escribimos porque pediste un presupuesto para una mudanza.'
            : "You're receiving this because you asked us for a moving quote."
        }
        unsubscribeUrl={unsubscribeUrl}
        postalAddress={postalAddress}
        phone={phone}
        email={email}
        websiteLabel={websiteLabel}
        social={social}
        labels={
          es
            ? { manage: 'Administrar preferencias', unsubscribe: 'Cancelar suscripción', rights: 'Todos los derechos reservados.' }
            : { manage: 'Manage preferences', unsubscribe: 'Unsubscribe', rights: 'All rights reserved.' }
        }
      />
    </Shell>
  )
}
