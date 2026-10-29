import type { Prisma, PrismaClient } from '@prisma/client'

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
 * Vrstni red: otroci → starši (FK), prehodi:
 *  0. FIELD_SWEEP po besedilnih poljih (strežniški nid() id-ji brez predpone),
 *  1. blok prehod po id (+ znana alternativna polja entityId/inventoryItemId),
 *  2. odkleni prehod po locationId (aplikacijsko ustvarjeni otroci testnih
 *     lokacij, npr. Receipt/Payment, ki imajo samodejne id-je brez predpone),
 *  3. ponovni prehod po id (ovire so zdaj odstranjene),
 *  4. izbris lokacij, 5. varovalčni ponovni lokacijski prehod,
 *  6. late FIELD_SWEEP (besedilne sirote, ki jih ovira FK — npr. Employee.pin).
 * Napake posamezne tabele se zberejo in sporočijo; brisanje ne ustavi testov.
 */

/** Vse testne id-predpone (iz `const PREFIX`/`const P` v tests/*.test.ts). */
export const TEST_PREFIXES = [
  'v186lf-', // labor-forecast P1-4 (v1.186.0)
  'v186ai-', // ai-insights P2-9 (v1.186.0)
  'v187cp-', // kuponi P2-10b (v1.187.0)
  'v188wl-', // waitlist SMS P2-14 (v1.188.0)
  'v189ap-', // knjigovodski portal P2-13 (v1.189.0)
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
  'i12-', // issue12-recommendations (v1.113.0)
  'i24-', // issue24-labels (v1.114.0)
  'i22-', // issue22-payroll (v1.115.0)
  'i8-', // issue8-stock-transfers (v1.116.0)
  'i10-', // issue10 labor-coverage (v1.117.0)
  'adl-', // auth-demo-login (v1.118.0)
  'i9-', // issue9 channel-sync (v1.119.0)
  'i3-', // issue3 pos-readiness (v1.120.0)
  'i70-', // issue70 state-consistency (v1.121.0)
  'i4-', // issue4 einvoices SI/HR (v1.125.0)
  'i11-', // issue11 CRM gostov (v1.126.0)
  'i11a-', // issue11 CRM admin/ddl (v1.126.0)
  'v129-', // role-ui-gating (v1.129.0 — čistilka/skladiščnik gating, Δ% KPI)
  'fsub-', // fiscal-submit (v1.144.0 — skupna fiskalna oddaja: storno + obnova pending)
  'ocon-', // order-concurrency (v1.145.0 — audit #10/#11/#12: CAS preklic/move/merge)
  'seqfl-', // sequence-receipt-number (v1.146.0 — audit #14: spodnja meja sekvence + reže)
  'a89-', // audit89-tenant-move-scope (v1.147.0 — audit #8/#9: cilj premika + javna lista lokacij)
  'a22-', // audit22-drawer-cash (v1.148.0 — audit #22: meje števanja predala + predaja med izmenama)
  'aw10-', // audit10-writers (v1.148.0 — audit #10 razred: dostava, webhook, popust, čistilec)
  'a56-', // audit56-einvoice-lines (v1.149.0 — audit #5/#6: popust in zaokroževanje na B2B e-računu)
  'v156-', // cfd-conditional (v1.156.0 — pogojni odgovor stanja zaslona gostov)
  'v156p-', // paylink-sim-guard (v1.156.0 — strežniška meja simulatorja na javni plačilni povezavi)
  'v158-', // reservation-capacity (v1.158.0 — celodnevna kapaciteta + zaklep sočasnih rezervacij)
  'v156r-', // po-receive-concurrency (v1.156.0 — atomarni GRN/zaloga/statusi ob sočasnem prevzemu)
  'v157-', // stripe-webhook (v1.157.0 — podpisana poravnava plačanih sej + dnevna uskladitev)
  'v159-', // delivery-tenant (v1.159.0 — webhook vezan na integracijo/lokacijo, ključ po lokaciji)
  'v160-', // gl-live-day (v1.160.0 — GL tekoči dan se osveži, pretekli zamrzne; ročni se ne prepiše)
  'v162-', // waitlist-table-release (v1.162.0 — sprostitev mize iz čakalne vrste)
  'v163-', // integration-log-pii (v1.163.0 — dnevnik brez osebnih podatkov gosta)
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
  // Issue #8 (v1.116.0): medlokacijski prenosi — postavke pred glavo
  // (transferId FK Cascade: StockTransferItem MORA pasti pred StockTransfer).
  // StockTransfer NIMA locationId stolpca (from/to skalarna) → NI v
  // LOCATION_CHILD_SWEEP; API-ustvarjene glave (nid() id) čistijo testi ročno
  // (kot PayrollExport), id-predponske fiksre pa pokrije ta prehod (+ alt
  // inventoryItemId za postavke, ki kažejo na i8- izvorne artikle).
  { model: 'stockTransferItem', alt: 'inventoryItemId' },
  { model: 'stockTransfer' },
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
  // v1.156.0: Receipt.Order je OBAVEZEN FK z privzetim Restrict — če bi Order
  // brisali pred Receipt, bi SQLite zavrnil brisanje naročila (račun ga drži),
  // naročilo pa nato blokira brisanje lokacije (Order.Location je Restrict).
  // Dokaz: 13 testnih lokacij je ostalo v dev bazi po teku paylink testov
  // (račun + plačilo z nid() id-jem, predpona samo v locationId).
  'receipt',
  'order',
  'cashRegisterShift',
  'zReport',
  'inventoryItem',
  'inventoryBatch',
  'stocktake',
  'deviceRegistry',
  // v1.145.0 (audit #10): DeviceSyncOperation ima OBAVEZEN locationId FK, vrstic pa
  // ustvarjajo rute z nid() id-jem BREZ testne predpone (claim/upsert v /api/sync).
  // ID_SWEEP ga ujame samo po id-predponi → test, ki pošilja sync operacije, je
  // blokiral izbris testne lokacije (RESTRICT). Pred tem so ga testi čistili ročno
  // po deviceId (tests/race-fixes.test.ts); zdaj je pokrit centralno.
  'deviceSyncOperation',
  'guestFeedback',
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
  // v1.115.0 (issue #22): obračunsko obdobje — nid() id brez predpone, predpona
  // živi v locationId (skalar brez FK) → lokacijski prehod počisti vrstice pred
  // brisanjem lokacije (drugače bi ostale sirote). PayrollExport NIMA locationId
  // → NI v sweep-u (testi ga čistijo ročno po periodId).
  'payrollPeriod',
  // v1.126.0 (issue #11): CRM — kampanje/soglasja/pošiljke z nid() id BREZ predpone,
  // predpona živi v locationId (skalar brez FK) → lokacijski prehod počisti vrstice
  // pred brisanjem lokacije (drugače bi ostale sirote).
  'guestConsent',
  'campaign',
  'campaignSend',
  // v1.144.0 (audit #3): publishEvent() piše nid() id BREZ predpone, predpona živi v
  // locationId. ID_SWEEP eventLog ujame samo id/entityId s predpono → lokacijsko
  // odani dogodki (npr. storno račun) ostanejo 'pending' in zaidejo v globalni
  // dispatch drugih testov (dokaz: tests/issue38-event-tenant-scope.test.ts:268 je
  // v celotnem teku dobil 15 namesto 5 — samoceljivost sweep-a, ne napaka izdelka).
  'eventLog',
] as const

type Delegate = { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> }

/**
 * Task 61: modeli s strežniško generiranimi id-ji (nid()) — testna predpona je
 * zapisana v besedilnih poljih (opis/opomba/številka), ne v id. Takšnih vrstic
 * id- in lokacijski prehod ne smetijo (locationId postane NULL po izbrisu
 * lokacije — SetNull) → potrebujejo lasten prehod po besedilnih poljih.
 * `contains`: predpona je SRED imena, ne na začetku (Counter `receipt:<locId>`).
 */
const FIELD_SWEEP: ReadonlyArray<{ model: string; fields: readonly string[]; contains?: boolean; late?: boolean }> = [
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
  // v1.146.0 (audit #14): Counter vrstice, ki jih ustvari nextSequence(), imajo
  // nid() id (BREZ predpone), testna predpona pa živi SRED `name`
  // (`receipt:seqfl-loc-…`, `order:…`). ID_SWEEP (`id startsWith`) jih ne vidi,
  // lokacijskega stolpca Counter nima → zaostareli številki bi se prenašali iz
  // enega teka v drugega. Predpona je vedno v lokacijskem delu imena, `nid()` pa
  // vezaje odstrani (src/lib/map.ts:29), zato `contains` zadene samo testne
  // vrstice. Izbris je v dev SQLite tudi sicer samoceljiv: nextSequence in
  // allocateReceiptNumber Counter ustvarita znova.
  { model: 'counter', fields: ['name'], contains: true },
  // v1.147.0 (release audit #8/#9): Employee.pin je @unique, testi pa v njega
  // napišejo dobesedno vrednost s predpono (`pin: 'pi49-a'`), id pa je nid() BREZ
  // predpone. Če tek crashne, ostane tak zaposlen; ko kasneje izbrisan njegova
  // testna lokacija, FK nastavi locationId na NULL — sirota torej uide obema
  // prehodoma (po id in po locationId). Naslednji tek nato pade na P2002 (`pin`)
  // že v beforeAll, bun pa preskoči CELTO datoteko (19 testov izgubljenih).
  // `late` zaradi FK: Employee je starš StaffShift/TimeEntry/Order (Restrict),
  // zato se mora brisati šele PO id- in lokacijskem prehodu — sicer prehod vrže
  // napako, ki jo testi števajo kot odpad. Realni PIN (4–8 številk) predpone ne
  // more vsebovati, zato je poseg v varnostno smer omejen samo na testne vrstice.
  { model: 'employee', fields: ['pin'], late: true },
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

  /* ZDRUŽENE predpone, NE zanka po predponi.
   * Zakaj: TEST_PREFIXES ima 64 vnosev, faz pa je ~190 deleteMany na pregled.
   * Zanko po predponi smo merili: 64 × 190 × 2 pregleda (beforeAll + afterAll v
   * vsakem DB testu) ≈ 24.000 krožnih poklicev do baze; tests/fixture-sweep.test.ts
   * je zato počil na lastnem timeoutu (60 s) čeprav so bile poslovne tabele
   * PRAZNE. Z OR-seznamom čez vse predpone je število izjav ~190 na pregled —
   * neodvisno od števila predpon. Vrstni red faz in otroci→starši je identičen
   * prejšnjemu; predpone v istem stavku so med seboj neodvisne (vrstica pripada
   * eni sami predponi), zato se FK-odvisnosti ne spremenijo. */
  /** OR-pogoji čez vse predpone za eno polje (`field`). */
  const forField = (field: string, mode: 'startsWith' | 'contains'): Record<string, unknown>[] =>
    prefixes.map((p) => ({ [field]: { [mode]: p } }))

  // 0. FIELD_SWEEP: strežniško generirani id-ji (nid()) — testna predpona živi v
  //    BESEDILOVIH poljih, ne v id. Lekcija Task 61: AccountsPayable POST ruta ustvari
  //    id z nid(), predpona ostane le v invoiceNumber/notes; po izbrisu testne lokacije
  //    je še locationId NULL (SetNull) → sirota, nevidna za id- in lokacijske prehode.
  //    Dokaz: 128 stroškov v dev bazi (72 rfix- + 56 exp61-) — vsi testni odpadki.
  //    Teko PRVI (pred id- prehodom), ker je AP list — sicer FK do dobavitelja
  //    pokvari starševski prehod (supplier deleteMany P2003).
  for (const spec of FIELD_SWEEP) {
    if (spec.late) continue
    const mode = spec.contains ? 'contains' : 'startsWith'
    await dele(spec.model, { OR: spec.fields.flatMap((f) => forField(f, mode)) })
  }
  // 0b. otroci naročil testnih lokacij, ki jih id-predpona ne vidi: Payment
  //    (Payment → Check je OBAVEZEN FK z Restrict) in OrderItem (FK na MenuItem
  //    je Restrict; API-ustvarjene postavke imajo nid() id in le orderId).
  //    MORATA pasti PRED fazo 1 — sicer menuItem deleteMany pade, ker OrderItem
  //    še obstaja (napaka je bila vidna v vsakem teku, ki ustvari naročilo prek
  //    API-ja, npr. paylink testi). Faza 3 bi sicer uspela, a šum ostane.
  //    v1.189.0: še Receipt (orderId OBAVEZEN, onUpdate: Restrict, onDelete
  //    privzeto Restrict — EDINI ne-kaskadni otrok Order; Check/OrderItem/
  //    KotDocument/PayLink/StationTask so Cascade in jih SQLite pobere sam).
  //    API-račun (nid() id, predpona živi v locationId) sicer blokira fazo 1
  //    (delete order) s P2003, ki se razreši šele v fazah 2/3 — šum v
  //    prisma:error in SweepResult.errors (dokaz: issue19 G1 fiskalni storno).
  try {
    const testOrders = await db.order.findMany({
      where: {
        OR: [...forField('id', 'startsWith'), ...forField('locationId', 'startsWith')],
      } as unknown as Prisma.OrderWhereInput,
      select: { id: true },
    })
    if (testOrders.length > 0) {
      await dele('orderItem', { orderId: { in: testOrders.map((o) => o.id) } })
      await dele('receipt', { orderId: { in: testOrders.map((o) => o.id) } })
      const checks = await db.check.findMany({
        where: { orderId: { in: testOrders.map((o) => o.id) } },
        select: { id: true },
      })
      if (checks.length > 0) {
        await dele('payment', { checkId: { in: checks.map((c) => c.id) } })
      }
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    errors.push(`otroci naročil (po naročilih): ${raw.trim().split('\n')[0] || String(e)}`)
  }
  // 1. blok prehod po id — otroci → starši, ŠE BREZ location:
  //    opciona relacija na Location je onDelete: SetNull — če bi lokacijo brisali
  //    prej, bi otrokom (npr. DeliveryZone z aplikacijskim id-jem) postavil
  //    locationId na NULL in jih prehod 2 ne bi več našel.
  for (const spec of ID_SWEEP) {
    if (spec.model === 'location') continue
    await dele(spec.model, { OR: forField('id', 'startsWith').concat(spec.alt ? forField(spec.alt, 'startsWith') : []) })
  }
  // 1b. (premaknjeno v 0b: otroci naročil morajo pasti pred ID_SWEEP, da
  //    menuItem deleteMany ne zadene Restrict FK-ja.)
  // 2. odkleni prehod po locationId — aplikacijsko ustvarjeni otroci testnih
  //    lokacij (samodejni id-ji brez predpone); lokacija ŠE obstaja
  for (const model of LOCATION_CHILD_SWEEP) {
    await dele(model, { OR: forField('locationId', 'startsWith') })
  }
  // 3. ponovni prehod po id (BREZ location) — ovire so zdaj odstranjene
  for (const spec of ID_SWEEP) {
    if (spec.model === 'location') continue
    await dele(spec.model, { OR: forField('id', 'startsWith') })
  }
  // 4. lokacija ZADNJA — uspeh pomeni, da ni več FK ovir
  await dele('location', { OR: forField('id', 'startsWith') })
  // 5. varovalka: morebitni SetNull sirote ponovno po locationId, potem končni id prehod
  for (const model of LOCATION_CHILD_SWEEP) {
    await dele(model, { OR: forField('locationId', 'startsWith') })
  }
  // 6. late FIELD_SWEEP — besedilno poimenske sirote, ki so FK-ovirane (npr.
  //    Employee.pin s predpono in locationId NULL): šele zdaj so vsi otroci
  //    (StaffShift/TimeEntry/Order) odstranjeni, zato brisanje ne vrže napake.
  for (const spec of FIELD_SWEEP) {
    if (!spec.late) continue
    const mode = spec.contains ? 'contains' : 'startsWith'
    await dele(spec.model, { OR: spec.fields.flatMap((f) => forField(f, mode)) })
  }

  let remainingLocations = 0
  try {
    // `forField` vrne Record<string, unknown> (primeren je samo za brisanje prek
    // delegata); count potrebuje tipiziran WHERE, zato je oblika ročna — ZDRUŽENA
    // čez vse predpone
    remainingLocations = await db.location.count({
      where: { OR: prefixes.map((p) => ({ id: { startsWith: p } })) },
    })
  } catch {
    /* števec je informativen; napaka brisanja je že v errors */
  }

  return { tables, errors, remainingLocations }
}
