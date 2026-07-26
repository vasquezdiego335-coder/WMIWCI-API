// ════════════════════════════════════════════════════════════════════════
//  reset-password.ts — set an admin user's password (bcrypt) directly.
//  Owner account recovery. Run against prod via Railway so the prod DB URL is
//  injected (never hard-code it):
//     railway run npx tsx scripts/reset-password.ts <email> <newPassword>
//  Prints the DB host (no credentials) so you can confirm the target first.
// ════════════════════════════════════════════════════════════════════════
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const [email, password] = process.argv.slice(2)
if (!email || !password) {
  console.error('Usage: tsx scripts/reset-password.ts <email> <newPassword>')
  process.exit(1)
}

// Show the target DB host (credentials stripped) for a sanity check.
try {
  const u = new URL(process.env.DATABASE_URL ?? '')
  console.log(`DB target -> host=${u.host} db=${u.pathname.replace('/', '')}`)
} catch {
  console.error('No DATABASE_URL in env — run this via `railway run` so prod is injected.')
  process.exit(1)
}

const prisma = new PrismaClient()

async function main() {
  const passwordHash = await bcrypt.hash(password, 12)
  const user = await prisma.user.update({
    where: { email },
    data: { passwordHash },
    select: { email: true, role: true, active: true },
  })
  console.log(`OK - password reset for ${user.email} (role=${user.role}, active=${user.active})`)
}

main()
  .catch((e) => {
    console.error('reset failed:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
