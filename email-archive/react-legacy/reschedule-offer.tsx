import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Hr, Button } from '@react-email/components'
import { AnimatedHero, HeroAnimStyle } from './_ui'

interface Props {
  customerName?: string
  alternateDates?: string[] // pre-formatted Eastern date strings
  rescheduleUrl?: string
  locale?: string
  heroGifUrl?: string
}

// Sent when a booking's requested date can't be served, but we want to KEEP
// the customer (and their $49 hold) and offer alternate dates. Bilingual.
export default function RescheduleOfferEmail({
  customerName = 'Friend',
  alternateDates = [],
  rescheduleUrl = 'https://www.wemoveitweclearit.com/booking-form.html',
  locale = 'en',
  heroGifUrl = 'https://moveitclearit.com/email/truck-hero.gif',
}: Props) {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')

  const copy = es
    ? {
        lang: 'es',
        heading: 'Elige una nueva fecha 📅',
        p1: `Hola ${customerName}, no podemos hacer la fecha/hora que pediste — pero queremos hacer tu mudanza.`,
        p2: 'Tu retención de $49 sigue activa (no se te cobró de nuevo). Solo elige una de estas fechas disponibles:',
        noDates: 'Llámanos al 862-640-0625 y encontramos una fecha que te funcione.',
        cta: 'Elegir mi nueva fecha',
        hold: 'Tu retención de $49 se mantiene con esta reserva — no pagas otra vez.',
        footer: '¿Preguntas? 862-640-0625 · hello@moveitclearit.com',
      }
    : {
        lang: 'en',
        heading: 'Pick a new date 📅',
        p1: `Hi ${customerName}, we can't do the date/time you requested — but we'd still love to do your move.`,
        p2: "Your $49 hold is still active (you were not charged again). Just pick one of these open dates:",
        noDates: 'Call us at 862-640-0625 and we\'ll find a date that works for you.',
        cta: 'Choose my new date',
        hold: 'Your $49 hold stays attached to this booking — you don\'t pay again.',
        footer: 'Questions? 862-640-0625 · hello@moveitclearit.com',
      }

  return (
    <Html lang={copy.lang}><Head><HeroAnimStyle /></Head>
      <Body style={{ backgroundColor: '#F5F1EA', fontFamily: 'Inter, sans-serif' }}>
        <Container style={{ maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }}>
          <Section style={{ backgroundColor: '#0A1628', padding: '20px', borderRadius: '12px 12px 0 0', textAlign: 'center' }}>
            <Text style={{ color: '#FF5A1F', fontSize: '16px', fontWeight: '700', margin: '0' }}>Move It Clear It.</Text>
          </Section>
          <Section style={{ backgroundColor: '#FFFFFF', padding: '32px 28px', borderRadius: '0 0 12px 12px' }}>
            {/* Animated hero: SVG (Apple Mail) + GIF fallback (Gmail/Outlook) */}
            <AnimatedHero heroGifUrl={heroGifUrl} />
            <Heading style={{ fontSize: '20px', fontWeight: '700', color: '#0A1628', margin: '18px 0 16px' }}>{copy.heading}</Heading>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>{copy.p1}</Text>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>{copy.p2}</Text>

            {alternateDates.length > 0 ? (
              <Section style={{ backgroundColor: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: '8px', padding: '16px', margin: '20px 0' }}>
                {alternateDates.slice(0, 3).map((d, i) => (
                  <Text key={i} style={{ fontSize: '14px', fontWeight: '600', color: '#0A1628', lineHeight: '1.8', margin: '0' }}>
                    {i + 1}. {d}
                  </Text>
                ))}
              </Section>
            ) : (
              <Text style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>{copy.noDates}</Text>
            )}

            <Section style={{ textAlign: 'center', margin: '24px 0' }}>
              <Button href={rescheduleUrl} style={{ backgroundColor: '#FF5A1F', color: '#FFFFFF', fontSize: '15px', fontWeight: '700', padding: '12px 28px', borderRadius: '8px', textDecoration: 'none' }}>
                {copy.cta}
              </Button>
            </Section>

            <Text style={{ fontSize: '13px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px', fontWeight: '600' }}>{copy.hold}</Text>
            <Hr style={{ borderColor: '#E5E7EB', margin: '20px 0' }} />
            <Text style={{ fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }}>{copy.footer}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
