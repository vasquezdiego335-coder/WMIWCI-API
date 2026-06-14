/**
 * Generate a bcrypt hash for a password.
 * Usage: npx ts-node scripts/hash-password.ts <password>
 *
 * Use this to set initial passwords for Diego and Sebastian in the seed.
 * Never commit real passwords to source control.
 */

import bcrypt from 'bcryptjs'

const password = process.argv[2]

if (!password) {
  console.error('Usage: npx ts-node scripts/hash-password.ts <password>')
  process.exit(1)
}

async function main() {
  const hash = await bcrypt.hash(password, 12)
  console.log('\nPassword hash (copy this into your seed or .env):')
  console.log(hash)
}

main()
