import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const locIds = new Set((await db.location.findMany({ select: { id: true } })).map((l) => l.id))
  const counters = await db.counter.findMany({ select: { name: true } })
  let dead = 0, live = 0
  const other: string[] = []
  for (const c of counters) {
    const m = /^(order|receipt):(.+)$/.exec(c.name)
    if (!m) { other.push(c.name); continue }
    if (locIds.has(m[2])) live++; else { dead++; console.log(`  MRTEV: ${c.name}`) }
  }
  console.log(`števci: ${counters.length} = mrtve ${dead} + žive ${live} + nelokacijski ${other.length} (${other.join(', ')})`)
}
main().finally(() => db.$disconnect())
