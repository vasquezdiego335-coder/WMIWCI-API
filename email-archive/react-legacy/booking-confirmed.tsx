import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Button, Hr } from '@react-email/components'

interface Props {
  customerName: string
  confirmedDate: string
  originAddress: string
  destAddress: string
  discountPercent?: number
  discountType?: string
  portalUrl: string
  message?: string
  locale?: string
}

export default function BookingConfirmedEmail({
  customerName = 'Friend',
  confirmedDate = 'TBD',
  originAddress = 'Origin',
  destAddress = 'Destination',
  discountPercent,
  discountType,
  portalUrl = '#',
  message,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const c = es
    ? {
        lang: 'es', h1: '¡Estás confirmado! ✅', hi: `Hola ${customerName},`,
        intro: 'Tu mudanza está oficialmente en el calendario. Estos son los detalles:',
        dt: 'Fecha y Hora', from: 'Desde', to: 'Hasta', disc: 'Descuento Aplicado',
        discVal: (n: number) => `🏷 ${n}% de descuento en tu saldo restante`,
        body2: 'Nuestro equipo llegará a tu dirección de origen. Por favor ten el camión listo en el lugar a la hora programada.',
        cta: 'Ver Mi Reserva →', footer: '¿Preguntas? Llámanos o escríbenos al 862-640-0625',
      }
    : {
        lang: 'en', h1: "You're confirmed! ✅", hi: `Hi ${customerName},`,
        intro: 'Your move is officially on the calendar. Here are the details:',
        dt: 'Date & Time', from: 'From', to: 'To', disc: 'Discount Applied',
        discVal: (n: number) => `🏷 ${n}% off your remaining balance`,
        body2: 'Our crew will arrive at your origin address. Please have the truck ready at the location by the scheduled time.',
        cta: 'View Your Booking →', footer: 'Questions? Call or text us at 862-640-0625',
      }
  return (
    <Html lang={c.lang}>
      <Head />
      <Body style={body}>
        <Container style={container}>
          <Section style={header}>
            <Text style={brandName}>Move It Clear It.</Text>
          </Section>
          <Section style={content}>
            <Heading style={h1}>{c.h1}</Heading>
            {message && <Text style={highlight}>{message}</Text>}
            <Text style={p}>{c.hi}</Text>
            <Text style={p}>{c.intro}</Text>
            <Section style={detailBox}>
              <Text style={detailLabel}>{c.dt}</Text>
              <Text style={detailValue}>{confirmedDate}</Text>
              <Text style={detailLabel}>{c.from}</Text>
              <Text style={detailValue}>{originAddress}</Text>
              <Text style={detailLabel}>{c.to}</Text>
              <Text style={detailValue}>{destAddress}</Text>
              {discountPercent ? (
                <>
                  <Text style={detailLabel}>{c.disc}</Text>
                  <Text style={detailValue}>{c.discVal(discountPercent)}</Text>
                </>
              ) : null}
            </Section>
            <Text style={p}>{c.body2}</Text>
            <Button style={btn} href={portalUrl}>{c.cta}</Button>
            <Hr style={hr} />
            <Text style={footer}>{c.footer}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const body: React.CSSProperties = { backgroundColor: '#F5F1EA', fontFamily: 'Inter, -apple-system, sans-serif' }
const container: React.CSSProperties = { maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }
const header: React.CSSProperties = { backgroundColor: '#0A1628', padding: '24px', borderRadius: '12px 12px 0 0', textAlign: 'center' }
const brandName: React.CSSProperties = { color: '#FF5A1F', fontSize: '18px', fontWeight: '700', margin: '0' }
const content: React.CSSProperties = { backgroundColor: '#FFFFFF', padding: '32px 28px', borderRadius: '0 0 12px 12px' }
const h1: React.CSSProperties = { fontSize: '22px', fontWeight: '700', color: '#0A1628', margin: '0 0 16px' }
const highlight: React.CSSProperties = { backgroundColor: '#FFF7ED', border: '1px solid #FF5A1F', borderRadius: '8px', padding: '12px 16px', color: '#C04A10', fontWeight: '600', margin: '0 0 16px' }
const p: React.CSSProperties = { fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }
const detailBox: React.CSSProperties = { backgroundColor: '#F5F1EA', padding: '16px', borderRadius: '8px', margin: '20px 0' }
const detailLabel: React.CSSProperties = { fontSize: '11px', color: '#6B7280', fontWeight: '600', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '8px 0 2px' }
const detailValue: React.CSSProperties = { fontSize: '14px', color: '#0A1628', fontWeight: '500', margin: '0 0 8px' }
const btn: React.CSSProperties = { backgroundColor: '#FF5A1F', color: '#FFFFFF', padding: '14px 28px', borderRadius: '8px', fontWeight: '700', fontSize: '15px', display: 'block', textAlign: 'center', textDecoration: 'none', margin: '24px 0' }
const hr: React.CSSProperties = { borderColor: '#E5E7EB', margin: '24px 0' }
const footer: React.CSSProperties = { fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }
