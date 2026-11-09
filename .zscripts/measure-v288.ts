// v1.288.0 meritve: DMMF pregled vseh tabel + vrstice
import { PrismaClient, Prisma } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const models = Prisma.dmmf.datamodel.models
  const out: string[] = []
  let total = 0
  for (const m of models) {
    try {
      const count = await (db as any)[m.name].count()
      if (count > 0) { out.push(`${m.name}: ${count}`); total += count }
    } catch { /* ignore */ }
  }
  console.log('=== TABELE Z VRSTICAMI (živa dev baza) ===')
  console.log(out.sort((a: string, b: string) => parseInt(b.split(': ')[1]) - parseInt(a.split(': ')[1])).join('\n'))
  console.log(`\nSKUPAJ modelov: ${models.length}, z vrsticami: ${out.length}, vrstic skupaj: ${total}`)
}
main().finally(() => db.$disconnect())
