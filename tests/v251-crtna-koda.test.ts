import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid } from '@/lib/map'
import {
  encodeCode128b,
  normalizeReceiptScan,
  receiptScanVariants,
  CODE128_MAX_INPUT,
  CODE128_QUIET_MODULES,
} from '../src/lib/barcode'
import { buildReceiptHTML, type ReceiptDetailT } from '../src/lib/receipt'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { en } from '../src/lib/i18n/en'
import { APP_VERSION } from '../src/lib/version'
import { GET as lookupGET } from '../src/app/api/furs/lookup/route'

/**
 * v1.251.0 — ČRTNA KODA RAČUNA (docs/PRIMERJAVA-VMESNIKOV-2026 §25).
 *
 * Toast januar 2026 (»Look up checks by scanning the receipt barcode« —
 * »now available to all Toast POS locations«): gost prinese račun nazaj
 * (vračilo/storno, tip, poizvedba), osebje skenira črtno kodo z računa in
 * dokument se najde — brez ročnega brskanja po seznamu zadnjih 100.
 *
 *  Č1) ČISTI SLOJ barcode.ts — Code128-B enkodirnik (kanonski vektor »ABC«,
 *      kontrolna vsota mod 103, število modulov (n+2)×11+13, zavračanje
 *      neveljavnih znakov), normalizacija vnosa skenerja, variante velikosti.
 *  Č2) NATISNJEN RAČUN — buildReceiptHTML nosi SVG črtno kodo (SL + HR),
 *      neenkodirljiva številka jo tiho izpusti (tisk NIKOLI ne pade, §18).
 *  Č3) ŽIVA RUTA GET /api/furs/lookup — pravica reports.sales (natakar 403),
 *      obseg lokacije, točno ujemanje, presledki, variante velikosti,
 *      stara shema R-YYYY-NNNNN, multi-lokacija za centralno vlogo, storno.
 *  Č4) UI MONTAŽA — kartica skeniranja v zavihku Računi, gating reports.sales,
 *      Enter submit (skener = tipkovnica, paradigma EAN v1.229), i18n pariteta.
 *  Ž)  REGISTRI — verzija 1.257.0, compose, i18n 4093/4093 pariteta,
 *      dokumenta (PRIMERJAVA §25, AUDIT števci), worklog pin.
 *
 * 0 DDL · 0 novih odvisnosti · 0 AI.
 */

const PREFIX = 'v251-'
const TS = Date.now()

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const routeSrc = read('src/app/api/furs/lookup/route.ts')
const barcodeSrc = read('src/lib/barcode.ts')
const receiptSrc = read('src/lib/receipt.ts')
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

/* ═══════════ fixtures (org → brand → property → 2 lokaciji; mize; naročila; računi) ═══════════ */

let org = ''
let brand = ''
let prop = ''
let locA = ''
let locB = ''
let mgrA = ''
let waiterA = ''
let adminA = ''
let tokMgr = ''
let tokWaiter = ''
let tokAdmin = ''

const RN_MAIN = `${new Date().getFullYear()}-11-42-BLG251A` // točno ujemanje
const RN_LOWER = `${new Date().getFullYear()}-11-77-blg251x` // male črke premises (varianta)
const RN_LEGACY = 'R-2025-123' // stara številčna shema (ročni vnos)
const RN_DUP = `${new Date().getFullYear()}-11-99-DUP251` // ista številka na OBEH lokacijah

let receiptMain = ''
let receiptLower = ''
let receiptLegacy = ''
let receiptDupA = ''
let receiptDupB = ''
let receiptStorno = ''

async function cleanupFixtures() {
  const locs = await db.location.findMany({ where: { name: { startsWith: PREFIX } } }, { select: { id: true } })
  const locIds = locs.map((l) => l.id)
  for (const locId of locIds) {
    const orders = await db.order.findMany({ where: { locationId: locId }, select: { id: true } })
    for (const o of orders) {
      await db.receipt.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.eventLog.deleteMany({ where: { entityId: o.id } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { entityId: o.id } }).catch(() => null)
      await db.order.deleteMany({ where: { id: o.id } }).catch(() => null)
    }
    const tables = await db.table.findMany({ where: { locationId: locId }, select: { id: true } })
    for (const t of tables) {
      await db.eventLog.deleteMany({ where: { entityId: t.id } }).catch(() => null)
    }
    await db.table.deleteMany({ where: { locationId: locId } }).catch(() => null)
    await db.employee.deleteMany({ where: { locationId: locId } }).catch(() => null)
  }
  await db.receipt.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.order.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { in: locIds } } }).catch(() => null)
  if (prop) await db.property.deleteMany({ where: { id: prop } }).catch(() => null)
  if (brand) await db.brand.deleteMany({ where: { id: brand } }).catch(() => null)
  if (org) await db.organization.deleteMany({ where: { id: org } }).catch(() => null)
}

let seedSeq = 0
async function seedReceiptWithOrder(locId: string, receiptNumber: string, opts?: { isStorno?: boolean; stornoOf?: string; tableNo?: number }) {
  seedSeq++
  const orderNo = 25100 + seedSeq
  const tableNo = opts?.tableNo ?? 7
  let table = await db.table.findFirst({ where: { locationId: locId, number: tableNo }, select: { id: true } })
  if (!table) {
    table = await db.table.create({ data: { id: nid(), number: tableNo, capacity: 4, locationId: locId, status: 'available' } })
  }
  const orderId = `${PREFIX}ord-${TS}-${seedSeq}`
  await db.order.create({
    data: {
      id: orderId, orderNumber: orderNo, status: 'paid', paymentStatus: 'paid', paymentMethod: 'cash',
      subtotal: 18.2, tax: 3.6, discount: 0, tip: 0, total: 18.2, totalWithTip: 18.2, paidAt: new Date(),
      locationId: locId, tableId: table.id,
    },
  })
  const receiptId = `${PREFIX}rcpt-${TS}-${seedSeq}`
  await db.receipt.create({
    data: {
      id: receiptId, receiptNumber, orderId,
      businessName: `${PREFIX} Gostilna`, businessAddress: 'Testna 1', businessId: '12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', zoi: 'a'.repeat(32), eor: `EOR-${seedSeq}`, fiscalVerified: true, fiscalStatus: 'verified',
      subtotal: 18.2, vatBreakdown: JSON.stringify({ '22.00': { base: 14.6, vat: 3.6 } }), totalVat: 3.6, discount: 0,
      total: 18.2, tip: 0, totalWithTip: 18.2, paymentMethod: 'cash',
      isStorno: opts?.isStorno ?? false, stornoOf: opts?.stornoOf ?? '',
      printedAt: new Date(), locationId: locId, cisStatus: 'none',
    },
  })
  return receiptId
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  await cleanupFixtures()

  org = nid()
  brand = nid()
  prop = nid()
  await db.organization.create({ data: { id: org, name: `${PREFIX} Org`, slug: `${PREFIX}-org-${TS}` } })
  await db.brand.create({ data: { id: brand, organizationId: org, name: `${PREFIX} Brand` } })
  await db.property.create({ data: { id: prop, brandId: brand, name: `${PREFIX} Prop` } })
  locA = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} Lokacija A`, code: `${PREFIX}-A-${TS}`, premisesId: 'BLG251A', propertyId: prop, country: 'SI', timezone: 'Europe/Ljubljana' },
  })).id
  locB = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} Lokacija B`, code: `${PREFIX}-B-${TS}`, premisesId: 'BLG251B', propertyId: prop, country: 'SI', timezone: 'Europe/Ljubljana' },
  })).id

  mgrA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Vodja A`, email: `${PREFIX}-mgr-${TS}@test.local`, role: 'manager', pin: `${PREFIX}-pin-m-${TS}`, locationId: locA },
  })).id
  tokMgr = createToken({ sub: mgrA, name: `${PREFIX} Vodja A`, role: 'MANAGER', loc: locA, sv: 0 })
  waiterA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Natakar A`, email: `${PREFIX}-waiter-${TS}@test.local`, role: 'waiter', pin: `${PREFIX}-pin-w-${TS}`, locationId: locA },
  })).id
  tokWaiter = createToken({ sub: waiterA, name: `${PREFIX} Natakar A`, role: 'WAITER', loc: locA, sv: 0 })
  adminA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Admin A`, email: `${PREFIX}-admin-${TS}@test.local`, role: 'admin', pin: `${PREFIX}-pin-a-${TS}`, locationId: locA },
  })).id
  tokAdmin = createToken({ sub: adminA, name: `${PREFIX} Admin A`, role: 'ADMIN', loc: locA, sv: 0 })

  receiptMain = await seedReceiptWithOrder(locA, RN_MAIN, { tableNo: 7 })
  receiptLower = await seedReceiptWithOrder(locA, RN_LOWER, { tableNo: 8 })
  receiptLegacy = await seedReceiptWithOrder(locA, RN_LEGACY, { tableNo: 9 })
  receiptDupA = await seedReceiptWithOrder(locA, RN_DUP, { tableNo: 10 })
  receiptDupB = await seedReceiptWithOrder(locB, RN_DUP, { tableNo: 11 })
  receiptStorno = await seedReceiptWithOrder(locA, `${new Date().getFullYear()}-11-43-STO251`, { isStorno: true, stornoOf: receiptMain, tableNo: 12 })
})

afterAll(async () => {
  await cleanupFixtures()
  await sweepTestFixtures(db, [PREFIX])
})

/* ═══════════ Č1 — čisti sloj barcode.ts ═══════════ */

describe('v1.251.0 Č1 — čisti sloj: Code128-B enkodirnik', () => {
  test('A1: kanonski vektor »ABC« (spec primer): start B 211214, A 111323, B 131123, C 131321, kontrola 222122, stop 2331112', () => {
    const abc = encodeCode128b('ABC')!
    expect(abc).not.toBeNull()
    expect(abc.widths.join('')).toBe('2112141113231311231313212221222331112')
    // vsota modulov: start(11) + 3×11 + kontrola(11) + stop(13) = 68
    expect(abc.totalModules).toBe(68)
  })

  test('A2: kontrolna vsota mod 103 — ABC → 1 (104 + 33 + 2×34 + 3×35 = 310 = 3×103 + 1)', () => {
    const abc = encodeCode128b('ABC')!
    // vzorec kontrolne vsote je 5. blok širin (po startu in 3 znakih)
    const checkPattern = abc.widths.slice(4 * 6, 5 * 6).join('')
    expect(checkPattern).toBe('222122') // vrednost 1
  })

  test('A3: številka računa (2026-11-42-BLG001) — (n+2)×11+13 modulov, start/stop obrobljen', () => {
    const rn = encodeCode128b('2026-11-42-BLG001')!
    expect(rn).not.toBeNull()
    expect(rn.totalModules).toBe((17 + 2) * 11 + 13)
    // prvi vzorec = start B (211214), zadnjih 7 širin = stop (2331112)
    expect(rn.widths.slice(0, 6).join('')).toBe('211214')
    expect(rn.widths.slice(-7).join('')).toBe('2331112')
    // število elementov: 6 širin na simbol (start + 17 znakov + kontrola) + 7 za stop = liho (začne/konča s črto)
    expect(rn.widths.length).toBe(6 * 19 + 7)
    expect(rn.widths.length % 2).toBe(1)
  })

  test('A4: invarianta dolžine za različne vhode — vsak simbol prispeva natanko 11 modulov (stop 13)', () => {
    for (const s of ['X', '2026', 'R-2025-123', 'BLG251A-2026-11-42-999999', '0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
      const e = encodeCode128b(s)!
      expect(e.totalModules).toBe((s.length + 2) * 11 + 13)
    }
  })

  test('A5: zavrne prazen, predolg in znake izven ASCII 32–126 (č/š/ž/€/tab)', () => {
    expect(encodeCode128b('')).toBeNull()
    expect(encodeCode128b('a'.repeat(CODE128_MAX_INPUT + 1))).toBeNull()
    expect(encodeCode128b('č')).toBeNull()
    expect(encodeCode128b('šumniki ž')).toBeNull()
    expect(encodeCode128b('€')).toBeNull()
    expect(encodeCode128b('ta\tb')).toBeNull()
    expect(encodeCode128b('2026-11-42-BLG001')).not.toBeNull() // veljaven ostaja
  })

  test('A6: tihi prostor (quiet zone) = 10 modulov na stran (spec minimum)', () => {
    expect(CODE128_QUIET_MODULES).toBe(10)
  })

  test('A7: normalizeReceiptScan — trim + vsi presledki ven, velikost OHRANJENA', () => {
    expect(normalizeReceiptScan('  2026-11-42-BLG001 \n')).toBe('2026-11-42-BLG001')
    expect(normalizeReceiptScan('2026-11-42 BLG001')).toBe('2026-11-42BLG001')
    expect(normalizeReceiptScan('')).toBe('')
    expect(normalizeReceiptScan(undefined as unknown as string)).toBe('')
    expect(normalizeReceiptScan('2026-11-77-blg251x')).toBe('2026-11-77-blg251x') // male ostanejo
  })

  test('A8: receiptScanVariants — [kot-je, velike, male] v enem nizu', () => {
    expect(receiptScanVariants('2026-11-77-blg251x')).toEqual(['2026-11-77-blg251x', '2026-11-77-BLG251X', '2026-11-77-blg251x'])
    expect(receiptScanVariants('R-2025-123')).toEqual(['R-2025-123', 'R-2025-123', 'r-2025-123'])
  })
})

/* ═══════════ Č2 — natisnjen račun (buildReceiptHTML) ═══════════ */

function fixtureReceipt(invoiceNumber: string, overrides?: Partial<ReceiptDetailT>): ReceiptDetailT {
  return {
    id: 'rcpt-1', invoiceNumber, createdAt: new Date().toISOString(), printedAt: new Date().toISOString(),
    businessName: 'Test Gostilna', businessAddress: 'Testna 1', businessId: '12345678', taxId: 'SI12345678',
    registerId: 'BLG-001', premisesId: 'BLG251A', zoi: 'z'.repeat(32), eor: 'EOR-1', fiscalVerified: true, fiscalStatus: 'verified',
    subtotal: 18.2, discount: 0, totalVat: 3.6, total: 18.2, tip: 0, totalWithTip: 18.2, paymentMethod: 'cash',
    isCopy: false, isStorno: false, vatBreakdown: [{ rate: 22, base: 14.6, vat: 3.6 }],
    orderNumber: 42, tableName: 'Miza 7', operator: 'Ana', items: [{ name: 'Jedi', qty: 2, price: 9.1, vatRate: 22, amount: 18.2 }],
    ...overrides,
  }
}

describe('v1.251.0 Č2 — natisnjen račun: SVG črtna koda Code128', () => {
  test('B1: SL račun nosi SVG z viewBox, belo podlago, črtami in napisom številke', () => {
    const html = buildReceiptHTML(fixtureReceipt('2026-11-42-BLG001'), 'Hvala za obisk!', 'sl')
    expect(html).toContain('<svg class="bc"')
    expect(html).toContain('viewBox="0 0 242 60"') // 222 modulov + 2×10 tihih prostorov
    expect(html).toContain('aria-label="2026-11-42-BLG001"')
    expect(html).toContain('fill="#fff"') // bela podlaga (quiet zone vidna)
    expect((html.match(/<rect /g) ?? []).length).toBeGreaterThan(20) // črte kot rect elementi
    expect(html).toContain('2026-11-42-BLG001') // napis pod kodo (ročni vnos fallback)
    expect(html).toContain('.bcwrap') // CSS razred
  })

  test('B2: HR račun (ZKI/JIR) nosi črtno kodo enako', () => {
    const html = buildReceiptHTML(
      fixtureReceipt('2026-11-42-BLG251A', { country: 'HR', zki: 'z'.repeat(32), jir: 'j'.repeat(32), qr: 'https://provjera.porezna-uprava.hr/x' }),
      undefined, 'hr',
    )
    expect(html).toContain('<svg class="bc"')
    expect(html).toContain('aria-label="2026-11-42-BLG251A"')
  })

  test('B3: neenkodirljiva številka (č) — koda TIHO izpuščena, račun se zgradi (§18)', () => {
    const html = buildReceiptHTML(fixtureReceipt('2026-11-42-ČLG001'), undefined, 'sl')
    expect(html).not.toContain('<svg class="bc"')
    expect(html).toContain('<html lang="sl">') // dokument ostane veljaven
    expect(html).toContain('ZOI:') // fiskalni blok nespremenjen
  })

  test('B4: koda stoji ZA fiskalno oznako in PRED nogo (vrstni red izpisa)', () => {
    const html = buildReceiptHTML(fixtureReceipt('2026-11-42-BLG001'), ' FOOTER-XYZ ', 'sl')
    const iFiscal = html.indexOf('ZOI:')
    const iSvg = html.indexOf('<svg class="bc"')
    const iFooter = html.indexOf('FOOTER-XYZ')
    expect(iFiscal).toBeGreaterThan(-1)
    expect(iSvg).toBeGreaterThan(iFiscal)
    expect(iFooter).toBeGreaterThan(iSvg)
  })
})

/* ═══════════ Č3 — živa ruta GET /api/furs/lookup ═══════════ */

describe('v1.251.0 Č3 — živa ruta GET /api/furs/lookup (sqlite)', () => {
  test('C1: brez žetona → 401', async () => {
    const res = await lookupGET(req(`/api/furs/lookup?code=${RN_MAIN}`, ''))
    expect(res.status).toBe(401)
  })

  test('C2: natakar (brez reports.sales) → 403', async () => {
    const res = await lookupGET(req(`/api/furs/lookup?code=${RN_MAIN}`, tokWaiter))
    expect(res.status).toBe(403)
  })

  test('C3: vodja — točno ujemanje: 200, en zadetek s številko, mizo, naročilom, zneskom', async () => {
    const res = await lookupGET(req(`/api/furs/lookup?code=${encodeURIComponent(RN_MAIN)}`, tokMgr))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.receipts.length).toBe(1)
    const r = d.receipts[0]
    expect(r.invoiceNumber).toBe(RN_MAIN)
    expect(r.tableName).toBe('Miza 7')
    expect(r.orderNumber).toBeGreaterThan(25100)
    expect(r.total).toBe(18.2)
    expect(r.fiscalVerified).toBe(true)
    expect(r.isStorno).toBe(false)
    expect(r.stornoOf).toBe(null) // preslikava seznama: prazna → null
    expect(r.id).toBe(receiptMain)
  })

  test('C4: presledki okoli in znotraj vnosa → normalizirano ujemanje', async () => {
    const spaced = `  ${RN_MAIN.slice(0, 7)} ${RN_MAIN.slice(7)} \n`
    const res = await lookupGET(req(`/api/furs/lookup?code=${encodeURIComponent(spaced)}`, tokMgr))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.receipts.length).toBe(1)
    expect(d.receipts[0].invoiceNumber).toBe(RN_MAIN)
  })

  test('C5: velikost črk — seedana mala premises, iskanje z VELIKIMI → najdeno prek variante', async () => {
    const upper = RN_LOWER.toUpperCase()
    const res = await lookupGET(req(`/api/furs/lookup?code=${encodeURIComponent(upper)}`, tokMgr))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.receipts.length).toBe(1)
    expect(d.receipts[0].invoiceNumber).toBe(RN_LOWER)
    expect(d.receipts[0].id).toBe(receiptLower)
  })

  test('C6: neobstoječa koda → 200 s praznim seznamom (iskreno, ne 404)', async () => {
    const res = await lookupGET(req(`/api/furs/lookup?code=2099-99-99-NOPE99`, tokMgr))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.receipts).toEqual([])
  })

  test('C7: prekratka koda → 400 (isti prag kao EAN v1.229)', async () => {
    const res = await lookupGET(req(`/api/furs/lookup?code=12`, tokMgr))
    expect(res.status).toBe(400)
    const res2 = await lookupGET(req(`/api/furs/lookup?code=`, tokMgr))
    expect(res2.status).toBe(400)
  })

  test('C8: stara številčna shema R-2025-123 (ročni vnos z računa) → najdeno', async () => {
    const res = await lookupGET(req(`/api/furs/lookup?code=R-2025-123`, tokMgr))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.receipts.length).toBe(1)
    expect(d.receipts[0].invoiceNumber).toBe(RN_LEGACY)
    expect(d.receipts[0].id).toBe(receiptLegacy)
  })

  test('C9: obseg — vodja A vidi SAMO svojo lokacijo; admin (centralen) vidi OBE z isto številko', async () => {
    const resMgr = await lookupGET(req(`/api/furs/lookup?code=${encodeURIComponent(RN_DUP)}`, tokMgr))
    expect(resMgr.status).toBe(200)
    const dMgr = await resMgr.json()
    expect(dMgr.receipts.length).toBe(1)
    expect(dMgr.receipts[0].id).toBe(receiptDupA)

    const resAdmin = await lookupGET(req(`/api/furs/lookup?code=${encodeURIComponent(RN_DUP)}`, tokAdmin))
    expect(resAdmin.status).toBe(200)
    const dAdmin = await resAdmin.json()
    expect(dAdmin.receipts.length).toBe(2)
    expect(dAdmin.receipts.map((r: { id: string }) => r.id).sort()).toEqual([receiptDupA, receiptDupB].sort())
  })

  test('C10: storno račun — isStorno true + stornoOf povezava na original', async () => {
    const rn = `${new Date().getFullYear()}-11-43-STO251`
    const res = await lookupGET(req(`/api/furs/lookup?code=${encodeURIComponent(rn)}`, tokMgr))
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.receipts.length).toBe(1)
    expect(d.receipts[0].isStorno).toBe(true)
    expect(d.receipts[0].stornoOf).toBe(receiptMain)
  })
})

/* ═══════════ Č4 — UI montaža (zavihek Računi) ═══════════ */

describe('v1.251.0 Č4 — UI: kartica skeniranja v zavihku Računi', () => {
  test('D1: kartica z oznakami data-region + testid + naslov/placeholder/gumb iz i18n', () => {
    expect(dash).toContain('data-region="receipt-scan"')
    expect(dash).toContain('data-testid="receipt-scan-input"')
    expect(dash).toContain("t('rcpt.scanTitle')")
    expect(dash).toContain("t('rcpt.scanPlaceholder')")
    expect(dash).toContain("t('rcpt.scanBtn')")
    expect(dash).toContain("t('rcpt.scanHint')")
    expect(dash).toContain("t('rcpt.scanNone')")
    expect(dash).toContain('data-region="receipt-scan-results"')
    expect(dash).toContain('<ScanBarcode') // ikona v naslovu kartice
  })

  test('D2: gating reports.sales + Enter submit (skener = tipkovnica) + ponatis/storno akciji na zadetku', () => {
    expect(dash).toContain("{hasPerm('reports.sales') && (")
    expect(dash).toContain("if (e.key === 'Enter')")
    expect(dash).toContain('rcptScanSubmit')
    expect(dash).toContain("printInvoice(r.id)") // ponatis že najdenega
    expect(dash).toContain('stornoReceipt(r)') // storno že najdenega
    expect(dash).toContain('/api/furs/lookup?code=')
  })

  test('D3: i18n — 6 rcpt.scan* ključev v SL in HR; EN (gostujoči) jih NIMA (fallback SL)', () => {
    const slKeys = Object.keys(sl).filter((k) => k.startsWith('rcpt.scan'))
    const hrKeys = Object.keys(hr).filter((k) => k.startsWith('rcpt.scan'))
    expect(slKeys.length).toBe(6)
    expect(hrKeys.length).toBe(6)
    expect(slKeys).toEqual(hrKeys)
    for (const k of slKeys) expect(sl[k].length).toBeGreaterThan(3)
    for (const k of hrKeys) expect(hr[k].length).toBeGreaterThan(3)
    expect(Object.keys(en).filter((k) => k.startsWith('rcpt.scan')).length).toBe(0)
  })
})

/* ═══════════ Ž — registri in pini ═══════════ */

describe('v1.251.0 Ž — registri in pini', () => {
  test('Ž1: verzija 1.257.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.273.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.273.0'")
    expect(compose).toContain('restaurantos:1.273.0')
  })

  test('Ž2: i18n pariteta SL/HR 4093/4093 (+6 rcpt.scan*)', () => {
    expect(Object.keys(sl).length).toBe(4320)
    expect(Object.keys(hr).length).toBe(4320)
  })

  test('Ž3: ruta — pravica, obseg, variante, 0 DDL dokaz, 0 novih odvisnosti', () => {
    expect(routeSrc).toContain("requirePermission(req, 'reports.sales')")
    expect(routeSrc).toContain('await locationScope(user)')
    expect(routeSrc).toContain('normalizeReceiptScan')
    expect(routeSrc).toContain('receiptScanVariants(code)')
    expect(routeSrc).toContain('take: 50')
    // 0 DDL: prisma shema nedotaknjena (nobenega modela/stolpca Barcode*)
    expect(read('prisma/schema.prisma')).not.toContain('barcode')
    expect(read('prisma/schema.prisma')).not.toContain('model Barcode')
    // 0 novih odvisnosti: kodirnik je čisti sloj (0 uvozov)
    expect(barcodeSrc).not.toMatch(/^import /m)
    // črtna koda na računu = tiho izpuščena ob napaki (§18)
    expect(receiptSrc).toContain('encodeCode128b')
  })

  test('Ž4: dokumenta — PRIMERJAVA §25 + AUDIT števci', () => {
    expect(doc).toContain('## 25.')
    expect(doc).toContain('Look up checks by scanning the receipt barcode')
    expect(auditDoc).toContain('v1.251.0')
    expect(auditDoc).toContain('- 4320 ključev SL in 4320 HR')
  })

  test('Ž5: worklog vrhnji vnos nosi Task ID v1.252.0-finalna-verifikacija', () => {
    expect(wl.slice(0, 400)).toContain('Task ID: v1.273.0-diakritike-izvoz-api')
  })
})
