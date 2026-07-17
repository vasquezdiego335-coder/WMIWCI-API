import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Hr } from '@react-email/components'

interface Props {
  customerName?: string
  messagePreview?: string
  locale?: string
}

// Bilingual auto-reply sent to anyone who submits the contact form.
export default function ContactAckEmail({ customerName = 'Friend', messagePreview, locale = 'en' }: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')

  const copy = es
    ? {
        lang: 'es',
        heading: 'Recibimos tu mensaje ✅',
        p1: `Hola ${customerName}, gracias por escribirnos. Recibimos tu mensaje y te responderemos en unas horas.`,
        p2: 'Para algo urgente, llámanos o envíanos un mensaje al 862-640-0625.',
        yourMsg: 'Tu mensaje',
        footer: '¿Preguntas? 862-640-0625 · hello@moveitclearit.com',
      }
    : {
        lang: 'en',
        heading: 'We got your message ✅',
        p1: `Hi ${customerName}, thanks for reaching out. We received your message and will reply within a few hours.`,
        p2: 'For anything urgent, call or text us at 862-640-0625.',
        yourMsg: 'Your message',
        footer: 'Questions? 862-640-0625 · hello@moveitclearit.com',
      }

  return (
    <Html lang={copy.lang}><Head />
      <Body style={{ backgroundColor: '#F5F1EA', fontFamily: 'Inter, sans-serif' }}>
        <Container style={{ maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }}>
          <Section style={{ backgroundColor: '#0A1628', padding: '20px', borderRadius: '12px 12px 0 0', textAlign: 'center' }}>
            <Text style={{ color: '#FF5A1F', fontSize: '16px', fontWeight: '700', margin: '0' }}>Move It Clear It.</Text>
          </Section>
          <Section style={{ backgroundColor: '#FFFFFF', padding: '32px 28px', borderRadius: '0 0 12px 12px' }}>
            <Heading style={{ fontSize: '20px', fontWeight: '700', color: '#0A1628', margin: '0 0 16px' }}>{copy.heading}</Heading>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>{copy.p1}</Text>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>{copy.p2}</Text>
            {messagePreview ? (
              <Section style={{ backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '8px', padding: '16px', margin: '20px 0' }}>
                <Text style={{ fontSize: '12px', fontWeight: '700', color: '#0A1628', margin: '0 0 6px' }}>{copy.yourMsg}</Text>
                <Text style={{ fontSize: '13px', color: '#374151', lineHeight: '1.6', margin: '0', fontStyle: 'italic' }}>{messagePreview}</Text>
              </Section>
            ) : null}
            <Hr style={{ borderColor: '#E5E7EB', margin: '20px 0' }} />
            <Text style={{ fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }}>{copy.footer}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
