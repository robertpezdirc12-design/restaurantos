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
 * BRISANJE je omejeno na vrstice, katerih id (oziroma znano alternativno
 * polje oziroma IME — v1.284.0) se začne s testno predpono — realni
 * (ne-testni) podatki so nedotaknjeni.
 * Vrstni red: otroci → starši (FK), prehodi:
 *  0. FIELD_SWEEP po besedilnih poljih (strežniški nid() id-ji brez predpone),
 *  0a. zbiralni prehod: id-ji nid()-id lokacij s predponskim IMENOM (v1.284.0),
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
  'v190wp-', // spletni portal za naročila P1 #8 (v1.190.0)
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
  'v241-', // qr-autofire (v1.241.0 — push + avto-požig gostovega/tabličnega naročila)
  'v242-', // založni val (v1.242.0 — EAN per lokacija, receptura varovalo, serije odpada/inventure, varianca neto gibanja, pokritost)
  'v243-', // povračilna celica (v1.243.0 — storno vrača darilno kartico, točke, kupon; v243e- = živa E2E fikstura)
  'v244-', // ritem val (v1.244.0 — pacing konfiguracija, pričakovani gosti, KDS zaklep)
  'v245-', // kombinacijski val (v1.245.0 — kombinacije miz + walk-in rezerva)
  'v246-', // operativni val (v1.246.0 — digitalni checklisti: predloge + izvedbe)
  'v225-', // qa-tips-decimal (v1.225.0 — izmerjeno v živi dev bazi 3. 11. 2026: v225-Admin je ukradel demo-vstop)
  'v248-', // strežni val (v1.248.0 — izmerjeno v1.282.0: osirotele ChecklistRun/ScheduledEmailLog vrstice po zelenih tekih; registracija omogoča centralni samoceljiv sweep)
  'v282-', // email determinizem + sweep pokritje (v1.282.0 — ChecklistRun/ScheduledEmailLog vpisi spodaj)
  'v284-', // sweep lokacij po imenu (v1.284.0 — nid()-id lokacije s predponskim imenom, vzorec i23-Nova)
  'v285-', // sweep gotovina + gostje (v1.285.0 — CashMovement/Guest/GuestVisit vpisi spodaj; i16-/v187cp- sta bili registrirani ŽE PREJ, vrzel je bila v SEZNAMIH modelov)
  'v286-', // sweep napitnine (v1.286.0 — TipPool zbirni prehod 0c + lokacijski vpis spodaj)
  'v288-', // sweep globji pregled (v1.288.0 — 9 novih FIELD_SWEEP razredov + GL prehod 0d + Counter izteg 0a; meritve v tests/v288-sweep-globji-pregled.test.ts)
  'v289-', // stabilnost dveh tekov (v1.289.0 — merilni val: prehodno ravnotežje + popravek i30 receipt+order; meritve v tests/v289-stabilnost-dveh-tekov.test.ts)
  'v290-', // repni široki klici (v1.290.0 — vhod+izhod široki klic v 9 repnih datotekah: rep suite 107 → 0; meritve v tests/v290-repni-siroki-klici.test.ts)
  // ── v1.283.0: registracija 45 preostalih neregistriranih predpon (izmerjeno:
  // 137 definiranih, 90 registriranih pred valom; 16 od 50 je puščalo ostanke
  // PO ZELENIH tekih — ne le ob crashu; 29 se samočisti, a ob crashu pred
  // afterAll ostanejo → centralni sweep jih počisti na naslednjem teku suite.
  // Zavestno VEN: c15-/c23-/v168-/v215- (0 db uvoza — mrtva teža v OR-seznamih)
  // in zst63 (vrstice nosijo 'zst63-…', ki je že registriran). 'v206' je brez
  // pomišljaja — varno, ker nid() izdeluje SAMO hex [0-9a-f], 'v' ni hex) ──
  'afx-', // audit-fixes — izmerjeno: EventLog/InventoryItem/StockTransaction ostanki po zelenih tekih (ročni afterAll zamudi eventLog, FK .catch(()=>null) pogoltne napako)
  'clnfx-', // cleaner-role — izmerjeno: AuditLog ostanek
  'i26-', // issue26-giftcard-tenant — izmerjeno: AuditLog ostanek
  'i29-', // issue29-device-enroll — self-sweep; centralna varovalka ob crashu
  'i30-', // issue30-37-ssrf — izmerjeno: EventLog+AuditLog ostanki (ročni afterAll brez lastnega sweepa)
  'i31-', // issue31-36-mfa — self-sweep; centralna varovalka
  'i38-', // issue38-event-tenant — izmerjeno: enterprise drevo ostanki
  'i5-', // issue5-authorization — izmerjeno: enterprise drevo ostanki
  'i52-', // issue52-55-58-59-inventory — izmerjeno: enterprise drevo ostanki
  'i73a-', // issue73-audit15 — izmerjeno: AuditLog ostanek
  'i75fx-', // issue75-security — self-sweep; centralna varovalka
  'p086fx-', // menu-86-board — self-sweep; centralna varovalka
  'sweep58-', // fixture-sweep lastna fiksturna — samočistilna datoteka, registracija za konsistentnost
  'v161-', // v161-cron-marker — izmerjeno: cela lokacija ostane (afterAll je ne briše)
  'v167-', // v167-digest-dedupe — ročni afterAll brez sweepa; ScheduledEmailLog id-vzorec
  'v185-', // v185-split-guests — self-sweep; centralna varovalka
  'v192ps-', // v192-payroll-surcharges — self-sweep; centralna varovalka
  'v193-', // v193-seats — self-sweep; centralna varovalka
  'v195-', // v195-order-seats — self-sweep; centralna varovalka
  'v196ec-', // v196-expense-category — self-sweep; centralna varovalka
  'v197ps-', // v197-payroll-rates — self-sweep; centralna varovalka
  'v200eq-', // v200-equipment — self-sweep; centralna varovalka
  'v202ean-', // v202-ean-receiving — self-sweep; centralna varovalka
  'v203doc-', // v203-documents — self-sweep; centralna varovalka
  'v204h-', // v204-order-hold — self-sweep; centralna varovalka
  'v205c-', // v205-crm-whatsapp — self-sweep; centralna varovalka
  'v206', // v206-hourly-email — vrstice: v206loc-/v206ord-/v206rc-; nid() je samo hex, 'v' ni hex → ne more biti predpona realnega id-ja
  'v210v-', // v210-pos-variants — self-sweep; centralna varovalka
  'v219-', // v219-qa-hardening — self-sweep; centralna varovalka
  'v220-', // v220-qa-user-wave — izmerjeno: AuditLog ostanek
  'v221-', // v221-qa-loyalty-gc — izmerjeno: LoyaltyAccount ostanek
  'v224-', // v224-qa-promo — izmerjeno: AuditLog ostanek
  'v226-', // v226-qa-coupon — self-sweep; centralna varovalka
  'v230fx-', // v230-auto86 — self-sweep; centralna varovalka
  'v237-', // v237-kds-modifiers — self-sweep; centralna varovalka
  'v238-', // v238-money-integrity — self-sweep; centralna varovalka
  'v239-', // v239-receipt-cell — self-sweep; centralna varovalka
  'v2391-', // v239-1-receipt-snapshot — self-sweep; centralna varovalka
  'v240-', // v240-reservation-cell — izmerjeno: EventLog+AuditLog ostanki
  'v247-', // v247-pogledi — izmerjeno: AuditLog ostanek
  'v249-', // v249-cenovni — self-sweep; centralna varovalka
  'v250-', // v250-tempo — self-sweep; centralna varovalka
  'v251-', // v251-crtna-koda — self-sweep; centralna varovalka
  'v252-', // v252-avtododelitev — izmerjeno: AuditLog ostanek
  'v253-', // v253-odprti-racuni — self-sweep; centralna varovalka
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
const ID_SWEEP: Array<{ model: string; alt?: 'entityId' | 'inventoryItemId' | 'loyaltyAccountId' | 'guestId' | 'employeeId' }> = [
  // — evidence/revizija najprej (referencirajo vse druge) —
  { model: 'eventLog', alt: 'entityId' },
  { model: 'auditLog', alt: 'entityId' },
  { model: 'printJob' },
  { model: 'integrationLog' },
  { model: 'deviceSyncOperation' },
  { model: 'webhook' },
  // v1.285.0 (najdba med valom — REŠITEV UGANKE »2 P2003« iz v1.284.0):
  // API-ustvarjene distribucije napitnin (nid() id iz POST /api/shifts/tips)
  // nosijo predponski employeeId (OBAVEZEN FK Restrict) → ena blokirana vrstica
  // povrne CELO employee deleteMany (SQLite atomarnost) → VSI id-predponski
  // zaposleni ostanejo (izmerjeno 36 živih: 28 i60- + 8 v225- čez 4 teke).
  // alt prehod PRED employee (vrstni red otrok → starši).
  { model: 'tipDistribution', alt: 'employeeId' },
  { model: 'tipPool' },
  { model: 'giftCardTransaction' },
  { model: 'giftCard' },
  // v1.283.0: LoyaltyTransaction → LoyaltyAccount je OBAVEZEN FK (privzeti Restrict).
  // Aplikacijska pot zvestobe (pridobitev točk ob plačilu) piše nid() id BREZ
  // predpone — predpona živi SAMO v loyaltyAccountId (izmerjeno v živi bazi:
  // v221 osirotela LoyaltyAccount + nid transakcija, ki je blokirala izbris).
  // alt prehod po loyaltyAccountId počisti transakcijo PRED računom (vrstni red
  // spodaj), sicer račun ostane zaklenjen (vzorec stockTransaction/inventoryItemId).
  { model: 'loyaltyTransaction', alt: 'loyaltyAccountId' },
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
  // v1.285.0: gost — id-predponske fiksature (vzorec v187cp-×32 v živi bazi: tests/
  // v187-coupons seje goste s predponskim id-jem IN locationId; faza 4 izbriše
  // lokacijo → Guest.locationId je SetNull FK → NULL → NEVIDEN lokacijskim
  // prehodom; izmerjeno nalaganje 24→32 čez val). GuestVisit PRED gostom:
  // GuestVisit.guestId je OBAVEZEN FK z Restrict (edini ne-kaskadni otrok —
  // Coupon CASCADE, Order SetNull; CampaignSend/GuestConsent skalarja brez
  // FK). Brez alt prehoda bi crash i11 teka (edina zapisovalca GuestVisit
  // ročno čistita — 0 vrstic v živi bazi) pustil PAR gost+obisk, ki ga NOBEN
  // naslednji tek ne more pobrati (P2003 zanka). Vzorec: loyaltyTransaction/
  // alt loyaltyAccountId iz v1.283.0.
  { model: 'guestVisit', alt: 'guestId' },
  { model: 'guest' },
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
  // v1.285.0: gotovinska gibanja — izmerjeno 68 živih vrstic (36 z id-predpono
  // i16-mv-… iz tests/issue16 db.create + 32 z nid() id-jem iz PRODUKCIJSKE
  // route POST /api/shifts/movements z predponskim locationId/userId/shiftId —
  // skalarji BREZ FK, zato jih nič ne zaklene in nič ne čisti; nalaganje
  // 27→68 čez en val). PRED cashRegisterShift (semantični otrok izmene,
  // shiftId skalar); brez lastnih FK → čist list.
  { model: 'cashMovement' },
  { model: 'cashRegisterShift' },
  // — organizacijsko drevo + preostali starši —
  { model: 'supplierPriceHistory' },
  { model: 'supplier' },
  { model: 'integration' },
  // v1.282.0: izvedbe digitalnih checklistov (v1.246.0) — id-predponske fiksture
  // (vzorec v248 G1) so ostajale v dev bazi po ZELENIH tekih (ChecklistRun ni bil
  // na seznamu; izmerjeno v1.282.0: 2 osiroteli vrstici na tek). templateId je
  // skalar BREZ FK (predloge živijo v config JSON Integration vrstice) → lahko
  // takoj za logičnim staršem; nid() otroke testnih lokacij pokriva spodnji
  // lokacijski prehod.
  { model: 'checklistRun' },
  // v1.282.0: e-poštni dnevnik — id-predponske fiksture (vzorec v167); vrstice,
  // ki jih piše PRODUKCIJSKA koda (nid() id, prejemnik = testna e-pošta), čista
  // FIELD_SWEEP po prejemniku spodaj.
  { model: 'scheduledEmailLog' },
  { model: 'job' },
  { model: 'restaurantSettings' },
  { model: 'accountsPayable' },
  { model: 'employee' },
  // v1.283.0: enterprise drevo — testi (i5/i38/i52) ustvarjajo org/brand/property
  // z id-predpono in imeni BREZ nje (»I38 Org A«, »PA«) → FIELD_SWEEP po name
  // jih ne vidi (izmerjeno v živi bazi: 18 osirotelih vrstic po zelenih tekih).
  // Vrstni red otroci→starši po Restrict FK: Property→Brand→Organization.
  // Workstation→Property je prav tako Restrict, a je izmerjeno 0 vrstic v dev
  // bazi — če ga prihodnji val zapiše, gre PRED property (zavestno odloženo).
  { model: 'property' },
  { model: 'brand' },
  { model: 'organization' },
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
  // v1.285.0: gotovinska gibanja, ki jih piše APLIKACIJA (POST /api/shifts/
  // movements) z nid() id-jem BREZ testne predpone — predponski locationId
  // (skalar brez FK) jih odda temu prehodu (izmerjeno 32 živih vrstic; vzorec
  // deviceSyncOperation). PRED cashRegisterShift (otrok izmene).
  // guest je ZAVESTNO VEN: 0 nid() zapisovalcev — produkcija ne ustvarja gostov
  // (rg '\.guest\.(create|upsert)' src/ = 0 zadetkov); vsi testi sejejo goste z
  // id-predpono direktno → ID_SWEEP jih vidi v fazi 1 ŠE PRED izbrisom
  // lokacije. Vzorec Workstation iz v1.284.0; pin v285 Č2 varuje.
  'cashMovement',
  'cashRegisterShift',
  // v1.286.0: bazeni napitnin, ki jih piše APLIKACIJA (POST /api/tips) z
  // nid() id-jem BREZ testne predpone — predponski locationId jih odda temu
  // prehodu PRED izbrisom lokacije (SET NULL bi jih sicer naredil nevidne;
  // vzorec cashMovement zgoraj). Pokrije bazene, katerih distribucije NE
  // nosijo predpone (npr. demo zaposleni); ostale pobere zbirni prehod 0c
  // skupaj s predponskimi distribucijami. CASCADE vzame tudi nepredponske
  // otroke testnega bazena (otroci testnega bazena so testni odpadek).
  'tipPool',
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
  // v1.288.0: revizijski dogodki HACCP zapisa — locationId je SKALAR (shema:
  // brez @relation) z @@index, vendar doslej NI bil v tem seznamu (dokumentirana
  // nakana v1.109.0 »lokacijski prehod PRED haccpEntry« pri ID_SWEEP vnosu
  // haccpAction nikoli izvedena v TEM seznamu). Izmerjeno: 9/tek nid()-id
  // vrstic z predponskim locationId (i20-locA-…) preživi zelene teke — brisanje
  // testne lokacije jih ne počisti (skalar), id-predpona jih ne vidi (nid).
  // PRED haccpEntry po izvirni nakani (sicer dosledno vzorcu otrok-pred-starši).
  'haccpAction',
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
  // v1.282.0: izvedbe checklistov, ki jih piše APLIKACIJA (cron/opravila) z
  // nid() id-jem BREZ predpone — predpona živi v locationId (skalar) → ta
  // prehod jih počisti pred brisanjem testne lokacije.
  'checklistRun',
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
  // v1.190.0 (P1 #8): spletni portal — vrstico ustvari PUT z nid() id-jem BREZ
  // testne predpone (locationId nosi predpono) → lokacijski prehod.
  'webOrderPortal',
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
  // v1.283.0: AuditLog.locationId je SKALAR brez FK — brisanje testne lokacije
  // ga ne počisti (asimetrija: eventLog je bil pokrit tu, auditLog ne). Izmerjeno
  // v živi bazi: vrstice z ŽE REGISTRIRANIMI predponami (v248-/i20-/v242-) so
  // preživele zelene teke. nid() id + predponski locationId → ta prehod
  // (vzorec managerCall/stationTask: skalar locationId brez FK).
  'auditLog',
  // v1.288.0: GL vrstice dnevnega obračuna — JournalLine.locationId je SKALAR
  // (brez @relation; nosi user.loc uporabnika, ki je sprožil obračun). Vrstice
  // z nid()-id lokacijo pobere IN-seznam locChildOr(); predponske pobere
  // startsWith. Vnosi (JournalEntry) čisti zbirni prehod 0d, ki teče PRED fazo 1
  // — ta vpis je plastena varovalka za vrstice, ki bi nastopile kasneje v teku
  // (idempotenten deleteMany).
  'journalLine',
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
  // v1.289.0 dopolnitev (readdir dokaz, 283/283): bun test izvaja datoteke v
  // READDIR (datotečno-sistemskem, NE abecednem) redu — VRSTNI RED TEKA je
  // zato odvisen od stanja datotečnega sistema (reset peskovnika/git checkout
  // ga spremeni; osnovni val je zapisal »workerje« — atribucija popravljena:
  // poskusi z 3/10 majhnimi datotekami namigujejo abecedni red, pri 283
  // datotekah je dokaz 283/283 readdir). Vrstice, ki jih ustvarijo datoteke
  // za zadnjim širokim klicem sweepa (TEST_PREFIXES), ostanejo kot PREHODNI
  // rep; naslednji tek jih poberejo zgodnji široki klici — ta contains prehod
  // je mehanizem samoceljenja mrtvih števcev s predponskim lokacijskim id-jem.
  // INVARIANTA neodvisna od reda: 0 AKUMULACIJE čez teke.
  // v1.290.0 (repni široki klici): VSEH 9 izmerjenih repnih datotek (issue30,
  // issue11-crm-core/admin, v162, guest-feedback, stocktake, haccp-plans,
  // issue7, v240) zdaj nosi VHODNI široki klic (beforeAll oz. setup pri
  // haccp-plans — setupP teče ob uvozu modula) in IZHODNI široki klic (konec
  // afterAll) — rep suite po teku je 0 neodvisno od readdir reda (izhodišče
  // izmere: 107 predponskih vrstic).
  { model: 'counter', fields: ['name'], contains: true },
  // v1.282.0: ScheduledEmailLog vrstice, ki jih piše PRODUKCIJSKA koda
  // (sendDailyDigest/sendShiftDailySummary/sendWeeklyTaskSummary) — id je
  // nid() BREZ predpone, prejemnik pa je e-pošta testne nastavitvene vrstice
  // (izmerjeno: osirotela TASK_WEEKLY vrstica 'v248-digest@test.local' po
  // zelenem teku v248 G3). startsWith po prejemniku ujame natanko testne
  // vrstice — realni prejemniki ne morejo nositi testne predpone v lokalnem
  // delu naslova. List brez FK → varno v fazi 0.
  { model: 'scheduledEmailLog', fields: ['recipient'] },
  // v1.285.0 (najdba med valom): AuditLog vrstice, ki jih piše PRODUKCIJSKA koda
  // (TIP_POOL_CLOSE/TIMECLOCK_MANUAL iz APIjev) — id je nid() BREZ predpone,
  // predponski je SAMO userId (skalar — zaposleni testnega teka; izmerjeno 16
  // živih vrstic po zelenih tekih i60/v225). Vzorec scheduledEmailLog/
  // recipient iz v1.282.0: realni userId je nid() hex — predpona z ne-hex
  // znakom ne more biti predpona realnega id-ja. List brez FK otrok → varno v fazi 0.
  { model: 'auditLog', fields: ['userId'] },
  // ── v1.288.0: globji pregled preostalih FIELD_SWEEP razlik (A-kandidat iz
  // v1.286.0/v1.287.0 — izmerjeno po 2 zelenih tekih na svežem semenu:
  // akumulacija ~69 predponskih sirot na tek v 10 razredih, ki so uidele
  // VSEM trem prehodom: nid() id + locationId NULL ali odmrli + predpona v
  // besedilnem polju, ki ga doslej nihče ni pometal). Vrstni red bloka je
  // FK-diktiran: StockTransaction → InventoryItem je OBAVEZEN Restrict FK,
  // zato transakcije (po employeeName) padejo PREJ kot artikli (po name) —
  // sicer bi brisanje artikla padlo na P2003 (šum v errors, vrstice ostanejo). ──
  { model: 'stockTransaction', fields: ['employeeName'] },
  // i52- (issue52-55-58-59-inventory): artikli ustvarjeni prek enterprise API
  // z nid() id-jem in predponskim IMENOM; po izbrisu drevesa locationId padne
  // na NULL (SetNull) → nevidni id- in lokacijskemu prehodu (izmerjeno 9/tek).
  { model: 'inventoryItem', fields: ['name'] },
  // i30- (issue30-37-ssrf): integracije z nid() id-jem + predponskim imenom +
  // locationId NULL (izmerjeno 4/tek). IntegrationLog → Integration je CASCADE
  // → z integracijo pade tudi dnevnik (izmerjeno +1/tek, prav tako uide
  // id-prehodu: integrationId je nid).
  { model: 'integration', fields: ['name'] },
  // v240- (v240-reservation-cell): javni widget piše rezervacijo z nid() id-jem,
  // predpona živi v customerName; locationId je skalar, ki ga test poči → NULL
  // (izmerjeno 19/tek). Table.reservationId je SetNull → brisanje rezervacije
  // sprosti mize brez FK ovir. V245 kombinacije (comboTableIds ',v245-tbl-a,…,')
  // so sred-niz — te vrstice pokrije customerName (iste vrstice, ista predpona
  // v drugem polju).
  { model: 'reservation', fields: ['customerName'] },
  // gfb- (guest-feedback): QR povratne informacije gostov z nid() id-jem —
  // predpona v guestName/comment/tableId, locationId NULL (izmerjeno 7/tek).
  // List brez FK otrok → varen vhod v fazo 0.
  { model: 'guestFeedback', fields: ['guestName', 'comment', 'tableId'] },
  // v186ai- (v186-ai-insights): vpogledi AI z nid() id-jem — predpona v
  // employeeId (izmerjeno 3/tek). List brez FK otrok.
  { model: 'aIConversation', fields: ['employeeId'] },
  // v190wp- (v190-web-portal): dostavni podatki spletnega portala z nid() id-jem
  // — predpona v deliveryInstructions (naslov/telefon sta predmet asercij
  // testa, zato je nosilec navodilo; izmerjeno 1/tek). Order → DeliveryInfo
  // ne blokira (otrok).
  { model: 'deliveryInfo', fields: ['deliveryInstructions'] },
  // furspost (furs-post): dogodki StockChanged ob fiskalnem stornu — id/entityId/
  // locationId so VSI nid() (lokacijo počisti reverse-FK afterAll testa SAM,
  // preden bi kateri koli kasnejši sweep lahko uporabil njen id za IN-seznam;
  // entityId = artikel, ne račun → lastnični deleteMany po entityId ne zadene).
  // Edini trajen predponski sled je "by":"furspost-…" SRED JSON payloada
  // (izmerjeno 6/tek). `contains` po vzorcu Counter: realni payloadi
  // referencirajo realne nid() entitete — testna predpona z ne-hex znaki ne
  // more biti del realnega zapisa.
  { model: 'eventLog', fields: ['payload'], contains: true },
  // v1.288.0 (drugi auditLog vnos poleg userId): produkcija piše audit vrstice
  // z nid() id-jem, kjer je predpona SAMO SRED details JSON (poNumber
  // 'PO-V156R-mw8vz6…', grnNumber, entityId — izmerjeno 26/tek: v156r-/disc59-/
  // hcp64-/i53-/i4-). userId vrstice pomete obstoječi vnos (v1.285.0) na
  // naslednjem teku lastnika predpone; details vrstice brez predponskega
  // userId niso pokrite z NOBENIM naslednjim tekom (beforeAll lastnika predpone
  // pomete samo userId zadetke — details polja ne vidi).
  // `contains` po istem varnostnem argumentu kot eventLog/payload.
  { model: 'auditLog', fields: ['details'], contains: true },
  // ── v1.288.0 najdba #2 med valom (živa verifikacija po teku 7 datotek):
  // instrumenti vračil iz tests/v243-povracilna-celica — 5 stale darilnih
  // kartic + 6 računov zvestobe z nid() id-jem, katerih lokacija je bila že
  // izbrisana (SetNull) → lastni cleanup po locationId jih ne vidi več; polna
  // suite jih pobere SAMO zato, ker v243 afterAll teče z živo lokacijo —
  // crash teka bi jih pustil za vedno. Kupon (code) in gost (lastName/email)
  // sta čista lista (Coupon→Guest je Cascade — obrambna globina za sirote);
  // kartice in računi zvestobe imajo Restrict otroke brez predpone → zbirni
  // prehod 0e spodaj. ──
  { model: 'coupon', fields: ['code'] },
  { model: 'guest', fields: ['lastName', 'email'] },
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
   * Zakaj: TEST_PREFIXES ima 136 vnosov, faz pa je ~190 deleteMany na pregled.
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
  // 0a. zbiralni prehod — nid()-id lokacije s predponskim IMENOM (v1.284.0).
  //     POST /api/locations dodeli nid() id, testna predpona pa živi SAMO v
  //     imenu (tests/issue23-42: »i23-Nova« — izmerjeno v1.283.0 kot živa
  //     vrstica po ZELENIH tekih, ker se issue23 afterAll zanaša IZKLJUČNO na
  //     ta sweep; tests/unique-collision čisti po imenu ročno → njegove
  //     preživijo samo crash pred afterAll). Fazam 1/3/4 (id) in 2/5
  //     (locationId otrok) so takšne lokacije in njihovi nid() otroci
  //     NEVIDNI. Zberemo id-je po imenu — varnost je ista kot pri enterprise
  //     FIELD_SWEEP po name: realna imena ne nosijo testnih predpon (demo
  //     seed »RestaurantOS Ljubljana«; pin Č3 before=after v v284 testih).
  const orphanLocIds = (
    await db.location.findMany({
      where: { OR: forField('name', 'startsWith') } as unknown as Prisma.LocationWhereInput,
      select: { id: true },
    })
  ).map((r) => r.id)
  // v1.288.0: števci zaporedij pobranih sirot — 'receipt:<locId>'/'order:<locId>'
  // Counter vrstice referencirajo lokacijo SRED imena; ko faza 4 pobere nid()-id
  // lokacijo s predponskim imenom (0a zgoraj), njen števec OSTANE (izmerjeno po
  // 2 zelenih tekih: 14 'order:<nid>' vrstic — vsi lokacijski deli so mrtvi id-ji;
  // vrednosti se več ne pomikajo, vrstice pa se nabirajo +7/tek). Predponske-id
  // lokacije ('order:v245-loc-…') že pokriva obstoječi Counter contains prehod —
  // ta izteg pokriva nid()-id sirote. Exact-match po CELEM imenu: demo števci
  // živih lokacij in 'grn:' dnevni števec ostanejo nedotaknjeni (id žive lokacije
  // nikoli ni v orphanLocIds — 0a zbira SAMO predponsko poimenovane).
  if (orphanLocIds.length > 0) {
    await dele('counter', {
      name: { in: orphanLocIds.flatMap((id) => [`receipt:${id}`, `order:${id}`]) },
    })
  }
  /** OR-pogoji za prehoda 2/5 (locationId): predponski startsWith + IN-seznam
   *  znanih nid() id-jev sirot (njihovi otroci nosijo nid() locationId →
   *  startsWith jih ne vidi; Employee→Location je SetNull → brez tega bi
   *  ostali sirote z NULL locationId za vedno). */
  const locChildOr = (): Record<string, unknown>[] =>
    orphanLocIds.length > 0
      ? [...forField('locationId', 'startsWith'), { locationId: { in: orphanLocIds } }]
      : forField('locationId', 'startsWith')
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
        OR: [
          ...forField('id', 'startsWith'),
          ...forField('locationId', 'startsWith'),
          // v1.284.0: naročila nid()-id lokacij s predponskim imenom (locationId
          // = nid → startsWith ne vidi). Brez tega bi plačilo (Restrict→kupon)
          // blokiralo kupon, kupon naročilo, naročilo pa lokacijo (faza 2/4).
          ...(orphanLocIds.length > 0 ? [{ locationId: { in: orphanLocIds } }] : []),
        ],
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
  // 0c. zbiralni prehod — nid()-id bazeni napitnin predponskih distribucij
  //     (v1.286.0). POST /api/tips (src/app/api/tips/route.ts:354 — poolId =
  //     nid()) ustvari bazen z nid() id-jem; testna predpona živi SAMO v
  //     locationId bazena ter id/employeeId distribucij. Distribucije pobere
  //     ID_SWEEP (alt employeeId, v1.285.0), bazen pa je ostal: ni bil v
  //     NOBENEM seznamu, faza 4 pa izbriše testno lokacijo → TipPool.locationId
  //     SET NULL → neviden VSEM prehodom (izmerjeno 13 živih v1.285.0 → 25 v
  //     v1.286.0). Zberemo tipPoolId PRED fazo 1 — dokaz je VRSTICA
  //     distribucije; ko pade, je sled izbrisana. Varnost ista kot pri 0a:
  //     bazen, na katerega kaže predponska distribucija, JE testna fikstura
  //     (produkcija ne piše testnih predpon); CASCADE pobere tudi morebitne
  //     nepredponske otroke bazena (otroci testnega bazena so testni odpadek).
  //     OBSTOJEČE sirote (dokaz že izbrisan) pobere enkratni remedy vala —
  //     po njem 0c + lokacijski vpis preprečujeta nastanek novih.
  const orphanTipPoolIds = Array.from(
    new Set(
      (
        await db.tipDistribution.findMany({
          where: {
            OR: [...forField('id', 'startsWith'), ...forField('employeeId', 'startsWith')],
          } as unknown as Prisma.TipDistributionWhereInput,
          select: { tipPoolId: true },
        })
      ).map((r) => r.tipPoolId),
    ),
  )
  // 0d. zbiralni prehod — GL vnosi testnih lokacij (v1.288.0). POST /api/reports/gl
  //     (source 'auto') piše JournalEntry z nid() id-jem BREZ predpone — vnos sam
  //     nima NOBENEGA predponskega polja (entryNumber/reference/description so
  //     generirane, locationId je NULL ker refresh pot v route ne osvežuje vnosa,
  //     ampak samo vrstice). Predponski je SAMO JournalLine.locationId (user.loc
  //     uporabnika, ki je sprožil obračun; izmerjeno 6 vrstic + 2 vnosa na tek —
  //     i5-locA1/i5-locB1 iz tests/issue5-authorization). GL koda nastavi
  //     locationId na VSE vrstice vnosa iz ISTEGA user.loc (create + refresh poti
  //     v route) → vnos s predponsko vrstico JE testni odpadek; demo vnosi
  //     (demo lokacija = nid hex brez predpone v imenu) ostanejo. JournalLine →
  //     JournalEntry je Restrict FK → vrstice PRED vnosi (vzorec 0c: dokaz za
  //     vnos je VRSTICA s predponskim locationId; ko pade, je sled izbrisana).
  //     IN-seznam po locChildOr logiki: tudi vrstice, ki kažejo na nid()-id
  //     lokacijo s predponskim IMENOM (0a), vdajo svoj vnos.
  const orphanJournalEntryIds = Array.from(
    new Set(
      (
        await db.journalLine.findMany({
          where: {
            OR: [
              ...forField('locationId', 'startsWith'),
              ...(orphanLocIds.length > 0 ? [{ locationId: { in: orphanLocIds } }] : []),
            ],
          } as unknown as Prisma.JournalLineWhereInput,
          select: { journalEntryId: true },
        })
      ).map((r) => r.journalEntryId),
    ),
  )
  if (orphanJournalEntryIds.length > 0) {
    await dele('journalLine', {
      OR: [
        ...forField('locationId', 'startsWith'),
        ...(orphanLocIds.length > 0 ? [{ locationId: { in: orphanLocIds } }] : []),
      ],
    })
    await dele('journalEntry', { id: { in: orphanJournalEntryIds } })
  }
  // 0e. zbiralni prehod — instrumenti vračil (v1.288.0 najdba #2 med valom).
  //     Darilne kartice in računi zvestobe iz tests/v243-povracilna-celica
  //     (POST /api/* z nid() id-jem): predpona živi v ownerName oziroma
  //     customerName; lokacija je bila izbrisana (SetNull) → lastni v243
  //     cleanup po locationId jih ne najde več (izmerjeno 5 GC + 6 LA po
  //     samostojnem teku; polna suite jih počisti z lastnim afterAll — crash
  //     teka pa bi jih pustil za vedno). Transakcije otroci: issue vrstice
  //     nosijo predpono v note, REDEEM/REFUND pa so BREZ predpone → Restrict
  //     FK blokira brisanje starša → zbirni prehod (vzorec 0c/0d): otroci
  //     starša s predponskim imenom SO testni odpadek (produkcija ne piše
  //     testnih predpon v ownerName/customerName).
  const orphanGiftCardIds = (
    await db.giftCard.findMany({
      where: { OR: forField('ownerName', 'startsWith') } as unknown as Prisma.GiftCardWhereInput,
      select: { id: true },
    })
  ).map((r) => r.id)
  if (orphanGiftCardIds.length > 0) {
    await dele('giftCardTransaction', { giftCardId: { in: orphanGiftCardIds } })
    await dele('giftCard', { id: { in: orphanGiftCardIds } })
  }
  const orphanLoyaltyIds = (
    await db.loyaltyAccount.findMany({
      where: { OR: [...forField('customerName', 'startsWith'), ...forField('customerEmail', 'startsWith')] } as unknown as Prisma.LoyaltyAccountWhereInput,
      select: { id: true },
    })
  ).map((r) => r.id)
  if (orphanLoyaltyIds.length > 0) {
    await dele('loyaltyTransaction', { loyaltyAccountId: { in: orphanLoyaltyIds } })
    await dele('loyaltyAccount', { id: { in: orphanLoyaltyIds } })
  }
  // 1. blok prehod po id — otroci → starši, ŠE BREZ location:
  //    opciona relacija na Location je onDelete: SetNull — če bi lokacijo brisali
  //    prej, bi otrokom (npr. DeliveryZone z aplikacijskim id-jem) postavil
  //    locationId na NULL in jih prehod 2 ne bi več našel.
  for (const spec of ID_SWEEP) {
    if (spec.model === 'location') continue
    // v1.286.0: tipPool dobi tudi IN-seznam zbranih nid()-id bazenov (0c) —
    // vzorec orphanLocIds iz faz 2/4/5 (v1.284.0).
    await dele(spec.model, {
      OR: forField('id', 'startsWith')
        .concat(spec.alt ? forField(spec.alt, 'startsWith') : [])
        .concat(spec.model === 'tipPool' && orphanTipPoolIds.length > 0 ? [{ id: { in: orphanTipPoolIds } }] : []),
    })
  }
  // 1b. (premaknjeno v 0b: otroci naročil morajo pasti pred ID_SWEEP, da
  //    menuItem deleteMany ne zadene Restrict FK-ja.)
  // 2. odkleni prehod po locationId — aplikacijsko ustvarjeni otroci testnih
  //    lokacij (samodejni id-ji brez predpone); lokacija ŠE obstaja.
  //    v1.284.0: locChildOr() dodaja IN-seznam id-jev sirot po imenu (0a).
  for (const model of LOCATION_CHILD_SWEEP) {
    await dele(model, { OR: locChildOr() })
  }
  // 3. ponovni prehod po id (BREZ location) — ovire so zdaj odstranjene
  for (const spec of ID_SWEEP) {
    if (spec.model === 'location') continue
    // v1.286.0: tudi ponovni prehod vračuna zbrane bazene (idempotentna
    // varovalka — faza 1 jih je že pobrala, to je varuh vrstnega reda faz)
    await dele(spec.model, {
      OR: forField('id', 'startsWith')
        .concat(spec.model === 'tipPool' && orphanTipPoolIds.length > 0 ? [{ id: { in: orphanTipPoolIds } }] : []),
    })
  }
  // 4. lokacija ZADNJA — uspeh pomeni, da ni več FK ovir. v1.284.0: tudi
  //    id-ji sirot s predponskim IMENOM (0a) — njihovi otroci so padli v 2.
  await dele('location', {
    OR: orphanLocIds.length > 0
      ? [...forField('id', 'startsWith'), { id: { in: orphanLocIds } }]
      : forField('id', 'startsWith'),
  })
  // 5. varovalka: morebitni SetNull sirote ponovno po locationId, potem končni id prehod
  for (const model of LOCATION_CHILD_SWEEP) {
    await dele(model, { OR: locChildOr() })
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
    // v1.284.0: šteje se tudi po IMENU — sirota s predponskim imenom JE
    // testna lokacija (poštena merilna točka; prej je takšen ostanek števec
    // prijavljal 0, čeprav je vrstica preživela).
    remainingLocations = await db.location.count({
      where: {
        OR: [
          ...prefixes.map((p) => ({ id: { startsWith: p } })),
          ...prefixes.map((p) => ({ name: { startsWith: p } })),
        ],
      },
    })
  } catch {
    /* števec je informativen; napaka brisanja je že v errors */
  }

  return { tables, errors, remainingLocations }
}
