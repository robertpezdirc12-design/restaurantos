import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid, num } from '@/lib/map'
import {
  parseHm,
  tempoLocalParts,
  tempoZonedTimeToUtc,
  serviceSpansForLocalDay,
  serviceSpansInWindow,
  mergeIntervals,
  overlapMinutes,
  aggregateTableTempo,
  gapRowOf,
  aggregateServiceGaps,
  medianOf,
  type TempoOpeningRow,
  type TempoTableSample,
  type TempoGapOrder,
  type TempoServiceSpan,
} from '../src/lib/tempo-insights'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { APP_VERSION } from '../src/lib/version'
import { GET as tempoGET } from '../src/app/api/reports/tempo/route'

/**
 * v1.250.0 — TEMPO VAL (docs/PRIMERJAVA-VMESNIKOV-2026 §24).
 *
 * Lightspeed junij 2026 Tempo »service insights«: »tables with the most empty
 * time and orders with the longest service gaps« — odložena točka §22 D /
 * sklep §23, izpeljana DETERMINISTIČNO iz obstoječih podatkov (Order.createdAt
 * → paidAt po mizah + OrderItem firedAt/readyAt po naročilih).
 *
 *  Č1) ČISTI SLOJ tempo-insights.ts — časovni pas (DSP-robovi!), spani
 *      odprtih ur (tedenske vrstice + posebni dnevi + odmik kosila),
 *      intervalna matematika (unija + presek), prazni čas miz, servisne
 *      luknje (mediane + top N, preklicane postavke izven).
 *  Č2) ŽIVA RUTA GET /api/reports/tempo — pravica reports.sales (natakar
 *      403), obseg, oblika odgovora, izmerjene vrednosti naročil, števci,
 *      okno dni (clamp 1..90).
 *  Č3) UI MONTAŽA — kartica v Analitiki (pregled), gating reports.sales,
 *      data-region oznake, CSV izvoz.
 *  Ž)  REGISTRI — verzija 1.257.0, compose, i18n 4093/4093 pariteta,
 *      dokumenti (PRIMERJAVA §24, AUDIT števci), worklog pin.
 *
 * 0 DDL · 0 novih odvisnosti · 0 AI.
 */

const PREFIX = 'v250-'
const TS = Date.now()

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const routeSrc = read('src/app/api/reports/tempo/route.ts')
const libSrc = read('src/lib/tempo-insights.ts')
const analitika = read('src/components/tabs/analitika-tab.tsx')
const dtabs = read('src/components/dashboard-tabs.tsx')
const slSrc = read('src/lib/i18n/sl.ts')
const hrSrc = read('src/lib/i18n/hr.ts')
const compose = read('deploy/docker-compose.yml')
const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
const wl = read('worklog.md')

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/* ═══════════ fixtures (vzorec v249: lokacija + zaposlena + mize + urnik) ═══════════ */

let locA = ''
let mgrA = ''
let waiterA = ''
let tokMgr = ''
let tokWaiter = ''
let tableA = ''
let tableB = ''
let tableC = ''

async function cleanupFixtures() {
  const locs = await db.location.findMany({ where: { name: { startsWith: PREFIX } } }, { select: { id: true } })
  const locIds = locs.map((l) => l.id)
  for (const locId of locIds) {
    const orders = await db.order.findMany({ where: { locationId: locId }, select: { id: true } })
    for (const o of orders) {
      const items = await db.orderItem.findMany({ where: { orderId: o.id }, select: { id: true } })
      await db.orderItemModifier.deleteMany({ where: { orderItemId: { in: items.map((i) => i.id) } } }).catch(() => null)
      const checks = await db.check.findMany({ where: { orderId: o.id }, select: { id: true } })
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
      await db.eventLog.deleteMany({ where: { entityId: o.id } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { entityId: o.id } }).catch(() => null)
      await db.check.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.receipt.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.stockTransaction.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.orderItem.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.order.deleteMany({ where: { id: o.id } }).catch(() => null)
    }
    const tables = await db.table.findMany({ where: { locationId: locId }, select: { id: true } })
    await db.eventLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.auditLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.table.deleteMany({ where: { locationId: locId } }).catch(() => null)
    await db.openingHours.deleteMany({ where: { locationId: locId } }).catch(() => null)
    await db.specialOpeningDay.deleteMany({ where: { locationId: locId } }).catch(() => null)
    const menus = await db.menu.findMany({ where: { locationId: locId }, select: { id: true } })
    const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
    const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
    await db.menuItemModifierGroup.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } }).catch(() => null)
    await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } }).catch(() => null)
    await db.employee.deleteMany({ where: { locationId: locId } }).catch(() => null)
    // v1.288.0: tudi števec naročil (nextSequence ga ustvari za vsako lokacijo z API-naročili; izmerjeno 49 mrtvih 'order:<nid>' — lokacijski dokaz za 0a izteg je bil izbrisan prej)
    await db.counter.deleteMany({ where: { name: { in: [`receipt:${locId}`, `order:${locId}`] } } }).catch(() => null)
    await db.location.deleteMany({ where: { id: locId } }).catch(() => null)
  }
}

/** Ponastavi naročila med skupinami (vsak test ustvari sveže). */
async function resetOrders() {
  const orders = await db.order.findMany({ where: { locationId: locA }, select: { id: true } })
  for (const o of orders) {
    const items = await db.orderItem.findMany({ where: { orderId: o.id }, select: { id: true } })
    await db.orderItemModifier.deleteMany({ where: { orderItemId: { in: items.map((i) => i.id) } } }).catch(() => null)
    const checks = await db.check.findMany({ where: { orderId: o.id }, select: { id: true } })
    await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
    await db.eventLog.deleteMany({ where: { entityId: o.id } }).catch(() => null)
    await db.auditLog.deleteMany({ where: { entityId: o.id } }).catch(() => null)
    await db.check.deleteMany({ where: { orderId: o.id } }).catch(() => null)
    await db.receipt.deleteMany({ where: { orderId: o.id } }).catch(() => null)
    await db.stockTransaction.deleteMany({ where: { orderId: o.id } }).catch(() => null)
    await db.orderItem.deleteMany({ where: { orderId: o.id } }).catch(() => null)
    await db.order.deleteMany({ where: { id: o.id } }).catch(() => null)
  }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  await cleanupFixtures()

  locA = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} Lokacija A`, code: `${PREFIX}-A-${TS}`, premisesId: `BLGV250A${TS}`,
      taxId: 'SI12345678', registerNumber: 'BLG-V250-01A', country: 'SI', timezone: 'Europe/Ljubljana' },
  })).id
  mgrA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Vodja A`, email: `${PREFIX}-mgr-a-${TS}@test.local`, role: 'manager', pin: `${PREFIX}-pin-ma-${TS}`, locationId: locA },
  })).id
  tokMgr = createToken({ sub: mgrA, name: `${PREFIX} Vodja A`, role: 'MANAGER', loc: locA, sv: 0 })
  waiterA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Natakar A`, email: `${PREFIX}-waiter-a-${TS}@test.local`, role: 'waiter', pin: `${PREFIX}-pin-wa-${TS}`, locationId: locA },
  })).id
  tokWaiter = createToken({ sub: waiterA, name: `${PREFIX} Natakar A`, role: 'WAITER', loc: locA, sv: 0 })

  // urnik: vsak dan 00:00–23:59 BREZ odmika — Deterministično (testi tečejo ob
  // poljubni uri; odmik kosila je pokrit v Č1 lib testih). KANONSKA konvencija
  // OpeningRows: 0 = nedelja … 6 = sobota (oh.day* / reservation-slots weekdayOf)
  for (let dow = 0; dow <= 6; dow++) {
    await db.openingHours.create({
      data: { id: nid(), locationId: locA, dayOfWeek: dow, openTime: '00:00', closeTime: '23:59', breakStart: '', breakEnd: '', isClosed: false },
    })
  }
  tableA = (await db.table.create({ data: { id: nid(), number: 250, capacity: 4, locationId: locA, status: 'available' } })).id
  tableB = (await db.table.create({ data: { id: nid(), number: 251, capacity: 2, locationId: locA, status: 'available' } })).id
  tableC = (await db.table.create({ data: { id: nid(), number: 252, capacity: 6, locationId: locA, status: 'available' } })).id

  const menuA = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA } })).id
  const catA = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId: menuA } })).id
  await db.menuItem.create({ data: { id: itemJedi, name: `${PREFIX} Jedi`, price: 8, categoryId: catA, vatRate: 22 } })
})

const itemJedi = `v250-item-${TS}`

afterAll(async () => {
  await cleanupFixtures()
  await sweepTestFixtures(db, [PREFIX])
})

/* ═══════════ Č1 — čisti sloj tempo-insights.ts ═══════════ */

describe('v1.250.0 Č1 — čisti sloj: pas, spani, intervali, mize, luknje', () => {
  const TZ = 'Europe/Ljubljana'

  test('Č1-A1: parseHm — veljavno/neveljavno (payroll vzorec)', () => {
    expect(parseHm('08:00')).toBe(480)
    expect(parseHm('22:30')).toBe(1350)
    expect(parseHm('7:05')).toBe(425)
    expect(parseHm('')).toBeNull()
    expect(parseHm(null)).toBeNull()
    expect(parseHm('24:00')).toBeNull()
    expect(parseHm('08:60')).toBeNull()
    expect(parseHm('abc')).toBeNull()
  })

  test('Č1-A2: tempoZonedTimeToUtc + tempoLocalParts — povratna pot (DST-varna)', () => {
    // 10:00 sredini dneva vedno varna (ni prehoda) — povratna pot identična
    const utc = tempoZonedTimeToUtc(2026, 11, 4, 10, 0, TZ)
    const parts = tempoLocalParts(utc, TZ)
    expect(parts).toEqual({ y: 2026, m: 11, d: 4 })
    // CET (zima): 10:00 lokalno = 09:00 UTC
    expect(utc.getUTCHours()).toBe(9)
    // poletni čas: 10. 7. 2026 CEST (UTC+2): 10:00 lokalno = 08:00 UTC
    const summer = tempoZonedTimeToUtc(2026, 7, 10, 10, 0, TZ)
    expect(summer.getUTCHours()).toBe(8)
  })

  test('Č1-A3: DST prehod pomlad 2026 (29. 3., 02:00→03:00) — span 01:00–05:00 traja 3 h realno', () => {
    // odprto 01:00–05:00 na dan prehoda (NEDELJA = 0): 01:00 CET = 00:00 UTC, 05:00 CEST = 03:00 UTC → 180 min
    const weekly: TempoOpeningRow[] = [{ dayOfWeek: 0, openTime: '01:00', closeTime: '05:00', breakStart: '', breakEnd: '', isClosed: false }]
    const spans = serviceSpansForLocalDay('2026-03-29', weekly, [], TZ, 0, Date.UTC(2026, 4, 1))
    expect(spans.length).toBe(1)
    expect((spans[0]!.end - spans[0]!.start) / 60000).toBe(180)
  })

  test('Č1-A4: DST prehod jesen 2026 (25. 10., 03:00→02:00) — span 01:00–05:00 traja 5 h realno', () => {
    // 01:00 CEST = 23:00 UTC (prejšnji dan), 05:00 CET = 04:00 UTC → 300 min (ura se ponovi); 25. 10. 2026 = NEDELJA (0)
    const weekly: TempoOpeningRow[] = [{ dayOfWeek: 0, openTime: '01:00', closeTime: '05:00', breakStart: '', breakEnd: '', isClosed: false }]
    const spans = serviceSpansForLocalDay('2026-10-25', weekly, [], TZ, 0, Date.UTC(2026, 11, 1))
    expect(spans.length).toBe(1)
    expect((spans[0]!.end - spans[0]!.start) / 60000).toBe(300)
  })

  test('Č1-A5: serviceSpansForLocalDay — zaprt dan, odmik kosila (DVA spana), neveljavni časi, prirez', () => {
    const weekly: TempoOpeningRow[] = [
      { dayOfWeek: 1, openTime: '08:00', closeTime: '22:00', breakStart: '15:00', breakEnd: '17:00', isClosed: false },
      { dayOfWeek: 2, openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: true },
      { dayOfWeek: 3, openTime: 'neveljavno', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false },
      { dayOfWeek: 4, openTime: '22:00', closeTime: '08:00', breakStart: '', breakEnd: '', isClosed: false },
      { dayOfWeek: 5, openTime: '08:00', closeTime: '12:00', breakStart: '13:00', breakEnd: '14:00', isClosed: false }, // odmik IZVEN dneva → en span
    ]
    // ponedeljek 2. 11. 2026 (dan 1 v KANONSKI konvenciji 0=ned … 6=sob): dva spana, odmik izščrtan → 7 h + 5 h = 12 h
    const mon = serviceSpansForLocalDay('2026-11-02', weekly, [], TZ, 0, Date.UTC(2026, 11, 30))
    expect(mon.length).toBe(2)
    const monMin = mon.reduce((s, sp) => s + (sp.end - sp.start), 0) / 60000
    expect(monMin).toBe(720)
    // torek (dan 2, zaprto): nič
    expect(serviceSpansForLocalDay('2026-11-03', weekly, [], TZ, 0, Date.UTC(2026, 11, 30))).toEqual([])
    // sreda (neveljavno odprto): nič
    expect(serviceSpansForLocalDay('2026-11-04', weekly, [], TZ, 0, Date.UTC(2026, 11, 30))).toEqual([])
    // četrtek (zaprto ≤ odprto): nič
    expect(serviceSpansForLocalDay('2026-11-05', weekly, [], TZ, 0, Date.UTC(2026, 11, 30))).toEqual([])
    // petek (odmik izven odprtih ur): EN span 08:00–12:00
    const fri = serviceSpansForLocalDay('2026-11-06', weekly, [], TZ, 0, Date.UTC(2026, 11, 30))
    expect(fri.length).toBe(1)
    expect((fri[0]!.end - fri[0]!.start) / 60000).toBe(240)
    // prirez na okno: okno se konča ob 10:00 lokalno → prvi span samo 08:00–10:00
    const since = Date.UTC(2026, 10, 1) // pred dnem
    const now = tempoZonedTimeToUtc(2026, 11, 2, 10, 0, TZ).getTime()
    const cut = serviceSpansForLocalDay('2026-11-02', weekly, [], TZ, since, now)
    expect(cut.length).toBe(1)
    expect((cut[0]!.end - cut[0]!.start) / 60000).toBe(120)
  })

  test('Č1-A6: poseben dan povozi tedensko (zaprto + lastni urnik)', () => {
    const weekly: TempoOpeningRow[] = [{ dayOfWeek: 1, openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false }]
    // 2. 11. 2026 je ponedeljek — praznik ZAPRT
    const closed = serviceSpansForLocalDay('2026-11-02', weekly, [{ date: '2026-11-02', isClosed: true }], TZ, 0, Date.UTC(2026, 11, 30))
    expect(closed).toEqual([])
    // poseben dan z lastnim urnikom 10:00–14:00 (namesto 08–22)
    const custom = serviceSpansForLocalDay('2026-11-02', weekly, [{ date: '2026-11-02', isClosed: false, openTime: '10:00', closeTime: '14:00' }], TZ, 0, Date.UTC(2026, 11, 30))
    expect(custom.length).toBe(1)
    expect((custom[0]!.end - custom[0]!.start) / 60000).toBe(240)
  })

  test('Č1-A7: serviceSpansInWindow — iteracija po LOKALNIH dnevih + varovalo 400', () => {
    const weekly: TempoOpeningRow[] = Array.from({ length: 7 }, (_, i) => ({
      dayOfWeek: i, openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false,
    }))
    // točno 2 lokalna dneva (sreda 12:00 → petek 12:00 lokalno): sreda prirezana 12–22 + četrtek 8–22 + petek prirezan 8–12
    const since = tempoZonedTimeToUtc(2026, 11, 4, 12, 0, TZ).getTime()
    const now = tempoZonedTimeToUtc(2026, 11, 6, 12, 0, TZ).getTime()
    const spans = serviceSpansInWindow(weekly, [], TZ, since, now)
    const totalMin = spans.reduce((s, sp) => s + (sp.end - sp.start), 0) / 60000
    expect(totalMin).toBe(600 + 840 + 240)
    // obratno okno → prazno
    expect(serviceSpansInWindow(weekly, [], TZ, now, since)).toEqual([])
    // absurdno okno (varovalo 400 dni) se ne zanki v neskončnost
    expect(serviceSpansInWindow(weekly, [], TZ, 0, Date.now() + 4000 * 24 * 3600 * 1000).length).toBeGreaterThan(0)
  })

  test('Č1-B1: mergeIntervals — unija prekrivajočih/stikajočih, izpad neveljavnih', () => {
    expect(mergeIntervals([[0, 10], [5, 15], [20, 30], [15, 20]])).toEqual([[0, 30]])
    expect(mergeIntervals([[10, 0]])).toEqual([]) // konec ≤ začetek
    expect(mergeIntervals([[NaN, 5]])).toEqual([]) // ne-konična
    expect(mergeIntervals([])).toEqual([])
    // ločene skupine ostanejo ločene
    expect(mergeIntervals([[0, 5], [100, 200], [10, 50]])).toEqual([[0, 5], [10, 50], [100, 200]])
  })

  test('Č1-B2: overlapMinutes — presek z spani, brez dvojnega štetja', () => {
    const spans: TempoServiceSpan[] = [{ start: 0, end: 600000 }] // 0–10 min
    // dve PREKRIVAJOČI se naročili na isti mizi 2–8 in 5–12 → unija 2–12 → presek s spanom = 8 min
    expect(overlapMinutes([[120000, 480000], [300000, 720000]], spans)).toBe(8)
    // naročilo IZVEN spana ne šteje
    expect(overlapMinutes([[700000, 900000]], spans)).toBe(0)
    // naročilo čez cel dan
    expect(overlapMinutes([[-60000, 1200000]], spans)).toBe(10)
  })

  test('Č1-C1: aggregateTableTempo — prazna miza prva, preklic ne šteje v naročila, povp. obrat in prihodek', () => {
    const spans: TempoServiceSpan[] = [{ start: 0, end: 600000 }] // 10 min odprtih ur
    const tables = [
      { tableId: 'T1', label: 'Miza 1' },
      { tableId: 'T2', label: 'Miza 2' },
      { tableId: 'T3', label: 'Miza 3' },
    ]
    const samples: TempoTableSample[] = [
      // T1: dve plačani naročili (2–5, 6–9 min) — unija 6 min zasedenosti, 1 h prihodka vsaka
      { tableId: 'T1', start: 120000, end: 300000, cancelled: false, paid: true, revenue: 10 },
      { tableId: 'T1', start: 360000, end: 540000, cancelled: false, paid: true, revenue: 12 },
      // T2: eno PREKLICANO (blokira 0–10, prihodek 0) + eno odprto (še teče do meje okna)
      { tableId: 'T2', start: 0, end: 180000, cancelled: true, paid: false, revenue: 0 },
      { tableId: 'T2', start: 240000, end: 600000, cancelled: false, paid: false, revenue: 0 },
      // T3: nikoli (najbolj prazna)
    ]
    const rows = aggregateTableTempo(tables, samples, { T1: spans, T2: spans, T3: spans })
    expect(rows.length).toBe(3)
    // razvrstitev PADAJOČE po praznem času: T3 (10) → T1 (4) → T2 (1)
    // T3 nikoli uporabljena → emptyMin = 10 (celotne odprte ure) — najbolj prazna
    expect(rows[0]!.tableId).toBe('T3')
    expect(rows[0]!.emptyMin).toBe(10)
    expect(rows[0]!.orders).toBe(0)
    expect(rows[0]!.utilization).toBe(0)
    expect(rows[0]!.avgTurnMin).toBeNull()
    // T1: 6 min zasedenosti → 4 min prazno; 2 naročili, obrat (3+3)/2 = 3 min, prihodek 22
    expect(rows[1]!.tableId).toBe('T1')
    expect(rows[1]!.occupiedMin).toBe(6)
    expect(rows[1]!.emptyMin).toBe(4)
    expect(rows[1]!.orders).toBe(2)
    expect(rows[1]!.avgTurnMin).toBe(3)
    expect(rows[1]!.revenue).toBe(22)
    expect(rows[1]!.utilization).toBeCloseTo(0.6, 5)
    // T2: preklic (3 min) + odprto (6 min) = 9 min zasedenosti → 1 min prazno; orders = 1 (preklic NE šteje)
    expect(rows[2]!.tableId).toBe('T2')
    expect(rows[2]!.occupiedMin).toBe(9)
    expect(rows[2]!.emptyMin).toBe(1)
    expect(rows[2]!.orders).toBe(1)
    expect(rows[2]!.revenue).toBe(0)
  })

  test('Č1-C2: miza brez odprtih ur ostane v seznamu (serviceMin 0, iskreno)', () => {
    const rows = aggregateTableTempo([{ tableId: 'T9', label: 'Miza 9' }], [], { T9: [] })
    expect(rows).toEqual([{
      tableId: 'T9', label: 'Miza 9', locationName: '', orders: 0, serviceMin: 0,
      occupiedMin: 0, emptyMin: 0, utilization: 0, avgTurnMin: null, revenue: 0,
    }])
  })

  test('Č1-C3: overlap čez dva spana (jutro + večer) ne razširi zasedenosti čez odmik', () => {
    // dva spana: 0–10 in 20–30 (odmik 10–20); naročilo 5–25 zasede 5 (jutro) + 5 (večer) = 10 min, NE 20
    const spans: TempoServiceSpan[] = [{ start: 0, end: 600000 }, { start: 1200000, end: 1800000 }]
    expect(overlapMinutes([[300000, 1500000]], spans)).toBe(10)
  })

  test('Č1-D1: gapRowOf — vse štiri metrike, preklicana postavka izven, negativa prižgana na 0', () => {
    const t0 = 1000000
    const row = gapRowOf({
      orderId: 'O1', orderNumber: 7, tableLabel: 'Miza 1', waiter: 'Ana',
      createdAt: t0, paidAt: t0 + 40 * 60000,
      items: [
        { firedAt: t0 + 5 * 60000, readyAt: t0 + 12 * 60000, voided: false },
        { firedAt: t0 + 6 * 60000, readyAt: t0 + 25 * 60000, voided: false },
        { firedAt: t0 + 50 * 60000, readyAt: t0 + 90 * 60000, voided: true }, // preklicana — NE šteje
        { firedAt: null, readyAt: null, voided: false }, // nedokončana — ne šteje
      ],
    })
    expect(row.entryToFireMin).toBe(5)
    expect(row.firstReadyMin).toBe(12)
    expect(row.fullServiceMin).toBe(25)
    expect(row.turnMin).toBe(40)
    // urona nesreča (readyAt PRED createdAt) → 0, ne negativna (kds-stats vzorec)
    const skewed = gapRowOf({
      orderId: 'O2', orderNumber: 8, tableLabel: null, waiter: '',
      createdAt: t0, paidAt: null,
      items: [{ firedAt: t0 - 60000, readyAt: t0 - 30000, voided: false }],
    })
    expect(skewed.entryToFireMin).toBe(0)
    expect(skewed.firstReadyMin).toBe(0)
    expect(skewed.fullServiceMin).toBe(0)
    expect(skewed.turnMin).toBeNull()
  })

  test('Č1-D2: aggregateServiceGaps — mediana, top N padajoče, izenačena po številki, unknownReady', () => {
    const t0 = 0
    const mk = (n: number, full: number, ready = 10): TempoGapOrder => ({
      orderId: `O${n}`, orderNumber: n, tableLabel: `Miza ${n}`, waiter: `W${n}`,
      createdAt: t0, paidAt: t0 + (full + 15) * 60000,
      items: [{ firedAt: t0 + 2 * 60000, readyAt: t0 + ready * 60000, voided: false }, { firedAt: t0 + 2 * 60000, readyAt: t0 + full * 60000, voided: false }],
    })
    const orders = [mk(1, 20), mk(2, 40), mk(3, 30), mk(4, 40), mk(5, 25),
      // naročilo BREZ pripravljenih postavk — iskreno v unknownReady, ne v medianah STREŽBE;
      // OBRT je zanj IZMERJEN (paidAt obstaja) → šteje v mediano obrata (iskrena meritev)
      { orderId: 'O6', orderNumber: 6, tableLabel: null, waiter: '', createdAt: t0, paidAt: t0 + 60 * 60000, items: [{ firedAt: null, readyAt: null, voided: false }] }]
    const res = aggregateServiceGaps(orders, 3)
    // top 3 po celotni strežbi: 40 (#2), 40 (#4 — izenačena, nižja številka naprej), 30 (#3)
    expect(res.rows.map((r) => r.orderNumber)).toEqual([2, 4, 3])
    expect(res.rows[0]!.fullServiceMin).toBe(40)
    // statistike: 6 naročil, 5 izmerjenih, 1 brez žiga
    expect(res.stats.orders).toBe(6)
    expect(res.stats.measured).toBe(5)
    expect(res.stats.unknownReady).toBe(1)
    // mediana celotne strežbe izmerjenih [20, 40, 30, 40, 25] → 30 (O6 nima žiga → NE šteje)
    expect(res.stats.medianFullServiceMin).toBe(30)
    // mediana prvega krožnika [10×5] → 10
    expect(res.stats.medianFirstReadyMin).toBe(10)
    // mediana vnosa→pošiljanja [2×5] → 2
    expect(res.stats.medianEntryToFireMin).toBe(2)
    // mediana obrata IZMERJENIH obratov [35, 55, 45, 55, 40, 60] → (45+55)/2 = 50 (O6 obrat JE izmerjen)
    expect(res.stats.medianTurnMin).toBe(50)
  })

  test('Č1-D3: medianOf — liho/sodo/prazno', () => {
    expect(medianOf([5])).toBe(5)
    expect(medianOf([1, 9, 5])).toBe(5)
    expect(medianOf([1, 2, 3, 4])).toBe(2.5)
    expect(medianOf([])).toBeNull()
  })

  test('Č1-D4: prazna agregacija — 0 naročil, iskreni null-i', () => {
    const res = aggregateServiceGaps([])
    expect(res.rows).toEqual([])
    expect(res.stats).toEqual({
      orders: 0, measured: 0, unknownReady: 0,
      medianFullServiceMin: null, medianFirstReadyMin: null, medianEntryToFireMin: null, medianTurnMin: null,
    })
  })
})

/* ═══════════ Č2 — živa ruta GET /api/reports/tempo (sqlite) ═══════════ */

describe('v1.250.0 Č2 — GET /api/reports/tempo (živo, sqlite)', () => {
  test('Č2-B1: natakar BREZ reports.sales → 403; vodja → 200', async () => {
    const denied = await tempoGET(req('/api/reports/tempo?days=7', tokWaiter))
    expect(denied.status).toBe(403)
    const okRes = await tempoGET(req('/api/reports/tempo?days=7', tokMgr))
    expect(okRes.status).toBe(200)
  })

  test('Č2-B2: brez žetona → 401', async () => {
    const anon = await tempoGET(req('/api/reports/tempo?days=7', ''))
    expect(anon.status).toBe(401)
  })

  test('Č2-B3: izmerjene vrednosti — naročilo z žigi pošiljanja/priprave na mizi', async () => {
    await resetOrders()
    const now = Date.now()
    const created = await db.order.create({
      data: {
        id: nid(), orderNumber: 770250, locationId: locA, tableId: tableA, employeeId: mgrA,
        type: 'dine-in', status: 'delivered', paymentStatus: 'paid', paymentMethod: 'cash',
        subtotal: 16, tax: 0, discount: 0, tip: 0, total: 16, totalWithTip: 16,
        createdAt: new Date(now - 40 * 60000), paidAt: new Date(now),
      },
    })
    await db.orderItem.createMany({
      data: [
        { id: nid(), orderId: created.id, menuItemId: itemJedi, quantity: 1, price: 8, vatRate: 22, vatAmount: 0, menuItemName: 'Jedi', firedAt: new Date(now - 35 * 60000), readyAt: new Date(now - 28 * 60000), status: 'ready' },
        { id: nid(), orderId: created.id, menuItemId: itemJedi, quantity: 1, price: 8, vatRate: 22, vatAmount: 0, menuItemName: 'Jedi', firedAt: new Date(now - 34 * 60000), readyAt: new Date(now - 15 * 60000), status: 'ready' },
        // preklicana postavka z absurdno pripravo — NE sme vplesti v meritve
        { id: nid(), orderId: created.id, menuItemId: itemJedi, quantity: 1, price: 8, vatRate: 22, vatAmount: 0, menuItemName: 'Jedi', voided: true, firedAt: new Date(now + 30 * 60000), readyAt: new Date(now + 90 * 60000), status: 'ready' },
      ],
    })
    const res = await tempoGET(req('/api/reports/tempo?days=7', tokMgr))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      periodDays: number; tables: Array<{ tableId: string; orders: number; serviceMin: number; revenue: number; emptyMin: number }>
      gaps: { rows: Array<{ orderNumber: number; entryToFireMin: number | null; firstReadyMin: number | null; fullServiceMin: number | null; turnMin: number | null }>; stats: { orders: number; measured: number } }
    }
    expect(body.periodDays).toBe(7)
    // miza A nosi eno streženo naročilo, prihodek 16
    const rowA = body.tables.find((r) => r.tableId === tableA)
    expect(rowA).toBeDefined()
    expect(rowA!.orders).toBe(1)
    expect(rowA!.revenue).toBe(16)
    expect(rowA!.serviceMin).toBeGreaterThan(0)
    expect(rowA!.emptyMin).toBeGreaterThanOrEqual(0)
    // luknja naročila #770250: vnos→pošiljanje 5, prvi krožnik 12, celotna 25, obrat 40
    const gap = body.gaps.rows.find((r) => r.orderNumber === 770250)
    expect(gap).toBeDefined()
    expect(gap!.entryToFireMin).toBe(5)
    expect(gap!.firstReadyMin).toBe(12)
    expect(gap!.fullServiceMin).toBe(25)
    expect(gap!.turnMin).toBe(40)
    expect(body.gaps.stats.orders).toBeGreaterThanOrEqual(1)
    expect(body.gaps.stats.measured).toBeGreaterThanOrEqual(1)
  })

  test('Č2-B4: plačano naročilo BREZ žigov priprave — unknownReady, ne v vrsticah', async () => {
    await resetOrders()
    const now = Date.now()
    const created = await db.order.create({
      data: {
        id: nid(), orderNumber: 770251, locationId: locA, tableId: tableB,
        type: 'dine-in', status: 'delivered', paymentStatus: 'paid', paymentMethod: 'card',
        subtotal: 4, tax: 0, discount: 0, tip: 0, total: 4, totalWithTip: 4,
        createdAt: new Date(now - 20 * 60000), paidAt: new Date(now),
      },
    })
    await db.orderItem.create({
      data: { id: nid(), orderId: created.id, menuItemId: itemJedi, quantity: 1, price: 4, vatRate: 22, vatAmount: 0, menuItemName: 'Jedi', status: 'ready' },
    })
    const res = await tempoGET(req('/api/reports/tempo?days=7', tokMgr))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { gaps: { rows: Array<{ orderNumber: number }>; stats: { orders: number; unknownReady: number; medianFullServiceMin: number | null } } }
    expect(body.gaps.rows.find((r) => r.orderNumber === 770251)).toBeUndefined()
    expect(body.gaps.stats.unknownReady).toBeGreaterThanOrEqual(1)
    // mediana iz IZMERJENIH — eno samo neizmerjeno naročilo → null, ne zvlečeno
    expect(body.gaps.stats.medianFullServiceMin).toBeNull()
    expect(body.gaps.stats.orders).toBe(1)
  })

  test('Č2-B5: okno dni — clamp (neveljavno → 7, 0 → 1, 999 → 90)', async () => {
    const d0 = await tempoGET(req('/api/reports/tempo?days=abc', tokMgr))
    expect(((await d0.json()) as { periodDays: number }).periodDays).toBe(7)
    const d1 = await tempoGET(req('/api/reports/tempo?days=0', tokMgr))
    expect(((await d1.json()) as { periodDays: number }).periodDays).toBe(1)
    const d2 = await tempoGET(req('/api/reports/tempo?days=999', tokMgr))
    expect(((await d2.json()) as { periodDays: number }).periodDays).toBe(90)
  })

  test('Č2-B6: odprto (neplačano) naročilo šteje v zasedenost mize, ne v luknje', async () => {
    await resetOrders()
    const now = Date.now()
    await db.order.create({
      data: {
        id: nid(), orderNumber: 770252, locationId: locA, tableId: tableC,
        type: 'dine-in', status: 'sent', paymentStatus: 'unpaid',
        subtotal: 8, tax: 0, discount: 0, tip: 0, total: 8, totalWithTip: 8,
        createdAt: new Date(now - 10 * 60000),
      },
    })
    const res = await tempoGET(req('/api/reports/tempo?days=7', tokMgr))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tables: Array<{ tableId: string; orders: number; revenue: number; occupiedMin: number }>; gaps: { stats: { orders: number } } }
    const rowC = body.tables.find((r) => r.tableId === tableC)
    expect(rowC).toBeDefined()
    expect(rowC!.orders).toBe(1) // odprta naročila so strežena
    expect(rowC!.revenue).toBe(0) // a brez prihodka
    expect(rowC!.occupiedMin).toBeGreaterThan(0) // fizično zaseda
    expect(body.gaps.stats.orders).toBe(0) // plačana disciplina — neplačana niso v luknjah
  })
})

/* ═══════════ Č3 — UI montaža ═══════════ */

describe('v1.250.0 Č3 — UI montaža (Analitika/Pregled + i18n)', () => {
  test('Č3-D1: kartica v analitika-tab (data-region, obe sekciji, fmtTempoMin null-varnost)', () => {
    expect(analitika).toContain('export function TempoInsightsCard()')
    expect(analitika).toContain('data-region="tempo-insights-card"')
    expect(analitika).toContain('data-region="tempo-table-row"')
    expect(analitika).toContain('data-region="tempo-gap-row"')
    expect(analitika).toContain('data-region="tempo-stat"')
    expect(analitika).toContain("api<TempoResp>(`/api/reports/tempo?days=${days}`)")
    // obe sekciji z aria-label
    expect(analitika).toContain("aria-label={t('tempo.tablesTitle')}")
    expect(analitika).toContain("aria-label={t('tempo.gapsTitle')}")
    // null-varna oblika minut
    expect(analitika).toContain("function fmtTempoMin(min: number | null | undefined): string")
    // dolgi seznami z max-h + scroll (UI pravila)
    expect(analitika).toContain('max-h-96 overflow-y-auto')
    // CSV izvoz
    expect(analitika).toContain('downloadCSV(`tempo-vpogledi-${days}dni.csv`')
  })

  test('Č3-D2: dashboard montaža — gating reports.sales, tik za StaffPerformanceCard', () => {
    expect(dash).toContain("TempoInsightsCard,")
    expect(dash).toContain("{hasPerm('reports.sales') && <TempoInsightsCard />}")
    // izvoz iz sodčka (barrel)
    expect(dtabs).toContain('TempoInsightsCard')
  })

  test('Č3-D3: i18n — vsi tempo.* ključi v SL in HR (pariteta)', () => {
    const keys = [
      'tempo.title', 'tempo.desc', 'tempo.tablesTitle', 'tempo.tablesInfo',
      'tempo.th.table', 'tempo.th.empty', 'tempo.th.util', 'tempo.th.orders', 'tempo.th.turn', 'tempo.th.revenue',
      'tempo.gapsTitle', 'tempo.gapsInfo', 'tempo.gap.full', 'tempo.gap.first', 'tempo.gap.entry', 'tempo.gap.turn',
      'tempo.stat.medianFull', 'tempo.stat.medianTurn', 'tempo.stat.measured', 'tempo.stat.unknown',
      'tempo.empty', 'tempo.noTables', 'tempo.noService', 'tempo.noMeasured', 'tempo.order', 'tempo.noTable',
    ]
    for (const k of keys) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    // EN/DE/IT ostajajo gostujoči slovarji (dashboard je SL/HR)
    expect(slSrc).toContain("'tempo.title': 'Tempo vpogledi — mize in strežba'")
    expect(hrSrc).toContain("'tempo.title': 'Tempo uvidi — stolovi i posluživanje'")
  })
})

/* ═══════════ Ž — registri in pini ═══════════ */

describe('v1.250.0 Ž — registri in pini', () => {
  test('Ž1: verzija 1.250.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.293.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.293.0'")
    expect(compose).toContain('restaurantos:1.293.0')
  })

  test('Ž2: i18n pariteta SL/HR 4093/4093 (+26 tempo.*)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
    expect(Object.keys(sl).filter((k) => k.startsWith('tempo.')).length).toBe(26)
    expect(Object.keys(hr).filter((k) => k.startsWith('tempo.')).length).toBe(26)
  })

  test('Ž3: ruta — pravica, obseg, čista plast (0 DDL dokaz)', () => {
    expect(routeSrc).toContain("requirePermission(req, 'reports.sales')")
    expect(routeSrc).toContain('locationScope(user)')
    expect(routeSrc).toContain('serviceSpansInWindow')
    expect(routeSrc).toContain('aggregateTableTempo')
    expect(routeSrc).toContain('aggregateServiceGaps')
    expect(routeSrc).toContain("loc.timezone || 'Europe/Ljubljana'")
    // naročila, ki PRESEKAJO okno (odprta še tečejo)
    expect(routeSrc).toContain('OR: [{ paidAt: null }, { paidAt: { gte: since } }]')
    // 0 DDL: prisma shema nedotaknjena (nobenega model Tempo*)
    expect(read('prisma/schema.prisma')).not.toContain('model Tempo')
    // 0 novih odvisnosti
    expect(read('package.json')).not.toContain('"tempo')
  })

  test('Ž4: dokumenta — PRIMERJAVA §24 + AUDIT števci', () => {
    expect(doc).toContain('## 24. Raziskava november 2026 — TEMPO VAL v1.250.0')
    expect(doc).toContain('§22 D')
    expect(doc).toContain('tables with the most empty time')
    expect(doc).toContain('orders with the longest service gaps')
    expect(auditDoc).toContain('**POSODOBITEV (v1.250.0, PRIMERJAVA-VMESNIKOV-2026 §24 — tempo vpogledi):**')
    expect(auditDoc).toContain('- 4324 ključev SL in 4324 HR')
  })

  test('Ž5: worklog vrhnji vnos nosi Task ID v1.250.0', () => {
    expect(wl.slice(0, 400)).toContain('Task ID: v1.293.0-demo-real-auditlog-pisatelji')
  })
})
