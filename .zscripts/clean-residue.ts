// enkratno čiščenje ostankov založenega teka (v238 Zaloga + transakcije)
import { db } from '../src/lib/db'
async function main() {
  const items = await db.inventoryItem.findMany({ where: { name: { startsWith: 'v238-' } }, select: { id: true } })
  for (const it of items) {
    await db.stockTransaction.deleteMany({ where: { inventoryItemId: it.id } })
    await db.inventoryItem.deleteMany({ where: { id: it.id } })
  }
  console.log(`pobrisanih artiklov: ${items.length}`)
}
main().finally(() => db.$disconnect())
