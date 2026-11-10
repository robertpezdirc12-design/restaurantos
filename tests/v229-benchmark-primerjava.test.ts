import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { APP_VERSION } from '../src/lib/version'

/**
 * PRIMERJAVA-VMESNIKOV-2026 VAL (v1.229.0) — 5 funkcij iz benchmark analize
 * (docs/PRIMERJAVA-VMESNIKOV-2026.md: Toast, Square, Lightspeed, TouchBistro,
 * Clover, MarketMan raziskava oktober–december 2025/2026).
 *
 * 1. POS: EAN ČITALNIK → KOŠARA (Toast/Clover standard; scanner = tipkovnica
 *    + Enter) — GET /api/menus?ean= poišče InventoryItem.ean s povezanim
 *    meni artiklom (OSS-9 sloj); Enter s čisto številskim vnosom (4–14) sproži
 *    pot, besedne poizvedbe se NE.
 * 2. POS: PRILJUBLJENO ★ (Toast vzorec) — zvezdica na KARTICAH (sestrinski
 *    gumb — veljaven HTML), ★ čip pred kategorijami, persist ro_sale_favs.
 * 3. POS: HAPPY HOUR ⚡ — med aktivnim oknom auto-popusta ploščica pokaže
 *    akcijsko ceno (prikaz; kanonični obračun ostaja v billing.ts computeBill).
 * 4. MIZE: UREJEVALNIK MIZ (Toast/TouchBistro/Lightspeed vsi imajo; naš API
 *    POST/PATCH/DELETE + revizija je obstajal, UI ne) — dialog z vrstico po
 *    mizo (številka/sedeži/cona) + dodajanje + brisanje z varovalko.
 * 5. NAROČILA: PRENOS NA NATAKARJA (Lightspeed »transfer user«) — PATCH
 *    employeeId (samo aktivna naročila, lokacijski gate, revizija ORDER_TRANSFER)
 *    + izbira v NaročiloSheetu.
 */

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const menusRoute = read('src/app/api/menus/route.ts')
const tablesIdRoute = read('src/app/api/tables/[id]/route.ts')
const ordersIdRoute = read('src/app/api/orders/[id]/route.ts')
const mapLib = read('src/lib/map.ts')
const sl = read('src/lib/i18n/sl.ts')
const hr = read('src/lib/i18n/hr.ts')

describe('v1.229 A — POS EAN čitalnik (scanner → košara)', () => {
  test('A1: strežnik — GET /api/menus podpira ?ean= (InventoryItem.ean → menuItemId, lokacijski obseg)', () => {
    expect(menusRoute).toContain("req.nextUrl.searchParams.get('ean')")
    expect(menusRoute).toContain('db.inventoryItem.findFirst')
    expect(menusRoute).toContain('ean: code, menuItemId: { not: null }')
    expect(menusRoute).toContain('eanItem')
  })

  test('A2: strežnik — kraje od 4 znakov naprej iščejo (besedne poizvedbe ne)', () => {
    expect(menusRoute).toContain('eanParam.trim().length >= 4')
  })

  test('A3: klient — Enter v iskalnem polju sproži EAN pot (samo čisto številske kode 4–14)', () => {
    expect(dash).toContain("if (e.key === 'Enter') { e.preventDefault(); void saleEanSubmit() }")
    expect(dash).toContain('/^\\d{4,14}$/.test(code)')
    expect(dash).toContain("api<{ eanItem: MenuT | null }>(`/api/menus?ean=${encodeURIComponent(code)}`)")
  })

  test('A4: klient — zadetek doda v košaro in počisti polje; nezadetek pokaže opozorilo', () => {
    expect(dash).toContain("posAddClick('sale', d.eanItem)")
    expect(dash).toContain("setSaleSearch('')")
    expect(dash).toContain("t('sale.eanUnknown')")
  })

  test('A5: i18n — sale.eanAdded/sale.eanUnknown v SL in HR', () => {
    expect(sl).toContain("'sale.eanAdded': 'Dodano: {name}'")
    expect(sl).toContain("'sale.eanUnknown': 'Neznana koda — artikla s to črtno kodo ni v zalogi.'")
    expect(hr).toContain("'sale.eanAdded': 'Dodano: {name}'")
    expect(hr).toContain("'sale.eanUnknown': 'Nepoznat kod — artikla s tim crtičnim kodom nema u zalihi.'")
  })
})

describe('v1.229 B — POS priljubljeno ★ (Toast vzorec)', () => {
  test('B1: persist ro_sale_favs + hydratcijsko-varen restore (queueMicrotask, kot ro_sale_view)', () => {
    expect(dash).toContain("localStorage.getItem('ro_sale_favs')")
    expect(dash).toContain("localStorage.setItem('ro_sale_favs'")
    expect(dash).toContain('queueMicrotask')
  })

  test('B2: ★ čip v traku kategorij + filter FAVS v saleItems (deluje v OBEH pogledih)', () => {
    expect(dash).toContain("saleCat === 'FAVS' ? 'default' : 'outline'")
    expect(dash).toContain("(saleCat === 'FAVS' ? saleFavs.includes(mi.id) : mi.categoryId === saleCat)")
    expect(dash).toContain("saleMixed = saleCat === 'ALL' || saleCat === 'FAVS' || saleSearch.trim() !== ''")
  })

  test('B3: zvezdica je SESTRINSKI gumb (ne gumb-v-gumbu — neveljaven HTML) z aria-pressed', () => {
    expect(dash).toContain('aria-pressed={fav}')
    expect(dash).toContain('saleFavToggle(mi.id)')
  })

  test('B4: prazen ★ pogled je iskren (favsEmpty namig, ne prazen zaslon)', () => {
    expect(dash).toContain("saleCat === 'FAVS' && saleSearch.trim() === '' ? t('sale.favsEmpty') : t('sale.empty')")
    expect(sl).toContain("'sale.favsEmpty': 'Noben artikel ni označen z ★ — označi ga v pogledu kartic.'")
    expect(hr).toContain("'sale.favsEmpty': 'Nijedan artikl nije označen sa ★ — označi ga u prikazu kartica.'")
  })
})

describe('v1.229 C — POS Happy Hour ⚡ (akcijska cena na ploščici)', () => {
  test('C1: auto popusti se naložijo LAZY ob vstopu v prodaja (1×/5 min, filter triggerType=auto + isActive)', () => {
    expect(dash).toContain("activeTab !== 'prodaja'")
    expect(dash).toContain("d.triggerType === 'auto' && d.isActive")
    expect(dash).toContain('300_000')
  })

  test('C2: hhOf uporablja KANONIČNI isHappyActive iz billing.ts (en vir, ne kopija) + validFrom/validTo + targetCategoryIds', () => {
    expect(dash).toContain("isHappyActive } from '@/lib/billing'")
    expect(dash).toContain('d.validFrom && new Date(d.validFrom) > hhNow')
    expect(dash).toContain("(d.targetCategoryIds || '').split(',')")
  })

  test('C3: urni tiktak (okno HH se preklopi na polno uro brez čakanja na poll)', () => {
    expect(dash).toContain('setInterval(() => setHhNow(new Date()), 60_000)')
  })

  test('C4: ⚡ akcijska cena na ploščicah OBEH pogledov (kompaktni + kartice) z prečrtano osnovno ceno', () => {
    const compactSection = dash.slice(dash.indexOf("saleView === 'compact' ?"), dash.indexOf("saleView === 'compact' ?") + 6000)
    expect(compactSection).toContain('hhOf(mi)')
    expect(compactSection).toContain('fmtEUR(hh.price)')
    const cardsSection = dash.slice(dash.indexOf('grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2'))
    expect(cardsSection).toContain('hhOf(mi)')
    expect(cardsSection).toContain('fmtEUR(hh.price)')
  })

  test('C5: i18n — sale.hhAria v SL in HR (napovedovalnik cene za bralnike zaslona)', () => {
    expect(sl).toContain("'sale.hhAria': 'Akcijska cena {price}'")
    expect(hr).toContain("'sale.hhAria': 'Akcijska cijena {price}'")
  })
})

describe('v1.229 D — urejevalnik miz (Toast/TouchBistro/Lightspeed)', () => {
  test('D1: strežnik — PATCH sprejema number + seats pod menu.manage (konfiguracija prostora, ne operativni status)', () => {
    expect(tablesIdRoute).toContain('body?.number !== undefined || body?.seats !== undefined')
    expect(tablesIdRoute).toContain("requirePermission(req, isFloorPlan ? 'menu.manage' : 'orders.create')")
  })

  test('D2: strežnik — validacija (celo ≥ 1; sedeži 1–30) + konflikt številke 409', () => {
    expect(tablesIdRoute).toContain('Številka mize mora biti celo število ≥ 1.')
    expect(tablesIdRoute).toContain('Sedežev mora biti med 1 in 30.')
    expect(tablesIdRoute).toContain('number_locationId')
    expect(tablesIdRoute).toContain('že obstaja.', 409)
  })

  test('D3: strežnik — revizija TABLE_UPDATE ob konfiguracijski spremembi (status ostane brez — 15 s cikel)', () => {
    expect(tablesIdRoute).toContain("'TABLE_UPDATE'")
    expect(tablesIdRoute).toContain('from: { number: existing.number')
  })

  test('D4: UI — gumb Uredi mize viden samo z menu.manage; dialog ima vrstico po mizo + dodajanje + brisanje', () => {
    expect(dash).toContain("hasPerm('menu.manage') && (")
    expect(dash).toContain('teSave(row)')
    expect(dash).toContain('teDelete(row)')
    expect(dash).toContain('teAdd()')
    expect(dash).toContain("t('tables.addRow')")
  })

  test('D5: UI — brisanje blokirano ob aktivnem/zadržanem naročilu (isti pogoj kot tloris klik)', () => {
    expect(dash).toContain("(tb.activeOrder || tb.heldOrderId)")
    expect(dash).toContain("t('tables.deleteBlocked')")
  })

  test('D6: i18n — tables.edit/number/seatsShort/zoneShort/addRow/deleteConfirm/deleteBlocked/saveRow v SL in HR', () => {
    for (const k of ['tables.edit', 'tables.number', 'tables.seatsShort', 'tables.zoneShort', 'tables.addRow', 'tables.deleteRow', 'tables.deleteConfirm', 'tables.deleteBlocked', 'tables.saveRow']) {
      expect(sl).toContain(`'${k}':`)
      expect(hr).toContain(`'${k}':`)
    }
  })
})

describe('v1.229 E — prenos naročila na natakarja (Lightspeed transfer user)', () => {
  test('E1: strežnik — PATCH employeeId pod orders.create (vsebina se ne spreminja — ne employees.manage)', () => {
    expect(ordersIdRoute).toContain('else if (body?.employeeId !== undefined)')
    expect(ordersIdRoute).toContain("requirePermission(req, 'orders.create')")
  })

  test('E2: strežnik — samo AKTIVNA naročila (terminalna 409)', () => {
    expect(ordersIdRoute).toContain('Zaključenega naročila ni mogoče prenesti')
  })

  test('E3: strežnik — zaposleni mora obstajati, biti aktiven (status) in pripadati lokaciji naročila (403)', () => {
    expect(ordersIdRoute).toContain('status: true, locationId: true')
    expect(ordersIdRoute).toContain("emp.status !== 'active'")
    expect(ordersIdRoute).toContain('Zaposleni pripada drugi lokaciji.')
  })

  test('E4: strežnik — revizija ORDER_TRANSFER (kdo, od koga, na koga)', () => {
    expect(ordersIdRoute).toContain("'ORDER_TRANSFER'")
    expect(ordersIdRoute).toContain('toEmployeeId: empId, toName: emp.name')
  })

  test('E5: klient — izbira natakarja v NaročiloSheetu (samo aktivna naročila + orders.create)', () => {
    expect(dash).toContain("['unpaid', 'partial'].includes(orderSheet.paymentStatus || 'unpaid') && hasPerm('orders.create')")
    expect(dash).toContain('void transferOrder(v)')
  })

  test('E6: mapOrder.employee nosi id (aditivno — stari porabniki name nespremenjeni)', () => {
    expect(mapLib).toContain('employee: o.employee ? { id: o.employee.id as string, name: o.employee.name as string } : null')
  })

  test('E7: i18n — sheet.transferWaiter/transferred/waiterLabel v SL in HR', () => {
    expect(sl).toContain("'sheet.transferWaiter': 'Prenesi na natakarja'")
    expect(hr).toContain("'sheet.transferWaiter': 'Prenesi na konobara'")
    expect(sl).toContain("'sheet.transferred': 'Naročilo preneseno: {name}'")
    expect(hr).toContain("'sheet.transferred': 'Narudžba prenesena: {name}'")
  })
})

describe('v1.229 Ž — verzija + dokument (doc-truth)', () => {
  test('Ž1: verzija je dvignjena na 1.238.0 (version.ts + compose oznaka)', () => {
    expect(APP_VERSION).toBe('1.296.0')
    expect(read('src/lib/version.ts')).toContain("'1.296.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.296.0')
  })

  test('Ž2: primerjalni dokument obstaja in pokriva VSEH 5 vmesnikov', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    for (const anchor of ['VMESNIK PRODAJA', 'VMESNIK ŠANK', 'VMESNIK KUHINJA', 'VMESNIK RESTAVRACIJA', 'VMESNIK ZALOGE']) {
      expect(doc).toContain(anchor)
    }
    // benchmark viri so poimenovani
    for (const vendor of ['Toast', 'Square', 'Lightspeed', 'TouchBistro', 'MarketMan']) {
      expect(doc).toContain(vendor)
    }
  })
})
