// Human labels for admin-OS enums (owner spec 2026-07-13). Plain objects — no
// 'use client', so both server pages and client forms import the same source.

export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  WORKER_PAY: 'Worker pay',
  GAS: 'Gas',
  TOLLS: 'Tolls',
  PARKING: 'Parking',
  TRUCK_RENTAL: 'Truck rental',
  MOVING_EQUIPMENT: 'Moving equipment',
  MOVING_BLANKETS: 'Moving blankets',
  STRAPS_DOLLIES: 'Straps & dollies',
  ADVERTISING: 'Advertising',
  WEBSITE_SOFTWARE: 'Website & software',
  INSURANCE: 'Insurance',
  PHONE: 'Phone',
  CREW_FOOD: 'Food & drinks for crew',
  REFUNDS: 'Refunds',
  OFFICE: 'Office',
  LEGAL_REGISTRATION: 'Legal & registration',
  SUPPLIES: 'Supplies',
  MISC: 'Miscellaneous',
}

export const EXPENSE_CATEGORY_ORDER = Object.keys(EXPENSE_CATEGORY_LABELS)

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  CASHAPP: 'Cash App',
  BANK_TRANSFER: 'Bank transfer',
  CHECK: 'Check',
  OTHER: 'Other',
}
export const PAYMENT_METHOD_ORDER = Object.keys(PAYMENT_METHOD_LABELS)

export const EXPENSE_STATUS_LABELS: Record<string, string> = {
  SUBMITTED: 'Submitted',
  NEEDS_REVIEW: 'Needs review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  REIMBURSED: 'Reimbursed',
}
export const EXPENSE_STATUS_COLORS: Record<string, string> = {
  SUBMITTED: '#6B7280',
  NEEDS_REVIEW: '#F59E0B',
  APPROVED: '#10B981',
  REJECTED: '#EF4444',
  REIMBURSED: '#3B82F6',
}

export const OWNER_TX_TYPE_LABELS: Record<string, string> = {
  CONTRIBUTION: 'Contribution',
  WITHDRAWAL: 'Withdrawal',
  REIMBURSEMENT: 'Reimbursement',
  DISTRIBUTION: 'Profit distribution',
  PERSONAL_PURCHASE: 'Personal purchase (reimbursable)',
}
export const OWNER_TX_TYPE_ORDER = Object.keys(OWNER_TX_TYPE_LABELS)

export const APPROVAL_STATUS_COLORS: Record<string, string> = {
  PENDING: '#F59E0B',
  APPROVED: '#10B981',
  REJECTED: '#EF4444',
}

export const OWNER_LABELS: Record<string, string> = { DIEGO: 'Diego', SEBASTIAN: 'Sebastian' }
