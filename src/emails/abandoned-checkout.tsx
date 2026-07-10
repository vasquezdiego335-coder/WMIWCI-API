import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Button, Hr } from '@react-email/components'
import { AnimatedHero, HeroAnimStyle } from './_ui'

interface Props { customerName: string; checkoutUrl: string; heroGifUrl?: string }

export default function AbandonedCheckoutEmail({
  customerName = 'Friend',
  checkoutUrl = '#',
  heroGifUrl = 'https://moveitclearit.com/email/truck-hero.gif',
}: Props) {
  return (
    <Html lang="en">
      <Head><HeroAnimStyle /></Head>
      <Body style={{ backgroundColor: '#F5F1EA', fontFamily: 'Inter, sans-serif' }}>
        <Container style={{ maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }}>
          <Section style={{ backgroundColor: '#0A1628', padding: '20px', borderRadius: '12px 12px 0 0', textAlign: 'center' }}><Text style={{ color: '#FF5A1F', fontSize: '16px', fontWeight: '700', margin: '0' }}>We Move It. We Clear It.</Text></Section>
          <Section style={{ backgroundColor: '#FFFFFF', padding: '26px 28px 32px', borderRadius: '0 0 12px 12px' }}>
            {/* Animated hero: SVG (Apple Mail) + GIF fallback (Gmail/Outlook) */}
            <AnimatedHero heroGifUrl={heroGifUrl} />
            <Heading style={{ fontSize: '20px', fontWeight: '700', color: '#0A1628', margin: '18px 0 16px' }}>Your date is still available 📅</Heading>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>Hi {customerName}, you started a booking with us but didn't complete the $49 deposit. Your requested date may still be open!</Text>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>Complete your deposit now to lock it in before it's taken.</Text>
            <Button style={{ backgroundColor: '#FF5A1F', color: '#FFF', padding: '14px 28px', borderRadius: '8px', fontWeight: '700', display: 'block', textAlign: 'center', textDecoration: 'none', margin: '20px 0' }} href={checkoutUrl}>Complete My Booking →</Button>
            <Hr style={{ borderColor: '#E5E7EB', margin: '20px 0' }} />
            <Text style={{ fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }}>Questions? Reply to this email or call 862-640-0625</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
