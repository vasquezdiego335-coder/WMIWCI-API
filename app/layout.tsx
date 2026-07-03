import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'MoveItClearIt — Labor-Only Moving',
  description: 'Professional labor-only moving services. We provide the muscle — you handle the truck.',
  metadataBase: new URL(process.env.APP_URL ?? 'https://wmiwci-backend.vercel.app'),
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
    ],
    apple: [
      { url: '/favicon-512.png', sizes: '512x512' },
    ],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body style={{ margin: 0, padding: 0, fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif' }}>
        {children}
        <footer style={{ backgroundColor: '#0A1628', padding: '32px 24px', marginTop: '40px' }}>
          <div style={{ maxWidth: '720px', margin: '0 auto', textAlign: 'center' }}>
            <nav aria-label="Legal" style={{ display: 'flex', gap: '24px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
              <a href="https://moveitclearit.com/terms" style={{ color: '#FF5A1F', fontSize: '14px', fontWeight: 600, textDecoration: 'none' }}>
                MoveItClearIt Terms of Service
              </a>
              <a href="https://moveitclearit.com/privacy" style={{ color: '#FF5A1F', fontSize: '14px', fontWeight: 600, textDecoration: 'none' }}>
                MoveItClearIt Privacy Policy
              </a>
            </nav>
            <p style={{ color: '#9CA3AF', fontSize: '13px', margin: 0 }}>© 2026 MoveItClearIt</p>
          </div>
        </footer>
      </body>
    </html>
  )
}
