/**
 * Issue #11 §8 — validate-migration: preveri pripravljenost sheme za migracijo.
 * Poganjanje: bun scripts/validate-migration.ts  (izhod 0 = OK, 1 = napaka)
 * Preveri: prisma validate na obeh shemah, drift (modeli), obvezni modeli
 * (enterprise + EventLog + PrintJob), pariteta enumov med shemama.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REQUIRED_MODELS = ['Organization', 'Brand', 'Property', 'Workstation', 'EventLog', 'PrintJob', 'RevenueCenter', 'Location']

function models(path: string): Set<string> {
  return new Set([...readFileSync(path, 'utf8').matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]))
}
function enums(path: string): Set<string> {
  return new Set([...readFileSync(path, 'utf8').matchAll(/^enum\s+(\w+)/gm)].map((m) => m[1]))
}

let failed = false

// 1) prisma validate (obe shemi)
for (const schema of ['prisma/schema.prisma', 'prisma/schema.sqlite.prisma']) {
  const r = spawnSync('bunx', ['prisma', 'validate', `--schema=${schema}`], { encoding: 'utf8' })
  if (r.status === 0) {
    console.log(`✓ prisma validate: ${schema}`)
  } else {
    console.error(`✗ prisma validate: ${schema}\n${r.stderr || r.stdout}`)
    failed = true
  }
}

// 2) drift (modeli + enumi)
const pgM = models('prisma/schema.prisma')
const liteM = models('prisma/schema.sqlite.prisma')
const missingLite = [...pgM].filter((m) => !liteM.has(m))
const missingPg = [...liteM].filter((m) => !pgM.has(m))
if (missingLite.length || missingPg.length) {
  console.error(`✗ drift modelov: manjka v sqlite=${missingLite} v pg=${missingPg}`)
  failed = true
} else {
  console.log(`✓ modeli usklajeni (${pgM.size})`)
}

const pgE = enums('prisma/schema.prisma')
const liteE = enums('prisma/schema.sqlite.prisma')
const missingEnum = [...pgE].filter((e) => !liteE.has(e))
if (missingEnum.length) {
  // sqlite zrcalo po dogovoru enumov NIMA (String polja) — to je pričakovano,
  // opozorilo samo, če sqlite hoče enum, ki ga pg nima
  const extra = [...liteE].filter((e) => !pgE.has(e))
  if (extra.length) {
    console.error(`✗ sqlite enumi, ki jih pg nima: ${extra}`)
    failed = true
  } else {
    console.log(`~ enumi: pg=${pgE.size}, sqlite zrcalo brez enumov (po dogovoru) — pg enumi manjkajoči v sqlite (pričakovano): ${missingEnum.length}`)
  }
}

// 3) obvezni modeli (enterprise faza 1)
const missingRequired = REQUIRED_MODELS.filter((m) => !pgM.has(m))
if (missingRequired.length) {
  console.error(`✗ obvezni modeli manjkajo v schema.prisma: ${missingRequired}`)
  failed = true
} else {
  console.log(`✓ obvezni modeli prisotni (${REQUIRED_MODELS.length})`)
}

// 4) nova vloga v enumu EmployeeRole (pg)
const pgSrc = readFileSync('prisma/schema.prisma', 'utf8')
const roleMatch = pgSrc.match(/enum EmployeeRole \{([^}]*)\}/)
const roles = roleMatch ? roleMatch[1].split('\n').map((s) => s.trim()).filter(Boolean) : []
const needRoles = ['group_owner', 'org_admin', 'property_manager', 'warehouse', 'accounting']
const missingRoles = needRoles.filter((r) => !roles.includes(r))
if (missingRoles.length) {
  console.error(`✗ EmployeeRole manjka: ${missingRoles}`)
  failed = true
} else {
  console.log(`✓ EmployeeRole: ${roles.length} vlog (vključno enterprise)`)
}

if (failed) process.exit(1)
console.log('\nMIGRACIJA: pripravljena ✓')
process.exit(0)
