// ════════════════════════════════════════════════════════════════════════
//  BOUNCE CLASSIFICATION — pure, shared by the webhook and the health checks
//  ---------------------------------------------------------------------
//  Only a HARD (permanent) bounce may suppress an address. A soft bounce — a
//  full mailbox, a message too large, a transient "550 4.4.7 Message expired" —
//  says nothing about whether the address exists, and suppressing it would
//  silently stop mailing a real customer.
// ════════════════════════════════════════════════════════════════════════

export type BounceInfo = { type?: string; subType?: string }

/** Is this bounce permanent? Only permanent bounces suppress. */
export function isHardBounce(bounce: BounceInfo | undefined): boolean {
  const type = (bounce?.type ?? '').toLowerCase()
  const sub = (bounce?.subType ?? '').toLowerCase()
  if (sub === 'mailboxfull' || sub === 'messagetoolarge' || sub === 'contentrejected' || sub === 'attachmentrejected') {
    return false
  }
  // When the provider states a type it is authoritative: only 'Permanent' is
  // hard. Transient / Soft / Undetermined / anything unknown is NOT — we would
  // rather keep mailing a questionable address than silently drop a paying
  // customer on ambiguous provider data. ('General' exists under BOTH
  // Permanent and Transient, so it never decides on its own when a type is
  // present.)
  if (type) return type === 'permanent'
  // No type at all: only a sub-type that exists solely for dead addresses.
  return sub === 'general' || sub === 'nosuchuser' || sub === 'noemail' || sub === 'suppressed' || sub === 'onaccountsuppressionlist'
}

/**
 * Does this bounce POSITIVELY read as soft? False when the data is missing or
 * unreadable (a truncated detail) — callers that must not hide a hard bounce
 * treat "unknown" as possibly hard.
 */
export function isKnownSoftBounce(bounce: BounceInfo | undefined): boolean {
  if (!bounce) return false
  const sub = (bounce.subType ?? '').toLowerCase()
  const softSub = sub === 'mailboxfull' || sub === 'messagetoolarge' || sub === 'contentrejected' || sub === 'attachmentrejected'
  return (Boolean(bounce.type) || softSub) && !isHardBounce(bounce)
}

/**
 * Recover `{ type, subType }` from a stored EmailEvent.detail — the JSON of the
 * provider's `data` object, TRUNCATED to 1000 characters at write time, so it
 * may not parse. Falls back to reading the two fields out of the text.
 */
export function bounceFromEventDetail(detail: string | null | undefined): BounceInfo | undefined {
  if (!detail) return undefined
  try {
    const parsed = JSON.parse(detail) as { bounce?: BounceInfo } | null
    if (parsed && typeof parsed === 'object' && parsed.bounce && typeof parsed.bounce === 'object') return parsed.bounce
  } catch {
    // truncated — fall through to the text scan
  }
  const idx = detail.indexOf('"bounce"')
  if (idx === -1) return undefined
  const tail = detail.slice(idx)
  const type = /"type"\s*:\s*"([^"]*)"/.exec(tail)?.[1]
  const subType = /"subType"\s*:\s*"([^"]*)"/.exec(tail)?.[1]
  if (type === undefined && subType === undefined) return undefined
  return { ...(type !== undefined ? { type } : {}), ...(subType !== undefined ? { subType } : {}) }
}
