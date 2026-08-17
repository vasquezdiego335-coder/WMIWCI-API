import type { MetadataRoute } from 'next'

// ════════════════════════════════════════════════════════════════════════════
//  robots.txt for the APP host (admin + customer portal + deposit links).
//  ------------------------------------------------------------------------
//  There was no robots.txt here at all, which meant a 404 and "assume allowed"
//  for every crawler including the admin surface.
//
//  THE IMPORTANT PART IS WHAT IS *NOT* BLOCKED. Facebook/Messenger, Discord and
//  WhatsApp preview crawlers DO honour robots.txt, and a `Disallow: /deposit`
//  would silently kill every link preview — the exact failure this feature is
//  supposed to fix. Deposit pages are kept out of search with a `noindex,
//  nofollow, noarchive` META tag instead, which unfurl crawlers ignore. The two
//  mechanisms are not interchangeable, and using the wrong one is how a working
//  card turns into a grey box.
// ════════════════════════════════════════════════════════════════════════════

export default function robots(): MetadataRoute.Robots {
  // No `host` directive on purpose. This file is generated at BUILD time, so a
  // host baked from the build environment can be quietly wrong in production —
  // and `Host:` is a Yandex-only directive that buys nothing here. The rules
  // below depend on no environment variable, so they are correct everywhere.
  return {
    rules: [
      {
        userAgent: '*',
        // Private surfaces. /deposit is deliberately absent from this list.
        disallow: ['/admin', '/api', '/crew', '/my-booking'],
        allow: '/deposit',
      },
    ],
  }
}
