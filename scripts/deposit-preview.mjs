// ════════════════════════════════════════════════════════════════════════════
//  deposit-preview.mjs — render the REAL deposit page to static HTML files.
//  ------------------------------------------------------------------------
//  WHY THIS EXISTS. The public deposit page is the one screen in this system a
//  paying customer sees, it is usually opened inside Messenger's in-app browser
//  on a phone, and its content is free text an owner types on the move. Reading
//  the JSX is not the same as looking at it with a 200-character service line in
//  Spanish at 320px — which is exactly how an internal note ended up clipped on
//  a live link.
//
//  It renders the ACTUAL component with the ACTUAL stylesheet, so what you look
//  at is what ships. No database, no Stripe, no network.
//
//    npx tsx scripts/deposit-preview.mjs        -> .preview/deposit/*.html
//
//  The output is gitignored scratch. Delete it freely.
// ════════════════════════════════════════════════════════════════════════════
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, '.preview', 'deposit')

// Run through tsx (`npx tsx scripts/deposit-preview.mjs`) so the real .tsx
// component and .ts modules import directly.
const { default: DepositView } = await import('../app/deposit/[token]/DepositView.tsx')
const { parseCalendarDate } = await import('../src/lib/move-date.ts')

const CSS = readFileSync(join(ROOT, 'app/deposit/[token]/deposit.css'), 'utf8')

const PHONE = { display: '(862) 640-0625', tel: '+18626400625', sms: '+18626400625' }

const base = {
  token: 'SACBX6T8SZHB',
  status: 'ACTIVE',
  firstName: 'Rosey',
  serviceSummary: 'Labor-Only Move · 2 Movers',
  moveDetails: [
    'Apartment next door',
    'Old wooden bed frame removal',
    'New queen bed frame assembly',
    '15 stairs at pickup · 7 stairs at drop-off',
  ],
  customerNote: 'Customer to provide all necessary hardware/screws.',
  moveDate: parseCalendarDate('2026-08-22'),
  moveTimeMinutes: 420,
  quoteTotalCents: 49500,
  alreadyPaidCents: null,
  depositCents: 4900,
  remainingCents: 44600,
  amountPaidCents: null,
  paidAt: null,
  showsBalance: true,
}

/** The cases that have actually broken this page, plus the ordinary one. */
const CASES = [
  { name: '01-en-typical', lang: 'en', view: base },
  { name: '02-es-typical', lang: 'es', view: base },
  {
    name: '03-en-long-text',
    lang: 'en',
    // The reported defect: an internal note pasted into the service field, plus
    // an unbreakable token. Neither may widen the card or be clipped.
    view: {
      ...base,
      serviceSummary:
        'Job Note: Saturday, 7:00 AM — 2 workers, labor-only move, customer has own truck',
      moveDetails: [
        'Pickup is a third-floor walk-up with a very narrow staircase landing',
        'https://maps.example.com/a/very/long/unbreakable/url/that/cannot/wrap',
        'Supercalifragilisticexpialidociousandthensomemoreletters',
        '15 stairs at pickup · 7 stairs at drop-off · long carry at both ends',
        'Fragile glass tabletop — handle with two people at all times please',
        'Customer will meet the crew in the rear parking lot by the loading door',
      ],
      customerNote:
        'Customer to provide all necessary hardware, screws, bolts and any tools required for the bed frame reassembly on arrival.',
    },
  },
  {
    name: '04-es-long-text',
    lang: 'es',
    view: {
      ...base,
      serviceSummary: 'Mudanza solo de mano de obra · 2 trabajadores · sin camión',
      moveDetails: [
        'Apartamento de al lado, tercer piso sin ascensor y escalera estrecha',
        '15 escalones en la recogida · 7 escalones en la entrega',
        'Desmontaje de la cama de madera antigua y montaje de la cama nueva',
      ],
      customerNote:
        'El cliente debe proporcionar todos los tornillos y herrajes necesarios para el montaje.',
    },
  },
  {
    name: '05-en-minimal',
    lang: 'en',
    // Everything optional is absent. The card must still look intentional.
    view: {
      ...base,
      firstName: null,
      serviceSummary: null,
      moveDetails: [],
      customerNote: null,
      moveDate: null,
      moveTimeMinutes: null,
      quoteTotalCents: null,
      remainingCents: null,
      showsBalance: false,
    },
  },
  {
    name: '06-en-already-paid-row',
    lang: 'en',
    // The three money figures must subtract on screen.
    view: { ...base, alreadyPaidCents: 4900, remainingCents: 39700 },
  },
  {
    name: '07-en-no-time',
    lang: 'en',
    view: { ...base, moveTimeMinutes: null },
  },
  {
    name: '08-en-paid',
    lang: 'en',
    view: {
      ...base,
      status: 'PAID',
      amountPaidCents: 4900,
      paidAt: new Date('2026-08-20T18:34:00.000Z'),
    },
  },
  {
    name: '09-es-expired',
    lang: 'es',
    view: { ...base, status: 'EXPIRED' },
  },
  {
    name: '10-en-outage',
    lang: 'en',
    view: null, // the database could not be reached
  },
]

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'deposit.css'), CSS, 'utf8')

const WIDTHS = [320, 360, 390, 430, 768, 1440]

for (const testCase of CASES) {
  const body = renderToStaticMarkup(
    React.createElement(DepositView, {
      view: testCase.view,
      token: 'SACBX6T8SZHB',
      initialLang: testCase.lang,
      returning: false,
      canceled: false,
      phone: PHONE,
    })
  )

  const html = `<!doctype html>
<html lang="${testCase.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${testCase.name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>html,body{margin:0;padding:0}</style>
<!-- LINKED, never inlined. deposit.css's own header comment contains the
     literal text </st" + "yle> (it documents the hydration bug it was extracted
     from), and a <style> element is RAW TEXT: inlining the file terminates the
     element at that point and silently drops the :root custom properties, so
     every colour falls back to black. Next links it as a stylesheet too, so
     this is also what production actually does. -->
<link rel="stylesheet" href="./deposit.css">
</head>
<body>
${body}
<footer data-site-footer style="background-color:#0A1628;padding:32px 24px;margin-top:40px">
  <div style="max-width:720px;margin:0 auto;text-align:center">
    <nav aria-label="Legal"><a href="https://moveitclearit.com/terms" style="color:#FF5A1F">Move It Clear It Terms of Service</a></nav>
  </div>
</footer>
</body>
</html>`
  writeFileSync(join(OUT, `${testCase.name}.html`), html, 'utf8')
}

// One index that shows every case at every width, so a single screenshot proves
// the whole matrix rather than ten separate looks.
const frames = CASES.map(
  (c) => `<section class="grp"><h2>${c.name}</h2><div class="row">${WIDTHS.map(
    (w) => `<figure style="width:${w}px"><figcaption>${w}px</figcaption>
      <iframe src="./${c.name}.html" width="${w}" height="1400" loading="lazy"></iframe></figure>`
  ).join('')}</div></section>`
).join('\n')

writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>Deposit page matrix</title>
<style>
body{font:14px system-ui;background:#111;color:#eee;margin:0;padding:20px}
h2{font:600 13px ui-monospace;color:#FF5A1F;margin:26px 0 8px}
.row{display:flex;gap:16px;overflow-x:auto;padding-bottom:10px;align-items:flex-start}
figure{margin:0;flex:0 0 auto}
figcaption{font:11px ui-monospace;color:#888;margin-bottom:4px}
iframe{border:1px solid #333;background:#fff;display:block}
</style></head><body><h1>Deposit page — every case, every width</h1>${frames}</body></html>`,
  'utf8'
)

console.log(`Wrote ${CASES.length} cases to ${OUT}`)
console.log(`Open: ${join(OUT, 'index.html')}`)
