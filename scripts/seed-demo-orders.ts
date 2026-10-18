/**
 * DEMO NAROČILA (v1.141.0 — KDS odbrojevalni časovnik + mize statusi):
 * Ustvari nekaj aktivnih naročil z RAZLIČNIMI starostmi (2/8/20/35 min), da
 * KDS pokaže vse razrede odbrojevalnika (sveže/opozorilo/urgentno/zamuda)
 * in mize pokažejo zasedene/v pripravi. Samo lokacije z menijem in mizami;
 * idempotentno preskoči, če lokacija že ima aktivna naročila.
 */
import { db } from '../src/lib/db'

const nid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const mins = (m: number) => new Date(Date.now() - m * 60_000)

async function main() {
  const locs = await db.location.findMany({ select: { id: true, name: true } })
  let made = 0
  for (const loc of locs) {
    const active = await db.order.count({ where: { locationId: loc.id, status: { in: ['open', 'sent', 'prepared'] } } })
    if (active > 0) continue
    const menu = await db.menu.findFirst({ where: { locationId: loc.id, isActive: true }, include: { Category: { include: { MenuItem: true } } } })
    if (!menu || menu.Category.length === 0) continue
    const tables = await db.table.findMany({ where: { locationId: loc.id }, orderBy: { number: 'asc' } })
    if (tables.length === 0) continue
    const allItems = menu.Category.flatMap((c) => c.MenuItem)
    if (allItems.length === 0) continue
    const maxNum = (await db.order.findFirst({ orderBy: { orderNumber: 'desc' }, select: { orderNumber: true } }))?.orderNumber ?? 41000
    // 4 naročila: 3 min (sveže), 9 min (opozorilo), 19 min (zamuda), 34 min (zamuda+)
    const specs = [
      { age: 3, tables: [tables[0]], itemCount: 2, itemStatus: 'fired' },
      { age: 9, tables: [tables[1]], itemCount: 3, itemStatus: 'fired' },
      { age: 19, tables: [tables[2]], itemCount: 2, itemStatus: 'preparing' },
      { age: 34, tables: [tables[3] ?? tables[0]], itemCount: 4, itemStatus: 'fired' },
    ]
    for (const [i, sp] of specs.entries()) {
      const picks = allItems.slice(i * 2, i * 2 + sp.itemCount)
      if (picks.length === 0) continue
      const subtotal = picks.reduce((s, it) => s + Number(it.price), 0)
      const tax = Math.round(subtotal * 0.22 * 100) / 100
      const order = await db.order.create({
        data: {
          id: nid('ord'),
          orderNumber: maxNum + 1 + i,
          type: 'dine-in',
          status: 'sent',
          tableId: sp.tables[0]?.id,
          subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100,
          splitCount: 2,
          locationId: loc.id,
          createdAt: mins(sp.age),
          updatedAt: mins(sp.age),
          firedAt: mins(sp.age),
        },
      })
      for (const [j, it] of picks.entries()) {
        await db.orderItem.create({
          data: {
            id: nid('item'),
            orderId: order.id,
            menuItemId: it.id,
            quantity: j === 0 ? 2 : 1,
            price: Number(it.price),
            vatRate: Number(it.vatRate ?? 22),
            menuItemName: it.name,
            status: j === 0 ? sp.itemStatus : 'fired',
            createdAt: mins(sp.age),
            firedAt: mins(sp.age),
          },
        })
      }
      made++
    }
    if (made >= 8) break // 2 lokaciji sta dovolj za demo
  }
  console.log(`✅ Demo naročila: ${made}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => { return (db as unknown as { $disconnect: () => Promise<void> }).$disconnect() })
