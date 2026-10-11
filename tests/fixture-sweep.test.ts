import { describe, expect, test } from 'bun:test'
import { db } from '../src/lib/db'
import { assertDevDatabase, sweepTestFixtures, TEST_PREFIXES, type SweepResult } from './helpers/fixture-sweep'

/**
 * Task 58 — regresija za počistnik testnih fiksur (tests/helpers/fixture-sweep.ts).
 *
 * Ozadje: crashani testni teki (kill pred afterAll) pustijo fiksature z id-predpono
 * v dev SQLite; javni /api/auth/locations jih izpiše na prijavnem zaslonu
 * (opazovano: 25× "rp1-Lokacija"). Počistnik je samoceljiv — vsak DB-backed test
 * poganja pre-sweep svoje predpone; ta datoteka preverja njegovo pravilnost:
 *  - briše IZKLJUČNO vrstice s testno predpono (tudi aplikacijsko ustvarjene
 *    otroke testnih lokacij po locationId),
 *  - realni podatki (lokacije brez testnih predpon) ostanejo nedotaknjeni,
 *  - ključavnica zavrne oddaljeno bazo (DATABASE_URL brez "file:").
 * Testne fiksature te datoteke uporabljajo lastno predpono `sweep58-` in jih
 * počistnik pobere še v primeru crasha tega teka (samo-celjivost).
 */

const P = 'sweep58-'
const RUN = Date.now().toString(36)

async function seedJunk(): Promise<void> {
  const locId = `${P}loc-${RUN}`
  await db.location.create({ data: { id: locId, name: `${P}Lokacija`, code: `SW58-${RUN.toUpperCase()}` } })
  const menu = await db.menu.create({ data: { id: `${P}menu-${RUN}`, name: `${P}Meni`, locationId: locId } })
  const cat = await db.category.create({ data: { id: `${P}cat-${RUN}`, name: `${P}Kategorija`, menuId: menu.id } })
  await db.menuItem.create({ data: { id: `${P}mi-${RUN}`, name: `${P}Jed`, price: 5, categoryId: cat.id } })
  await db.table.create({ data: { id: `${P}tbl-${RUN}`, number: 987654, locationId: locId } })
  const emp = await db.employee.create({
    data: { id: `${P}emp-${RUN}`, name: `${P}Natakar`, email: `${P}emp-${RUN}@test.local`, role: 'waiter', status: 'active', sessionVersion: 0, locationId: locId, pin: '99581', pinLookup: `${P}pl-${RUN}` },
  })
  const order = await db.order.create({
    data: { id: `${P}ord-${RUN}`, orderNumber: 987654, locationId: locId, tableId: null, status: 'open', paymentStatus: 'unpaid', subtotal: 0, tax: 0, total: 0 },
  })
  await db.orderItem.create({
    data: { id: `${P}itm-${RUN}`, orderId: order.id, menuItemId: `${P}mi-${RUN}`, quantity: 1, price: 5, vatRate: 22, vatAmount: 0, menuItemName: `${P}Jed`, status: 'pending', voided: false },
  })
  void emp
}

/** locationId otrok z aplikacijskim (naključnim) id-jem — pokaže odkleni prehod. */
async function seedAppChildAtTestLocation(): Promise<string> {
  const locId = `${P}loc-${RUN}`
  // DeliveryZone nosi locationId (schema) in ima v testih samodejni id
  // namenoma id BREZ testne predpone (kot aplikacijska koda) — čisti ga odkleni prehod po locationId
  const id = `${RUN}-auto-${Math.random().toString(36).slice(2, 8)}`
  await db.deliveryZone.create({ data: { id, name: `${P}Cona`, locationId: locId } })
  return id
}

async function countRealLocations(): Promise<number> {
  const all = await db.location.findMany({ select: { id: true } })
  return all.filter((l) => !TEST_PREFIXES.some((p) => l.id.startsWith(p))).length
}

describe('fixture-sweep — Task 58 (higiena testnih fiksur)', () => {
  test('briše vse fiksature s predpono, vključno z aplikacijskimi otroki testne lokacije', async () => {
    await seedJunk()
    const autoChildId = await seedAppChildAtTestLocation()

    // fiksature res obstajajo
    expect(await db.location.count({ where: { id: { startsWith: P } } })).toBe(1)
    expect(await db.menuItem.count({ where: { id: { startsWith: P } } })).toBe(1)
    expect(await db.deliveryZone.count({ where: { id: autoChildId } })).toBe(1)

    const res: SweepResult = await sweepTestFixtures(db, [P])

    expect(res.remainingLocations).toBe(0)
    expect(await db.location.count({ where: { id: { startsWith: P } } })).toBe(0)
    expect(await db.menu.count({ where: { id: { startsWith: P } } })).toBe(0)
    expect(await db.category.count({ where: { id: { startsWith: P } } })).toBe(0)
    expect(await db.menuItem.count({ where: { id: { startsWith: P } } })).toBe(0)
    expect(await db.table.count({ where: { id: { startsWith: P } } })).toBe(0)
    expect(await db.employee.count({ where: { id: { startsWith: P } } })).toBe(0)
    expect(await db.order.count({ where: { id: { startsWith: P } } })).toBe(0)
    expect(await db.orderItem.count({ where: { id: { startsWith: P } } })).toBe(0)
    // aplikacijski otrok (id brez predpone, locationId s predpono) je prav tako izbrisan
    expect(await db.deliveryZone.count({ where: { id: autoChildId } })).toBe(0)
  })

  test('realni podatki (brez testnih predpon) ostanejo nedotaknjeni', async () => {
    const before = await countRealLocations()
    expect(before).toBeGreaterThan(0) // dev seed: "RestavrantOS Ljubljana"
    const res = await sweepTestFixtures(db, TEST_PREFIXES)
    // v celotnem suitskem teku sme sweep pobrati ostanke crashanih tekov drugih
    // datotek (to je ŽELJENA samoceljivost) — zato stroge praznine ne uveljavljamo
    if (Object.keys(res.tables).length > 0) {
      console.log('[sweep58] pobrani ostanki:', JSON.stringify(res.tables))
    }
    // kritični zagotovili: lokacije počitšene, realni podatki nedotaknjeni
    expect(res.remainingLocations).toBe(0)
    const after = await countRealLocations()
    expect(after).toBe(before)
    // prava idempotenca: drugi sweep spet pusti 0 preostalih testnih lokacij
    const res2 = await sweepTestFixtures(db, TEST_PREFIXES)
    expect(res2.remainingLocations).toBe(0)
    const after2 = await countRealLocations()
    expect(after2).toBe(before)
  })

  test('ključavnica: oddaljena baza (DATABASE_URL brez "file:") je zavrnjena', () => {
    const orig = process.env.DATABASE_URL
    try {
      process.env.DATABASE_URL = 'postgresql://user:pass@neon.example/db?sslmode=require'
      expect(() => assertDevDatabase()).toThrow()
      process.env.DATABASE_URL = 'mysql://user@host/db'
      expect(() => assertDevDatabase()).toThrow()
      process.env.DATABASE_URL = ''
      expect(() => assertDevDatabase()).toThrow()
    } finally {
      process.env.DATABASE_URL = orig
    }
    // veljaven dev URL ne meče
    process.env.DATABASE_URL = 'file:/home/z/my-project/db/custom.db'
    expect(() => assertDevDatabase()).not.toThrow()
    process.env.DATABASE_URL = orig
  })

  test('FIELD_SWEEP: strežniški id (nid()) + predpona v besedilu + NULL lokacija → najden in izbrisan (Task 61 sirote)', async () => {
    await seedJunk()
    // AccountsPayable POST ruta ustvari id z nid() — simuliraj pošteno siroto:
    // naključen id, testna predpona v invoiceNumber/notes, locationId NULL (SetNull po izbrisu lokacije)
    const supplier = await db.supplier.create({
      data: { id: `${P}dob-fs`, name: `${P}Dobavitelj FS`, code: `FS-${Date.now().toString(36).toUpperCase()}` },
    })
    const ap = await db.accountsPayable.create({
      data: {
        id: `nid${Date.now().toString(36)}fs`, // strežniški vzorec — BREZ testne predpone
        apNumber: 'AP-FSWEEP-SIM',
        supplierId: supplier.id,
        invoiceNumber: `${P}FStrošek`,
        notes: `${P}FStrošek`,
        dueDate: new Date(),
        subtotal: 7,
        totalAmount: 7,
        locationId: null, // SetNull sirota — id- in lokacijski prehod je ne vidita
      },
    })
    expect(await db.accountsPayable.count({ where: { id: ap.id } })).toBe(1)

    const res: SweepResult = await sweepTestFixtures(db, [P])

    expect(res.errors).toEqual([])
    // FIELD_SWEEP prehod (6. faza) najde siroto po besedilnih poljih
    expect(await db.accountsPayable.count({ where: { id: ap.id } })).toBe(0)
    expect(await db.supplier.count({ where: { id: { startsWith: P } } })).toBe(0)
  })

  test('znane testne predpone so pokrite (uhajanje nove fiksurne datoteke = vidna lokacija na prijavi)', () => {
    for (const p of ['rp1-', 'rfix-', 'rbac-p2-', '33a-', '33c-', 'uc-', 'gfb-', 'tst57-', 'stockded', 'zrepvat', 'furspost', 'storno-test-', 'torg-', 'torgl-', 'disc59-', 'integ60-', 'exp61-', 'ent62-']) {
      expect(TEST_PREFIXES).toContain(p)
    }
  })
})
