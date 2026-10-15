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
  'disc59-', // discounts-admin (Task 59)
  'integ60-', // integrations-admin (Task 60)
  'exp61-', // expenses-admin (Task 61)
  'ent62-', // enterprise-admin (Task 62)
  'zst63-', // zreport-storno (Task 63)
  'hcp64-', // haccp-plans (Task 64)
  'mig65-', // migrations-console (Task 65)
  'sk66-', // stroski-ddl (Task 66)
  'sk67-', // expenses-categories (Task 67)
  'sk68-', // client-bundle-hygiene (OPS-2)
  'hhfl-', // handheld-flow (v1.84.0 P0-1)
  'plnk-', // paylink-flow (v1.85.0 P0-2)
  'i47-', // issue47-48-order-state (v1.89.0)
  'pih-', // p1-hardening (v1.89.0)
  'i23-', // issue23-42-data-exposure (v1.90.0)
  'i60-', // issue60-63-cash-shift-atomic (v1.92.0)
  'pi49-', // issue49-51-64-payments (v1.93.0)
  'i53-', // issue53-54-fiscal-po-scope (v1.95.0)
  'i65-', // issue56-57-65-replay-scope (v1.96.0)
  'i4346-', // issue43-46-loyalty-discount-gc (v1.97.0)
  'i3966-', // issue39-66-atomicity (v1.99.0)
  'i25-', // issue25-error-report (v1.102.0)
  'i18a-', // issue18-ap-3way-match (v1.103.0)
  'i7-', // issue7-allergen-truth (v1.104.0)
  'i15-', // issue15-lot-governance (v1.105.0)
  'i17-', // issue17-food-cost-variance (v1.106.0)
  'i19-', // issue19-exception-governance (v1.107.0)
  'i16-', // issue16-cash-movements (v1.108.0)
  'i20-', // issue20-haccp-ops (v1.109.0)
  'i13-', // issue13-reservation-widget (v1.110.0)
  'i21-', // issue21-manager-call (v1.111.0)
  'i14-', // issue14-kds-stations (v1.112.0)
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
  // v1.85.0 P0-2: javna plačilna povezava (FK → Order, briši PRED naročilom)
  { model: 'payLink' },
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
  // Issue #20 (v1.109.0): revizijski dogodki HACCP zapisa — nid() id, locationId
  // nosi testno predpono (kopija iz zapisa) → lokacijski prehod PRED haccpEntry.
  { model: 'haccpAction' },
  { model: 'prepStation' },
  { model: 'deliveryZone' },
  { model: 'table' },
  { model: 'counter' },
  { model: 'deviceRegistry' },
  { model: 'timeEntry' },
  // v1.92.0 (issue #60): StaffShift referencira Employee z Restrict — brez tega
  // prehoda bi izbris testnega Employee spodletel (sirote z nid() id + locationId
  // so pobrani v odklenjenem lokacijskem prehodu, direktni s predponskim id tu).
  { model: 'staffShift' },
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
  'payLink',
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
  'staffShift',
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
  // v1.95.0 (issue #54): nabavna pot (POST/receive) ustvari PurchaseOrder/GoodsReceipt/
  // AccountsPayable/SupplierPriceHistory z nid() id-ji BREZ predpone (poNumber/grnNumber/
  // apNumber/invoiceNumber prav tako brez nje) — testna predpona živi SAMO v locationId.
  // Otroci → starši: AP/priceHistory (FK na PO/supplier), GRN (kaskada na PO), PO zadnji.
  'accountsPayable',
  'supplierPriceHistory',
  'goodsReceipt',
  'purchaseOrder',
  // v1.110.0 (issue #13): javni rezervacijski widget — nid() id brez predpone,
  // predpona živi v locationId (skalar, NE SetNull) → prehod po locationId
  // počisti vrstico pred brisanjem lokacije (drugače bi ostala sirota).
  'reservationWidget',
  // v1.111.0 (issue #21): klic vodje — nid() id brez predpone (MC…),
  // predpona živi v locationId (skalar brez FK) → lokacijski prehod počisti
  // vrstice pred brisanjem lokacije (drugače bi ostale sirote).
  'managerCall',
  // v1.112.0 (issue #14): KDS postajne naloge + usmeritve artiklov — nid() id
  // brez predpone, predpona živi v locationId (skalar brez FK) → lokacijski
  // prehod počisti vrstice pred brisanjem lokacije (drugače bi ostale sirote).
  'stationTask',
  'menuItemStation',
] as const

type Delegate = { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> }

/**
 * Task 61: modeli s strežniško generiranimi id-ji (nid()) — testna predpona je
 * zapisana v besedilnih poljih (opis/opomba/številka), ne v id. Takšnih vrstic
 * id- in lokacijski prehod ne smetijo (locationId postane NULL po izbrisu
 * lokacije — SetNull) → potrebujejo lasten prehod po besedilnih poljih.
 */
const FIELD_SWEEP: ReadonlyArray<{ model: string; fields: readonly string[] }> = [
  { model: 'accountsPayable', fields: ['invoiceNumber', 'notes', 'apNumber'] },
  // Task 62: enterprise drevo (property → brand → organization) — POST /api/enterprise
  // ustvarja id z nid(), testna predpona živi v name (org tudi slug). Restriktivne FK
  // (Property→Brand, Brand→Organization) diktirajo vrstni red otroci → starši.
  // Location→property je opciona (SetNull) — brisanje testnega property ne ovira
  // lokacijskih prehodov (testne lokacije nosijo predpono v id).
  { model: 'property', fields: ['name'] },
  { model: 'brand', fields: ['name'] },
  { model: 'organization', fields: ['name', 'slug'] },
  // Task 64: HACCP načrti (POST /api/haccp/plans) — nid() id, predpona živi v
  // name (tudi target/responsible). Brez FK otrok; Location→plan je opciona
  // (SetNull s plan strani) → plan gre lahko v glavni prehod, tu je FIELD_SWEEP
  // zaradi besedilnih polj (id-predpona ni v id).
  { model: 'haccpPlan', fields: ['name', 'target', 'responsible'] },
]

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
    // 0. FIELD_SWEEP: strežniško generirani id-ji (nid()) — testna predpona živi v
    //    BESEDILOVIH poljih, ne v id. Lekcija Task 61: AccountsPayable POST ruta ustvari
    //    id z nid(), predpona ostane le v invoiceNumber/notes; po izbrisu testne lokacije
    //    je še locationId NULL (SetNull) → sirota, nevidna za id- in lokacijske prehode.
    //    Dokaz: 128 stroškov v dev bazi (72 rfix- + 56 exp61-) — vsi testni odpadki.
    //    Teko PRVI (pred id- prehodom), ker je AP list — sicer FK do dobavitelja
    //    pokvari starševski prehod (supplier deleteMany P2003).
    for (const spec of FIELD_SWEEP) {
      await dele(spec.model, {
        OR: spec.fields.map((f) => ({ [f]: { startsWith: p } })),
      })
    }
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
