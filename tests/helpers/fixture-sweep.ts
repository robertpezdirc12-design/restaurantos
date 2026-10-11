import type { PrismaClient } from '@prisma/client'

/**
 * Task 58 — higiena testnih fiksur (samo dev SQLite).
 *
 * PROBLEM: če testni tek crasha ali proces umre PRED afterAll (npr. kill po
 * timeoutu, garblirana generacija), ostanejo fiksature z id-predpono v dev bazi.
 * Vidni učinek: prijavni zaslon (preview / dev) pokaže vrsto iso lokacij
 * (npr. 25× "rp1-Lokacija" iz tests/race-fixes-p1.test.ts), ker javni endpoint
 * /api/auth/locations izpiše vse aktivne lokacije. Produkcijska baza NI prizadeta
 * (lokalni testi tečejo proti file: SQLite; preverjeno 11.10.2026: Neon vrača
 * natanko 1 lokacijo "RestaurantOS Ljubljana").
 *
 * REŠITEV (samoceljiva disciplina):
 *  1. vsak DB-backed test PRED ustvarjanjem fiksur počisti ostanke ISTIH predpon
 *     od prejšnjih crashanih tekov (`sweepTestFixtures(db, [PREFIX])`);
 *  2. one-time skripta scripts/cleanup-test-fixtures.ts počisti vse znane predpone.
 *
 * VARNOSTNA KLJUČAVNICA: brisanje je dovoljeno IZKLJUČNO proti lokalni SQLite
 * datoteki (DATABASE_URL se začne z "file:"). Oddaljena baza (npr. Neon Postgres
 * v produkciji) zavrnjena z napako — tudi če kdo pomotoma preusmeri env.
 *
 * BRISANJE je omejeno na vrstice, katerih id (oziroma znano alternativno polje)
 * se začne s testno predpono — realni (ne-testni) podatki so nedotaknjeni.
 * Vrstni red: otroci → starši (FK), trije prehodi:
 *  1. blok prehod po id (+ znana alternativna polja entityId/inventoryItemId),
 *  2. odkleni prehod po locationId (aplikacijsko ustvarjeni otroci testnih
 *     lokacij, npr. Receipt/Payment, ki imajo samodejne id-je brez predpone),
 *  3. ponovni prehod po id (ovire so zdaj odstranjene).
 * Napake posamezne tabele se zberejo in sporočijo; brisanje ne ustavi testov.
 */

/** Vse testne id-predpone (iz `const PREFIX`/`const P` v tests/*.test.ts). */
export const TEST_PREFIXES = [
  'rp1-', // race-fixes-p1
  'rfix-', // race-fixes
  'rbac-p2-', // rbac-p2
  '33a-', // orders-move-merge-fire
  '33c-', // audit-chain
  'uc-', // unique-collision
  'gfb-', // guest-feedback
  'tst57-', // stocktake (Task 57)
  'stockded', // stock-deduction
  'zrepvat', // zreport-vat
  'furspost', // furs-post
  'storno-test-', // receipt-storno
  'torg-', // tenant-org
  'torgl-', // tenant-org-list
] as const

/** Zaustavi izvajanje, če DATABASE_URL ni lokalna SQLite datoteka. */
export function assertDevDatabase(): void {
  const url = process.env.DATABASE_URL || ''
  if (!url.startsWith('file:')) {
    throw new Error(
      `fixture-sweep: ZAVRJENO — DATABASE_URL ni lokalna SQLite datoteka ("${url.slice(0, 14)}…"). ` +
        'Čiščenje testnih fiksur se sme izvajati izključno proti dev SQLite (file:), nikoli proti oddaljeni/produkcijski bazi.',
    )
  }
}

export interface SweepResult {
  /** tabela → število izbrisanih vrstic (samo tabele z > 0) */
  tables: Record<string, number>
  /** napake posameznih tabel (npr. preostala FK ovira) */
  errors: string[]
  /** število PREOSTALIH testnih lokacij — mora biti 0 */
  remainingLocations: number
}

/**
 * Tabele brisane po id-predponi (oziroma `alt` polju), urejene otroci → starši.
 * `alt`: znano alternativno polje, ki nosi testno predpono namesto id-ja.
 */
const ID_SWEEP: Array<{ model: string; alt?: 'entityId' | 'inventoryItemId' }> = [
  // — evidence/revizija najprej (referencirajo vse druge) —
  { model: 'eventLog', alt: 'entityId' },
  { model: 'auditLog', alt: 'entityId' },
  { model: 'printJob' },
  { model: 'integrationLog' },
  { model: 'deviceSyncOperation' },
  { model: 'webhook' },
  { model: 'tipDistribution' },
  { model: 'tipPool' },
  { model: 'giftCardTransaction' },
  { model: 'giftCard' },
  { model: 'loyaltyTransaction' },
  { model: 'loyaltyAccount' },
  { model: 'payment' },
  { model: 'receipt' },
  { model: 'stockBatchAllocation' },
  { model: 'stockTransaction', alt: 'inventoryItemId' },
  { model: 'stocktakeItem' },
  { model: 'stocktake' },
  { model: 'inventoryBatch' },
  { model: 'inventoryItem' },
  { model: 'recipeItem' },
  { model: 'goodsReceipt' },
  { model: 'purchaseOrder' },
  { model: 'wasteRecord' },
  // — drevo naročil —
  { model: 'deliveryTracking' },
  { model: 'deliveryInfo' },
  { model: 'guestFeedback' },
  { model: 'reservation' },
  { model: 'waitlistEntry' },
  { model: 'check' },
  { model: 'orderItemModifier' },
  { model: 'orderItem' },
  { model: 'order' },
  { model: 'discount' },
  // — meni —
  { model: 'menuItemModifierGroup' },
  { model: 'modifier' },
  { model: 'modifierGroup' },
  { model: 'menuItem' },
  { model: 'category' },
  { model: 'menu' },
  // — oprema lokacij / osebje —
  { model: 'openingHours' },
  { model: 'specialOpeningDay' },
  { model: 'haccpEntry' },
  { model: 'prepStation' },
  { model: 'deliveryZone' },
  { model: 'table' },
  { model: 'counter' },
  { model: 'deviceRegistry' },
  { model: 'timeEntry' },
  { model: 'employeeJob' },
  { model: 'zReport' },
  { model: 'cashRegisterShift' },
  // — organizacijsko drevo + preostali starši —
  { model: 'supplierPriceHistory' },
  { model: 'supplier' },
  { model: 'integration' },
  { model: 'job' },
  { model: 'restaurantSettings' },
  { model: 'accountsPayable' },
  { model: 'employee' },
  // lokacija se briše ZADNJA (uspešnost = preverjena spodaj)
  { model: 'location' },
]

/**
 * Tabele z locationId: aplikacijsko ustvarjeni otroci testnih lokacij
 * (samodejni id-ji BREZ testne predpone) — brišejo se po locationId.
 */
const LOCATION_CHILD_SWEEP = [
  'employee',
  'menu',
  'table',
  'order',
  'cashRegisterShift',
  'zReport',
  'inventoryItem',
  'inventoryBatch',
  'stocktake',
  'deviceRegistry',
  'guestFeedback',
  'receipt',
  'timeEntry',
  'wasteRecord',
  'reservation',
  'waitlistEntry',
  'haccpEntry',
  'prepStation',
  'openingHours',
  'specialOpeningDay',
  'discount',
  'deliveryZone',
  'giftCard',
  'loyaltyAccount',
  'integration',
  'printJob',
] as const

type Delegate = { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> }

/**
 * Počisti vse vrstice z id-predpono (ali znano alternativo) iz `prefixes`.
 * Vrne povzetek; NIKOLI ne meče napak posameznih tabel (samo jih zbere).
 * Ključavnica assertDevDatabase() mora preiti — sicer vrže napako PREZ brisanja.
 */
export async function sweepTestFixtures(db: PrismaClient, prefixes: readonly string[]): Promise<SweepResult> {
  if (prefixes.length === 0) return { tables: {}, errors: [], remainingLocations: 0 }
  assertDevDatabase()

  const tables: Record<string, number> = {}
  const errors: string[] = []

  const dele = async (model: string, where: Record<string, unknown>): Promise<void> => {
    try {
      const delegate = (db as unknown as Record<string, Delegate | undefined>)[model]
      if (!delegate || typeof delegate.deleteMany !== 'function') {
        errors.push(`${model}: manjka delegat`)
        return
      }
      const res = await delegate.deleteMany({ where })
      if (process.env.SWEEP_DEBUG) console.log(`[sweep-dbg] ${model}:`, JSON.stringify(where), '→', res.count)
      if (res.count > 0) tables[model] = (tables[model] || 0) + res.count
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const msg = raw.trim().split('\n')[0] || String(e)
      errors.push(`${model}: ${msg}`)
    }
  }

  for (const p of prefixes) {
    // 1. blok prehod po id — otroci → starši, ŠE BREZ location:
    //    opciona relacija na Location je onDelete: SetNull — če bi lokacijo brisali
    //    prej, bi otrokom (npr. DeliveryZone z aplikacijskim id-jem) postavil
    //    locationId na NULL in jih prehod 2 ne bi več našel.
    for (const spec of ID_SWEEP) {
      if (spec.model === 'location') continue
      const or: Record<string, unknown>[] = [{ id: { startsWith: p } }]
      if (spec.alt) or.push({ [spec.alt]: { startsWith: p } })
      await dele(spec.model, { OR: or })
    }
    // 2. odkleni prehod po locationId — aplikacijsko ustvarjeni otroci testnih
    //    lokacij (samodejni id-ji brez predpone); lokacija ŠE obstaja
    for (const model of LOCATION_CHILD_SWEEP) {
      await dele(model, { locationId: { startsWith: p } })
    }
    // 3. ponovni prehod po id (BREZ location) — ovire so zdaj odstranjene
    for (const spec of ID_SWEEP) {
      if (spec.model === 'location') continue
      await dele(spec.model, { id: { startsWith: p } })
    }
    // 4. lokacija ZADNJA — uspeh pomeni, da ni več FK ovir
    await dele('location', { id: { startsWith: p } })
    // 5. varovalka: morebitni SetNull sirote ponovno po locationId, potem končni id prehod
    for (const model of LOCATION_CHILD_SWEEP) {
      await dele(model, { locationId: { startsWith: p } })
    }
  }

  let remainingLocations = 0
  try {
    remainingLocations = await db.location.count({
      where: { OR: prefixes.map((p) => ({ id: { startsWith: p } })) },
    })
  } catch {
    /* števec je informativen; napaka brisanja je že v errors */
  }

  return { tables, errors, remainingLocations }
}
