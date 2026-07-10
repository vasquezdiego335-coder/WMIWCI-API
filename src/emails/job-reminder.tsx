import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Button, Hr } from '@react-email/components'
import { AnimatedHero, HeroAnimStyle } from './_ui'
interface Props { customerName: string; scheduledStart?: string; originAddress: string; portalUrl: string; heroGifUrl?: string }
export default function JobReminderEmail({ customerName = 'Friend', scheduledStart, originAddress = 'Origin', portalUrl = '#', heroGifUrl = 'https://moveitclearit.com/email/truck-hero.gif' }: Props) {
  const dateStr = scheduledStart ? new Date(scheduledStart).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : 'tomorrow'
  return (
    <Html lang="en"><Head><HeroAnimStyle /></Head>
      <Body style={{ backgroundColor: '#F5F1EA', fontFamily: 'Inter, sans-serif' }}>
        <Container style={{ maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }}>
          <Section style={{ backgroundColor: '#0A1628', padding: '20px', borderRadius: '12px 12px 0 0', textAlign: 'center' }}><Text style={{ color: '#FF5A1F', fontSize: '16px', fontWeight: '700', margin: '0' }}>We Move It. We Clear It.</Text></Section>
          <Section style={{ backgroundColor: '#FFFFFF', padding: '32px 28px', borderRadius: '0 0 12px 12px' }}>
            {/* Animated hero: SVG (Apple Mail) + GIF fallback (Gmail/Outlook) */}
            <AnimatedHero heroGifUrl={heroGifUrl} />
            <Heading style={{ fontSize: '20px', fontWeight: '700', color: '#0A1628', margin: '18px 0 16px' }}>⏰ Your move is tomorrow!</Heading>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>Hi {customerName}, just a reminder that your crew arrives <strong>{dateStr}</strong> at {originAddress}.</Text>
            <Section style={{ backgroundColor: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: '8px', padding: '16px', margin: '16px 0' }}>
              <Text style={{ fontSize: '14px', color: '#0A1628', fontWeight: '600', margin: '0 0 8px' }}>Before the crew arrives:</Text>
              <Text style={{ fontSize: '13px', color: '#374151', margin: '4px 0' }}>✅ Have the truck at the pickup location</Text>
              <Text style={{ fontSize: '13px', color: '#374151', margin: '4px 0' }}>✅ Disconnect appliances and prepare boxes</Text>
              <Text style={{ fontSize: '13px', color: '#374151', margin: '4px 0' }}>✅ Clear pathways and doorways</Text>
              <Text style={{ fontSize: '13px', color: '#374151', margin: '4px 0' }}>✅ Have payment ready for remaining balance</Text>
            </Section>
            <Button style={{ backgroundColor: '#FF5A1F', color: '#FFF', padding: '14px 28px', borderRadius: '8px', fontWeight: '700', display: 'block', textAlign: 'center', textDecoration: 'none', margin: '20px 0' }} href={portalUrl}>View Booking Details →</Button>
            <Hr style={{ borderColor: '#E5E7EB', margin: '20px 0' }} />
            <Text style={{ fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }}>Need to reschedule? Call 862-640-0625 ASAP</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
