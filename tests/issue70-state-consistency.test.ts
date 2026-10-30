/**
 * Issue #70 (P1 — Poenoti demo/operativna stanja miz, KDS časovnike in statuse
 * dostav) — popravki (v1.121.0):
 *
 *  §1 MIZE: kanonična izpeljava statusa izključno iz /api/tables (mapTable):
 *   - OCCUPIED = AKTIVNO naročilo (open/sent/prepared);
 *   - DB 'occupied' BREZ aktivnega naročila (zastarelo demo stanje, točno
 *     produkcija v1.119.0: mize 1/2/3/6) → samodejno DIRTY ("za pospraviti"),
 *     ker vsak zaključek naročila (plačilo/storno/preklic) postavi mizo v
 *     'cleaning' — 'occupied' brez naročila je nedosegljiv sicer;
 *   - handheld/tablica/dashboard izrisujejo oznako IZKLJUČNO iz tb.status
 *     (skupna preslikava tableStatusLabelKey — prej je handheld za OCCUPIED
 *     brez activeOrder pokazal "Na voljo");
 *   - API-level konsistenca: vsi statusi iz odgovora so v {FREE, OCCUPIED,
 *     RESERVED, DIRTY} in imajo oznako v SL+HR slovarjih (isti demo nabor).
 *  §2 KDS: zastareli listki > 8 h (KDS_STALE_THRESHOLD_MIN = 480) —
 *   isStaleKdsTicket/staleTicketHours enote + pragovi; vrsta /api/kitchen na
 *   ISTEM naboru (stari demo listek 9 dni + svež listek) razrešena po UI
 *   pravilu "aktivni najprej, zastareli na konec" (isto sortiranje kot
 *   dashboard); source-pin: dashboard + kds-station-board obe plošči.
 *  §3 DOSTAVE: deliveryOrderIsActive — zgodovina ("Zaključene dostave") = SAMO
 *   terminalni zapisi (PAID/CANCELLED ali DELIVERED/CANCELLED); dostavno
 *   naročilo BREZ DeliveryInfo (produkcija: 19× OPEN demo) je AKTIVNO;
 *   source-pin oznake zgodovine + kartice 'dost.noInfo'.
 *  §4 TLORIS: floorPlanUnitIsPercent/planPositionOf — produkcija-like nabor
 *   (vse vrednosti ≤ 100 = odstotki) se NE stisne v zgornji levi kot;
 *   px nabor (seed 40..400) se deli s 440×380; mize brez pozicije → avto-mreža;
 *   source-pin: dashboard uporablja skupno preslikavo + persist v enoti nabora.
 *  §R REGISTRI: 'i70-' v TEST_PREFIXES; APP_VERSION 1.134.0; 0 DDL (posX/posY
 *   že obstajata v shemi — patch je čisto v preslikavi).
 *
 * Fiksture s predpono `i70-`. Read-only narava produkcije je spoštovana:
 * vsi testi tečejo proti lokalni SQLite (sweepTestFixtures varovalka).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { TEST_PREFIXES } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { nid, mapTable } from '../src/lib/map'
import { APP_VERSION } from '../src/lib/version'
import { isStaleKdsTicket, staleTicketHours, KDS_STALE_THRESHOLD_MIN, delayThresholdForTarget } from '../src/lib/kds-delays'
import { tableStatusLabelKey } from '../src/lib/table-status'
import { deliveryOrderIsActive } from '../src/lib/delivery-view'
import { floorPlanUnitIsPercent, planPositionOf, FLOOR_PLAN_W, FLOOR_PLAN_H } from '../src/lib/floor-plan'
import { GET as tablesGET } from '../src/app/api/tables/route'
import { GET as kitchenGET } from '../src/app/api/kitchen/route'
import { GET as deliveryGET } from '../src/app/api/delivery/route'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'i70-'
const RUN = Date.now().toString(36)
const PIN = `${String(Date.now()).slice(-6)}3`

const src = (p: string): string => readFileSync(join(process.cwd(), 'src', p), 'utf8')

function req(url: string, token: string | null, method = 'GET'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(`http://localhost:3000${url}`, { method, headers })
}

// ── DB fiksture ──
let locId = ''
let mgrToken = ''
let orderSeqCounter = 994000

async function seedTable(number: number, status: string, posX: number, posY: number, area = 'main'): Promise<string> {
  const id = `${P}tbl-${number}-${RUN}`
  await db.table.create({ data: { id, number, capacity: 4, status, area, posX, posY, locationId: locId } })
  return id
}

/** Naročilo z eno aktivno postavko (status po želji; firedAt neobvezno). */
async function seedOrder(opts: { tableId?: string | null; status: string; type?: string; createdAt?: Date; deliveryInfoId?: string | null; paymentStatus?: string }): Promise<string> {
  const orderId = `${P}ord-${orderSeqCounter}-${RUN}`
  const menuId = `${P}menu-${orderSeqCounter}-${RUN}`
  const catId = `${P}cat-${orderSeqCounter}-${RUN}`
  const miId = `${P}mi-${orderSeqCounter}-${RUN}`
  orderSeqCounter++
  await db.menu.create({ data: { id: menuId, name: `${P}Meni ${RUN}`, locationId: locId } })
  await db.category.create({ data: { id: catId, name: `${P}Kategorija ${RUN}`, menuId } })
  await db.menuItem.create({ data: { id: miId, name: `${P}Jed`, price: 5, categoryId: catId, vatRate: 22 } })
  await db.order.create({
    data: {
      id: orderId, orderNumber: orderSeqCounter, locationId: locId,
      tableId: opts.tableId ?? null, status: opts.status, type: opts.type ?? 'dine-in',
      paymentStatus: opts.paymentStatus ?? 'unpaid',
      subtotal: 5, tax: 0.9, total: 5.9,
      ...(opts.deliveryInfoId ? { deliveryInfoId: opts.deliveryInfoId } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  })
  await db.orderItem.create({
    data: { id: `${P}itm-${orderId}`, orderId, menuItemId: miId, quantity: 1, price: 5, vatRate: 22, vatAmount: 0.9, menuItemName: `${P}Jed`, status: 'pending', voided: false },
  })
  return orderId
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  locId = (await db.location.create({
    data: { id: `${P}loc-${RUN}`, name: `${P}Lokacija`, code: `I70-${RUN.toUpperCase()}`, premisesId: `${P}SI-${RUN}`, taxId: 'SI12345678', registerNumber: 'BLG-I70-01', country: 'SI', fursEnvironment: 'test' },
  })).id
  const fields = employeePinFields(PIN, `${P}mgr-${RUN}@test.local`)
  const mgrId = `${P}mgr-${RUN}`
  await db.employee.create({
    data: {
      id: mgrId, name: `${P}Manager`, email: `${P}mgr-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locId,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
  mgrToken = createToken({ sub: mgrId, name: `${P}Manager`, role: 'manager', loc: locId, sv: 0 })
})

afterAll(async () => {
  // nid() id-ji (Order → OrderItem/Receipt/Payment + revizije/dogodki) po entityId/details predponi
  const orders = await db.order.findMany({ where: { locationId: locId }, select: { id: true } })
  for (const oid of orders.map((o) => o.id)) {
    const receipts = await db.receipt.findMany({ where: { orderId: oid }, select: { id: true } })
    const receiptIds = receipts.map((r) => r.id)
    const checks = await db.check.findMany({ where: { orderId: oid }, select: { id: true } })
    await db.payment.deleteMany({ where: { orderId: oid } }).catch(() => null)
    await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
    await db.eventLog.deleteMany({ where: { OR: [{ entityId: { in: [...receiptIds, oid] } }, { payload: { contains: P } }] } }).catch(() => null)
    await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...receiptIds, oid] } }, { details: { contains: P } }] } }).catch(() => null)
    await db.check.deleteMany({ where: { orderId: oid } }).catch(() => null)
    await db.receipt.deleteMany({ where: { orderId: oid } }).catch(() => null)
    await db.orderItem.deleteMany({ where: { orderId: oid } }).catch(() => null)
    await db.order.deleteMany({ where: { id: oid } }).catch(() => null)
  }
  const menus = await db.menu.findMany({ where: { locationId: locId }, select: { id: true } })
  const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
  const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
  await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } }).catch(() => null)
  // dostave (DeliveryInfo nima @relation na Order pri brisanju — ročno)
  await db.deliveryTracking.deleteMany({ where: { deliveryInfoId: { contains: P } } }).catch(() => null)
  await db.deliveryInfo.deleteMany({ where: { id: { contains: P } } }).catch(() => null)
  // mize + QR povezani dogodki/revizije + osebje/lokacija + dokaz čiščenja
  const tables = await db.table.findMany({ where: { locationId: locId }, select: { id: true } })
  await db.eventLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
  const leftovers = await db.table.count({ where: { id: { startsWith: P } } })
  expect(leftovers).toBe(0)
})

// ═══ §1 — kanonična stanja miz (isti vir: /api/tables) ═══

describe('§1 Mize — kanonični status iz /api/tables (mapTable)', () => {
  it('mapTable: zastarelo "occupied" BREZ naročila → DIRTY (avto-obravnavanje, 0 mutacij)', () => {
    const row = { id: 'i70-x', number: 1, capacity: 4, area: 'main', posX: 0, posY: 0, status: 'occupied', locationId: 'loc' }
    expect(mapTable(row, null).status).toBe('DIRTY')
    expect(mapTable(row, null).activeOrder).toBeNull()
    // DB 'occupied' + aktivno naročilo → OCCUPIED (kanonično pravilo)
    expect(mapTable(row, { id: 'i70-o', total: 5.9, splitCount: 2 } as never).status).toBe('OCCUPIED')
  })

  it('GET /api/tables: produkcija-like nabor (mize 1/2/3/6 "occupied" brez naročila) → DIRTY', async () => {
    // točno demo stanje iz issue #70 §1: mize 1,2,3,6 'occupied' brez aktivnega naročila
    await seedTable(1, 'occupied', 31.0, 25.3)
    await seedTable(2, 'occupied', 38.6, 53.2)
    await seedTable(3, 'occupied', 46.6, 59.9)
    await seedTable(6, 'occupied', 63.5, 19.9, 'patio')
    await seedTable(9, 'occupied', 35.4, 62.9, 'bar')       // + AKTIVNO naročilo → OCCUPIED
    await seedTable(10, 'cleaning', 9.3, 41.8, 'bar')        // → DIRTY (isto kot prej)
    await seedTable(4, 'reserved', 52.6, 54.8)               // → RESERVED
    await seedTable(5, 'available', 63.9, 55.1)              // → FREE
    await seedOrder({ tableId: (await db.table.findFirst({ where: { number: 9, locationId: locId } }))!.id, status: 'sent' })
    // miza 11: 'available' + aktivno naročilo → OCCUPIED (naročilo je kanonični vir)
    const t11 = await seedTable(11, 'available', 35.5, 64.3, 'bar')
    await seedOrder({ tableId: t11, status: 'open' })

    const res = await tablesGET(req('/api/tables', mgrToken))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tables: { id: string; number: number; status: string; activeOrder: unknown }[] }
    const byNumber = new Map(body.tables.map((t) => [t.number, t]))
    expect(byNumber.get(1)!.status).toBe('DIRTY')   // prej dashboard "Zasedena" / handheld "Na voljo"
    expect(byNumber.get(2)!.status).toBe('DIRTY')
    expect(byNumber.get(3)!.status).toBe('DIRTY')
    expect(byNumber.get(6)!.status).toBe('DIRTY')
    expect(byNumber.get(9)!.status).toBe('OCCUPIED')
    expect(byNumber.get(9)!.activeOrder).not.toBeNull()
    expect(byNumber.get(10)!.status).toBe('DIRTY')
    expect(byNumber.get(4)!.status).toBe('RESERVED')
    expect(byNumber.get(5)!.status).toBe('FREE')
    expect(byNumber.get(11)!.status).toBe('OCCUPIED') // aktivno naročilo vedno premaga DB status
    expect(byNumber.get(11)!.activeOrder).not.toBeNull()
  })

  it('konsistenca (sprejemno merilo §1): vsi statusi imajo oznako v SL+HR — handheld/dashboard izrisujeta iz ISTEGA nabora', async () => {
    const res = await tablesGET(req('/api/tables', mgrToken))
    const body = (await res.json()) as { tables: { status: string }[] }
    for (const t of body.tables) {
      // status je VEDNO iz kanoničnega slovarja (nikoli surov DB niz)
      expect(['FREE', 'OCCUPIED', 'RESERVED', 'DIRTY']).toContain(t.status)
      // oznaka, ki jo izrišejo handheld/tablica (tableStatusLabelKey), obstaja v OBEH jezikih
      const key = tableStatusLabelKey(t.status)
      expect(sl[key as keyof typeof sl]).toBeTruthy()
      expect(hr[key as keyof typeof hr]).toBeTruthy()
    }
  })

  it('source-pin: handheld + tablica oznaka IZKLJUČNO iz tb.status (stara activeOrder oznaka odstranjena)', () => {
    const hh = src('app/handheld/page.tsx')
    const tab = src('app/tablica/page.tsx')
    for (const f of [hh, tab]) {
      expect(f).toContain("import { tableStatusLabelKey } from '@/lib/table-status'")
      expect(f).toContain('{t(tableStatusLabelKey(tb.status))}')
      // prej: tb.activeOrder ? t('tlb.occupied') : … : t('tables.available') — regresija
      expect(f).not.toContain("tb.activeOrder ? t('tlb.occupied')")
    }
  })

  it('source-pin: dashboard mreža Mize — oznaka iz tb.status (ne activeOrder)', () => {
    const dash = src('app/dashboard/page.tsx')
    expect(dash).toContain("{tb.status === 'DIRTY' ? t('tables.clickClean') : stL(tb.status)}")
    expect(dash).not.toContain("{tb.activeOrder ? stL('OCCUPIED')")
  })
})

// ═══ §2 — KDS zastareli listki (> 8 h) ═══

describe('§2 KDS — zastareli listki ( prag 8 h, starost v urah )', () => {
  it('isStaleKdsTicket: prag je STROGO > 480 min; meja 480/479 ni zastarela, 481 je', () => {
    expect(KDS_STALE_THRESHOLD_MIN).toBe(480)
    expect(isStaleKdsTicket(479)).toBe(false)
    expect(isStaleKdsTicket(480)).toBe(false) // meja = aktivna (konzervativno)
    expect(isStaleKdsTicket(481)).toBe(true)
    expect(isStaleKdsTicket(13413)).toBe(true) // produkcija v1.119.0 (~9,3 dni)
    expect(isStaleKdsTicket(2343)).toBe(true)  // produkcija v1.119.0 (~1,6 dneva)
    expect(isStaleKdsTicket(143)).toBe(false)  // današnji demo listek
    expect(isStaleKdsTicket(null)).toBe(false)
    expect(isStaleKdsTicket(undefined)).toBe(false)
    expect(isStaleKdsTicket(Number.NaN)).toBe(false)
  })

  it('staleTicketHours: 13.496 min → 224 h (ne "13.496 min"); negativno/null → 0', () => {
    expect(staleTicketHours(13496)).toBe(224)
    expect(staleTicketHours(481)).toBe(8)
    expect(staleTicketHours(0)).toBe(0)
    expect(staleTicketHours(-5)).toBe(0)
    expect(staleTicketHours(null)).toBe(0)
  })

  it('zastarelost ne vpliva na prag zamudcev (delayThreshold ostaja per-postaja)', () => {
    // prag zamudcev je ločen (max(10, ceil(target×1.25))) — zastarelost je SAMO vrstni red/oznaka
    expect(delayThresholdForTarget(null)).toBe(10)
    expect(delayThresholdForTarget(8)).toBe(10)
    expect(delayThresholdForTarget(16)).toBe(20)
  })

  it('konsistenca (sprejemno merilo §2): isti nabor /api/kitchen — UI pravilo postavi svež listek PRED zastareli', async () => {
    // produkcija-like: listek #690 star ~9 dni (status 'prepared'/'ready' — obtičal) + svež listek
    const staleId = await seedOrder({ status: 'sent', createdAt: new Date(Date.now() - 9 * 24 * 3600 * 1000) })
    const freshId = await seedOrder({ status: 'sent', createdAt: new Date(Date.now() - 2 * 60 * 1000) })
    const res = await kitchenGET(req('/api/kitchen', mgrToken))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { queue: { id: string; createdAt: string }[] }
    const ids = body.queue.map((o) => o.id)
    expect(ids).toContain(staleId)
    expect(ids).toContain(freshId)
    // strežnik vrača createdAt ASC (najstarejši prvi — zato je zastareli listek dominiral)
    expect(ids.indexOf(staleId)).toBeLessThan(ids.indexOf(freshId))
    // UI pravilo (dashboard): aktivni najprej, zastareli na konec (stabilno sortiranje)
    const kdsMinutes = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
    const uiOrder = body.queue
      .slice()
      .sort((a, b) => Number(isStaleKdsTicket(kdsMinutes(a.createdAt))) - Number(isStaleKdsTicket(kdsMinutes(b.createdAt))))
      .map((o) => o.id)
    expect(uiOrder.indexOf(freshId)).toBeLessThan(uiOrder.indexOf(staleId)) // zastareli NE dominira
    expect(isStaleKdsTicket(kdsMinutes(body.queue.find((o) => o.id === staleId)!.createdAt))).toBe(true)
    expect(isStaleKdsTicket(kdsMinutes(body.queue.find((o) => o.id === freshId)!.createdAt))).toBe(false)
  })

  it('source-pin: dashboard KDS vrsta sortira zastarele na konec + ura/oznaka; kds-station-board isto', () => {
    const dash = src('app/dashboard/page.tsx')
    expect(dash).toContain('isStaleKdsTicket')
    expect(dash).toContain('t(\'kds.stale\')')
    expect(dash).toContain('t(\'kds.staleHours\', { h: staleTicketHours(ageMin) })')
    expect(dash).toContain("t('kds.staleHint')")
    const board = src('components/kds-station-board.tsx')
    expect(board).toContain('staleLast')
    expect(board).toContain('groupIsStale')
    expect(board).toContain("t('kds.staleHours', { h: staleTicketHours(age) })")
  })

  it('i18n: kds.stale / kds.staleHours / kds.staleHint obstajata v SL in HR', () => {
    for (const k of ['kds.stale', 'kds.staleHours', 'kds.staleHint']) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
  })
})

// ═══ §3 — Dostave: semantično skladna sekcija "Zaključene dostave" ═══

describe('§3 Dostave — zgodovina = SAMO terminalni zapisi', () => {
  it('deliveryOrderIsActive: naročilo BREZ DeliveryInfo + OPEN je AKTIVNO (ne "zaključeno")', () => {
    // produkcija v1.119.0: 19 dostavnih naročil brez DeliveryInfo, status OPEN — vsa so
    // padla v "Zaključene dostave" z oznako OPEN
    expect(deliveryOrderIsActive({ status: 'OPEN', delivery: null })).toBe(true)
    expect(deliveryOrderIsActive({ status: 'OPEN', delivery: { status: 'PENDING' } })).toBe(true)
    expect(deliveryOrderIsActive({ status: 'OPEN', delivery: { status: 'ON_THE_WAY' } })).toBe(true)
    // terminalno:
    expect(deliveryOrderIsActive({ status: 'OPEN', delivery: { status: 'DELIVERED' } })).toBe(false)
    expect(deliveryOrderIsActive({ status: 'OPEN', delivery: { status: 'CANCELLED' } })).toBe(false)
    expect(deliveryOrderIsActive({ status: 'PAID', delivery: null })).toBe(false)
    expect(deliveryOrderIsActive({ status: 'PAID', delivery: { status: 'PENDING' } })).toBe(false)
    expect(deliveryOrderIsActive({ status: 'CANCELLED', delivery: { status: 'DELIVERED' } })).toBe(false)
  })

  it('konsistenca (sprejemno merilo §3): /api/delivery na istem naboru — aktivnost po UI pravilu', async () => {
    // produkcija-like: dostavno naročilo BREZ DeliveryInfo (status OPEN) + dostavljena dostava
    const diDelivered = `${P}di-delivered-${RUN}`
    await db.deliveryInfo.create({ data: { id: diDelivered, address: `${P}Ulica 1`, city: 'Ljubljana', status: 'delivered', deliveryFee: 2.5, packagingFee: 0 } })
    const noInfoId = await seedOrder({ status: 'open', type: 'delivery' })
    const deliveredId = await seedOrder({ status: 'open', type: 'delivery', deliveryInfoId: diDelivered })
    const res = await deliveryGET(req('/api/delivery', mgrToken))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { orders: { id: string; status: string; delivery: { status: string } | null }[] }
    const noInfo = body.orders.find((o) => o.id === noInfoId)!
    const delivered = body.orders.find((o) => o.id === deliveredId)!
    expect(noInfo.delivery).toBeNull()                       // točno produkcija: 19× brez podatkov
    expect(noInfo.status).toBe('OPEN')
    expect(delivered.delivery!.status).toBe('DELIVERED')      // mapDeliveryInfo → UPPERCASE
    // UI razvrstitev na ISTEM odgovoru: brez podatkov = AKTIVNO (ne "zaključeno")
    expect(deliveryOrderIsActive(noInfo)).toBe(true)
    expect(deliveryOrderIsActive(delivered)).toBe(false)
  })

  it('konsistenca (sprejemno merilo §3): oznake zgodovine so izključno terminalne (nikoli "OPEN")', () => {
    // enaka pravila kot UI (backoffice-tab): PAID/CANCELLED → status naročila; sicer
    // DELIVERED/CANCELLED dostave. Zgodbina se ne more več izrisati kot OPEN.
    const history = [
      { status: 'PAID', delivery: { status: 'DELIVERED' } },
      { status: 'PAID', delivery: null },
      { status: 'CANCELLED', delivery: { status: 'PENDING' } },
      { status: 'OPEN', delivery: { status: 'DELIVERED' } },
      { status: 'OPEN', delivery: { status: 'CANCELLED' } },
    ]
    for (const o of history) expect(deliveryOrderIsActive(o as never)).toBe(false)
    const badgeOf = (o: { status: string; delivery: { status: string } | null }): string =>
      ['PAID', 'CANCELLED'].includes(o.status) ? o.status : (o.delivery?.status ?? o.status)
    for (const o of history) expect(badgeOf(o)).not.toBe('OPEN')
  })

  it('source-pin: filter uporablja deliveryOrderIsActive; kartica brez podatkov + terminalne oznake', () => {
    const tab = src('components/tabs/backoffice-tab.tsx')
    expect(tab).toContain("import { deliveryOrderIsActive } from '@/lib/delivery-view'")
    expect(tab).toContain('orders.filter(deliveryOrderIsActive)')
    expect(tab).toContain("t('dost.noInfo')")
    expect(tab).not.toContain('o.delivery && o.delivery.status !==')
  })

  it('i18n: dost.noInfo obstaja v SL in HR', () => {
    expect(sl['dost.noInfo' as keyof typeof sl]).toBeTruthy()
    expect(hr['dost.noInfo' as keyof typeof hr]).toBeTruthy()
  })
})

// ═══ §4 — Tloris: enotsko-odporne pozicije (produkcija: odstotki, seed: px) ═══

describe('§4 Tloris — detekcija enote nabora pozicij', () => {
  /** Produkcija v1.119.0: 13 miz, posX 8,6 … 69,9 / posY 7,2 … 64,3 (odstotki). */
  const PROD_LIKE = [
    { id: 'i70-p1', zone: 'bar', posX: 35.4, posY: 62.9 },
    { id: 'i70-p2', zone: 'bar', posX: 9.3, posY: 41.8 },
    { id: 'i70-p3', zone: 'main', posX: 31.0, posY: 25.3 },
    { id: 'i70-p4', zone: 'main', posX: 38.6, posY: 53.2 },
    { id: 'i70-p5', zone: 'main', posX: 46.6, posY: 59.9 },
    { id: 'i70-p6', zone: 'main', posX: 52.6, posY: 54.8 },
    { id: 'i70-p7', zone: 'main', posX: 63.9, posY: 55.1 },
    { id: 'i70-p8', zone: 'main', posX: 8.6, posY: 41.9 },
    { id: 'i70-p9', zone: 'patio', posX: 63.5, posY: 19.9 },
    { id: 'i70-p10', zone: 'patio', posX: 62.5, posY: 24.5 },
    { id: 'i70-p11', zone: 'patio', posX: 59.5, posY: 35.9 },
    { id: 'i70-p12', zone: 'patio', posX: 69.8, posY: 44.2 },
    { id: 'i70-p13', zone: 'private', posX: 34.6, posY: 7.2 },
  ]
  /** Seed vrednosti: px na platnu 440×380 (40 … 400). */
  const SEED_LIKE = [
    { id: 'i70-s1', zone: 'main', posX: 40, posY: 40 },
    { id: 'i70-s2', zone: 'main', posX: 160, posY: 40 },
    { id: 'i70-s3', zone: 'main', posX: 280, posY: 140 },
    { id: 'i70-s4', zone: 'main', posX: 400, posY: 240 },
  ]

  it('floorPlanUnitIsPercent: produkcija-like (vse ≤ 100) → odstotki; seed px → px', () => {
    expect(floorPlanUnitIsPercent(PROD_LIKE)).toBe(true)
    expect(floorPlanUnitIsPercent(SEED_LIKE)).toBe(false)
    expect(floorPlanUnitIsPercent([])).toBe(false)                       // brez pozicij → px privzeto
    expect(floorPlanUnitIsPercent([{ id: 'x', zone: 'z', posX: 0, posY: 0 }])).toBe(false) // degenerirano
  })

  it('planPositionOf: produkcija-like nabor se izriše RAZPRŠENO (ne v zgornjem levem kotu)', () => {
    // hrošč: prej je bilo posX/440 → vse znotraj 16 % širine (zgornji levi vogal)
    const xs = PROD_LIKE.map((t) => planPositionOf(t, PROD_LIKE).x)
    const ys = PROD_LIKE.map((t) => planPositionOf(t, PROD_LIKE).y)
    for (const x of xs) expect(x).toBeGreaterThan(8) // 9,3 % ostane 9,3 % (ne 2,1 %)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(50) // razpon ~61 %, prej ~14 %
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(50)
    const p1 = planPositionOf(PROD_LIKE[0]!, PROD_LIKE)
    expect(Math.round(p1.x * 10) / 10).toBe(35.4)
    expect(Math.round(p1.y * 10) / 10).toBe(62.9)
  })

  it('planPositionOf: px nabor (seed) se deli s platnom 440×380 (zgodovinsko vedenje)', () => {
    const s4 = planPositionOf(SEED_LIKE[3]!, SEED_LIKE)
    expect(s4.x).toBeCloseTo(400 / FLOOR_PLAN_W * 100, 5)
    expect(s4.y).toBeCloseTo(240 / FLOOR_PLAN_H * 100, 5)
    const s1 = planPositionOf(SEED_LIKE[0]!, SEED_LIKE)
    expect(s1.x).toBeCloseTo(40 / FLOOR_PLAN_W * 100, 5)
  })

  it('planPositionOf: mize BREZ pozicije → avto-mreža po conah (stolpec cona, vrstica miza)', () => {
    const tables = [
      { id: 'i70-g1', zone: 'Glavna dvorana', posX: 0, posY: 0 },
      { id: 'i70-g2', zone: 'Glavna dvorana', posX: 0, posY: 0 },
      { id: 'i70-g3', zone: 'Terasa', posX: 0, posY: 0 },
      { id: 'i70-g4', zone: 'Terasa', posX: 0, posY: 0 },
      { id: 'i70-g5', zone: 'Terasa', posX: 0, posY: 0 },
    ]
    const g1 = planPositionOf(tables[0]!, tables)
    const g2 = planPositionOf(tables[1]!, tables)
    const g3 = planPositionOf(tables[2]!, tables)
    const g5 = planPositionOf(tables[4]!, tables)
    expect(g1.x).toBe(15)                        // prva cona = prvi stolpec
    expect(g2.x).toBe(15)                        // ista cona, ista vrstica? ne — idx%5 vrstice
    expect(g2.y).toBeGreaterThan(g1.y)           // druga miza v coni = nižja vrstica
    expect(g3.x).toBe(32)                        // druga cona = drugi stolpec
    expect(g5.y).toBeGreaterThan(g3.y)
    for (const t of tables) {
      const p = planPositionOf(t, tables)
      expect(p.x).toBeGreaterThanOrEqual(3)
      expect(p.x).toBeLessThanOrEqual(97)
    }
  })

  it('planPositionOf: clamp na platno (3 … 97) tudi za skrajne vrednosti', () => {
    // čisti odstotkovski nabor na robu (100 %) → clamp 97 (nikoli izven platna)
    const pctSet = [{ id: 'i70-e1', zone: 'z', posX: 100, posY: 100 }]
    const e1 = planPositionOf(pctSet[0]!, pctSet)
    expect(e1.x).toBe(97)
    expect(e1.y).toBe(97)
    // px nabor (vrednost > 100 razkrije enoto): 120 px → 27,3 % platna
    const pxSet = [{ id: 'i70-e3', zone: 'z', posX: 120, posY: 90 }, { id: 'i70-e4', zone: 'z', posX: 440, posY: 10 }]
    const p = planPositionOf(pxSet[0]!, pxSet)
    expect(p.x).toBeCloseTo(120 / 440 * 100, 5)
  })

  it('source-pin: dashboard uporablja skupno preslikavo + persist v enoti nabora', () => {
    const dash = src('app/dashboard/page.tsx')
    expect(dash).toContain("import { FLOOR_PLAN_W, FLOOR_PLAN_H, floorPlanUnitIsPercent, planPositionOf } from '@/lib/floor-plan'")
    expect(dash).toContain('planPos[tb.id] ?? planPositionOf(')
    expect(dash).toContain('const percent = floorPlanUnitIsPercent(') // vlečenje persist v enoti nabora
  })

  it('0 DDL: posX/posY že obstajata v obeh shemah (ni bilo spremembe sheme)', () => {
    const sqlite = readFileSync(join(process.cwd(), 'prisma/schema.sqlite.prisma'), 'utf8')
    expect(sqlite).toContain('posX            Float           @default(0)')
    expect(sqlite).toContain('posY            Float           @default(0)')
    const pg = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    expect(pg).toMatch(/posX\s+Float\s+@default\(0\)/)
    expect(pg).toMatch(/posY\s+Float\s+@default\(0\)/)
  })
})

// ═══ §R — registri ═══

describe('§R Registri — verzija / sweep predpona', () => {
  it('APP_VERSION je 1.137.0', () => {
    expect(APP_VERSION).toBe('1.202.0')
  })

  it("TEST_PREFIXES vsebuje 'i70-'", () => {
    expect(TEST_PREFIXES.includes('i70-')).toBe(true)
  })

  it('fiksna predpona i70- je samo v lastnih id-jih', () => {
    expect(nid()).not.toContain(P) // nid() nikoli ne generira testne predpone
  })
})
