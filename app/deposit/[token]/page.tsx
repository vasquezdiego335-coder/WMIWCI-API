// ════════════════════════════════════════════════════════════════════════════
//  /deposit/[publicToken] — the customer's deposit payment page.
//  ------------------------------------------------------------------------
//  SERVER-RENDERED, deliberately. Messenger, Discord, WhatsApp and iMessage
//  preview crawlers do not run JavaScript, so the Open Graph tags have to be in
//  the FIRST HTML response or the link unfurls as a bare grey box.
//
//  WHAT THE CUSTOMER MAY SEE: first name, move date, a short service line, the
//  quote total, the deposit due today, and what is left afterwards.
//  WHAT THEY MAY NOT, and cannot, because the view model does not carry them:
//  pickup or delivery address, phone number, email address, booking number,
//  any Stripe identifier, any internal id.
//
//  THE AMOUNT IS NOT ON THIS PAGE'S CRITICAL PATH. It is displayed here, but
//  the charge is built server-side from the DepositRequest row. Editing the
//  DOM, replaying the POST or forging a body changes nothing about what Stripe
//  is told to charge.
//
//  The visible card is a CLIENT component so the language toggle can swap copy
//  without a reload — which matters because a reload would re-request a page
//  the customer reached from Messenger. It still server-renders on first paint,
//  so there is no blank frame and no SEO/accessibility regression.
// ════════════════════════════════════════════════════════════════════════════
import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { businessPhone } from '@/lib/business-contact'
import { pickLang, type Lang } from '@/lib/deposit-copy'
import {
  isValidPublicToken,
  publicDepositView,
  depositUrl,
  depositOgImageUrl,
  type PublicDepositView,
} from '@/lib/deposit-links'
import DepositView from './DepositView'

// Auth-free but DB-backed and money-bearing: never statically prerendered and
// never cached, so a paid link cannot serve a stale "pay now" page.
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const ORANGE = '#FF5A1F'

// ── Metadata ────────────────────────────────────────────────────────────────
//
// GENERIC ON PURPOSE. Messenger and Discord CACHE an unfurl per URL and serve
// it to anyone the link is forwarded to. A name, an amount or a move date in
// these tags would leak a customer's details into a cached card outside our
// control — so every deposit link unfurls identically.
export async function generateMetadata({ params }: { params: { token: string } }): Promise<Metadata> {
  const url = depositUrl(params.token)
  const image = depositOgImageUrl()
  return {
    title: 'Secure Your Move | Move It Clear It',
    description: 'Review your quote and securely pay your booking deposit.',
    // noindex keeps a customer-specific page out of search results.
    // It does NOT block unfurl crawlers: Discord, Facebook/Messenger and
    // WhatsApp read Open Graph regardless of a robots meta, and robots.txt
    // explicitly allows /deposit for exactly this reason.
    robots: { index: false, follow: false, noarchive: true },
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: 'Move It Clear It',
      title: 'Secure Your Move | Move It Clear It',
      description: 'Review your quote and securely pay your booking deposit.',
      url,
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          type: 'image/jpeg',
          alt: 'Move It Clear It — secure online deposit payment',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'Secure Your Move | Move It Clear It',
      description: 'Review your quote and securely pay your booking deposit.',
      images: [image],
    },
  }
}

// Next 14 moved themeColor OUT of the metadata export. Left in `metadata` it is
// silently ignored and logs an 'Unsupported metadata themeColor' warning on
// EVERY request.
export function generateViewport(): Viewport {
  return {
    themeColor: ORANGE,
    // Explicit: the page must not zoom-lock, older customers pinch to read.
    width: 'device-width',
    initialScale: 1,
  }
}

// ── Data ────────────────────────────────────────────────────────────────────
//
// THREE outcomes, not two. "We could not reach the database" is not the same
// fact as "this link does not exist", and a customer who was texted a real link
// must not be told it is invalid because of an outage. Separating them also
// keeps the page RENDERABLE when the DB is down, which is what keeps the Open
// Graph tags in the response — a link that unfurls as a grey box during a blip
// looks like a scam, and stays cached that way.
type LoadResult =
  | { kind: 'ok'; view: PublicDepositView }
  | { kind: 'missing' }
  | { kind: 'unavailable' }

async function loadView(token: string): Promise<LoadResult> {
  if (!isValidPublicToken(token)) return { kind: 'missing' }
  let row
  try {
    row = await fetchRow(token)
  } catch (err) {
    // Deliberately not notFound(): see above.
    console.error('[deposit] lookup failed', err instanceof Error ? err.message : String(err))
    return { kind: 'unavailable' }
  }
  if (!row) return { kind: 'missing' }
  return { kind: 'ok', view: publicDepositView(row) }
}

function fetchRow(token: string) {
  return prisma.depositRequest.findUnique({
    where: { publicToken: token },
    // Explicit select — the projection can never widen by accident when a
    // column is added to the model later.
    select: {
      publicToken: true,
      customerName: true,
      quoteTotalCents: true,
      balanceBeforeCents: true,
      amountCents: true,
      amountPaidCents: true,
      serviceSummary: true,
      moveDate: true,
      status: true,
      expiresAt: true,
      paidAt: true,
    },
  })
}

export default async function DepositPage({
  params,
  searchParams,
}: {
  params: { token: string }
  searchParams: { [k: string]: string | string[] | undefined }
}) {
  const loaded = await loadView(params.token)
  if (loaded.kind === 'missing') notFound()

  // First paint in the customer's own language. `?lang=` wins so a link can be
  // shared in a chosen language; otherwise the browser decides.
  const requested = typeof searchParams.lang === 'string' ? searchParams.lang.toLowerCase() : null
  const initialLang: Lang =
    requested === 'es' || requested === 'en' ? requested : pickLang(headers().get('accept-language'))

  // `?return=1` is set on the Stripe success URL. It means "the customer came
  // back from Stripe" and NOTHING more — it is never treated as proof of
  // payment. When the webhook has not landed yet the panel polls; it can only
  // ever show success once the SERVER says paid.
  const returning = searchParams.return === '1'
  const canceled = searchParams.canceled === '1'

  const phone = businessPhone()

  return (
    <DepositView
      view={loaded.kind === 'ok' ? loaded.view : null}
      token={params.token}
      initialLang={initialLang}
      returning={returning}
      canceled={canceled}
      phone={{ display: phone.display, tel: phone.tel, sms: phone.sms }}
    />
  )
}
