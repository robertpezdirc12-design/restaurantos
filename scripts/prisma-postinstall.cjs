#!/usr/bin/env node
// Izbira Prisma sheme glede na okolje:
//  - lokalni dev (DATABASE_URL=file:...) -> prisma/schema.sqlite.prisma
//  - produkcija (Neon Postgres, Vercel)  -> prisma/schema.prisma
const { execSync } = require('child_process')
const url = process.env.DATABASE_URL || ''
const schema = url.startsWith('file:') ? 'prisma/schema.sqlite.prisma' : 'prisma/schema.prisma'
console.log(`[prisma-postinstall] DATABASE_URL=${url ? url.split('@').pop() || url : '(ni nastavljen)'} -> generiram ${schema}`)
try {
  // GitLab CI uporablja oven/bun, kjer npx ni na voljo; npm okolja pa ga imajo.
  // npm_execpath je zanesljiv znak, da postinstall poganja npm.
  const command = process.env.npm_execpath ? 'npx' : 'bunx'
  execSync(`${command} prisma generate --schema ${schema}`, { stdio: 'inherit' })
} catch (e) {
  console.error('[prisma-postinstall] generate ni uspel:', e.message)
  process.exit(0) // ne prekini namestitve zaradi generate
}
