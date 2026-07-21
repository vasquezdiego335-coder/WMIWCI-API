// Generates the hosted email raster assets from the vector SOURCE in _ui.tsx.
//   npx tsx scripts/gen-email-assets.ts
// Output: email-assets/  (icons in navy/orange/gold @1x+@2x, hero.png, manifest.json)
// These are UPLOADED to ${EMAIL_ASSET_BASE_URL} (default https://moveitclearit.com/email).
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { IconSvg, HeroTruckArt, C } from '../src/emails/_ui'

const OUT = resolve('email-assets')
const ICONS = resolve(OUT, 'icons')
mkdirSync(ICONS, { recursive: true })

const ICON_NAMES = [
  'clipboard','route','shield','clock','steps','phone','mail','globe',
  'calendar','crew','checklist','truck','sparkle','weight','search',
] as const
const TONES: Record<string, string> = { navy: C.navy, orange: C.orange, gold: C.gold }

// Human-readable alt text per icon (for the manifest; the template uses alt="").
const ALT: Record<string, string> = {
  clipboard: 'Clipboard', route: 'Route pin', shield: 'Shield', clock: 'Clock',
  steps: 'Steps', phone: 'Phone', mail: 'Envelope', globe: 'Globe',
  calendar: 'Calendar', crew: 'Crew', checklist: 'Checklist', truck: 'Truck',
  sparkle: 'Sparkle', weight: 'Weight', search: 'Search',
}

function svgFor(name: string, color: string, px: number): string {
  const markup = renderToStaticMarkup(React.createElement(IconSvg, { name: name as never, color, size: px }))
  const m = markup.match(/<svg[\s\S]*<\/svg>/)
  if (!m) throw new Error(`no <svg> for ${name}`)
  return m[0]
}

type Entry = { file: string; width: number; height: number; url: string; alt: string }
const base = (process.env.EMAIL_ASSET_BASE_URL || 'https://moveitclearit.com/email').replace(/\/+$/, '')
const manifest: Entry[] = []

async function main() {
  // ── Icons: 15 × 3 tones × {1x=24, 2x=48} ──
  for (const name of ICON_NAMES) {
    for (const tone of Object.keys(TONES)) {
      for (const [suffix, px] of [['', 24], ['@2x', 48]] as const) {
        const svg = svgFor(name, TONES[tone], px)
        const file = `icons/${name}-${tone}${suffix}.png`
        await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(resolve(OUT, file))
        manifest.push({ file, width: px, height: px, url: `${base}/${file}`, alt: ALT[name] })
      }
    }
  }

  // ── Hero: static PNG rasterized from HeroTruckArt (2x = 640×246, served @320) ──
  const heroMarkup = renderToStaticMarkup(React.createElement(HeroTruckArt))
  const heroSvg = heroMarkup.match(/<svg[\s\S]*<\/svg>/)![0]
  await sharp(Buffer.from(heroSvg), { density: 144 }).png({ compressionLevel: 9 }).toFile(resolve(OUT, 'hero.png'))
  manifest.push({ file: 'hero.png', width: 640, height: 246, url: `${base}/hero.png`, alt: 'Move It Clear It — your movers are on the way' })

  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify({ base, generatedAt: new Date().toISOString(), assets: manifest }, null, 2))
  console.log(`OK generated ${manifest.length} assets into ${OUT}`)
  console.log(`  icons: ${ICON_NAMES.length} × ${Object.keys(TONES).length} tones × 2 sizes = ${ICON_NAMES.length * 3 * 2}`)
  console.log(`  hero.png (640×246)`)
}

main().catch((e) => { console.error('gen-email-assets failed:', e instanceof Error ? e.message : String(e)); process.exit(1) })
