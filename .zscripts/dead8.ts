import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const locIds = new Set((await db.location.findMany({ select: { id: true } })).map((l) => l.id))
  for (const c of await db.counter.findMany({ select: { name: true, value: true } })) {
    const m = /^(order|receipt):(.+)$/.exec(c.name)
    if (m && !locIds.has(m[2])) console.log(`MRTEV ${c.name} vrednost=${c.value}`)
  }
}
main().finally(() => db.$disconnect())
