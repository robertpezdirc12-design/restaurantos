import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as guestsPOST } from '../src/app/api/orders/[id]/checks/guests/route'
import { GET as checksGET } from '../src/app/api/orders/[id]/checks/route'

/**
 * P1-6 (v1.185.0) — SPLIT PO GOSTIH.
 *
 * Tržna vrzel (docs/TRZNA-VRZELI-2026.md §4 P1 #6): »2 gosta na računu« —
 * obstojeci split po izstavkih (OPS-7) zahteva ročno oklepjanje postavk; obstoječi
 * N× razdelitvi plačilnih delov (OPS-4 v1.67.0) ostanejo na EN izstavku (en račun).
 * Ta ruta v ENM kliku porazdeli postavke na N pravih izstavkov (vsak svoje plačilo
 * in svoj račun), pošteno po znesku (LPT: najdražja postavka v trenutno najlažje
 * vedro), atomsko in z revizijo.
 *
 * Merila:
 *  G1 pravice (401 brez žetona, 403 brez orders.pay, 404 tuje naročilo, tenant meja)
 *  G2 validacija (400: ne-celo število, 1, 11; 409: premalo postavk)
 *  G3 konservativnost (409: plačano naročilo, plačan izstavek, izstavek s plačilom)
 *  G4 srečen tok (2 gostova: 2 izstavka, vsi dodeljeni, pošteno po znesku,
 *     izstavek #1 ohrani id, audit zapisan, GET checks odraža)
 *  G5 rebalans (ponoven klic z N=3 ne doda izstavkov — 3 skupaj, vsi neplačani)
 *  G6 voided postavke so izključene iz porazdelitve in iz premalo-postavk računa
 *
 * ID-ji s predpono `v185-` (sweep beforeAll, cleanup afterAll).
 */

const PREFIX = 'v185-'
const RUN = Date.now().toString(36)

let locId = ''
let adminId = ''
let adminToken = ''
let noPayToken = ''
let menuItemId = ''

function req(url: string, token: string | null, method = 'POST', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

let itemSeq = 0

async function seedItem(orderId: string, name: string, price: number, qty = 1, voided = false): Promise<string> {
  itemSeq += 1
  const row = await db.orderItem.create({
    data: {
      id: `${PREFIX}it${itemSeq}-${RUN}`, orderId, menuItemId, menuItemName: name, quantity: qty, price, vatRate: 22, vatAmount: 0,
      status: 'fired', voided,
    },
  })
  return row.id
}

async function guests(orderId: string, n: number, token = adminToken) {
  return guestsPOST(req(`/api/orders/${orderId}/checks/guests`, token, 'POST', { guestCount: n }), { params: Promise.resolve({ id: orderId }) })
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `V185-${RUN.toUpperCase()}`, premisesId: `${PREFIX}prem-${RUN}`, country: 'SI' },
  })
  locId = loc.id
  adminId = `${PREFIX}admin-${RUN}`
  const adminPin = employeePinFields(`9${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locId, ...adminPin },
  })
  const cleanerPin = employeePinFields(`8${RUN.slice(-5)}`, `${PREFIX}clean-${RUN}@test.local`)
  const waiter = await db.employee.create({
    data: { id: `${PREFIX}clean-${RUN}`, name: `${PREFIX}Cistilka`, email: `${PREFIX}clean-${RUN}@test.local`, role: 'CLEANER', status: 'active', sessionVersion: 0, locationId: locId, ...cleanerPin },
  })
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locId } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
  menuItemId = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: `${PREFIX}Artikel`, price: 10, categoryId: cat.id } })).id
  adminToken = createToken({ sub: adminId, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locId, sv: 0 })
  noPayToken = createToken({ sub: waiter.id, name: `${PREFIX}Cistilka`, role: 'CLEANER', loc: locId, sv: 0 })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

describe('v1.185.0 — split po gostih (P1-6)', () => {
  test('G1a brez žetona → 401', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o0-${RUN}`, locationId: locId, orderNumber: 962000, status: 'open', paymentStatus: 'unpaid' } })
    const res = await guests(o.id, 2, null)
    expect(res.status).toBe(401)
  })

  test('G1b CLEANER brez orders.pay → 403', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o0b-${RUN}`, locationId: locId, orderNumber: 962001, status: 'open', paymentStatus: 'unpaid' } })
    const res = await guests(o.id, 2, noPayToken)
    expect(res.status).toBe(403)
  })

  test('G1c neznano naročilo → 404', async () => {
    const res = await guests(`${PREFIX}manjka-${RUN}`, 2)
    expect(res.status).toBe(404)
  })

  test('G2a guestCount 1 / 11 / 2.5 → 400', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o1-${RUN}`, locationId: locId, orderNumber: 962002, status: 'open', paymentStatus: 'unpaid' } })
    for (const n of [1, 11, 2.5, 0, -3]) {
      const res = await guests(o.id, n)
      expect(res.status, `guestCount=${n}`).toBe(400)
    }
    // ne-število
    const bad = await guestsPOST(req(`/api/orders/${o.id}/checks/guests`, adminToken, 'POST', { guestCount: 'veliko' }), { params: Promise.resolve({ id: o.id }) })
    expect(bad.status).toBe(400)
  })

  test('G2b premalo postavk za N gostov → 409, vsak dobi vsaj eno', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o2-${RUN}`, locationId: locId, orderNumber: 962003, status: 'open', paymentStatus: 'unpaid' } })
    await seedItem(o.id, 'Kava', 2.5)
    await seedItem(o.id, 'Sok', 3.0)
    const res = await guests(o.id, 3)
    expect(res.status).toBe(409)
    const j = (await res.json()) as { error: string }
    expect(j.error).toContain('vsaj eno')
  })

  test('G3a plačano naročilo → 409', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o3-${RUN}`, locationId: locId, orderNumber: 962004, status: 'paid', paymentStatus: 'paid' } })
    await seedItem(o.id, 'Kava', 2.5)
    const res = await guests(o.id, 2)
    expect(res.status).toBe(409)
  })

  test('G3b plačan izstavek → 409', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o4-${RUN}`, locationId: locId, orderNumber: 962005, status: 'open', paymentStatus: 'unpaid' } })
    await seedItem(o.id, 'Kava', 2.5)
    await seedItem(o.id, 'Sok', 3.0)
    await db.check.create({ data: { id: `${PREFIX}chkPaid-${RUN}`, checkNumber: 1, orderId: o.id, paymentStatus: 'paid' } })
    const res = await guests(o.id, 2)
    expect(res.status).toBe(409)
  })

  test('G3c izstavek z plačilom (paymentStatus unpaid!) → 409', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o5-${RUN}`, locationId: locId, orderNumber: 962006, status: 'open', paymentStatus: 'unpaid' } })
    await seedItem(o.id, 'Kava', 2.5)
    const chk = await db.check.create({ data: { id: `${PREFIX}chkPay-${RUN}`, checkNumber: 1, orderId: o.id, paymentStatus: 'unpaid' } })
    await db.payment.create({ data: { id: `${PREFIX}pay-${RUN}`, checkId: chk.id, amount: 2.5, type: 'cash' } })
    const res = await guests(o.id, 2)
    expect(res.status).toBe(409)
  })

  test('G4 srečen tok: 2 gostova → poštena porazdelitev po znesku, audit, GET odraža', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o6-${RUN}`, locationId: locId, orderNumber: 962007, status: 'open', paymentStatus: 'unpaid' } })
    await seedItem(o.id, 'Zebra pečenka', 18.9)
    await seedItem(o.id, 'Burek', 3.5)
    await seedItem(o.id, 'Kranjska', 12.5)
    await seedItem(o.id, 'Juha', 4.5)

    const res = await guests(o.id, 2)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { guestCount: number; checks: { id: string; checkNumber: number; items: number; total: number }[] }
    expect(body.guestCount).toBe(2)
    expect(body.checks).toHaveLength(2)
    expect(body.checks.map((c) => c.checkNumber).sort((a, b) => a - b)).toEqual([1, 2])
    // vsi 4 postavki dodeljeni
    expect(body.checks.reduce((s, c) => s + c.items, 0)).toBe(4)
    // LPT pravičnost: razlika med vedroma ≤ najdražja postavka (18.9)
    const totals = body.checks.map((c) => c.total).sort((a, b) => a - b)
    expect(totals[1] - totals[0]).toBeLessThanOrEqual(18.9 + 0.005)
    // seštevek = vsota postavk
    expect(Math.abs(totals[0] + totals[1] - 39.4)).toBeLessThan(0.01)
    // vsak izstavek vsaj 1 postavka
    expect(body.checks.every((c) => c.items >= 1)).toBe(true)

    // izstavek #1 ohrani PRVI id (baza) — GET checks pokaže dodelitev
    const firstCheckId = body.checks.find((c) => c.checkNumber === 1)!.id
    const items = await db.orderItem.findMany({ where: { orderId: o.id, voided: false } })
    const perCheck = new Map<string, number>()
    for (const it of items) {
      const k = it.checkId ?? ''
      perCheck.set(k, (perCheck.get(k) ?? 0) + 1)
    }
    expect(perCheck.size).toBe(2)
    expect(perCheck.get(firstCheckId)).toBe(body.checks.find((c) => c.checkNumber === 1)!.items)

    // audit
    const audit = await db.auditLog.findFirst({ where: { entityType: 'Order', entityId: o.id, action: 'ORDER_CHECK_GUEST_SPLIT' } })
    expect(audit).not.toBeNull()
    expect(String(audit?.details)).toContain('"guestCount":2')

    // GET checks odraža 2 izstavka
    const g = await checksGET(req(`/api/orders/${o.id}/checks`, adminToken, 'GET'), { params: Promise.resolve({ id: o.id }) })
    expect(g.status).toBe(200)
    const gj = (await g.json()) as { checkCount: number }
    expect(gj.checkCount).toBe(2)
  })

  test('G4b LPT specifično: najdražja ostane sama, lahke gredo k drugemu vedru (pravičnost)', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o7-${RUN}`, locationId: locId, orderNumber: 962008, status: 'open', paymentStatus: 'unpaid' } })
    // LPT potek: 18.9 → vedro A; 12.5 → vedro B; 4.5 → vedro B (12.5 < 18.9);
    // 3.5 → vedro B (17.0 < 18.9). Rezultat: 18.9 vs 20.5 → razlika 1.6.
    // (razdelitev po ŠTEVILU postavk bi dala 18.9+12.5=31.4 vs 8.0 → razlika 23.4 — krivično)
    await seedItem(o.id, 'Zebra pečenka', 18.9)
    await seedItem(o.id, 'Kranjska', 12.5)
    await seedItem(o.id, 'Juha', 4.5)
    await seedItem(o.id, 'Burek', 3.5)
    const res = await guests(o.id, 2)
    const body = (await res.json()) as { checks: { total: number }[] }
    const totals = body.checks.map((c) => c.total).sort((a, b) => a - b)
    expect(totals[0]).toBeCloseTo(18.9, 2)
    expect(totals[1]).toBeCloseTo(20.5, 2)
  })

  test('G5 rebalans: ponoven klic z N=3 ne doda izstavkov čez 3 in ne puščava starih', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o8-${RUN}`, locationId: locId, orderNumber: 962009, status: 'open', paymentStatus: 'unpaid' } })
    for (let i = 1; i <= 6; i++) await seedItem(o.id, `Postavka ${i}`, 5 + i)
    const r1 = await guests(o.id, 2)
    expect(r1.status).toBe(200)
    const r2 = await guests(o.id, 3)
    expect(r2.status).toBe(200)
    const body = (await r2.json()) as { checks: { checkNumber: number }[] }
    expect(body.checks).toHaveLength(3)
    expect(body.checks.map((c) => c.checkNumber)).toEqual([1, 2, 3])
    const dbChecks = await db.check.findMany({ where: { orderId: o.id } })
    expect(dbChecks).toHaveLength(3)
    const items = await db.orderItem.findMany({ where: { orderId: o.id, voided: false } })
    expect(items.every((it) => it.checkId && dbChecks.some((c) => c.id === it.checkId))).toBe(true)
  })

  test('G6 voided postavke: izključene iz porazdelitve in iz omejitve premalo postavk', async () => {
    const o = await db.order.create({ data: { id: `${PREFIX}o9-${RUN}`, locationId: locId, orderNumber: 962010, status: 'open', paymentStatus: 'unpaid' } })
    await seedItem(o.id, 'Kava', 2.5)
    await seedItem(o.id, 'Sok', 3.0)
    await seedItem(o.id, 'Stornirano', 99, 1, true)
    // 2 živi postavki: N=2 gre; N=3 ne (voided ne šteje)
    const ok2 = await guests(o.id, 2)
    expect(ok2.status).toBe(200)
    const body = (await ok2.json()) as { checks: { items: number }[] }
    expect(body.checks.reduce((s, c) => s + c.items, 0)).toBe(2)

    const o2 = await db.order.create({ data: { id: `${PREFIX}o10-${RUN}`, locationId: locId, orderNumber: 962011, status: 'open', paymentStatus: 'unpaid' } })
    await seedItem(o2.id, 'Kava', 2.5)
    await seedItem(o2.id, 'Stornirano', 99, 1, true)
    const bad = await guests(o2.id, 2)
    expect(bad.status).toBe(409)
    const j = (await bad.json()) as { error: string }
    expect(j.error).toContain('1 postavk')
  })
})
