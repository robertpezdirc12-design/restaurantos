import { PrismaClient } from '@prisma/client'
import { TEST_PREFIXES } from '../tests/helpers/fixture-sweep'
const db = new PrismaClient()
function pref(v: string): string { for (const p of TEST_PREFIXES) if (v.startsWith(p) || v.includes(p)) return p; return '?' }
async function main() {
  const hits: Record<string, number> = {}
  for (const a of await db.auditLog.findMany({ select: { userId: true, details: true, timestamp: true } })) {
    const p = pref(a.userId || '') || pref(a.details || '')
    if (p !== '?') { hits[p] = (hits[p] || 0) + 1 }
  }
  console.log(JSON.stringify(hits))
  const last = await db.auditLog.findMany({ orderBy: { timestamp: 'desc' }, take: 3, select: { action: true, userId: true, timestamp: true } })
  for (const r of last) console.log(`${r.timestamp.toISOString()} ${r.action} userId=${(r.userId || '').slice(0, 24)}`)
}
main().finally(() => db.$disconnect())
