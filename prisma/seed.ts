import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'

const db = new PrismaClient()

function pinHash(pin: string, salt: string) {
  return crypto.scryptSync(pin, salt, 32).toString('hex')
}

async function main() {
  const loc = await db.location.create({ data: { name: 'RestaurantOS Ljubljana', city: 'Ljubljana', address: 'Slovenska cesta 1', phone: '+386 1 234 56 78', currency: 'EUR' } })

  const mkEmp = async (name: string, email: string, role: string, pin: string) => {
    const salt = crypto.randomBytes(16).toString('hex')
    return db.employee.create({ data: { locationId: loc.id, name, email, role, pinSalt: salt, pinHash: pinHash(pin, salt) } })
  }
  await mkEmp('Robert Pezdirc', 'admin@restaurantos.app', 'ADMIN', '1234')
  await mkEmp('Ana Kovač', 'natakarica@restaurantos.app', 'WAITER', '1111')
  await mkEmp('Kuhinja', 'kuhinja@restaurantos.app', 'KITCHEN', '2222')

  const zones = ['Glavna dvorana', 'Terasa', 'Bar']
  const names = ['T1','T2','T3','T4','T5','T6','B1','B2','P1','P2','P3','P4','P5','P6']
  for (let i = 0; i < names.length; i++) {
    const zone = i < 6 ? zones[0] : i < 8 ? zones[2] : zones[1]
    await db.table.create({ data: { locationId: loc.id, name: names[i], zone, seats: 2 + (i % 4), posX: (i % 6) * 120 + 40, posY: Math.floor(i / 6) * 100 + 40 } })
  }

  const cats = [
    { name: 'Predjedi', items: [['Šparaška juha', 4.5], ['Kraški pršut', 9.8], ['Jajca v senčki', 6.9]] },
    { name: 'Glavne jedi', items: [['Kranjska klobasa', 12.5], ['Bujta repa', 11.9], ['Zrezek v parmezanu', 18.9], ['Šampionska rižota', 13.5]] },
    { name: 'Pijače', items: [['Union pivo 0,5l', 3.8], ['Zeleno štrukljev sok', 3.2], ['Kava', 1.8], ['Cviček 1dl', 2.4]] },
    { name: 'Sladice', items: [['Potica', 4.2], ['Prekmurska gibanica', 4.8]] },
  ] as const
  for (let c = 0; c < cats.length; c++) {
    const cat = await db.category.create({ data: { name: cats[c].name, sortOrder: c } })
    for (const [name, price] of cats[c].items) {
      await db.menuItem.create({ data: { categoryId: cat.id, name, price, taxRate: cats[c].name === 'Pijače' ? 22 : 9.5, station: cats[c].name === 'Pijače' ? 'BAR' : 'KITCHEN' } })
    }
  }

  await db.setting.createMany({ data: [
    { key: 'restaurant.name', value: 'RestaurantOS Ljubljana' },
    { key: 'restaurant.taxId', value: 'SI12345678' },
    { key: 'furs.environment', value: 'SIMULATION' },
    { key: 'app.version', value: '1.26.0' },
  ]})

  const t1 = await db.table.findFirst({ where: { name: 'T1' } })
  const waiter = await db.employee.findFirst({ where: { role: 'WAITER' } })
  const items = await db.menuItem.findMany({ take: 3 })
  if (t1 && waiter) {
    const subtotal = items.reduce((s, i) => s + i.price, 0)
    const order = await db.order.create({ data: { locationId: loc.id, tableId: t1.id, employeeId: waiter.id, status: 'OPEN', guests: 2, subtotal, tax: subtotal * 0.095, total: subtotal * 1.095 } })
    for (const it of items) await db.orderItem.create({ data: { orderId: order.id, menuItemId: it.id, name: it.name, qty: 1, unitPrice: it.price, taxRate: it.taxRate, station: it.station } })
  }
  console.log('SEED OK', loc.id)
}
main().finally(() => db.$disconnect())
