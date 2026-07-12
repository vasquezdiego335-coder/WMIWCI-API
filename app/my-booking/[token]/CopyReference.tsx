'use client'

import { useState } from 'react'

// Small, accessible copy-to-clipboard control for the booking reference.
// Client-only (needs navigator.clipboard) — the rest of the page stays a
// server component. No library; graceful if the clipboard API is unavailable.
export function CopyReference({ reference }: { reference: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(reference)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1700)
    } catch {
      // Clipboard blocked (old browser / insecure context) — leave state as-is.
    }
  }

  return (
    <button
      type="button"
      className={`bk-ref__btn${copied ? ' is-copied' : ''}`}
      onClick={copy}
      aria-label={copied ? `Booking reference ${reference} copied to clipboard` : `Copy booking reference ${reference}`}
    >
      <span className="bk-ref__code">{reference}</span>
      <span className="bk-ref__ic" aria-hidden="true">
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </span>
      <span className="bk-ref__hint" aria-hidden="true">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}
