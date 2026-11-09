// v1.288.0 globji pregled: klasifikacija post-suite vrstic po predponski prisotnosti
import { PrismaClient, Prisma } from '@prisma/client'
const db = new PrismaClient()

// TEST_PREFIXES iz fixture-sweep (centralna resnica) — dynamic import ne deluje v bun scripti, uporabimo read
import { TEST_PREFIXES } from '../tests/helpers/fixture-sweep'

async function main() {
  const models = Prisma.dmmf.datamodel.models
  const report: string[] = []
  for (const m of models) {
    let total = 0
    try { total = await (db as any)[m.name].count() } catch { continue }
    if (total === 0) continue
    const fields = m.fields.filter(f => f.kind === 'scalar')
    const strFields = fields.filter(f => ['String', 'String?'].includes(f.type) || f.type.includes('String')).map(f => f.name)
    // vzorci za contains iskanje (Counter receipt:<prefix>-...) — samo znane skalarno-besedilne
    const rows = await (db as any)[m.name].findMany()
    let prefixed = 0, clean = 0
    const prefixedSamples: string[] = []
    for (const row of rows) {
      let isPrefixed = false
      for (const [k, v] of Object.entries(row)) {
        if (typeof v !== 'string') continue
        for (const p of TEST_PREFIXES) {
          if (v.startsWith(p) || v.includes(p)) { isPrefixed = true; break }
        }
        if (isPrefixed) break
      }
      if (isPrefixed) {
        prefixed++
        if (prefixedSamples.length < 3) prefixedSamples.push(JSON.stringify(row).slice(0, 160))
      } else clean++
    }
    report.push(`${m.name}: skupaj=${total} PREDPONSKIH=${prefixed} ČISTIH=${clean}`)
    if (prefixed > 0) prefixedSamples.forEach(s => report.push(`   ☞ ${s}`))
  }
  console.log(report.join('\n'))
}
main().finally(() => db.$disconnect())
