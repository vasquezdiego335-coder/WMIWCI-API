// ════════════════════════════════════════════════════════════════════════
//  i18n — bilingual (English + Spanish) email subjects
//  ----------------------------------------------------------------------
//  The customer's preferred language is captured at booking time (the
//  marketing site's EN/ES toggle posts `locale`) and stored on the Customer.
//  Every customer-facing email subject runs through here so the whole
//  notification pipeline switches language with a single field.
//
//  The SMS copy catalog (and its t() helper) was removed on 2026-09-15: Move It
//  Clear It no longer sends SMS, and nothing called it any more.
//
//  Usage:
//    import { emailSubject, normalizeLocale, type Locale } from '@/lib/i18n'
// ════════════════════════════════════════════════════════════════════════

export type Locale = 'en' | 'es'

export const BIZ_PHONE = '862-640-0625'
// Brand line retired 2026-07-17: "We Move It. We Clear It." → "Move It Clear It."
export const BIZ_NAME = 'Move It Clear It.'

// Normalize anything that comes off the wire ("EN", "es-US", undefined…) to a
// supported Locale. Defaults to English.
export function normalizeLocale(value?: string | null): Locale {
  if (!value) return 'en'
  return value.trim().toLowerCase().startsWith('es') ? 'es' : 'en'
}

// ── Email subjects (bilingual) ────────────────────────────────────────────
// Subjects for every customer email template (bilingual). The English strings
// MUST match SUBJECTS in src/workers/email.worker.ts — a parity test enforces it.
// A template missing here used to go out with the business name as its subject
// ("Move It Clear It."), which is what every quote follow-up did until 2026-09-15.
export const EMAIL_SUBJECTS: Record<string, { en: string; es: string }> = {
  'pre-approval':        { en: "We've received your booking request",       es: 'Recibimos tu solicitud de reserva' },
  'final-confirmation':  { en: 'Your booking is approved',                  es: 'Tu reserva está aprobada' },
  'booking-declined':    { en: 'About your booking request',                es: 'Sobre tu solicitud de reserva' },
  'payment-receipt':     { en: 'Payment received — receipt enclosed',       es: 'Pago recibido — recibo adjunto' },
  'booking-updated':     { en: 'Your booking has been updated',             es: 'Tu reserva ha sido actualizada' },
  'booking-cancellation':{ en: 'Your booking has been cancelled',           es: 'Tu reserva ha sido cancelada' },
  'payment-failed':{ en: 'Action required — update your payment method', es: 'Acción requerida — actualiza tu método de pago' },
  'job-reminder':        { en: 'Your move is almost here',                  es: 'Tu mudanza ya casi llega' },
  'job-completion':      { en: 'Your move is complete — thank you',         es: 'Tu mudanza está completa — gracias' },
  'review-request':      { en: 'How did we do? Leave us a review',          es: '¿Cómo lo hicimos? Deja tu reseña' },
  'abandoned-checkout':  { en: 'Your date is still available',              es: 'Tu fecha sigue disponible' },
  'abandoned-checkout-2': { en: "What's included in a labor-only move",     es: 'Qué incluye una mudanza de solo mano de obra' },
  'abandoned-checkout-3': { en: 'Did your moving plans change?',            es: '¿Cambiaron tus planes de mudanza?' },
  'quote-followup-1':    { en: 'Did your quote come through?',              es: '¿Recibiste tu presupuesto?' },
  'quote-followup-2':    { en: 'What "labor-only" actually means',          es: 'Qué significa “solo mano de obra”' },
  'quote-followup-final':{ en: 'Are you still planning your move?',         es: '¿Todavía estás planeando tu mudanza?' },
  'referral':            { en: 'Give 15%. Get 15%.',                        es: 'Da 15%. Recibe 15%.' },
  'information-required':{ en: 'We need a few details to schedule your move', es: 'Necesitamos algunos datos para agendar tu mudanza' },
  'operational-alert':   { en: 'An update about your move',                 es: 'Una actualización sobre tu mudanza' },
  'final-invoice':       { en: 'Your final invoice',                        es: 'Tu factura final' },
  'referral-reward':     { en: 'Your referral reward is here',              es: 'Tu recompensa por recomendarnos ya está aquí' },
  'quote-request-received': { en: 'We received your moving estimate request', es: 'Recibimos su solicitud de estimado de mudanza' },
  'lead-nurture-1':      { en: 'To price your move, we need a few things',  es: 'Para cotizar tu mudanza necesitamos unos datos' },
  'lead-nurture-2':      { en: 'What "labor-only" actually means',          es: 'Qué significa “solo mano de obra”' },
  'lead-nurture-final':  { en: 'Do you still need an estimate?',            es: '¿Todavía necesitas un estimado?' },
}

/** The localized subject, or null when the catalog has no entry for this template. */
export function localizedSubject(template: string, locale?: string): string | null {
  const entry = EMAIL_SUBJECTS[template]
  if (!entry) return null
  return entry[normalizeLocale(locale)] ?? entry.en
}

export function emailSubject(template: string, locale?: string): string {
  return localizedSubject(template, locale) ?? BIZ_NAME
}
