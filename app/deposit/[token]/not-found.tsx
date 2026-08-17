// A bad or retired token gets the SAME neutral page whether the link never
// existed or was deleted. Distinguishing them would turn this route into an
// oracle for guessing tokens.
export default function DepositNotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #0A1628 0%, #0D1F3C 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div style={{ background: '#FFFFFF', borderRadius: '18px', padding: '32px 26px', maxWidth: '420px', width: '100%', textAlign: 'center' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 800, color: '#0A1628', margin: '0 0 10px' }}>Payment link not found</h1>
        <p style={{ fontSize: '15px', color: '#4B5563', margin: '0 0 22px', lineHeight: 1.5 }}>
          This link is not valid. Nothing was charged. Text or call us and we will send you a new one.
        </p>
        <a
          href="tel:+18626400625"
          style={{
            display: 'block', background: '#D2450F', color: '#FFFFFF', borderRadius: '12px',
            padding: '15px 20px', fontWeight: 700, fontSize: '17px', textDecoration: 'none',
          }}
        >
          Call (862) 640-0625
        </a>
      </div>
    </main>
  )
}
