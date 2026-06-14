import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Button, Hr, Img } from '@react-email/components'

interface Props {
  customerName: string
  bookingId: string
  checkoutUrl: string
  requestedDate: string
  originAddress: string
  destAddress: string
}

export default function BookingConfirmationEmail({
  customerName = 'Friend',
  bookingId = 'BOOKING-ID',
  checkoutUrl = 'https://wmiwci-backend.vercel.app',
  requestedDate = new Date().toISOString(),
  originAddress = 'Origin',
  destAddress = 'Destination',
}: Props) {
  const dateStr = new Date(requestedDate).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York',
  })

  return (
    <Html lang="en">
      <Head />
      <Body style={body}>
        <Container style={container}>
          <Section style={header}>
            <Text style={brandName}>We Move It. We Clear It.</Text>
            <Text style={tagline}>West Orange, NJ · Essex County</Text>
          </Section>

          <Section style={content}>
            <Heading style={h1}>Your booking request is in! 🎉</Heading>
            <Text style={p}>Hi {customerName},</Text>
            <Text style={p}>
              Thanks for choosing us! We've received your booking request. To lock in your date,
              complete your <strong>$49 deposit</strong> below. This fee holds your spot and counts
              toward your balance.
            </Text>

            <Section style={detailBox}>
              <Text style={detailLabel}>Booking ID</Text>
              <Text style={detailValue}>{bookingId}</Text>
              <Text style={detailLabel}>Requested Date</Text>
              <Text style={detailValue}>{dateStr}</Text>
              <Text style={detailLabel}>From</Text>
              <Text style={detailValue}>{originAddress}</Text>
              <Text style={detailLabel}>To</Text>
              <Text style={detailValue}>{destAddress}</Text>
            </Section>

            <Button style={btn} href={checkoutUrl}>
              Complete $49 Deposit →
            </Button>

            <Text style={note}>
              ⚠️ This link expires in 30 minutes. If it expires, reply to this email and we'll send a new one.
            </Text>

            <Hr style={hr} />
            <Text style={footer}>
              We Move It. We Clear It. | 862-640-0625 | hello@moveitclearit.com
              <br />
              Labor-only moving service. Customer provides or arranges the truck.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const body: React.CSSProperties = { backgroundColor: '#F5F1EA', fontFamily: 'Inter, -apple-system, sans-serif' }
const container: React.CSSProperties = { maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }
const header: React.CSSProperties = { backgroundColor: '#0A1628', padding: '24px', borderRadius: '12px 12px 0 0', textAlign: 'center' }
const brandName: React.CSSProperties = { color: '#FF5A1F', fontSize: '18px', fontWeight: '700', margin: '0', letterSpacing: '0.02em' }
const tagline: React.CSSProperties = { color: '#8B9BC1', fontSize: '12px', margin: '4px 0 0' }
const content: React.CSSProperties = { backgroundColor: '#FFFFFF', padding: '32px 28px', borderRadius: '0 0 12px 12px' }
const h1: React.CSSProperties = { fontSize: '22px', fontWeight: '700', color: '#0A1628', margin: '0 0 16px' }
const p: React.CSSProperties = { fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }
const detailBox: React.CSSProperties = { backgroundColor: '#F5F1EA', padding: '16px', borderRadius: '8px', margin: '20px 0' }
const detailLabel: React.CSSProperties = { fontSize: '11px', color: '#6B7280', fontWeight: '600', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '8px 0 2px' }
const detailValue: React.CSSProperties = { fontSize: '14px', color: '#0A1628', fontWeight: '500', margin: '0 0 8px' }
const btn: React.CSSProperties = { backgroundColor: '#FF5A1F', color: '#FFFFFF', padding: '14px 28px', borderRadius: '8px', fontWeight: '700', fontSize: '15px', display: 'block', textAlign: 'center', textDecoration: 'none', margin: '24px 0' }
const note: React.CSSProperties = { fontSize: '13px', color: '#6B7280', margin: '12px 0', fontStyle: 'italic' }
const hr: React.CSSProperties = { borderColor: '#E5E7EB', margin: '24px 0' }
const footer: React.CSSProperties = { fontSize: '12px', color: '#9CA3AF', textAlign: 'center', lineHeight: '1.6' }
