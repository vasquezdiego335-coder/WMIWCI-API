import { PrismaClient, UserRole } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  // ── Staff accounts ─────────────────────────────────────────
  const diegoHash = await bcrypt.hash('change_me_diego_2024!', 12)
  const sebastianHash = await bcrypt.hash('change_me_sebastian_2024!', 12)

  const diego = await prisma.user.upsert({
    where: { email: 'diego@moveitclearit.com' },
    update: {
      // Always sync Discord ID + role on re-seed so button permissions work.
      discordId: process.env.DISCORD_USER_DIEGO ?? null,
      role: UserRole.OWNER,
    },
    create: {
      email: 'diego@moveitclearit.com',
      passwordHash: diegoHash,
      name: 'Diego',
      role: UserRole.OWNER,
      discordId: process.env.DISCORD_USER_DIEGO ?? null,
    },
  })

  const sebastian = await prisma.user.upsert({
    where: { email: 'sebastian@moveitclearit.com' },
    update: {
      discordId: process.env.DISCORD_USER_SEBASTIAN ?? null,
      role: UserRole.MANAGER,
    },
    create: {
      email: 'sebastian@moveitclearit.com',
      passwordHash: sebastianHash,
      name: 'Sebastian',
      role: UserRole.MANAGER,
      discordId: process.env.DISCORD_USER_SEBASTIAN ?? null,
    },
  })

  console.log(`✅ Users: Diego (${diego.id}), Sebastian (${sebastian.id})`)

  // ── Sample customer + booking ───────────────────────────────
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 7)
  tomorrow.setHours(9, 0, 0, 0)

  const customer = await prisma.customer.upsert({
    where: { email: 'test@example.com' },
    update: {},
    create: {
      email: 'test@example.com',
      name: 'Jane Test',
      phone: '+15551234567',
      isFirstTime: true,
    },
  })

  const tokenExpiry = new Date()
  tokenExpiry.setDate(tokenExpiry.getDate() + 7)

  const booking = await prisma.booking.create({
    data: {
      customerId: customer.id,
      status: 'CONFIRMED',
      originAddress: '123 Main St, West Orange, NJ 07052',
      destAddress: '456 Oak Ave, Montclair, NJ 07042',
      originFloor: 2,
      destFloor: 1,
      hasElevator: false,
      itemsDescription: '2-bedroom apartment, sofa, dining table, boxes',
      estimatedHours: 4,
      requestedDate: tomorrow,
      confirmedDate: tomorrow,
      scheduledStart: tomorrow,
      baseRate: 699,
      totalEstimate: 699,
      discountType: 'FIRST_TIME_AUTO',
      discountPercent: 10,
      customerTokenExpiry: tokenExpiry,
    },
  })

  console.log(`✅ Sample booking: ${booking.id}`)
  console.log(`   Customer portal token: ${booking.customerToken}`)
  console.log('')
  console.log('⚠️  IMPORTANT: Change default passwords before production!')
  console.log('   Diego:     change_me_diego_2024!')
  console.log('   Sebastian: change_me_sebastian_2024!')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
