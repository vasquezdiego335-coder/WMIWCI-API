import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Hr } from '@react-email/components'

interface Props {
  customerName?: string
  newDateDisplay?: string // pre-formatted Eastern date string
  displayId?: string
  locale?: string
}

// Sent the moment a customer picks a new date from their portal. Confirms the
// move was moved AND reassures them the $49 hold stays attached (no new charge).
// Bilingual via the locale captured at booking time.
export default function BookingRescheduledEmail({
  customerName = 'Friend',
  newDateDisplay = 'your new date',
  displayId = '',
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')

  const copy = es
    ? {
        lang: 'es',
        heading: 'Tu mudanza fue reprogramada ✅',
        p1: `Hola ${customerName}, recibimos tu nueva fecha. Estamos revisándola y te confirmamos en breve.`,
        when: 'Nueva fecha',
        hold: 'Tu retención de $49 sigue activa en esta reserva — no se te cobró de nuevo.',
        p2: 'Si esta fecha no funciona, puedes elegir otra desde el mismo enlace o llamarnos.',
        footer: '¿Preguntas? 862-640-0625 · hello@moveitclearit.com',
      }
    : {
        lang: 'en',
        heading: 'Your move has been rescheduled ✅',
        p1: `Hi ${customerName}, we got your new date. We're reviewing it and will confirm shortly.`,
        when: 'New date',
        hold: 'Your $49 hold stays attached to this booking — you were not charged again.',
        p2: 'If this date does not work, you can pick another from the same link or call us.',
        footer: 'Questions? 862-640-0625 · hello@moveitclearit.com',
      }

  return (
    <Html lang={copy.lang}><Head />
      <Body style={{ backgroundColor: '#F5F1EA', fontFamily: 'Inter, sans-serif' }}>
        <Container style={{ maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }}>
          <Section style={{ backgroundColor: '#0A1628', padding: '20px', borderRadius: '12px 12px 0 0', textAlign: 'center' }}>
            <Text style={{ color: '#FF5A1F', fontSize: '16px', fontWeight: '700', margin: '0' }}>We Move It. We Clear It.</Text>
          </Section>
          <Section style={{ backgroundColor: '#FFFFFF', padding: '32px 28px', borderRadius: '0 0 12px 12px' }}>
            <Heading style={{ fontSize: '20px', fontWeight: '700', color: '#0A1628', margin: '0 0 16px' }}>{copy.heading}</Heading>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>{copy.p1}</Text>

            <Section style={{ backgroundColor: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: '8px', padding: '16px', margin: '20px 0' }}>
              <Text style={{ fontSize: '13px', color: '#9A3412', fontWeight: '700', margin: '0 0 4px', textTransform: 'uppercase' }}>{copy.when}</Text>
              <Text style={{ fontSize: '16px', fontWeight: '700', color: '#0A1628', margin: '0' }}>{newDateDisplay}</Text>
              {displayId ? (
                <Text style={{ fontSize: '12px', color: '#6B7280', margin: '6px 0 0' }}>#{displayId}</Text>
              ) : null}
            </Section>

            <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px', fontWeight: '600' }}>{copy.hold}</Text>
            <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>{copy.p2}</Text>
            <Hr style={{ borderColor: '#E5E7EB', margin: '20px 0' }} />
            <Text style={{ fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }}>{copy.footer}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
