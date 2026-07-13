'use client'

// Shared client helpers for admin-OS forms (owner spec 2026-07-13).

/** Reads the double-submit CSRF cookie the middleware sets and echoes it as the
 *  X-CSRF-Token header every state-mutating /api call requires. */
export function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {}
  const t = document.cookie.split('; ').find((c) => c.startsWith('moveit_csrf='))?.split('=')[1]
  return t ? { 'X-CSRF-Token': decodeURIComponent(t) } : {}
}

/** Upload a receipt/photo to the existing /api/files/upload endpoint. Returns
 *  the Cloudinary URL + publicId, or throws with a readable message. */
export async function uploadReceipt(file: File, bookingId?: string): Promise<{ url: string; publicId: string }> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('type', 'RECEIPT')
  if (bookingId) fd.append('bookingId', bookingId)
  const res = await fetch('/api/files/upload', { method: 'POST', headers: { ...csrfHeader() }, body: fd })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error ?? 'Receipt upload failed')
  }
  const d = await res.json()
  return { url: d.url, publicId: d.publicId }
}
