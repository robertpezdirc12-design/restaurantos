/**
 * v1.253.0 — ODPRTI RAČUNI V POROČILU (docs/PRIMERJAVA-VMESNIKOV-2026 §27;
 * Square oktober 2026 »See open checks in the Sales report«).
 *
 * Dve ugotovitvi:
 *  A · ČISTI SLOJ (xz-report): buildXzReport dobi ADITIVNI vhod openChecks —
 *    obstoječa polja ostanejo izključno poravnana (računovodska disciplina,
 *    ni drsenja pomena za knjigovodje), skupaj pa nosita grossWithOpen /
 *    netWithOpen. Defenzivna normalizacija (count ≥ 0, r2, rows ≤ 50).
 *  B · ŽIVA RUTA (GET /api/reports/export?section=zz): odprti = paidAt null +
 *    cancelledAt null + status NOT IN [paid, cancelled], isto okno + isti
 *    lokacijski obseg kot računi; privzeto VKLJUČENO (Square: »included by
 *    default«), open=0|false izklopi; CSV nosi banner vrstico.
 *
 * Predpona fiksatur `v253-`; cleanup v afterAll (obratna smer FK).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as exportGET } from '../src/app/api/reports/export/route'
import { buildXzReport, MAX_XZ_OPEN_ROWS } from '../src/lib/xz-report'
import { APP_VERSION } from '../src/lib/version'
import { readFileSync } from 'fs'
import { join } from 'path'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v253-'
const RUN = Date.now().toString(36)
const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

let nidC = 0
const nid = () => `${P}${RUN}-${(nidC++).toString(36)}`

let locA = ''
let locB = ''
let mgrAId = ''
let tokenA = '' // vodja z reports.sales na lokaciji A
let mgrBId = ''
let staffId = ''
let staffToken = '' // natakar brez reports.sales

/** Datumski okno poizvedbe: [danes-2, danes+1] — vsi "zdaj" fiksturi so znotraj. */
const DAY = (offsetDays: number) => {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}
const FROM = DAY(-2)
const TO = DAY(1)
const q = (extra: string) => `/api/reports/export?from=${FROM}&to=${TO}&format=json&section=zz${extra}`

function req(url: string, tok: string | null = tokenA): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'GET',
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' },
  })
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])

  const a = await db.location.create({ data: { id: `${P}locA-${RUN}`, name: `${P}Lokacija A`, code: `V253A-${RUN.toUpperCase()}`, premisesId: `v253-premA-${RUN}` } })
  locA = a.id
  const t1 = await db.table.create({ data: { id: nid(), number: 1, locationId: locA } })
  void t1
  mgrAId = `${P}mgr-${RUN}`
  const pin = employeePinFields('v253-pin-1234', `${P}mgr-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: mgrAId, name: `${P}Vodja`, email: `${P}mgr-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locA,
      pin: pin.pin, pinLookup: pin.pinLookup,
    },
  })
  tokenA = createToken({ sub: mgrAId, name: `${P}Vodja`, role: 'manager', loc: locA, sv: 0 })

  const b = await db.location.create({ data: { id: `${P}locB-${RUN}`, name: `${P}Lokacija B`, code: `V253B-${RUN.toUpperCase()}`, premisesId: `v253-premB-${RUN}` } })
  locB = b.id
  mgrBId = `${P}mgrB-${RUN}`
  const pinB = employeePinFields('v253-pinB-1234', `${P}mgrB-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: mgrBId, name: `${P}Vodja B`, email: `${P}mgrB-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locB,
      pin: pinB.pin, pinLookup: pinB.pinLookup,
    },
  })

  staffId = `${P}nat-${RUN}`
  const pinN = employeePinFields('v253-pinN-1234', `${P}nat-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: staffId, name: `${P}Natakar`, email: `${P}nat-${RUN}@test.local`,
      role: 'staff', status: 'active', sessionVersion: 0, locationId: locA,
      pin: pinN.pin, pinLookup: pinN.pinLookup,
    },
  })
  staffToken = createToken({ sub: staffId, name: `${P}Natakar`, role: 'staff', loc: locA, sv: 0 })

  const now = Date.now()
  const tableA1 = (await db.table.findFirst({ where: { locationId: locA, number: 1 } }))!

  // ── O1: ODPRT na mizi 1 (dine-in) — ŠTEJE (najstarejši → rows[0])
  await db.order.create({
    data: {
      id: nid(), orderNumber: 25301, locationId: locA, tableId: tableA1.id, employeeId: mgrAId,
      type: 'dine-in', status: 'open', paymentStatus: 'unpaid',
      subtotal: 20.00, tax: 4.40, total: 24.40, totalWithTip: 24.40,
      createdAt: new Date(now - 90 * 60000),
    },
  })
  // ── O2: POSLAN odnos (takeaway, brez mize) — ŠTEJE (rows[1], tableNumber null)
  await db.order.create({
    data: {
      id: nid(), orderNumber: 25302, locationId: locA, employeeId: mgrAId,
      type: 'takeaway', status: 'sent', paymentStatus: 'unpaid',
      subtotal: 10.00, tax: 2.20, total: 12.20, totalWithTip: 12.20,
      createdAt: new Date(now - 30 * 60000),
    },
  })
  // ── O3: PLAČAN (status paid, paidAt) — NE šteje v odprte; nosi račun R1
  const o3 = await db.order.create({
    data: {
      id: nid(), orderNumber: 25303, locationId: locA, tableId: tableA1.id, employeeId: mgrAId,
      type: 'dine-in', status: 'paid', paymentStatus: 'paid', paymentMethod: 'cash',
      subtotal: 41.00, tax: 9.00, total: 50.00, totalWithTip: 50.00,
      createdAt: new Date(now - 3 * 3600000), paidAt: new Date(now - 3600000),
    },
  })
  // ── O4: PREKLIČAN — NE šteje
  await db.order.create({
    data: {
      id: nid(), orderNumber: 25304, locationId: locA, employeeId: mgrAId,
      type: 'dine-in', status: 'cancelled', paymentStatus: 'unpaid',
      subtotal: 5.00, tax: 1.10, total: 6.10, totalWithTip: 6.10,
      createdAt: new Date(now - 2 * 3600000), cancelledAt: new Date(now - 100 * 60000), cancelReason: 'test',
    },
  })
  // ── O5: ODPRTO a IZVEN okna (pred from) — NE šteje
  await db.order.create({
    data: {
      id: nid(), orderNumber: 25305, locationId: locA, employeeId: mgrAId,
      type: 'dine-in', status: 'open', paymentStatus: 'unpaid',
      subtotal: 99.00, tax: 21.78, total: 120.78, totalWithTip: 120.78,
      createdAt: new Date(now - 5 * 86400000),
    },
  })
  // ── O6: ODPRTO na lokaciji B — NE šteje za obseg upravitelja A
  await db.order.create({
    data: {
      id: nid(), orderNumber: 25306, locationId: locB, employeeId: mgrBId,
      type: 'dine-in', status: 'open', paymentStatus: 'unpaid',
      subtotal: 30.00, tax: 6.60, total: 36.60, totalWithTip: 36.60,
      createdAt: new Date(now - 15 * 60000),
    },
  })
  // ── R1: fiskaliziran račun na plačanem O3 → grossSales osnova
  await db.receipt.create({
    data: {
      id: nid(), receiptNumber: `${P}R-${RUN}-1`, orderId: o3.id,
      businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
      subtotal: 41.00, vatBreakdown: '{"22":{"base":41,"vat":9.02}}', totalVat: 9.02, discount: 0,
      total: 50.00, tip: 0, totalWithTip: 50.00, paymentMethod: 'cash',
      isCopy: false, isStorno: false, stornoOf: '', locationId: locA,
      createdAt: new Date(now - 55 * 60000),
    },
  })
})

afterAll(async () => {
  // obratna smer FK: računi → naročila → mize → uslužbenci → lokacije
  await db.receipt.deleteMany({ where: { locationId: { in: [locA, locB] } } })
  await db.order.deleteMany({ where: { locationId: { in: [locA, locB] } } })
  await db.table.deleteMany({ where: { locationId: { in: [locA, locB] } } })
  await db.employee.deleteMany({ where: { id: { in: [mgrAId, mgrBId, staffId] } } })
  await db.location.deleteMany({ where: { id: { in: [locA, locB] } } })
  await sweepTestFixtures(db, [P])
})

/* ═══════════════ A — ČISTI SLOJ: buildXzReport openChecks ═══════════════ */

const BASE = {
  from: '2026-11-01', to: '2026-11-04',
  grossSales: 100, netSales: 82, vatByRate: [{ rate: 22, base: 82, amount: 18 }],
  paymentsByMethod: [{ method: 'cash', amount: 100 }],
  discountsTotal: 0, tipsTotal: 0, voidedCount: 0, voidedTotal: 0, wasteTotal: 0,
  covers: 4, avgPartySize: 2.5, prevNetSales: 60, prevCovers: 3,
  prevFrom: '2026-10-28', prevTo: '2026-10-31',
}

describe('v1.253.0 A — čisti sloj: aditivni openChecks blok', () => {
  test('A1: brez vhoda → included:false, ničle, skupaj = osnova (nazajzdružno prijazno)', () => {
    const rep = buildXzReport(BASE)
    expect(rep.openChecks).toEqual({ included: false, count: 0, gross: 0, net: 0, vat: 0, rows: [] })
    expect(rep.grossWithOpen).toBe(100)
    expect(rep.netWithOpen).toBe(82)
    // obstoječa polja nedotaknjena
    expect(rep.grossSales).toBe(100)
    expect(rep.covers).toBe(4)
  })

  test('A2: z vhodom → blok prenesen, vsote pravilne', () => {
    const rep = buildXzReport({
      ...BASE,
      openChecks: {
        included: true, count: 2, gross: 36.60, net: 30.00, vat: 6.60,
        rows: [
          { orderNumber: 25301, tableNumber: 1, type: 'dine-in', total: 24.40, createdAt: '2026-11-04T18:00:00.000Z' },
          { orderNumber: 25302, tableNumber: null, type: 'takeaway', total: 12.20, createdAt: '2026-11-04T19:00:00.000Z' },
        ],
      },
    })
    expect(rep.openChecks.included).toBe(true)
    expect(rep.openChecks.count).toBe(2)
    expect(rep.openChecks.gross).toBe(36.6)
    expect(rep.openChecks.net).toBe(30)
    expect(rep.openChecks.vat).toBe(6.6)
    expect(rep.openChecks.rows.length).toBe(2)
    expect(rep.openChecks.rows[0].tableNumber).toBe(1)
    expect(rep.grossWithOpen).toBe(136.6)
    expect(rep.netWithOpen).toBe(112)
    // računovodska disciplina: osnovni polji OSTANETA poravnani
    expect(rep.grossSales).toBe(100)
    expect(rep.netSales).toBe(82)
  })

  test('A3: defenzivno — negativen count → 0, NaN zneski → 0, rows porezani na 50', () => {
    const manyRows = Array.from({ length: 60 }, (_, i) => ({
      orderNumber: i + 1, tableNumber: i + 1, type: 'dine-in', total: 1, createdAt: '2026-11-04T10:00:00.000Z',
    }))
    const rep = buildXzReport({
      ...BASE,
      openChecks: { included: true, count: -5, gross: Number.NaN, net: null as unknown as number, vat: 'abc' as unknown as number, rows: manyRows },
    })
    expect(rep.openChecks.count).toBe(0)
    expect(rep.openChecks.gross).toBe(0)
    expect(rep.openChecks.net).toBe(0)
    expect(rep.openChecks.vat).toBe(0)
    expect(rep.openChecks.rows.length).toBe(MAX_XZ_OPEN_ROWS)
    expect(MAX_XZ_OPEN_ROWS).toBe(50)
  })

  test('A4: included:false z podatki → vse nič (izklop pomnoži blok na 0), skupaj = osnova', () => {
    const rep = buildXzReport({
      ...BASE,
      openChecks: { included: false, count: 7, gross: 99, net: 80, vat: 19, rows: [{ orderNumber: 1, tableNumber: 1, type: 'dine-in', total: 99, createdAt: '' }] },
    })
    expect(rep.openChecks.included).toBe(false)
    expect(rep.openChecks.count).toBe(0)
    expect(rep.openChecks.rows).toEqual([])
    expect(rep.grossWithOpen).toBe(100)
  })
})

/* ═══════════════ B — ŽIVA RUTA: odprti računi v X/Z (sqlite) ═══════════════ */

describe('v1.253.0 B — GET /api/reports/export?section=zz (živo)', () => {
  test('B1: privzeto VKLJUČENO — odprta štejeta, plačano/preklicano/izven okna/tuja lokacija NE', async () => {
    const res = await exportGET(req(q('')))
    expect(res.status).toBe(200)
    const j = await body(res)
    const oc = j.openChecks as { included: boolean; count: number; gross: number; net: number; vat: number; rows: { orderNumber: number | null; tableNumber: number | null; type: string; total: number; createdAt: string }[] }
    expect(oc.included).toBe(true)
    // SAMO O1 + O2 (O3 plačan, O4 preklican, O5 izven okna, O6 tuja lokacija)
    expect(oc.count).toBe(2)
    expect(oc.gross).toBe(36.6)
    expect(oc.net).toBe(30)
    expect(oc.vat).toBe(6.6)
    expect(oc.rows.length).toBe(2)
    // najstarejši prvi: O1 na mizi 1
    expect(oc.rows[0].orderNumber).toBe(25301)
    expect(oc.rows[0].tableNumber).toBe(1)
    expect(oc.rows[0].type).toBe('dine-in')
    expect(oc.rows[0].total).toBe(24.4)
    expect(oc.rows[1].orderNumber).toBe(25302)
    expect(oc.rows[1].tableNumber).toBeNull()
    expect(oc.rows[1].type).toBe('takeaway')
    // skupaj z odprtimi
    expect(j.grossWithOpen).toBe(86.6)
    expect(j.netWithOpen).toBe(71)
    // ADITIVNOST: osnovna polja ostanejo izključno iz računov (R1 = 50)
    expect(j.grossSales).toBe(50)
    expect(j.netSales).toBe(41)
    expect(j.covers).toBe(1)
  })

  test('B2: open=0 → samo poravnano (Square: »turn off the Open Checks filter«)', async () => {
    const res = await exportGET(req(q('&open=0')))
    expect(res.status).toBe(200)
    const j = await body(res)
    const oc = j.openChecks as { included: boolean; count: number; gross: number; rows: unknown[] }
    expect(oc.included).toBe(false)
    expect(oc.count).toBe(0)
    expect(oc.gross).toBe(0)
    expect(oc.rows).toEqual([])
    expect(j.grossWithOpen).toBe(50)
    expect(j.netWithOpen).toBe(41)
  })

  test('B3: open=false → izklopljeno (niz »false«, ne samo »0«)', async () => {
    const res = await exportGET(req(q('&open=false')))
    expect(res.status).toBe(200)
    const j = await body(res)
    expect((j.openChecks as { included: boolean }).included).toBe(false)
  })

  test('B4: CSV — banner vrstica »Vkljuceni v dnevni promet;DA« + blok; open=0 → IZKLOPLJENO', async () => {
    const resOn = await exportGET(req(`/api/reports/export?from=${FROM}&to=${TO}&format=csv&section=zz`))
    expect(resOn.status).toBe(200)
    const csvOn = await resOn.text()
    expect(csvOn).toContain('ODPRTI RACUNI')
    expect(csvOn).toContain('Vkljuceni v dnevni promet;DA')
    expect(csvOn).toContain('Stevilo odprtih;2')
    expect(csvOn).toContain('Skupaj z odprtimi - bruto;86.60')

    const resOff = await exportGET(req(`/api/reports/export?from=${FROM}&to=${TO}&format=csv&section=zz&open=0`))
    const csvOff = await resOff.text()
    expect(csvOff).toContain('ODPRTI RACUNI;IZKLOPLJENO')
    expect(csvOff).not.toContain('Vkljuceni v dnevni promet;DA')
  })

  test('B5: pravice — natakar brez reports.sales → 403', async () => {
    const res = await exportGET(req(q(''), staffToken))
    expect(res.status).toBe(403)
  })

  test('B6: pošten count nad rezom — 55 odprtih → count 55, rows 50 (UI »… in še 5«)', async () => {
    const now = Date.now()
    const bulk = Array.from({ length: 55 }, (_, i) => ({
      id: `${P}bulk-${RUN}-${i}`, orderNumber: 25400 + i, locationId: locA, employeeId: mgrAId,
      type: 'takeaway', status: 'open', paymentStatus: 'unpaid',
      subtotal: 1, tax: 0.22, total: 1.22, totalWithTip: 1.22,
      createdAt: new Date(now - (600 + i) * 60000),
    }))
    await db.order.createMany({ data: bulk })
    try {
      const res = await exportGET(req(q('')))
      expect(res.status).toBe(200)
      const j = await body(res)
      const oc = j.openChecks as { count: number; rows: unknown[] }
      expect(oc.count).toBe(57) // 2 osnovna + 55 novih
      expect(oc.rows.length).toBe(50)
    } finally {
      await db.order.deleteMany({ where: { id: { startsWith: `${P}bulk-${RUN}-` } } })
    }
  })
})

/* ═══════════════ Ž — REGISTRI IN PINI ═══════════════ */

describe('v1.253.0 Ž — registri', () => {
  const compose = read('deploy/docker-compose.yml')
  const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
  const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
  const routeSrc = read('src/app/api/reports/export/route.ts')
  const uiSrc = read('src/components/tabs/backoffice-tab.tsx')

  test('Ž1: verzija 1.257.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.258.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.258.0'")
    expect(compose).toContain('restaurantos:1.258.0')
  })

  test('Ž2: i18n pariteta SL/HR 4093/4093 (+15 acct.xzOpen*)', () => {
    expect(Object.keys(sl).length).toBe(4099)
    expect(Object.keys(hr).length).toBe(4099)
    for (const k of [
      'acct.xzOpenToggle', 'acct.xzOpenHint', 'acct.xzOpenBanner', 'acct.xzOpenCount',
      'acct.xzOpenGross', 'acct.xzOpenNet', 'acct.xzOpenVat', 'acct.xzOpenTotalGross',
      'acct.xzOpenTotalNet', 'acct.xzOpenListTitle', 'acct.xzOpenEmpty', 'acct.xzOpenTable',
      'acct.xzOpenNoTable', 'acct.xzOpenMore', 'acct.xzOpenAge',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
  })

  test('Ž3: montaža — ruta + UI; 0 DDL dokaz', () => {
    // ruta: defenzivna definicija odprtega + pošten agregat + rez vrstic
    expect(routeSrc).toContain("paidAt: null,")
    expect(routeSrc).toContain("status: { notIn: ['paid', 'cancelled'] }")
    expect(routeSrc).toContain('db.order.aggregate')
    expect(routeSrc).toContain('take: 50')
    expect(routeSrc).toContain("openParam !== '0' && openParam !== 'false'")
    // CSV banner
    expect(routeSrc).toContain('Vkljuceni v dnevni promet;DA')
    // UI: preklop + predogled s parametrom + seznam z drsenjem
    expect(uiSrc).toContain('xz-open-checks')
    expect(uiSrc).toContain("open=${xzOpen ? '1' : '0'}")
    expect(uiSrc).toContain('xz-open-list')
    expect(uiSrc).toContain('max-h-40 overflow-y-auto')
    // 0 DDL: brez novih stolpcev/modelov tega vala
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('openChecks')
    expect(schema).not.toContain('XzOpenCheck')
  })

  test('Ž4: dokumenta — PRIMERJAVA §27 + AUDIT števci', () => {
    expect(doc).toContain('## 27.')
    expect(doc).toContain('See open checks')
    expect(auditDoc).toContain('v1.253.0')
    expect(auditDoc).toContain('- 4099 ključev SL in 4099 HR')
  })

  test('Ž5: worklog vrhnji vnos nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.258.0-finalna-verifikacija')
  })
})
