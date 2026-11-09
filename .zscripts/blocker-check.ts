import { PrismaClient } from '@prisma/client'
import { TEST_PREFIXES } from '../tests/helpers/fixture-sweep'
const db = new PrismaClient()
async function main() {
  const items = await db.inventoryItem.findMany({ where: { OR: TEST_PREFIXES.map(p => ({ name: { startsWith: p } })) }, select: { id: true, name: true } })
  console.log(`predponsko-poimenovanih artiklov: ${items.length}`)
  for (const it of items) {
    const stx = await db.stockTransaction.count({ where: { inventoryItemId: it.id } })
    const batch = await db.inventoryBatch.count({ where: { inventoryItemId: it.id } })
    const recipe = await db.recipeItem.count({ where: { inventoryItemId: it.id } })
    const alloc = await db.stockBatchAllocation.count({ where: { StockTransaction: { inventoryItemId: it.id } } }).catch(() => -1)
    console.log(`  ${it.name.slice(0,40)} → stx=${stx} batch=${batch} recipe=${recipe} alloc=${alloc}`)
    if (stx > 0) {
      const rows = await db.stockTransaction.findMany({ where: { inventoryItemId: it.id }, select: { employeeName: true, employeeId: true } })
      console.log(`    stx employeeNames: ${JSON.stringify(rows.map(r => ({ n: r.employeeName?.slice(0,25), e: r.employeeId?.slice(0,25) })))}`)
    }
  }
}
main().finally(() => db.$disconnect())
