import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'MoveItClearIt Terms of Service',
}

export default function TermsPage() {
  return (
    <div style={page}>
      <header style={hdr}>
        <div style={hdrInner}>
          <Link href="https://moveitclearit.com" style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#FF5A1F', fontWeight: '700', fontSize: '14px', letterSpacing: '0.04em', textDecoration: 'none' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', background: '#F5F1EA', borderRadius: '8px', padding: '4px', flexShrink: 0, boxShadow: '0 2px 6px rgba(0,0,0,0.18)' }}>
              <img src="/icon.svg" alt="" width={28} height={28} style={{ display: 'block' }} />
            </span>
            WE MOVE IT. WE CLEAR IT.
          </Link>
        </div>
      </header>

      <main style={main}>
        <h1 style={h1}>MoveItClearIt Terms of Service</h1>
        <p style={updated}>Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>

        <Section title="1. Service Description">
          <p>We Move It. We Clear It. provides <strong>labor-only moving services</strong>. We supply trained labor to assist with loading, unloading, and moving items. <strong>We do not provide transportation.</strong> The customer is responsible for providing or arranging their own moving truck or vehicle.</p>
          <p>We do not provide junk removal, disposal, or hauling services. We do not hold any transportation carrier license (DOT). We are not a licensed moving carrier.</p>
        </Section>

        <Section title="2. Booking and Payment">
          <p>A $49 booking fee is authorized (a hold, not a charge) to request your reservation. We capture the $49 only when we approve your booking; if we deny it, the hold is released and you are not charged. Once captured, it is applied toward your final bill, with the balance due at time of service.</p>
          <p>Pricing is based on hourly labor rates. Additional charges may apply for extra crew members, long carries, stair fees, or other factors agreed upon at time of booking.</p>
        </Section>

        <Section title="3. Cancellations and Rescheduling">
          <p>Once captured (after approval), the $49 booking fee is non-refundable. Rescheduling requests must be submitted at least 72 hours before the scheduled service time. Same-day cancellations may result in a cancellation fee equal to 2 hours of labor.</p>
        </Section>

        <Section title="4. Arrival Windows, Late Arrival &amp; Waiting Time">
          <p>Because we provide labor-only service, our crew reserves an <strong>exclusive arrival window</strong> for your move. Keeping every job on schedule protects your appointment and the appointments of the customers scheduled after you.</p>
          <p>We understand unexpected delays happen, so every booking includes a <strong>complimentary 30-minute grace period</strong> measured from the crew&apos;s arrival. If the crew arrives and cannot begin — for example, items are not packed, access is not available, or no one is present — waiting time begins once the grace period ends.</p>
          <p>Waiting time after the grace period is billed as follows:</p>
          <ul>
            <li><strong>First 30 minutes: complimentary (no charge)</strong></li>
            <li><strong>Each additional 30 minutes, or any portion thereof: $50</strong></li>
          </ul>
          <p>Any waiting fee is calculated from the crew&apos;s logged arrival and ready times, appears as a separate line item on your receipt, and is collected on move day — it is never added to the $49 booking deposit.</p>
          <p>If a delay exceeds <strong>90 minutes</strong> without prior arrangement with Move It Clear It, and depending on crew availability, we reserve the right to reschedule your move to the next available opening, move you to a later slot, or cancel the reservation. We will make good-faith efforts to reach you and discuss options before doing so.</p>
        </Section>

        <Section title="5. Customer Responsibilities">
          <p>The customer is responsible for:</p>
          <ul>
            <li>Providing or arranging a suitable moving truck or vehicle</li>
            <li>Ensuring items to be moved are properly packed and prepared</li>
            <li>Disclosing any fragile, high-value, or hazardous items prior to service</li>
            <li>Ensuring safe and legal access to all locations</li>
            <li>Being present or having a designated representative present during service</li>
          </ul>
        </Section>

        <Section title="6. Liability Limitations">
          <p>We take reasonable care with all items. However, our liability for damage to items is limited to the lesser of the item's depreciated value or $100 per item. We are not responsible for damage to items that were improperly packed by the customer, pre-existing damage, or damage to furniture that cannot be safely navigated through doorways or stairs.</p>
          <p>We are not liable for: acts of God, delays caused by traffic or weather, or any indirect or consequential damages.</p>
        </Section>

        <Section title="7. Prohibited Items">
          <p>We will not move hazardous materials, explosives, firearms, illegal substances, or any item prohibited by law. We reserve the right to refuse any item at our discretion.</p>
        </Section>

        <Section title="8. Door Hanger Promotions">
          <p>Door hanger promotional discounts (10% off labor) are subject to verification and require approval. Presenting a fraudulent door hanger voids the discount and may result in cancellation of service.</p>
        </Section>

        <Section title="9. Dispute Resolution">
          <p>Any dispute arising from services provided must be reported within 24 hours of service completion. We will make good-faith efforts to resolve disputes. Disputes unresolved through direct communication may be submitted to binding arbitration.</p>
        </Section>

        <Section title="10. Changes to Terms">
          <p>We reserve the right to modify these terms at any time. Updated terms will be posted at this URL. Continued use of our services constitutes acceptance of the current terms.</p>
        </Section>

        <Section title="11. Contact">
          <p>For questions about these terms, contact us at <a href="mailto:hello@moveitclearit.com" style={{ color: '#FF5A1F' }}>hello@moveitclearit.com</a>.</p>
        </Section>

        <div style={{ marginTop: '40px', paddingTop: '24px', borderTop: '1px solid #E5E7EB' }}>
          <Link href="/privacy" style={{ color: '#FF5A1F', fontSize: '14px' }}>Privacy Policy →</Link>
        </div>
      </main>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '32px' }}>
      <h2 style={{ fontSize: '16px', fontWeight: '700', color: '#0A1628', margin: '0 0 12px' }}>{title}</h2>
      <div style={{ fontSize: '14px', color: '#374151', lineHeight: '1.7' }}>{children}</div>
    </div>
  )
}

const page: React.CSSProperties = { minHeight: '100vh', backgroundColor: '#F5F1EA', fontFamily: 'Inter, -apple-system, sans-serif' }
const hdr: React.CSSProperties = { backgroundColor: '#0A1628', padding: '0' }
const hdrInner: React.CSSProperties = { maxWidth: '720px', margin: '0 auto', padding: '16px 24px' }
const main: React.CSSProperties = { maxWidth: '720px', margin: '0 auto', padding: '40px 24px' }
const h1: React.CSSProperties = { fontSize: '28px', fontWeight: '800', color: '#0A1628', margin: '0 0 8px' }
const updated: React.CSSProperties = { fontSize: '13px', color: '#9CA3AF', margin: '0 0 40px' }
