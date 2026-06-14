import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Button, Hr } from '@react-email/components'
interface Props { customerName: string; googleReviewUrl: string; portalUrl: string }
export default function ReviewRequestEmail({ customerName = 'Friend', googleReviewUrl = '#', portalUrl = '#' }: Props) {
  return (
    <Html lang="en"><Head />
      <Body style={{ backgroundColor: '#F5F1EA', fontFamily: 'Inter, sans-serif' }}>
        <Container style={{ maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }}>
          <Section style={{ backgroundColor: '#0A1628', padding: '20px', borderRadius: '12px 12px 0 0', textAlign: 'center' }}><Text style={{ color: '#FF5A1F', fontSize: '16px', fontWeight: '700', margin: '0' }}>We Move It. We Clear It.</Text></Section>
          <Section style={{ backgroundColor: '#FFFFFF', padding: '32px 28px', borderRadius: '0 0 12px 12px' }}>
            <Heading style={{ fontSize: '20px', fontWeight: '700', color: '#0A1628', margin: '0 0 8px' }}>How did we do? ⭐</Heading>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>Hi {customerName}, it was a pleasure working with you! If you have 60 seconds, a Google review makes a huge difference for our small local business.</Text>
            <Button style={{ backgroundColor: '#FF5A1F', color: '#FFF', padding: '14px 28px', borderRadius: '8px', fontWeight: '700', display: 'block', textAlign: 'center', textDecoration: 'none', margin: '20px 0' }} href={googleReviewUrl}>Leave a Google Review ⭐ →</Button>
            <Hr style={{ borderColor: '#E5E7EB', margin: '20px 0' }} />
            <Text style={{ fontSize: '12px', color: '#9CA3AF', textAlign: 'center' }}>We Move It. We Clear It. · West Orange, NJ · 862-640-0625</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
