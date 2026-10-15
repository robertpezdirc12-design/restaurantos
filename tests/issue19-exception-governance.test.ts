/**
 * Issue #19 (P1/P2, v1.107.0) — razlogi in vodstvena odobritev finančnih izjem.
 *
 * pokritost:
 *  A. Politika (exception-policy): privzetki (graceful pre-DDL), pisanje prek
 *     PUT /api/settings (settings.manage), GET odmev + audit spremembe, meje.
 *  B. validateExceptionReason: katalog kind (discount/cancel/storno/void/any),
 *     aktivnost, lokacija dejanja, »Drugo«/requireComment → obvezen komentar,
 *     prosta besedila 3–200.
 *  C. Popust POST: register pod pragom brez razloga (konfigurirana promocija);
 *     nad pragom brez odobritelja 403; izvajalec kot odobritelj 403 (LOČENA
 *     oseba!); veljaven drugi vodja (e-pošta+PIN) 200 + audit odobritelj/metoda
 *     pin (BREZ PIN-a v auditu); ad-hoc VEDNO razlog; vodstveni izvajalec =
 *     odobritev 'role'; politika excRequireReasonDiscount.
 *  D. Popust DELETE: obvezen razlog (izjema) + audit posnetek.
 *  E. Preklic postavke: prag excVoidApprovalAmountCents + odobritev prek
 *     permission override (orders.void natakarju) — poverilnica druge osebe.
 *  F. Preklic naročila (PATCH CANCELLED + DELETE): obvezen razlog + audit.
 *  G. Fiskalni storno: obvezen razlog + audit posnetek.
 *  H. Katalog razlogov CRUD (void-reasons): GET kind filter, POST/PATCH/DELETE
 *     (settings.manage), tuja lokacija 403, brisanje v uporabi 409.
 *  I. Varnost odobritelja: napačen PIN, neaktiven, tuja lokacija, ne-vodstvena
 *     vloga — vsi 403; audit ne vsebuje poverilnic.
 *  J. Poročilo /api/reports/exceptions: tenant obseg, vrste/agregati, en dogodek
 *     na akcijo (brez dvojnega štetja), CSV (BOM), dovoljenje reports.view.
 *  K. GET /api/exception-policy: politika + isManagerial (brez skrivnosti).
 *
 * Fiksture s predpono i19-. Politika (RestaurantSettings) se SHRANI/povrne —
 * deljena singleton vrstica (vzorec issue18 tolerance testa 7).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  exceptionPolicy, DEFAULT_EXCEPTION_POLICY, writeExceptionPolicy,
  resetExceptionPolicyProbe,
} from '../src/lib/exception-policy'
import {
  resetReasonKindProbe, validateExceptionReason, reasonKindColumnAvailable,
} from '../src/lib/exception-approval'
import { POST as discountPOST, DELETE as discountDELETE } from '../src/app/api/orders/[id]/discount/route'
import { POST as voidPOST } from '../src/app/api/orders/[id]/void/route'
import { PATCH as orderPATCH, DELETE as orderDELETE } from '../src/app/api/orders/[id]/route'
import { POST as stornoPOST } from '../src/app/api/receipts/[id]/storno/route'
import { GET as reasonsGET, POST as reasonsPOST, PATCH as reasonsPATCH, DELETE as reasonsDELETE } from '../src/app/api/void-reasons/route'
import { GET as exceptionsGET } from '../src/app/api/reports/exceptions/route'
import { GET as policyGET } from '../src/app/api/exception-policy/route'
import { PUT as settingsPUT } from '../src/app/api/settings/route'
import { jstr } from '../src/lib/map'

const P = 'i19-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let locB = ''
let miA = ''
let mgrAId = ''
let mgrA2Id = '' // DRUGI vodja lokacije A (ločena oseba za odobritev)
let mgrBId = ''
let waiterAId = ''
let voidWaiterAId = '' // natakar z override orders.void (E)
let tokMgrA = ''
let tokMgrA2 = ''
let tokMgrB = ''
let tokWaiterA = ''
let tokVoidWaiterA = ''
let pinMgrA2 = ''
let pinMgrB = ''
let pinWaiterA = ''
let pinVoidWaiterA = ''

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

interface SeedEmpOpts { role?: string; loc?: string | null; overrides?: string[]; name: string }
async function seedEmployee(o: SeedEmpOpts): Promise<{ id: string; pin: string }> {
  const id = `${P}${o.name}-${RUN}`
  const email = `${P}${o.name}-${RUN}@test.local`
  // naključen 6-mestni PIN (pinLookup je UNIQUE — deterministične vrednosti trčijo)
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const f = employeePinFields(pin, email)
  await db.employee.create({
    data: {
      id, name: `${P}${o.name}`, email,
      role: o.role ?? 'manager', status: 'active', sessionVersion: 0,
      locationId: o.loc ?? null,
      pin: f.pin, pinLookup: f.pinLookup,
      permissionOverrides: o.overrides ? jstr(o.overrides) : '[]',
    },
  })
  return { id, pin }
}

let ordSeq = 0
async function seedOrder(loc: string, opts: { paymentStatus?: string; item?: { qty: number; price: number } } = {}) {
  const id = `${P}o${++ordSeq}-${RUN}`
  await db.order.create({
    data: {
      id, orderNumber: 47100 + ordSeq, locationId: loc, tableId: null,
      status: 'open', paymentStatus: opts.paymentStatus ?? 'unpaid',
      subtotal: 5, tax: 1.1, total: 6.1,
    },
  })
  const item = opts.item ?? { qty: 1, price: 5 }
  const itemId = `${P}itm${ordSeq}-${RUN}`
  await db.orderItem.create({
    data: {
      id: itemId, orderId: id, menuItemId: miA,
      quantity: item.qty, price: item.price, vatRate: 22, vatAmount: 1.1,
      menuItemName: `${P}Jed`, status: 'pending', voided: false,
    },
  })
  return { id, itemId }
}

async function seedDiscount(overrides: Record<string, unknown> = {}) {
  const id = `${P}disc${++ordSeq}-${RUN}`
  await db.discount.create({
    data: {
      id, name: `${P}Popust ${ordSeq}`, type: 'percent', amount: 10,
      isActive: true, locationId: locA, triggerType: 'manual',
      maxUses: null, currentUses: 0, ...overrides,
    },
  })
  return id
}

/** Katalog razlog z kind (raw — stolpca sta mirror/DDL only). */
async function seedReason(name: string, kind: string, opts: { requireComment?: boolean; isActive?: boolean; loc?: string } = {}) {
  const id = `${P}vr-${name}-${RUN}`
  await db.voidReason.create({
    data: { id, name: `${P}${name}`, isActive: opts.isActive ?? true, sortOrder: 0, locationId: opts.loc ?? locA },
  })
  await db.$executeRaw`UPDATE "VoidReason" SET "kind" = ${kind}, "requireComment" = ${opts.requireComment ? 1 : 0} WHERE "id" = ${id}`
  return id
}

let reasonSeq = 0
/** Plačano naročilo + originalni račun (vzorec zreport-storno). */
async function seedPaidOrderWithReceipt(total: number) {
  const orderId = `${P}paid${++reasonSeq}-${RUN}`
  await db.order.create({
    data: {
      id: orderId, orderNumber: 48100 + reasonSeq, status: 'paid', paymentStatus: 'paid',
      paymentMethod: 'cash', subtotal: total, tax: 0, discount: 0, tip: 0,
      total, totalWithTip: total, paidAt: new Date(), locationId: locA, splitCount: 1,
    },
  })
  const receiptId = `${P}rcpt${reasonSeq}-${RUN}`
  await db.receipt.create({
    data: {
      id: receiptId, receiptNumber: `2026-10-${48100 + reasonSeq}-BLGI19`,
      orderId, businessName: `${P} lokacija`, businessAddress: 'Testna cesta 1',
      businessId: '12345678', taxId: 'SI12345678', registerId: 'BLG-001',
      total, totalVat: 0, subtotal: total,
      vatBreakdown: JSON.stringify({ '22.00': { base: total, vat: 0 } }),
      paymentMethod: 'cash', isStorno: false, locationId: locA,
    },
  })
  return { orderId, receiptId }
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

let settingsExistedBefore = false

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  resetExceptionPolicyProbe()
  resetReasonKindProbe()
  locA = `${P}locA-${RUN}`
  locB = `${P}locB-${RUN}`
  await db.location.create({ data: { id: locA, code: `${P}LA`, name: `${P}Lokacija A`, premisesId: `${P}premA-${RUN}` } })
  await db.location.create({ data: { id: locB, code: `${P}LB`, name: `${P}Lokacija B`, premisesId: `${P}premB-${RUN}` } })
  const menuA = await db.menu.create({ data: { id: `${P}menuA-${RUN}`, name: `${P}Meni A`, locationId: locA } })
  const catA = await db.category.create({ data: { id: `${P}catA-${RUN}`, name: `${P}Kat A`, menuId: menuA.id } })
  miA = (await db.menuItem.create({ data: { id: `${P}miA-${RUN}`, name: `${P}Jed A`, price: 5, categoryId: catA.id } })).id

  const mgrA = await seedEmployee({ name: 'mgrA', loc: locA })
  const mgrA2 = await seedEmployee({ name: 'mgrA2', loc: locA })
  const mgrB = await seedEmployee({ name: 'mgrB', loc: locB })
  const waiterA = await seedEmployee({ name: 'waiterA', role: 'waiter', loc: locA })
  const voidWaiterA = await seedEmployee({ name: 'voidWaiterA', role: 'waiter', loc: locA, overrides: ['orders.void'] })
  mgrAId = mgrA.id; mgrA2Id = mgrA2.id; mgrBId = mgrB.id; waiterAId = waiterA.id; voidWaiterAId = voidWaiterA.id
  pinMgrA2 = mgrA2.pin; pinMgrB = mgrB.pin; pinWaiterA = waiterA.pin; pinVoidWaiterA = voidWaiterA.pin
  tokMgrA = tok(mgrAId, `${P}mgrA`, 'MANAGER', locA)
  tokMgrA2 = tok(mgrA2Id, `${P}mgrA2`, 'MANAGER', locA)
  tokMgrB = tok(mgrBId, `${P}mgrB`, 'MANAGER', locB)
  tokWaiterA = tok(waiterAId, `${P}waiterA`, 'WAITER', locA)
  tokVoidWaiterA = tok(voidWaiterAId, `${P}voidWaiterA`, 'WAITER', locA)

  // singleton nastavitve — obstoječe stanje si zapomni (politika se testira in povrne)
  settingsExistedBefore = !!(await db.restaurantSettings.findFirst())
})

afterAll(async () => {
  // politiko povrni na privzetke (0 pragov) + singleton če prej ni obstajal
  await writeExceptionPolicy({
    excDiscountApprovalAmountCents: 0, excVoidApprovalAmountCents: 0,
    excStornoApprovalAmountCents: 0, excCancelApprovalAmountCents: 0,
    excDiscountApprovalPct: 15,
    excRequireReasonDiscount: false,
  }).catch(() => null)
  if (!settingsExistedBefore) {
    await db.restaurantSettings.deleteMany({}).catch(() => null)
  }
  resetExceptionPolicyProbe()
  resetReasonKindProbe()
  await sweepTestFixtures(db, [P])
})

/* ───────── A. politika ───────── */

describe('A. politika finančnih izjem (exception-policy)', () => {
  it('A1. privzetki: 15 % prag, zneskovni pragovi izklopljeni, razlog za preklic/storno/void obvezen', async () => {
    resetExceptionPolicyProbe(true) // DDL prisoten, vrstica brez vrednosti → privzetki
    const p = await exceptionPolicy()
    expect(p.discountApprovalPct).toBe(15)
    expect(p.discountApprovalAmountCents).toBe(0)
    expect(p.voidApprovalAmountCents).toBe(0)
    expect(p.stornoApprovalAmountCents).toBe(0)
    expect(p.cancelApprovalAmountCents).toBe(0)
    expect(p.requireReasonDiscount).toBe(false)
    expect(p.requireReasonCancel).toBe(true)
    expect(p.requireReasonStorno).toBe(true)
    expect(p.requireReasonVoid).toBe(true)
    resetExceptionPolicyProbe()
  })

  it('A2. pre-DDL: pisanje vrne napako (503 sporočilo), branje varni privzetki', async () => {
    const keep = await reasonKindColumnAvailable()
    void keep
    resetExceptionPolicyProbe(false)
    const err = await writeExceptionPolicy({ excVoidApprovalAmountCents: 500 })
    expect(err).toBeTruthy()
    expect(String(err)).toContain('DDL')
    const p = await exceptionPolicy()
    expect(p).toEqual(DEFAULT_EXCEPTION_POLICY)
    resetExceptionPolicyProbe()
  })

  it('A3. PUT /api/settings zaposli politiko (settings.manage); GET odmeva politiko; audit zapiše spremenjene ključe', async () => {
    // singleton (če še ne obstaja) — writeExceptionPolicy je UPDATE
    if (!(await db.restaurantSettings.findFirst())) {
      await db.restaurantSettings.create({ data: { id: `${P}settings-${RUN}` } })
    }
    resetExceptionPolicyProbe(true)
    const res = await settingsPUT(req('PUT', '/api/settings', tokMgrA, { excVoidApprovalAmountCents: 1234, excRequireReasonDiscount: true }))
    expect(res.status).toBe(200)
    const b = await body(res)
    const pol = (b.exceptionPolicy ?? {}) as Record<string, unknown>
    expect(Number(pol.voidApprovalAmountCents)).toBe(1234)
    expect(pol.requireReasonDiscount).toBe(true)
    const audit = await db.auditLog.findFirst({
      where: { action: 'SETTINGS_UPDATE', details: { contains: 'excVoidApprovalAmountCents' } },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).toBeTruthy()
    // povrni (politika je deljena — ne zastrupi ostalih testov)
    await settingsPUT(req('PUT', '/api/settings', tokMgrA, { excVoidApprovalAmountCents: 0, excRequireReasonDiscount: false }))
    resetExceptionPolicyProbe()
  })

  it('A4. meje: negativen prag zavrnjen', async () => {
    resetExceptionPolicyProbe(true)
    const err = await writeExceptionPolicy({ excDiscountApprovalPct: -5 })
    expect(err).toBeTruthy()
    resetExceptionPolicyProbe()
  })
})

/* ───────── B. validacija razloga ───────── */

describe('B. validateExceptionReason (katalog kind + komentar)', () => {
  it('B1. katalog kind=discount veljaven → posnetek imena', async () => {
    const id = await seedReason('Gost nezadovoljen', 'discount')
    const r = await validateExceptionReason('discount', locA, { reasonId: id })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.reason.reasonId).toBe(id)
      expect(r.reason.reasonName).toContain('Gost nezadovoljen')
    }
  })

  it('B2. vrsta se ne ujema: void razlog za storno → 400', async () => {
    const id = await seedReason('Napaka pri naročilu', 'void')
    const r = await validateExceptionReason('storno', locA, { reasonId: id })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it('B3. neaktiven razlog → 400; tuja lokacija → 400', async () => {
    const inactive = await seedReason('Neaktiven', 'discount', { isActive: false })
    const r1 = await validateExceptionReason('discount', locA, { reasonId: inactive })
    expect(r1.ok).toBe(false)
    const foreign = await seedReason('Tuj', 'discount', { loc: locB })
    const r2 = await validateExceptionReason('discount', locA, { reasonId: foreign })
    expect(r2.ok).toBe(false)
  })

  it('B4. »Drugo« zahteva obvezen komentar', async () => {
    const other = await seedReason('Drugo', 'discount')
    const r1 = await validateExceptionReason('discount', locA, { reasonId: other })
    expect(r1.ok).toBe(false)
    const r2 = await validateExceptionReason('discount', locA, { reasonId: other, comment: 'gost je odšel pred serviranjem' })
    expect(r2.ok).toBe(true)
  })

  it('B5. requireComment vrstica zahteva komentar', async () => {
    const rc = await seedReason('Poslovna kompenzacija', 'discount', { requireComment: true })
    const r1 = await validateExceptionReason('discount', locA, { reasonId: rc })
    expect(r1.ok).toBe(false)
    const r2 = await validateExceptionReason('discount', locA, { reasonId: rc, comment: 'dogovor z direktorjem' })
    expect(r2.ok).toBe(true)
  })

  it('B6. kind=any velja za VSE vrste; prosta besedila 3–200', async () => {
    const any1 = await seedReason('Splošen razlog', 'any')
    for (const kind of ['discount', 'cancel', 'storno', 'void'] as const) {
      const r = await validateExceptionReason(kind, locA, { reasonId: any1 })
      expect(r.ok).toBe(true)
    }
    const r2 = await validateExceptionReason('discount', locA, { reason: 'kakovost hrane' })
    expect(r2.ok).toBe(true)
    const r3 = await validateExceptionReason('discount', locA, { reason: 'ab' })
    expect(r3.ok).toBe(false)
  })
})

/* ───────── C. popust POST — razlog + odobritev ───────── */

describe('C. popust POST: prag, razlog, LOČENA oseba odobritelja', () => {
  it('C1. register popust 10 % natakarja pod pragom → 200 brez razloga (konfigurirana promocija)', async () => {
    const disc = await seedDiscount({ amount: 10 })
    const { id } = await seedOrder(locA)
    const res = await discountPOST(req('POST', `/api/orders/${id}/discount`, tokWaiterA, { discountId: disc }), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)
  })

  it('C2. register popust 20 % natakarja BREZ odobritelja → 403 (prag 15 %)', async () => {
    const disc = await seedDiscount({ amount: 20 })
    const { id } = await seedOrder(locA)
    const res = await discountPOST(req('POST', `/api/orders/${id}/discount`, tokWaiterA, { discountId: disc }), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(403)
    expect((await body(res)).error).toContain('odobritev')
    expect(Number((await db.order.findUnique({ where: { id } }))?.discount)).toBe(0)
  })

  it('C3. izvajalec kot odobritelj (ISTE poverilnice) → 403 — vnos role=MANAGER na istem klicu ne šteje', async () => {
    const disc = await seedDiscount({ amount: 20 })
    const { id } = await seedOrder(locA)
    // natakar vpiše SEBE kot odobritelja (e-pošta + PIN istega računa)
    const res = await discountPOST(
      req('POST', `/api/orders/${id}/discount`, tokWaiterA, {
        discountId: disc,
        reason: 'nezadovoljstvo gosta',
        approverEmail: `${P}waiterA-${RUN}@test.local`,
        approverPin: pinWaiterA,
      }),
      { params: Promise.resolve({ id }) },
    )
    expect(res.status).toBe(403)
    expect((await body(res)).error).toContain('druga oseba')
    expect(Number((await db.order.findUnique({ where: { id } }))?.discount)).toBe(0)
  })

  it('C4. veljaven DRUGI vodja (e-pošta+PIN) → 200; audit: approverId/name + method pin + razlog; BREZ PIN-a', async () => {
    const disc = await seedDiscount({ amount: 20 })
    const { id } = await seedOrder(locA)
    const res = await discountPOST(
      req('POST', `/api/orders/${id}/discount`, tokWaiterA, {
        discountId: disc,
        reason: 'gost nezadovoljen s postrežbo',
        approverEmail: `${P}mgrA2-${RUN}@test.local`,
        approverPin: pinMgrA2,
      }),
      { params: Promise.resolve({ id }) },
    )
    expect(res.status).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'DISCOUNT_APPLIED', entityId: id }, orderBy: { timestamp: 'desc' } })
    expect(audit).toBeTruthy()
    const d = JSON.parse(audit!.details) as Record<string, unknown>
    expect(d.approved).toBe(true)
    expect(d.approvalMethod).toBe('pin')
    expect(d.approverId).toBe(mgrA2Id)
    expect(String(d.approverName)).toContain('mgrA2')
    expect(d.reasonText).toBe('gost nezadovoljen s postrežbo')
    // skrivnosti: PIN/e-pošta odobritelja NE smeta v audit
    expect(String(audit!.details)).not.toContain(pinMgrA2)
    expect(String(audit!.details)).not.toContain('approverPin')
  })

  it('C5. ad-hoc popust VEDNO zahteva razlog (tudi pod pragom, vodstveni izvajalec)', async () => {
    const { id } = await seedOrder(locA)
    const res1 = await discountPOST(req('POST', `/api/orders/${id}/discount`, tokMgrA, { name: 'Ad hoc', type: 'fixed', amount: 1 }), { params: Promise.resolve({ id }) })
    expect(res1.status).toBe(400)
    expect((await body(res1)).error).toContain('azlog')
    const res2 = await discountPOST(req('POST', `/api/orders/${id}/discount`, tokMgrA, { name: 'Ad hoc', type: 'fixed', amount: 1, reason: 'poslovna kompenzacija' }), { params: Promise.resolve({ id }) })
    expect(res2.status).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'DISCOUNT_APPLIED', entityId: id }, orderBy: { timestamp: 'desc' } })
    const d = JSON.parse(audit!.details) as Record<string, unknown>
    expect(d.source).toBe('adhoc')
    expect(d.reasonText).toBe('poslovna kompenzacija')
  })

  it('C6. vodstveni izvajalec nad pragom → 200 (odobritev role, ohranjena dosedanja politika)', async () => {
    const disc = await seedDiscount({ amount: 25 })
    const { id } = await seedOrder(locA)
    const res = await discountPOST(req('POST', `/api/orders/${id}/discount`, tokMgrA, { discountId: disc, reason: 'stalni gost' }), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'DISCOUNT_APPLIED', entityId: id }, orderBy: { timestamp: 'desc' } })
    const d = JSON.parse(audit!.details) as Record<string, unknown>
    expect(d.approvalMethod).toBe('role')
    expect(d.approverId).toBe(mgrAId)
  })

  it('C7. politika excRequireReasonDiscount=true → tudi register popust pod pragom zahteva razlog', async () => {
    if (!(await db.restaurantSettings.findFirst())) {
      await db.restaurantSettings.create({ data: { id: `${P}settings2-${RUN}` } })
    }
    resetExceptionPolicyProbe(true)
    await writeExceptionPolicy({ excRequireReasonDiscount: true })
    const disc = await seedDiscount({ amount: 5 })
    const { id } = await seedOrder(locA)
    const res1 = await discountPOST(req('POST', `/api/orders/${id}/discount`, tokWaiterA, { discountId: disc }), { params: Promise.resolve({ id }) })
    expect(res1.status).toBe(400)
    const res2 = await discountPOST(req('POST', `/api/orders/${id}/discount`, tokWaiterA, { discountId: disc, reason: 'promocija za stalne goste' }), { params: Promise.resolve({ id }) })
    expect(res2.status).toBe(200)
    await writeExceptionPolicy({ excRequireReasonDiscount: false })
    resetExceptionPolicyProbe()
  })
})

/* ───────── D. popust DELETE — obvezen razlog ───────── */

describe('D. popust DELETE: odstranitev je izjema', () => {
  it('D1. brez razloga → 400; z razlogom → 200 + DISCOUNT_REMOVED s posnetkom', async () => {
    const disc = await seedDiscount({ amount: 10 })
    const { id } = await seedOrder(locA)
    await discountPOST(req('POST', `/api/orders/${id}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id }) })
    const del1 = await discountDELETE(req('DELETE', `/api/orders/${id}/discount`, tokMgrA), { params: Promise.resolve({ id }) })
    expect(del1.status).toBe(400)
    // obstoječi popust je ostal (napaka PRED mutacijo)
    expect(Number((await db.order.findUnique({ where: { id } }))?.discount)).toBeGreaterThan(0)
    const del2 = await discountDELETE(req('DELETE', `/api/orders/${id}/discount`, tokMgrA, { reason: 'gost je zamenjal odločitev' }), { params: Promise.resolve({ id }) })
    expect(del2.status).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'DISCOUNT_REMOVED', entityId: id }, orderBy: { timestamp: 'desc' } })
    const d = JSON.parse(audit!.details) as Record<string, unknown>
    expect(d.reasonText).toBe('gost je zamenjal odločitev')
    expect(Number(d.removedAmount)).toBeGreaterThan(0)
  })
})

/* ───────── E. preklic postavke — prag odobritve ───────── */

describe('E. preklic postavke: prag + odobritev (permission override pot)', () => {
  it('E1. natakar z orders.void override, prag 3 €: brez odobritelja 403; z drugim vodjo 200 + audit pin', async () => {
    if (!(await db.restaurantSettings.findFirst())) {
      await db.restaurantSettings.create({ data: { id: `${P}settings3-${RUN}` } })
    }
    resetExceptionPolicyProbe(true)
    await writeExceptionPolicy({ excVoidApprovalAmountCents: 300 }) // 3 €
    const { id, itemId } = await seedOrder(locA, { item: { qty: 1, price: 5 } }) // 5 € > 3 €
    const r1 = await voidPOST(req('POST', `/api/orders/${id}/void`, tokVoidWaiterA, { itemId, reason: 'napaka pri naročilu' }), { params: Promise.resolve({ id }) })
    expect(r1.status).toBe(403)
    const r2 = await voidPOST(
      req('POST', `/api/orders/${id}/void`, tokVoidWaiterA, {
        itemId, reason: 'napaka pri naročilu',
        approverEmail: `${P}mgrA2-${RUN}@test.local`, approverPin: pinMgrA2,
      }),
      { params: Promise.resolve({ id }) },
    )
    expect(r2.status).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_ITEM_VOID', entityId: itemId }, orderBy: { timestamp: 'desc' } })
    const d = JSON.parse(audit!.details) as Record<string, unknown>
    expect(d.approvalMethod).toBe('pin')
    expect(d.approverId).toBe(mgrA2Id)
    expect(String(audit!.details)).not.toContain(pinMgrA2)
    await writeExceptionPolicy({ excVoidApprovalAmountCents: 0 })
    resetExceptionPolicyProbe()
  })
})

/* ───────── F. preklic naročila — obvezen razlog ───────── */

describe('F. preklic naročila: razlog obvezen (PATCH CANCELLED + DELETE)', () => {
  it('F1. DELETE brez razloga → 400; z razlogom → 200 + ORDER_CANCELLED s posnetkom', async () => {
    const { id } = await seedOrder(locA)
    const r1 = await orderDELETE(req('DELETE', `/api/orders/${id}`, tokMgrA), { params: Promise.resolve({ id }) })
    expect(r1.status).toBe(400)
    expect((await db.order.findUnique({ where: { id } }))?.status).toBe('open') // napaka PREJ
    const r2 = await orderDELETE(req('DELETE', `/api/orders/${id}`, tokMgrA, { reason: 'gost je odšel' }), { params: Promise.resolve({ id }) })
    expect(r2.status).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_CANCELLED', entityId: id }, orderBy: { timestamp: 'desc' } })
    const d = JSON.parse(audit!.details) as Record<string, unknown>
    expect(d.reasonText).toBe('gost je odšel')
  })

  it('F2. PATCH status CANCELLED brez razloga → 400; z → 200 + OVERRIDE s posnetkom', async () => {
    const { id } = await seedOrder(locA)
    const r1 = await orderPATCH(req('PATCH', `/api/orders/${id}`, tokMgrA, { status: 'CANCELLED' }), { params: Promise.resolve({ id }) })
    expect(r1.status).toBe(400)
    const r2 = await orderPATCH(req('PATCH', `/api/orders/${id}`, tokMgrA, { status: 'CANCELLED', reason: 'napačen vnos mize' }), { params: Promise.resolve({ id }) })
    expect(r2.status).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_STATUS_CANCELLED_OVERRIDE', entityId: id }, orderBy: { timestamp: 'desc' } })
    const d = JSON.parse(audit!.details) as Record<string, unknown>
    expect(d.reasonText).toBe('napačen vnos mize')
  })
})

/* ───────── G. fiskalni storno — obvezen razlog ───────── */

describe('G. fiskalni storno: razlog obvezen', () => {
  it('G1. brez razloga → 400 (stanje nespremenjeno); z razlogom → 201 + RECEIPT_STORNO s posnetkom', async () => {
    const { receiptId } = await seedPaidOrderWithReceipt(9.9)
    const r1 = await stornoPOST(req('POST', `/api/receipts/${receiptId}/storno`, tokMgrA), { params: Promise.resolve({ id: receiptId }) })
    expect(r1.status).toBe(400)
    // naročilo ostaja 'paid' (napaka PRED transakcijo), brez storno računa
    expect(await db.receipt.count({ where: { stornoOf: receiptId } })).toBe(0)
    const r2 = await stornoPOST(req('POST', `/api/receipts/${receiptId}/storno`, tokMgrA, { reason: 'gost ni prejel naročila' }), { params: Promise.resolve({ id: receiptId }) })
    expect(r2.status).toBe(201)
    const audit = await db.auditLog.findFirst({ where: { action: 'RECEIPT_STORNO', entityId: { not: receiptId } }, orderBy: { timestamp: 'desc' } })
    const d = JSON.parse(audit!.details) as Record<string, unknown>
    expect(d.reasonText).toBe('gost ni prejel naročila')
  })
})

/* ───────── H. katalog razlogov CRUD ───────── */

describe('H. void-reasons CRUD (settings.manage + kind)', () => {
  it('H1. GET ?kind=discount → samo discount+any; privzeto (void) ohrani dosedanji izbirnik', async () => {
    const disc = await seedReason('Razlog popusta', 'discount')
    const void1 = await seedReason('Razlog preklica', 'void')
    const any1 = await seedReason('Splošen', 'any')
    const rDisc = await reasonsGET(req('GET', '/api/void-reasons?kind=discount', tokMgrA))
    const bDisc = await body(rDisc)
    const idsDisc = (bDisc.voidReasons as { id: string }[]).map((x) => x.id)
    expect(idsDisc).toContain(disc)
    expect(idsDisc).toContain(any1)
    expect(idsDisc).not.toContain(void1)
    const rVoid = await reasonsGET(req('GET', '/api/void-reasons', tokMgrA))
    const idsVoid = ((await body(rVoid)).voidReasons as { id: string }[]).map((x) => x.id)
    expect(idsVoid).toContain(void1)
    expect(idsVoid).toContain(any1)
    expect(idsVoid).not.toContain(disc)
  })

  it('H2. POST create (settings.manage) → 201 + vrstica kind/requireComment + audit; waiter → 403', async () => {
    const rWaiter = await reasonsPOST(req('POST', '/api/void-reasons', tokWaiterA, { name: 'Test', kind: 'discount' }))
    expect(rWaiter.status).toBe(403)
    const r = await reasonsPOST(req('POST', '/api/void-reasons', tokMgrA, { name: 'Kakovost hrane', kind: 'storno', requireComment: true }))
    expect(r.status).toBe(201)
    const b = (await body(r)).reason as { id: string; name: string; kind: string; requireComment: boolean }
    expect(b.kind).toBe('storno')
    expect(b.requireComment).toBe(true)
    const row = await db.$queryRaw<{ kind: string; requireComment: number }[]>`SELECT "kind", "requireComment" FROM "VoidReason" WHERE "id" = ${b.id}`
    expect(row[0].kind).toBe('storno')
    expect(Number(row[0].requireComment)).toBe(1)
    expect(await db.auditLog.count({ where: { action: 'EXCEPTION_REASON_CREATED', entityId: b.id } })).toBe(1)
  })

  it('H3. PATCH preimenovanje/deaktivacija → 200 + audit; deaktiviran IZGINE iz GET', async () => {
    const id = await seedReason('Za deaktivacijo', 'discount')
    const r = await reasonsPATCH(req('PATCH', '/api/void-reasons', tokMgrA, { id, name: 'Preimenovan razlog', isActive: false }))
    expect(r.status).toBe(200)
    expect(await db.auditLog.count({ where: { action: 'EXCEPTION_REASON_UPDATED', entityId: id } })).toBe(1)
    const b = await body(await reasonsGET(req('GET', '/api/void-reasons?kind=discount', tokMgrA)))
    expect((b.voidReasons as { id: string }[]).some((x) => x.id === id)).toBe(false)
  })

  it('H4. PATCH tuje lokacije → 403 (guardResource); DELETE v uporabi → 409 z navodilom', async () => {
    const foreign = await seedReason('Tuj razlog', 'discount', { loc: locB })
    const r = await reasonsPATCH(req('PATCH', '/api/void-reasons', tokMgrA, { id: foreign, isActive: false }))
    expect(r.status).toBe(403)

    // razlog v uporabi: OrderItem.voidReasonId
    const used = await seedReason('Uporabljen', 'void')
    const { id: orderId, itemId } = await seedOrder(locA)
    await db.orderItem.update({ where: { id: itemId }, data: { voidReasonId: used, voided: true } })
    void orderId
    const del = await reasonsDELETE(req('DELETE', `/api/void-reasons?id=${used}`, tokMgrA))
    expect(del.status).toBe(409)
    expect((await body(del)).error).toContain('deaktivir')
    // neuporabljen razlog gre izbrisat
    const unused = await seedReason('Neuporabljen', 'void')
    const del2 = await reasonsDELETE(req('DELETE', `/api/void-reasons?id=${unused}`, tokMgrA))
    expect(del2.status).toBe(200)
    expect(await db.voidReason.findUnique({ where: { id: unused } })).toBeNull()
  })
})

/* ───────── I. varnost odobritelja ───────── */

describe('I. varnost odobritelja (ločena oseba, PIN, obseg)', () => {
  async function attemptWith(approver: { email: string; pin: string }): Promise<number> {
    const disc = await seedDiscount({ amount: 20 })
    const { id } = await seedOrder(locA)
    const res = await discountPOST(
      req('POST', `/api/orders/${id}/discount`, tokWaiterA, {
        discountId: disc, reason: 'test', approverEmail: approver.email, approverPin: approver.pin,
      }),
      { params: Promise.resolve({ id }) },
    )
    return res.status
  }

  it('I1. napačen PIN → 403', async () => {
    expect(await attemptWith({ email: `${P}mgrA2-${RUN}@test.local`, pin: '000000' })).toBe(403)
  })

  it('I2. odobritelj druge lokacije (ne-centralna vloga) → 403', async () => {
    expect(await attemptWith({ email: `${P}mgrB-${RUN}@test.local`, pin: pinMgrB })).toBe(403)
  })

  it('I3. ne-vodstvena vloga odobritelja (veljaven PIN, WAITER vloga) → 403', async () => {
    // voidWaiterA (WAITER z override, PRAVILEN PIN) kot odobritelj — nima vodstvene vloge
    expect(await attemptWith({ email: `${P}voidWaiterA-${RUN}@test.local`, pin: pinVoidWaiterA })).toBe(403)
  })

  it('I4. neaktiven odobritelj → 403', async () => {
    const inactive = await seedEmployee({ name: 'neaktivenVodja', loc: locA })
    await db.employee.update({ where: { id: inactive.id }, data: { status: 'inactive' } })
    expect(await attemptWith({ email: `${P}neaktivenVodja-${RUN}@test.local`, pin: inactive.pin })).toBe(403)
  })
})

/* ───────── J. poročilo izjem ───────── */

describe('J. GET /api/reports/exceptions (tenant obseg + en dogodek na akcijo)', () => {
  it('J1. vrstice z razlogom/akterjem/odobriteljem; agregati po vrstah; brez dvojnega štetja; tuja lokacija NE VIDI', async () => {
    // lokacija A: popust (natakar + odobritev pin) + preklic naročila; lokacija B: popust vodje
    const discA = await seedDiscount({ amount: 20 })
    const oA = await seedOrder(locA)
    await discountPOST(
      req('POST', `/api/orders/${oA.id}/discount`, tokWaiterA, {
        discountId: discA, reason: 'nezadovoljstvo gosta J1',
        approverEmail: `${P}mgrA2-${RUN}@test.local`, approverPin: pinMgrA2,
      }),
      { params: Promise.resolve({ id: oA.id }) },
    )
    const oA2 = await seedOrder(locA)
    await orderDELETE(req('DELETE', `/api/orders/${oA2.id}`, tokMgrA, { reason: 'testni preklic J1' }), { params: Promise.resolve({ id: oA2.id }) })

    const oB = await seedOrder(locB)
    const discB = await seedDiscount({ amount: 10 })
    await db.discount.update({ where: { id: discB }, data: { locationId: locB } })
    await discountPOST(req('POST', `/api/orders/${oB.id}/discount`, tokMgrB, { discountId: discB }), { params: Promise.resolve({ id: oB.id }) })

    const res = await exceptionsGET(req('GET', '/api/reports/exceptions', tokMgrA))
    expect(res.status).toBe(200)
    const b = await body(res)
    const rows = (b.rows as { id: string; kind: string; actorName: string | null; approverName: string | null; reasonText: string | null; reasonName: string | null }[])
    const kinds = (b.byKind ?? {}) as Record<string, { count: number }>
    expect(Number(kinds.discount?.count ?? 0)).toBeGreaterThanOrEqual(1)
    expect(Number(kinds.cancel?.count ?? 0)).toBeGreaterThanOrEqual(1)
    // en dogodek na akcijo: J1 popust (unikaten razlog) prijavljen ENKRAT — ostali
    // natakarjevi popusti iz prejšnjih testov (C1, brez razloga) se NE štejejo dvakrat
    const discRows = rows.filter((r) => r.kind === 'discount' && r.reasonText === 'nezadovoljstvo gosta J1')
    expect(discRows.length).toBe(1)
    expect(discRows[0].approverName).toContain('mgrA2')
    expect(discRows[0].actorName).toContain('waiterA')
    // preklic naročila ima razlog (unikaten za J1)
    const cancelRows = rows.filter((r) => r.kind === 'cancel')
    expect(cancelRows.some((r) => r.reasonText === 'testni preklic J1')).toBe(true)

    // tuja lokacija: mgrB vidi SVOJE (lokacija B) in NE vidi lokacije A
    const resB = await exceptionsGET(req('GET', '/api/reports/exceptions', tokMgrB))
    const bB = await body(resB)
    const rowsB = (bB.rows as { actorName: string | null }[])
    expect(rowsB.some((r) => r.actorName === `${P}mgrB`)).toBe(true)
    expect(rowsB.some((r) => r.actorName === `${P}waiterA`)).toBe(false)
  })

  it('J2. CSV: BOM + Content-Disposition + vrstice z razlogom', async () => {
    const res = await exceptionsGET(req('GET', '/api/reports/exceptions?format=csv', tokMgrA))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain('izjeme-')
    const text = await res.text()
    expect(text.charCodeAt(0)).toBe(0xfeff) // BOM
    expect(text).toContain('datum;vrsta')
    expect(text).toContain('izvedel')
    expect(text).toContain('odobril')
  })

  it('J3. dovoljenje: natakar brez reports.view → 403', async () => {
    const res = await exceptionsGET(req('GET', '/api/reports/exceptions', tokWaiterA))
    expect(res.status).toBe(403)
  })
})

/* ───────── K. lahek endpoint politike ───────── */

describe('K. GET /api/exception-policy', () => {
  it('K1. vrne politiko + isManagerial (waiter false, manager true); brez skrivnosti', async () => {
    const rW = await policyGET(req('GET', '/api/exception-policy', tokWaiterA))
    expect(rW.status).toBe(200)
    const bW = await body(rW)
    expect(bW.isManagerial).toBe(false)
    expect((bW.policy as Record<string, unknown>).discountApprovalPct).toBe(15)
    expect(JSON.stringify(bW)).not.toContain('pin')
    const rM = await policyGET(req('GET', '/api/exception-policy', tokMgrA))
    expect((await body(rM)).isManagerial).toBe(true)
  })

  it('K2. brez žetona → 401', async () => {
    const res = await policyGET(req('GET', '/api/exception-policy', ''))
    expect(res.status).toBe(401)
  })
})
