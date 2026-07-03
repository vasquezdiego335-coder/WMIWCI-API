'use client'

import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'

// ════════════════════════════════════════════════════════════════════════
//  /my-booking (no token) — Booking lookup page
//
//  Customers reach this page two ways:
//    1. Typing /my-booking directly (no token in URL)
//    2. app/page.tsx redirects here
//
//  This is NOT a booking form — bookings are created on the marketing
//  site (booking-form.html) which posts to /api/bookings. This page lets
//  existing customers look up their booking by email.
// ════════════════════════════════════════════════════════════════════════

export default function MyBookingLookup() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLookup(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch(`/api/customer/booking/lookup?email=${encodeURIComponent(email.trim())}`)
      const data = await res.json()

      if (res.ok && data.token) {
        router.push(`/my-booking/${data.token}`)
      } else {
        setError(data.error ?? 'No booking found for that email. Please check and try again.')
      }
    } catch {
      setError('Something went wrong. Please try again or call us at (862) 640-0625.')
    } finally {
      setLoading(false)
    }
  }

  const marketingSiteUrl = process.env.NEXT_PUBLIC_MARKETING_SITE_URL ?? 'https://www.wemoveitweclearit.com'

  return (
    <div style={page}>
      <header style={header}>
        <div style={headerInner}>
          <p style={brand}>WE MOVE IT. WE CLEAR IT.</p>
          <a href="tel:+18626400625" style={phone}>862-640-0625</a>
        </div>
      </header>

      <main style={main}>
        <div style={card}>
          <h1 style={title}>Check Your Booking</h1>
          <p style={subtitle}>
            Enter the email you used when booking to view your move status, schedule, and payment details.
          </p>

          <form onSubmit={handleLookup} style={form}>
            <div>
              <label htmlFor="email" style={label}>Email address</label>
              <input
                id="email"
                type="email"
                placeholder="you@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                style={input}
              />
            </div>

            {error && <p style={errorStyle}>{error}</p>}

            <button type="submit" disabled={loading} style={button}>
              {loading ? 'Looking up...' : 'Find My Booking'}
            </button>
          </form>

          <div style={divider} />

          <div style={helpSection}>
            <p style={helpTitle}>Need to book a move?</p>
            <a
              href={`${marketingSiteUrl}/booking-form.html`}
              style={bookLink}
            >
              Book your move here &rarr;
            </a>
          </div>

          <div style={helpSection}>
            <p style={helpTitle}>Questions?</p>
            <p style={helpText}>
              Call or text <a href="tel:+18626400625" style={orangeLink}>(862) 640-0625</a>
              {' '}or email <a href="mailto:hello@moveitclearit.com" style={orangeLink}>hello@moveitclearit.com</a>
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────
const page: React.CSSProperties = { minHeight: '100vh', backgroundColor: '#F5F1EA', fontFamily: 'Inter, -apple-system, sans-serif' }
const header: React.CSSProperties = { backgroundColor: '#0A1628', padding: 0 }
const headerInner: React.CSSProperties = { maxWidth: 600, margin: '0 auto', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }
const brand: React.CSSProperties = { color: '#FF5A1F', fontWeight: 700, fontSize: 13, margin: 0, letterSpacing: '0.06em' }
const phone: React.CSSProperties = { fontSize: 13, color: '#CBD5E1', textDecoration: 'none' }
const main: React.CSSProperties = { maxWidth: 600, margin: '0 auto', padding: '40px 24px' }
const card: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: 12, padding: '32px 28px', boxShadow: '0 1px 6px rgba(0,0,0,0.08)' }
const title: React.CSSProperties = { fontSize: 24, fontWeight: 800, color: '#0A1628', margin: '0 0 8px' }
const subtitle: React.CSSProperties = { fontSize: 14, color: '#6B7280', margin: '0 0 24px', lineHeight: 1.5 }
const form: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16 }
const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }
const input: React.CSSProperties = { width: '100%', padding: '10px 14px', border: '1.5px solid #D1D5DB', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }
const button: React.CSSProperties = { padding: 14, backgroundColor: '#FF5A1F', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer' }
const errorStyle: React.CSSProperties = { fontSize: 13, color: '#EF4444', margin: 0 }
const divider: React.CSSProperties = { height: 1, backgroundColor: '#E5E7EB', margin: '24px 0' }
const helpSection: React.CSSProperties = { marginBottom: 16 }
const helpTitle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: '#0A1628', margin: '0 0 4px' }
const helpText: React.CSSProperties = { fontSize: 13, color: '#6B7280', margin: 0 }
const bookLink: React.CSSProperties = { fontSize: 14, color: '#FF5A1F', fontWeight: 600, textDecoration: 'none' }
const orangeLink: React.CSSProperties = { color: '#FF5A1F', textDecoration: 'none' }
