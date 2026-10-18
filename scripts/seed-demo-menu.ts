/**
 * DEMO MENI (v1.141.0 — vizualni benchmark Toast/Square):
 * Večina lokacij v dev DB NIMA menija/kategorij/artiklov → POS mreža prazna,
 * kompaktni grid ne more pokazati gostote. Skripta doda realističen demo meni
 * VSAKI lokaciji brez menija:
 *   - pripravljalni postaji Kuhinja + Šank (BAR → KDS filtriranje deluje)
 *   - meni "Glavni meni" + 6 kategorij
 *   - ~30 artiklov s slovenskimi imeni in realnimi cenami
 * Idempotentno: lokacije z obstoječim menijem so preskočene.
 */
import { db } from '../src/lib/db'

type Item = { name: string; price: number; cat: string; bar?: boolean }

const MENU: { cat: string; icon: string; color: string }[] = [
  { cat: 'Predjedi', icon: '🥗', color: '#10b981' },
  { cat: 'Glavne jedi', icon: '🍽️', color: '#f59e0b' },
  { cat: 'Pice', icon: '🍕', color: '#ef4444' },
  { cat: 'Burgerji', icon: '🍔', color: '#f97316' },
  { cat: 'Dezerti', icon: '🍰', color: '#ec4899' },
  { cat: 'Pijače', icon: '🥤', color: '#14b8a6' },
]

const ITEMS: Item[] = [
  { name: 'Bruskete s paradižnikom', price: 6.5, cat: 'Predjedi' },
  { name: 'Kozice v česnovem maslu', price: 9.9, cat: 'Predjedi' },
  { name: 'Gobova juha', price: 4.5, cat: 'Predjedi' },
  { name: 'Pršut in sir', price: 12.0, cat: 'Predjedi' },
  { name: 'Telečji zrezek', price: 18.5, cat: 'Glavne jedi' },
  { name: 'Losos na žaru', price: 21.0, cat: 'Glavne jedi' },
  { name: 'Goveji golaž', price: 14.5, cat: 'Glavne jedi' },
  { name: 'Piščanec Stir-fry', price: 13.9, cat: 'Glavne jedi' },
  { name: 'Veganski rižot', price: 12.9, cat: 'Glavne jedi' },
  { name: 'Testenine Bolognese', price: 12.5, cat: 'Glavne jedi' },
  { name: 'Testenine s kozicami', price: 15.5, cat: 'Glavne jedi' },
  { name: 'Margherita', price: 8.9, cat: 'Pice' },
  { name: 'Pizza Capricciosa', price: 11.5, cat: 'Pice' },
  { name: 'Pizza Quattro formaggi', price: 12.9, cat: 'Pice' },
  { name: 'Pizza Prosciutto', price: 12.5, cat: 'Pice' },
  { name: 'Pizza Vegetariana', price: 10.9, cat: 'Pice' },
  { name: 'Pizza Calzone', price: 11.9, cat: 'Pice' },
  { name: 'Klasičen burger', price: 10.9, cat: 'Burgerji' },
  { name: 'Dvojni cheese burger', price: 13.9, cat: 'Burgerji' },
  { name: 'Pikantni burger', price: 11.9, cat: 'Burgerji' },
  { name: 'Chicken burger', price: 10.5, cat: 'Burgerji' },
  { name: 'Čokoladna torta', price: 5.5, cat: 'Dezerti' },
  { name: 'Tiramisu', price: 6.0, cat: 'Dezerti' },
  { name: 'Palačinke z nutello', price: 5.9, cat: 'Dezerti' },
  { name: 'Sadna skleda', price: 4.9, cat: 'Dezerti' },
  { name: 'Domače pivo 0.5', price: 4.5, cat: 'Pijače', bar: true },
  { name: 'Uvozno vino 0.2', price: 3.5, cat: 'Pijače', bar: true },
  { name: 'Coca cola 0.33', price: 2.9, cat: 'Pijače', bar: true },
  { name: 'Radenska 0.5', price: 2.5, cat: 'Pijače', bar: true },
  { name: 'Espresso', price: 1.8, cat: 'Pijače', bar: true },
  { name: 'Kava z mlekom', price: 2.2, cat: 'Pijače', bar: true },
  { name: 'Cocktail Margarita', price: 8.5, cat: 'Pijače', bar: true },
  { name: 'Aperol spritz', price: 7.5, cat: 'Pijače', bar: true },
]

const nid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

async function main() {
  const locs = await db.location.findMany({ select: { id: true, name: true } })
  let menusCreated = 0
  let itemsCreated = 0
  for (const loc of locs) {
    const existing = await db.menu.count({ where: { locationId: loc.id } })
    if (existing > 0) continue
    // pripravljalni postaji (kuhinja + šank) — stationToUI daje KITCHEN/BAR
    const kitchen = await db.prepStation.create({
      data: { id: nid('st'), name: 'Kuhinja', type: 'kitchen', avgPrepTime: 15, locationId: loc.id },
    })
    const bar = await db.prepStation.create({
      data: { id: nid('st'), name: 'Šank', type: 'bar', avgPrepTime: 5, locationId: loc.id },
    })
    const menu = await db.menu.create({
      data: { id: nid('menu'), name: 'Glavni meni', locationId: loc.id, isActive: true },
    })
    menusCreated++
    let order = 0
    for (const c of MENU) {
      const cat = await db.category.create({
        data: { id: nid('cat'), name: c.cat, icon: c.icon, color: c.color, sortOrder: order++, menuId: menu.id },
      })
      for (const it of ITEMS.filter((x) => x.cat === c.cat)) {
        await db.menuItem.create({
          data: {
            id: nid('item'),
            name: it.name,
            price: it.price,
            isAvailable: true,
            sortOrder: order,
            vatRate: it.bar ? 9.5 : 22,
            categoryId: cat.id,
            prepStationId: it.bar ? bar.id : kitchen.id,
          },
        })
        itemsCreated++
      }
    }
  }
  console.log(`✅ Demo meniji: ${menusCreated} (artiklov: ${itemsCreated})`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => { return (db as unknown as { $disconnect: () => Promise<void> }).$disconnect() })
