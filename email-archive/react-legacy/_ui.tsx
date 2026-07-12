import * as React from 'react'

// Stub exports for email-archive/react-legacy components
// These are legacy/archived templates not used in production
// Real components are in src/

export type HeroAnimStyle = Record<string, unknown>

export const AnimatedHero: React.FC<{
  src?: string
  alt?: string
  style?: Record<string, unknown>
}> = ({ src, alt, style }) => (
  <img src={src} alt={alt} style={style} />
)
