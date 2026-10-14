/**
 * Issue #26 (P1) — tenant izolacija darilnih kartic: branje (ledger), polnjenje,
 * spremembe in unovčenje — BREZ blokade medposlovalničnega unovčenja v isti org.
 *
 * Pokrito:
 *  1. GET /api/giftcards/[id]: giftcards.manage + org obseg (prej: requireAuth +
 *     globalni findUnique — vsaka seja je videla 100 transakcij tuje org);
 *  2. PATCH: guardResource PRED mutacijo (prej: giftcards.manage orgA je
 *     deaktiviral/preimenoval kartico orgB);
 *  3. topup: varovalka PRED statusno preverbo in PRED idempotentnim replayem —
 *     replay ključ iz TUJE org ne dobi kartice/salda (ključ NI poverilnica);
 *  4. lookup: tenant obseg (org → medposlovalnično OK; staff brez org dreva →
 *     lastna lokacija; centralna neznana org → fail-closed prazno; bootstrap
 *     globalno); tuja org in neobstoječa → ENOTEN 404 (enumeracijska zaščita);
 *  5. legacy kartica brez locationId → fail-closed 404 povsod (izrecna
 *     zahteva issue-ja: brez razrešljive organizacije NI neomejenega dostopa);
 *  6. fiskalno unovčenje (POST /api/furs): kartica iste org na DRUGI lokaciji
 *     deluje (poslovno pravilo varovano); cross-tenant → 409 zavrnitev;
 *  7. zavrnitve pišejo revizijo GIFT_CARD_ACCESS_DENIED BREZ podatkov kartice.
 *
 * Fiksture s predpono i26- (GiftCardTransaction Restrict → ročno čiščenje
 * PRED sweep; revizija zavrnitev po akciji + userId predponi).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { __resetRateLimitForTests } from '../src/lib/rate-limit'
import { GET as gcDetailGET, PATCH as gcPATCH } from '../src/app/api/giftcards/[id]/route'
import { POST as gcTopupPOST } from '../src/app/api/giftcards/[id]/topup/route'
import { GET as gcLookupGET } from '../src/app/api/giftcards/lookup/route'
import { POST as fursPOST } from '../src/app/api/furs/route'

const P = 'i26-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const PREV_FURS_ENV = process.env.FURS_ENVIRONMENT

// ── fiksture ──
let locA = '' // nevezana (legacy) lokacija — staff brez org dreva
let locOA1 = '' // org A, lokacija 1 (fiskalno pripravljena)
let locOA2 = '' // org A, lokacija 2 (medposlovalnično unovčenje)
let locOB = '' // org B
let miOA1 = ''
let gcA = '' // kartica na nevezani lokaciji
let gcOA1 = '' // kartica org A / lokacija 1
let gcOA2 = '' // kartica org A / lokacija 2
let gcOB = '' // kartica org B
let gcNull = '' // LEGACY kartica brez locationId
let tokMgrA = ''
let tokWaiter = ''
let tokMgrOA1 = ''
let tokAdminOA1 = ''
let tokAdminOB = ''
let tokAdminNoLoc = ''

const CARD_NUM = {
  A: `GC-20990101-100001`,
  OA1: `GC-20990101-100002`,
  OA2: `GC-20990101-100003`,
  OB: `GC-20990101-100004`,
  NULL: `GC-20990101-100005`,
}

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

async function seedEmployee(name: string, role: string, loc: string | null, seq: number): Promise<string> {
  const id = `${P}${name}-${RUN}`
  const pin = `${PIN_BASE}${seq}`
  const f = employeePinFields(pin, `${P}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${P}${name}`, email: `${P}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

async function seedCard(id: string, cardNumber: string, balance: number, locationId: string | null) {
  await db.giftCard.create({
    data: {
      id, cardNumber, balance, initialBalance: balance,
      status: 'active', ownerName: `${P}Lastnik ${id}`, locationId,
      purchasedAt: new Date(), expiresAt: null,
    },
  })
}

const vatOf = (base: number, rate: number) => Math.round((base * rate + Number.EPSILON)) / 100

let ordSeq = 880001
async function seedOrderAt(loc: string, employeeId: string) {
  const orderId = `${P}o${++ordSeq}-${RUN}`
  const subtotal = 5
  const tax = vatOf(5, 22)
  await db.order.create({
    data: {
      id: orderId, orderNumber: ordSeq, locationId: loc, status: 'open',
      paymentStatus: 'unpaid', type: 'dine-in',
      subtotal, tax, total: subtotal + tax, employeeId,
    },
  })
  await db.orderItem.create({
    data: {
      id: `${P}itm${ordSeq}-${RUN}`, orderId, menuItemId: miOA1,
      quantity: 1, price: 5, vatRate: 22, vatAmount: tax,
      menuItemName: `${P}Jed OA1`, status: 'served',
    },
  })
  return orderId
}

async function cleanFixtures() {
  // GiftCardTransaction (Restrict) najprej, nato revizije, nato kartice
  const cards = await db.giftCard.findMany({ where: { OR: [{ id: { startsWith: P } }, { cardNumber: { startsWith: 'GC-20990101-' } }] }, select: { id: true } })
  for (const { id } of cards) {
    await db.giftCardTransaction.deleteMany({ where: { giftCardId: id } })
    await db.payment.deleteMany({ where: { giftCardId: id } })
    await db.auditLog.deleteMany({ where: { entityType: 'GiftCard', entityId: id } })
    await db.giftCard.deleteMany({ where: { id } })
  }
  await db.auditLog.deleteMany({ where: { action: 'GIFT_CARD_ACCESS_DENIED', userId: { startsWith: P } } })
  await db.receipt.deleteMany({ where: { orderId: { startsWith: P } } }).catch(() => null)
  await db.payment.deleteMany({ where: { orderId: { startsWith: P } } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { orderId: { startsWith: P } } })
  await db.order.deleteMany({ where: { id: { startsWith: P } } })
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanFixtures()
  __resetRateLimitForTests()
  process.env.FURS_ENVIRONMENT = 'simulation'

  // org drevo: org A (dve lokaciji) + org B (ena)
  const orgA = `${P}orgA-${RUN}`
  const orgB = `${P}orgB-${RUN}`
  const brandA = `${P}brandA-${RUN}`
  const brandB = `${P}brandB-${RUN}`
  const propA = `${P}propA-${RUN}`
  const propB = `${P}propB-${RUN}`
  await db.organization.create({ data: { id: orgA, name: `${P}Org A`, slug: `${P}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: `${P}Org B`, slug: `${P}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: `${P}Znamka A` } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: `${P}Znamka B` } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: `${P}Objekt A` } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: `${P}Objekt B` } })

  locA = `${P}locA-${RUN}`
  await db.location.create({ data: { id: locA, code: `${P}LA`, name: `${P}Lokacija A (nevezana)`, premisesId: `${P}premA-${RUN}` } })
  locOA1 = `${P}locOA1-${RUN}`
  await db.location.create({ data: { id: locOA1, code: `${P}OA1`, name: `${P}Lokacija OA1`, propertyId: propA, taxId: 'SI12345678', registerNumber: `${P}BLG-OA1`, fursEnvironment: 'simulation', country: 'SI' } })
  locOA2 = `${P}locOA2-${RUN}`
  await db.location.create({ data: { id: locOA2, code: `${P}OA2`, name: `${P}Lokacija OA2`, propertyId: propA } })
  locOB = `${P}locOB-${RUN}`
  await db.location.create({ data: { id: locOB, code: `${P}OB`, name: `${P}Lokacija OB`, propertyId: propB } })

  // meni/artikel za OrderItem FK na OA1
  const menuOA = await db.menu.create({ data: { id: `${P}menuOA-${RUN}`, name: `${P}Meni OA`, locationId: locOA1 } })
  const catOA = await db.category.create({ data: { id: `${P}catOA-${RUN}`, name: `${P}Kat OA`, menuId: menuOA.id } })
  miOA1 = (await db.menuItem.create({ data: { id: `${P}miOA1-${RUN}`, name: `${P}Jed OA`, price: 5, categoryId: catOA.id } })).id

  // kartice
  gcA = `${P}gcA-${RUN}`
  gcOA1 = `${P}gcOA1-${RUN}`
  gcOA2 = `${P}gcOA2-${RUN}`
  gcOB = `${P}gcOB-${RUN}`
  gcNull = `${P}gcNull-${RUN}`
  await seedCard(gcA, CARD_NUM.A, 25, locA)
  await seedCard(gcOA1, CARD_NUM.OA1, 25, locOA1)
  await seedCard(gcOA2, CARD_NUM.OA2, 25, locOA2)
  await seedCard(gcOB, CARD_NUM.OB, 30, locOB)
  await seedCard(gcNull, CARD_NUM.NULL, 25, null)

  // uporabniki
  const mgrA = await seedEmployee('mgrA', 'manager', locA, 1)
  const waiterA = await seedEmployee('waiterA', 'waiter', locA, 2)
  const mgrOA1 = await seedEmployee('mgrOA1', 'manager', locOA1, 3)
  const adminOA1 = await seedEmployee('adminOA1', 'admin', locOA1, 4)
  const adminOB = await seedEmployee('adminOB', 'admin', locOB, 5)
  const adminNoLoc = await seedEmployee('adminNoLoc', 'admin', null, 6)
  tokMgrA = tok(mgrA, `${P}mgrA`, 'MANAGER', locA)
  tokWaiter = tok(waiterA, `${P}waiterA`, 'WAITER', locA)
  tokMgrOA1 = tok(mgrOA1, `${P}mgrOA1`, 'MANAGER', locOA1)
  tokAdminOA1 = tok(adminOA1, `${P}adminOA1`, 'ADMIN', locOA1)
  tokAdminOB = tok(adminOB, `${P}adminOB`, 'ADMIN', locOB)
  tokAdminNoLoc = tok(adminNoLoc, `${P}adminNoLoc`, 'ADMIN', null)
})

afterAll(async () => {
  await cleanFixtures()
  __resetRateLimitForTests()
  if (PREV_FURS_ENV === undefined) delete process.env.FURS_ENVIRONMENT
  else process.env.FURS_ENVIRONMENT = PREV_FURS_ENV
})

/* ───────────── GET /api/giftcards/[id] — ledger pod pravico + org obsegom ───────────── */

describe('#26 — GET [id]: podrobni dnevnik zahteva pravico in tenant obseg', () => {
  it('manager na SVOJI lokaciji vidi kartico + ledger (≤ 50 transakcij)', async () => {
    const res = await gcDetailGET(req('GET', `/api/giftcards/${gcA}`, tokMgrA), { params: Promise.resolve({ id: gcA }) })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { card: { id: string; cardNumber: string }; transactions: unknown[] }
    expect(j.card.id).toBe(gcA)
    expect(Array.isArray(j.transactions)).toBe(true)
    expect(j.transactions.length).toBeLessThanOrEqual(50)
  })

  it('natakar (orders.pay BREZ giftcards.manage) → 403, BREZ podatkov kartice', async () => {
    const res = await gcDetailGET(req('GET', `/api/giftcards/${gcA}`, tokWaiter), { params: Promise.resolve({ id: gcA }) })
    expect(res.status).toBe(403)
    const raw = JSON.stringify(await res.json())
    expect(raw).not.toContain(CARD_NUM.A)
    expect(raw).not.toContain('balance')
  })

  it('manager orgA z ZNANIM id-jem kartice orgB → 403 + revizija GIFT_CARD_ACCESS_DENIED (brez podatkov kartice)', async () => {
    const res = await gcDetailGET(req('GET', `/api/giftcards/${gcOB}`, tokAdminOA1), { params: Promise.resolve({ id: gcOB }) })
    expect(res.status).toBe(403)
    const raw = JSON.stringify(await res.json())
    expect(raw).not.toContain(CARD_NUM.OB)
    const audit = await db.auditLog.findFirst({
      where: { action: 'GIFT_CARD_ACCESS_DENIED', entityId: gcOB, userId: { startsWith: P } },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
    const details = String(audit?.details || '')
    expect(details).toContain('GET')
    expect(details).toContain('cross-tenant')
    expect(details).not.toContain(CARD_NUM.OB)
  })

  it('centralna orgA vidi kartico DRUGE lokacije iste org (ledger ostaja org-obsežen)', async () => {
    const res = await gcDetailGET(req('GET', `/api/giftcards/${gcOA2}`, tokAdminOA1), { params: Promise.resolve({ id: gcOA2 }) })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { card: { id: string } }
    expect(j.card.id).toBe(gcOA2)
  })

  it('staff (manager OA1) na kartici OA2 (ista org, druga lokacija) → 403 (ledger je strožji od unovčenja)', async () => {
    const res = await gcDetailGET(req('GET', `/api/giftcards/${gcOA2}`, tokMgrOA1), { params: Promise.resolve({ id: gcOA2 }) })
    expect(res.status).toBe(403)
  })

  it('legacy kartica brez locationId → 404 (fail-closed, enotno z neobstoječo)', async () => {
    const res = await gcDetailGET(req('GET', `/api/giftcards/${gcNull}`, tokAdminOA1), { params: Promise.resolve({ id: gcNull }) })
    expect(res.status).toBe(404)
    const raw = JSON.stringify(await res.json())
    expect(raw).not.toContain(CARD_NUM.NULL)
    // kartica OBSTAJA v DB (ni bila izbrisana) — dostop je zavrnjen, ne uničen
    expect(await db.giftCard.count({ where: { id: gcNull } })).toBe(1)
  })
})

/* ───────────── PATCH — varovalka PRED mutacijo ───────────── */

describe('#26 — PATCH: spremembe samo znotraj organizacije', () => {
  it('giftcards.manage orgB NE more deaktivirati/preimenovati kartice orgA → 403, kartica nespremenjena', async () => {
    const res = await gcPATCH(
      req('PATCH', `/api/giftcards/${gcOA1}`, tokAdminOB, { ownerName: `${P}Hacker`, status: 'inactive' }),
      { params: Promise.resolve({ id: gcOA1 }) },
    )
    expect(res.status).toBe(403)
    const card = await db.giftCard.findUnique({ where: { id: gcOA1 } })
    expect(card?.status).toBe('active')
    expect(card?.ownerName).toBe(`${P}Lastnik ${gcOA1}`)
  })

  it('legacy kartica brez lokacije → 404 PATCH, nespremenjena', async () => {
    const res = await gcPATCH(
      req('PATCH', `/api/giftcards/${gcNull}`, tokAdminOA1, { status: 'inactive' }),
      { params: Promise.resolve({ id: gcNull }) },
    )
    expect(res.status).toBe(404)
    const card = await db.giftCard.findUnique({ where: { id: gcNull } })
    expect(card?.status).toBe('active')
  })

  it('centralna orgA deaktivira kartico svoje org → 200 + revizija GIFT_CARD_UPDATE', async () => {
    const res = await gcPATCH(
      req('PATCH', `/api/giftcards/${gcOA1}`, tokAdminOA1, { status: 'inactive' }),
      { params: Promise.resolve({ id: gcOA1 }) },
    )
    expect(res.status).toBe(200)
    const card = await db.giftCard.findUnique({ where: { id: gcOA1 } })
    expect(card?.status).toBe('inactive')
    const audit = await db.auditLog.findFirst({ where: { action: 'GIFT_CARD_UPDATE', entityId: gcOA1 }, orderBy: { timestamp: 'desc' } })
    expect(audit).not.toBeNull()
    // reaktivacija za nadaljnje teste
    const back = await gcPATCH(
      req('PATCH', `/api/giftcards/${gcOA1}`, tokAdminOA1, { status: 'active' }),
      { params: Promise.resolve({ id: gcOA1 }) },
    )
    expect(back.status).toBe(200)
  })
})

/* ───────────── topup — varovalka PRED statusno preverbo in PRED replayem ───────────── */

describe('#26 — topup: polnjenje znotraj organizacije, replay ne obide avtorizacije', () => {
  it('manager na SVOJI lokaciji napolni kartico → 201 (zlata pot ohranjena)', async () => {
    const res = await gcTopupPOST(
      req('POST', `/api/giftcards/${gcA}/topup`, tokMgrA, { amount: 5 }),
      { params: Promise.resolve({ id: gcA }) },
    )
    expect(res.status).toBe(201)
    const card = await db.giftCard.findUnique({ where: { id: gcA } })
    expect(Math.round(Number(card?.balance) * 100)).toBe(3000)
    expect(await db.giftCardTransaction.count({ where: { giftCardId: gcA, type: 'topup' } })).toBe(1)
  })

  it('orders.pay orgA NE more polniti kartice orgB → 403, saldo nespremenjen, BREZ transakcije', async () => {
    const res = await gcTopupPOST(
      req('POST', `/api/giftcards/${gcOB}/topup`, tokMgrOA1, { amount: 5 }),
      { params: Promise.resolve({ id: gcOB }) },
    )
    expect(res.status).toBe(403)
    const card = await db.giftCard.findUnique({ where: { id: gcOB } })
    expect(Math.round(Number(card?.balance) * 100)).toBe(3000)
    expect(await db.giftCardTransaction.count({ where: { giftCardId: gcOB } })).toBe(0)
  })

  it('staff (OA1) ne more polniti kartice OA2 (ista org, druga lokacija) → 403 (polnjenje je strožje od unovčenja)', async () => {
    const res = await gcTopupPOST(
      req('POST', `/api/giftcards/${gcOA2}/topup`, tokMgrOA1, { amount: 5 }),
      { params: Promise.resolve({ id: gcOA2 }) },
    )
    expect(res.status).toBe(403)
  })

  it('centralna orgA napolni kartico OA2 (ista org, druga lokacija) → 201', async () => {
    const res = await gcTopupPOST(
      req('POST', `/api/giftcards/${gcOA2}/topup`, tokAdminOA1, { amount: 5, clientOperationId: `i26topup-${RUN}-001` }),
      { params: Promise.resolve({ id: gcOA2 }) },
    )
    expect(res.status).toBe(201)
    const card = await db.giftCard.findUnique({ where: { id: gcOA2 } })
    expect(Math.round(Number(card?.balance) * 100)).toBe(3000)
  })

  it('REPLAY istega clientOperationId iz TUJE org → 403 PRED replayem (ključ NI poverilnica), saldo nespremenjen', async () => {
    const before = await db.giftCard.findUnique({ where: { id: gcOA2 } })
    const beforeCents = Math.round(Number(before?.balance) * 100)
    const res = await gcTopupPOST(
      req('POST', `/api/giftcards/${gcOA2}/topup`, tokAdminOB, { amount: 5, clientOperationId: `i26topup-${RUN}-001` }),
      { params: Promise.resolve({ id: gcOA2 }) },
    )
    expect(res.status).toBe(403)
    const raw = JSON.stringify(await res.json())
    expect(raw).not.toContain(CARD_NUM.OA2)
    expect(raw).not.toContain('balance')
    const after = await db.giftCard.findUnique({ where: { id: gcOA2 } })
    expect(Math.round(Number(after?.balance) * 100)).toBe(beforeCents)
    // idempotentni zapis ni podvojen
    expect(await db.giftCardTransaction.count({ where: { giftCardId: gcOA2, type: 'topup' } })).toBe(1)
  })

  it('isti uporabnik (orgA) replaya svoj ključ → 200 replayed, BREZ dodatnega polnjenja', async () => {
    const res = await gcTopupPOST(
      req('POST', `/api/giftcards/${gcOA2}/topup`, tokAdminOA1, { amount: 5, clientOperationId: `i26topup-${RUN}-001` }),
      { params: Promise.resolve({ id: gcOA2 }) },
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { replayed: boolean }
    expect(j.replayed).toBe(true)
    const card = await db.giftCard.findUnique({ where: { id: gcOA2 } })
    expect(Math.round(Number(card?.balance) * 100)).toBe(3000)
  })

  it('legacy kartica brez lokacije → topup 404, saldo nespremenjen', async () => {
    const res = await gcTopupPOST(
      req('POST', `/api/giftcards/${gcNull}/topup`, tokAdminOA1, { amount: 5 }),
      { params: Promise.resolve({ id: gcNull }) },
    )
    expect(res.status).toBe(404)
    const card = await db.giftCard.findUnique({ where: { id: gcNull } })
    expect(Math.round(Number(card?.balance) * 100)).toBe(2500)
  })
})

/* ───────────── lookup — tenant obseg iskanja (POS plačilni tok) ───────────── */

describe('#26 — lookup: tenant obseg, medposlovalnično unovčenje iste org ohranjeno', () => {
  it('staff na nevezani lokaciji najde KARTICO SVOJE LOKACIJE (POS regresija — migracijsko varno)', async () => {
    const res = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=${CARD_NUM.A}`, tokMgrA))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { card: { id: string; cardNumber: string } }
    expect(j.card.id).toBe(gcA)
    expect(j.card.cardNumber).toBe(CARD_NUM.A)
  })

  it('suffix iskanje (zadnjih 6) deluje znotraj obsega', async () => {
    const res = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=100001`, tokMgrA))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { card: { id: string } }
    expect(j.card.id).toBe(gcA)
  })

  it('manager orgA najde kartico DRUGE poslovalnice ISTE org (medposlovalnično unovčenje — poslovno pravilo #26)', async () => {
    const res = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=${CARD_NUM.OA2}`, tokMgrOA1))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { card: { id: string } }
    expect(j.card.id).toBe(gcOA2)
  })

  it('centralna orgA prav tako vidi kartico OA2; odgovor BREZ locationId', async () => {
    const res = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=${CARD_NUM.OA2}`, tokAdminOA1))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { card: Record<string, unknown> }
    expect(j.card.id).toBe(gcOA2)
    expect(j.card.locationId).toBeUndefined()
  })

  it('kartica TUJE org (orgB) → 404, ENAKO kot neobstoječa (brez enumeracijske razlike)', async () => {
    const resForeign = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=${CARD_NUM.OB}`, tokMgrOA1))
    const resMissing = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=GC-20990101-999999`, tokMgrOA1))
    expect(resForeign.status).toBe(404)
    expect(resMissing.status).toBe(404)
    expect((await resForeign.json()).error).toBe((await resMissing.json()).error)
  })

  it('staff na nevezani lokaciji NE vidi kartic org dreves (tuji tenant)', async () => {
    const res = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=${CARD_NUM.OA1}`, tokMgrA))
    expect(res.status).toBe(404)
  })

  it('legacy kartica brez locationId je v lookupu NEVIDNA (fail-closed)', async () => {
    const res = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=${CARD_NUM.NULL}`, tokMgrA))
    expect(res.status).toBe(404)
    const res2 = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=${CARD_NUM.NULL}`, tokAdminOA1))
    expect(res2.status).toBe(404)
  })

  it('centralna vloga z NEZNANO org (loc null) → fail-closed: nič ni vidno (vzorec #38)', async () => {
    const res = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=${CARD_NUM.OA1}`, tokAdminNoLoc))
    expect(res.status).toBe(404)
  })
})

/* ───────────── fiskalno unovčenje — POST /api/furs (kartica = instrument org) ───────────── */

describe('#26 — unovčenje ob plačilu: medposlovalnično isti org DA, cross-tenant NE', () => {
  it('naročilo na OA1 plačano s kartico OA2 (ISTA org, druga lokacija) → 201, saldo odbit, redeem transakcija', async () => {
    const orderId = await seedOrderAt(locOA1, `${P}mgrOA1-${RUN}`)
    const res = await fursPOST(req('POST', '/api/furs', tokMgrOA1, { orderId, type: 'giftcard', giftCardId: gcOA2 }))
    expect(res.status).toBe(201)
    const card = await db.giftCard.findUnique({ where: { id: gcOA2 } })
    // 25 + 5 (topup) − 6.10 (naročilo) = 23.90
    expect(Math.round(Number(card?.balance) * 100)).toBe(2390)
    const tx = await db.giftCardTransaction.findFirst({ where: { giftCardId: gcOA2, type: 'redeem' }, orderBy: { createdAt: 'desc' } })
    expect(tx).not.toBeNull()
    expect(Math.round(Number(tx?.amount) * 100)).toBe(-610)
    const order = await db.order.findUnique({ where: { id: orderId } })
    expect(order?.paymentStatus).toBe('paid')
  })

  it('naročilo na OA1 s kartico orgB → 409 zavrnitev, saldo nespremenjen, BREZ računa, naročilo neplačano', async () => {
    const orderId = await seedOrderAt(locOA1, `${P}mgrOA1-${RUN}`)
    const res = await fursPOST(req('POST', '/api/furs', tokMgrOA1, { orderId, type: 'giftcard', giftCardId: gcOB }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string }
    expect(String(body.error)).toMatch(/dru[dg]i organizaciji/i)
    const card = await db.giftCard.findUnique({ where: { id: gcOB } })
    expect(Math.round(Number(card?.balance) * 100)).toBe(3000)
    expect(await db.giftCardTransaction.count({ where: { giftCardId: gcOB, type: 'redeem' } })).toBe(0)
    const order = await db.order.findUnique({ where: { id: orderId } })
    expect(order?.paymentStatus).toBe('unpaid')
    const receipts = await db.receipt.findMany({ where: { Order: { id: orderId } } })
    expect(receipts.length).toBe(0)
  })

  it('legacy kartica brez lokacije → 409 fail-closed, saldo nespremenjen', async () => {
    const orderId = await seedOrderAt(locOA1, `${P}mgrOA1-${RUN}`)
    const res = await fursPOST(req('POST', '/api/furs', tokMgrOA1, { orderId, type: 'giftcard', giftCardId: gcNull }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string }
    expect(String(body.error)).toMatch(/nima vezane lokacije/i)
    const card = await db.giftCard.findUnique({ where: { id: gcNull } })
    expect(Math.round(Number(card?.balance) * 100)).toBe(2500)
    const order = await db.order.findUnique({ where: { id: orderId } })
    expect(order?.paymentStatus).toBe('unpaid')
  })
})
