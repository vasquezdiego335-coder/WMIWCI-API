import { v2 as cloudinary } from 'cloudinary'
import crypto from 'crypto'

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME ?? 'placeholder',
  api_key: process.env.CLOUDINARY_API_KEY ?? 'placeholder',
  api_secret: process.env.CLOUDINARY_API_SECRET ?? 'placeholder',
  secure: true,
})

// ── Generate a signed upload URL ─────────────────────────────
// Never expose API secret to client — always generate server-side
export function generateSignedUploadParams(params: {
  folder: string
  publicId?: string
  resourceType?: 'image' | 'raw'
  maxBytes?: number
}): {
  signature: string
  timestamp: number
  apiKey: string
  cloudName: string
  folder: string
} {
  const timestamp = Math.round(Date.now() / 1000)
  const folder = params.folder
  const maxBytes = params.maxBytes ?? 10_485_760 // 10MB default

  const toSign = [
    `folder=${folder}`,
    `timestamp=${timestamp}`,
    `upload_preset=moveit_signed`,
  ].join('&') + process.env.CLOUDINARY_API_SECRET

  const signature = crypto
    .createHash('sha256')
    .update(toSign)
    .digest('hex')

  return {
    signature,
    timestamp,
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    folder,
  }
}

// ── Generate a signed access URL (expires in 1 hour) ─────────
export function generateSignedUrl(publicId: string, expiresInSecs = 3600): string {
  return cloudinary.url(publicId, {
    sign_url: true,
    auth_token: {
      key: process.env.CLOUDINARY_API_SECRET ?? '',
      duration: expiresInSecs,
    },
    secure: true,
  })
}

// ── Delete a file ─────────────────────────────────────────────
export async function deleteFile(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId)
}

// ── Delete multiple files ─────────────────────────────────────
export async function deleteFiles(publicIds: string[]): Promise<void> {
  if (publicIds.length === 0) return
  await cloudinary.api.delete_resources(publicIds)
}

// ── Upload from a buffer (server-side) ───────────────────────
export async function uploadBuffer(
  buffer: Buffer,
  options: {
    folder: string
    publicId?: string
    resourceType?: 'image' | 'raw'
  }
): Promise<{ publicId: string; url: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder,
        public_id: options.publicId,
        resource_type: options.resourceType ?? 'image',
        overwrite: false,
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Upload failed'))
        resolve({
          publicId: result.public_id,
          url: result.secure_url,
          bytes: result.bytes,
        })
      }
    )
    stream.end(buffer)
  })
}

export { cloudinary }
