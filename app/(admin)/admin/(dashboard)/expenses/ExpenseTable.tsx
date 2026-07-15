'use client'

import { useState } from 'react'
import Link from 'next/link'
import { fmtCents } from '@/lib/profit'
import { COLORS, Badge, tableStyles as T } from '../_ui'
import {
  EXPENSE_STATUS_LABELS, EXPENSE_STATUS_COLORS, PAYMENT_METHOD_LABELS,
  categoryGroupLabel, expenseDisplayTitle, hasNotes, sortExpenses,
  type ExpenseSortKey, type SortDir,
} from '@/lib/expense-format'
import ExpenseActions from './ExpenseActions'
import ExpenseDrawer from './ExpenseDrawer'

// Client expenses table (owner spec 2026-07-14). Column order is the owner's:
// Date | Item | Category | Vendor | Amount | Payment | Paid By | Related Job |
// Status | Notes | Actions. Item title is the most prominent field; long notes
// live behind a "View notes" icon that opens the OWNER-only details drawer;
// every listed column sorts. Sorting/derivation logic is pure + tested in
// src/lib/expense-format.ts — this component is presentation + interaction only.

export interface ExpenseRow {
  id: string
  itemTitle: string | null
  amount: number
  incurredOn: string
  category: string
  subcategory: string | null
  vendor: string | null
  paymentMethod: string | null
  paidBy: string | null
  bookingId: string | null
  purpose: string | null
  receiptUrl: string | null
  receiptPublicId: string | null
  reimbursable: boolean
  status: string
  notes: string | null
  createdByName: string | null
  updatedByName: string | null
  createdAt: string
  updatedAt: string
  job: { id: string; label: string } | null
  jobLabel: string | null // convenience mirror of job.label for sorting
}

const COLUMNS: { key: ExpenseSortKey; label: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'title', label: 'Item' },
  { key: 'category', label: 'Category' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'amount', label: 'Amount' },
  { key: 'method', label: 'Payment' },
  { key: 'paidBy', label: 'Paid By' },
  { key: 'job', label: 'Related Job' },
  { key: 'status', label: 'Status' },
]

const dateOnly = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })

export default function ExpenseTable({ rows, isOwner }: { rows: ExpenseRow[]; isOwner: boolean }) {
  const [sortKey, setSortKey] = useState<ExpenseSortKey>('date')
  const [dir, setDir] = useState<SortDir>('desc')
  const [openId, setOpenId] = useState<string | null>(null)

  const sorted = sortExpenses(rows, sortKey, dir)
  const open = openId ? rows.find((r) => r.id === openId) ?? null : null

  function toggleSort(key: ExpenseSortKey) {
    if (key === sortKey) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setDir(key === 'date' || key === 'amount' ? 'desc' : 'asc')
    }
  }

  return (
    <div style={T.wrap}>
      <div style={T.scroll}>
        <table style={T.table}>
          <thead>
            <tr>
              {COLUMNS.map((c) => {
                const active = c.key === sortKey
                return (
                  <th
                    key={c.key}
                    style={{ ...T.th, cursor: 'pointer', color: active ? COLORS.navy : COLORS.muted, userSelect: 'none' }}
                    onClick={() => toggleSort(c.key)}
                    title={`Sort by ${c.label}`}
                  >
                    {c.label}{active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                )
              })}
              <th style={T.th}>Notes</th>
              <th style={T.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => {
              const rowClickable = isOwner
              return (
                <tr
                  key={e.id}
                  onClick={rowClickable ? () => setOpenId(e.id) : undefined}
                  style={rowClickable ? { cursor: 'pointer' } : undefined}
                >
                  <td style={{ ...T.td, whiteSpace: 'nowrap' }}>{dateOnly(e.incurredOn)}</td>
                  <td style={{ ...T.td, minWidth: 180 }}>
                    <span style={{ fontWeight: 700, color: COLORS.navy, fontSize: '13.5px' }}>{expenseDisplayTitle(e)}</span>
                    {e.subcategory && <div style={{ fontSize: '11px', color: COLORS.faint }}>{e.subcategory}</div>}
                  </td>
                  <td style={{ ...T.td, whiteSpace: 'nowrap' }}>{categoryGroupLabel(e.category)}</td>
                  <td style={T.td}>{e.vendor ?? '—'}</td>
                  <td style={{ ...T.td, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtCents(e.amount)}</td>
                  <td style={T.td}>{e.paymentMethod ? (PAYMENT_METHOD_LABELS[e.paymentMethod] ?? e.paymentMethod) : '—'}</td>
                  <td style={T.td}>{e.paidBy ?? '—'}</td>
                  <td style={T.td}>
                    {e.job ? (
                      <Link href={`/admin/jobs/${e.job.id}`} onClick={(ev) => ev.stopPropagation()} style={{ color: COLORS.orange, textDecoration: 'none' }}>
                        {e.job.label}
                      </Link>
                    ) : (
                      <span style={{ color: COLORS.faint }}>General</span>
                    )}
                  </td>
                  <td style={T.td}><Badge color={EXPENSE_STATUS_COLORS[e.status] ?? COLORS.muted}>{EXPENSE_STATUS_LABELS[e.status] ?? e.status}</Badge></td>
                  <td style={T.td}>
                    {hasNotes(e) && isOwner ? (
                      <button
                        onClick={(ev) => { ev.stopPropagation(); setOpenId(e.id) }}
                        style={notesBtn}
                        title="View notes"
                      >📝 View</button>
                    ) : hasNotes(e) ? (
                      <span title="Notes (owner view)" style={{ color: COLORS.faint }}>📝</span>
                    ) : '—'}
                  </td>
                  <td style={T.td} onClick={(ev) => ev.stopPropagation()}>
                    <ExpenseActions id={e.id} status={e.status} reimbursable={e.reimbursable} canDelete={isOwner} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {open && isOwner && <ExpenseDrawer expense={open} onClose={() => setOpenId(null)} />}
    </div>
  )
}

const notesBtn: React.CSSProperties = {
  padding: '3px 8px', backgroundColor: '#fff', border: '1px solid #E5E7EB', borderRadius: '6px',
  fontSize: '11px', fontWeight: 700, color: COLORS.muted, cursor: 'pointer', whiteSpace: 'nowrap',
}
