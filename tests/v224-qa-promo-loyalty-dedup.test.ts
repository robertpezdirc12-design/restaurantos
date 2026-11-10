import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as discountPOST } from '../src/app/api/orders/[id]/discount/route'
import { POST as loyaltyPOST } from '../src/app/api/loyalty/route'
import { APP_VERSION } from '../src/lib/version'

/**
 * UPORABNIŠKI QA VAL #6 — DOKUMENTIRANA B-OSTANKA IZ VALA #3 (v1.228.0).
 *
 * Val #3 (v1.221.0) je v zalihu »C« dokumentiral dve najdbi kot B-ostanek
 * (lastnikova odločitev takrat). Ta val obe ZAPREVA, ker sta obe čisto
 * izvedbeni (0 DDL, 0 odvisnosti, 0 AI):
 *
 *  C1 (P2 — promo koda registra ni bila unovčljiva v POS polju za kupone):
 *     plačilni dialog ima ENO polje za kodo (»Kupon (koda)«), ki je iskalo
 *     IZKLJUČNO osebne kupone (Coupon). Natakar, ki je vnesel promo kodo iz
 *     registra popustov (Discount.promoCode — register kodo pozna in jo
 *     razstavlja v seznamu), je dobil ZAVAJAJOČ 404 »Kupon s to kodo ne
 *     obstaja.« — koda pa je obstajala, samo v drugem viru. POPRAVEK:
 *     discount ruta ob ne najdenem osebnem kuponu poišče ISTO kodo v registru
 *     (ista lokacija, aktiven, ročen sprožilec — 'auto'/Happy Hour izpada,
 *     ker se aplicira sam ob plačilu). Promo veja deli SEMANTIKO registra:
 *     kvota currentUses/maxUses (CAS v isti transakciji), vir 'register'
 *     (razlog/odobritev po politiki registra, ne ad-hoc izjeme), veljav-
 *     nostno okno. Neznana koda v OBEH virih doje 404, ki pošteno pove oba
 *     vira. Primerjava je normalizirana (trim + VELIKE črke), ker register
 *     prek API-ja kodo lahko shrani tudi male.
 *
 *  C2 (P2 — ustvarjanje člana zvestobe brez dedupliciranja po telefonu):
 *     POST /api/loyalty je ustvaril račun zvestobe BREZ preverbe — isti gost
 *     (ista telefonska številka) je lahko imel več računov, točke so se
 *     razdrobile. POPRAVEK: če telefon (≥ 6 števk po normalizaciji) na ISTI
 *     lokaciji že obstaja → 409 z imenom obstoječega gosta. Normalizacija je
 *     ista kot CRM dedup (normalizePhoneDigits: ne-števke odpadejo, vodilna
 *     '00' se odstrani → '+386 40 111 222' ≡ '00386 40 111 222'). Prazen
 *     telefon = brez preverbe (ime samo po sebi ni identiteta). Obseg = ista
 *     lokacija (večlokalni gost ima lahko račun na vsaki lokaciji).
 *
 * Tu sta zapečatena popravka (vedenjsko, direktne route calls po vzorcu
 * v221) + statika UI/i18n + verzija.
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const PREFIX = 'v224-'
const RUN = Date.now().toString(36)

let locId = ''
let adminId = ''
let adminToken = ''
let menuItemId = ''

function req(url: string, token: string | null, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

let orderSeq = 973400

async function cleanup() {
  await sweepTestFixtures(db, [PREFIX])
}

beforeAll(async () => {
  await cleanup()
  locId = `${PREFIX}loc-${RUN}`
  await db.location.create({
    data: {
      id: locId, name: `${PREFIX}Lokacija`, code: `V224${RUN.toUpperCase().slice(-6)}`,
      premisesId: `BLGV224${RUN.toUpperCase().slice(-5)}`, country: 'SI',
      registerNumber: 'BLG-224', fursEnvironment: 'simulation', currency: 'EUR', timezone: 'Europe/Ljubljana',
    },
  })
  adminId = `${PREFIX}admin-${RUN}`
  const pin = employeePinFields(`7${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locId, ...pin },
  })
  adminToken = createToken({ sub: adminId, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locId, sv: 0 })
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locId } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
  menuItemId = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: `${PREFIX}Artikel`, price: 10, categoryId: cat.id } })).id
})

afterAll(async () => {
  await cleanup()
})

async function seedOrder(): Promise<string> {
  const orderId = `${PREFIX}o${orderSeq}-${RUN}`
  await db.order.create({
    data: { id: orderId, orderNumber: orderSeq++, locationId: locId, status: 'open', paymentStatus: 'unpaid', type: 'dine-in', subtotal: 8.20, tax: 1.80, total: 10, employeeId: adminId },
  })
  await db.orderItem.create({
    data: { id: `${PREFIX}it${orderSeq}-${RUN}`, orderId, menuItemId, menuItemName: `${PREFIX}Artikel`, quantity: 1, price: 10, vatRate: 22, vatAmount: 1.80, status: 'served' },
  })
  return orderId
}

/* ── C1 · P2 — promo koda registra v POS polju za kodo ─────────────────── */

describe('v224 C1 · promo koda registra je unovčljiva v POS polju za kodo', () => {
  test('200: koda registra (percent) se odkupi prek couponCode — kvota currentUses se poveča', async () => {
    const promoId = `${PREFIX}d1-${RUN}`
    await db.discount.create({
      data: { id: promoId, name: `${PREFIX}Promo 10 %`, type: 'percent', amount: 10, triggerType: 'manual', promoCode: 'V224PROMO', maxUses: 5, currentUses: 0, isActive: true, locationId: locId },
    })
    const orderId = await seedOrder()
    // mala pisava + presledki dokazujeta normalizacijo (register prek API-ja
    // lahko shrani male črke; POS polje sili velike)
    const res = await discountPOST(
      req(`/api/orders/${orderId}/discount`, adminToken, 'POST', { couponCode: ' v224promo ' }),
      { params: Promise.resolve({ id: orderId }) },
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { discount?: number; discountId?: string; name?: string }
    expect(j.discount).toBe(1) // 10 % od 10 €
    expect(j.discountId).toBe(promoId)
    expect(j.name).toBe(`${PREFIX}Promo 10 %`)
    const fresh = await db.discount.findUnique({ where: { id: promoId } })
    expect(fresh?.currentUses).toBe(1) // delitev kvote registra
    // naročilo nosi popust (kanonično polje Order.discount)
    const order = await db.order.findUnique({ where: { id: orderId } })
    expect(Number(order?.discount)).toBe(1)
  })

  test('404: neznana koda pošteno pove OBA vira (osebni kupon + promo koda)', async () => {
    const orderId = await seedOrder()
    const res = await discountPOST(
      req(`/api/orders/${orderId}/discount`, adminToken, 'POST', { couponCode: 'V224NEZNANA' }),
      { params: Promise.resolve({ id: orderId }) },
    )
    expect(res.status).toBe(404)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('ni osebnega kupona niti aktivne promo kode')
  })

  test("404: promo koda z 'auto' (Happy Hour) sprožilcem NE velja za ročni vnos", async () => {
    await db.discount.create({
      data: { id: `${PREFIX}d2-${RUN}`, name: `${PREFIX}HappyHour`, type: 'percent', amount: 20, triggerType: 'auto', promoCode: 'V224AUTO', isActive: true, locationId: locId },
    })
    const orderId = await seedOrder()
    const res = await discountPOST(
      req(`/api/orders/${orderId}/discount`, adminToken, 'POST', { couponCode: 'V224AUTO' }),
      { params: Promise.resolve({ id: orderId }) },
    )
    expect(res.status).toBe(404) // auto se aplicira sam ob plačilu — ročna koda ga ne sme obiti
    const order = await db.order.findUnique({ where: { id: orderId } })
    expect(Number(order?.discount)).toBe(0)
  })

  test('400: pretekla promo koda se zavrne z besedilom promo veje', async () => {
    await db.discount.create({
      data: { id: `${PREFIX}d3-${RUN}`, name: `${PREFIX}Pretekla`, type: 'fixed', amount: 2, triggerType: 'manual', promoCode: 'V224STARA', isActive: true, locationId: locId, validTo: new Date('2020-01-01') },
    })
    const orderId = await seedOrder()
    const res = await discountPOST(
      req(`/api/orders/${orderId}/discount`, adminToken, 'POST', { couponCode: 'V224STARA' }),
      { params: Promise.resolve({ id: orderId }) },
    )
    expect(res.status).toBe(400)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('Promo koda je pretekla')
  })

  test('409: izčrpana kvota promo kode se zavrne (delitev semantike registra)', async () => {
    await db.discount.create({
      data: { id: `${PREFIX}d4-${RUN}`, name: `${PREFIX}Enkratna`, type: 'fixed', amount: 1, triggerType: 'manual', promoCode: 'V224ENKRAT', maxUses: 1, currentUses: 1, isActive: true, locationId: locId },
    })
    const orderId = await seedOrder()
    const res = await discountPOST(
      req(`/api/orders/${orderId}/discount`, adminToken, 'POST', { couponCode: 'V224ENKRAT' }),
      { params: Promise.resolve({ id: orderId }) },
    )
    expect(res.status).toBe(409)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('omejitev uporabe')
  })

  test('statika: fallback pot išče SAMO aktivne popuste te lokacije z neprazno kodo, brez auto', () => {
    const src = read('src/app/api/orders/[id]/discount/route.ts')
    expect(src).toContain("promoCode: { not: '' }")
    expect(src).toContain("(d.promoCode || '').trim().toUpperCase() === code")
    expect(src).toContain("d.triggerType !== 'auto'")
    // osebni kupon ostane PRVI vir (vrstni red iskanja)
    expect(src.indexOf('db.coupon.findUnique')).toBeLessThan(src.indexOf('db.discount.findMany'))
  })

  test('statika: UI oznaka/sporočilo/placeholder pokrivata oba vira (SL + HR)', () => {
    expect(read('src/lib/i18n/sl.ts')).toContain("'cp.label': 'Kupon / promo koda'")
    expect(read('src/lib/i18n/hr.ts')).toContain("'cp.label': 'Kupon / promo kod'")
    expect(read('src/lib/i18n/sl.ts')).toContain("'cp.applied': 'Koda je uporabljena — popust je na računu.'")
    expect(read('src/app/dashboard/page.tsx')).toContain('placeholder="BD26-XXXXXXXX / PROMO10"')
  })
})

/* ── C2 · P2 — dedup člana zvestobe po telefonu ────────────────────────── */

describe('v224 C2 · loyalty — isti telefon na isti lokaciji = en račun', () => {
  test('201: prvi član z mednarodno obliko (+386 …) se ustvari', async () => {
    const res = await loyaltyPOST(req('/api/loyalty', adminToken, 'POST', { guestName: `${PREFIX}Ana Horvat`, phone: '+386 40 555 666', locationId: locId }))
    expect(res.status).toBe(201)
  })

  test('409: isti telefon v DRUGI zapisni obliki (00386 …) → zavrnjen z imenom obstoječega', async () => {
    const res = await loyaltyPOST(req('/api/loyalty', adminToken, 'POST', { guestName: `${PREFIX}Dvojnik`, phone: '00386 40 555 666', locationId: locId }))
    expect(res.status).toBe(409)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('že ima račun zvestobe')
    expect(j.error).toContain(`${PREFIX}Ana Horvat`)
    // na lokaciji obstaja SAMO en račun s to številko
    const rows = await db.loyaltyAccount.findMany({ where: { locationId: locId, customerName: { in: [`${PREFIX}Ana Horvat`, `${PREFIX}Dvojnik`] } } })
    expect(rows.length).toBe(1)
  })

  test('201: drugačen telefon in prazen telefon gresta skozi (ime ni identiteta)', async () => {
    const a = await loyaltyPOST(req('/api/loyalty', adminToken, 'POST', { guestName: `${PREFIX}Ana Horvat`, phone: '040999888', locationId: locId }))
    expect(a.status).toBe(201) // isto ime, druga številka — zakonito
    const b = await loyaltyPOST(req('/api/loyalty', adminToken, 'POST', { guestName: `${PREFIX}Brez telefona`, phone: '', locationId: locId }))
    expect(b.status).toBe(201) // brez telefona ni preverbe
  })

  test('statika: dedup uporablja normalizePhoneDigits (CRM disciplina) z varovalko dolžine', () => {
    const src = read('src/app/api/loyalty/route.ts')
    expect(src).toContain("import { normalizePhoneDigits } from '@/lib/crm'")
    expect(src).toContain('digits.length >= 6')
    // obseg: SAMO ista lokacija (večlokalni gost ima račun povsod)
    expect(src).toContain('where: { locationId: loc },')
  })
})

/* ── verzija ───────────────────────────────────────────────────────────── */

describe('v224 Č · verzija + dokumentacija', () => {
  test('verzija je dvignjena na 1.238.0 (version.ts)', () => {
    expect(APP_VERSION).toBe('1.303.0')
    expect(read('src/lib/version.ts')).toContain("'1.303.0'")
  })

  test('compose oznaka slike sledi verziji (selfhost pogodba)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('image: restaurantos:1.303.0')
  })

  test('PRD nosi zapis QA-vala v1.227.0 (doc-truth)', () => {
    expect(read('docs/PRD-LOKALNA-BAZA.md')).toContain('QA-val v1.227.0')
  })

  test('worklog vnos na vrhu (Task ID: v1.228.0)', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.303.0-nadzorni-val-stabilnosti-iv')
    expect(wl.indexOf('Task ID: v1.227.0')).toBeLessThan(wl.indexOf('Task ID: v1.224.0'))
  })
})
