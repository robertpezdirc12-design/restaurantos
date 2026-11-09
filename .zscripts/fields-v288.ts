// v1.288.0 globji pregled: točno KATERA polja nosijo predpono
import { PrismaClient } from '@prisma/client'
import { TEST_PREFIXES } from '../tests/helpers/fixture-sweep'
const db = new PrismaClient()

async function analyze(model: string) {
  const rows = await (db as any)[model].findMany()
  const fieldHits: Record<string, number> = {}
  const samples: Record<string, string> = {}
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== 'string') continue
      for (const p of TEST_PREFIXES) {
        if (v.startsWith(p) || v.includes(p)) {
          fieldHits[k] = (fieldHits[k] || 0) + 1
          if (!samples[k]) samples[k] = `${k}="${v.slice(0, 60)}"`
          break
        }
      }
    }
  }
  const locNull = rows.filter((r: any) => r.locationId === null).length
  const locSet = rows.filter((r: any) => typeof r.locationId === 'string' && r.locationId !== null).length
  console.log(`\n=== ${model} (${rows.length} vrstic; locationId: null=${locNull}, set=${locSet}) ===`)
  for (const [f, n] of Object.entries(fieldHits).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${f}: ${n}× — ${samples[f]}`)
  }
}
async function main() {
  for (const m of ['guestFeedback', 'haccpAction', 'integration', 'inventoryItem', 'reservation', 'journalLine', 'stockTransaction', 'eventLog', 'auditLog']) {
    await analyze(m)
  }
}
main().finally(() => db.$disconnect())
