/*
 * make-hero-gif.mjs — generates the animated truck GIF used as the Gmail/Outlook
 * fallback for <AnimatedHero>. Same art as HeroTruckArt in src/emails/_ui.tsx:
 * wheels rotate + the road dashoffset flows. Loops seamlessly.
 *
 *   npm i -D sharp gif-encoder-2
 *   node scripts/make-hero-gif.mjs            # -> scripts/truck-hero.gif
 *   node scripts/make-hero-gif.mjs ./out.gif  # -> custom path
 *
 * Then host it (see bottom of this file / the deploy notes):
 *   WMIWCI-SITE/public/email/truck-hero.gif  ->  https://moveitclearit.com/email/truck-hero.gif
 */
import sharp from 'sharp'
import GIFEncoder from 'gif-encoder-2'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const W = 320 // output width  (matches AnimatedHero width)
const H = 123 // output height (matches AnimatedHero height)
const SCALE = 2 // supersample for crisp edges, then downscale
const FRAMES = 15 // one full wheel rotation over the loop
const DELAY = 66 // ms per frame (~1s loop)
const ROAD_PERIODS = 2 // dash cycles per loop (road period = 10+16 = 26px)

const OUT =
  process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'truck-hero.gif')

// One frame of the scene. `deg` rotates both wheels; `off` shifts the road dashes.
function frameSvg(deg, off) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 520 200">
  <rect x="0" y="0" width="520" height="200" fill="#FFFFFF"/>
  <path d="M118 67 L121 74 L128 76 L121 78 L118 85 L115 78 L108 76 L115 74 Z" fill="#D4A24C"/>
  <path d="M404 60 L408 68 L416 71 L408 74 L404 82 L400 74 L392 71 L400 68 Z" fill="#D4A24C"/>
  <line x1="40" y1="172" x2="480" y2="172" stroke="#D4A24C" stroke-width="4" stroke-linecap="round" stroke-dasharray="10 16" stroke-dashoffset="${off}"/>
  <rect x="180" y="78" width="120" height="62" rx="12" fill="#0D1A2D"/>
  <rect x="180" y="120" width="120" height="9" fill="#FF6A00"/>
  <path d="M214 92 L242 106 L214 120" stroke="#FF6A00" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M300 94 h36 l24 24 v18 a5 5 0 0 1 -5 5 h-55 z" fill="#0D1A2D"/>
  <rect x="318" y="102" width="28" height="20" rx="4" fill="#FF6A00" opacity="0.9"/>
  <rect x="357" y="132" width="6" height="9" rx="2" fill="#D4A24C"/>
  <circle cx="222" cy="150" r="18" fill="#0D1A2D"/>
  <circle cx="222" cy="150" r="7.5" fill="#F7F7F2"/>
  <g transform="rotate(${deg} 222 150)"><path d="M222 143.5 V156.5 M215.5 150 H228.5" stroke="#0D1A2D" stroke-width="2.4" stroke-linecap="round"/></g>
  <circle cx="328" cy="150" r="18" fill="#0D1A2D"/>
  <circle cx="328" cy="150" r="7.5" fill="#F7F7F2"/>
  <g transform="rotate(${deg} 328 150)"><path d="M328 143.5 V156.5 M321.5 150 H334.5" stroke="#0D1A2D" stroke-width="2.4" stroke-linecap="round"/></g>
</svg>`
}

async function main() {
  const encoder = new GIFEncoder(W, H, 'neuquant', true)
  encoder.setDelay(DELAY)
  encoder.setRepeat(0) // 0 = loop forever
  encoder.setQuality(8)
  encoder.start()

  for (let i = 0; i < FRAMES; i++) {
    const deg = ((360 / FRAMES) * i).toFixed(2)
    const off = (-((26 * ROAD_PERIODS) / FRAMES) * i).toFixed(2)
    // Rasterize the SVG at 2x, downscale to WxH, flatten onto white, RGBA raw pixels.
    const rgba = await sharp(Buffer.from(frameSvg(deg, off)))
      .resize(W, H)
      .flatten({ background: '#FFFFFF' })
      .ensureAlpha()
      .raw()
      .toBuffer()
    encoder.addFrame(rgba) // gif-encoder-2 accepts a raw RGBA buffer
  }

  encoder.finish()
  writeFileSync(OUT, encoder.out.getData())
  console.log(`✓ wrote ${OUT}  (${FRAMES} frames, ${W}x${H}, ~${DELAY * FRAMES}ms loop)`)
  console.log('  next: copy it to  WMIWCI-SITE/public/email/truck-hero.gif')
  console.log('  so it serves at   https://moveitclearit.com/email/truck-hero.gif')
}

main().catch((err) => {
  console.error('GIF generation failed:', err)
  process.exit(1)
})
