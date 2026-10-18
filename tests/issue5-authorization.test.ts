/**
 * Issue #5 (P0) — varna in dosledna avtorizacija pri vsakem API-klicu.
 *
 * pokriva v1.88.0 popravke:
 *  A. read-leaks: settings (SECRETS), suppliers (IBAN/davčna), events (payload),
 *     jobs, webhooks, monitoring/errors, integrations (v integrations-admin),
 *     stocktakes, reservations (PII), orders, feedback, kitchen (KDS vrsta),
 *     inventory cost strip;
 *  B. org-scope: locations/stats, locations, dashboard (?locationId org preverba +
 *     finančni KPI gating), tips, purchase-orders, GL entryNumber po obsegu;
 *  C. write-gaps: shifts POST (cash.manage), haccp GET/POST, orders note/customerName,
 *     discounts katalog (discounts.manage + location guard), employees POST eskalacija
 *     + PIN + role-bump seje, tables tloris, staff-shifts lastne/ekipa + jobId;
 *  D. NOVA funkcija: preklic posamezne postavke (orders.void + VoidReason katalog);
 *  E. landingTab (P1-A pristajalni zavihek po vlogi).
 *
 * ID-ji s predpono `i5-` (idempotentno, cleanup afterAll — obrnjen FK vrstni red).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { landingTab } from '../src/lib/tab-permissions'
import { glEntryNumber } from '../src/lib/gl'
import { GET as settingsGET } from '../src/app/api/settings/route'
import { GET as suppliersGET } from '../src/app/api/suppliers/route'
import { GET as eventsGET } from '../src/app/api/events/route'
import { GET as jobsGET } from '../src/app/api/jobs/route'
import { GET as webhooksGET } from '../src/app/api/webhooks/route'
import { GET as monitoringErrorsGET } from '../src/app/api/monitoring/errors/route'
import { GET as kitchenGET } from '../src/app/api/kitchen/route'
import { POST as shiftsPOST } from '../src/app/api/shifts/route'
import { GET as haccpGET, POST as haccpPOST } from '../src/app/api/haccp/route'
import { GET as ordersGET } from '../src/app/api/orders/route'
import { PATCH as orderPATCH } from '../src/app/api/orders/[id]/route'
import { POST as orderVoidPOST } from '../src/app/api/orders/[id]/void/route'
import { GET as voidReasonsGET } from '../src/app/api/void-reasons/route'
import { POST as discountsPOST } from '../src/app/api/discounts/route'
import { PATCH as discountPATCH } from '../src/app/api/discounts/[id]/route'
import { POST as employeesPOST } from '../src/app/api/employees/route'
import { PATCH as employeePATCH } from '../src/app/api/employees/[id]/route'
import { PATCH as tablePATCH } from '../src/app/api/tables/[id]/route'
import { GET as staffShiftsGET, POST as staffShiftsPOST } from '../src/app/api/staff-shifts/route'
import { GET as locationsStatsGET } from '../src/app/api/locations/stats/route'
import { GET as locationsGET } from '../src/app/api/locations/route'
import { GET as dashboardGET } from '../src/app/api/dashboard/route'
import { GET as tipsGET } from '../src/app/api/tips/route'
import { GET as purchaseOrdersGET } from '../src/app/api/purchase-orders/route'
import { GET as reservationsGET } from '../src/app/api/reservations/route'
import { GET as feedbackGET } from '../src/app/api/guests/feedback/route'
import { GET as stocktakesGET } from '../src/app/api/stocktakes/route'
import { GET as inventoryGET } from '../src/app/api/inventory/route'
import { GET as glGET } from '../src/app/api/reports/gl/route'

const PREFIX = 'i5-'
const RUN = Date.now().toString(36)
const DAY = '2026-03-10'

let orgA = '', propA = '', brandA = ''
let orgB = '', propB = '', brandB = ''
let locA1 = '', locB1 = ''
let adminA = '', adminB = '', waiterA = '', chefA = '', cleanerA = '', managerA = ''
let orderVoid = '', item1 = '', item2 = '', voidReasonA = ''
let tableA = '', discountB = ''
let miI5 = ''
let shiftOrderSeq = 7500
/* v1.141.0: /api/settings GET je globalni singleton (findFirst) — da fiksna
   vrstica ZAGOTOVO zadene (tudi na demo-sejani bazi), obstoječe nastavitve
   odložimo pred testom in jih po testu povrnemo (hermetičen test). */
let settingsStash: Awaited<ReturnType<typeof db.restaurantSettings.findMany>> = []

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const isResp = (r: unknown): r is Response => r instanceof Response
/** Route handler vrne OBEČANO vrednost — awaitamo jo TUKAJ (helper prejme lahko Promise) */
async function status(r: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  const v = (await (r as Promise<unknown> | Response)) as unknown
  expect(isResp(v)).toBe(true)
  const res = v as Response
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function seedEmployee(name: string, role: string, loc: string, pinSeq: number): Promise<string> {
  const id = `${PREFIX}${name}-${RUN}`
  // pinLookup je globalno unikaten PO PIN-u (hash(pin) brez e-pošte!) — PIN izpeljemo
  // iz unikatnega ID-ja (deterministično, kolidacije s preostalim suite nemogoče)
  const pin = String(10000000 + ([...`${id}${pinSeq}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 89999999, 7)))
  const fields = employeePinFields(pin, `${PREFIX}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${PREFIX}${name}`, email: `${PREFIX}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
  return id
}

async function seedOrder(loc: string, status: string, pay: string): Promise<string> {
  const n = ++shiftOrderSeq
  return (await db.order.create({
    data: { id: `${PREFIX}ord-${n}-${RUN}`, locationId: loc, orderNumber: n, status, paymentStatus: pay, type: 'dine-in' },
  })).id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  orgA = `${PREFIX}orgA-${RUN}`; brandA = `${PREFIX}brandA-${RUN}`; propA = `${PREFIX}propA-${RUN}`
  orgB = `${PREFIX}orgB-${RUN}`; brandB = `${PREFIX}brandB-${RUN}`; propB = `${PREFIX}propB-${RUN}`
  locA1 = `${PREFIX}locA1-${RUN}`; locB1 = `${PREFIX}locB1-${RUN}`
  await db.organization.create({ data: { id: orgA, name: 'I5 Org A', slug: `${PREFIX}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: 'I5 Org B', slug: `${PREFIX}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: 'BA' } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: 'BB' } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: 'PA' } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: 'PB' } })
  await db.location.create({ data: { id: locA1, name: 'I5 A1', code: `${PREFIX}A1-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locB1, name: 'I5 B1', code: `${PREFIX}B1-${RUN}`, propertyId: propB } })

  adminA = await seedEmployee('adminA', 'admin', locA1, 1)
  adminB = await seedEmployee('adminB', 'admin', locB1, 2)
  waiterA = await seedEmployee('waiterA', 'waiter', locA1, 3)
  chefA = await seedEmployee('chefA', 'chef', locA1, 4)
  cleanerA = await seedEmployee('cleanerA', 'cleaner', locA1, 5)
  managerA = await seedEmployee('managerA', 'manager', locA1, 6)

  // nastavitve z SKRIVNOSTMI (settings leak test)
  // v1.141.0: singleton getFirst() mora zadeti TO vrstico — demo nastavitve odložimo
  settingsStash = await db.restaurantSettings.findMany()
  if (settingsStash.length) await db.restaurantSettings.deleteMany({})
  await db.restaurantSettings.create({
    data: {
      id: `${PREFIX}settings-${RUN}`, name: 'I5 Test', fursCertPassword: 'SECRET-FURS-123',
      emailSmtpPassword: 'SECRET-SMTP-456', apiKeys: '["SECRET-API"]', cisCertPassword: 'SECRET-CIS-789',
      receiptFooter: 'I5 footer', currency: 'EUR',
    },
  })

  // dobavitelj (finančni profil)
  await db.supplier.create({
    data: { id: `${PREFIX}sup-${RUN}`, name: `${PREFIX} Doba`, taxId: 'SI999', iban: 'SI56...', bank: 'NLB', paymentTerms: '30 dni', isActive: true },
  })

  // zaloga (cost strip test)
  await db.inventoryItem.create({
    data: { id: `${PREFIX}inv-${RUN}`, name: `${PREFIX} Moka`, unit: 'kg', quantity: 5, minQuantity: 1, costPerUnit: 3.5, locationId: locA1 },
  })

  // miza (tloris test)
  tableA = (await db.table.create({
    data: { id: `${PREFIX}tbl-${RUN}`, number: 9105, status: 'available', locationId: locA1 },
  })).id

  // naročilo + postavki (void test) + katalog razlogov
  voidReasonA = (await db.voidReason.create({
    data: { id: `${PREFIX}vr-${RUN}`, name: 'I5 razlog', sortOrder: 1, locationId: locA1 },
  })).id
  // meni za OrderItem FK (menuItemId → MenuItem)
  const menuI5 = (await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: 'I5 Meni', locationId: locA1 } })).id
  const catI5 = (await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: 'I5 Kategorija', menuId: menuI5 } })).id
  miI5 = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: 'I5 Pizza', price: 10, categoryId: catI5 } })).id
  orderVoid = await seedOrder(locA1, 'open', 'unpaid')
  item1 = (await db.orderItem.create({
    data: { id: `${PREFIX}it1-${RUN}`, orderId: orderVoid, menuItemId: miI5, menuItemName: 'I5 Pizza', quantity: 2, price: 10, vatRate: 22, vatAmount: 3.28, status: 'fired' },
  })).id
  item2 = (await db.orderItem.create({
    data: { id: `${PREFIX}it2-${RUN}`, orderId: orderVoid, menuItemId: miI5, menuItemName: 'I5 Solata', quantity: 1, price: 5, vatRate: 9.5, vatAmount: 0.43, status: 'pending' },
  })).id
  // zneski kot bi jih izračunal recalc (2×10 + 5 = 25 osnove + 3,71 DDV)
  await db.order.update({ where: { id: orderVoid }, data: { subtotal: 25, tax: 3.71, total: 28.71 } })

  // popust na TUJI lokaciji (cross-location PATCH test)
  discountB = (await db.discount.create({
    data: { id: `${PREFIX}discB-${RUN}`, name: `${PREFIX} B popust`, type: 'percent', amount: 10, triggerType: 'manual', isActive: true, locationId: locB1 },
  })).id

  // GL: računa istega dne v obeh organizacijah (entryNumber po obsegu)
  const glDate = new Date(`${DAY}T12:00:00`)
  const oA = await seedOrder(locA1, 'paid', 'paid')
  const oB = await seedOrder(locB1, 'paid', 'paid')
  await db.receipt.create({ data: { id: `${PREFIX}rA-${RUN}`, receiptNumber: `${PREFIX}-RA1`, orderId: oA, businessName: 'I5 A', businessAddress: '', businessId: '', taxId: '', subtotal: 100, totalVat: 22, total: 122, paymentMethod: 'cash', createdAt: glDate, printedAt: glDate, locationId: locA1 } })
  await db.receipt.create({ data: { id: `${PREFIX}rB-${RUN}`, receiptNumber: `${PREFIX}-RB1`, orderId: oB, businessName: 'I5 B', businessAddress: '', businessId: '', taxId: '', subtotal: 200, totalVat: 44, total: 244, paymentMethod: 'card', createdAt: glDate, printedAt: glDate, locationId: locB1 } })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  // v1.141.0: povrni odložene (demo) nastavitve — hermetičen test, baza ostane nespremenjena
  if (settingsStash.length) {
    await db.restaurantSettings.createMany({ data: settingsStash })
    settingsStash = []
  }
})

/* ══════════════════════ A. read-leaks ══════════════════════ */

describe('issue #5 A — read-leaks: pravice + minimalni DTO', () => {
  it('settings GET: waiter BREZ skrivnosti (minimalni DTO), admin z models — ključi skrivnosti ODSOTNI', async () => {
    const w = await status(settingsGET(req('/api/settings', tok(waiterA, 'w', 'WAITER', locA1))))
    expect(w.code).toBe(200)
    const s = w.body.settings as Record<string, unknown>
    expect(s.receiptFooter).toBe('I5 footer')
    expect(Object.keys(s)).not.toContain('fursCertPassword')
    expect(Object.keys(s)).not.toContain('emailSmtpPassword')
    expect(Object.keys(s)).not.toContain('apiKeys')
    expect(Object.keys(s)).not.toContain('cisCertPassword')
    const a = await status(settingsGET(req('/api/settings', tok(adminA, 'a', 'ADMIN', locA1))))
    expect(a.code).toBe(200)
    const sa = a.body.settings as Record<string, unknown>
    // issue #23 (v1.90.0): nastavitvena vloga vidi INDIKATOR, ne surove skrivnosti
    expect(sa.fursCertPassword).toBe('••••')
    expect(sa.emailSmtpPassword).toBe('••••')
    expect(sa.apiKeys).toBe('••••')
    expect(JSON.stringify(a.body)).not.toContain('SECRET-')
  })

  it('suppliers GET: cleaner → 403; admin → IBAN/davčna; (nabava brez inventory.manage ne vidi finančnih polj)', async () => {
    const c = await status(suppliersGET(req('/api/suppliers', tok(cleanerA, 'c', 'CLEANER', locA1))))
    expect(c.code).toBe(403)
    const a = await status(suppliersGET(req('/api/suppliers', tok(adminA, 'a', 'ADMIN', locA1))))
    expect(a.code).toBe(200)
    const sup = (a.body.suppliers as Record<string, unknown>[]).find((x) => String(x.name).includes('Doba'))
    expect(sup?.iban).toBe('SI56...')
    expect(sup?.taxId).toBe('SI999')
  })

  it('events GET: waiter → 403 (central-only); admin → 200 BREZ payload/error ključev', async () => {
    const w = await status(eventsGET(req('/api/events', tok(waiterA, 'w', 'WAITER', locA1))))
    expect(w.code).toBe(403)
    const a = await status(eventsGET(req('/api/events', tok(adminA, 'a', 'ADMIN', locA1))))
    expect(a.code).toBe(200)
    const evs = (a.body.events as Record<string, unknown>[]) ?? []
    for (const e of evs) {
      expect(Object.keys(e)).not.toContain('payload')
      expect(Object.keys(e)).not.toContain('error')
    }
  })

  it('jobs GET: waiter → 403 (permission sets so rekonivala); admin → 200', async () => {
    const w = await status(jobsGET(req('/api/jobs', tok(waiterA, 'w', 'WAITER', locA1))))
    expect(w.code).toBe(403)
    const a = await status(jobsGET(req('/api/jobs', tok(adminA, 'a', 'ADMIN', locA1))))
    expect(a.code).toBe(200)
    expect(Array.isArray(a.body.jobContexts)).toBe(true)
  })

  it('webhooks + monitoring/errors GET: waiter → 403; admin → 200', async () => {
    expect((await status(webhooksGET(req('/api/webhooks', tok(waiterA, 'w', 'WAITER', locA1))))).code).toBe(403)
    expect((await status(monitoringErrorsGET(req('/api/monitoring/errors', tok(waiterA, 'w', 'WAITER', locA1))))).code).toBe(403)
    expect((await status(webhooksGET(req('/api/webhooks', tok(adminA, 'a', 'ADMIN', locA1))))).code).toBe(200)
    expect((await status(monitoringErrorsGET(req('/api/monitoring/errors', tok(adminA, 'a', 'ADMIN', locA1))))).code).toBe(200)
  })

  it('kitchen GET: cleaner → 403 (KDS vrsta je kuhinjska); chef → 200; ?station= strežniški filter', async () => {
    expect((await status(kitchenGET(req('/api/kitchen', tok(cleanerA, 'c', 'CLEANER', locA1))))).code).toBe(403)
    const c = await status(kitchenGET(req('/api/kitchen', tok(chefA, 'c', 'KITCHEN', locA1))))
    expect(c.code).toBe(200)
    expect(Array.isArray(c.body.queue)).toBe(true)
    // strežniški filter: naročilo s fired postavko brez postaje = KITCHEN → BAR filter ga izpusti
    const bar = await status(kitchenGET(req('/api/kitchen?station=BAR', tok(chefA, 'c', 'KITCHEN', locA1))))
    expect(bar.code).toBe(200)
    const barOrders = (bar.body.queue as { items: { station: string }[] }[])
    for (const o of barOrders) {
      expect(o.items.every((it) => (it.station || 'KITCHEN') === 'BAR')).toBe(true)
    }
  })

  it('orders GET: cleaner → 403; waiter → 200 (branje domene — orders.create)', async () => {
    expect((await status(ordersGET(req('/api/orders', tok(cleanerA, 'c', 'CLEANER', locA1))))).code).toBe(403)
    expect((await status(ordersGET(req('/api/orders', tok(waiterA, 'w', 'WAITER', locA1))))).code).toBe(200)
  })

  it('reservations GET: chef → 403 (PII gostov); waiter → 200', async () => {
    expect((await status(reservationsGET(req('/api/reservations', tok(chefA, 'c', 'KITCHEN', locA1))))).code).toBe(403)
    expect((await status(reservationsGET(req('/api/reservations', tok(waiterA, 'w', 'WAITER', locA1))))).code).toBe(200)
  })

  it('guests/feedback GET: chef → 403; waiter (reservations.manage) → 200 — usklajeno s TAB_PERM.mnenja', async () => {
    expect((await status(feedbackGET(req('/api/guests/feedback', tok(chefA, 'c', 'KITCHEN', locA1))))).code).toBe(403)
    expect((await status(feedbackGET(req('/api/guests/feedback', tok(waiterA, 'w', 'WAITER', locA1))))).code).toBe(200)
  })

  it('stocktakes GET: waiter → 403; admin → 200', async () => {
    expect((await status(stocktakesGET(req('/api/stocktakes', tok(waiterA, 'w', 'WAITER', locA1))))).code).toBe(403)
    expect((await status(stocktakesGET(req('/api/stocktakes', tok(adminA, 'a', 'ADMIN', locA1))))).code).toBe(200)
  })

  it('inventory GET: cost/supplierId STRIPPED za waiter (operativni DTO), admin vidi ceno', async () => {
    const w = await status(inventoryGET(req('/api/inventory', tok(waiterA, 'w', 'WAITER', locA1))))
    expect(w.code).toBe(200)
    const moka = (w.body.inventory as Record<string, unknown>[]).find((x) => String(x.name).includes('Moka'))
    expect(moka).toBeDefined()
    expect(moka?.cost).toBe(0)
    expect(moka?.supplierId).toBeNull()
    const a = await status(inventoryGET(req('/api/inventory', tok(adminA, 'a', 'ADMIN', locA1))))
    const mokaA = (a.body.inventory as Record<string, unknown>[]).find((x) => String(x.name).includes('Moka'))
    expect(Number(mokaA?.cost)).toBeGreaterThan(0)
  })

  it('purchase-orders GET: waiter → 403 (nabava = inventory.manage)', async () => {
    expect((await status(purchaseOrdersGET(req('/api/purchase-orders', tok(waiterA, 'w', 'WAITER', locA1))))).code).toBe(403)
  })
})

/* ══════════════════════ B. org-scope ══════════════════════ */

describe('issue #5 B — org-scope: centralne vloge vidijo SAMO svojo organizacijo', () => {
  it('locations/stats: admin orgA NE vidi lokacije orgB (prej ročni bypass {} = vse)', async () => {
    const a = await status(locationsStatsGET(req('/api/locations/stats', tok(adminA, 'a', 'ADMIN', locA1))))
    expect(a.code).toBe(200)
    const ids = (a.body.stats as { id: string }[]).map((s) => s.id)
    expect(ids).toContain(locA1)
    expect(ids).not.toContain(locB1)
  })

  it('locations GET: admin orgA NE vidi imenika orgB', async () => {
    const a = await status(locationsGET(req('/api/locations', tok(adminA, 'a', 'ADMIN', locA1))))
    expect(a.code).toBe(200)
    const ids = (a.body.locations as { id: string }[]).map((l) => l.id)
    expect(ids).not.toContain(locB1)
  })

  it('dashboard: ?locationId TUJE org → 403 (assertOrgScope); waiter BREZ finančnih KPI', async () => {
    const foreign = await status(dashboardGET(req(`/api/dashboard?locationId=${locB1}`, tok(adminA, 'a', 'ADMIN', locA1))))
    expect(foreign.code).toBe(403)
    const w = await status(dashboardGET(req('/api/dashboard', tok(waiterA, 'w', 'WAITER', locA1))))
    expect(w.code).toBe(200)
    const stats = w.body.stats as Record<string, unknown>
    expect(stats.financialPerm).toBe(false)
    expect(Number(stats.todayRevenue)).toBe(0)
    const a = await status(dashboardGET(req(`/api/dashboard?locationId=${locA1}`, tok(adminA, 'a', 'ADMIN', locA1))))
    expect(a.code).toBe(200)
    expect((a.body.stats as Record<string, unknown>).financialPerm).toBe(true)
  })

  it('tips GET: non-central IGNORIRA tuji locationId param (vedno svoja); centralna s tujim → 403', async () => {
    const m = await status(tipsGET(req(`/api/tips?locationId=${locB1}`, tok(managerA, 'm', 'MANAGER', locA1))))
    expect(m.code).toBe(200)
    const a = await status(tipsGET(req(`/api/tips?locationId=${locB1}`, tok(adminA, 'a', 'ADMIN', locA1))))
    expect(a.code).toBe(403)
  })

  it('GL entryNumber: enaka obseg → isti ključ (idempotenca); TUJA org → DRUG zapis istega dne', async () => {
    // unit: scope key je del številke
    expect(glEntryNumber(DAY, '*')).toBe(`GL-${DAY.replaceAll('-', '')}-01`)
    expect(glEntryNumber(DAY, 'aabbccdd')).toBe(`GL-${DAY.replaceAll('-', '')}-aabbccdd-01`)
    expect(glEntryNumber(DAY, 'aabbccdd')).toBe(glEntryNumber(DAY, 'aabbccdd'))
    expect(glEntryNumber(DAY, '11223344')).not.toBe(glEntryNumber(DAY, 'aabbccdd'))
    // route: admin A in admin B istega dne dobita LOČENA persistirana vnosa
    const from = DAY
    const to = DAY
    const a = await status(glGET(req(`/api/reports/gl?from=${from}&to=${to}`, tok(adminA, 'a', 'ADMIN', locA1))))
    expect(a.code).toBe(200)
    const b = await status(glGET(req(`/api/reports/gl?from=${from}&to=${to}`, tok(adminB, 'b', 'ADMIN', locB1))))
    expect(b.code).toBe(200)
    const entriesA = a.body.entries as { entryNo: string; persisted: boolean; debit: number }[]
    const entriesB = b.body.entries as { entryNo: string; persisted: boolean; debit: number }[]
    expect(entriesA.length).toBe(1)
    expect(entriesB.length).toBe(1)
    expect(entriesA[0].entryNo).not.toBe(entriesB[0].entryNo)
    // A: 122 € blagajna; B: 244 € — vsak vidi SAMO svoje
    expect(Math.round(entriesA[0].debit)).toBe(122)
    expect(Math.round(entriesB[0].debit)).toBe(244)
  })
})

/* ══════════════════════ C. write-gaps ══════════════════════ */

describe('issue #5 C — write-gaps: pravice na PISANJE', () => {
  it('shifts POST: waiter → 403 (cash.manage; prej requireAuth — vsak je lahko odprl izmeno)', async () => {
    const w = await status(shiftsPOST(req('/api/shifts', tok(waiterA, 'w', 'WAITER', locA1), 'POST', { openingCash: 100 })))
    expect(w.code).toBe(403)
  })

  it('haccp GET: chef (haccp.execute) → 200 (prej settings.manage je kuharja zaklenil ven); waiter → 403', async () => {
    const c = await status(haccpGET(req('/api/haccp', tok(chefA, 'c', 'KITCHEN', locA1))))
    expect(c.code).toBe(200)
    expect((await status(haccpGET(req('/api/haccp', tok(waiterA, 'w', 'WAITER', locA1))))).code).toBe(403)
  })

  it('haccp POST: chef → 201 (izvedba kontrole); waiter → 403 (prej requireAuth — natakar je lahko vnašal!)', async () => {
    const c = await status(haccpPOST(req('/api/haccp', tok(chefA, 'c', 'KITCHEN', locA1), 'POST', { type: 'temperature', target: 'Hladilnik 1', value: 4, ok: true })))
    expect(c.code).toBe(201)
    const w = await status(haccpPOST(req('/api/haccp', tok(waiterA, 'w', 'WAITER', locA1), 'POST', { type: 'temperature', target: 'X', ok: true })))
    expect(w.code).toBe(403)
  })

  it('orders PATCH {note}: chef (brez orders.create) → 403 (prej requireAuth — vsak je lahko spreminjal opombe)', async () => {
    const res = await status(orderPATCH(req(`/api/orders/${orderVoid}`, tok(chefA, 'c', 'KITCHEN', locA1), 'PATCH', { note: 'hack' }), { params: Promise.resolve({ id: orderVoid }) } as never))
    expect(res.code).toBe(403)
  })

  it('discounts POST: waiter (apply_discounts) → 403 — katalog = discounts.manage; admin → 201', async () => {
    const w = await status(discountsPOST(req('/api/discounts', tok(waiterA, 'w', 'WAITER', locA1), 'POST', { name: 'I5 happy', type: 'percent', amount: 10 })))
    expect(w.code).toBe(403)
    const a = await status(discountsPOST(req('/api/discounts', tok(adminA, 'a', 'ADMIN', locA1), 'POST', { name: `I5 popust ${RUN}`, type: 'percent', amount: 10 })))
    expect(a.code).toBe(201)
  })

  it('discounts/[id] PATCH: admin orgA na popustu orgB → 403 (location/org guard na vir — prej mankal)', async () => {
    const res = await status(discountPATCH(req(`/api/discounts/${discountB}`, tok(adminA, 'a', 'ADMIN', locA1), 'PATCH', { amount: 50 }), { params: Promise.resolve({ id: discountB }) } as never))
    expect(res.code).toBe(403)
  })

  it('employees POST: MANAGER ustvari OWNER → 403 (privilegirana vloga = samo centralna); PIN "abc" → 400', async () => {
    const esc = await status(employeesPOST(req('/api/employees', tok(managerA, 'm', 'MANAGER', locA1), 'POST', { name: 'I5 uzurpator', email: `${PREFIX}-esc@t.local`, pin: '1234', role: 'OWNER' })))
    expect(esc.code).toBe(403)
    const badPin = await status(employeesPOST(req('/api/employees', tok(adminA, 'a', 'ADMIN', locA1), 'POST', { name: 'I5 pin', email: `${PREFIX}-pin@t.local`, pin: 'abc', role: 'WAITER' })))
    expect(badPin.code).toBe(400)
  })

  it('employees PATCH: sprememba vloge ODPOVE staro sejo TAKOJ (sessionVersion bump → 401)', async () => {
    const id = await seedEmployee('demoted', 'manager', locA1, 7)
    const oldToken = createToken({ sub: id, name: 'd', role: 'MANAGER', loc: locA1, sv: 0 })
    const res = await status(employeePATCH(req(`/api/employees/${id}`, tok(adminA, 'a', 'ADMIN', locA1), 'PATCH', { role: 'WAITER' }), { params: Promise.resolve({ id }) } as never))
    expect(res.code).toBe(200)
    // stara seja (sv:0) — sessionVersion v DB je zdaj 1 → requireAuth 401
    const after = await status(ordersGET(req('/api/orders', oldToken)))
    expect(after.code).toBe(401)
  })

  it('tables PATCH: waiter posX (tloris) → 403 (menu.manage); status ostaja orders.create', async () => {
    const floor = await status(tablePATCH(req(`/api/tables/${tableA}`, tok(waiterA, 'w', 'WAITER', locA1), 'PATCH', { posX: 999 }), { params: Promise.resolve({ id: tableA }) } as never))
    expect(floor.code).toBe(403)
  })

  it('staff-shifts GET: waiter vidi SAMO svoje izmene; manager (timeclock.manage) vidi ekipo', async () => {
    const today = new Date().toISOString().slice(0, 10)
    await db.staffShift.create({
      data: { id: `${PREFIX}-ss1-${RUN}`, employeeId: waiterA, shiftDate: new Date(`${today}T00:00:00`), shiftType: 'full', startTime: '08:00', endTime: '16:00', role: 'waiter', locationId: locA1, status: 'scheduled', createdById: adminA },
    })
    await db.staffShift.create({
      data: { id: `${PREFIX}-ss2-${RUN}`, employeeId: chefA, shiftDate: new Date(`${today}T00:00:00`), shiftType: 'full', startTime: '10:00', endTime: '18:00', role: 'chef', locationId: locA1, status: 'scheduled', createdById: adminA },
    })
    const w = await status(staffShiftsGET(req(`/api/staff-shifts?from=${today}`, tok(waiterA, 'w', 'WAITER', locA1))))
    expect(w.code).toBe(200)
    const ownIds = (w.body.shifts as { employeeId: string }[]).map((s) => s.employeeId)
    expect(new Set(ownIds)).toEqual(new Set([waiterA]))
    const m = await status(staffShiftsGET(req(`/api/staff-shifts?from=${today}`, tok(managerA, 'm', 'MANAGER', locA1))))
    const teamIds = (m.body.shifts as { employeeId: string }[]).map((s) => s.employeeId)
    expect(teamIds.length).toBeGreaterThanOrEqual(2)
  })

  it('staff-shifts POST: jobId se ZAPIŠE (prej mrtev stolpec), neveljaven jobId se tiho izpusti', async () => {
    const job = (await db.job.create({ data: { id: `${PREFIX}job-${RUN}`, name: `I5 delovno mesto ${RUN}`, isActive: true, sortOrder: 1 } })).id
    const today = new Date().toISOString().slice(0, 10)
    const p = await status(staffShiftsPOST(req('/api/staff-shifts', tok(managerA, 'm', 'MANAGER', locA1), 'POST', { employeeId: chefA, shiftDate: today, startTime: '12:00', endTime: '20:00', jobId: job })))
    expect(p.code).toBe(200) // ruta vrača ok() = 200
    const created = await db.staffShift.findFirst({ where: { id: (p.body.shift as { id: string }).id } })
    expect(created?.jobId).toBe(job)
  })
})

/* ══════════════════════ D. void posamezne postavke ══════════════════════ */

describe('issue #5 D — preklic posamezne postavke (orders.void + razlog)', () => {
  it('voidReasons GET: admin → 200 s katalogom; waiter → 403', async () => {
    const a = await status(voidReasonsGET(req('/api/void-reasons', tok(adminA, 'a', 'ADMIN', locA1))))
    expect(a.code).toBe(200)
    const reasons = a.body.voidReasons as { id: string; name: string }[]
    expect(reasons.some((r) => r.id === voidReasonA)).toBe(true)
    expect((await status(voidReasonsGET(req('/api/void-reasons', tok(waiterA, 'w', 'WAITER', locA1))))).code).toBe(403)
  })

  it('void: waiter (brez orders.void) → 403', async () => {
    const res = await status(orderVoidPOST(req(`/api/orders/${orderVoid}/void`, tok(waiterA, 'w', 'WAITER', locA1), 'POST', { itemId: item2, reasonId: voidReasonA }), { params: Promise.resolve({ id: orderVoid }) } as never))
    expect(res.code).toBe(403)
  })

  it('void: BREZ razloga → 400 (razlog je obvezen)', async () => {
    const res = await status(orderVoidPOST(req(`/api/orders/${orderVoid}/void`, tok(adminA, 'a', 'ADMIN', locA1), 'POST', { itemId: item2 }), { params: Promise.resolve({ id: orderVoid }) } as never))
    expect(res.code).toBe(400)
  })

  it('void: PLAČANO naročilo → 409 (fiskalni storno je ločena pot)', async () => {
    const paid = await seedOrder(locA1, 'paid', 'paid')
    const pi = (await db.orderItem.create({ data: { id: `${PREFIX}-paidit-${RUN}`, orderId: paid, menuItemId: miI5, menuItemName: 'X', quantity: 1, price: 5, status: 'served' } })).id
    const res = await status(orderVoidPOST(req(`/api/orders/${paid}/void`, tok(adminA, 'a', 'ADMIN', locA1), 'POST', { itemId: pi, reasonId: voidReasonA }), { params: Promise.resolve({ id: paid }) } as never))
    expect(res.code).toBe(409)
  })

  it('void happy path: manager → 200, postavka voided + voidReasonId, znesek naročila se PRERAČUNA, audit + KDS filter', async () => {
    const before = await db.order.findUnique({ where: { id: orderVoid } })
    expect(Number(before?.total)).toBeGreaterThan(20) // 2×10 + 5 + DDV
    const res = await status(orderVoidPOST(req(`/api/orders/${orderVoid}/void`, tok(managerA, 'm', 'MANAGER', locA1), 'POST', { itemId: item2, reasonId: voidReasonA }), { params: Promise.resolve({ id: orderVoid }) } as never))
    expect(res.code).toBe(200)
    expect(res.body.voided).toBeDefined()
    expect((res.body.voided as { reason: string }).reason).toBe('I5 razlog')
    const it = await db.orderItem.findUnique({ where: { id: item2 } })
    expect(it?.voided).toBe(true)
    expect(it?.voidReasonId).toBe(voidReasonA)
    const after = await db.order.findUnique({ where: { id: orderVoid } })
    expect(Number(after?.total)).toBeLessThan(Number(before?.total))
    // audit sled
    const audit = await db.auditLog.count({ where: { action: 'ORDER_ITEM_VOID', entityId: item2 } })
    expect(audit).toBe(1)
    // KDS vrsta: voided postavka IZGINE (kuhinja vidi samo item1)
    const k = await status(kitchenGET(req('/api/kitchen', tok(chefA, 'c', 'KITCHEN', locA1))))
    const q = k.body.queue as { id: string; items: { id: string }[] }[]
    const myOrder = q.find((o) => o.id === orderVoid)
    expect(myOrder).toBeDefined()
    expect(myOrder!.items.map((i) => i.id)).toEqual([item1])
  })

  it('void: podvojen klik → 409 (CAS, brez drugega audita)', async () => {
    const auditsBefore = await db.auditLog.count({ where: { action: 'ORDER_ITEM_VOID' } })
    const res = await status(orderVoidPOST(req(`/api/orders/${orderVoid}/void`, tok(adminA, 'a', 'ADMIN', locA1), 'POST', { itemId: item2, reasonId: voidReasonA }), { params: Promise.resolve({ id: orderVoid }) } as never))
    expect(res.code).toBe(409)
    expect(await db.auditLog.count({ where: { action: 'ORDER_ITEM_VOID' } })).toBe(auditsBefore)
  })

  it('void: prosta beseda (brez kataloga) — razlog ≥ 3 znaki → 200, shranjen v audit sledi', async () => {
    const o = await seedOrder(locA1, 'open', 'unpaid')
    const it = (await db.orderItem.create({ data: { id: `${PREFIX}-txtit-${RUN}`, orderId: o, menuItemId: miI5, menuItemName: 'Txt', quantity: 1, price: 3, status: 'pending' } })).id
    const short = await status(orderVoidPOST(req(`/api/orders/${o}/void`, tok(adminA, 'a', 'ADMIN', locA1), 'POST', { itemId: it, reason: 'ab' }), { params: Promise.resolve({ id: o }) } as never))
    expect(short.code).toBe(400)
    const ok = await status(orderVoidPOST(req(`/api/orders/${o}/void`, tok(adminA, 'a', 'ADMIN', locA1), 'POST', { itemId: it, reason: 'kuhinja je zavrnila' }), { params: Promise.resolve({ id: o }) } as never))
    expect(ok.code).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_ITEM_VOID', entityId: it } })
    expect(String(audit?.details)).toContain('kuhinja je zavrnila')
  })
})

/* ══════════════════════ E. landingTab (P1-A) ══════════════════════ */

describe('issue #5 E — landingTab: pristajalni zavihek po vlogi', () => {
  it('kuhinja → kuhinja (KDS); šank → prodaja (hitra prodaja); natakar → mize', () => {
    expect(landingTab('KITCHEN', ['kitchen.update'])).toEqual({ tab: 'kuhinja' })
    expect(landingTab('CHEF', ['kitchen.update', 'haccp.execute'])).toEqual({ tab: 'kuhinja' })
    expect(landingTab('BAR', ['orders.pay', 'kitchen.update'])).toEqual({ tab: 'prodaja' })
    expect(landingTab('WAITER', ['orders.create'])).toEqual({ tab: 'mize' })
  })
  it('čistilka → haccp (haccp.execute) ali delovnica; centralne vloge + manager → pregled', () => {
    expect(landingTab('CLEANER', ['haccp.execute'])).toEqual({ tab: 'haccp' })
    expect(landingTab('CLEANER', [])).toEqual({ tab: 'delovnicas' })
    expect(landingTab('OWNER', [])).toEqual({ tab: 'pregled' })
    expect(landingTab('ADMIN', [])).toEqual({ tab: 'pregled' })
    expect(landingTab('MANAGER', [])).toEqual({ tab: 'pregled' })
  })
  it('enterprise: warehouse → zaloge; accounting → racuni; BAR brez orders.pay pade na mize (perms > vloga)', () => {
    expect(landingTab('WAREHOUSE', ['inventory.manage'])).toEqual({ tab: 'zaloge' })
    expect(landingTab('ACCOUNTING', ['reports.sales'])).toEqual({ tab: 'racuni' }) // issue #72 D3
    expect(landingTab('BAR', [])).toEqual({ tab: 'mize' })
  })
})
