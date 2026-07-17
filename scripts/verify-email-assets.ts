// Verifies every URL in email-assets/manifest.json is live: HTTP 200, image MIME,
// HTTPS, no auth/redirect-to-error. Exit 1 if any asset is unavailable.
//   npx tsx scripts/verify-email-assets.ts
import { readFileSync } from 'fs'
import { resolve } from 'path'

type Entry = { file: string; width: number; height: number; url: string; alt: string }

async function head(url: string): Promise<{ ok: boolean; code: number; type: string; https: boolean; redirected: boolean }> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' })
    return {
      ok: res.ok,
      code: res.status,
      type: res.headers.get('content-type') || '',
      https: new URL(res.url).protocol === 'https:',
      redirected: res.redirected && !/\/email\//.test(res.url),
    }
  } catch (e) {
    return { ok: false, code: 0, type: String(e instanceof Error ? e.message : e), https: false, redirected: false }
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(resolve('email-assets/manifest.json'), 'utf8')) as { assets: Entry[] }
  let bad = 0
  const sample: string[] = []
  for (const a of manifest.assets) {
    const r = await head(a.url)
    const good = r.ok && r.code === 200 && r.type.startsWith('image/') && r.https && !r.redirected
    if (!good) {
      bad++
      sample.push(`  FAIL ${a.url} -> ${r.code} ${r.type}${r.redirected ? ' (redirected)' : ''}${r.https ? '' : ' (not https)'}`)
    }
  }
  console.log(`Checked ${manifest.assets.length} asset URLs — ${manifest.assets.length - bad} OK, ${bad} failing.`)
  if (bad) { console.error(sample.slice(0, 20).join('\n')); process.exit(1) }
  console.log('All email asset URLs return 200 image/* over HTTPS with no error redirect.')
}
main().catch((e) => { console.error(e); process.exit(1) })
