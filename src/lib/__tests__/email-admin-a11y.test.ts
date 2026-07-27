import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

// ════════════════════════════════════════════════════════════════════════
//  ADMIN EMAIL-MARKETING ACCESSIBILITY (audit pass F, 2026-07-27)
//
//  These are STATIC checks over the real components. They cannot replace a
//  browser — contrast as rendered, focus order and screen-reader output all
//  need one — but they do pin the defects that were actually found, so a
//  future edit cannot quietly reintroduce them.
//
//  Contrast values below were computed against #FFFFFF using the WCAG 2.1
//  relative-luminance formula, at the sizes these colours are ACTUALLY used
//  (10-12px), where the AA threshold is 4.5:1 rather than 3:1.
// ════════════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '..', '..', '..')
const ADMIN = join(ROOT, 'app/(admin)/admin/(dashboard)/email-marketing')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out
}
const pages = walk(ADMIN)

// ── Contrast maths (so the numbers are checked, not asserted) ────────────

const luminance = (hex: string): number => {
  const v = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(v.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('the contrast helper agrees with known WCAG values', () => {
  // Sanity-check the maths before trusting it to judge the palette.
  assert.ok(Math.abs(ratio('#000000', '#FFFFFF') - 21) < 0.1, 'black on white is 21:1')
  assert.ok(Math.abs(ratio('#FFFFFF', '#FFFFFF') - 1) < 0.01, 'white on white is 1:1')
})

test('F-10 every status/text colour meets AA at the sizes actually used', () => {
  // The originals and what they scored: amber #F59E0B 2.1:1, green #10B981
  // 2.2:1, faint #9CA3AF 2.6:1, red #EF4444 3.7:1 — all used for 10-12px text.
  const composer = read('app/(admin)/admin/(dashboard)/email-marketing/campaigns/CampaignComposer.tsx')
  const palette = /const C = \{([\s\S]*?)\n\}/.exec(composer)?.[1] ?? ''
  const colours = Array.from(palette.matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)).map((m) => ({ name: m[1], hex: m[2] }))
  assert.ok(colours.length >= 6, `expected the palette to parse, got ${colours.length}`)

  const failures: string[] = []
  for (const { name, hex } of colours) {
    if (name === 'line') continue // borders are non-text; 3:1 applies, not 4.5:1
    const r = ratio(hex, '#FFFFFF')
    if (r < 4.5) failures.push(`${name} ${hex} = ${r.toFixed(2)}:1`)
  }
  assert.deepEqual(failures, [], `these fail WCAG AA (4.5:1) on white:\n  ${failures.join('\n  ')}`)
})

test('F-10 white-on-badge status colours meet AA', () => {
  const composer = read('app/(admin)/admin/(dashboard)/email-marketing/campaigns/CampaignComposer.tsx')
  const block = /const STATE_COLOR[\s\S]*?\n\}/.exec(composer)?.[0] ?? ''
  const literals = Array.from(block.matchAll(/'(#[0-9A-Fa-f]{6})'/g)).map((m) => m[1])
  for (const hex of literals) {
    const r = ratio('#FFFFFF', hex)
    assert.ok(r >= 4.5, `badge background ${hex} gives ${r.toFixed(2)}:1 against white badge text (needs 4.5:1 at 10px)`)
  }
})

// ── Form labelling ──────────────────────────────────────────────────────

test('F-1 form fields use a real <label htmlFor>, not a paragraph', () => {
  // THE DEFECT: the label was a <p>. Screen readers announced every field in
  // the campaign composer as unnamed, and clicking the text did not focus the
  // input. A paragraph beside an input is not a label.
  const composer = read('app/(admin)/admin/(dashboard)/email-marketing/campaigns/CampaignComposer.tsx')
  assert.match(composer, /<label htmlFor=\{id\} style=\{fieldLabel\}>/, 'fields must use an associated <label>')
  assert.ok(!/<p style=\{fieldLabel\}>/.test(composer), 'no field label may still be a paragraph')
  assert.match(composer, /<input\s+id=\{id\}/, 'the input must carry the id the label points at')
  assert.match(composer, /<select id=\{id\}/, 'and so must the select')
})

test('F-1 field ids come from useId — a counter breaks SSR hydration', () => {
  // A module-level counter produces different ids on the server and the client,
  // so React reports a hydration mismatch and the rendered `for` can end up
  // pointing at nothing — an accessibility fix that silently un-fixes itself.
  const composer = read('app/(admin)/admin/(dashboard)/email-marketing/campaigns/CampaignComposer.tsx')
  assert.match(composer, /const id = useId\(\)/, 'ids must come from React.useId()')
  assert.ok(!/let fieldSeq/.test(composer), 'a module-level id counter is not SSR-safe')
})

// ── Announcements ───────────────────────────────────────────────────────

test('F-5 server refusals are announced, from an always-mounted live region', () => {
  // Every server refusal lands in this list — approval refused, dispatch
  // blocked, recipients withheld from a retry. Rendered silently, a
  // screen-reader user clicks a button and is told nothing about why it failed.
  const composer = read('app/(admin)/admin/(dashboard)/email-marketing/campaigns/CampaignComposer.tsx')
  assert.match(composer, /role="alert"/, 'errors must be in an alert region')
  assert.match(composer, /aria-live="assertive"/, 'and announced immediately — they follow a deliberate action')
  // The region must exist BEFORE the text arrives; announcing from a node that
  // mounts at the same moment is unreliable across screen readers.
  const region = composer.indexOf('role="alert"')
  const condition = composer.indexOf('{errors.length > 0 && (')
  assert.ok(region > 0 && region < condition, 'the live region must wrap the condition, not sit inside it')
})

// ── Structure and navigation ────────────────────────────────────────────

test('F-11 no page jumps from h1 to h3', () => {
  // PageHeader renders <h1>. Section headings must be <h2>; skipping a level
  // breaks the outline screen-reader users navigate by.
  const offenders = pages.filter((p) => /<h3[\s>]/.test(readFileSync(p, 'utf8')))
  assert.deepEqual(offenders.map((p) => p.replace(ROOT, '')), [], 'these skip a heading level')
})

test('F-9 the current tab is exposed, not just coloured', () => {
  const shared = read('app/(admin)/admin/(dashboard)/email-marketing/_shared.tsx')
  assert.match(shared, /aria-current=\{on \? 'page' : undefined\}/, 'the active tab must set aria-current')
  assert.match(shared, /aria-label="Email marketing sections"/, 'and the nav must be named')
})

test('F-7 wide tables scroll, are keyboard reachable, and are named', () => {
  const ui = read('app/(admin)/admin/(dashboard)/_ui.tsx')
  assert.match(ui, /overflowX: 'auto'/, 'wide tables must scroll rather than break the page')
  // minWidth is what makes it SCROLL instead of crushing columns to nothing.
  assert.match(ui, /minWidth: '760px'/, 'without a min width the columns just crush')
  // A scrollable region is unusable for keyboard-only users without a tabindex.
  assert.match(ui, /tabIndex: 0/, 'the scroll container must be focusable (WCAG 2.1.1)')
  assert.match(ui, /role: 'region'/, 'and announced as a region')
  const page = read('app/(admin)/admin/(dashboard)/email-marketing/campaigns/page.tsx')
  assert.match(page, /tableScrollProps\('Campaign performance table'\)/, 'the campaigns table must use it')
})

// ── Touch targets ───────────────────────────────────────────────────────

test('F-6 action buttons meet the WCAG 2.2 target size', () => {
  // Six of these sit shoulder-to-shoulder on every run card. At 5px padding on
  // an 11px font they were roughly 24px tall — the bare floor, on a control
  // whose neighbours include CANCELLED and FAILED.
  const composer = read('app/(admin)/admin/(dashboard)/email-marketing/campaigns/CampaignComposer.tsx')
  const min = /minHeight: '(\d+)px'/.exec(composer)
  assert.ok(min, 'action buttons must declare a minimum height')
  assert.ok(Number(min![1]) >= 32, `minimum height is ${min![1]}px; needs >= 32px for comfortable tapping`)
  assert.match(composer, /minWidth: '44px'/, 'and a minimum width so icon-width labels stay tappable')
})

// ── Destructive actions ─────────────────────────────────────────────────

test('destructive and irreversible actions confirm, and say what cannot be undone', () => {
  const composer = read('app/(admin)/admin/(dashboard)/email-marketing/campaigns/CampaignComposer.tsx')
  assert.match(composer, /THIS CANNOT BE UNDONE/, 'sending must state irreversibility')
  assert.match(composer, /cannot be recalled/, 'and that accepted mail cannot be pulled back')
  assert.match(composer, /Reason for marking this campaign/, 'cancelling/failing must require a reason')
})

test('every emoji used as an icon sits beside real text, never alone', () => {
  // An emoji alone in a control is announced as its unicode name, or not at
  // all. Each must be accompanied by a text label.
  const bad: string[] = []
  for (const p of pages) {
    const src = readFileSync(p, 'utf8')
    // A button whose entire content is a single non-alphanumeric glyph.
    for (const m of Array.from(src.matchAll(/<button[^>]*>\s*([^\w\s<][^\w<]{0,2})\s*<\/button>/g))) {
      bad.push(`${p.replace(ROOT, '')}: ${m[1]}`)
    }
  }
  assert.deepEqual(bad, [], 'icon-only buttons need an accessible name')
})
