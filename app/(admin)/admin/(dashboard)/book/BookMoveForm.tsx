'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { csrfHeader } from '../_client'
import { MOVE_SIZES } from '@/lib/estimate'
import { checkServiceArea } from '@/lib/service-area'
import {
  DEPOSIT_MODES,
  PROPERTY_TYPES,
  SERVICE_MODES,
  SERVICE_MODE_LABELS,
  type DepositMode,
  type ServiceMode,
} from '@/lib/admin-booking'
// The SERVER's wording for every scan ending, imported rather than retyped.
// scan-lock.ts is a pure module with no imports of its own (DB-free by design),
// so a client island can carry it. See SCAN_KICK_FALLBACKS below for why this
// is not a style preference.
import { SCAN_KICK_MESSAGES } from '@/lib/scan-lock'

// ════════════════════════════════════════════════════════════════════════
//  BookMoveForm — the Book Move client island (Moving OS Phase 1).
//  One screen, top to bottom, no wizard. Server routes own every decision;
//  this island only collects inputs, shows the live recommendation (with the
//  WHY), and renders the cascade the server reports back. Client-side price
//  math here is DISPLAY ONLY (the same pure libs the server uses) — the POST
//  recomputes everything server-side and never trusts these numbers.
// ════════════════════════════════════════════════════════════════════════

export type BookPrefill = {
  leadId?: string
  /** An existing Customer matched from the lead's email. Prefilled so
   *  converting a repeat customer's lead updates their record instead of
   *  creating a second one (correctness pass item 3). */
  customerId?: string
  customerBookings?: number
  /** That customer's STORED email language (R2-7.1). Without it the language
   *  select showed English for a Spanish-speaking repeat customer, and the
   *  booking wrote that English back over their real preference. */
  customerLocale?: string
  name?: string
  email?: string
  phone?: string
  moveDate?: string
  serviceType?: string
  originZip?: string
  originCity?: string
  destZip?: string
  destCity?: string
  notes?: string
}

type Recommendation = {
  jobSizeLabel: string
  crewSize: number
  truckSize: string | null
  estimatedHoursMin: number
  estimatedHoursMax: number
  possibleTrips: number
  difficulty: string
  reasons: string[]
}
type Quote = { estimatedTotal: number; base: number; accessAddons: number; travel: number; hasService: boolean }
type CatalogItem = { id: string; name: string; category: string; isHeavy: boolean; needsDisassembly: boolean; recommendedMovers: number | null }
type TruckOpt = {
  id: string
  name: string
  size: string
  status: string
  active: boolean
  busy: boolean
  /** R2-2: how many of that day's assignments are unpaid/unapproved HOLDS
   *  rather than confirmed jobs — the same distinction the create's 409 makes. */
  pendingHolds?: number
  bookings: Array<{ displayId: string; status: string; customerName?: string; hold?: 'confirmed' | 'pending' }>
}
type CustomerHit = { id: string; name: string; email: string | null; phone: string | null; locale: string; bookings: number }
type InvLine = {
  key: string
  catalogItemId?: string
  name: string
  quantity: number
  isHeavy?: boolean
  needsDisassembly?: boolean
  recommendedMovers?: number | null
  notes?: string
}
type SuccessPayload = {
  bookingId: string
  bookingReference: string
  status: string
  jobId: string | null
  portalUrl: string
  stripeUrl: string | null
  leadConverted: boolean
  warnings: string[]
  /** Item 2 — what the server actually scheduled. */
  scheduling?: 'timed' | 'day_level'
  crewStartTime?: string | null
  scheduledStart?: string | null
  /** Item 3 — which customer record this booking landed on. */
  customerId?: string
  customerMode?: 'use' | 'update' | 'create'
  /** Item 7 — what the Action Center kick ACTUALLY did. Absent (an older
   *  response) means "not reported", which the panel says nothing about
   *  rather than claiming a scan ran. */
  actionCenterScan?: 'completed' | 'skipped_cooldown' | 'failed'
  actionCenterScanReason?: string
  actionCenterScanMessage?: string
}

/** Wording for a response that reports a scan ending but carries no message —
 *  version skew (a new client bundle answered by an older server), since
 *  today's route always sends all three fields.
 *
 *  P0-B — WHY THIS IS A MAP AND NOT FOUR STRING LITERALS. Round 3 deleted the
 *  sentence "Action Center rescanned — this booking is included" from the
 *  server copy because it claims coverage the code cannot prove; the client
 *  kept its own hand-typed copy of it, UNCONDITIONAL, under a branch
 *  (`actionCenterScan === 'completed'`) that covers BOTH server endings — so
 *  it printed a coverage claim for exactly the ending where the server
 *  deliberately says "this booking may not be on the list". Every fallback now
 *  comes from the same constants the server maps its endings onto, so no copy
 *  of the copy exists to drift again.
 *
 *  `SCAN_KICK_MESSAGES.ran_included` is deliberately ABSENT and must stay
 *  absent: coverage depends on the COMMITTED status and on the loader's own
 *  `isInternalTest` filter (scan-lock.scanCoversBooking), which only the server
 *  can evaluate. Re-deriving that predicate here would be the same drift in a
 *  new place. `ran` is the claimless wording for a scan that ran, and an
 *  ending this build does not recognize falls through to `failed`, which
 *  promises nothing at all. */
const SCAN_KICK_FALLBACKS: Record<string, string> = {
  ran: SCAN_KICK_MESSAGES.ran,
  cooldown: SCAN_KICK_MESSAGES.cooldown,
  already_running: SCAN_KICK_MESSAGES.already_running,
  timeout: SCAN_KICK_MESSAGES.timeout,
}

const DIFFICULTY_COLORS: Record<string, string> = { standard: '#10B981', elevated: '#F59E0B', high: '#EF4444' }
const DEPOSIT_LABELS: Record<DepositMode, [string, string]> = {
  stripe_link: ['$49 hold link', 'Creates the Stripe hold link for YOU to send (text or email it yourself — nothing is sent automatically).'],
  collect_on_day: ['Collect on move day', 'Book now as CONFIRMED; the deposit is a move-day matter.'],
  waived: ['Waived', 'Owner decision — recorded in the audit log.'],
}

/** ISO instant → "8:00 AM" in America/New_York (the only timezone this business
 *  schedules in). Null in, null out — a day-level booking has no time to show. */
function formatEtTime(iso?: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d)
}

const num = (s: string): number | undefined => {
  if (s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}
let keyCounter = 0
const nextKey = () => `line-${++keyCounter}`

export default function BookMoveForm({ prefill }: { prefill?: BookPrefill }) {
  // ── Customer ──
  const [custSearch, setCustSearch] = useState('')
  const [custHits, setCustHits] = useState<CustomerHit[]>([])
  // The PICKED customer record. While this is set, the POST updates that exact
  // CRM row (correctness pass item 3) instead of matching on the typed email —
  // which is what used to create a second record for a repeat customer.
  const [customerId, setCustomerId] = useState(prefill?.customerId ?? '')
  const [linkedLabel, setLinkedLabel] = useState(
    prefill?.customerId
      ? `${prefill.name ?? 'Existing customer'}${typeof prefill.customerBookings === 'number' ? ` · ${prefill.customerBookings} booking${prefill.customerBookings === 1 ? '' : 's'}` : ''}`
      : '',
  )
  const [name, setName] = useState(prefill?.name ?? '')
  const [email, setEmail] = useState(prefill?.email ?? '')
  const [phone, setPhone] = useState(prefill?.phone ?? '')
  // The customer's email language. Two pieces of state, deliberately (R2-7.1):
  // `locale` is what the select SHOWS (seeded from the linked customer's stored
  // value so the owner sees the truth), and `localeTouched` records whether the
  // owner actually chose it. Only a touched value is submitted — an untouched
  // select must never write 'en' over a Spanish speaker's preference just
  // because English is what a fresh form shows.
  const [locale, setLocale] = useState<'en' | 'es'>(prefill?.customerLocale === 'es' ? 'es' : 'en')
  const [localeTouched, setLocaleTouched] = useState(false)

  // ── Move details ──
  const [serviceType, setServiceType] = useState(prefill?.serviceType || '2br')
  const [moveDate, setMoveDate] = useState(prefill?.moveDate ?? '')
  // The REAL crew start time (ET). Blank is a first-class answer: the booking
  // is then scheduled at day level and nothing invents an hour (item 2).
  const [startTime, setStartTime] = useState('')
  const [arrivalWindow, setArrivalWindow] = useState('')
  const [oStreet, setOStreet] = useState('')
  const [oCity, setOCity] = useState(prefill?.originCity ?? '')
  const [oState, setOState] = useState('NJ')
  const [oZip, setOZip] = useState(prefill?.originZip ?? '')
  const [oProp, setOProp] = useState('')
  const [dStreet, setDStreet] = useState('')
  const [dCity, setDCity] = useState(prefill?.destCity ?? '')
  const [dState, setDState] = useState('NJ')
  const [dZip, setDZip] = useState(prefill?.destZip ?? '')
  const [dProp, setDProp] = useState('')
  const [stops, setStops] = useState('')

  // ── Access ──
  const [oFloor, setOFloor] = useState('')
  const [dFloor, setDFloor] = useState('')
  const [oStairs, setOStairs] = useState('')
  const [dStairs, setDStairs] = useState('')
  const [oElev, setOElev] = useState(false)
  const [dElev, setDElev] = useState(false)
  const [longCarry, setLongCarry] = useState(false)
  const [coi, setCoi] = useState(false)
  const [accessNotes, setAccessNotes] = useState('')

  // ── Services ──
  const [mode, setMode] = useState<ServiceMode>('full_service')
  const [packing, setPacking] = useState(false)
  const [unpacking, setUnpacking] = useState(false)
  const [assembly, setAssembly] = useState(false)
  const [disassembly, setDisassembly] = useState(false)

  // ── Inventory ──
  const [inv, setInv] = useState<InvLine[]>([])
  const [catQ, setCatQ] = useState('')
  const [catHits, setCatHits] = useState<CatalogItem[]>([])
  const [catalogMissing, setCatalogMissing] = useState(false)
  const [customName, setCustomName] = useState('')

  // ── Recommendation ──
  const [rec, setRec] = useState<Recommendation | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [recBusy, setRecBusy] = useState(false)
  const recTick = useRef(0)

  // ── Truck ──
  const [trucks, setTrucks] = useState<TruckOpt[]>([])
  const [trucksMissing, setTrucksMissing] = useState(false)
  const [truckId, setTruckId] = useState('')
  const [truckOverride, setTruckOverride] = useState(false)

  // ── Price + deposit ──
  const [ownerTotal, setOwnerTotal] = useState('')
  const [priceReason, setPriceReason] = useState('')
  const [deposit, setDeposit] = useState<DepositMode>('stripe_link')

  // ── Extra notes ──
  const [notes, setNotes] = useState(prefill?.notes ?? '')
  const [crewInstructions, setCrewInstructions] = useState('')

  // ── Submit ──
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflictInfo, setConflictInfo] = useState('')
  const [success, setSuccess] = useState<SuccessPayload | null>(null)

  // ── Customer search-as-you-type (debounced) ──
  useEffect(() => {
    if (custSearch.trim().length < 2) {
      setCustHits([])
      return
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/customers/search?q=${encodeURIComponent(custSearch.trim())}`)
        if (res.ok) setCustHits((await res.json()).customers ?? [])
      } catch {
        /* search is a convenience — never an error state */
      }
    }, 300)
    return () => clearTimeout(t)
  }, [custSearch])

  // ── Catalog search (debounced) ──
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/inventory/catalog?q=${encodeURIComponent(catQ.trim())}`)
        if (res.ok) {
          const d = await res.json()
          setCatHits(d.items ?? [])
          setCatalogMissing(!!d.migrationMissing)
        }
      } catch {
        /* degrade to custom entry */
      }
    }, 300)
    return () => clearTimeout(t)
  }, [catQ])

  // ── Trucks for the picked date ──
  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(moveDate)) {
      setTrucks([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/admin/trucks?date=${moveDate}`)
        if (res.ok && !cancelled) {
          const d = await res.json()
          setTrucks(d.trucks ?? [])
          setTrucksMissing(!!d.migrationMissing)
        }
      } catch {
        /* truck select degrades to none */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [moveDate])

  // ── Live recommendation (debounced on every relevant input) ──
  const recommendBody = useMemo(
    () =>
      JSON.stringify({
        serviceType,
        inventory: inv.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          isHeavy: i.isHeavy ?? false,
          needsDisassembly: i.needsDisassembly ?? false,
          recommendedMovers: i.recommendedMovers ?? null,
        })),
        originStairFlights: num(oStairs) ?? null,
        destStairFlights: num(dStairs) ?? null,
        originHasElevator: oElev,
        destHasElevator: dElev,
        longCarry,
        needsPacking: packing,
        needsAssembly: assembly,
        needsDisassembly: disassembly,
        additionalStops: num(stops) ?? null,
      }),
    [serviceType, inv, oStairs, dStairs, oElev, dElev, longCarry, packing, assembly, disassembly, stops],
  )

  async function refreshRecommendation(body: string) {
    const tick = ++recTick.current
    setRecBusy(true)
    try {
      const res = await fetch('/api/admin/estimate/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body,
      })
      if (res.ok && tick === recTick.current) {
        const d = await res.json()
        setRec(d.recommendation ?? null)
        setQuote(d.quote ?? null)
      }
    } catch {
      /* advisory only */
    } finally {
      if (tick === recTick.current) setRecBusy(false)
    }
  }

  useEffect(() => {
    const t = setTimeout(() => void refreshRecommendation(recommendBody), 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendBody])

  // ── Display-only travel (same pure lib the server uses) ──
  const clientSA = useMemo(() => {
    if (!/^\d{5}$/.test(oZip) || !/^\d{5}$/.test(dZip)) return null
    try {
      return checkServiceArea([{ zip: oZip, city: oCity, state: oState }], { zip: dZip, city: dCity, state: dState })
    } catch {
      return null
    }
  }, [oZip, dZip, oCity, dCity, oState, dState])

  const travelDollars = clientSA?.travelFeeCents ? clientSA.travelFeeCents / 100 : 0
  const recommendedTotal = quote && quote.hasService ? Math.round((quote.estimatedTotal + travelDollars) * 100) / 100 : null
  const ownerNum = num(ownerTotal)
  const priceDiffers = recommendedTotal != null && ownerNum != null && Math.abs(ownerNum - recommendedTotal) > 1

  const selectedTruck = trucks.find((t) => t.id === truckId)
  const truckBusy = !!selectedTruck?.busy

  function pickCustomer(c: CustomerHit) {
    // The id is the whole point: the booking now updates THIS record, so a
    // corrected email or a newly added phone never forks their history.
    setCustomerId(c.id)
    setLinkedLabel(`${c.name} · ${c.bookings} booking${c.bookings === 1 ? '' : 's'}`)
    setName(c.name)
    setEmail(c.email ?? '')
    setPhone(c.phone ?? '')
    // Show THEIR language; picking a customer is not the owner choosing one,
    // so this does not mark the field touched (R2-7.1).
    setLocale(c.locale === 'es' ? 'es' : 'en')
    setLocaleTouched(false)
    setCustHits([])
    setCustSearch('')
  }

  function unlinkCustomer() {
    setCustomerId('')
    setLinkedLabel('')
  }

  function addCatalogItem(item: CatalogItem) {
    setInv((prev) => {
      const existing = prev.find((l) => l.catalogItemId === item.id)
      if (existing) {
        return prev.map((l) => (l.catalogItemId === item.id ? { ...l, quantity: Math.min(99, l.quantity + 1) } : l))
      }
      return [
        ...prev,
        {
          key: nextKey(),
          catalogItemId: item.id,
          name: item.name,
          quantity: 1,
          isHeavy: item.isHeavy,
          needsDisassembly: item.needsDisassembly,
          recommendedMovers: item.recommendedMovers,
        },
      ]
    })
  }

  function addCustomItem() {
    const n = customName.trim()
    if (!n) return
    setInv((prev) => [...prev, { key: nextKey(), name: n, quantity: 1 }])
    setCustomName('')
  }

  function setQty(key: string, delta: number) {
    setInv((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity >= 1),
    )
  }

  async function submit() {
    setError('')
    setConflictInfo('')
    // Client-side guardrails (the server re-validates everything).
    if (!name.trim()) return setError('Customer name is required.')
    if (!email.trim() && !phone.trim()) return setError('Provide an email or a phone number.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(moveDate)) return setError('Pick a move date.')
    if (!oStreet.trim() || !oCity.trim() || !/^\d{5}$/.test(oZip)) return setError('Complete the pickup address (street, city, 5-digit ZIP).')
    if (!dStreet.trim() || !dCity.trim() || !/^\d{5}$/.test(dZip)) return setError('Complete the destination address (street, city, 5-digit ZIP).')
    if (ownerNum == null || ownerNum <= 0) return setError('Set the owner price.')
    if (priceDiffers && !priceReason.trim()) return setError('The price differs from the recommendation — write the reason.')

    setBusy(true)
    try {
      const body = {
        customer: {
          id: customerId || undefined,
          name: name.trim(),
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          // Sent ONLY when the owner actually chose a language (R2-7.1) — the
          // same "never blank / never overwrite what we were not told" rule the
          // email and phone fields follow. Omitted means "no language stated":
          // an existing customer keeps theirs, a new one is created 'en'.
          locale: localeTouched ? locale : undefined,
        },
        move: {
          serviceType,
          moveDate,
          startTime: startTime || undefined,
          arrivalWindow: arrivalWindow.trim() || undefined,
          originAddress: { street: oStreet.trim(), city: oCity.trim(), state: oState.trim() || 'NJ', zip: oZip },
          destAddress: { street: dStreet.trim(), city: dCity.trim(), state: dState.trim() || 'NJ', zip: dZip },
          originPropertyType: oProp || undefined,
          destPropertyType: dProp || undefined,
          originFloor: num(oFloor),
          destFloor: num(dFloor),
          originStairFlights: num(oStairs),
          destStairFlights: num(dStairs),
          originHasElevator: oElev,
          destHasElevator: dElev,
          longCarry,
          coiRequired: coi,
          accessNotes: accessNotes.trim() || undefined,
          additionalStopsCount: num(stops),
        },
        services: {
          serviceMode: mode,
          needsPacking: packing,
          needsUnpacking: unpacking,
          needsAssembly: assembly,
          needsDisassembly: disassembly,
        },
        inventory: inv.map((l) => ({
          catalogItemId: l.catalogItemId,
          name: l.name,
          quantity: l.quantity,
          notes: l.notes || undefined,
        })),
        truckId: truckId || undefined,
        truckConflictOverride: truckOverride,
        itemsDescription: notes.trim() || undefined,
        crewInstructions: crewInstructions.trim() || undefined,
        leadId: prefill?.leadId,
        pricing: { ownerTotal: ownerNum, overrideReason: priceReason.trim() || undefined },
        deposit: { mode: deposit },
      }
      const res = await fetch('/api/admin/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 409 && d.conflictingCustomerId) {
        // The typed email belongs to a DIFFERENT customer — the owner decides
        // (book under that customer, or clear the email). Never a silent merge.
        setError(d.error ?? 'That email already belongs to another customer.')
        return
      }
      if (res.status === 409) {
        setConflictInfo(d.error ?? 'Truck is already booked in this window.')
        return
      }
      if (!res.ok) {
        setError(d.error ?? 'Booking failed — nothing was created.')
        return
      }
      setSuccess(d as SuccessPayload)
    } finally {
      setBusy(false)
    }
  }

  // ── Success panel: the cascade, made visible ──
  if (success) {
    const cascade: string[] = [
      `Booking ${success.bookingReference} created (${success.status === 'CONFIRMED' ? 'confirmed' : 'awaiting the $49 hold'})`,
    ]
    // Item 3 — say which CRM record this landed on, so a repeat customer is
    // visibly NOT duplicated.
    if (success.customerMode === 'create') cascade.push('New customer record created')
    else if (success.customerMode === 'update') cascade.push('Existing customer record updated (no duplicate created)')
    else if (success.customerMode === 'use') cascade.push('Booked under the existing customer record (nothing to change)')
    // Item 2 — the real schedule, or the honest absence of one.
    const startLabel = formatEtTime(success.scheduledStart) ?? success.crewStartTime ?? ''
    cascade.push(
      success.scheduling === 'day_level'
        ? 'Day-level scheduling — no crew start time was set, so truck conflicts are checked by day. It stays that way through approval: nothing invents an hour later'
        : success.status === 'CONFIRMED'
          ? `Crew start time ${startLabel} ET is on the schedule`
          : `Crew start time ${startLabel} ET captured — it lands on the schedule when the $49 hold is paid`,
    )
    if (success.jobId) cascade.push('Job scheduled + staffing requirement auto-created from the recommendation')
    if (success.leadConverted) cascade.push('Lead converted to BOOKED')
    if (success.stripeUrl) cascade.push('Stripe $49 hold link created — send it to the customer yourself')
    // Item 7 / R2-6 / R3-3 / P0-B — the REAL scan outcome, in the SERVER's
    // words. Phase 1 claimed "Action Center scan kicked" no matter what
    // happened, so a silent failure read as success; round 1 then claimed a
    // SKIPPED scan meant "the list is already current", which is false for the
    // booking that just committed; round 3 removed the last coverage claim
    // from the server copy — and this panel kept a hand-typed copy of it.
    //
    // The server wording is authoritative. The fallbacks below exist only for
    // a response that somehow carries no message, they are keyed on the REAL
    // ending rather than on the coarse state (the old code answered
    // 'skipped_cooldown' with the cooldown sentence even when the true reason
    // was already_running), and they come from SCAN_KICK_FALLBACKS so no
    // literal here can drift away from the server again.
    const scanTimedOut = success.actionCenterScanReason === 'timeout'
    const scanLine =
      success.actionCenterScanMessage ??
      SCAN_KICK_FALLBACKS[success.actionCenterScanReason ?? ''] ??
      SCAN_KICK_MESSAGES.failed
    // A slow scan is not a broken one — it stays in the cascade rather than in
    // the red banner, because a red "failed" on every healthy-but-slow scan is
    // what trains an owner to ignore the red banner.
    if (success.actionCenterScan === 'completed' || success.actionCenterScan === 'skipped_cooldown' || scanTimedOut) {
      cascade.push(scanLine)
    }
    const scanFailed = success.actionCenterScan === 'failed' && !scanTimedOut
    return (
      <div style={panel}>
        <h2 style={{ fontSize: '18px', fontWeight: 800, color: '#0A1628', margin: '0 0 4px' }}>
          ✅ Move booked — {success.bookingReference}
        </h2>
        <p style={{ fontSize: '13px', color: '#6B7280', margin: '0 0 14px' }}>
          Everything below happened from that one decision. No emails were sent to the customer — the links are yours to send.
        </p>
        <ul style={{ margin: '0 0 16px', paddingLeft: '18px' }}>
          {cascade.map((c) => (
            <li key={c} style={{ fontSize: '13px', color: '#374151', padding: '2px 0' }}>{c}</li>
          ))}
        </ul>
        {success.warnings.length > 0 && (
          <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '10px', padding: '10px 12px', marginBottom: '14px' }}>
            {success.warnings.map((w) => (
              <p key={w} style={{ fontSize: '12px', color: '#B45309', margin: '2px 0' }}>⚠ {w}</p>
            ))}
          </div>
        )}
        {scanFailed && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '10px 12px', marginBottom: '14px' }}>
            <p style={{ fontSize: '12px', color: '#B91C1C', margin: '0 0 6px' }}>
              ⚠ {scanLine}
            </p>
            <p style={{ fontSize: '12px', color: '#7F1D1D', margin: '0 0 6px' }}>
              The booking itself is saved — only the alert refresh did not confirm.
            </p>
            <Link href="/admin/action-center" style={{ fontSize: '12px', fontWeight: 700, color: '#B91C1C' }}>
              Open the Action Center →
            </Link>
          </div>
        )}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <Link href={`/admin/jobs/${success.bookingId}`} style={{ ...primaryBtn, textDecoration: 'none', display: 'inline-block' }}>
            Open the job →
          </Link>
          <CopyButton label="Copy portal link" value={success.portalUrl} />
          {success.stripeUrl && <CopyButton label="Copy Stripe hold link" value={success.stripeUrl} />}
          <button type="button" style={ghostBtn} onClick={() => window.location.assign('/admin/book')}>
            Book another
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: '880px' }}>
      {/* ── Customer ── */}
      <section style={panel}>
        <h3 style={sectionTitle}>1 · Customer</h3>
        <label style={field}>
          <span style={labelCss}>Find an existing customer</span>
          <input value={custSearch} onChange={(e) => setCustSearch(e.target.value)} placeholder="Search name, email, or phone…" style={input} />
        </label>
        {custHits.length > 0 && (
          <div style={{ border: '1px solid #E5E7EB', borderRadius: '8px', margin: '6px 0 10px', overflow: 'hidden' }}>
            {custHits.map((c) => (
              <button key={c.id} type="button" onClick={() => pickCustomer(c)} style={hitRow}>
                <strong>{c.name}</strong>
                <span style={{ color: '#6B7280' }}> · {c.email ?? 'no email'} · {c.phone ?? 'no phone'} · {c.bookings} booking{c.bookings === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>
        )}
        {customerId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '8px', padding: '8px 12px', margin: '6px 0 10px' }}>
            <span style={{ fontSize: '12px', color: '#166534' }}>
              🔗 Booking under the existing customer record{linkedLabel ? ` — ${linkedLabel}` : ''}. Edits below update
              that record; a blank field never erases what is stored.
            </span>
            <button type="button" onClick={unlinkCustomer} style={{ ...ghostBtn, padding: '5px 10px', fontSize: '12px' }}>
              Unlink
            </button>
          </div>
        )}
        <div style={row}>
          <label style={{ ...field, flex: 2 }}>
            <span style={labelCss}>Name *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} style={input} maxLength={200} />
          </label>
          <label style={{ ...field, flex: 2 }}>
            <span style={labelCss}>Email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" style={input} maxLength={320} />
          </label>
          <label style={{ ...field, flex: 1 }}>
            <span style={labelCss}>Phone {email.trim() ? '' : '*'}</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} style={input} maxLength={40} />
          </label>
          <label style={field}>
            <span style={labelCss}>Language</span>
            <select
              value={locale}
              onChange={(e) => {
                setLocale(e.target.value as 'en' | 'es')
                setLocaleTouched(true)
              }}
              style={input}
            >
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
            {customerId && !localeTouched && (
              <span style={{ fontSize: '11px', color: '#6B7280' }}>
                Their saved language — left alone unless you change it here
              </span>
            )}
          </label>
        </div>
        <p style={hint}>No email? Phone is enough — the system stores a never-deliverable placeholder and will not pretend to email them.</p>
      </section>

      {/* ── Move details ── */}
      <section style={panel}>
        <h3 style={sectionTitle}>2 · Move details</h3>
        <div style={row}>
          <label style={field}>
            <span style={labelCss}>Move size *</span>
            <select value={serviceType} onChange={(e) => setServiceType(e.target.value)} style={input}>
              {Object.entries(MOVE_SIZES).map(([key, s]) => (
                <option key={key} value={key}>{s.label}{s.price > 0 ? ` — $${s.price}${s.starting ? '+' : ''}` : ''}</option>
              ))}
            </select>
          </label>
          <label style={field}>
            <span style={labelCss}>Move date *</span>
            <input type="date" value={moveDate} onChange={(e) => setMoveDate(e.target.value)} style={input} />
          </label>
          <label style={field}>
            <span style={labelCss}>Crew start time (ET)</span>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} style={{ ...input, width: '120px' }} />
          </label>
          <label style={field}>
            <span style={labelCss}>Arrival window</span>
            <input value={arrivalWindow} onChange={(e) => setArrivalWindow(e.target.value)} placeholder="8:00–10:00 AM" style={input} maxLength={60} />
          </label>
          <label style={field}>
            <span style={labelCss}>Extra stops</span>
            <input type="number" min={0} max={10} value={stops} onChange={(e) => setStops(e.target.value)} style={{ ...input, width: '70px' }} />
          </label>
        </div>
        <p style={hint}>
          {startTime
            ? 'The crew start time is what the Calendar, staffing times and truck conflicts key off — it is the time you are promising.'
            : 'No crew start time yet? Leave it blank — the booking is scheduled by DAY and no hour is invented, now or at approval. Truck conflicts stay checked by the whole day, the calendar and digest list it by date with the time as TBD, and the customer is told the time is still to be confirmed. The arrival window is free text and is never turned into a start time.'}
        </p>
        <AddressBlock
          title="Pickup" street={oStreet} city={oCity} state={oState} zip={oZip} prop={oProp}
          setStreet={setOStreet} setCity={setOCity} setState={setOState} setZip={setOZip} setProp={setOProp}
        />
        <AddressBlock
          title="Destination" street={dStreet} city={dCity} state={dState} zip={dZip} prop={dProp}
          setStreet={setDStreet} setCity={setDCity} setState={setDState} setZip={setDZip} setProp={setDProp}
        />
        {clientSA && (
          <p style={{ ...hint, color: clientSA.zone === 'primary' ? '#10B981' : clientSA.zone === 'extended_nj' ? '#B45309' : '#EF4444' }}>
            Service area: {clientSA.zone === 'primary' ? 'primary — no travel fee' : clientSA.zone === 'extended_nj' ? 'extended NJ — $50 travel fee (move day)' : `${clientSA.zone} — travel pricing is your call (recorded)`}
          </p>
        )}
      </section>

      {/* ── Access ── */}
      <section style={panel}>
        <h3 style={sectionTitle}>3 · Access</h3>
        <div style={row}>
          <label style={field}><span style={labelCss}>Pickup floor</span><input type="number" min={0} value={oFloor} onChange={(e) => setOFloor(e.target.value)} style={{ ...input, width: '70px' }} /></label>
          <label style={field}><span style={labelCss}>Pickup stairs (flights)</span><input type="number" min={0} max={20} value={oStairs} onChange={(e) => setOStairs(e.target.value)} style={{ ...input, width: '70px' }} /></label>
          <label style={check}><input type="checkbox" checked={oElev} onChange={(e) => setOElev(e.target.checked)} /> Elevator at pickup</label>
          <label style={field}><span style={labelCss}>Drop-off floor</span><input type="number" min={0} value={dFloor} onChange={(e) => setDFloor(e.target.value)} style={{ ...input, width: '70px' }} /></label>
          <label style={field}><span style={labelCss}>Drop-off stairs</span><input type="number" min={0} max={20} value={dStairs} onChange={(e) => setDStairs(e.target.value)} style={{ ...input, width: '70px' }} /></label>
          <label style={check}><input type="checkbox" checked={dElev} onChange={(e) => setDElev(e.target.checked)} /> Elevator at drop-off</label>
        </div>
        <div style={{ ...row, marginTop: '8px' }}>
          <label style={check}><input type="checkbox" checked={longCarry} onChange={(e) => setLongCarry(e.target.checked)} /> Long carry</label>
          <label style={check}><input type="checkbox" checked={coi} onChange={(e) => setCoi(e.target.checked)} /> COI required (building certificate of insurance)</label>
        </div>
        <label style={{ ...field, marginTop: '8px' }}>
          <span style={labelCss}>Parking / access notes</span>
          <input value={accessNotes} onChange={(e) => setAccessNotes(e.target.value)} placeholder="Loading dock 9-11 only; park on the north side…" style={input} maxLength={2000} />
        </label>
      </section>

      {/* ── Services ── */}
      <section style={panel}>
        <h3 style={sectionTitle}>4 · Services</h3>
        <div style={row}>
          {SERVICE_MODES.map((m) => (
            <label key={m} style={check}>
              <input type="radio" name="serviceMode" checked={mode === m} onChange={() => setMode(m)} /> {SERVICE_MODE_LABELS[m]}
            </label>
          ))}
        </div>
        <div style={{ ...row, marginTop: '8px' }}>
          <label style={check}><input type="checkbox" checked={packing} onChange={(e) => setPacking(e.target.checked)} /> Packing</label>
          <label style={check}><input type="checkbox" checked={unpacking} onChange={(e) => setUnpacking(e.target.checked)} /> Unpacking</label>
          <label style={check}><input type="checkbox" checked={assembly} onChange={(e) => setAssembly(e.target.checked)} /> Assembly</label>
          <label style={check}><input type="checkbox" checked={disassembly} onChange={(e) => setDisassembly(e.target.checked)} /> Disassembly</label>
        </div>
      </section>

      {/* ── Inventory ── */}
      <section style={panel}>
        <h3 style={sectionTitle}>5 · Inventory</h3>
        <label style={field}>
          <span style={labelCss}>Search the catalog</span>
          <input value={catQ} onChange={(e) => setCatQ(e.target.value)} placeholder="couch, washer, box…" style={input} />
        </label>
        {catalogMissing && <p style={{ ...hint, color: '#B45309' }}>Catalog table missing (migration 20260811000000 not applied) — add custom items below.</p>}
        {catHits.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '8px 0' }}>
            {catHits.map((it) => (
              <button key={it.id} type="button" onClick={() => addCatalogItem(it)} style={chipBtn}>
                + {it.name}{it.isHeavy ? ' 🏋' : ''}{it.needsDisassembly ? ' 🔧' : ''}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', margin: '8px 0' }}>
          <label style={{ ...field, flex: 1 }}>
            <span style={labelCss}>Custom item</span>
            <input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomItem() } }}
              placeholder="Fish tank (55 gal)…"
              style={input}
              maxLength={200}
            />
          </label>
          <button type="button" onClick={addCustomItem} style={ghostBtn}>Add</button>
        </div>
        {inv.length === 0 ? (
          <p style={hint}>Nothing captured yet — booking still works, with a warning to confirm the list before move day.</p>
        ) : (
          <div style={{ border: '1px solid #F1F1F1', borderRadius: '10px', overflow: 'hidden' }}>
            {inv.map((l) => (
              <div key={l.key} style={invRow}>
                <span style={{ flex: 1, fontSize: '13px', color: '#374151' }}>
                  {l.name}
                  {l.isHeavy && <em style={{ color: '#B45309', fontStyle: 'normal' }}> · heavy</em>}
                  {l.needsDisassembly && <em style={{ color: '#6B7280', fontStyle: 'normal' }}> · disassembly</em>}
                </span>
                <button type="button" onClick={() => setQty(l.key, -1)} style={stepBtn} aria-label={`One fewer ${l.name}`}>−</button>
                <span style={{ minWidth: '26px', textAlign: 'center', fontWeight: 700, fontSize: '13px' }}>{l.quantity}</span>
                <button type="button" onClick={() => setQty(l.key, +1)} style={stepBtn} aria-label={`One more ${l.name}`}>+</button>
                <button type="button" onClick={() => setInv((prev) => prev.filter((x) => x.key !== l.key))} style={{ ...stepBtn, color: '#EF4444' }} aria-label={`Remove ${l.name}`}>✕</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Recommendation card ── */}
      <section style={{ ...panel, borderLeft: '4px solid #FF5A1F' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ ...sectionTitle, margin: 0 }}>6 · Recommendation {recBusy && <span style={{ fontWeight: 400, color: '#9CA3AF' }}>updating…</span>}</h3>
          <button type="button" onClick={() => void refreshRecommendation(recommendBody)} style={ghostBtn}>Refresh</button>
        </div>
        {rec ? (
          <>
            <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', margin: '12px 0' }}>
              <Stat label="Crew" value={`${rec.crewSize} movers`} />
              <Stat label="Truck" value={rec.truckSize ?? 'manual plan'} />
              <Stat label="Hours" value={`${rec.estimatedHoursMin}–${rec.estimatedHoursMax}h`} />
              <Stat label="Trips" value={String(rec.possibleTrips)} />
              <Stat label="Difficulty" value={rec.difficulty} color={DIFFICULTY_COLORS[rec.difficulty]} />
              {recommendedTotal != null && <Stat label="Recommended price" value={`$${recommendedTotal}`} color="#FF5A1F" />}
            </div>
            <ul style={{ margin: 0, paddingLeft: '18px' }}>
              {rec.reasons.map((r) => (
                <li key={r} style={{ fontSize: '12px', color: '#6B7280', padding: '1px 0' }}>{r}</li>
              ))}
            </ul>
            {clientSA && clientSA.travelFeeCents == null && (
              <p style={{ ...hint, color: '#B45309' }}>Travel pricing pending your review — not included in the recommended price.</p>
            )}
          </>
        ) : (
          <p style={hint}>Pick a move size to see crew / truck / hours and the reasons behind them.</p>
        )}
      </section>

      {/* ── Truck ── */}
      <section style={panel}>
        <h3 style={sectionTitle}>7 · Truck</h3>
        {trucksMissing ? (
          <p style={{ ...hint, color: '#B45309' }}>Trucks table missing (migration 20260811000000 not applied) — book without a truck assignment.</p>
        ) : trucks.length === 0 ? (
          <p style={hint}>{moveDate ? 'No trucks in the fleet yet — add them under Operations → Trucks.' : 'Pick a move date to see per-truck availability.'}</p>
        ) : (
          <>
            <div style={row}>
              <label style={{ ...field, minWidth: '260px' }}>
                <span style={labelCss}>Assign a truck (optional)</span>
                <select value={truckId} onChange={(e) => { setTruckId(e.target.value); setTruckOverride(false) }} style={input}>
                  <option value="">— no truck assigned —</option>
                  {trucks.filter((t) => t.active && t.status === 'AVAILABLE').map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.size}){t.busy ? ' — BUSY this day' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {truckBusy && (
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '10px 12px', marginTop: '8px' }}>
                <p style={{ fontSize: '12px', color: '#B91C1C', margin: '0 0 6px', fontWeight: 700 }}>
                  ⚠ {selectedTruck!.name} is already taken on this day by {selectedTruck!.bookings.length} booking{selectedTruck!.bookings.length === 1 ? '' : 's'}:{' '}
                  {/* R2-2: an unpaid hold counts — the create refuses it either
                      way — but say which it is, because breaking a hold that
                      nobody has paid for is a different call from breaking a
                      confirmed job. */}
                  {selectedTruck!.bookings.map((b) => `${b.displayId}${b.hold === 'pending' ? ' (unpaid hold)' : ''}`).join(', ')}
                </p>
                <label style={{ ...check, color: '#B91C1C' }}>
                  <input type="checkbox" checked={truckOverride} onChange={(e) => setTruckOverride(e.target.checked)} />
                  Double-book this truck anyway (deliberate, audited)
                </label>
              </div>
            )}
          </>
        )}
        {conflictInfo && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '10px 12px', marginTop: '8px' }}>
            <p style={{ fontSize: '12px', color: '#B91C1C', margin: '0 0 6px', fontWeight: 700 }}>⚠ {conflictInfo}</p>
            <label style={{ ...check, color: '#B91C1C' }}>
              <input type="checkbox" checked={truckOverride} onChange={(e) => setTruckOverride(e.target.checked)} />
              Double-book this truck anyway (deliberate, audited)
            </label>
          </div>
        )}
      </section>

      {/* ── Price ── */}
      <section style={panel}>
        <h3 style={sectionTitle}>8 · Price</h3>
        <div style={row}>
          <label style={field}>
            <span style={labelCss}>Recommended</span>
            <input value={recommendedTotal != null ? `$${recommendedTotal}` : '—'} readOnly style={{ ...input, background: '#F9FAFB', width: '110px' }} />
          </label>
          <label style={field}>
            <span style={labelCss}>Your price ($) *</span>
            <input type="number" min={1} step="1" value={ownerTotal} onChange={(e) => setOwnerTotal(e.target.value)} style={{ ...input, width: '110px', fontWeight: 700 }} />
          </label>
          {recommendedTotal != null && (
            <button type="button" style={ghostBtn} onClick={() => setOwnerTotal(String(recommendedTotal))}>
              Use recommended
            </button>
          )}
        </div>
        {priceDiffers && (
          <label style={{ ...field, marginTop: '8px' }}>
            <span style={{ ...labelCss, color: '#B45309' }}>Why the different price? (required, audited as PRICE_CHANGED)</span>
            <input value={priceReason} onChange={(e) => setPriceReason(e.target.value)} placeholder="Repeat customer; matched competitor quote; extra-heavy inventory…" style={input} maxLength={500} />
          </label>
        )}
      </section>

      {/* ── Deposit ── */}
      <section style={panel}>
        <h3 style={sectionTitle}>9 · Deposit</h3>
        {DEPOSIT_MODES.map((m) => (
          <label key={m} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '6px 0', cursor: 'pointer' }}>
            <input type="radio" name="deposit" checked={deposit === m} onChange={() => setDeposit(m)} style={{ marginTop: '3px' }} />
            <span>
              <strong style={{ fontSize: '13px', color: '#0A1628' }}>{DEPOSIT_LABELS[m][0]}</strong>
              <br />
              <span style={{ fontSize: '12px', color: '#6B7280' }}>{DEPOSIT_LABELS[m][1]}</span>
            </span>
          </label>
        ))}
      </section>

      {/* ── Notes ── */}
      <section style={panel}>
        <h3 style={sectionTitle}>10 · Notes</h3>
        <label style={field}>
          <span style={labelCss}>Job notes (visible on the job page)</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ ...input, resize: 'vertical' }} maxLength={4000} />
        </label>
        <label style={{ ...field, marginTop: '8px' }}>
          <span style={labelCss}>Crew instructions</span>
          <textarea value={crewInstructions} onChange={(e) => setCrewInstructions(e.target.value)} rows={2} style={{ ...input, resize: 'vertical' }} maxLength={2000} />
        </label>
      </section>

      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '10px', padding: '10px 14px', marginBottom: '12px' }}>
          <p style={{ fontSize: '13px', color: '#B91C1C', margin: 0, fontWeight: 600 }}>{error}</p>
        </div>
      )}

      <button type="button" onClick={() => void submit()} disabled={busy} style={{ ...bookBtn, opacity: busy ? 0.6 : 1 }}>
        {busy ? 'Booking…' : '📞 BOOK MOVE'}
      </button>
      <p style={{ ...hint, marginTop: '8px' }}>
        Booking creates the customer, the booking, the job + staffing requirement (when confirmed), converts the lead, and asks the Action Center to rescan — the panel afterwards reports what that scan actually did. No customer emails are sent.
      </p>
    </div>
  )
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <p style={{ fontSize: '10px', fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 2px' }}>{label}</p>
      <p style={{ fontSize: '16px', fontWeight: 800, color: color ?? '#0A1628', margin: 0 }}>{value}</p>
    </div>
  )
}

function AddressBlock(props: {
  title: string
  street: string; city: string; state: string; zip: string; prop: string
  setStreet: (v: string) => void; setCity: (v: string) => void; setState: (v: string) => void; setZip: (v: string) => void; setProp: (v: string) => void
}) {
  return (
    <div style={{ marginTop: '10px' }}>
      <p style={{ fontSize: '11px', fontWeight: 700, color: '#0A1628', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{props.title}</p>
      <div style={row}>
        <label style={{ ...field, flex: 2, minWidth: '200px' }}>
          <span style={labelCss}>Street *</span>
          <input value={props.street} onChange={(e) => props.setStreet(e.target.value)} style={input} maxLength={200} />
        </label>
        <label style={{ ...field, flex: 1 }}>
          <span style={labelCss}>City *</span>
          <input value={props.city} onChange={(e) => props.setCity(e.target.value)} style={input} maxLength={120} />
        </label>
        <label style={field}>
          <span style={labelCss}>State</span>
          <input value={props.state} onChange={(e) => props.setState(e.target.value)} style={{ ...input, width: '56px' }} maxLength={20} />
        </label>
        <label style={field}>
          <span style={labelCss}>ZIP *</span>
          <input value={props.zip} onChange={(e) => props.setZip(e.target.value)} style={{ ...input, width: '76px' }} maxLength={5} inputMode="numeric" />
        </label>
        <label style={field}>
          <span style={labelCss}>Property</span>
          <select value={props.prop} onChange={(e) => props.setProp(e.target.value)} style={input}>
            <option value="">—</option>
            {PROPERTY_TYPES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      style={ghostBtn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          window.prompt('Copy this link:', value)
        }
      }}
    >
      {copied ? '✓ Copied' : label}
    </button>
  )
}

// ── Styles (house inline-style pattern) ──────────────────────────────────────

const panel: React.CSSProperties = { backgroundColor: '#FFFFFF', border: '1px solid #F1F1F1', borderRadius: '14px', padding: '16px 18px', marginBottom: '14px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }
const sectionTitle: React.CSSProperties = { fontSize: '13px', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }
const row: React.CSSProperties = { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }
const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }
const labelCss: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: '#6B7280', letterSpacing: '0.04em', textTransform: 'uppercase' }
const input: React.CSSProperties = { padding: '8px 10px', border: '1px solid #D1D5DB', borderRadius: '8px', fontSize: '13px', fontFamily: 'inherit', backgroundColor: '#fff' }
const check: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#374151', cursor: 'pointer' }
const hint: React.CSSProperties = { fontSize: '12px', color: '#9CA3AF', margin: '6px 0 0' }
const hitRow: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: '#fff', border: 'none', borderBottom: '1px solid #F3F4F6', fontSize: '13px', cursor: 'pointer' }
const chipBtn: React.CSSProperties = { padding: '5px 10px', background: '#F5F1EA', border: '1px solid #E5E7EB', borderRadius: '100px', fontSize: '12px', cursor: 'pointer' }
const invRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 12px', borderBottom: '1px solid #F3F4F6' }
const stepBtn: React.CSSProperties = { width: '26px', height: '26px', border: '1px solid #E5E7EB', borderRadius: '6px', background: '#fff', cursor: 'pointer', fontSize: '13px', lineHeight: 1 }
const primaryBtn: React.CSSProperties = { padding: '9px 16px', backgroundColor: '#0A1628', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
const ghostBtn: React.CSSProperties = { padding: '9px 14px', backgroundColor: '#fff', color: '#6B7280', border: '1px solid #E5E7EB', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
const bookBtn: React.CSSProperties = { padding: '14px 28px', backgroundColor: '#FF5A1F', color: '#fff', border: 'none', borderRadius: '10px', fontSize: '15px', fontWeight: 800, letterSpacing: '0.03em', cursor: 'pointer', boxShadow: '0 2px 8px rgba(255,90,31,0.35)' }
