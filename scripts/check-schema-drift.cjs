#!/usr/bin/env node
const fs = require('fs')
const SRC = 'prisma/schema.prisma'
const DST = 'prisma/schema.sqlite.prisma'
const MODEL_RE = /^model\s+(\w+)/gm
function models(path) {
  if (!fs.existsSync(path)) { console.error(`ERROR: ni mogoče prebrati ${path} (datoteka manjka?)`); process.exit(2) }
  return new Set([...fs.readFileSync(path, 'utf8').matchAll(MODEL_RE)].map((m) => m[1]))
}
const pg = models(SRC), lite = models(DST)
const missingInSqlite = [...pg].filter((m) => !lite.has(m)).sort()
const missingInPg = [...lite].filter((m) => !pg.has(m)).sort()
console.log(`schema.prisma: ${pg.size} modelov · schema.sqlite.prisma: ${lite.size} modelov`)
if (!missingInSqlite.length && !missingInPg.length) { console.log('OK: seznam modelov je usklajen (brez drifta).'); process.exit(0) }
if (missingInSqlite.length) {
  console.log(`DRIFT: ${missingInSqlite.length} modelov MANJKA v prisma/schema.sqlite.prisma:`)
  for (const m of missingInSqlite) console.log(`  - ${m}`)
  console.log('  → regeneriraj zrcalo: python3 scripts/build-sqlite-mirror.py')
}
if (missingInPg.length) {
  console.log(`DRIFT: ${missingInPg.length} modelov obstaja SAMO v schema.sqlite.prisma (manjkajo v schema.prisma):`)
  for (const m of missingInPg) console.log(`  - ${m}`)
}
console.log('FAIL: schema drift — usklajuj obe shemi pred merge.')
process.exit(1)
