// Human labels for admin-OS enums (owner spec 2026-07-13). Plain objects — no
// 'use client', so both server pages and client forms import the same source.
//
// The expense label maps + organized category taxonomy now live in
// src/lib/expense-format.ts (one source of truth, unit-tested). Re-exported here
// so existing `../_labels` imports keep working; new code may import either path.

export {
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_CATEGORY_ORDER,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_ORDER,
  EXPENSE_STATUS_LABELS,
  EXPENSE_STATUS_COLORS,
  EXPENSE_CATEGORY_GROUPS,
  SUBCATEGORY_SUGGESTIONS,
  ALL_SUBCATEGORY_SUGGESTIONS,
  PAID_BY_OPTIONS,
  categoryGroupLabel,
} from '@/lib/expense-format'

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

// ── Action Center (increment 2). Severity is NEVER color-alone: each level
//    carries an icon + text label (accessibility rule from the owner spec). ──

export const REMINDER_SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFO: 'Info',
}
export const REMINDER_SEVERITY_ICONS: Record<string, string> = {
  CRITICAL: '🚨',
  HIGH: '⚠️',
  MEDIUM: '🟠',
  LOW: '🔹',
  INFO: 'ℹ️',
}
export const REMINDER_SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: '#DC2626',
  HIGH: '#EA580C',
  MEDIUM: '#D97706',
  LOW: '#2563EB',
  INFO: '#6B7280',
}
export const REMINDER_SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']

export const REMINDER_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  IN_PROGRESS: 'In progress',
  SNOOZED: 'Snoozed',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed',
}
export const REMINDER_STATUS_COLORS: Record<string, string> = {
  OPEN: '#EF4444',
  ACKNOWLEDGED: '#F59E0B',
  IN_PROGRESS: '#3B82F6',
  SNOOZED: '#6B7280',
  RESOLVED: '#10B981',
  DISMISSED: '#9CA3AF',
}

export const REMINDER_CATEGORY_LABELS: Record<string, string> = {
  BOOKING_DATA: 'Booking Data',
  JOBS_SCHEDULING: 'Jobs & Scheduling',
  FINANCIAL: 'Financial',
  CUSTOMER_BALANCE: 'Customer Balances',
  CREW_PAYROLL: 'Crew & Payroll',
  LEADS: 'Leads & Follow-Up',
  DATA_QUALITY: 'Data Quality',
}

// ── Ideas & Roadmap (increment 2) ──

export const ROADMAP_STATUS_LABELS: Record<string, string> = {
  IDEA: 'Idea',
  RESEARCHING: 'Researching',
  PLANNED: 'Planned',
  READY: 'Ready',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  ARCHIVED: 'Archived',
}
export const ROADMAP_STATUS_COLORS: Record<string, string> = {
  IDEA: '#6B7280',
  RESEARCHING: '#8B5CF6',
  PLANNED: '#3B82F6',
  READY: '#0EA5E9',
  IN_PROGRESS: '#F59E0B',
  BLOCKED: '#EF4444',
  COMPLETED: '#10B981',
  REJECTED: '#9CA3AF',
  ARCHIVED: '#D1D5DB',
}
export const ROADMAP_STATUS_ORDER = ['IN_PROGRESS', 'READY', 'PLANNED', 'BLOCKED', 'RESEARCHING', 'IDEA', 'COMPLETED', 'REJECTED', 'ARCHIVED']

export const ROADMAP_PRIORITY_LABELS: Record<string, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
}
export const ROADMAP_PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: '#DC2626',
  HIGH: '#EA580C',
  MEDIUM: '#D97706',
  LOW: '#6B7280',
}

export const ROADMAP_CATEGORY_LABELS: Record<string, string> = {
  FINANCIAL: 'Financial',
  REPORTS: 'Reports',
  JOBS: 'Jobs',
  SCHEDULING: 'Scheduling',
  PAYROLL: 'Payroll',
  LEADS: 'Leads',
  MARKETING: 'Marketing',
  CUSTOMERS: 'Customers',
  PAYMENTS: 'Payments',
  EQUIPMENT: 'Equipment',
  FLEET: 'Fleet',
  DOCUMENTS: 'Documents',
  NOTIFICATIONS: 'Notifications',
  SECURITY: 'Security',
  AI: 'AI',
  WEBSITE: 'Website',
  BOOKING_FORM: 'Booking Form',
  SYSTEM: 'System',
  OTHER: 'Other',
}
