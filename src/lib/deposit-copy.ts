// ════════════════════════════════════════════════════════════════════════════
//  deposit-copy.ts — every word on the deposit page, in English and Spanish.
//  ------------------------------------------------------------------------
//  DELIBERATE TRANSLATION, not machine translation. A large share of this
//  business's customers are Spanish-speaking, and this is the page where
//  someone hands over money: "saldo restante" has to mean what it says, and a
//  cancellation policy has to be as precise in Spanish as in English or it is
//  not a policy, it is decoration.
//
//  The shape is a single record keyed by locale so the two can never drift out
//  of step — a missing Spanish key is a TYPE ERROR, not a silently English
//  string appearing mid-page. That is enforced by `Copy` below being derived
//  from the English object.
//
//  NOTHING HERE IS A NUMBER. Every amount, date and name is interpolated by the
//  caller from the accepted-quote snapshot. Copy must never be able to state a
//  price, which is why there is no `$49` anywhere in this file.
// ════════════════════════════════════════════════════════════════════════════

export type Lang = 'en' | 'es'
export const LANGS: readonly Lang[] = ['en', 'es'] as const

const EN = {
  // ── Head / identity ──
  brand: 'Move It Clear It',
  langLabel: 'Language',
  english: 'English',
  spanish: 'Español',

  // ── Primary ──
  title: 'Secure Your Move',
  intro: 'Review your quote and pay the deposit to reserve your move.',
  greeting: 'Hi {name} — here are your details.',

  // ── Details ──
  moveDate: 'Move date',
  service: 'Service',

  // ── Money ──
  quoteTotal: 'Quote total',
  depositDue: 'Deposit due today',
  remaining: 'Remaining balance after deposit',
  appliedNote: 'This deposit is applied to the total balance of your move.',

  // ── Action ──
  payButton: 'Pay {amount} Securely',
  paying: 'Opening secure checkout…',
  stripeNote: 'Secure payment processed by Stripe',

  // ── Reassurance ──
  reassureTitle: 'What happens next',
  reassureApplied: 'Your deposit comes off the total you owe on move day.',
  reassureQuote: 'Your quoted price is locked in — we do not change it after you pay.',
  reassureHelp: 'A real person answers. Call or text us any time.',
  helpTitle: 'Need help? Call or text us.',

  // ── Confirming ──
  confirmingTitle: 'Confirming your payment…',
  confirmingBody: 'This takes a few seconds. Please keep this page open.',
  slowTitle: 'Still confirming your payment',
  slowBody:
    'Your bank may take a moment. You have not been charged twice — please do not pay again. Refresh this page shortly, or contact us and we will confirm it for you.',
  refresh: 'Refresh',

  // ── Terminal states ──
  paidBadge: 'Deposit received',
  paidTitle: 'Thank you{name}',
  paidAmount: 'Amount paid',
  paidDate: 'Payment date',
  paidRemaining: 'Remaining balance',
  paidApplied: 'This deposit has been applied toward your moving balance.',

  expiredTitle: 'This payment link has expired',
  canceledTitle: 'This payment link is no longer active',
  closedBody: 'Nothing was charged. Call or text us and we will send you a new one.',

  invalidTitle: 'Payment link not found',
  invalidBody: 'This link is not valid. Nothing was charged. Call or text us and we will send you a new one.',

  unavailableTitle: 'We can’t load this right now',
  unavailableBody:
    'Your link is fine — we just could not reach our system for a moment. Nothing has been charged. Please refresh in a minute, or contact us and we will take the payment another way.',

  canceledNotice: 'Payment was not completed. Nothing was charged — you can try again below.',
  errorGeneric: 'We could not start the payment. Please try again, or contact us and we will help.',
  errorNetwork: 'We could not reach the payment page. Check your connection and try again.',
  tryAgain: 'Try again',

  // ── Legal ──
  policyTitle: 'Cancellation & rescheduling',
  policyBody:
    'Rescheduling requests must be submitted at least 72 hours before the scheduled service time. Same-day cancellations may result in a cancellation fee equal to 2 hours of labor.',
  fullTerms: 'Full terms',
  terms: 'Terms of Service',

  callUs: 'Call us',
  textUs: 'Text us',
} as const

/** The contract. Spanish must supply every key English does. */
export type Copy = { readonly [K in keyof typeof EN]: string }

const ES: Copy = {
  brand: 'Move It Clear It',
  langLabel: 'Idioma',
  english: 'English',
  spanish: 'Español',

  title: 'Asegure su mudanza',
  intro: 'Revise su cotización y pague el depósito para reservar su mudanza.',
  greeting: 'Hola {name} — estos son sus detalles.',

  moveDate: 'Fecha de la mudanza',
  service: 'Servicio',

  quoteTotal: 'Total de la cotización',
  depositDue: 'Depósito a pagar hoy',
  remaining: 'Saldo restante después del depósito',
  appliedNote: 'Este depósito se aplica al saldo total de su mudanza.',

  payButton: 'Pagar {amount} de forma segura',
  paying: 'Abriendo el pago seguro…',
  stripeNote: 'Pago seguro procesado por Stripe',

  reassureTitle: 'Qué sigue',
  reassureApplied: 'Su depósito se descuenta del total que debe el día de la mudanza.',
  reassureQuote: 'Su precio cotizado queda fijo — no lo cambiamos después de que usted pague.',
  reassureHelp: 'Le contesta una persona real. Llámenos o escríbanos cuando quiera.',
  helpTitle: '¿Necesita ayuda? Llámenos o envíenos un mensaje.',

  confirmingTitle: 'Confirmando su pago…',
  confirmingBody: 'Esto toma unos segundos. Por favor mantenga esta página abierta.',
  slowTitle: 'Seguimos confirmando su pago',
  slowBody:
    'Su banco puede tardar un momento. No se le ha cobrado dos veces — por favor no pague de nuevo. Actualice esta página en un momento, o comuníquese con nosotros y se lo confirmamos.',
  refresh: 'Actualizar',

  paidBadge: 'Depósito recibido',
  paidTitle: 'Gracias{name}',
  paidAmount: 'Cantidad pagada',
  paidDate: 'Fecha del pago',
  paidRemaining: 'Saldo restante',
  paidApplied: 'Este depósito se ha aplicado al saldo de su mudanza.',

  expiredTitle: 'Este enlace de pago ha vencido',
  canceledTitle: 'Este enlace de pago ya no está activo',
  closedBody: 'No se realizó ningún cobro. Llámenos o escríbanos y le enviaremos uno nuevo.',

  invalidTitle: 'Enlace de pago no encontrado',
  invalidBody:
    'Este enlace no es válido. No se realizó ningún cobro. Llámenos o escríbanos y le enviaremos uno nuevo.',

  unavailableTitle: 'No podemos cargar esto en este momento',
  unavailableBody:
    'Su enlace está bien — solo no pudimos conectarnos con nuestro sistema por un momento. No se ha realizado ningún cobro. Actualice en un minuto, o comuníquese con nosotros y tomaremos el pago de otra manera.',

  canceledNotice: 'El pago no se completó. No se realizó ningún cobro — puede intentarlo de nuevo abajo.',
  errorGeneric: 'No pudimos iniciar el pago. Inténtelo de nuevo, o comuníquese con nosotros y le ayudamos.',
  errorNetwork: 'No pudimos conectar con la página de pago. Revise su conexión e inténtelo de nuevo.',
  tryAgain: 'Intentar de nuevo',

  policyTitle: 'Cancelación y reprogramación',
  // The English policy is the approved one; this states the SAME terms, with the
  // same numbers. It is a translation, never a second policy.
  policyBody:
    'Las solicitudes de reprogramación deben enviarse al menos 72 horas antes de la hora de servicio programada. Las cancelaciones el mismo día pueden generar un cargo por cancelación equivalente a 2 horas de mano de obra.',
  fullTerms: 'Términos completos',
  terms: 'Términos del Servicio',

  callUs: 'Llamar',
  textUs: 'Enviar mensaje',
}

export const COPY: Record<Lang, Copy> = { en: EN, es: ES }

/** Substitute {placeholders}. Absent values collapse to an empty string rather
 *  than printing "{name}" at a customer. */
export function fill(template: string, vars: Record<string, string | null | undefined> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => vars[key] ?? '')
}

/**
 * Best initial language from an Accept-Language header.
 *
 * Server-side so a Spanish speaker's FIRST paint is Spanish — switching after
 * the fact still works, but a page that opens in the wrong language has already
 * asked them to work for it. Defaults to English on anything ambiguous.
 */
export function pickLang(acceptLanguage?: string | null): Lang {
  if (!acceptLanguage) return 'en'
  // "es-MX,es;q=0.9,en;q=0.8" → take the first tag we recognise, by q-order.
  const tags = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';')
      const q = params.find((p) => p.trim().startsWith('q='))
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.split('=')[1]) || 0 : 1 }
    })
    .filter((t) => t.tag)
    .sort((a, b) => b.q - a.q)
  for (const { tag } of tags) {
    if (tag.startsWith('es')) return 'es'
    if (tag.startsWith('en')) return 'en'
  }
  return 'en'
}

/** Locale tag for Intl date formatting. */
export const intlLocale = (lang: Lang): string => (lang === 'es' ? 'es-US' : 'en-US')

// ── Money formatting ────────────────────────────────────────────────────────
//
// Lives HERE, not in deposit-links.ts, because the payment page is a client
// component and deposit-links imports node:crypto for token generation — which
// webpack cannot bundle for a browser. Splitting the formatter out is what keeps
// the client bundle free of a Node built-in.
//
// Deliberately NOT localised. US Spanish writes $49.00 exactly as English does;
// switching to es-US grouping would render "$1.495,00" and change what a
// customer believes they are paying.

/** Integer cents -> "$1,234.56". THE money formatter for this feature. */
export function formatCents(cents: number): string {
  const neg = cents < 0
  const abs = Math.abs(Math.round(cents))
  const s = (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (neg ? '-' : '') + '$' + s
}
