import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy — We Move It. We Clear It.',
}

export default function PrivacyPage() {
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
        <h1 style={h1}>Privacy Policy</h1>
        <p style={updated}>Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>

        <Section title="1. Information We Collect">
          <p>When you book a service with us, we collect:</p>
          <ul>
            <li><strong>Contact information:</strong> name, email address, phone number</li>
            <li><strong>Service information:</strong> pickup and delivery addresses, items to be moved, scheduling preferences</li>
            <li><strong>Payment information:</strong> processed securely via Stripe. We never store full card numbers.</li>
            <li><strong>Technical information:</strong> IP address and browser type (logged for fraud prevention only)</li>
            <li><strong>Communications:</strong> messages you send us via email or our contact form</li>
          </ul>
        </Section>

        <Section title="2. How We Use Your Information">
          <p>We use your information to:</p>
          <ul>
            <li>Process and fulfill your booking</li>
            <li>Send booking confirmations, reminders, and receipts via email</li>
            <li>Coordinate scheduling with our crew</li>
            <li>Prevent fraud and abuse</li>
            <li>Comply with legal obligations</li>
            <li>Improve our services (aggregated, non-identifying data only)</li>
          </ul>
          <p>We do <strong>not</strong> sell your personal information to third parties.</p>
        </Section>

        <Section title="3. Information Sharing">
          <p>We share your information only with:</p>
          <ul>
            <li><strong>Stripe</strong> — payment processing. Subject to <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer" style={{ color: '#FF5A1F' }}>Stripe's privacy policy</a>.</li>
            <li><strong>Resend</strong> — transactional email delivery</li>
            <li><strong>Cloudinary</strong> — file storage for job-related photos and documents</li>
            <li><strong>Our internal team</strong> via Discord — for crew coordination (first name + address only)</li>
          </ul>
          <p>We may disclose information if required by law or to protect our legal rights.</p>
        </Section>

        <Section title="4. Data Retention">
          <p>We retain your booking information for 3 years after service completion for tax and legal compliance purposes. You may request deletion of your personal data at any time, subject to our legal retention obligations.</p>
        </Section>

        <Section title="5. Security">
          <p>We use industry-standard security measures including HTTPS encryption, bcrypt password hashing, HTTP-only cookies, and rate limiting. Payment data is handled entirely by Stripe and is never stored on our servers.</p>
        </Section>

        <Section title="6. Cookies">
          <p>We use a single session cookie for admin authentication. We do not use tracking or advertising cookies. We do not use Google Analytics or similar tracking services on the booking portal.</p>
        </Section>

        <Section title="7. Your Rights">
          <p>You have the right to:</p>
          <ul>
            <li>Access the personal information we hold about you</li>
            <li>Request correction of inaccurate data</li>
            <li>Request deletion of your data (subject to legal retention requirements)</li>
            <li>Opt out of non-transactional communications</li>
          </ul>
          <p>To exercise these rights, email us at <a href="mailto:hello@moveitclearit.com" style={{ color: '#FF5A1F' }}>hello@moveitclearit.com</a>.</p>
        </Section>

        <Section title="8. Children's Privacy">
          <p>Our services are not directed to individuals under 18. We do not knowingly collect personal information from children.</p>
        </Section>

        <Section title="9. Changes to This Policy">
          <p>We may update this policy periodically. Changes will be posted at this URL with an updated date. Continued use of our services constitutes acceptance.</p>
        </Section>

        <Section title="10. Contact">
          <p>Questions about this policy? Contact us at <a href="mailto:hello@moveitclearit.com" style={{ color: '#FF5A1F' }}>hello@moveitclearit.com</a>.</p>
        </Section>

        <div style={{ marginTop: '40px', paddingTop: '24px', borderTop: '1px solid #E5E7EB' }}>
          <Link href="/terms" style={{ color: '#FF5A1F', fontSize: '14px' }}>Terms of Service →</Link>
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
