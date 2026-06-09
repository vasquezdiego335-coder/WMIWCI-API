export default function NotFound() {
  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#F5F1EA', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter, -apple-system, sans-serif', padding: '24px' }}>
      <div style={{ textAlign: 'center', maxWidth: '400px' }}>
        <p style={{ fontSize: '48px', margin: '0 0 16px' }}>🔗</p>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#0A1628', margin: '0 0 12px' }}>
          Link expired or not found
        </h1>
        <p style={{ fontSize: '14px', color: '#6B7280', margin: '0 0 24px', lineHeight: '1.6' }}>
          This booking link has either expired or doesn't exist.
          Booking links are valid for 30 days after your scheduled date.
        </p>
        <p style={{ fontSize: '14px', color: '#6B7280', margin: '0' }}>
          Need help?{' '}
          <a href="mailto:hello@moveitclearit.com" style={{ color: '#FF5A1F', fontWeight: '600' }}>
            hello@moveitclearit.com
          </a>
        </p>
      </div>
    </div>
  )
}
