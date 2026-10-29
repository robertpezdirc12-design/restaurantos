import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  birthdayInYear,
  nextBirthday,
  birthdayInWindow,
  generateCouponCode,
  normalizeCouponCode,
  couponAmountOf,
  couponStatusAt,
  birthdayCouponExpiry,
  BIRTHDAY_COUPON_PERCENT,
} from '../src/lib/coupons'
import { issueBirthdayCoupons } from '../src/lib/coupons-run'
import { GET as couponsGET, POST as couponsPOST } from '../src/app/api/coupons/route'
import { PATCH as couponPATCH } from '../src/app/api/coupons/[id]/route'
import { POST as discountPOST } from '../src/app/api/orders/[id]/discount/route'

/**
 * P2-10b (v1.187.0) — ROJSTNODNEVNI KUPONI.
 *
 * Zadnji del tržne vrzeli P2-10 (docs/TRZNA-VRZELI-2026.md §4): kampanje z
 * segmenti (win-back) so zaprte od v1.126.0; ta izdaja doda samodejni osebni
 * rojstnodnevni kupon + ročno izdajo + odkup skozi kanonično popustno jedro.
 *
 * Merila:
 *  Č1 čisti sloj: pojavljanje rojstnega dne (29. 2. → 28. 2. v ne-prestopnem),
 *     okno izdaje (robovi vključeni), koda (format + abeceda brez zamenljivih),
 *     znesek (odstotek/fiksni, omejen na osnovo), izpeljano stanje (expired).
 *  Č2 pravice: 401 brez žetona, 403 CLEANER (settings.manage) na GET/POST/PATCH.
 *  Č3 ročna izdaja: validacije (404 gost, 400 oboje/nič/neveljaven odstotek/
 *     pretekel datum), srečen tok (201, format kode, GET seznam, privzeta poteč).
 *  Č4 preklic: issued → void, ponovni preklic 409, redeemed 409.
 *  Č5 cron izdaja: rojstni dan danes → 1 kupon (15 %, leto pojavljanja, poteče
 *     pojavljanje+30 dni), idempotenca (ponovni tek → skipped), zunaj okna → 0,
 *     29. 2. v ne-prestopnem letu → izdano 28. 2. z letom pojavljanja.
 *  Č6 odkup (discount ruta, vir 'coupon'): srečen tok (znesek = 15 % osnove,
 *     kupon redeemed z orderId, audit DISCOUNT_APPLIED), ponovni odkup 409,
 *     naročilo brez gosta 400, tuji gost 400, pretekel 409, preklican 409,
 *     neznana koda 404, oboje (couponCode + discountId) 400.
 *
 * ID-ji s predpono `v187cp-` (sweep beforeAll, cleanup afterAll).
 */

const PREFIX = 'v187cp-'
const RUN = Date.now().toString(36)

let locId = ''
let adminId = ''
let adminToken = ''
let noPermToken = ''
let menuItemId = ''
/** fiksni "danes" za deterministične cron teste (pravi današnji dan, podneven) */
function todayNow(): Date {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12, 0, 0, 0)
}

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

async function seedGuest(name: string, birthday: Date | null, email = ''): Promise<string> {
  const row = await db.guest.create({
    data: { id: `${PREFIX}g${name}-${RUN}`, firstName: `${PREFIX}${name}`, lastName: 'Test', birthday, email, locationId: locId },
  })
  return row.id
}

async function seedOrder(guestId: string | null): Promise<string> {
  const row = await db.order.create({
    data: {
      id: `${PREFIX}o${itemSeq + 1}-${RUN}`, locationId: locId, orderNumber: 963000 + (++itemSeq),
      status: 'open', paymentStatus: 'unpaid', ...(guestId ? { guestId } : {}),
    },
  })
  return row.id
}

/** Rojstni dan: isti mesec/dan kot `ref`, leto rojstva 1990. */
function birthdaySameDay(ref: Date): Date {
  return new Date(1990, ref.getMonth(), ref.getDate(), 12, 0, 0, 0)
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `V187-${RUN.toUpperCase()}`, premisesId: `${PREFIX}prem-${RUN}`, country: 'SI' },
  })
  locId = loc.id
  adminId = `${PREFIX}admin-${RUN}`
  const adminPin = employeePinFields(`7${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locId, ...adminPin },
  })
  const cleanPin = employeePinFields(`6${RUN.slice(-5)}`, `${PREFIX}clean-${RUN}@test.local`)
  const cleaner = await db.employee.create({
    data: { id: `${PREFIX}clean-${RUN}`, name: `${PREFIX}Cistilka`, email: `${PREFIX}clean-${RUN}@test.local`, role: 'CLEANER', status: 'active', sessionVersion: 0, locationId: locId, ...cleanPin },
  })
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locId } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
  menuItemId = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: `${PREFIX}Artikel`, price: 10, categoryId: cat.id } })).id
  adminToken = createToken({ sub: adminId, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locId, sv: 0 })
  noPermToken = createToken({ sub: cleaner.id, name: `${PREFIX}Cistilka`, role: 'CLEANER', loc: locId, sv: 0 })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

/* ────────────────────────── Č1 — čisti sloj ────────────────────────── */

describe('v1.187.0 P2-10b — čisti sloj', () => {
  test('birthdayInYear: 29. 2. v ne-prestopnem letu → 28. 2.; normalen datum ohrani', () => {
    const leap = birthdayInYear(new Date(2000, 1, 29, 12), 2024) // prestopno
    expect(leap.getMonth()).toBe(1)
    expect(leap.getDate()).toBe(29)
    const nonLeap = birthdayInYear(new Date(2000, 1, 29, 12), 2026) // ne-prestopno
    expect(nonLeap.getMonth()).toBe(1)
    expect(nonLeap.getDate()).toBe(28)
    const normal = birthdayInYear(new Date(1990, 4, 17, 12), 2026)
    expect(normal.getFullYear()).toBe(2026)
    expect(normal.getMonth()).toBe(4)
    expect(normal.getDate()).toBe(17)
  })

  test('nextBirthday: danes → danes; preteklost → naslednje leto; prihodnost → to leto', () => {
    const now = new Date(2026, 5, 15, 10, 0, 0, 0) // 15. 6. 2026
    expect(nextBirthday(new Date(1990, 5, 15, 12), now).getTime()).toBe(new Date(2026, 5, 15, 12).getTime())
    expect(nextBirthday(new Date(1990, 5, 14, 12), now).getFullYear()).toBe(2027)
    expect(nextBirthday(new Date(1990, 5, 20, 12), now).getFullYear()).toBe(2026)
  })

  test('birthdayInWindow: robovi vključeni, zunaj okna izključeni', () => {
    const now = new Date(2026, 5, 15, 10, 0, 0, 0)
    expect(birthdayInWindow(new Date(1990, 5, 15, 12), now, 3)).toBe(true) // danes
    expect(birthdayInWindow(new Date(1990, 5, 18, 12), now, 3)).toBe(true) // +3 (rob)
    expect(birthdayInWindow(new Date(1990, 5, 19, 12), now, 3)).toBe(false) // +4
    expect(birthdayInWindow(new Date(1990, 5, 14, 12), now, 3)).toBe(false) // včeraj → naslednje leto
    // 29. 2. v ne-prestopnem letu: pojavljanje 28. 2. je v oknu dneva 28. 2.
    const feb28 = new Date(2026, 1, 28, 10, 0, 0, 0)
    expect(birthdayInWindow(new Date(2000, 1, 29, 12), feb28, 0)).toBe(true)
  })

  test('generateCouponCode: format BD{YY}-{8} iz abecede brez zamenljivih; rng določa', () => {
    // determinističen rng (vedno 0 → prvi znak 'A') pokaže, da rng res določa kodo
    expect(generateCouponCode(2026, () => 0)).toBe('BD26-AAAAAAAA')
    // 200 naključnih: format + noben zamenljiv znak (O, I, 0, 1)
    for (let k = 0; k < 200; k++) {
      const c = generateCouponCode(2026)
      expect(c).toMatch(/^BD\d{2}-[A-Z2-9]{8}$/)
      expect(c).not.toMatch(/[OI01]/)
    }
  })

  test('normalizeCouponCode: trim + VELIKE + omejitev dolžine', () => {
    expect(normalizeCouponCode('  bd26-abcd  ')).toBe('BD26-ABCD')
    expect(normalizeCouponCode(null)).toBe('')
  })

  test('couponAmountOf: odstotek in fiksni, OMEJENO na osnovo, r2', () => {
    expect(couponAmountOf({ percent: 15, fixedAmount: 0 }, 10)).toBe(1.5)
    expect(couponAmountOf({ percent: 200, fixedAmount: 0 }, 10)).toBe(10) // odstotek omejen na 100
    expect(couponAmountOf({ percent: null, fixedAmount: 25 }, 10)).toBe(10) // fiksni omejen na osnovo
    expect(couponAmountOf({ percent: null, fixedAmount: 7.777 }, 100)).toBe(7.78)
    expect(couponAmountOf({ percent: 15, fixedAmount: 0 }, 0)).toBe(0)
  })

  test('couponStatusAt: issued + pretekel → expired; ostali passthrough', () => {
    const now = new Date(2026, 5, 15, 12)
    expect(couponStatusAt({ status: 'issued', expiresAt: new Date(2026, 5, 14) }, now)).toBe('expired')
    expect(couponStatusAt({ status: 'issued', expiresAt: new Date(2026, 5, 16) }, now)).toBe('issued')
    expect(couponStatusAt({ status: 'redeemed', expiresAt: new Date(2020, 0, 1) }, now)).toBe('redeemed')
    expect(couponStatusAt({ status: 'void', expiresAt: new Date(2020, 0, 1) }, now)).toBe('void')
  })

  test('birthdayCouponExpiry: pojavljanje + 30 dni, do konca dneva', () => {
    const e = birthdayCouponExpiry(new Date(2026, 5, 15, 12))
    expect(e.getFullYear()).toBe(2026)
    expect(e.getMonth()).toBe(6)
    expect(e.getDate()).toBe(15)
    expect(e.getHours()).toBe(23)
  })
})

/* ────────────────────────── Č2 — pravice ────────────────────────── */

describe('v1.187.0 P2-10b — pravice', () => {
  test('Č2a GET brez žetona → 401; CLEANER → 403', async () => {
    expect((await couponsGET(req('/api/coupons', null, 'GET'))).status).toBe(401)
    expect((await couponsGET(req('/api/coupons', noPermToken, 'GET'))).status).toBe(403)
  })

  test('Č2b POST brez žetona → 401; CLEANER → 403', async () => {
    expect((await couponsPOST(req('/api/coupons', null, 'POST', { guestId: 'x', percent: 10 }))).status).toBe(401)
    expect((await couponsPOST(req('/api/coupons', noPermToken, 'POST', { guestId: 'x', percent: 10 }))).status).toBe(403)
  })

  test('Č2c PATCH brez žetona → 401; CLEANER → 403', async () => {
    expect((await couponPATCH(req('/api/coupons/x', null, 'PATCH', {}), { params: Promise.resolve({ id: 'x' }) })).status).toBe(401)
    expect((await couponPATCH(req('/api/coupons/x', noPermToken, 'PATCH', {}), { params: Promise.resolve({ id: 'x' }) })).status).toBe(403)
  })
})

/* ────────────────────────── Č3/Č4 — ročna izdaja + preklic ────────────────────────── */

describe('v1.187.0 P2-10b — ročna izdaja (POST/GET/PATCH /api/coupons)', () => {
  let guestId = ''
  let couponId = ''
  let couponCodeVal = ''

  test('Č3a validacije: 404 gost, 400 oboje, 400 nič, 400 odstotek, 400 poteč', async () => {
    const g = await seedGuest('v', birthdaySameDay(todayNow()))
    guestId = g
    expect((await couponsPOST(req('/api/coupons', adminToken, 'POST', { guestId: `${PREFIX}manjka-${RUN}`, percent: 10 }))).status).toBe(404)
    expect((await couponsPOST(req('/api/coupons', adminToken, 'POST', { guestId: g, percent: 10, fixedAmount: 5 }))).status).toBe(400)
    expect((await couponsPOST(req('/api/coupons', adminToken, 'POST', { guestId: g }))).status).toBe(400)
    for (const bad of [0, 101, 12.5]) {
      expect((await couponsPOST(req('/api/coupons', adminToken, 'POST', { guestId: g, percent: bad }))).status, `percent=${bad}`).toBe(400)
    }
    expect((await couponsPOST(req('/api/coupons', adminToken, 'POST', { guestId: g, percent: 10, expiresAt: new Date(Date.now() - 3600_000).toISOString() }))).status).toBe(400)
  })

  test('Č3b srečen tok: 201, format kode, privzeta poteča (+30 dni), GET seznam', async () => {
    const res = await couponsPOST(req('/api/coupons', adminToken, 'POST', { guestId, percent: 10, note: `${PREFIX}ročni` }))
    expect(res.status).toBe(201)
    const j = (await res.json()) as { coupon: { id: string; code: string; percent: number; expiresAt: string } }
    couponId = j.coupon.id
    couponCodeVal = j.coupon.code
    expect(j.coupon.code).toMatch(/^BD\d{2}-[A-Z2-9]{8}$/)
    expect(j.coupon.percent).toBe(10)
    const days = (new Date(j.coupon.expiresAt).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(28.5)
    expect(days).toBeLessThan(31.5)

    const list = await couponsGET(req(`/api/coupons?guestId=${encodeURIComponent(guestId)}`, adminToken, 'GET'))
    expect(list.status).toBe(200)
    const lj = (await list.json()) as { coupons: { id: string; reason: string; status: string }[] }
    expect(lj.coupons.some((c) => c.id === couponId && c.reason === 'manual' && c.status === 'issued')).toBe(true)
  })

  test('Č3c filter po statusu/reasonu deluje', async () => {
    const list = await couponsGET(req('/api/coupons?status=void&reason=manual', adminToken, 'GET'))
    expect(list.status).toBe(200)
    const lj = (await list.json()) as { coupons: { status: string }[] }
    expect(lj.coupons.every((c) => c.status === 'void')).toBe(true)
  })

  test('Č4a preklic: issued → void; ponovni preklic → 409; neznani → 404', async () => {
    const res = await couponPATCH(req(`/api/coupons/${couponId}`, adminToken, 'PATCH', { note: 'napačno izdan' }), { params: Promise.resolve({ id: couponId }) })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { coupon: { status: string } }
    expect(j.coupon.status).toBe('void')
    expect((await couponPATCH(req(`/api/coupons/${couponId}`, adminToken, 'PATCH', {}), { params: Promise.resolve({ id: couponId }) })).status).toBe(409)
    expect((await couponPATCH(req(`/api/coupons/${PREFIX}manjka-${RUN}`, adminToken, 'PATCH', {}), { params: Promise.resolve({ id: `${PREFIX}manjka-${RUN}` }) })).status).toBe(404)
  })
})

/* ────────────────────────── Č5 — cron izdaja ────────────────────────── */

describe('v1.187.0 P2-10b — cron izdaja (issueBirthdayCoupons)', () => {
  test('Č5a rojstni dan danes → kupon 15 %, idempotenca, zunaj okna → 0', async () => {
    const now = todayNow()
    const todayGuest = await seedGuest('bday', birthdaySameDay(now))
    await seedGuest('later', new Date(1985, now.getMonth(), now.getDate() + 10, 12)) // 10 dni naprej → zunaj okna 3

    const run1 = await issueBirthdayCoupons({ now, actor: 'test', sendEmail: false })
    expect(run1.issued).toBeGreaterThanOrEqual(1)
    const c = await db.coupon.findFirst({ where: { guestId: todayGuest, reason: 'birthday' } })
    expect(c).not.toBeNull()
    expect(c!.percent).toBe(BIRTHDAY_COUPON_PERCENT)
    expect(c!.year).toBe(now.getFullYear())
    expect(c!.status).toBe('issued')
    // poteče: dan pojavljanja + 30 dni (obalka dneva 23:59:59) — pojavljanje je DANES
    const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30, 23, 59, 59, 0)
    const exp = c!.expiresAt
    expect(exp.getFullYear()).toBe(expected.getFullYear())
    expect(exp.getMonth()).toBe(expected.getMonth())
    expect(exp.getDate()).toBe(expected.getDate())

    // ponovni tek: vse skipped (idempotenca po (gost, reason, year))
    const run2 = await issueBirthdayCoupons({ now, actor: 'test', sendEmail: false })
    expect(run2.issued).toBe(0)
    expect(run2.skipped).toBeGreaterThanOrEqual(1)

    // zunaj okna: 'later' gost brez kupona
    const laterCount = await db.coupon.count({ where: { reason: 'birthday', Guest: { id: { startsWith: `${PREFIX}glater-` } } } })
    expect(laterCount).toBe(0)
  })

  test('Č5b 29. 2. v ne-prestopnem letu → izdano 28. 2. z letom pojavljanja 2026', async () => {
    const now = new Date(2026, 1, 28, 10, 0, 0, 0) // 28. 2. 2026 (ne-prestopno)
    const leapGuest = await seedGuest('leap', new Date(2000, 1, 29, 12))
    const run = await issueBirthdayCoupons({ now, actor: 'test', sendEmail: false })
    expect(run.issued).toBeGreaterThanOrEqual(1)
    const c = await db.coupon.findFirst({ where: { guestId: leapGuest, reason: 'birthday' } })
    expect(c).not.toBeNull()
    expect(c!.year).toBe(2026)
    // pojavljanje 28. 2. → poteča 30 dni kasneje (30. 3.)
    expect(c!.expiresAt.getMonth()).toBe(2)
    expect(c!.expiresAt.getDate()).toBe(30)
  })
})

/* ────────────────────────── Č6 — odkup (discount ruta) ────────────────────────── */

describe('v1.187.0 P2-10b — odkup kupona (POST /api/orders/[id]/discount { couponCode })', () => {
  let g1 = ''
  let g2 = ''

  beforeAll(async () => {
    g1 = await seedGuest('r1', birthdaySameDay(todayNow()))
    g2 = await seedGuest('r2', birthdaySameDay(todayNow()))
  })

  test('Č6a srečen tok: 15 % osnove, kupon redeemed z orderId, audit DISCOUNT_APPLIED', async () => {
    const now = todayNow()
    await issueBirthdayCoupons({ now, actor: 'test', sendEmail: false })
    const c = await db.coupon.findFirst({ where: { guestId: g1, reason: 'birthday' } })
    expect(c).not.toBeNull()
    const orderId = await seedOrder(g1)
    await seedItem(orderId, 'Kava', 10) // osnova 10 → 15 % = 1,5

    const res = await discountPOST(req(`/api/orders/${orderId}/discount`, adminToken, 'POST', { couponCode: c!.code.toLowerCase() }), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { discount: number; name: string }
    expect(j.discount).toBe(1.5)
    expect(j.name).toContain(c!.code)

    const after = await db.coupon.findUnique({ where: { id: c!.id } })
    expect(after!.status).toBe('redeemed')
    expect(after!.orderId).toBe(orderId)
    expect(after!.redeemedAt).not.toBeNull()
    const order = await db.order.findUnique({ where: { id: orderId } })
    expect(Number(order!.discount)).toBe(1.5)
    const audits = await db.auditLog.findMany({ where: { action: 'DISCOUNT_APPLIED', entityId: orderId } })
    expect(audits.length).toBe(1)
    expect(audits[0].details).toContain('couponCode')
  })

  test('Č6b ponovni odkup istega kupona → 409 (drugo naročilo)', async () => {
    const now = todayNow()
    await issueBirthdayCoupons({ now, actor: 'test', sendEmail: false })
    const c = await db.coupon.findFirst({ where: { guestId: g2, reason: 'birthday' } })
    const o1 = await seedOrder(g2)
    await seedItem(o1, 'Kava', 10)
    const first = await discountPOST(req(`/api/orders/${o1}/discount`, adminToken, 'POST', { couponCode: c!.code }), { params: Promise.resolve({ id: o1 }) })
    expect(first.status).toBe(200)
    // drugo naročilo istega gosta — kupon je že odkupljen
    const o2 = await seedOrder(g2)
    await seedItem(o2, 'Sok', 8)
    const second = await discountPOST(req(`/api/orders/${o2}/discount`, adminToken, 'POST', { couponCode: c!.code }), { params: Promise.resolve({ id: o2 }) })
    expect(second.status).toBe(409)
    // naročilo o2 ostane brez popusta (rollback)
    const fresh = await db.order.findUnique({ where: { id: o2 } })
    expect(Number(fresh!.discount)).toBe(0)
  })

  test('Č6c naročilo brez gosta → 400', async () => {
    // svež ročni kupon za g1 (cron-izdani so že porabljeni v prejšnjih primerih)
    const created = await couponsPOST(req('/api/coupons', adminToken, 'POST', { guestId: g1, percent: 10 }))
    const { coupon } = (await created.json()) as { coupon: { code: string } }
    const o = await seedOrder(null)
    await seedItem(o, 'Kava', 10)
    const res = await discountPOST(req(`/api/orders/${o}/discount`, adminToken, 'POST', { couponCode: coupon.code }), { params: Promise.resolve({ id: o }) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('gosta')
  })

  test('Č6d tuji gost → 400', async () => {
    // svež ročni kupon za g2, nese ga naročilo g1
    const created = await couponsPOST(req('/api/coupons', adminToken, 'POST', { guestId: g2, percent: 10 }))
    const { coupon } = (await created.json()) as { coupon: { code: string } }
    const o = await seedOrder(g1)
    await seedItem(o, 'Kava', 10)
    const res = await discountPOST(req(`/api/orders/${o}/discount`, adminToken, 'POST', { couponCode: coupon.code }), { params: Promise.resolve({ id: o }) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('temu gostu')
  })

  test('Č6e pretekel kupon → 409 (izpeljano ob odkupu)', async () => {
    const guest = await seedGuest('exp', null)
    const created = await couponsPOST(req('/api/coupons', adminToken, 'POST', { guestId: guest, percent: 10 }))
    const { coupon } = (await created.json()) as { coupon: { id: string; code: string } }
    await db.coupon.update({ where: { id: coupon.id }, data: { expiresAt: new Date(Date.now() - 86_400_000) } })
    const o = await seedOrder(guest)
    await seedItem(o, 'Kava', 10)
    const res = await discountPOST(req(`/api/orders/${o}/discount`, adminToken, 'POST', { couponCode: coupon.code }), { params: Promise.resolve({ id: o }) })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('pretekel')
  })

  test('Č6f preklican kupon → 409', async () => {
    const guest = await seedGuest('void', null)
    const created = await couponsPOST(req('/api/coupons', adminToken, 'POST', { guestId: guest, percent: 10 }))
    const { coupon } = (await created.json()) as { coupon: { id: string; code: string } }
    await couponPATCH(req(`/api/coupons/${coupon.id}`, adminToken, 'PATCH', {}), { params: Promise.resolve({ id: coupon.id }) })
    const o = await seedOrder(guest)
    await seedItem(o, 'Kava', 10)
    const res = await discountPOST(req(`/api/orders/${o}/discount`, adminToken, 'POST', { couponCode: coupon.code }), { params: Promise.resolve({ id: o }) })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('preklican')
  })

  test('Č6g neznana koda → 404; oboje (couponCode+discountId) → 400', async () => {
    const o = await seedOrder(g1)
    await seedItem(o, 'Kava', 10)
    const unknown = await discountPOST(req(`/api/orders/${o}/discount`, adminToken, 'POST', { couponCode: 'BD99-NEZNANA' }), { params: Promise.resolve({ id: o }) })
    expect(unknown.status).toBe(404)
    const both = await discountPOST(req(`/api/orders/${o}/discount`, adminToken, 'POST', { couponCode: 'BD99-XXX', discountId: 'karkoli' }), { params: Promise.resolve({ id: o }) })
    expect(both.status).toBe(400)
  })
})
