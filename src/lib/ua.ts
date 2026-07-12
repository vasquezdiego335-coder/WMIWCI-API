// Tiny, dependency-free user-agent parser. Turns the raw userAgent string we
// already store on each booking into human-readable Browser / OS / Device labels
// for the admin dashboard. Best-effort — unknown UAs return '—'.

export type ParsedUA = { browser: string; os: string; device: string }

export function parseUserAgent(ua?: string | null): ParsedUA {
  if (!ua) return { browser: '—', os: '—', device: '—' }

  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /SamsungBrowser/.test(ua) ? 'Samsung Internet' :
    /Chrome\//.test(ua) && !/Chromium/.test(ua) ? 'Chrome' :
    /CriOS/.test(ua) ? 'Chrome (iOS)' :
    /FxiOS|Firefox/.test(ua) ? 'Firefox' :
    /Version\/.*Safari/.test(ua) ? 'Safari' :
    'Other'

  const os =
    /Windows NT 10/.test(ua) ? 'Windows 10/11' :
    /Windows/.test(ua) ? 'Windows' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Android/.test(ua) ? 'Android' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /Linux/.test(ua) ? 'Linux' :
    '—'

  const device =
    /iPad/.test(ua) ? 'Tablet (iPad)' :
    /iPhone/.test(ua) ? 'Phone (iPhone)' :
    /Android/.test(ua) && /Mobile/.test(ua) ? 'Phone (Android)' :
    /Android/.test(ua) ? 'Tablet (Android)' :
    /Mobile/.test(ua) ? 'Phone' :
    'Desktop'

  return { browser, os, device }
}
