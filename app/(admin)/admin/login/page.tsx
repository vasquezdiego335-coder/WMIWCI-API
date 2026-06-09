'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function AdminLogin() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Login failed')
        return
      }

      router.replace('/admin')
    } catch {
      setError('Network error — please try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={page}>
      <div style={card}>
        <div style={{ marginBottom: '32px', textAlign: 'center' }}>
          <p style={{ color: '#FF5A1F', fontWeight: '700', fontSize: '15px', margin: '0 0 2px', letterSpacing: '0.04em' }}>WE MOVE IT. WE CLEAR IT.</p>
          <p style={{ color: '#6B7280', fontSize: '13px', margin: '0' }}>Admin Portal</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={field}>
            <label style={label} htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              style={input}
              placeholder="you@moveitclearit.com"
            />
          </div>

          <div style={field}>
            <label style={label} htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              style={input}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p style={{ color: '#EF4444', fontSize: '13px', margin: '0 0 16px', padding: '10px 14px', backgroundColor: '#FEF2F2', borderRadius: '6px', border: '1px solid #FECACA' }}>
              {error}
            </p>
          )}

          <button type="submit" disabled={loading} style={{ ...btn, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

const page: React.CSSProperties = {
  minHeight: '100vh',
  backgroundColor: '#F5F1EA',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'Inter, -apple-system, sans-serif',
  padding: '16px',
}

const card: React.CSSProperties = {
  backgroundColor: '#FFFFFF',
  borderRadius: '16px',
  padding: '40px',
  width: '100%',
  maxWidth: '400px',
  boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
}

const field: React.CSSProperties = { marginBottom: '20px' }

const label: React.CSSProperties = {
  display: 'block',
  fontSize: '13px',
  fontWeight: '600',
  color: '#374151',
  marginBottom: '6px',
}

const input: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid #D1D5DB',
  borderRadius: '8px',
  fontSize: '14px',
  color: '#0A1628',
  outline: 'none',
  boxSizing: 'border-box',
}

const btn: React.CSSProperties = {
  width: '100%',
  padding: '12px',
  backgroundColor: '#FF5A1F',
  color: '#FFFFFF',
  border: 'none',
  borderRadius: '8px',
  fontSize: '14px',
  fontWeight: '600',
  cursor: 'pointer',
}
