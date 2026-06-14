import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Button, Hr } from '@react-email/components'

interface Props {
  customerName?: string
  released?: boolean
  depositAmount?: string
  rescheduleUrl?: string
  fallbackMessage?: string
  locale?: string
}

export default function BookingDeniedEmail({
  customerName = 'Friend',
  released = true,
  depositAmount = '49.00',
  rescheduleUrl = '#',
  fallbackMessage,
  locale = 'en',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const fallback =
    fallbackMessage ??
    (es
      ? 'Si no podemos procesar tu reserva automáticamente, te llamaremos o te enviaremos un correo para confirmar tu mudanza manualmente.'
      : 'If we cannot process your booking automatically, we will call you or send you an email to confirm your move manually.')
  const c = es
    ? {
        lang: 'es', h1: 'Lo sentimos — no podemos realizar esta mudanza',
        intro: `Hola ${customerName}, después de revisar tu solicitud no podemos confirmar esta reserva.`,
        title: released ? 'Tu retención de $49 fue liberada' : 'Tu retención de $49 será liberada',
        item: `💸 No se te cobró — la autorización de $${depositAmount} ${released ? 'fue liberada (puede tardar unos días en desaparecer de tu estado de cuenta).' : 'será liberada en breve.'}`,
        try: '¿Quieres probar otra fecha? Puedes reservar de nuevo cuando quieras:',
        cta: 'Reservar de Nuevo →', footer: '¿Preguntas? Llama o escribe al 862-640-0625',
      }
    : {
        lang: 'en', h1: "We're sorry — we can't take this move",
        intro: `Hi ${customerName}, after reviewing your request we're unable to confirm this booking.`,
        title: released ? 'Your $49 hold has been released' : 'Your $49 hold will be released',
        item: `💸 You were not charged — the $${depositAmount} authorization ${released ? 'has been released (it may take a few days to drop off your statement).' : 'will be released shortly.'}`,
        try: 'Want to try a different date? You can rebook anytime:',
        cta: 'Rebook Your Move →', footer: 'Questions? Call or text 862-640-0625',
      }
  return (
    <Html lang={c.lang}><Head />
      <Body style={body}>
        <Container style={container}>
          <Section style={header}><Text style={brand}>We Move It. We Clear It.</Text></Section>
          <Section style={content}>
            <Heading style={h1}>{c.h1}</Heading>
            <Text style={p}>{c.intro}</Text>
            <Section style={slotBox}>
              <Text style={slotTitle}>{c.title}</Text>
              <Text style={slotItem}>{c.item}</Text>
            </Section>
            <Text style={p}>{c.try}</Text>
            <Button style={btn} href={rescheduleUrl}>{c.cta}</Button>
            <Hr style={hr} />
            <Text style={p}>{fallback}</Text>
            <Text style={footer}>{c.footer}</Text>
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
const slotBox: React.CSSProperties = { backgroundColor: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: '8px', padding: '16px', margin: '20px 0' }
const slotTitle: React.CSSProperties = { fontSize: '13px', fontWeight: '700', color: '#0A1628', margin: '0 0 8px' }
const slotItem: React.CSSProperties = { fontSize: '14px', color: '#374151', margin: '4px 0', padding: '6px 0', borderBottom: '1px solid #FED7AA' }
const btn: React.CSSProperties = { backgroundColor: '#FF5A1F', color: '#FFF', padding: '14px 28px', borderRadius: '8px', fontWeight: '700', display: 'block', textAlign: 'center', textDecoration: 'none', margin: '20px 0' }
const hr: React.CSSProperties = { borderColor: '#E5E7EB', margin: '20px 0' }
const footer: React.CSSProperties = { fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }
