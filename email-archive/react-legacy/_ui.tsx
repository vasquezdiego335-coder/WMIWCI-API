import * as React from 'react'

// Stub exports for email-archive/react-legacy components
// These are legacy/archived templates not used in production
// Real components are in src/

export const HeroAnimStyle: React.FC = () => (
  <style>{`
    @keyframes heroFade {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .hero-anim {
      animation: heroFade 0.5s ease-in-out;
    }
  `}</style>
)

export const AnimatedHero: React.FC<{
  src?: string
  alt?: string
  style?: Record<string, unknown>
}> = ({ src, alt, style }) => (
  <img src={src} alt={alt} style={style} />
)
