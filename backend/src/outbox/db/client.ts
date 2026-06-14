// Reuse the app's existing Prisma singleton so the outbox does NOT open a
// second connection pool in the same process. If you ever extract the outbox
// into its own service, swap this for a local `new PrismaClient()`.
export { prisma } from '../../lib/db'
export type { PrismaClient, Prisma } from '@prisma/client'
