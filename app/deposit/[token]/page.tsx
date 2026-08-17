// ════════════════════════════════════════════════════════════════════════════
//  /deposit/[publicToken] — the customer's deposit payment page.
//  ------------------------------------------------------------------------
//  SERVER-RENDERED, deliberately. Messenger, Discord, WhatsApp and iMessage
//  preview crawlers do not run JavaScript, so the Open Graph tags have to be in
//  the FIRST HTML response or the link unfurls as a bare grey box.
//
//  WHAT THE CUSTOMER MAY SEE: first name, move date, a short service line, the
//  quote total, the deposit due now, and what is left afterwards.
//  WHAT THEY MAY NOT, and cannot, because the view model does not carry them:
//  pickup or delivery address, phone number, email address, booking number,
//  any Stripe identifier, any internal id.
//
//  THE AMOUNT IS NOT ON THIS PAGE'S CRITICAL PATH. It is displayed here, but
//  the charge is created server-side from the DepositRequest row. Editing the
//  DOM, replaying the POST or forging a body changes nothing about what Stripe
//  is told to charge.
// ════════════════════════════════════════════════════════════════════════════
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import {
  isValidPublicToken,
  publicDepositView,
  formatCents,
  formatMoveDate,
  depositUrl,
  depositOgImageUrl,
  type PublicDepositView,
} from '@/lib/deposit-links'
import PayPanel from './PayPanel'

// Auth-free but DB-backed and money-bearing: never statically prerendered and
// never cached, so a paid link cannot serve a stale "pay now" page.
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const NAVY = '#0A1628'
const DEEP_NAVY = '#0D1F3C'
const ORANGE = '#FF5A1F'
const ORANGE_CTA = '#D2450F'
const BONE = '#F5F1EA'
const GOLD = '#C9A961'

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
    description: 'Review and securely pay your Move It Clear It deposit.',
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
      description: 'Review and securely pay your Move It Clear It deposit.',
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
      description: 'Review and securely pay your Move It Clear It deposit.',
      images: [image],
    },
    themeColor: ORANGE,
    other: { 'theme-color': ORANGE },
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
  const view = loaded.kind === 'ok' ? loaded.view : null

  // `?return=1` is set on the Stripe success URL. It means "the customer came
  // back from Stripe" and NOTHING more — it is never treated as proof of
  // payment. When the webhook has not landed yet the panel polls; it can only
  // ever show success once the SERVER says paid.
  const returning = searchParams.return === '1'
  const canceled = searchParams.canceled === '1'

  return (
    <main style={page}>
      <div style={card}>
        <div style={goldLine} aria-hidden />

        <header style={header}>
          <span style={logoChip}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" width={34} height={34} style={{ display: 'block' }} />
          </span>
          <span style={wordmark}>MOVE IT CLEAR IT</span>
        </header>

        <div style={body}>
          {view == null ? (
            <UnavailableView />
          ) : view.status === 'PAID' ? (
            <PaidView view={view} />
          ) : view.status === 'ACTIVE' ? (
            <PayView view={view} returning={returning} canceled={canceled} />
          ) : (
            <ClosedView status={view.status} />
          )}
        </div>

        <footer style={footer}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, color: NAVY }}>Cancellation &amp; rescheduling</p>
          {/*
            The APPROVED policy, quoted from the Terms of Service, and nothing
            more. The Terms' "non-refundable" sentence is about the CAPTURED $49
            booking fee and is deliberately not repeated here: this deposit is a
            different instrument, and inventing a refund policy for it — in
            either direction — would be a term the customer never agreed to.
          */}
          <p style={{ margin: 0 }}>
            Rescheduling requests must be submitted at least 72 hours before the scheduled service time. Same-day
            cancellations may result in a cancellation fee equal to 2 hours of labor.
          </p>
          <p style={{ margin: '10px 0 0' }}>
            Full terms:{' '}
            <a href="/terms" style={{ color: ORANGE_CTA, fontWeight: 600 }}>
              Terms of Service
            </a>
          </p>
        </footer>
      </div>
    </main>
  )
}

// ── States ──────────────────────────────────────────────────────────────────

function PayView({ view, returning, canceled }: { view: PublicDepositView; returning: boolean; canceled: boolean }) {
  const moveDate = formatMoveDate(view.moveDate)
  return (
    <>
      <h1 style={h1}>Secure Your Move</h1>
      {view.firstName && <p style={greeting}>Hi {view.firstName} — here are your details.</p>}

      {canceled && (
        <p style={notice}>Payment was not completed. Nothing was charged — you can try again below.</p>
      )}

      <dl style={detailList}>
        {moveDate && <Detail label="Move date" value={moveDate} />}
        {view.serviceSummary && <Detail label="Service" value={view.serviceSummary} />}
      </dl>

      <div style={moneyBox}>
        {/* Quote total and remaining balance are HIDDEN, not zeroed, when the
            total is unknown — a "$0.00 remaining" a customer relies on is worse
            than saying nothing. */}
        {view.quoteTotalCents != null && <MoneyRow label="Quote total" value={formatCents(view.quoteTotalCents)} />}
        <MoneyRow label="Deposit due now" value={formatCents(view.depositCents)} strong />
        {view.remainingCents != null && (
          <MoneyRow label="Remaining balance after payment" value={formatCents(view.remainingCents)} />
        )}
      </div>

      <p style={appliesNote}>This deposit is applied toward your moving balance.</p>

      <PayPanel token={view.token} amountLabel={formatCents(view.depositCents)} returning={returning} />

      <p style={stripeNote}>Payment processed securely by Stripe</p>
    </>
  )
}

function PaidView({ view }: { view: PublicDepositView }) {
  const paid = view.amountPaidCents ?? view.depositCents
  return (
    <>
      <div style={paidBadge}>Deposit received</div>
      <h1 style={{ ...h1, fontSize: '30px' }}>Thank you{view.firstName ? `, ${view.firstName}` : ''}</h1>

      <div style={moneyBox}>
        <MoneyRow label="Amount paid" value={formatCents(paid)} strong />
        {view.paidAt && <MoneyRow label="Payment date" value={formatMoveDate(view.paidAt) ?? ''} />}
        {view.remainingCents != null && (
          <MoneyRow label="Remaining balance" value={formatCents(view.remainingCents)} />
        )}
      </div>

      <p style={appliesNote}>This deposit has been applied toward your moving balance.</p>
      <p style={stripeNote}>Payment processed securely by Stripe</p>
    </>
  )
}

/** The database could not be reached. Says exactly that — it does not guess at
 *  a status, and above all it does not tell a real customer their link is bad. */
function UnavailableView() {
  return (
    <>
      <h1 style={{ ...h1, fontSize: '27px' }}>We can&apos;t load this right now</h1>
      <p style={{ ...greeting, marginBottom: '20px' }}>
        Your link is fine — we just could not reach our system for a moment. Nothing has been charged. Please refresh in
        a minute, or text us and we will take the payment another way.
      </p>
      <a href="tel:+18626400625" style={{ ...payButton, textDecoration: 'none', display: 'block', textAlign: 'center' }}>
        Call (862) 640-0625
      </a>
    </>
  )
}

function ClosedView({ status }: { status: 'EXPIRED' | 'CANCELED' | 'ACTIVE' | 'PAID' }) {
  return (
    <>
      <h1 style={{ ...h1, fontSize: '28px' }}>
        {status === 'EXPIRED' ? 'This payment link has expired' : 'This payment link is no longer active'}
      </h1>
      <p style={{ ...greeting, marginBottom: '20px' }}>
        Nothing was charged. Text or call us and we will send you a new link.
      </p>
      <a href="tel:+18626400625" style={{ ...payButton, textDecoration: 'none', display: 'block', textAlign: 'center' }}>
        Call (862) 640-0625
      </a>
    </>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', padding: '9px 0', borderBottom: '1px solid #EFEAE1' }}>
      <dt style={{ fontSize: '14px', color: '#6B7280' }}>{label}</dt>
      <dd style={{ fontSize: '14px', color: NAVY, fontWeight: 600, margin: 0, textAlign: 'right' }}>{value}</dd>
    </div>
  )
}

function MoneyRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '14px', padding: '7px 0' }}>
      <span style={{ fontSize: strong ? '15px' : '14px', color: strong ? NAVY : '#6B7280', fontWeight: strong ? 700 : 500 }}>
        {label}
      </span>
      <span
        style={{
          fontSize: strong ? '26px' : '15px',
          color: strong ? ORANGE_CTA : NAVY,
          fontWeight: strong ? 800 : 600,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </div>
  )
}

// ── Styles (mobile-first; the card is a single column at every width) ───────
const page: React.CSSProperties = {
  minHeight: '100vh',
  background: `linear-gradient(180deg, ${NAVY} 0%, ${DEEP_NAVY} 100%)`,
  padding: '20px 14px 40px',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
}
const card: React.CSSProperties = {
  width: '100%',
  maxWidth: '460px',
  background: '#FFFFFF',
  borderRadius: '18px',
  overflow: 'hidden',
  boxShadow: '0 18px 50px rgba(0,0,0,0.35)',
}
const goldLine: React.CSSProperties = { height: '4px', background: `linear-gradient(90deg, ${GOLD} 0%, ${GOLD} 46%, rgba(201,169,97,0) 100%)` }
const header: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '11px', padding: '18px 22px', background: NAVY }
const logoChip: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '42px', height: '42px', background: BONE, borderRadius: '10px', padding: '4px', flexShrink: 0,
}
const wordmark: React.CSSProperties = { color: BONE, fontWeight: 700, fontSize: '13px', letterSpacing: '0.16em' }
const body: React.CSSProperties = { padding: '24px 22px 26px' }
const h1: React.CSSProperties = { fontSize: '32px', lineHeight: 1.1, fontWeight: 800, color: NAVY, margin: '0 0 6px', letterSpacing: '-0.02em' }
const greeting: React.CSSProperties = { fontSize: '15px', color: '#4B5563', margin: '0 0 18px' }
const notice: React.CSSProperties = {
  fontSize: '14px', color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A',
  borderRadius: '10px', padding: '10px 12px', margin: '0 0 16px',
}
const detailList: React.CSSProperties = { margin: '0 0 18px' }
const moneyBox: React.CSSProperties = { background: BONE, borderRadius: '14px', padding: '14px 16px', margin: '0 0 14px' }
const appliesNote: React.CSSProperties = { fontSize: '13px', color: '#4B5563', margin: '0 0 20px', lineHeight: 1.5 }
const stripeNote: React.CSSProperties = { fontSize: '12px', color: '#6B7280', textAlign: 'center', margin: '14px 0 0' }
const paidBadge: React.CSSProperties = {
  display: 'inline-block', background: '#ECFDF5', color: '#047857', border: '1px solid #A7F3D0',
  borderRadius: '999px', padding: '6px 14px', fontSize: '13px', fontWeight: 700, marginBottom: '12px',
}
const payButton: React.CSSProperties = {
  width: '100%', border: 'none', borderRadius: '12px', background: ORANGE_CTA, color: '#FFFFFF',
  fontSize: '18px', fontWeight: 700, padding: '17px 20px', cursor: 'pointer',
}
const footer: React.CSSProperties = {
  borderTop: '1px solid #EFEAE1', padding: '18px 22px 22px', background: '#FCFBF9',
  fontSize: '12px', color: '#6B7280', lineHeight: 1.55,
}
