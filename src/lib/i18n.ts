// ════════════════════════════════════════════════════════════════════════
//  i18n — bilingual (English + Spanish) copy for SMS + email subjects
//  ----------------------------------------------------------------------
//  The customer's preferred language is captured at booking time (the
//  marketing site's EN/ES toggle posts `locale`) and stored on the Customer.
//  Every customer-facing SMS/email subject runs through here so the whole
//  notification pipeline switches language with a single field.
//
//  Usage:
//    import { t, type Locale } from '@/lib/i18n'
//    const msg = t(locale, 'depositHold', { displayId, phone: BIZ_PHONE })
// ════════════════════════════════════════════════════════════════════════

export type Locale = 'en' | 'es'

export const BIZ_PHONE = '862-640-0625'
export const BIZ_NAME = 'We Move It. We Clear It.'

// Normalize anything that comes off the wire ("EN", "es-US", undefined…) to a
// supported Locale. Defaults to English.
export function normalizeLocale(value?: string | null): Locale {
  if (!value) return 'en'
  return value.trim().toLowerCase().startsWith('es') ? 'es' : 'en'
}

type Vars = Record<string, string | number | undefined>

// Interpolate {placeholders} in a template string.
function fill(template: string, vars: Vars = {}): string {
  return template.replace(/\{(\w+)\}/g, (_m, key) =>
    vars[key] !== undefined ? String(vars[key]) : `{${key}}`
  )
}

// ── String catalog. Every key has an `en` and `es` value. ─────────────────
const STRINGS = {
  // Deposit authorized (hold placed) — sent right after Stripe checkout.
  depositHold: {
    en: `${BIZ_NAME}: Your $49 is authorized (a hold, not a charge) for booking {displayId} — we're reviewing it now and only capture it once approved. If anything fails we'll call or email you to confirm manually. — {phone}`,
    es: `${BIZ_NAME}: Tus $49 están autorizados (una retención, no un cargo) para la reserva {displayId} — la estamos revisando y solo la cobramos al aprobarla. Si algo falla, te llamaremos o escribiremos para confirmar manualmente. — {phone}`,
  },
  // Booking confirmed (approved).
  bookingConfirmed: {
    en: `Hi {name}! Your move with ${BIZ_NAME} is confirmed for {date}. Questions? Reply or call ${BIZ_PHONE}.`,
    es: `¡Hola {name}! Tu mudanza con ${BIZ_NAME} está confirmada para el {date}. ¿Preguntas? Responde o llama al ${BIZ_PHONE}.`,
  },
  // ── PRE-APPROVAL SMS (1 of the 2 allowed texts) — sent when an admin clicks
  //    ✅ Approve in Discord. Short approval confirmation.
  preApproval: {
    en: `Hi {name}! Booking {displayId} is approved — pending final confirmation for {date}. We'll be in touch. — ${BIZ_PHONE}`,
    es: `¡Hola {name}! La reserva {displayId} está aprobada — pendiente de confirmación final para {date}. Te contactaremos. — ${BIZ_PHONE}`,
  },
  // ── FINAL CONFIRMATION SMS (1 of the 2 allowed texts) — sent by
  //    fulfillPaidCheckout() once payment completes.
  finalConfirmation: {
    en: `Hi {name}! Booking {displayId} confirmed. $49 hold recorded. Next: we finalize your move for {date}. Questions? ${BIZ_PHONE}`,
    es: `¡Hola {name}! Reserva {displayId} confirmada. Retención de $49 registrada. Siguiente: finalizamos tu mudanza para {date}. ¿Preguntas? ${BIZ_PHONE}`,
  },
  // Booking declined — generic rebook (terminal deny).
  bookingDenied: {
    en: `Hi {name}, we're sorry — we can't take this move. {refundLine} Rebook anytime: {url} — If anything fails we'll call or email you to confirm manually. ${BIZ_PHONE}`,
    es: `Hola {name}, lo sentimos — no podemos realizar esta mudanza. {refundLine} Reserva de nuevo cuando quieras: {url} — Si algo falla te llamaremos o escribiremos para confirmar manualmente. ${BIZ_PHONE}`,
  },
  refundReleased: {
    en: `Your $49 hold has been released — you were not charged.`,
    es: `Tu retención de $49 fue liberada — no se te cobró.`,
  },
  refundPending: {
    en: `Your $49 hold will be released; you were not charged.`,
    es: `Tu retención de $49 será liberada; no se te cobró.`,
  },
  // Reschedule offer — declined date, but here are alternates (deposit kept).
  rescheduleOffer: {
    en: `Hi {name}, that date/time isn't available, but your $49 hold stays attached. Pick a new date here: {url} — or call ${BIZ_PHONE}. Options: {dates}`,
    es: `Hola {name}, esa fecha/hora no está disponible, pero tu retención de $49 se mantiene. Elige una nueva fecha aquí: {url} — o llama al ${BIZ_PHONE}. Opciones: {dates}`,
  },
  // Reschedule confirmed — customer picked a new date (hold stays attached).
  bookingRescheduled: {
    en: `Hi {name}! Your move is now set for {date}. Your $49 hold stays attached — no new charge. We'll confirm shortly. Questions? ${BIZ_PHONE}`,
    es: `¡Hola {name}! Tu mudanza ahora es el {date}. Tu retención de $49 se mantiene — sin cargo nuevo. Confirmaremos pronto. ¿Preguntas? ${BIZ_PHONE}`,
  },
  // Job started (crew en route).
  jobStarted: {
    en: `Your ${BIZ_NAME} crew is on the way! See you soon — ${BIZ_PHONE}`,
    es: `¡Tu equipo de ${BIZ_NAME} va en camino! Nos vemos pronto — ${BIZ_PHONE}`,
  },
  // Job completed.
  jobCompleted: {
    en: `All done! Thank you for choosing ${BIZ_NAME}. 🙌 Receipt sent to {email}`,
    es: `¡Listo! Gracias por elegir ${BIZ_NAME}. 🙌 Recibo enviado a {email}`,
  },
  // Contact-form auto-reply.
  contactAck: {
    en: `Thanks {name} — we got your message and will reply within a few hours. For anything urgent, call/text ${BIZ_PHONE}. — ${BIZ_NAME}`,
    es: `Gracias {name} — recibimos tu mensaje y responderemos en unas horas. Para algo urgente, llama o escribe al ${BIZ_PHONE}. — ${BIZ_NAME}`,
  },
  // Lead auto-reply (quote/QR lead from the marketing tracker). Owner-approved
  // customer message; gated by CUSTOMER_AUTOREPLY_ENABLED in notify.ts.
  leadAck: {
    en: `Thanks {name}! We got your moving request and will call you shortly. Urgent? Call/text ${BIZ_PHONE}. — ${BIZ_NAME}`,
    es: `¡Gracias {name}! Recibimos tu solicitud de mudanza y te llamaremos pronto. ¿Urgente? Llama o escribe al ${BIZ_PHONE}. — ${BIZ_NAME}`,
  },
  // ── Phase 3: post-move follow-ups (MARKETING — gated by MARKETING_FOLLOWUPS_ENABLED,
  //    frequency-capped, quiet-hours-aware, and suppressed on STOP opt-out). ──
  reviewRequest: {
    en: `Hi {name}! Thanks for moving with ${BIZ_NAME}. How did we do? A 30-second review really helps us: {url}`,
    es: `¡Hola {name}! Gracias por mudarte con ${BIZ_NAME}. ¿Cómo lo hicimos? Una reseña de 30 segundos nos ayuda mucho: {url}`,
  },
  reviewReminder: {
    en: `Hi {name}, we hope your move went great! If you have a moment, we'd love a quick review: {url}`,
    es: `Hola {name}, ¡esperamos que tu mudanza haya salido genial! Si tienes un momento, nos encantaría una reseña rápida: {url}`,
  },
  repeatReminder: {
    en: `Hi {name}! Moving again or need junk cleared? ${BIZ_NAME} has you covered — 10% off for return customers. Book: {url} or call ${BIZ_PHONE}`,
    es: `¡Hola {name}! ¿Te mudas otra vez o necesitas retirar cosas? ${BIZ_NAME} te ayuda — 10% de descuento para clientes que regresan. Reserva: {url} o llama al ${BIZ_PHONE}`,
  },
  referralAsk: {
    en: `Glad we could help, {name}! Know someone who needs movers? Send them our way and we'll take great care of them: {url} — ${BIZ_NAME}`,
    es: `¡Nos alegra haber ayudado, {name}! ¿Conoces a alguien que necesite mudanza? Envíalos con nosotros y los cuidaremos muy bien: {url} — ${BIZ_NAME}`,
  },
  // Appended to every marketing follow-up SMS (TCPA opt-out instruction).
  smsOptOut: {
    en: `Reply STOP to opt out.`,
    es: `Responde STOP para cancelar.`,
  },
} as const

export type StringKey = keyof typeof STRINGS

// Main translation function.
export function t(locale: Locale | string | undefined, key: StringKey, vars: Vars = {}): string {
  const loc = normalizeLocale(typeof locale === 'string' ? locale : locale)
  const entry = STRINGS[key]
  const template = entry[loc] ?? entry.en
  return fill(template, vars)
}

// ── Email subjects (bilingual) ────────────────────────────────────────────
const EMAIL_SUBJECTS: Record<string, { en: string; es: string }> = {
  'pre-approval':      { en: 'Your booking is approved — pending final confirmation', es: 'Tu reserva está aprobada — pendiente de confirmación final' },
  'final-confirmation':{ en: 'Booking confirmed — payment & next steps',            es: 'Reserva confirmada — pago y próximos pasos' },
  'pending-approval':  { en: 'We received your booking — pending approval', es: 'Recibimos tu reserva — pendiente de aprobación' },
  'booking-confirmed': { en: 'Your move is confirmed ✅',                    es: 'Tu mudanza está confirmada ✅' },
  'booking-denied':    { en: 'About your booking request',                  es: 'Sobre tu solicitud de reserva' },
  'reschedule-offer':  { en: 'Pick a new date for your move',               es: 'Elige una nueva fecha para tu mudanza' },
  'booking-rescheduled': { en: 'Your move has been rescheduled',             es: 'Tu mudanza ha sido reprogramada' },
  'job-completion':    { en: 'Your move is complete — receipt enclosed',    es: 'Tu mudanza está completa — recibo adjunto' },
  'contact-ack':       { en: 'We got your message',                         es: 'Recibimos tu mensaje' },
}

export function emailSubject(template: string, locale?: string): string {
  const loc = normalizeLocale(locale)
  const entry = EMAIL_SUBJECTS[template]
  if (!entry) return BIZ_NAME
  return entry[loc] ?? entry.en
}
