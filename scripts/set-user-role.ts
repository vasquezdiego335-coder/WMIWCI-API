// ════════════════════════════════════════════════════════════════════════
//  set-user-role.ts — safely change a user's role in production (increment
//  2.1 correction). Built for the Sebastian OWNER fix, reusable for future
//  employees. DRY-RUN by default; --apply writes. Idempotent, audited, and it
//  NEVER touches passwords or any other field.
//
//  Founders Diego + Sebastian are BOTH co-owners → role OWNER. MANAGER is
//  reserved for future non-owner employees.
//
//  Fix Sebastian (recommended):
//    npx tsx scripts/set-user-role.ts --email sebastian@moveitclearit.com --role OWNER          (dry run)
//    npx tsx scripts/set-user-role.ts --email sebastian@moveitclearit.com --role OWNER --apply  (write)
// ════════════════════════════════════════════════════════════════════════
import { prisma } from '../src/lib/db'
import { UserRole } from '@prisma/client'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const email = arg('email')?.toLowerCase().trim()
  const role = arg('role')?.toUpperCase().trim() as UserRole | undefined
  const apply = process.argv.includes('--apply')

  if (!email || !role || !['OWNER', 'MANAGER', 'CREW'].includes(role)) {
    console.error('Usage: tsx scripts/set-user-role.ts --email <email> --role <OWNER|MANAGER|CREW> [--apply]')
    process.exit(1)
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, email: true, role: true } })
  if (!user) {
    console.error(`No user with email ${email}. Nothing changed.`)
    process.exit(1)
  }

  console.log(`User: ${user.name} <${user.email}>`)
  console.log(`Current role: ${user.role}   →   requested: ${role}`)

  if (user.role === role) {
    console.log('Already at the requested role — no change needed (idempotent).')
    await prisma.$disconnect()
    return
  }

  if (!apply) {
    console.log('\nDRY RUN — no change written. Re-run with --apply to update the role.')
    await prisma.$disconnect()
    return
  }

  // Write + audit in one transaction, recording before → after.
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { role } }),
    prisma.auditLog.create({
      data: {
        action: 'BOOKING_DETAILS_UPDATED', // closest existing generic admin action; details carry the specifics
        userId: user.id,
        details: { kind: 'user_role_change', email: user.email, from: user.role, to: role, via: 'scripts/set-user-role.ts' },
      },
    }),
  ])
  console.log(`\n✅ Applied. ${user.email} is now ${role}.`)
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
