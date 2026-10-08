/**
 * RestavrantOS seed — produkcijska shema (prisma/schema.sqlite.prisma lokalno /
 * prisma/schema.prisma produkcija). Zaženi: bun prisma/seed.ts
 */
import { PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
import { employeePinFields } from '../src/lib/auth'

const db = new PrismaClient()

/** Determinističen, trkaneprožen ID iz semena (sha1, 20 znakov) */
function nid(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 20)
}

async function main() {
  console.log('🌱 Seed začetek...')

  const locationId = nid('loc-main')
  const existing = await db.location.findUnique({ where: { id: locationId } })
  if (existing) {
    console.log('✅ Seed že izveden (lokacija obstaja) — preskok.')
    return
  }

  const location = await db.location.create({
    data: {
      id: locationId,
      name: 'RestavrantOS Ljubljana',
      code: 'LJU-01',
      type: 'restaurant',
      address: 'Slovenska cesta 1',
      city: 'Ljubljana',
      postCode: '1000',
      country: 'SI',
      phone: '+386 1 234 56 78',
      email: 'info@restaurantos.app',
      businessId: '1234567',
      taxId: 'SI12345678',
      registerNumber: 'BLG-001',
      premisesId: 'BLG001',
      fursEnvironment: 'test',
      currency: 'EUR',
      locale: 'sl-SI',
      isOpen: true,
      isActive: true,
    },
  })
  console.log('📍 Lokacija:', location.name)

  const employees = [
    { id: nid('emp-admin'), name: 'Ana Admin', email: 'admin@restaurantos.app', role: 'admin', pin: '1234' },
    { id: nid('emp-waiter'), name: 'Marko Natakar', email: 'natakar@restaurantos.app', role: 'staff', pin: '2345' },
    { id: nid('emp-kitchen'), name: 'Katarina Kuhinja', email: 'kuhinja@restaurantos.app', role: 'chef', pin: '3456' },
    { id: nid('emp-manager'), name: 'Mojca Vodja', email: 'vodja@restaurantos.app', role: 'manager', pin: '4567' },
  ]
  for (const e of employees) {
    const fields = employeePinFields(e.pin, e.email)
    await db.employee.create({
      data: {
        id: e.id,
        name: e.name,
        email: e.email,
        role: e.role as 'admin' | 'manager' | 'staff' | 'chef' | 'kitchen',
        status: 'active',
        locationId,
        pin: fields.pin,
        pinLookup: fields.pinLookup,
      },
    })
  }
  console.log('👥 Zaposleni:', employees.length)

  const menuId = nid('menu-main')
  await db.menu.create({
    data: { id: menuId, name: 'Glavni meni', icon: '🍽️', color: '#059669', locationId, isActive: true },
  })

  const stationKitchenId = nid('ps-kitchen')
  const stationBarId = nid('ps-bar')
  await db.prepStation.createMany({
    data: [
      { id: stationKitchenId, name: 'Kuhinja', type: 'kitchen', locationId },
      { id: stationBarId, name: 'Bar', type: 'bar', locationId },
    ],
  })

  const categories = [
    { id: nid('cat-jedi'), name: 'Glavne jedi', sortOrder: 1 },
    { id: nid('cat-predjedi'), name: 'Predjedi', sortOrder: 2 },
    { id: nid('cat-pijace'), name: 'Pijače', sortOrder: 3 },
    { id: nid('cat-sladice'), name: 'Sladice', sortOrder: 4 },
  ]
  for (const c of categories) {
    await db.category.create({
      data: { ...c, menuId, icon: '🍽️', color: '#059669' },
    })
  }

  const menuItems = [
    { id: nid('mi-burek'), name: 'Burek s sirom', price: 3.5, vatRate: 9.5, categoryId: categories[0].id, station: stationKitchenId, desc: 'Domač burek' },
    { id: nid('mi-rybica'), name: 'Zebra pečenka', price: 18.9, vatRate: 9.5, categoryId: categories[0].id, station: stationKitchenId, desc: 'Peljska pečenka z zelenjavo' },
    { id: nid('mi-kranjska'), name: 'Kranjska klobasa', price: 12.5, vatRate: 9.5, categoryId: categories[0].id, station: stationKitchenId, desc: 'S kislim zeljem in gorčico' },
    { id: nid('mi-rizota'), name: 'Morska rižota', price: 14.9, vatRate: 9.5, categoryId: categories[0].id, station: stationKitchenId, desc: 'Z kozicami in mušlami' },
    { id: nid('mi-supa'), name: 'Goveja juha', price: 4.5, vatRate: 9.5, categoryId: categories[1].id, station: stationKitchenId, desc: 'Z rezanci' },
    { id: nid('mi-salata'), name: 'Mešana solata', price: 6.9, vatRate: 9.5, categoryId: categories[1].id, station: stationKitchenId, desc: 'Sezonska' },
    { id: nid('mi-pivo'), name: 'Laško pivo 0,5l', price: 3.8, vatRate: 22, categoryId: categories[2].id, station: stationBarId, desc: 'Točeno' },
    { id: nid('mi-vino'), name: 'Cviček 1dl', price: 2.9, vatRate: 22, categoryId: categories[2].id, station: stationBarId, desc: 'Domače rdeče' },
    { id: nid('mi-kava'), name: 'Kava', price: 1.8, vatRate: 22, categoryId: categories[2].id, station: stationBarId, desc: 'Espresso' },
    { id: nid('mi-coca'), name: 'Coca-Cola 0,33l', price: 3.2, vatRate: 22, categoryId: categories[2].id, station: stationBarId, desc: 'Plastenka' },
    { id: nid('mi-palacinke'), name: 'Palačinke z nutello', price: 6.5, vatRate: 9.5, categoryId: categories[3].id, station: stationKitchenId, desc: 'Z oreščki' },
    { id: nid('mi-sarlota'), name: 'Kremna rezina', price: 4.9, vatRate: 9.5, categoryId: categories[3].id, station: stationKitchenId, desc: 'Bledska' },
  ]
  for (const m of menuItems) {
    await db.menuItem.create({
      data: {
        id: m.id,
        name: m.name,
        description: m.desc,
        price: m.price,
        vatRate: m.vatRate,
        categoryId: m.categoryId,
        prepStationId: m.station,
        isAvailable: true,
        sortOrder: 0,
      },
    })
  }
  console.log('🍽️ Artikli:', menuItems.length)

  const areas = [
    { area: 'Glavna dvorana', from: 1, to: 8 },
    { area: 'Bar', from: 9, to: 11 },
    { area: 'Terasa', from: 12, to: 14 },
  ]
  let tableCount = 0
  for (const a of areas) {
    for (let n = a.from; n <= a.to; n++) {
      await db.table.create({
        data: {
          id: nid(`tbl-${n}`),
          number: n,
          capacity: n % 3 === 0 ? 6 : 4,
          area: a.area,
          posX: 40 + (n % 4) * 120,
          posY: 40 + Math.floor((n - 1) / 4) * 100,
          status: 'available',
          locationId,
        },
      })
      tableCount++
    }
  }
  console.log('🪑 Mize:', tableCount)

  await db.restaurantSettings.create({
    data: {
      id: nid('settings-default'),
      name: 'RestavrantOS',
      address: 'Slovenska cesta 1',
      city: 'Ljubljana',
      postCode: '1000',
      phone: '+386 1 234 56 78',
      email: 'info@restaurantos.app',
      businessId: '1234567',
      taxId: 'SI12345678',
      registerNumber: 'BLG-001',
      fursEnvironment: 'test',
      defaultVatRate: 22,
      reducedVatRate: 9.5,
      currency: 'EUR',
      locale: 'sl-SI',
      country: 'SI',
      receiptFooter: 'Hvala za obisk! Prijava: admin@restaurantos.app',
    },
  })

  const supplierId = nid('sup-kmetija')
  await db.supplier.create({
    data: { id: supplierId, name: 'Kmetija Sonce', contactPerson: 'Jože Kmet', phone: '+386 41 111 222', city: 'Domžale', isActive: true },
  })
  await db.inventoryItem.createMany({
    data: [
      { id: nid('inv-moka'), name: 'MokaTip 500', unit: 'kg', quantity: 45, minQuantity: 10, costPerUnit: 1.2, supplier: 'Kmetija Sonce', locationId },
      { id: nid('inv-govedina'), name: 'Govedina (pleče)', unit: 'kg', quantity: 18, minQuantity: 5, costPerUnit: 11.5, supplier: 'Kmetija Sonce', locationId },
      { id: nid('inv-pivo'), name: 'Laško pivo 0,5l', unit: 'pcs', quantity: 240, minQuantity: 60, costPerUnit: 1.1, supplier: 'Kmetija Sonce', locationId },
    ],
  })

  await db.reservation.create({
    data: {
      id: nid('res-demo'),
      customerName: 'Družina Novak',
      customerPhone: '+386 40 123 456',
      dateTime: new Date(Date.now() + 2 * 3600_000),
      partySize: 4,
      status: 'confirmed',
      source: 'phone',
      locationId,
      tableId: nid('tbl-3'),
    },
  })

  await db.deviceRegistry.create({
    data: { id: nid('dev-pos1'), deviceId: 'POS-LJU-001', name: 'Blagajna 1', type: 'pos', status: 'online', locationId },
  })

  console.log('🎉 Seed končan. Prijava: admin@restaurantos.app / PIN 1234')
}

main()
  .catch((e) => {
    console.error('❌ Seed napaka:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
