import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Button, Hr } from '@react-email/components'

interface Props { customerName: string; bookingDisplayId: string; amountPaid: string; portalUrl: string }

export default function PaymentReceiptEmail({ customerName = 'Friend', bookingDisplayId = 'ID', amountPaid = '49.00', portalUrl = '#' }: Props) {
  return (
    <Html lang="en"><Head />
      <Body style={body}>
        <Container style={container}>
          <Section style={header}><Text style={brand}>We Move It. We Clear It.</Text></Section>
          <Section style={content}>
            <Heading style={h1}>Payment received 💳</Heading>
            <Text style={p}>Hi {customerName}, your $49 booking deposit has been received.</Text>
            <Section style={receiptBox}>
              <Text style={label}>Booking</Text><Text style={val}>{bookingDisplayId}</Text>
              <Text style={label}>Amount Paid</Text><Text style={val}>${amountPaid}</Text>
              <Text style={label}>Status</Text><Text style={val}>✅ Confirmed</Text>
            </Section>
            <Text style={p}>We're reviewing your booking and will send a confirmation shortly (usually within a few hours).</Text>
            <Button style={btn} href={portalUrl}>Check Booking Status →</Button>
            <Hr style={hr} />
            <Text style={footer}>We Move It. We Clear It. · 862-640-0625 · hello@moveitclearit.com</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const body: React.CSSProperties = { backgroundColor: '#F5F1EA', fontFamily: 'Inter, sans-serif' }
const container: React.CSSProperties = { maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }
const header: React.CSSProperties = { backgroundColor: '#0A1628', padding: '20px', borderRadius: '12px 12px 0 0', textAlign: 'center' }
const brand: React.CSSProperties = { color: '#FF5A1F', fontSize: '16px', fontWeight: '700', margin: '0' }
const content: React.CSSProperties = { backgroundColor: '#FFFFFF', padding: '32px 28px', borderRadius: '0 0 12px 12px' }
const h1: React.CSSProperties = { fontSize: '20px', fontWeight: '700', color: '#0A1628', margin: '0 0 16px' }
const p: React.CSSProperties = { fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }
const receiptBox: React.CSSProperties = { backgroundColor: '#F0FDF4', border: '1px solid #86EFAC', borderRadius: '8px', padding: '16px', margin: '20px 0' }
const label: React.CSSProperties = { fontSize: '11px', color: '#6B7280', fontWeight: '600', textTransform: 'uppercase', margin: '8px 0 2px' }
const val: React.CSSProperties = { fontSize: '14px', color: '#0A1628', fontWeight: '600', margin: '0 0 8px' }
const btn: React.CSSProperties = { backgroundColor: '#FF5A1F', color: '#FFF', padding: '14px 28px', borderRadius: '8px', fontWeight: '700', display: 'block', textAlign: 'center', textDecoration: 'none', margin: '20px 0' }
const hr: React.CSSProperties = { borderColor: '#E5E7EB', margin: '20px 0' }
const footer: React.CSSProperties = { fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }
