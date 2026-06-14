import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Button, Hr } from '@react-email/components'

// ════════════════════════════════════════════════════════════════════════
//  PRE-APPROVAL EMAIL  (1 of the 2 allowed customer emails)
//  Queued ONLY by the Discord approval handler (admin clicks ✅ Approve).
//  "Your booking is approved, pending final confirmation."
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  requestedDate?: string
  items?: string
  originAddress?: string
  destAddress?: string
  portalUrl?: string
  locale?: string
}

export default function PreApprovalEmail({
  customerName = 'Friend',
  displayId = '',
  requestedDate,
  items,
  originAddress,
  destAddress,
  portalUrl = '#',
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const dateStr = requestedDate
    ? new Date(requestedDate).toLocaleString(es ? 'es-US' : 'en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/New_York',
      })
    : es
    ? 'tu fecha solicitada'
    : 'your requested date'

  const c = es
    ? {
        lang: 'es',
        h1: '¡Tu reserva está aprobada! ✅',
        hi: `Hola ${customerName},`,
        intro: 'Tu reserva fue aprobada y está pendiente de confirmación final. Esto es lo que tenemos registrado:',
        ref: 'Referencia', dt: 'Fecha y Hora', from: 'Desde', to: 'Hasta', det: 'Detalles',
        next: 'Estamos finalizando los últimos detalles. Recibirás tu confirmación final en breve.',
        cta: 'Ver Mi Reserva →',
        footer: '¿Preguntas? Llámanos o escríbenos al 862-640-0625',
      }
    : {
        lang: 'en',
        h1: 'Your booking is approved! ✅',
        hi: `Hi ${customerName},`,
        intro: 'Your booking has been approved and is pending final confirmation. Here is what we have on file:',
        ref: 'Reference', dt: 'Date & Time', from: 'From', to: 'To', det: 'Details',
        next: "We're finalizing the last details. You'll receive your final confirmation shortly.",
        cta: 'View Your Booking →',
        footer: 'Questions? Call or text us at 862-640-0625',
      }

  return (
    <Html lang={c.lang}>
      <Head />
      <Body style={body}>
        <Container style={container}>
          <Section style={header}>
            <Text style={brandName}>We Move It. We Clear It.</Text>
          </Section>
          <Section style={content}>
            <Heading style={h1}>{c.h1}</Heading>
            <Text style={p}>{c.hi}</Text>
            <Text style={p}>{c.intro}</Text>
            <Section style={detailBox}>
              {displayId ? (
                <>
                  <Text style={detailLabel}>{c.ref}</Text>
                  <Text style={detailValue}>{displayId}</Text>
                </>
              ) : null}
              <Text style={detailLabel}>{c.dt}</Text>
              <Text style={detailValue}>{dateStr}</Text>
              {originAddress ? (
                <>
                  <Text style={detailLabel}>{c.from}</Text>
                  <Text style={detailValue}>{originAddress}</Text>
                </>
              ) : null}
              {destAddress ? (
                <>
                  <Text style={detailLabel}>{c.to}</Text>
                  <Text style={detailValue}>{destAddress}</Text>
                </>
              ) : null}
              {items ? (
                <>
                  <Text style={detailLabel}>{c.det}</Text>
                  <Text style={detailValue}>{items}</Text>
                </>
              ) : null}
            </Section>
            <Text style={p}>{c.next}</Text>
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
const p: React.CSSProperties = { fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }
const detailBox: React.CSSProperties = { backgroundColor: '#F5F1EA', padding: '16px', borderRadius: '8px', margin: '20px 0' }
const detailLabel: React.CSSProperties = { fontSize: '11px', color: '#6B7280', fontWeight: '600', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '8px 0 2px' }
const detailValue: React.CSSProperties = { fontSize: '14px', color: '#0A1628', fontWeight: '500', margin: '0 0 8px', whiteSpace: 'pre-line' }
const btn: React.CSSProperties = { backgroundColor: '#FF5A1F', color: '#FFFFFF', padding: '14px 28px', borderRadius: '8px', fontWeight: '700', fontSize: '15px', display: 'block', textAlign: 'center', textDecoration: 'none', margin: '24px 0' }
const hr: React.CSSProperties = { borderColor: '#E5E7EB', margin: '24px 0' }
const footer: React.CSSProperties = { fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }
