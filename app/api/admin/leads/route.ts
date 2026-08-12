import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { buildManualLeadCreate, OPEN_LEAD_STATUSES } from '@/lib/lead-transitions'
import { z } from 'zod'

// Manual lead entry (Moving OS Phase 1, Stage 2C). A phone call the owner
// answers becomes a tracked lead instead of a sticky note. Wires the
// previously-dead LEAD_CREATED audit action.
//
// CONSENT: manual entry NEVER grants marketing consent — the owner typing a
// customer's email is not that customer opting in. buildManualLeadCreate
// leaves all four consent columns null ("never asked"), per src/lib/leads.ts.
//
// DEDUPE: same email-first convention as createOrUpdateLead — but instead of
// silently merging (which would hide the owner's fresh notes inside an old
// row), an OPEN lead with the same email is REFUSED with a 409 + the existing
// lead's id, so the UI can take the owner to the lead that already exists.

const CreateSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    phone: z.string().trim().max(40).optional(),
    email: z.string().trim().email().max(200).optional(),
    moveDate: z.string().trim().optional(), // 'YYYY-MM-DD' or ISO
    moveSize: z.string().trim().max(60).optional(),
    originZip: z.string().trim().max(10).optional(),
    destinationZip: z.string().trim().max(10).optional(),
    notes: z.string().trim().max(2000).optional(),
    serviceInterest: z.string().trim().max(80).optional(),
  })
  .refine((d) => !!(d.phone?.trim() || d.email?.trim()), {
    message: 'At least one of phone or email is required',
  })

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'lead.manage')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  let moveDate: Date | null = null
  if (d.moveDate) {
    moveDate = new Date(d.moveDate.length === 10 ? d.moveDate + 'T12:00:00' : d.moveDate)
    if (Number.isNaN(moveDate.getTime())) return NextResponse.json({ error: 'Invalid move date' }, { status: 422 })
  }

  const data = buildManualLeadCreate({ ...d, moveDate }, new Date())
  // Normalization can void a contact field (e.g. a junk email) — re-check the
  // invariant on what will actually be STORED, not just on what was typed.
  if (!data.email && !data.phone) {
    return NextResponse.json({ error: 'At least one of phone or email is required' }, { status: 422 })
  }

  // Email-first dedupe (same convention as createOrUpdateLead): never spawn a
  // duplicate next to an OPEN lead with this address.
  if (data.email) {
    const existing = await prisma.lead.findFirst({
      where: { email: data.email, status: { in: [...OPEN_LEAD_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: `An open lead with this email already exists (${existing.name}).`, leadId: existing.id },
        { status: 409 }
      )
    }
  }

  // Create + audit atomically — the log can never record a create that rolled
  // back (house pattern, expenses route).
  const lead = await prisma.$transaction(async (tx) => {
    const l = await tx.lead.create({ data, select: { id: true, name: true, status: true, email: true, phone: true } })
    await tx.auditLog.create({
      data: {
        action: 'LEAD_CREATED',
        userId: session.userId,
        details: {
          leadId: l.id,
          name: l.name,
          email: l.email,
          phone: l.phone,
          source: 'MANUAL_ENTRY',
          by: session.name,
        },
      },
    })
    return l
  })

  apiLogger.info({ leadId: lead.id }, 'Lead created (manual entry)')
  return NextResponse.json(lead, { status: 201 })
}
