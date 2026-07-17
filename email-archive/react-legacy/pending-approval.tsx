import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Hr } from '@react-email/components'
interface Props { customerName: string; requestedDate?: string; locale?: string }
export default function PendingApprovalEmail({ customerName = 'Friend', requestedDate, locale = 'en' }: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const dateStr = requestedDate
    ? new Date(requestedDate).toLocaleDateString(es ? 'es-US' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' })
    : (es ? 'tu fecha solicitada' : 'your requested date')
  const c = es
    ? {
        lang: 'es', heading: 'Estamos revisando tu reserva ⏳',
        p1a: `Hola ${customerName}, ¡tu depósito está confirmado! Ahora estamos revisando disponibilidad para `, p1b: '.',
        p2: 'Recibirás un correo de confirmación en unas horas. Si tu fecha no está disponible, te ofreceremos alternativas de inmediato.',
        remindersTitle: 'Recordatorios rápidos',
        reminders: [
          'Debes estar presente al inicio y al final de la mudanza.',
          'Servicio solo de mano de obra — cargamos y descargamos; no proveemos camiones.',
          'Renta tu U-Haul a tu propio nombre y agréganos como segundo conductor.',
          'Escaleras, caminatas largas y artículos pesados pueden requerir tiempo extra.',
          'Tus $49 están autorizados (una retención, no un cargo). Solo los cobramos al aprobar tu reserva — si la rechazamos, la retención se libera y nunca se te cobra.',
        ],
        fallback: 'Si no podemos procesar tu reserva automáticamente, te llamaremos o te enviaremos un correo para confirmar tu mudanza manualmente.',
        footer: '¿Preguntas? 862-640-0625 · hello@moveitclearit.com',
      }
    : {
        lang: 'en', heading: "We're reviewing your booking ⏳",
        p1a: `Hi ${customerName}, your deposit is confirmed! We're now reviewing availability for `, p1b: '.',
        p2: "You'll receive a confirmation email within a few hours. If your date isn't available, we'll offer alternatives right away.",
        remindersTitle: 'Quick reminders',
        reminders: [
          'You must be present at the start and end of the move.',
          'Labor-only service — we load and unload; we do not provide trucks.',
          'Rent your U-Haul in your own name and add us as a second driver.',
          'Stairs, long walks, and heavy items may require extra time.',
          'Your $49 is authorized (a hold, not a charge). We capture it only when we approve your booking — if we deny it, the hold is released and you\'re never charged.',
        ],
        fallback: 'If we cannot process your booking automatically, we will call you or send you an email to confirm your move manually.',
        footer: 'Questions? 862-640-0625 · hello@moveitclearit.com',
      }
  return (
    <Html lang={c.lang}><Head />
      <Body style={{ backgroundColor: '#F5F1EA', fontFamily: 'Inter, sans-serif' }}>
        <Container style={{ maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }}>
          <Section style={{ backgroundColor: '#0A1628', padding: '20px', borderRadius: '12px 12px 0 0', textAlign: 'center' }}><Text style={{ color: '#FF5A1F', fontSize: '16px', fontWeight: '700', margin: '0' }}>Move It Clear It.</Text></Section>
          <Section style={{ backgroundColor: '#FFFFFF', padding: '32px 28px', borderRadius: '0 0 12px 12px' }}>
            <Heading style={{ fontSize: '20px', fontWeight: '700', color: '#0A1628', margin: '0 0 16px' }}>{c.heading}</Heading>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>{c.p1a}<strong>{dateStr}</strong>{c.p1b}</Text>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>{c.p2}</Text>
            <Section style={{ backgroundColor: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: '8px', padding: '16px', margin: '20px 0' }}>
              <Text style={{ fontSize: '13px', fontWeight: '700', color: '#0A1628', margin: '0 0 8px' }}>{c.remindersTitle}</Text>
              <Text style={{ fontSize: '13px', color: '#374151', lineHeight: '1.7', margin: '0' }}>
                {c.reminders.map((r, i) => (<React.Fragment key={i}>• {r}<br /></React.Fragment>))}
              </Text>
            </Section>
            <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px', fontWeight: '600' }}>{c.fallback}</Text>
            <Hr style={{ borderColor: '#E5E7EB', margin: '20px 0' }} />
            <Text style={{ fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }}>{c.footer}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
