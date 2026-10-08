#!/usr/bin/env node
// Izbira Prisma sheme glede na okolje:
//  - lokalni dev (DATABASE_URL=file:...) -> prisma/schema.sqlite.prisma
//  - produkcija (Neon Postgres, Vercel)  -> prisma/schema.prisma
const { execSync } = require('child_process')
const url = process.env.DATABASE_URL || ''
const schema = url.startsWith('file:') ? 'prisma/schema.sqlite.prisma' : 'prisma/schema.prisma'
console.log(`[prisma-postinstall] DATABASE_URL=${url ? url.split('@').pop() || url : '(ni nastavljen)'} -> generiram ${schema}`)
try {
  // Bun nastavi npm_config_user_agent na bun/*; v npm okolju uporabimo npx.
  const isBun = (process.env.npm_config_user_agent || '').startsWith('bun/')
  const command = isBun ? 'bunx' : 'npx'
  execSync(`${command} prisma generate --schema ${schema}`, { stdio: 'inherit' })
} catch (e) {
  console.error('[prisma-postinstall] generate ni uspel:', e.message)
  process.exit(0) // ne prekini namestitve zaradi generate
}
