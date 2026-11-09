// v1.288.0 ENKRATNI REMEDY: števci zaporedij, ki referencirajo IZBRISANE lokacije
// (strukturani kriterij — dokaz je mrtev id v imenu; vzorec TipPool remedy v1.286.0)
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const locIds = new Set((await db.location.findMany({ select: { id: true } })).map((l) => l.id))
  const counters = await db.counter.findMany({ select: { id: true, name: true, value: true } })
  const dead = counters.filter((c) => {
    const m = /^(order|receipt):(.+)$/.exec(c.name)
    return m !== null && !locIds.has(m[2])
  })
  const live = counters.filter((c) => {
    const m = /^(order|receipt):(.+)$/.exec(c.name)
    return m !== null && locIds.has(m[2])
  })
  console.log('ŽIVE lokacije:', locIds.size, '— demo:', [...locIds][0])
  console.log(`Števci skupaj: ${counters.length}; z lokacijsko predpono: ${dead.length + live.length} (mrtve: ${dead.length}, žive: ${live.length})`)
  for (const d of dead) console.log(`  BRIŠEM ${d.name} (vrednost ${d.value})`)
  for (const l of live) console.log(`  OHRANIM ${l.name}`)
  const other = counters.filter((c) => !/^(order|receipt):/.test(c.name))
  for (const o of other) console.log(`  NEDOTIČNJEN (ni lokacijski) ${o.name}`)
  if (dead.length > 0) {
    const res = await db.counter.deleteMany({ where: { id: { in: dead.map((d) => d.id) } } })
    console.log(`POBRISANIH: ${res.count}`)
  }
}
main().finally(() => db.$disconnect())
