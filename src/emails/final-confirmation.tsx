import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Button, Hr } from '@react-email/components'

// ════════════════════════════════════════════════════════════════════════
//  FINAL CONFIRMATION EMAIL  (1 of the 2 allowed customer emails)
//  Queued ONLY by fulfillPaidCheckout() (payment completed — webhook or the
//  success redirect). Confirms the booking, the payment status, and next steps.
// ════════════════════════════════════════════════════════════════════════

interface Props {
  customerName?: string
  displayId?: string
  date?: string
  amountPaid?: string // dollars, e.g. "49.00"
  items?: string
  portalUrl?: string
  locale?: string
}

export default function FinalConfirmationEmail({
  customerName = 'Friend',
  displayId = '',
  date,
  amountPaid = '49.00',
  items,
  portalUrl = '#',
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const dateStr = date
    ? new Date(date).toLocaleString(es ? 'es-US' : 'en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/New_York',
      })
    : es
    ? 'tu fecha de mudanza'
    : 'your move date'

  const c = es
    ? {
        lang: 'es',
        h1: '¡Reserva confirmada! ✅',
        hi: `Hola ${customerName},`,
        intro: 'Tu reserva está confirmada. Aquí está el resumen y los próximos pasos:',
        ref: 'Referencia', dt: 'Fecha y Hora', pay: 'Estado del Pago', det: 'Detalles',
        payVal: `$${amountPaid} autorizado (retención) — se cobra al completar la aprobación`,
        steps: 'Próximos pasos',
        stepsBody:
          'Nuestro equipo revisará los detalles finales. Mantén tu camión listo y a alguien presente al inicio y al final de la mudanza.',
        cta: 'Ver Mi Reserva →',
        footer: '¿Preguntas? Llámanos o escríbenos al 862-640-0625',
      }
    : {
        lang: 'en',
        h1: 'Booking confirmed! ✅',
        hi: `Hi ${customerName},`,
        intro: "Your booking is confirmed. Here's your summary and what happens next:",
        ref: 'Reference', dt: 'Date & Time', pay: 'Payment Status', det: 'Details',
        payVal: `$${amountPaid} authorized (hold) — captured on final approval`,
        steps: 'Next steps',
        stepsBody:
          'Our crew will review the final details. Please keep your truck ready and have someone present at the start and end of the move.',
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
              <Text style={detailLabel}>{c.pay}</Text>
              <Text style={detailValue}>{c.payVal}</Text>
              {items ? (
                <>
                  <Text style={detailLabel}>{c.det}</Text>
                  <Text style={detailValue}>{items}</Text>
                </>
              ) : null}
            </Section>
            <Section style={stepsBox}>
              <Text style={stepsTitle}>{c.steps}</Text>
              <Text style={stepsText}>{c.stepsBody}</Text>
            </Section>
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
const stepsBox: React.CSSProperties = { backgroundColor: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: '8px', padding: '16px', margin: '16px 0' }
const stepsTitle: React.CSSProperties = { fontSize: '13px', fontWeight: '700', color: '#0A1628', margin: '0 0 6px' }
const stepsText: React.CSSProperties = { fontSize: '13px', color: '#374151', lineHeight: '1.6', margin: '0' }
const btn: React.CSSProperties = { backgroundColor: '#FF5A1F', color: '#FFFFFF', padding: '14px 28px', borderRadius: '8px', fontWeight: '700', fontSize: '15px', display: 'block', textAlign: 'center', textDecoration: 'none', margin: '24px 0' }
const hr: React.CSSProperties = { borderColor: '#E5E7EB', margin: '24px 0' }
const footer: React.CSSProperties = { fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }
