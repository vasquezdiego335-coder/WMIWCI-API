import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { uploadBuffer } from '@/lib/cloudinary'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'

const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Allow staff OR customers with a valid booking token
  const session = await getSession()
  const bookingToken = req.headers.get('x-booking-token')

  let bookingId: string | null = null
  let uploadedBy = 'staff'

  if (!session && !bookingToken) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  if (bookingToken) {
    const booking = await prisma.booking.findFirst({
      where: {
        customerToken: bookingToken,
        customerTokenExpiry: { gte: new Date() },
      },
    })
    if (!booking) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    bookingId = booking.id
    uploadedBy = 'customer'
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const type = (formData.get('type') as string) || 'OTHER'
  const bId = (formData.get('bookingId') as string) || bookingId

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 413 })
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: `File type not allowed. Supported: ${ALLOWED_TYPES.join(', ')}` },
      { status: 415 }
    )
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const folder = `moveit/${bId ?? 'unclaimed'}`
  const resourceType = file.type === 'application/pdf' ? 'raw' : 'image'

  const { publicId, url, bytes } = await uploadBuffer(buffer, { folder, resourceType })

  const record = await prisma.file.create({
    data: {
      bookingId: bId || null,
      type: type as any,
      cloudinaryId: publicId,
      cloudinaryUrl: url,
      filename: file.name,
      mimeType: file.type,
      sizeBytes: bytes,
      uploadedBy: session?.userId ?? uploadedBy,
    },
  })

  if (bId) {
    await prisma.auditLog.create({
      data: {
        action: 'FILE_UPLOADED',
        userId: session?.userId,
        bookingId: bId,
        details: { fileId: record.id, type, filename: file.name, bytes },
      },
    })
  }

  apiLogger.info({ fileId: record.id, bookingId: bId }, 'File uploaded')

  return NextResponse.json({ fileId: record.id, url, publicId })
}
