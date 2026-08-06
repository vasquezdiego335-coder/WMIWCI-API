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
//  NON-QUOTE LEAD NURTURE  (stages 1 / 2 / final) — owner spec 2026-08-06
//  ---------------------------------------------------------------------
//  Sent to a lead who gave us an email and an intent but has NO calculated
//  quote: a contact-form message, a coupon capture, a tracker lead, or a
//  quick quote that asked for an in-person visit instead of a number.
//
//  WHY THIS IS NOT quote-followup.tsx. That template opens with "we sent you a
//  quote" and "did your quote come through?". For these people that is simply
//  untrue, and there is no wording tweak that makes a quote-recovery email
//  honest when no quote exists. Two audiences, two templates.
//
//  HARD CONSTRAINTS — READ BEFORE EDITING:
//   • NO PRICE, EVER. Not a range, not a "starting at", not an average. Nothing
//     about this lead's job has been priced, so any figure would be invented.
//   • NO "finish your booking" / "complete checkout" wording. They never
//     started one.
//   • NO availability or scarcity claim. We do not check live capacity here.
//   • Stage 1 asks for the information we genuinely need to price the job.
//     That list is the honest reason this email exists at all.
//
//  PROMOTIONAL by classification (email-guard), so it carries the full
//  MarketingFooter: unsubscribe link, postal address, and the reason they are
//  hearing from us. The send guard refuses it outright when any of those are
//  unconfigured — see marketing-context.ts.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  /** Where to go to get a real number. The primary CTA — required by validation. */
  quoteUrl?: string
  /** Promotional unsubscribe URL. Required for a promotional send. */
  unsubscribeUrl?: string
  postalAddress?: string
  phone?: string
  email?: string
  website?: string
  websiteLabel?: string
  social?: { instagram?: string; facebook?: string; tiktok?: string; google?: string }
  locale?: string
  /** 1 = what we need · 2 = how labor-only works · 3 = still need an estimate */
  stage?: number
}

export default function LeadNurtureEmail({
  customerName = 'there',
  quoteUrl = '#',
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

  const copy = es
    ? {
        1: {
          pill: 'Tu estimado',
          h1: 'Para darte un número exacto, necesitamos esto.',
          sub: `Hola ${customerName}, recibimos tu mensaje. Un estimado honesto depende de unos pocos datos — estos son los que marcan la diferencia.`,
          body: 'Respóndenos con lo que sepas. No necesitamos una lista perfecta; con esto ya podemos darte un precio real en vez de un rango inventado.',
          cta: 'Obtener mi estimado',
        },
        2: {
          pill: 'Cómo funciona',
          h1: 'Qué significa “solo mano de obra”.',
          sub: `Hola ${customerName}, la pregunta que más recibimos es qué pones tú y qué ponemos nosotros.`,
          body: 'Aquí está la respuesta corta:',
          cta: 'Ver mi estimado',
        },
        3: {
          pill: '¿Seguimos?',
          h1: '¿Todavía necesitas un estimado?',
          sub: `Hola ${customerName}, no queremos seguir escribiéndote si ya resolviste tu mudanza.`,
          body: 'Si ya no lo necesitas, ignora este correo y dejamos de escribirte sobre esto. Si todavía lo necesitas, contéstanos y lo vemos hoy mismo.',
          cta: 'Obtener mi estimado',
        },
      }
    : {
        1: {
          pill: 'Your estimate',
          h1: 'To give you a real number, we need a few things.',
          sub: `Hi ${customerName}, we got your message. An honest estimate comes down to a handful of details — these are the ones that actually change the price.`,
          body: "Reply with whatever you know. It doesn't have to be a perfect list; this much is enough for us to give you a real number instead of a made-up range.",
          cta: 'Get my estimate',
        },
        2: {
          pill: 'How it works',
          h1: 'What "labor-only" actually means.',
          sub: `Hi ${customerName}, the question we get most is which parts are ours and which parts are yours.`,
          body: "Here's the short version:",
          cta: 'Get my estimate',
        },
        3: {
          pill: 'Still moving?',
          h1: 'Do you still need an estimate?',
          sub: `Hi ${customerName}, we don't want to keep emailing you if your move is already sorted.`,
          body: "If you don't need us any more, ignore this and we'll stop writing about it. If you do, reply and we'll get you a number today.",
          cta: 'Get my estimate',
        },
      }

  const t = (copy as Record<number, (typeof copy)[1]>)[stage] ?? copy[1]

  // STAGE 1 — the information that genuinely changes a labor-only price. Every
  // line here maps to a real input of the price book (move size, stairs, truck,
  // date). Nothing aspirational, nothing we do not actually use.
  const needed = es
    ? [
        'De dónde a dónde (ciudad o código postal de cada lado).',
        'Qué día — o la semana, si aún no es fijo.',
        'El tamaño: estudio, 1, 2, 3 recámaras, o solo unos muebles.',
        'Escaleras o ascensor en cualquiera de los dos lados.',
        'Cosas pesadas o delicadas: piano, caja fuerte, mármol.',
      ]
    : [
        'Where to where — a city or ZIP on each end.',
        "What day, or which week if it isn't fixed yet.",
        'How much: studio, 1, 2, 3 bedrooms, or just a few pieces.',
        'Stairs or an elevator at either end.',
        'Anything heavy or fragile — piano, safe, stone tops.',
      ]

  // STAGE 2 — only facts about the service model. No price, no crew size, no
  // availability: none of that is known for this lead.
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
        {stage === 1 ? (
          <>
            <Eyebrow icon="clipboard" title={es ? 'Lo que necesitamos' : 'What we need'} tone="navy" />
            <Checklist items={needed} />
            <Spacer h={10} />
          </>
        ) : null}
        <p style={{ ...P, marginBottom: stage === 2 ? undefined : 0 }}>{t.body}</p>
        {stage === 2 ? (
          <>
            <Spacer h={6} />
            <Checklist items={included} />
          </>
        ) : null}
      </Card>

      {/* ── 3 · CTA ──────────────────────────────────────────── */}
      <Spacer h={22} />
      <div style={{ textAlign: 'center' as const }}>
        <PrimaryButton href={quoteUrl} label={t.cta} />
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
            ? 'Te escribimos porque nos contactaste sobre una mudanza y aceptaste recibir correos nuestros.'
            : "You're receiving this because you contacted us about a move and opted in to hear from us."
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
