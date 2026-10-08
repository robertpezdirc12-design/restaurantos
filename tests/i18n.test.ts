/**
 * Testi dvojezičnosti SL/HR (issue #1 triage — velik prečni sklop).
 *
 * Acceptance po triage:
 *  - »v prevodih ne sme ostajati mešanica jezikov ali manjkajoči ključi« → pariteta slovarjev;
 *  - »avtomatski testi zaznajo manjkajoče i18n ključe in hardcodirana uporabniška
 *    besedila v glavnih UI območjih« → sken kritičnih datotek za prevedene nize.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_LOCALE, LOCALES, dictionaryGaps, emptyValues, fiscalStatusLabel,
  isLocale, normalizeLocale, t,
} from '../src/lib/i18n'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

describe('i18n — slovarji', () => {
  test('pariteta: vsak ključ iz SL obstaja v HR (in obratno)', () => {
    const { missingInHr, missingInSl } = dictionaryGaps()
    expect(missingInHr).toEqual([])
    expect(missingInSl).toEqual([])
  })

  test('brez praznih vrednosti (prevod brez vsebine = mešanica jezikov)', () => {
    expect(emptyValues()).toEqual([])
  })

  test('vrednosti v HR niso slovenske besede iz SL slovarja (mešanica)', () => {
    // Preverimo znane slovensko-specifične vrednosti — v HR slovarju NE smejo obstajati
    // (nize z enako vsebino v obeh jezikih, kot 'Prijava'/'Bar', izključimo eksplicitno).
    const allowedSame = new Set([
      'common.app', 'login.title', 'login.submit', 'login.email', 'login.pin', 'login.devicePlaceholder',
      'login.deviceAnother', 'common.yes', 'common.no', 'common.saldo', 'lang.label',
      'tabs.haccp', 'tabs.kuhinja', 'tabs.rezervacije', 'tabs.racuni', 'tabs.dostava', 'tabs.nabava',
      'tabs.zaposleni', 'header.inactive', 'header.online', 'header.offline', 'header.logout',
      'dash.viewLabel', 'dash.locationFallback', 'tables.clickClean', 'tables.qrMenu', 'tables.qrAria',
      'tables.statusAria', 'payment.cash', 'payment.card', 'payment.mobile', 'payment.swap',
      'payment.search', 'payment.redeem', 'payment.discountLabel', 'payment.number', 'payment.eor',
      'payment.issue', 'payment.issuePos', 'payment.issuedSim', 'zones.bar', 'zones.patio', 'zones.private',
      'roles.ADMIN', 'roles.BAR', 'roles.KITCHEN', 'receipt.title', 'receipt.premises', 'receipt.register',
      'receipt.operator', 'receipt.copy', 'receipt.storno', 'receipt.zki', 'receipt.jir',
      'receipt.fursVerified', 'receipt.fursPending', 'receipt.fursFailed', 'receipt.fursNone', 'receipt.fursStatus',
      'login.reconstruction', 'payment.loyaltyEarned', 'payment.issued',
    ])
    const sloSpecific = ['Zasedena', 'Prosta', 'Shrani', 'Prekliči', 'Nalagam…', 'Iskanje', 'Napitnine',
      'Čakalna lista', 'Zaloge', 'Izmene', 'Stroški', 'Zvestoba', 'Mnenja', 'Nastavitve', 'Vse lokacije',
      'Sinhroniziram…', 'Osveži', 'Brez popusta', 'Odstrani', 'Za pospravit', 'Namig']
    for (const val of Object.values(hr)) {
      for (const s of sloSpecific) {
        // HR vrednost ne sme biti enaka slovensko-specifičnemu nizu (razen kot del daljšega besedila)
        if (val.trim() === s) throw new Error(`HR slovar vsebuje slovensko besedilo: "${s}"`)
      }
    }
    expect(allowedSame.size).toBeGreaterThan(0) // dokumentacijski smisel
  })
})

describe('i18n — t() in normalizacija', () => {
  test('privzeti jezik je sl', () => {
    expect(DEFAULT_LOCALE).toBe('sl')
    expect(LOCALES).toEqual(['sl', 'hr'])
  })

  test('t(sl) vrne natanko prvotna besedila (§18)', () => {
    expect(t('sl', 'tabs.mize')).toBe('Mize')
    expect(t('sl', 'status.FREE')).toBe('Prosta')
    expect(t('sl', 'login.subtitle')).toBe('Blagajna · naročila · mize · kuhinja')
  })

  test('t(hr) vrne hrvaške prevode', () => {
    expect(t('hr', 'tabs.mize')).toBe('Stolovi')
    expect(t('hr', 'status.FREE')).toBe('Slobodan')
    expect(t('hr', 'orders.none')).toBe('Nema aktivnih narudžbi.')
  })

  test('interpolacija spremenljivk', () => {
    expect(t('sl', 'tables.seats', { n: 4 })).toBe('4 mest')
    expect(t('hr', 'tables.seats', { n: 4 })).toBe('4 mjesta')
    expect(t('sl', 'dash.viewLabel', { name: 'Maribor' })).toBe('Pogled: Maribor')
    expect(t('hr', 'header.queued', { n: 3 })).toBe('3 u redu')
  })

  test('manjkajoč ključ → SL fallback → še vedno manjka → ključ', () => {
    expect(t('sl', 'nep obstojeci.kljuc')).toBe('nep obstojeci.kljuc')
    expect(t('hr', 'nep obstojeci.kljuc')).toBe('nep obstojeci.kljuc')
  })

  test('normalizeLocale: sl-SI/sl/hr-HR/hr/nepoznano', () => {
    expect(normalizeLocale('sl-SI')).toBe('sl')
    expect(normalizeLocale('sl')).toBe('sl')
    expect(normalizeLocale('hr-HR')).toBe('hr')
    expect(normalizeLocale('HR')).toBe('hr')
    expect(normalizeLocale('de-DE')).toBe('sl')
    expect(normalizeLocale(undefined)).toBe('sl')
    expect(normalizeLocale(42)).toBe('sl')
  })

  test('isLocale varno za branje iz shrambe', () => {
    expect(isLocale('hr')).toBe(true)
    expect(isLocale('de')).toBe(false)
    expect(isLocale(null)).toBe(false)
  })
})

describe('i18n — fiskalna oznaka stanja po državi (ni prevodna funkcija)', () => {
  test('SI tok — FURS oznake', () => {
    expect(fiscalStatusLabel('sl', 'SI', 'pending', false)).toBe(t('sl', 'receipt.fursPending'))
    expect(fiscalStatusLabel('hr', 'si', 'pending', false)).toBe(t('hr', 'receipt.fursPending'))
    expect(fiscalStatusLabel('hr', 'SI', 'none', true)).toBe(t('hr', 'receipt.fursVerified'))
  })

  test('HR tok — Fiskalizacija 2.0 oznake (ne glede na jezik UI)', () => {
    expect(fiscalStatusLabel('sl', 'HR', 'pending', false)).toBe(t('sl', 'receipt.hrPending'))
    expect(fiscalStatusLabel('hr', 'HR', 'pending', false)).toBe(t('hr', 'receipt.hrPending'))
    expect(fiscalStatusLabel('sl', 'HR', 'none', true)).toBe(t('sl', 'receipt.hrVerified'))
    expect(fiscalStatusLabel('hr', 'HR', 'weird', false)).toContain('Fiskalizacija')
  })
})

describe('i18n — regresija hardcodiranih besedil (glavna UI območja)', () => {
  const files = [
    '../src/app/page.tsx',
    '../src/app/dashboard/page.tsx',
    '../src/components/dashboard-tabs.tsx',
  ]
  // Per-datotekni seznam prenesenih nizov: [trdo kodirano besedilo, ključ]
  // njihova vrnitev v trdo kodirano obliko = regresija (acceptance: testi zaznajo hardcodirana besedila).
  const perFile: Record<string, [string, string][]> = {
    '../src/app/page.tsx': [
      ['Blagajna · naročila · mize · kuhinja', 'login.subtitle'],
      ['Vpišite se s službenim računom in PIN kodo.', 'login.desc'],
      ['Aktiviraj napravo (kiosk/display)', 'login.device'],
      ['Vpisna koda (8 števk)', 'login.deviceCode'],
      ['Aktiviraj še eno napravo', 'login.deviceAnother'],
      ['Prijava ni uspela.', 'login.failed'],
      ['Povezava s strežnikom ni uspela.', 'login.connection'],
      ['RestavrantOS · FURS simulacija · EUR', 'login.footer'],
    ],
    '../src/app/dashboard/page.tsx': [
      ['Vse lokacije', 'header.allLocations'],
      ['Sinhronizir', 'header.syncing'], // 'Sinhroniziram…'
      ['Ni aktivnih naročil.', 'orders.none'],
      ['Vsa aktivna naročila', 'orders.allActive'],
      ['Klikni — očisti', 'tables.clickClean'],
      ['Kuhinjski list', 'kitchen.kitchenTicket'],
      ['Bar list', 'kitchen.barTicket'],
      ['Način plačila:', 'payment.method'],
      ['Brez popusta', 'payment.noDiscount'],
      ['Eno plačilo', 'payment.single'],
      ['ZA PLAČATI', 'payment.due'],
      ['Natisni račun', 'payment.print'],
      ['Odjava iz sistema?', 'logout.title'],
      ['Ostani', 'logout.stay'],
      ['Zasedene mize', 'dash.openTables'],
      ['Današnji promet', 'dash.todayRevenue'],
      // Task 25-f — faza 2, skupina F (page.tsx inline sekcije: meni/rezervacije/računi/zaposleni/nastavitve + ostanki)
      ['Aktivna naročila', 'dash.activeOrders'],
      ['artiklov', 'dash.itemsCount'],
      ['Kuhinjska vrsta je prazna. 🎉', 'kitchen.queueEmpty'],
      ['Natisni kuhinjski list', 'kitchen.printKitchenTitle'],
      ['Natisni bar list', 'kitchen.printBarTitle'],
      ['Začni', 'kitchen.start'],
      ['Pripravljeno', 'status.PREPARED'],
      ['Na zalogi', 'menu.inStock'],
      ['Ni na voljo', 'menu.outOfStock'],
      ['Prekliči', 'common.cancel'],
      ['Prihajajoče rezervacije', 'resv.upcoming'],
      ['Ni prihajajočih rezervacij.', 'resv.empty'],
      ['Gost prišel', 'resv.stSeated'],
      ['Prišel', 'resv.seatedBtn'],
      ['Št. oseb', 'resv.guestsLabel'],
      ['Datum in čas *', 'resv.dateTime'],
      ['npr. otroški stol', 'resv.notePlaceholder'],
      ['Shrani rezervacijo', 'resv.save'],
      ['Vseeno shrani rezervacijo?', 'resv.confirmOutside'],
      ['Izvozi račune (CSV)', 'rcpt.exportCsv'],
      ['St. racuna', 'rcpt.csvNumber'],
      ['Nacin placila', 'rcpt.csvPayMethod'],
      ['Izdani računi (FURS)', 'rcpt.title'],
      ['Ni izdanih računov.', 'rcpt.none'],
      ['naročilo #', 'rcpt.orderShort'],
      ['neoverjeno', 'rcpt.unverified'],
      ['Natisni', 'common.print'],
      ['Aktiven je začasni (bootstrap) dostop', 'emp.bootstrapActive'],
      ['Ime in priimek', 'emp.bootNamePlaceholder'],
      ['PIN (4–8)', 'emp.bootPinPlaceholder'],
      ['Naključni 6-mestni PIN', 'emp.randomPinTitle'],
      ['Ustvari trajen profil', 'emp.bootCreate'],
      ['klikni profil za urejanje', 'emp.clickToEdit'],
      ['(neaktiven)', 'emp.inactiveSuffix'],
      ['Aktiven', 'emp.activeF'],
      ['Neaktiven', 'emp.inactiveF'],
      ['Dovoljenja (override-ji)', 'emp.permsLabel'],
      ['Shrani profil', 'emp.saveProfile'],
      ['Lokacija (poslovalnica)', 'emp.locationLabel'],
      ['Ponastavi PIN', 'emp.pinResetLabel'],
      ['4–8 številk', 'emp.pinPlaceholder'],
      ['Razumem, ponastavi PIN', 'emp.pinResetConfirm'],
      ['Razumem, deaktiviraj', 'emp.deactivateConfirm'],
      ['Tiskalnik in terminal — ta naprava', 'print.deviceTitle'],
      ['Cilj tiskanja', 'print.target'],
      ['Brskalnik (okno/PDF)', 'print.targetBrowser'],
      ['Lokalni agent (ESC/POS)', 'print.targetAgent'],
      ['Simulator (brez naprave)', 'print.targetSim'],
      ['Tiskalnik — IP gostitelj', 'print.hostLabel'],
      ['Tiskalnik — vrata', 'print.portLabel'],
      ['Plačilni terminal', 'print.terminal'],
      ['Brez terminala', 'print.termNone'],
      ['Ročno (koda odobritve s terminala)', 'print.termManual'],
      ['Testni tisk', 'print.testBtn'],
      ['Tisk ni uspel:', 'print.failed'],
      ['Lokacije', 'loc.title'],
      ['Nova lokacija', 'loc.new'],
      ['Ni lokacij.', 'loc.none'],
    ],
    // Task 25-a — faza 2, skupina A (Zaloge/Izmene/HACCP/Stroški/Zvestoba/Mnenja)
    '../src/components/dashboard-tabs.tsx': [
      // Zaloge (InventoryTab)
      ['Artiklov', 'inv.itemCount'],
      ['Pod minimumom', 'inv.belowMin'],
      ['Vrednost zaloge', 'inv.stockValue'],
      ['Sklad zalog', 'inv.stockList'],
      ['Zaloga je prazna.', 'inv.empty'],
      ['Ni dodanih dobaviteljev.', 'inv.noSuppliers'],
      ['Receptura artikla', 'inv.recipeTitle'],
      ['Sestavine (količina na eno prodano enoto)', 'inv.ingredients'],
      ['Dodaj sestavino', 'inv.addIngredient'],
      ['Shrani recepturo', 'inv.saveRecipe'],
      ['npr. Moka tip 500', 'inv.namePlaceholder'],
      ['Začetna količina', 'inv.initQty'],
      ['Min. količina', 'inv.minQty'],
      ['Cena / enoto (€)', 'inv.costPerUnit'],
      ['Shrani artikel', 'inv.saveItem'],
      ['Trenutno stanje:', 'inv.currentStock'],
      ['Nastavi količino na', 'inv.setQtyTo'],
      ['Shrani prilagoditev', 'inv.saveAdjust'],
      ['Shrani dobavitelja', 'inv.saveSupplier'],
      ['Izbrišem recepturo? Razknjiževanje za ta artikel se ustavi.', 'inv.deleteRecipeConfirm'],
      ['brez sestavin', 'inv.noIngredients'],
      // Izmene (ShiftsTab)
      ['Prihodki (mesec)', 'shifts.revenueMonth'],
      ['Dobiček (mesec)', 'shifts.profitMonth'],
      ['Računov (mesec)', 'shifts.invoicesMonth'],
      ['Prihodki (danes)', 'shifts.revenueToday'],
      ['Promet po davčnih stopnjah (mesec)', 'shifts.taxBreakdown'],
      ['Ni prometa.', 'shifts.noTraffic'],
      ['Izvozi poročilo (CSV)', 'shifts.exportCsv'],
      ['Odprta izmena', 'shifts.openShift'],
      ['Ni odprte izmene', 'shifts.noOpenShift'],
      ['Blagajna ob zaključku (€)', 'shifts.closingCashLabel'],
      ['Začetno stanje blagajne (€)', 'shifts.openingCashLabel'],
      ['Zaključi izmeno (Z)', 'shifts.stopShift'],
      ['Začni izmeno', 'shifts.startShift'],
      ['Zadnje izmene (Z-poročila)', 'shifts.recent'],
      ['Ni zapisov izmen.', 'shifts.none'],
      ['Stroški (mesec)', 'exp.month'],
      ['Davcna stopnja (%)', 'shifts.csvTaxRate'],
      ['Vloga', 'shifts.csvRole'],
      // HACCP (HaccpTab)
      ['Nova kontrola', 'haccp.newCheck'],
      ['Vrsta kontrole', 'haccp.typeLabel'],
      ['Cilj (naprava / prostor)', 'haccp.target'],
      ['Vrednost (°C)', 'haccp.value'],
      ['Rezultat', 'haccp.result'],
      ['✅ V redu', 'haccp.okSelect'],
      ['⚠️ Opomba', 'haccp.noteSelect'],
      ['Zapiši kontrolo', 'haccp.submit'],
      ['Zadnje kontrole', 'haccp.recent'],
      ['Ni zapisov HACCP kontrol.', 'haccp.none'],
      ['V redu', 'haccp.ok'],
      // Stroški (ExpensesTab)
      ['Vseh zapisov', 'exp.totalRecords'],
      ['Nov strošek', 'exp.new'],
      ['Opis', 'exp.description'],
      ['npr. Zelje in krompir — Kmetija Vidmar', 'exp.descPlaceholder'],
      ['Znesek (€)', 'exp.amount'],
      ['Zapiši strošek', 'exp.submit'],
      ['Izvozi stroške (CSV)', 'exp.exportCsv'],
      ['Ni zapisov stroškov.', 'exp.none'],
      ['Stroški', 'exp.title'],
      ['Kategorija', 'exp.csvCategory'],
      // Zvestoba (LoyaltyTab)
      ['Članov', 'loy.members'],
      ['Skupaj točk', 'loy.totalPoints'],
      ['Nov član', 'loy.newMember'],
      ['Zvestobni računi', 'loy.accounts'],
      ['Ni članov programa zvestobe.', 'loy.none'],
      ['Nov član zvestobe', 'loy.newMemberTitle'],
      ['Shrani člana', 'loy.saveMember'],
      ['Zapiši točke', 'loy.savePoints'],
      ['Točke (+ prihod / − obračun)', 'loy.pointsDelta'],
      ['Točke', 'loy.pointsBtn'],
      // Mnenja (FeedbackTab)
      ['Povprečna ocena', 'fb.avgRating'],
      ['Št. mnenj', 'fb.count'],
      ['Mnenja gostov', 'fb.title'],
      ['Ni še mnenj gostov.', 'fb.none'],
      // Task 25-b — faza 2, skupina B (Delovna mesta/Nastavitve/Naprave/Dostava/Izvoz računovodstva)
      // Delovna mesta (JobsCard)
      ['Delovna mesta', 'jobs.title'],
      ['Ni definiranih delovnih mest.', 'jobs.none'],
      ['Urna postavka (€)', 'jobs.hourlyRate'],
      ['npr. Sommelier', 'jobs.titlePlaceholder'],
      ['Aktivno', 'jobs.activeF'],
      // Nastavitve (SettingsEditor)
      ['Nastavitve podjetja', 'set.company'],
      ['Podatki lokacije', 'set.locationData'],
      ['Nastavitve še niso ustvarjene — shrani obrazec za prvo inicializacijo.', 'set.notCreated'],
      ['Nastavitve shranjene ✓', 'set.saved'],
      ['Shrani nastavitve', 'set.save'],
      ['FURS okolje', 'set.fursEnv'],
      ['Testno okolje', 'set.envTest'],
      ['Produkcijsko okolje', 'set.envProduction'],
      ['Matična številka', 'set.businessId'],
      ['Oznaka poslovnega prostora', 'set.registerNumber'],
      ['Poštna številka', 'set.postCode'],
      ['Program zvestobe', 'set.loyaltyProgram'],
      ['E-poštna poročila', 'set.emailReports'],
      ['npr. Gostilna pri Jožetu', 'set.namePlaceholder'],
      ['npr. Hvala za obisk!', 'set.receiptFooterPlaceholder'],
      // Naprave (DevicesCard)
      ['Naprave — onboarding', 'dev.title'],
      ['Ustvari vpisno kodo', 'dev.createCode'],
      ['Kopiraj kodo', 'dev.copyCode'],
      ['Koda kopirana ✓', 'dev.copied'],
      ['Ni registriranih naprav.', 'dev.none'],
      ['Trajno izbrišem napravo?', 'dev.deleteConfirm'],
      ['Ime naprave: min. 2 znaka.', 'dev.nameMin'],
      ['Samopostrežni kiosk', 'dev.sel.kiosk'],
      ['Mobilna naprava', 'dev.sel.mobile'],
      ['Brez lokacije', 'dev.noLocation'],
      ['Customer display (CFD)', 'dev.sel.cfd'],
      // Dostava (DeliveryTab)
      ['Ni aktivnih dostavnih naročil.', 'dost.activeNone'],
      ['Prejemnik:', 'dost.recipient'],
      ['Naslov:', 'dost.address'],
      ['Zaključene dostave', 'dost.history'],
      ['Dostavne cone', 'dost.zones'],
      ['Ni con. Dostava brez cone je vedno mogoča.', 'dost.noZones'],
      ['Platforme — webhooki in napake', 'dost.platforms'],
      ['Ni napak v zadnjih dogodkih.', 'dost.noErrors'],
      ['Ime voznika', 'dost.driverName'],
      ['Nova dostavna cona', 'dost.newZoneTitle'],
      ['Pristojbina (€)', 'dost.fee'],
      ['Min. naročilo (€)', 'dost.minOrder'],
      ['Čas (min)', 'dost.time'],
      ['Aktivna dostava', 'dost.active'],
      // Izvoz računovodstva (AccountingExportCard)
      ['Računovodski izvoz', 'acct.title'],
      ['Izvoz ni uspel.', 'acct.exportFailed'],
      ['Izvozi (CSV)', 'acct.exportCsv'],
      ['Izvozi (JSON)', 'acct.exportJson'],
      // ponovno uporabljeni obstoječi ključi
      ['Plačano', 'status.PAID'],
      // Task 25-c — faza 2, skupina C (Napitnine/Nabava)
      ['Napitnine — dnevni bazen', 'tips.title'],
      ['Zbrane napitnine', 'tips.collected'],
      ['Kartica/druge', 'tips.cardOther'],
      ['Plačila z napitnino', 'tips.paymentsWithTip'],
      ['Osnova delitve', 'tips.basis'],
      ['Po urah (izmene)', 'tips.basisHours'],
      ['Enakovredno', 'tips.basisEqual'],
      ['Po točkah (kmalu)', 'tips.basisPoints'],
      ['Za ta dan ni evidentiranih ur (izmen) — delitev po urah je samodejno padla na enakovredno.', 'tips.noHoursFallback'],
      ['Izplačaj', 'tips.payoutCol'],
      ['Označi izplačano', 'tips.markPaid'],
      ['Izplačaj vse čakajoče', 'tips.payAllPending'],
      ['Predogled delitve za', 'tips.previewFor'],
      ['Ure tega dne', 'tips.hoursToday'],
      ['Predvideni delež', 'tips.expectedShare'],
      ['Za ta dan ni napitnin ali zaposlenih z osnovo.', 'tips.emptyDay'],
      ['Zaključi dan — ustvari bazen', 'tips.closeDay'],
      ['Zgodovina bazenov', 'tips.history'],
      ['Še ni zaključenih dni.', 'tips.noHistory'],
      ['Nabavna naročila', 'proc.ordersTitle'],
      ['Ni dobaviteljev —', 'proc.noSuppliers'],
      ['Dodaj artikel zaloge', 'proc.addInvItem'],
      ['Ni vrstic — dodaj artikel zaloge ali ročno vrstico. Artikel samodejno prenese enoto in privzeto nabavno ceno.', 'proc.noLines'],
      ['Filter statusa', 'proc.statusFilter'],
      ['Vsi statusi', 'proc.allStatuses'],
      ['Ni še naročil — ustvari prvo nabavno naročilo.', 'proc.noOrders'],
      ['Ni naročil za izbrani status.', 'proc.noOrdersStatus'],
      ['Naziv dobavitelja je obvezen.', 'proc.supNameRequired'],
      ['Nabavno naročilo ustvarjeno (osnutek).', 'proc.poCreated'],
      ['Vnesi vsaj eno količino (sprejeto ali zavrnjeno).', 'proc.enterQty'],
      ['Nalagam nabavne podatke …', 'proc.loading'],
      ['Oddaj', 'proc.submitBtn'],
      ['Odobri', 'proc.approveBtn'],
      ['Prevzemi', 'proc.receiveBtn'],
      ['Ročna vrstica', 'proc.manualLine'],
      ['Artikel / opis', 'proc.itemDesc'],
      ['Cena/enota (€)', 'proc.pricePerUnit'],
      ['DDV %', 'proc.vatPercent'],
      ['Znesek vrstice:', 'proc.lineAmount'],
      ['Skupaj brez DDV', 'proc.netTotal'],
      ['Ustvari osnutek', 'proc.createDraft'],
      ['Vrstice — naročeno / prejeto / zavrnjeno', 'proc.linesHeader'],
      ['Postavka', 'proc.item'],
      ['Naročeno', 'proc.thOrdered'],
      ['Prejeto', 'proc.thReceived'],
      ['Zavrnjeno', 'proc.thRejected'],
      ['Cena/en.', 'proc.thPriceUnit'],
      ['Ni še prevzemov.', 'proc.noReceipts'],
      ['Zgodovina nabavnih cen', 'proc.priceHistory'],
      ['Dobavitelj *', 'proc.supplierLabel'],
      ['Naziv', 'jobs.name'],
      ['Kraj', 'set.city'],
      ['Davčna številka', 'set.taxId'],
      ['Lokacija', 'dev.location'],
      ['Kontakt', 'proc.contact'],
      ['Enota', 'inv.unit'],
      ['Naslov', 'set.address'],
      ['E-pošta', 'set.email'],
      ['IBAN', 'proc.iban'],
      ['Uredi', 'common.edit'],
      // Task 25-d — faza 2, skupina D (Darilne kartice/Odpad)
      // Darilne kartice (DarilneKarticeTab)
      ['Začetni saldo mora biti ne negativno število.', 'gc.errInitialBalance'],
      ['Kartica je že obstajala (replay)', 'gc.okReplayIssue'],
      ['Znesek polnjenja mora biti pozitivno število.', 'gc.errTopupAmount'],
      ['Polnjenje je že bilo izvedeno (replay)', 'gc.okReplayTopup'],
      ['Deaktiviram kartico', 'gc.confirmDeactivate'],
      ['Reaktiviram kartico', 'gc.confirmReactivate'],
      ['Kartica deaktivirana.', 'gc.okDeactivated'],
      ['Kartica reaktivirana.', 'gc.okReactivated'],
      ['Išči po številki kartice ali lastniku', 'gc.searchPlaceholder'],
      ['Iskanje darilnih kartic', 'gc.searchAria'],
      ['Išči', 'gc.searchBtn'],
      ['Počisti', 'gc.clearBtn'],
      ['Novo kartico', 'gc.newCard'],
      ['Aktivne kartice', 'gc.statActive'],
      ['aktivne z saldom', 'gc.statActiveSub'],
      ['Skupni saldo', 'gc.statTotal'],
      ['Izdane (30 dni)', 'gc.statIssued'],
      ['Unovčeno (30 dni)', 'gc.statRedeemed'],
      ['plačila s karticami', 'gc.statRedeemedSub'],
      ['Ni kartic', 'gc.none'],
      ['za to iskanje', 'gc.noneSearch'],
      ['Izdajte prvo kartico.', 'gc.noneFirst'],
      ['Številka', 'gc.thNumber'],
      ['Lastnik (opcijsko)', 'gc.ownerOptional'],
      ['Lastnik', 'gc.thOwner'],
      ['Velja do (opcijsko)', 'gc.validUntilOptional'],
      ['Velja do', 'gc.thValidUntil'],
      ['Izdana', 'gc.thIssued'],
      ['Stanje', 'gc.thStatus'],
      ['Deaktiviraj', 'gc.deactivateBtn'],
      ['Reaktiviraj', 'gc.reactivateBtn'],
      ['Izdaj darilno kartico', 'gc.issueTitle'],
      ['Ime kupca / prejemnika', 'gc.ownerPlaceholder'],
      ['Začetni saldo (EUR)', 'gc.initialBalance'],
      ['0 € = kartica brez vrednosti (polni se kasneje). Največ 5.000 €.', 'gc.initialBalanceHint'],
      ['Opomba (opcijsko)', 'gc.noteOptional'],
      ['npr. prodaja na blagajni', 'gc.noteIssuePlaceholder'],
      ['Izdaj kartico', 'gc.issueBtn'],
      ['Polnjenje', 'gc.topupTitle'],
      ['Trenutni saldo:', 'gc.currentSaldo'],
      ['Znesek polnjenja (EUR)', 'gc.topupAmount'],
      ['Največ 5.000 € na polnjenje.', 'gc.topupMaxHint'],
      ['npr. gotovinski vnos', 'gc.noteTopupPlaceholder'],
      ['začetno', 'gc.initialLower'],
      ['Brez roka veljavnosti', 'gc.noExpiry'],
      ['Deaktiviraj kartico', 'gc.deactivateCardBtn'],
      ['Reaktiviraj kartico', 'gc.reactivateCardBtn'],
      ['Ledžer transakcij', 'gc.ledger'],
      ['Ni transakcij.', 'gc.noTx'],
      ['Saldo po', 'gc.thBalanceAfter'],
      // Odpad (OdpadTab)
      ['Pokvarjeno', 'waste.rPokvareno'],
      ['Pretekel rok', 'waste.rPretekelRok'],
      ['Napaka pri pripravi', 'waste.rPriprava'],
      ['Razlitje / padec', 'waste.rRazlitje'],
      ['Okvara hladilne verige', 'waste.rHlajenje'],
      ['Vrnjena postavka (reklamacija)', 'waste.rReklamacija'],
      ['Izberi artikel zaloge.', 'waste.errSelectItem'],
      ['Količina odpada mora biti število večje od 0.', 'waste.errQty'],
      ['Izberi razlog odpada.', 'waste.errReason'],
      ['količino najprej popravi v Zalogah', 'waste.errOverStock'],
      ['Odpad je bil že evidentiran (replay)', 'waste.okReplay'],
      ['Odpad evidentiran:', 'waste.okRecord'],
      ['Povrnem odpad', 'waste.confirmReverse'],
      ['je nazaj na zalogi.', 'waste.okReversed'],
      ['Zadnjih 7 dni', 'waste.days7'],
      ['Zadnjih 90 dni', 'waste.days90'],
      ['Zadnjih 365 dni', 'waste.days365'],
      ['Vsi razlogi', 'waste.allReasons'],
      ['Odpad v obdobju', 'waste.inPeriod'],
      ['Zapisi odpada', 'waste.title'],
      ['Ni zapisov odpada v izbranem obdobju.', 'waste.none'],
      ['Strošek', 'waste.thCost'],
      ['Povrnjen', 'waste.reversedBadge'],
      ['V veljavi', 'waste.validBadge'],
      ['Povrni', 'waste.reverseBtn'],
      ['Evidentiraj odpad', 'waste.dialogTitle'],
      ['Izberi artikel …', 'waste.itemPlaceholder'],
      ['na zalogi', 'waste.onStock'],
      ['npr. 0,5', 'waste.qtyPlaceholder'],
      ['Izberi razlog …', 'waste.reasonPlaceholder'],
      ['npr. poškodovana embalaža', 'waste.notePlaceholder'],
      ['Na zalogi:', 'waste.onStockColon'],
      ['· cena:', 'waste.priceColon'],
      ['Ocenjeni strošek odpada:', 'waste.estimatedCost'],
      ['na zalogi je samo', 'waste.overStockSuffix'],
      ['zaloga po odpadu:', 'waste.afterWasteSuffix'],
      ['Evidentiraj', 'waste.submitBtn'],
      // ponovno uporabljeni obstoječi ključi (viri so zdaj prevedeni)
      ['Zapri', 'common.close'],
      ['Znesek', 'tips.amount'],
      ['Artikel', 'proc.article'],
      ['Količina', 'proc.qty'],
      ['Razlog', 'loy.reason'],
      ['Brez lastnika', 'payment.noOwner'],      ['1 oseba', 'wl.party1'],
      ['2 osebi', 'wl.party2'],
      ['{n} osebe', 'wl.party34'],
      ['{n} oseb', 'wl.partyN'],
      ['Čaka', 'wl.stWaiting'],
      ['Obveščen', 'wl.stNotified'],
      ['Usajen', 'wl.stSeated'],
      ['Odhod', 'wl.stLeft'],
      ['Ime gosta je obvezno.', 'wl.errName'],
      ['Število oseb mora biti celo število vsaj 1.', 'wl.errParty'],
      ['{name} dodan na čakalno listo.', 'wl.okAdded'],
      ['{name} obveščen — miza se pripravlja.', 'wl.okNotified'],
      ['{name} usajen{wait}.', 'wl.okSeated'],
      [' (čakal {dur})', 'wl.okSeatedWait'],
      ['{name} — odhod zabeležen.', 'wl.okLeft'],
      ['Izberi mizo za usaditev.', 'wl.errSelectTable'],
      ['Izbrišem vnos za {name}? Uporabi samo za pomotoma vnesene vnose.', 'wl.confirmDelete'],
      ['Vnos za {name} izbrisan.', 'wl.okDeleted'],
      ['Gosti brez rezervacije: prijava → obvestilo, ko se miza pripravlja → usaditev (miza se samodejno zaklene) ali odhod.', 'wl.desc'],
      ['Trenutno čaka', 'wl.statWaiting'],
      ['na listo', 'wl.naListo'],
      ['Obveščeni', 'wl.statNotified'],
      ['miza se pripravlja', 'wl.preparingTable'],
      ['Usajeni danes', 'wl.statSeated'],
      ['{n} odhodov', 'wl.leftCount'],
      ['Povprečno čakanje', 'wl.statAvgWait'],
      ['najdaljše {dur}', 'wl.longest'],
      ['Aktivna lista', 'wl.activeTitle'],
      ['FIFO po prijavi; rdeče = presežen napovedani čas.', 'wl.activeDesc'],
      ['Ni gostov na čakalni listi.', 'wl.empty'],
      ['Gost', 'wl.thGuest'],
      ['Čakanje', 'wl.thWait'],
      ['napoved', 'wl.forecast'],
      ['Obvesti gosta', 'wl.notifyTitle'],
      ['Obvesti', 'wl.notifyBtn'],
      ['Usadi gosta', 'wl.seatTitle'],
      ['Zabeležim odhod {name}?', 'wl.confirmLeft'],
      ['Odšel', 'wl.leftBtn'],
      ['Izbriši vnos {name}', 'wl.deleteAria'],
      ['Izbriši (samo pomota)', 'wl.deleteTitle'],
      ['Zaključeni (danes)', 'wl.finishedTitle'],
      ['Usaditvi in odhodi iz zadnjih 24 h.', 'wl.finishedDesc'],
      ['Čakal', 'wl.thWaited'],
      ['Miza', 'wl.thTable'],
      ['Miza {n}', 'wl.tableN'],
      ['Nova prijava na čakalno listo', 'wl.newTitle'],
      ['npr. Družina Novak', 'wl.namePlaceholder'],
      ['Telefon (neobvezno)', 'wl.phoneOptional'],
      ['Število oseb', 'wl.partyLabel'],
      ['Napovedani čas (min)', 'wl.quoteLabel'],
      ['Željeno območje (neobvezno)', 'wl.areaLabel'],
      ['npr. terasa, znotraj, bar', 'wl.areaPlaceholder'],
      ['Posebne potrebe (neobvezno)', 'wl.needsLabel'],
      ['npr. otroški stol, dostop invalidskih vozičkov', 'wl.needsPlaceholder'],
      ['npr. proslava, miza za 8', 'wl.notesPlaceholder'],
      ['Dodaj na listo', 'wl.submitBtn'],
      ['Usadi {name}', 'wl.seatTitleDialog'],
      ['· čaka že', 'wl.waitingSince'],
      [' · želi: {area}', 'wl.wantsSuffix'],
      ['Izberi prosto mizo …', 'wl.tablePlaceholder'],
      ['rezervirana', 'wl.tblReserved'],
      ['za čiščenje', 'wl.tblDirty'],
      ['Ni prostih miz — najprej sprosti/zaključi mizo v pregledu miz.', 'wl.noFreeTables'],
      ['Navadno', 'tc.typeRegular'],
      ['Nadure', 'tc.typeOvertime'],
      ['Praznik', 'tc.typeHoliday'],
      ['Bolniška', 'tc.typeSick'],
      ['Dopust', 'tc.typeVacation'],
      ['V čakanju', 'tc.stPending'],
      ['Potrjeno', 'tc.stApproved'],
      ['Sporno', 'tc.stDisputed'],
      ['Prijava na izmeno zabeležena — ura teče.', 'tc.okClockIn'],
      ['Odmor začet.', 'tc.okBreakStart'],
      ['Odmor zaključen.', 'tc.okBreakEnd'],
      ['Odjava zabeležena — skupaj {label}{pay}.', 'tc.okClockOut'],
      [' ({pay})', 'tc.okClockOutPay'],
      ['Vnos potrjen.', 'tc.okApproved'],
      ['Vnos označen kot sporen.', 'tc.okDisputed'],
      ['Izberi zaposlenega.', 'tc.errEmployee'],
      ['Časa prijave in odjave sta obvezna.', 'tc.errTimes'],
      ['Ročni vnos dodan (status: v čakanju potrditve).', 'tc.okManual'],
      ['Izmena v teku', 'tc.shiftActive'],
      ['Moj delovni čas', 'tc.myTitle'],
      ['Prijava ob {time}{rate}', 'tc.clockedInAt'],
      [' · ura {pay}', 'tc.rateSuffix'],
      ['Prijava in odjava izmene — ure so osnova za napitnine po urah in plačilo.', 'tc.myDesc'],
      ['☕ Na odmoru (od {time})', 'tc.onBreakBadge'],
      ['V teku', 'tc.inProgress'],
      ['Odmor', 'tc.breakBtn'],
      ['Konec odmora', 'tc.breakEndBtn'],
      ['Odjava', 'tc.clockOutBtn'],
      ['Prijava na izmeno', 'tc.clockInBtn'],
      ['Vnosov', 'tc.entriesCount'],
      ['Na izmeni', 'tc.onShift'],
      ['Izven izmene', 'tc.offShift'],
      ['Moja zgodovina (30 dni)', 'tc.myHistory'],
      ['Ni zapisov — prijavi se na izmeno.', 'tc.myEmpty'],
      ['Prijava', 'tc.thIn'],
      ['Odjava', 'tc.thOut'],
      ['Odmor', 'tc.thBreak'],
      ['Skupaj', 'tc.thTotal'],
      ['Plačilo', 'tc.thPay'],
      ['teče', 'tc.running'],
      ['Ekipa — vpogled in potrditev', 'tc.teamTitle'],
      ['Potrdi/sporen označi vnose zaposlenih; dodaj ročni vnos (popravek zgrešene ure).', 'tc.teamDesc'],
      ['Obdobje', 'tc.periodAria'],
      ['7 dni', 'tc.day7'],
      ['14 dni', 'tc.day14'],
      ['31 dni', 'tc.day31'],
      ['Skupaj (obdobje)', 'tc.totalPeriod'],
      ['V čakanju potrditve', 'tc.pendingApproval'],
      ['Trenutno na izmeni', 'tc.nowOnShift'],
      ['Na izmeni: ', 'tc.onShiftColon'],
      ['Ni vnosov v izbranem obdobju.', 'tc.teamEmpty'],
      ['Potrdi vnos', 'tc.approveTitle'],
      ['Potrdi', 'tc.approveSr'],
      ['Označi sporno', 'tc.disputeTitle'],
      ['Ročni vnos delovnega časa', 'tc.manualTitle'],
      ['Izberi zaposlenega …', 'tc.employeePlaceholder'],
      ['Odmor (min)', 'tc.breakMinutes'],
      ['npr. pozabil prijavit', 'tc.notePlaceholder'],
      ['Vnos se ustvari s statusom »v čakanju« — potrdi ga v tabeli zgoraj (potek: do 31 dni nazaj, ne v prihodnost).', 'tc.manualHint'],
      ['Dodaj vnos', 'tc.addEntryBtn'],
      ['Nalaganje …', 'tc.loading'],
      ['Odpiralni čas shranjen.', 'oh.okSaved'],
      ['Poseben dan dodan.', 'oh.okSpecialAdded'],
      ['Izbrišem posebni dan?', 'oh.confirmDeleteSpecial'],
      ['Poseben dan izbrisan.', 'oh.okSpecialDeleted'],
      ['Dodam {n} slovenskih praznikov za {year} (zaprti dnevi)? Obstojeci datumi se preskocijo.', 'oh.confirmHolidays'],
      ['Prazniki: dodanih {added}, obstoječih preskočenih {skipped}.', 'oh.okHolidays'],
      ['Nalaganje statusa …', 'oh.loadingStatus'],
      ['Privzeti urnik organizacije — lokacija nima svojega', 'oh.inheritedBadge'],
      ['Status ni na voljo.', 'oh.noStatus'],
      ['Tedenski urnik', 'oh.weekTitle'],
      ['Shrani urnik', 'oh.saveBtn'],
      ['Časi so lokalni (24-urni). Zapiralni čas pred odpiralnim pomeni delo čez polnoč. Odmor je izbirzen.', 'oh.weekDesc'],
      ['{day}: odprto', 'oh.ariaOpen'],
      ['{day}: odpre se', 'oh.ariaOpens'],
      ['{day}: zapre se', 'oh.ariaCloses'],
      ['{day}: odmor od', 'oh.ariaBreakFrom'],
      ['{day}: odmor do', 'oh.ariaBreakTo'],
      ['Zaprto', 'oh.closed'],
      ['Odmor:', 'oh.breakColon'],
      ['Posebni dnevi in prazniki', 'oh.specialTitle'],
      ['Posebni dan prevlada nad tedenskim urnikom (zaprt ali drugačen čas).', 'oh.specialDesc'],
      ['Slovenski prazniki {year}', 'oh.holidaysBtn'],
      ['Poseben dan', 'oh.specialBtn'],
      ['Ni posebnih dni. Rezervacije sledijo tedenskemu urniku.', 'oh.specialEmpty'],
      ['Zaprto cel dan', 'oh.closedAllDay'],
      ['Odprto {range}', 'oh.openHours'],
      ['Poseben urnik', 'oh.specialSchedule'],
      ['Izbriši poseben dan {date}', 'oh.deleteSpecialAria'],
      ['Poseben dan / praznik', 'oh.dialogTitle'],
      ['Odpre se', 'oh.opensAt'],
      ['Zapre se', 'oh.closesAt'],
      ['Opomba (razlog)', 'oh.noteReason'],
      ['npr. Praznik dela, zaprt zaradi dogodka', 'oh.notePlaceholder'],
    ],
  }

  for (const file of files) {
    const abs = join(import.meta.dir, file)
    const src = readFileSync(abs, 'utf-8')
    const translated = perFile[file] || []
    test(`${file.split('/').pop()} — prevedena besedila so prek t(), ne trdo kodirana`, () => {
      for (const [text, key] of translated) {
        // uporaba ključa mora obstajati (ali dinamična sestava prefix.key)
        const prefix = key.split('.')[0]
        const used = src.includes(`'${key}'`) || src.includes(`\`${prefix}.${key.split('.')[1]}`)
        if (!used) throw new Error(`${file}: ključ ${key} ni uporabljen`)
        // hardcodirana različica ne sme obstajati (v JSX nizu ali atributu)
        const esc = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const jsxHardcode = new RegExp(`>\\s*${esc}\\s*<`)
        const attrHardcode = new RegExp(`"[^"]*${esc}[^"]*"`)
        if (jsxHardcode.test(src) || attrHardcode.test(src)) {
          throw new Error(`${file}: trdo kodirano besedilo "${text}" (ključ ${key}) je še v UI`)
        }
      }
    })
  }

  test('prijava vsebuje LanguageToggle (preklop iz aplikacije, brez kode)', () => {
    const login = readFileSync(join(import.meta.dir, '../src/app/page.tsx'), 'utf-8')
    expect(login).toContain('LanguageToggle')
    expect(login).toContain('I18nProvider')
  })

  test('dashboard vsebuje preklopnik + provider', () => {
    const dash = readFileSync(join(import.meta.dir, '../src/app/dashboard/page.tsx'), 'utf-8')
    expect(dash).toContain('LanguageToggle')
    expect(dash).toContain('I18nProvider')
    expect(dash).toContain('useI18n')
  })
})
