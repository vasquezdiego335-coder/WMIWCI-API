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
  // The headline is SPLIT so "Move." can carry the orange, exactly as it does
  // on the social card the customer just tapped. Kept alongside `title`, which
  // is still used for the accessible page heading and the <title> tag.
  titleLead: 'Secure Your',
  titleAccent: 'Move.',
  intro: 'Review your quote and pay the deposit to reserve your move.',
  greeting: 'Hi {name} — here are your move details.',
  /** Same line when we do not know the customer's name. */
  greetingNoName: 'Here are your move details.',

  // ── Details ──
  // `moveDate` and `service` stay as the ACCESSIBLE names of the two lines at
  // the top of the card. Sighted customers read the date and the service
  // directly — a visible "Move date:" label in front of a date is noise — but a
  // screen reader announcing two unlabelled lines is not.
  moveDate: 'Move date',
  service: 'Service',
  moveDetailsTitle: 'Move details',
  /** The customer's own to-do. Kept separate from the details LIST because it
   *  is a thing they must act on, and a bullet in a list of facts gets skimmed. */
  needFromYou: 'What we need from you',

  // ── Money ──
  quoteTotal: 'Quote total',
  /** Money already collected on this job. Shown ONLY when there is some, so the
   *  three figures on the page subtract to each other. */
  alreadyPaid: 'Already paid',
  depositDue: 'Deposit due today',
  remaining: 'Remaining after deposit',
  appliedNote: 'This deposit is applied to the total balance of your move.',

  // ── Action ──
  payButton: 'Pay {amount} Securely',
  paying: 'Opening secure checkout…',
  stripeNote: 'Secure payment processed by Stripe',

  // ── Reassurance ──
  reassureTitle: 'What happens next',
  step1: 'Your deposit is applied to your moving balance — it is not an extra charge.',
  // NO PROMISE THAT THE PRICE CAN NEVER CHANGE. The previous wording said
  // "Your quoted price does not change", which is a guarantee this business
  // cannot keep: a scope change on move day (more stairs, more items, a second
  // stop) is reviewed and re-quoted. Saying otherwise on the page where money
  // changes hands is the kind of promise that turns into a dispute.
  step2: 'We confirm your appointment and send your confirmation details.',
  step3: 'You pay the remaining balance on move day once the work is completed.',
  // BOTH owners. They are the two people a customer actually deals with, and
  // the pair is what makes this read as a family business rather than a brand.
  ownerName: 'Diego & Sebastian',
  ownerRole: 'Owners & Lead Movers · North Jersey',
  // A BADGE, not a sentence on its own row — hence no full stop.
  seHablaEspanol: 'Se habla Español',
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
  // THE LINK EXPIRED, NOT THE MOVE. A customer who reads "expired" on a payment
  // page reasonably fears their appointment is gone. It is not, and the first
  // sentence has to say so before anything else.
  closedBody:
    'Your move is still on our books — only this payment link expired. Nothing was charged. Call or text Move It Clear It and we will send you a new one right away.',

  invalidTitle: 'Payment link not found',
  invalidBody: 'This link is not valid. Nothing was charged. Call or text us and we will send you a new one.',

  unavailableTitle: 'We can’t load this right now',
  unavailableBody:
    'Your link is fine — we just could not reach our system for a moment. Nothing has been charged. Please refresh in a minute, or contact us and we will take the payment another way.',

  canceledNotice: 'Payment was not completed. Nothing was charged — you can try again below.',
  errorGeneric: 'We could not start the payment. Please try again, or contact us and we will help.',
  errorNetwork: 'We could not reach the payment page. Check your connection and try again.',
  // ── Server refusals, localized ──
  // The API answers with a CODE as well as an English sentence; the page shows
  // the customer's own language and keeps the English only as a last resort.
  // A Spanish speaker used to be dropped into English at the exact moment the
  // payment failed — the one moment the page most needs to be understood.
  errorAlreadyPaid: 'This deposit has already been paid. Nothing more is owed today.',
  errorExpired: 'This payment link has expired. Call or text us and we will send you a new one.',
  errorInactive: 'This payment link is no longer active. Call or text us and we will send you a new one.',
  errorNotValid: 'This payment link is not valid. Call or text us and we will send you a new one.',
  errorBusy: 'Please try again in a moment.',
  errorTooMany: 'Too many attempts. Please wait a moment and try again.',
  tryAgain: 'Try again',

  // ── Legal ──
  //
  // SHORT ON PURPOSE, and the link is INSIDE the sentence. The page previously
  // carried the full policy paragraph and then a second "Full terms: Terms of
  // Service" line underneath — two links to the same destination, stacked, on
  // the quietest part of the page. One sentence, one link, and the Terms page
  // carries the legal language.
  //
  // IT INVENTS NOTHING. app/terms/page.tsx §3 reads: "Rescheduling requests
  // must be submitted at least 72 hours before the scheduled service time.
  // Same-day cancellations may result in a cancellation fee equal to 2 hours of
  // labor." The 72 hours is stated here verbatim because it is the number a
  // customer needs to act on; the fee is described but not quantified, and the
  // Terms link is one tap away. Nothing here is a term the Terms do not carry.
  policyTitle: 'Cancellation & rescheduling',
  policyBody:
    'Rescheduling requires at least 72 hours’ notice. Same-day cancellations may be subject to a cancellation fee.',
  policySeePre: 'See our ',
  policySeePost: ' for full details.',
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',

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
  titleLead: 'Asegure su',
  titleAccent: 'mudanza.',
  intro: 'Revise su cotización y pague el depósito para reservar su mudanza.',
  greeting: 'Hola {name} — estos son los detalles de su mudanza.',
  greetingNoName: 'Estos son los detalles de su mudanza.',

  moveDate: 'Fecha de la mudanza',
  service: 'Servicio',
  moveDetailsTitle: 'Detalles de la mudanza',
  needFromYou: 'Lo que necesitamos de usted',

  quoteTotal: 'Total de la cotización',
  alreadyPaid: 'Ya pagado',
  depositDue: 'Depósito a pagar hoy',
  remaining: 'Saldo restante después del depósito',
  appliedNote: 'Este depósito se aplica al saldo total de su mudanza.',

  payButton: 'Pagar {amount} de forma segura',
  paying: 'Abriendo el pago seguro…',
  stripeNote: 'Pago seguro procesado por Stripe',

  reassureTitle: 'Qué sigue',
  step1: 'Su depósito se aplica al saldo de su mudanza — no es un cargo adicional.',
  // Same restraint as the English: no promise that the price can never change.
  step2: 'Confirmamos su cita y le enviamos los detalles de su confirmación.',
  step3: 'Usted paga el saldo restante el día de la mudanza, una vez terminado el trabajo.',
  // Names are never translated; the role is.
  ownerName: 'Diego & Sebastian',
  ownerRole: 'Dueños y jefes de mudanzas · Norte de Nueva Jersey',
  seHablaEspanol: 'Se habla Español',
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
  // El enlace venció, NO la mudanza.
  closedBody:
    'Su mudanza sigue reservada — lo único que venció fue este enlace de pago. No se realizó ningún cobro. Llame o escriba a Move It Clear It y le enviaremos uno nuevo de inmediato.',

  invalidTitle: 'Enlace de pago no encontrado',
  invalidBody:
    'Este enlace no es válido. No se realizó ningún cobro. Llámenos o escríbanos y le enviaremos uno nuevo.',

  unavailableTitle: 'No podemos cargar esto en este momento',
  unavailableBody:
    'Su enlace está bien — solo no pudimos conectarnos con nuestro sistema por un momento. No se ha realizado ningún cobro. Actualice en un minuto, o comuníquese con nosotros y tomaremos el pago de otra manera.',

  canceledNotice: 'El pago no se completó. No se realizó ningún cobro — puede intentarlo de nuevo abajo.',
  errorGeneric: 'No pudimos iniciar el pago. Inténtelo de nuevo, o comuníquese con nosotros y le ayudamos.',
  errorNetwork: 'No pudimos conectar con la página de pago. Revise su conexión e inténtelo de nuevo.',
  errorAlreadyPaid: 'Este depósito ya fue pagado. Hoy no debe nada más.',
  errorExpired: 'Este enlace de pago ha vencido. Llámenos o escríbanos y le enviaremos uno nuevo.',
  errorInactive: 'Este enlace de pago ya no está activo. Llámenos o escríbanos y le enviaremos uno nuevo.',
  errorNotValid: 'Este enlace de pago no es válido. Llámenos o escríbanos y le enviaremos uno nuevo.',
  errorBusy: 'Inténtelo de nuevo en un momento.',
  errorTooMany: 'Demasiados intentos. Espere un momento e inténtelo de nuevo.',
  tryAgain: 'Intentar de nuevo',

  policyTitle: 'Cancelación y reprogramación',
  // The English policy is the approved one; this states the SAME terms, with the
  // same number. It is a translation, never a second policy.
  policyBody:
    'La reprogramación requiere un aviso de al menos 72 horas. Las cancelaciones el mismo día pueden generar un cargo por cancelación.',
  policySeePre: 'Consulte nuestros ',
  policySeePost: ' para conocer todos los detalles.',
  terms: 'Términos del servicio',
  privacy: 'Política de privacidad',

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
