// v1.288.0: podrobni izpisi eventLog payload / auditLog details / journal parov
import { PrismaClient } from '@prisma/client'
import { TEST_PREFIXES } from '../tests/helpers/fixture-sweep'
const db = new PrismaClient()
function findPrefix(v: string): string | null {
  for (const p of TEST_PREFIXES) if (v.includes(p)) return p
  return null
}
async function main() {
  console.log('=== EVENTLOG payload analiza ===')
  for (const e of await db.eventLog.findMany()) {
    const p = findPrefix(e.payload || '')
    if (p) console.log(`  ${e.type} entityId=${e.entityId?.slice(0,12)} loc=${e.locationId?.slice(0,14)} prefix=${p} payload=${(e.payload||'').slice(0,130)}`)
  }
  console.log('\n=== AUDITLOG details analiza (samo prefixed) ===')
  const dHits: Record<string, number> = {}
  for (const a of await db.auditLog.findMany()) {
    const p = findPrefix(a.details || '')
    if (p) dHits[p] = (dHits[p] || 0) + 1
  }
  console.log('  ' + JSON.stringify(dHits))
  console.log('\n=== JOURNAL par (entry + line) ===')
  for (const j of await db.journalEntry.findMany()) {
    console.log(`  entry id=${j.id.slice(0,12)} date=${j.date instanceof Date ? j.date.toISOString().slice(0,10) : j.date} source=${(j as any).source} doc=${(j as any).documentNumber} locId=${(j as any).locationId}`)
  }
  for (const l of await db.journalLine.findMany({ take: 3 })) {
    console.log(`  line id=${l.id.slice(0,10)} entry=${l.journalEntryId.slice(0,10)} code=${l.accountCode} locId=${l.locationId?.slice(0,16)} desc=${(l as any).description?.slice(0,40)}`)
  }
  console.log('\n=== GUESTFEEDBACK polna vrstica ===')
  const g = await db.guestFeedback.findFirst()
  if (g) console.log(JSON.stringify(g).slice(0, 400))
}
main().finally(() => db.$disconnect())
