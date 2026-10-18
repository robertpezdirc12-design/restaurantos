/**
 * Issues #43 + #44 + #45 + #46 (P1) — loyalty/kvota popusta/darilne kartice val.
 *
 * #43 — loyalty POST: kanonična lokacija (requireUserLocation + assertOrgScope),
 *   BREZ findFirst() fallbacka: staff = strežniško svoja lokacija (body ignoriran),
 *   centralni brez loc + brez locationId → 400; centralni orgA → tuja orgB 403;
 *   neobstoječa lokacija → 404; audit z locationId.
 * #44 — loyalty PATCH: saldo + ledger + tier + audit v ENI transakciji (anchor →
 *   fresh read → poslovna meja odpisa → write → ledger → audit); delta=-50 na
 *   saldu 10 → 409 (ne tihi clamp), sočasna odbitka → [200,409] (izgubljeni
 *   update nemogoč), sočasna prirasta → oba uspeta; meja ±1.000.000; cross-tenant
 *   403 ostaja.
 * #45 — popust na naročilu: VSA validacija PRED kvoto (ničelen znesek → 400,
 *   currentUses nedotaknjen); naročilo + kvota + audit v ENI $transaction;
 *   CAS paymentStatus(unpaid/partial) + dosedanja vrednost discount — plačano
 *   med branjem → 409 + kvota ROLLBACK; dva sočasna POSTa → [200,409], kvota 1;
 *   obstoječi popust → 409 (eksplicitna zamenjava); DELETE CAS v samem update-u.
 * #46 — giftcard lookup: orders.pay pravica (kuhinja 403); q < 6 znakov → 400
 *   BREZ DB poizvedbe; 6-mestni suffix + polna številka delujeta; odgovor BREZ
 *   locationId; rate limit 30/min (uporabnik+IP) → 31. = 429 + agregirana revizija.
 *
 * Fiksture s predpono i4346- (LoyaltyTransaction z nid() id-ji se počisti ročno
 * PRED sweep — FK Restrict; revizija rate-limit zavrnitev entityId='' prav tako).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { __resetRateLimitForTests } from '../src/lib/rate-limit'
import { POST as loyaltyPOST, PATCH as loyaltyPATCH } from '../src/app/api/loyalty/route'
import { POST as discountPOST, DELETE as discountDELETE } from '../src/app/api/orders/[id]/discount/route'
import { GET as gcLookupGET } from '../src/app/api/giftcards/lookup/route'

const P = 'i4346-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let locB = ''
let orgA = ''
let orgB = ''
let locOA = ''
let locOB = ''
let miA = ''
let tokMgrA = ''
let tokMgrB = ''
// issue #72 C1: loyalty POST/PATCH = settings.manage → MANAGER nima več;
// property_manager = poln nabor, a LOKACIJSKO vezan (ne-centralen)
let tokPmA = ''
let tokPmB = ''
let tokWaiter = ''
let tokKitchen = ''
let tokCentral = ''
let tokAdminOA = ''

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

async function seedEmployee(name: string, role: string, loc: string | null, seq: number, overrides: string[] = []): Promise<string> {
  const id = `${P}${name}-${RUN}`
  const pin = `${PIN_BASE}${seq}`
  const f = employeePinFields(pin, `${P}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${P}${name}`, email: `${P}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
      ...(overrides.length ? { permissionOverrides: JSON.stringify(overrides) } : {}),
    },
  })
  return id
}

let ordSeq = 0
async function seedOrder(loc: string, opts: { paymentStatus?: 'unpaid' | 'partial' | 'paid'; withItem?: boolean } = {}) {
  const id = `${P}o${++ordSeq}-${RUN}`
  await db.order.create({
    data: {
      id,
      orderNumber: 46100 + ordSeq,
      locationId: loc,
      tableId: null,
      status: 'open',
      paymentStatus: opts.paymentStatus ?? 'unpaid',
      subtotal: 5, tax: 1.1, total: 6.1,
    },
  })
  if (opts.withItem !== false) {
    await db.orderItem.create({
      data: {
        id: `${P}itm${ordSeq}-${RUN}`, orderId: id, menuItemId: miA,
        quantity: 1, price: 5, vatRate: 22, vatAmount: 1.1,
        menuItemName: `${P}Jed`, status: 'pending', voided: false,
      },
    })
  }
  return id
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

async function seedAccount(points: number, loc: string) {
  return db.loyaltyAccount.create({
    data: {
      id: `${P}acc${++ordSeq}-${RUN}`, customerName: `${P}Gost ${ordSeq}`,
      customerPhone: '', pointsBalance: points, lifetimePoints: points,
      tier: 'bronze', locationId: loc,
    },
  })
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  __resetRateLimitForTests()
  locA = `${P}locA-${RUN}`
  locB = `${P}locB-${RUN}`
  await db.location.create({ data: { id: locA, code: `${P}LA`, name: `${P}Lokacija A`, premisesId: `${P}premA-${RUN}` } })
  await db.location.create({ data: { id: locB, code: `${P}LB`, name: `${P}Lokacija B`, premisesId: `${P}premB-${RUN}` } })
  // org drevo za assertOrgScope test (#43): orgA ↔ orgB ločena
  orgA = `${P}orgA-${RUN}`
  orgB = `${P}orgB-${RUN}`
  const brandA = `${P}brandA-${RUN}`
  const brandB = `${P}brandB-${RUN}`
  const propA = `${P}propA-${RUN}`
  const propB = `${P}propB-${RUN}`
  locOA = `${P}locOA-${RUN}`
  locOB = `${P}locOB-${RUN}`
  await db.organization.create({ data: { id: orgA, name: `${P}Org A`, slug: `${P}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: `${P}Org B`, slug: `${P}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: `${P}Znamka A` } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: `${P}Znamka B` } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: `${P}Objekt A` } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: `${P}Objekt B` } })
  await db.location.create({ data: { id: locOA, code: `${P}OA`, name: `${P}Lokacija OA`, propertyId: propA } })
  await db.location.create({ data: { id: locOB, code: `${P}OB`, name: `${P}Lokacija OB`, propertyId: propB } })
  // meni/artikel za OrderItem FK (Restrict)
  const menuA = await db.menu.create({ data: { id: `${P}menuA-${RUN}`, name: `${P}Meni A`, locationId: locA } })
  const catA = await db.category.create({ data: { id: `${P}catA-${RUN}`, name: `${P}Kat A`, menuId: menuA.id } })
  miA = (await db.menuItem.create({ data: { id: `${P}miA-${RUN}`, name: `${P}Jed A`, price: 5, categoryId: catA.id } })).id
  // darilna kartica za lookup (#46)
  await db.giftCard.create({
    data: { id: `${P}gc1-${RUN}`, cardNumber: `GC-20261014-461001`, balance: 25, initialBalance: 25, status: 'active', ownerName: `${P}Lastnik`, locationId: locA },
  })

  const mgrA = await seedEmployee('mgrA', 'manager', locA, 1)
  const mgrB = await seedEmployee('mgrB', 'manager', locB, 2)
  const waiter = await seedEmployee('waiter', 'waiter', locA, 3)
  const kitchen = await seedEmployee('kitchen', 'kitchen', locA, 4)
  const central = await seedEmployee('central', 'admin', null, 5)
  const adminOA = await seedEmployee('adminOA', 'admin', locOA, 6)
  // ISSUE #75 5.1: property_manager = Razširjena raven — testni namen »ne-centralen
  // imetnik settings.manage« zdaj izrecen prek centralno podeljenega override-a
  const pmA = await seedEmployee('pmA', 'property_manager', locA, 7, ['settings.manage'])
  const pmB = await seedEmployee('pmB', 'property_manager', locB, 8, ['settings.manage'])
  tokMgrA = tok(mgrA, `${P}mgrA`, 'MANAGER', locA)
  tokMgrB = tok(mgrB, `${P}mgrB`, 'MANAGER', locB)
  tokWaiter = tok(waiter, `${P}waiter`, 'WAITER', locA)
  tokKitchen = tok(kitchen, `${P}kitchen`, 'KITCHEN', locA)
  tokCentral = tok(central, `${P}central`, 'ADMIN', null)
  tokAdminOA = tok(adminOA, `${P}adminOA`, 'ADMIN', locOA)
  tokPmA = tok(pmA, `${P}pmA`, 'PROPERTY_MANAGER', locA)
  tokPmB = tok(pmB, `${P}pmB`, 'PROPERTY_MANAGER', locB)
})

afterAll(async () => {
  // LoyaltyTransaction id-ji so nid() (brez predpone) → počisti po loyaltyAccountId
  // PRED sweep (FK Restrict na LoyaltyAccount)
  await db.loyaltyTransaction.deleteMany({ where: { loyaltyAccountId: { startsWith: P } } }).catch(() => null)
  // rate-limit revizija ima entityId '' → počisti po akciji + uporabniku (brez PII)
  await db.auditLog.deleteMany({ where: { action: 'GIFT_CARD_LOOKUP_RATE_LIMITED', userId: { startsWith: P } } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { orderId: { startsWith: P } } }).catch(() => null)
  await db.order.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
  __resetRateLimitForTests()
})

/* ─────────────────────────── #43 — loyalty POST ─────────────────────────── */

describe('#43 — loyalty POST: kanonična lokacija (brez findFirst fallbacka)', () => {
  it('pmA (property_manager, settings.manage) ustvari račun na SVOJI lokaciji; audit nosi locationId', async () => {
    // issue #72 C1: loyalty POST zahteva settings.manage → akter = pmA (ne-centralen)
    const res = await loyaltyPOST(req('POST', '/api/loyalty', tokPmA, { guestName: `${P}Ana`, phone: '040123456' }))
    expect(res.status).toBe(201)
    const j = (await res.json()) as { account: { id: string } }
    const acc = await db.loyaltyAccount.findUnique({ where: { id: j.account.id } })
    expect(acc?.locationId).toBe(locA)
    const audit = await db.auditLog.findFirst({ where: { action: 'LOYALTY_ACCOUNT_CREATED', entityId: j.account.id } })
    expect(audit?.locationId).toBe(locA)
    expect(audit?.userId).toBe(`${P}pmA-${RUN}`)
  })

  it('poskus z body.locationB se IGNORIRA — račun ostane na lastni lokaciji', async () => {
    const res = await loyaltyPOST(req('POST', '/api/loyalty', tokPmA, { guestName: `${P}Bor`, locationId: locB }))
    expect(res.status).toBe(201)
    const j = (await res.json()) as { account: { id: string } }
    const acc = await db.loyaltyAccount.findUnique({ where: { id: j.account.id } })
    expect(acc?.locationId).toBe(locA)
  })

  it('centralni brez user.loc in brez locationId → 400, NOBEN račun ni ustvarjen (ne prva lokacija baze)', async () => {
    const before = await db.loyaltyAccount.count({ where: { id: { startsWith: P } } })
    const res = await loyaltyPOST(req('POST', '/api/loyalty', tokCentral, { guestName: `${P}Cilka` }))
    expect(res.status).toBe(400)
    const after = await db.loyaltyAccount.count({ where: { id: { startsWith: P } } })
    expect(after).toBe(before)
  })

  it('centralni orgA (locOA) ne more ustvariti računa na lokaciji orgB → 403', async () => {
    const res = await loyaltyPOST(req('POST', '/api/loyalty', tokAdminOA, { guestName: `${P}Denis`, locationId: locOB }))
    expect(res.status).toBe(403)
    const acc = await db.loyaltyAccount.findFirst({ where: { customerName: `${P}Denis` } })
    expect(acc).toBeNull()
  })

  it('centralni orgA ustvari na svoji org lokaciji → 201, locationId locOA', async () => {
    const res = await loyaltyPOST(req('POST', '/api/loyalty', tokAdminOA, { guestName: `${P}Eva`, locationId: locOA }))
    expect(res.status).toBe(201)
    const j = (await res.json()) as { account: { id: string } }
    const acc = await db.loyaltyAccount.findUnique({ where: { id: j.account.id } })
    expect(acc?.locationId).toBe(locOA)
  })

  it('neobstoječa lokacija → 404 (ne tiha izdaja)', async () => {
    const res = await loyaltyPOST(req('POST', '/api/loyalty', tokCentral, { guestName: `${P}Fana`, locationId: `${P}neobst-${RUN}` }))
    expect(res.status).toBe(404)
  })

  it('manjkajoče ime → 400 (validacija ostaja)', async () => {
    const res = await loyaltyPOST(req('POST', '/api/loyalty', tokPmA, { guestName: '   ' }))
    expect(res.status).toBe(400)
  })
})

/* ─────────────────────────── #44 — loyalty PATCH ─────────────────────────── */

describe('#44 — loyalty PATCH: atomaren saldo + ledger (CAS + meje)', () => {
  it('odpis nad saldo (delta=-50, saldo 10) → 409; saldo NESPREMJEN; BREZ novega ledger zapisa (ne tihi clamp)', async () => {
    const acc = await seedAccount(10, locA)
    const res = await loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: -50 }))
    expect(res.status).toBe(409)
    const after = await db.loyaltyAccount.findUnique({ where: { id: acc.id } })
    expect(after?.pointsBalance).toBe(10)
    expect(await db.loyaltyTransaction.count({ where: { loyaltyAccountId: acc.id } })).toBe(0)
  })

  it('točen odpis do 0 → 200; saldo 0; ledger -10 ≡ sprememba salda; audit zapis', async () => {
    const acc = await seedAccount(10, locA)
    const res = await loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: -10 }))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { account: { points: number } }
    expect(j.account.points).toBe(0)
    const txs = await db.loyaltyTransaction.findMany({ where: { loyaltyAccountId: acc.id } })
    expect(txs).toHaveLength(1)
    expect(txs[0]?.points).toBe(-10)
    expect(await db.auditLog.count({ where: { action: 'LOYALTY_POINTS', entityId: acc.id } })).toBe(1)
  })

  it('SOČASNA odbitka 8 iz salda 10 → natanko ena uspe [200,409]; saldo 2; EN ledger', async () => {
    const acc = await seedAccount(10, locA)
    const [r1, r2] = await Promise.all([
      loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: -8 })),
      loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: -8 })),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])
    const after = await db.loyaltyAccount.findUnique({ where: { id: acc.id } })
    expect(after?.pointsBalance).toBe(2)
    expect(await db.loyaltyTransaction.count({ where: { loyaltyAccountId: acc.id, type: 'redeem' } })).toBe(1)
  })

  it('SOČASNA prirasta +5/+5 iz 10 → OBA uspeta; saldo 20; lifetime 20; DVA ledgerja (izgubljeni update nemogoč)', async () => {
    const acc = await seedAccount(10, locA)
    const [r1, r2] = await Promise.all([
      loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: 5 })),
      loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: 5 })),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const after = await db.loyaltyAccount.findUnique({ where: { id: acc.id } })
    expect(after?.pointsBalance).toBe(20)
    expect(after?.lifetimePoints).toBe(20)
    expect(await db.loyaltyTransaction.count({ where: { loyaltyAccountId: acc.id, type: 'earn' } })).toBe(2)
  })

  it('tier/lifetime izpeljana iz iste operacije: earn čez 100 → silver, redeem pod 100 → bronze', async () => {
    const acc = await seedAccount(10, locA)
    const r1 = await loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: 95 }))
    expect(r1.status).toBe(200)
    const mid = await db.loyaltyAccount.findUnique({ where: { id: acc.id } })
    expect(mid?.pointsBalance).toBe(105)
    expect(mid?.lifetimePoints).toBe(105)
    expect(mid?.tier).toBe('silver')
    const r2 = await loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: -6 }))
    expect(r2.status).toBe(200)
    const end = await db.loyaltyAccount.findUnique({ where: { id: acc.id } })
    expect(end?.pointsBalance).toBe(99)
    expect(end?.lifetimePoints).toBe(105)
    expect(end?.tier).toBe('bronze')
  })

  it('cross-tenant: pmB (locB, settings.manage) ne more spremeniti računa lokacije A → 403', async () => {
    const acc = await seedAccount(10, locA)
    const res = await loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmB, { id: acc.id, delta: 5 }))
    expect(res.status).toBe(403)
    const after = await db.loyaltyAccount.findUnique({ where: { id: acc.id } })
    expect(after?.pointsBalance).toBe(10)
    expect(await db.loyaltyTransaction.count({ where: { loyaltyAccountId: acc.id } })).toBe(0)
  })

  it('meja delte: |delta| > 1.000.000 → 400; neštevilski delta → 400; delta 0 → 400', async () => {
    const acc = await seedAccount(10, locA)
    expect((await loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: 2_000_000 }))).status).toBe(400)
    expect((await loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: -2_000_000 }))).status).toBe(400)
    expect((await loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: 'abc' }))).status).toBe(400)
    expect((await loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: acc.id, delta: 0 }))).status).toBe(400)
    const after = await db.loyaltyAccount.findUnique({ where: { id: acc.id } })
    expect(after?.pointsBalance).toBe(10)
    expect(await db.loyaltyTransaction.count({ where: { loyaltyAccountId: acc.id } })).toBe(0)
  })

  it('neobstoječi račun → 404', async () => {
    const res = await loyaltyPATCH(req('PATCH', '/api/loyalty', tokPmA, { id: `${P}nic-${RUN}`, delta: 5 }))
    expect(res.status).toBe(404)
  })
})

/* ─────────────────────────── #45 — popust na naročilu ─────────────────────────── */

describe('#45 — popust: kvota + naročilo atomarno (CAS, validacije PRED kvoto)', () => {
  it('ničelen znesek (naročilo brez postavk) → 400 PRED kvoto: currentUses ostane 0', async () => {
    const disc = await seedDiscount({ maxUses: 1 })
    const order = await seedOrder(locA, { withItem: false })
    const res = await discountPOST(req('POST', `/api/orders/${order}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: order }) })
    expect(res.status).toBe(400)
    const d = await db.discount.findUnique({ where: { id: disc } })
    expect(d?.currentUses).toBe(0)
    const o = await db.order.findUnique({ where: { id: order } })
    expect(Number(o?.discount)).toBe(0)
  })

  it('zlata pot: POST → 200; Order.discount 0.5; currentUses 1; audit DISCOUNT_APPLIED', async () => {
    const disc = await seedDiscount({ maxUses: 5 })
    const order = await seedOrder(locA)
    const res = await discountPOST(req('POST', `/api/orders/${order}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: order }) })
    expect(res.status).toBe(200)
    const o = await db.order.findUnique({ where: { id: order } })
    expect(Number(o?.discount)).toBe(0.5)
    const d = await db.discount.findUnique({ where: { id: disc } })
    expect(d?.currentUses).toBe(1)
    expect(await db.auditLog.count({ where: { action: 'DISCOUNT_APPLIED', entityId: order } })).toBe(1)
  })

  it('obstoječi popust → 409 (tiho preiranje prepovedano); kvota se NE porabi dvakrat', async () => {
    const disc = await seedDiscount({ maxUses: 5 })
    const order = await seedOrder(locA)
    const r1 = await discountPOST(req('POST', `/api/orders/${order}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: order }) })
    expect(r1.status).toBe(200)
    const r2 = await discountPOST(req('POST', `/api/orders/${order}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: order }) })
    expect(r2.status).toBe(409)
    const d = await db.discount.findUnique({ where: { id: disc } })
    expect(d?.currentUses).toBe(1)
  })

  it('naročilo plačano MED branjem in zapisom → 409 + kvota ROLLBACK (currentUses 0)', async () => {
    const disc = await seedDiscount({ maxUses: 1 })
    const order = await seedOrder(locA)
    // simulacija dirke: findUnique vrne naročilo, nato ga (pred transakcijo) označi plačano
    const orig = db.order.findUnique.bind(db.order)
    let restored = false
    const patched = db.order as unknown as { findUnique: typeof orig }
    patched.findUnique = (async (args: Parameters<typeof orig>[0]) => {
      const o = await orig(args)
      if (o && (o as { id: string }).id === order) {
        await db.order.update({ where: { id: order }, data: { paymentStatus: 'paid' } })
      }
      return o
    }) as typeof orig
    try {
      const res = await discountPOST(req('POST', `/api/orders/${order}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: order }) })
      expect(res.status).toBe(409)
    } finally {
      patched.findUnique = orig
      restored = true
    }
    expect(restored).toBe(true)
    const d = await db.discount.findUnique({ where: { id: disc } })
    expect(d?.currentUses).toBe(0)
    const o = await db.order.findUnique({ where: { id: order } })
    expect(Number(o?.discount)).toBe(0)
    expect(await db.auditLog.count({ where: { action: 'DISCOUNT_APPLIED', entityId: order } })).toBe(0)
  })

  it('SOČASNA POSTa na isto sveže naročilo → [200,409]; currentUses 1; natanko EN audit', async () => {
    const disc = await seedDiscount({ maxUses: 2 })
    const order = await seedOrder(locA)
    const [r1, r2] = await Promise.all([
      discountPOST(req('POST', `/api/orders/${order}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: order }) }),
      discountPOST(req('POST', `/api/orders/${order}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: order }) }),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])
    const d = await db.discount.findUnique({ where: { id: disc } })
    expect(d?.currentUses).toBe(1)
    const o = await db.order.findUnique({ where: { id: order } })
    expect(Number(o?.discount)).toBe(0.5)
    expect(await db.auditLog.count({ where: { action: 'DISCOUNT_APPLIED', entityId: order } })).toBe(1)
  })

  it('izčrpana kvota na DRUGEM naročilu → 409; drugo naročilo brez popusta', async () => {
    const disc = await seedDiscount({ maxUses: 1 })
    const o1 = await seedOrder(locA)
    const o2 = await seedOrder(locA)
    const r1 = await discountPOST(req('POST', `/api/orders/${o1}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: o1 }) })
    expect(r1.status).toBe(200)
    const r2 = await discountPOST(req('POST', `/api/orders/${o2}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: o2 }) })
    expect(r2.status).toBe(409)
    const d = await db.discount.findUnique({ where: { id: disc } })
    expect(d?.currentUses).toBe(1)
    const o = await db.order.findUnique({ where: { id: o2 } })
    expect(Number(o?.discount)).toBe(0)
  })

  it('DELETE na neplačanem naročilu → 200 (discount 0, audit REMOVED); DELETE na PLAČANEM → 409', async () => {
    const disc = await seedDiscount({ maxUses: 5 })
    const order = await seedOrder(locA)
    await discountPOST(req('POST', `/api/orders/${order}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: order }) })
    // #19 (v1.107.0): odstranitev uporabljenega popusta = izjema → obvezen razlog
    const del = await discountDELETE(req('DELETE', `/api/orders/${order}/discount`, tokMgrA, { reason: 'testni razlog odstranitve' }), { params: Promise.resolve({ id: order }) })
    expect(del.status).toBe(200)
    const o1 = await db.order.findUnique({ where: { id: order } })
    expect(Number(o1?.discount)).toBe(0)
    expect(await db.auditLog.count({ where: { action: 'DISCOUNT_REMOVED', entityId: order } })).toBe(1)
    // plačano naročilo: CAS v samem update-u
    const order2 = await seedOrder(locA, { paymentStatus: 'paid' })
    const del2 = await discountDELETE(req('DELETE', `/api/orders/${order2}/discount`, tokMgrA), { params: Promise.resolve({ id: order2 }) })
    expect(del2.status).toBe(409)
  })

  it('ad-hoc odstotek 20 % natakarja → 403 (odobritev vodje ostaja)', async () => {
    const order = await seedOrder(locA)
    const res = await discountPOST(req('POST', `/api/orders/${order}/discount`, tokWaiter, { name: 'Ad hoc', type: 'percent', amount: 20 }), { params: Promise.resolve({ id: order }) })
    expect(res.status).toBe(403)
    const o = await db.order.findUnique({ where: { id: order } })
    expect(Number(o?.discount)).toBe(0)
  })

  it('kuhinja (brez apply_discounts) → 403', async () => {
    const order = await seedOrder(locA)
    const res = await discountPOST(req('POST', `/api/orders/${order}/discount`, tokKitchen, { name: 'X', type: 'fixed', amount: 1 }), { params: Promise.resolve({ id: order }) })
    expect(res.status).toBe(403)
  })

  it('popust TUJE lokacije na naročilu → 400 (lokacijska validacija ostaja)', async () => {
    const disc = await seedDiscount({ maxUses: 5, locationId: locB })
    const order = await seedOrder(locA)
    const res = await discountPOST(req('POST', `/api/orders/${order}/discount`, tokMgrA, { discountId: disc }), { params: Promise.resolve({ id: order }) })
    expect(res.status).toBe(400)
    const d = await db.discount.findUnique({ where: { id: disc } })
    expect(d?.currentUses).toBe(0)
  })
})

/* ─────────────────────────── #46 — giftcard lookup ─────────────────────────── */

describe('#46 — giftcard lookup: pravice, dolžina, rate limit, minimalen odgovor', () => {
  it('q krajši od 6 znakov → 400 BREZ DB poizvedbe (findFirst/findUnique ne smeta biti klicana)', async () => {
    const origFF = db.giftCard.findFirst.bind(db.giftCard)
    const origFU = db.giftCard.findUnique.bind(db.giftCard)
    const patched = db.giftCard as unknown as { findFirst: typeof origFF; findUnique: typeof origFU }
    const boom = (async () => { throw new Error('NO_DB_EXPECTED') }) as unknown as typeof origFF
    patched.findFirst = boom
    patched.findUnique = boom as unknown as typeof origFU
    try {
      for (const q of ['A', '12', '123', '1234', '12345', 'GC-1', 'GC-12']) {
        const res = await gcLookupGET(req('GET', `/api/giftcards/lookup?q=${encodeURIComponent(q)}`, tokWaiter))
        expect(res.status).toBe(400)
      }
    } finally {
      patched.findFirst = origFF
      patched.findUnique = origFU
    }
  })

  it('natakar (orders.pay) poišče po POLNI številki → 200; odgovor BREZ locationId', async () => {
    const res = await gcLookupGET(req('GET', '/api/giftcards/lookup?q=GC-20261014-461001', tokWaiter))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { card: Record<string, unknown> }
    expect(j.card.cardNumber).toBe('GC-20261014-461001')
    expect(j.card.balance).toBe(25)
    expect(j.card.effectiveStatus).toBe('active')
    expect('locationId' in j.card).toBe(false)
  })

  it('6-mestni suffix (zadnjih 6) → 200 ista kartica; 7-mestni delni del → 200', async () => {
    const res = await gcLookupGET(req('GET', '/api/giftcards/lookup?q=461001', tokWaiter))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { card: { id: string } }
    expect(j.card.id).toBe(`${P}gc1-${RUN}`)
    const res2 = await gcLookupGET(req('GET', '/api/giftcards/lookup?q=4-461001', tokWaiter))
    expect(res2.status).toBe(200)
  })

  it('kuhinja (brez orders.pay) → 403 (iskkanje je le POS plačilni tok)', async () => {
    const res = await gcLookupGET(req('GET', '/api/giftcards/lookup?q=GC-20261014-461001', tokKitchen))
    expect(res.status).toBe(403)
  })

  it('neobstoječa kartica → 404 (generično sporočilo)', async () => {
    const res = await gcLookupGET(req('GET', '/api/giftcards/lookup?q=GC-1999-999999', tokWaiter))
    expect(res.status).toBe(404)
    const j = (await res.json()) as { error: string }
    expect(j.error).toContain('ne obstaja')
  })

  it('rate limit 30/min (uporabnik+IP): 30. klic 200/404, 31. → 429 + agregirana revizija BREZ iskalne vrednosti', async () => {
    __resetRateLimitForTests()
    let last = 0
    for (let i = 0; i < 30; i++) {
      last = (await gcLookupGET(req('GET', '/api/giftcards/lookup?q=GC-20261014-461001', tokWaiter))).status
    }
    expect(last).toBe(200)
    const r31 = await gcLookupGET(req('GET', '/api/giftcards/lookup?q=GC-20261014-461001', tokWaiter))
    expect(r31.status).toBe(429)
    const audits = await db.auditLog.findMany({ where: { action: 'GIFT_CARD_LOOKUP_RATE_LIMITED', userId: { startsWith: P } } })
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(audits[0]?.details).not.toContain('GC-20261014')
    // drug uporabnik ima LOČEN bucket (ključ vsebuje uporabnika)
    const other = await gcLookupGET(req('GET', '/api/giftcards/lookup?q=GC-20261014-461001', tokMgrA))
    expect(other.status).toBe(200)
    __resetRateLimitForTests()
  })
})
