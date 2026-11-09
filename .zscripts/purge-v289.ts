// v1.289.0: izprazni VSE tabele na mestu (datoteka ostane — varno za tekoči dev strežnik)
// namen: čist baseline po onesnaženem teku pod bun 1.3.14 (osmi reset peskovnika)
import { PrismaClient, Prisma } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const models = Prisma.dmmf.datamodel.models
  // otroci prvi (FK Restrict), nato starši — več poskusov po topološki iteraciji
  const imena = models.map((m) => m.name)
  for (let krog = 0; krog < 8; krog++) {
    let ostalo = 0
    for (const ime of imena) {
      try {
        const r = await (db as any)[ime].deleteMany({})
        ostalo += r.count
      } catch { /* FK blokada — naslednji krog */ }
    }
    if (ostalo === 0) break
    if (krog === 7) console.log(`POZOR: po 8 krogih še vedno brisalo (zadnji krog: ${ostalo})`)
  }
  let skupaj = 0
  let praznih = 0
  for (const m of models) {
    try {
      const c = await (db as any)[m.name].count()
      if (c > 0) { console.log(`OSTANEK ${m.name}: ${c}`); skupaj += c } else praznih++
    } catch { /* ignore */ }
  }
  console.log(`modelov: ${models.length}, praznih: ${praznih}, ostankov: ${skupaj}`)
}
main().finally(() => db.$disconnect())
