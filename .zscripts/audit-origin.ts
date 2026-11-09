import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const rows = await db.auditLog.findMany({ where: { userId: { startsWith: 'disc59-' } }, select: { action: true, entityType: true, timestamp: true, locationId: true }, take: 25 })
  const acts: Record<string, number> = {}
  for (const r of rows) { const k = `${r.action}/${r.entityType}`; acts[k] = (acts[k] || 0) + 1; if (acts[k] === 1) console.log(`  action=${r.action} entityType=${r.entityType} loc=${r.locationId?.slice(0,16)} at=${r.timestamp.toISOString()}`) }
  console.log('skupaj disc59-userId:', rows.length, JSON.stringify(acts))
  const last = await db.auditLog.findMany({ orderBy: { timestamp: 'desc' }, take: 6, select: { action: true, userId: true, timestamp: true } })
  console.log('zadnjih 6 auditLog:')
  for (const r of last) console.log(`  ${r.timestamp.toISOString()} action=${r.action} userId=${(r.userId || '').slice(0,22)}`)
}
main().finally(() => db.$disconnect())
