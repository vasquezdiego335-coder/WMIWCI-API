import * as React from 'react'
import { Html, Head, Body, Container, Section, Heading, Text, Button, Hr } from '@react-email/components'
interface Props { customerName: string; completedAt?: string; portalUrl: string; items?: string }
export default function JobCompletionEmail({ customerName = 'Friend', completedAt, portalUrl = '#', items }: Props) {
  return (
    <Html lang="en"><Head />
      <Body style={{ backgroundColor: '#F5F1EA', fontFamily: 'Inter, sans-serif' }}>
        <Container style={{ maxWidth: '560px', margin: '0 auto', padding: '24px 16px' }}>
          <Section style={{ backgroundColor: '#0A1628', padding: '20px', borderRadius: '12px 12px 0 0', textAlign: 'center' }}><Text style={{ color: '#FF5A1F', fontSize: '16px', fontWeight: '700', margin: '0' }}>We Move It. We Clear It.</Text></Section>
          <Section style={{ backgroundColor: '#FFFFFF', padding: '32px 28px', borderRadius: '0 0 12px 12px' }}>
            <Heading style={{ fontSize: '20px', fontWeight: '700', color: '#0A1628', margin: '0 0 16px' }}>Job Complete! 🎉</Heading>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>Hi {customerName}, your move is done! Thank you for trusting us with your belongings.</Text>
            <Text style={{ fontSize: '15px', color: '#374151', lineHeight: '1.6', margin: '0 0 12px' }}>Your receipt and job summary are available in your booking portal.</Text>
            {items ? (
              <Section style={{ backgroundColor: '#F5F1EA', padding: '14px 16px', borderRadius: '8px', margin: '0 0 16px' }}>
                <Text style={{ fontSize: '11px', color: '#6B7280', fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 6px' }}>Job Details</Text>
                <Text style={{ fontSize: '13px', color: '#0A1628', lineHeight: '1.7', margin: '0', whiteSpace: 'pre-line' }}>{items}</Text>
              </Section>
            ) : null}
            <Button style={{ backgroundColor: '#FF5A1F', color: '#FFF', padding: '14px 28px', borderRadius: '8px', fontWeight: '700', display: 'block', textAlign: 'center', textDecoration: 'none', margin: '20px 0' }} href={portalUrl}>Download Receipt →</Button>
            <Hr style={{ borderColor: '#E5E7EB', margin: '20px 0' }} />
            <Text style={{ fontSize: '13px', color: '#6B7280', textAlign: 'center' }}>We'll reach out in 48 hours with a review link. Your feedback means everything to us! 🙏</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
