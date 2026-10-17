/**
 * Issue #49 (P1) — kartično plačilo: STREŽNIŠKA politika dokazovanja
 * (src/lib/payments-policy.ts). approvalCode klienta NI dokaz bančne
 * transakcije: profil določi strežnik (SIM- = simulator, ostalo = ročna
 * zabeležba zaposlenega; 'verified_provider' je rezerviran za prihodnjo
 * integracijo in klient NE more zahtevati). Simulator v produkciji → 402;
 * ročni način ga lastnik izrecno izklopi s PAYMENTS_ALLOW_MANUAL_ATTESTATION=false.
 * Issue #50 (P1) — idempotenčni ključ VEZAN na isto naročilo: isti order + isti
 * ključ → replay istega računa; isti ključ na DRUGEM naročilu (tudi tujem
 * tenant-u) → 409 BREZ tujega računa in brez 'PAID' laži. Velja za pred-tx
 * replay in P2002 catch pot.
 * Issue #51 (P1) — izdaja darilne kartice: replay VEZAN na isti kontekst
 * (lokacija izdaje + org obseg + ENAK payload). clientOperationId NI poverilnica:
 * ključ iz druge lokacije/org ali drugačen payload → 409 brez podatkov kartice.
 * Issue #64 (P2) — sočasna izplačila RAZLIČNIH distribucij istega bazena:
 * ANCHOR zaklep bazena serializira transakciji → zadnji pisec vidi FRESH stanje
 * → vse distribucije paid ⇒ TipPool.status='paid' (prej je bazen zamrl 'pending').
 *
 * Vzorec: direktni uvoz route handlerjev (furs-post / i60) — NextRequest z
 * žetonom createToken; fiksature s predpono `pi49-`; sweep beforeAll/afterAll.
 * Žetoni nosijo UI role UPPERCASE ('MANAGER'/'ADMIN').
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken } from '../src/lib/auth'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { POST as giftcardsPOST } from '../src/app/api/giftcards/route'
import { POST as tipsPayoutPOST } from '../src/app/api/tips/payout/route'
import { approvalAttestationProfile, paymentPolicyError } from '../src/lib/payments-policy'
import { giftCardIssueId } from '../src/lib/giftcards'
import { vatFromGross } from '../src/lib/billing'
import { nid } from '../src/lib/map'

const PREFIX = 'pi49-'
const RUN = Date.now().toString(36)

let orgA = '', propA = '', brandA = ''
let orgB = '', propB = '', brandB = ''
let locA1 = '', locA2 = '', locB1 = ''
let managerA = '', managerA2 = '', managerB = ''
let miA = '', miB = ''

const tok = (sub: string, name: string, role: string, loc: string | null) =>
  createToken({ sub, name, role, loc, sv: 0 })

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function status(r: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  const res = (await (r as Promise<unknown> | Response)) as Response
  expect(res instanceof Response).toBe(true)
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}

const pay = (token: string, body: Record<string, unknown>) =>
  status(fursPOST(req('/api/furs', token, 'POST', body)))

/* ── naročilo z eno postavko: 10,00 € KONČNA cena (22 % → 8,20 neto + 1,80 DDV) ── */
let orderSeq = 991000
async function mkOrder(loc: string, menuItemId: string): Promise<string> {
  const orderId = `${PREFIX}ord-${++orderSeq}-${RUN}`
  const unitPrice = 10
  const vatRate = 22
  const vat = vatFromGross(unitPrice, vatRate)
  const employeeId = loc === locB1 ? managerB : managerA
  await db.order.create({
    data: {
      id: orderId, orderNumber: orderSeq, locationId: loc,
      status: 'open', paymentStatus: 'unpaid', type: 'dine-in',
      subtotal: Math.round((unitPrice - vat) * 100) / 100, tax: vat, total: unitPrice, employeeId,
    },
  })
  await db.orderItem.create({
    data: {
      id: nid(), orderId, menuItemId, quantity: 1, price: unitPrice,
      vatRate, vatAmount: vat, menuItemName: 'PI49 test', status: 'served',
    },
  })
  return orderId
}

/* ── bazen napitnin z distribucijami (Issue #64) ── */
let poolSeq = 0, distSeq = 0
async function mkPool(loc: string, employees: string[]): Promise<{ poolId: string; distIds: string[] }> {
  const poolId = `${PREFIX}pool-${++poolSeq}-${RUN}`
  await db.tipPool.create({
    data: {
      id: poolId, date: new Date(Date.now() + poolSeq * 864e5), totalTips: employees.length * 5,
      cashTips: employees.length * 5, cardTips: 0, distributionMethod: 'equal',
      status: 'pending', locationId: loc,
    },
  })
  const distIds: string[] = []
  for (const employeeId of employees) {
    const distId = `${PREFIX}dist-${++distSeq}-${RUN}`
    await db.tipDistribution.create({
      data: {
        id: distId, tipPoolId: poolId, employeeId, employeeName: 'PI49',
        hoursWorked: 1, points: 1, amount: 5, status: 'pending',
      },
    })
    distIds.push(distId)
  }
  return { poolId, distIds }
}

const payout = (token: string, body: Record<string, unknown>) =>
  status(tipsPayoutPOST(req('/api/tips/payout', token, 'POST', body)))

/**
 * Reverse-FK čiščenje (idempotentno — beforeAll IN afterAll, vzorec furs-post):
 * plačilna pot (furs POST) ustvari Payment/Check/Receipt z nid() id-ji BREZ predpone —
 * Payment (Restrict na Check) blokira brisanje naročil, zato morajo pasti PRVI;
 * GiftCardTransaction (Restrict na GiftCard) blokira brisanje gc- kartic. Nato
 * generični sweep odstrani preostalo drevo (naročila → kaskada Check, lokacije …).
 */
async function cleanupFixtures() {
  const orders = await db.order.findMany({ where: { id: { startsWith: `${PREFIX}ord-` } }, select: { id: true } })
  for (const { id: orderId } of orders) {
    const checks = await db.check.findMany({ where: { orderId }, select: { id: true } })
    if (checks.length) {
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } })
    }
    const receipts = await db.receipt.findMany({ where: { orderId }, select: { id: true } })
    if (receipts.length) {
      await db.auditLog.deleteMany({ where: { entityType: 'Receipt', entityId: { in: receipts.map((r) => r.id) } } })
      await db.eventLog.deleteMany({ where: { entityId: { in: receipts.map((r) => r.id) } } })
    }
    await db.auditLog.deleteMany({ where: { OR: [{ entityType: 'Order', entityId: orderId }, { entityId: orderId }] } })
    await db.stockTransaction.deleteMany({ where: { orderId } })
  }
  // darilne kartice teh fiksur: lokacija izdaje ima pi49- predpono (ali je null
  // po prejšnjem padlem sweepu) — transakcije (Restrict) najprej, nato kartica
  const cards = await db.giftCard.findMany({
    where: { OR: [{ locationId: { startsWith: PREFIX } }, { id: giftCardIssueId(`pi51-issue-${RUN}`) }] },
    select: { id: true },
  })
  for (const { id: cardId } of cards) {
    await db.giftCardTransaction.deleteMany({ where: { giftCardId: cardId } })
    await db.auditLog.deleteMany({ where: { entityType: 'GiftCard', entityId: cardId } })
    await db.giftCard.deleteMany({ where: { id: cardId } })
  }
  await sweepTestFixtures(db, [PREFIX])
}

beforeAll(async () => {
  await cleanupFixtures()
  orgA = `${PREFIX}orgA-${RUN}`; brandA = `${PREFIX}brandA-${RUN}`; propA = `${PREFIX}propA-${RUN}`
  orgB = `${PREFIX}orgB-${RUN}`; brandB = `${PREFIX}brandB-${RUN}`; propB = `${PREFIX}propB-${RUN}`
  locA1 = `${PREFIX}locA1-${RUN}`; locA2 = `${PREFIX}locA2-${RUN}`; locB1 = `${PREFIX}locB1-${RUN}`
  await db.organization.create({ data: { id: orgA, name: 'PI49 Org A', slug: `${PREFIX}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: 'PI49 Org B', slug: `${PREFIX}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: 'PI49 BA' } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: 'PI49 BB' } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: 'PI49 PA' } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: 'PI49 PB' } })
  await db.location.create({ data: { id: locA1, name: 'PI49 A1', code: `${PREFIX}A1-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locA2, name: 'PI49 A2', code: `${PREFIX}A2-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locB1, name: 'PI49 B1', code: `${PREFIX}B1-${RUN}`, propertyId: propB } })

  managerA = nid(); managerA2 = nid(); managerB = nid()
  await db.employee.create({ data: { id: managerA, name: `${PREFIX}mA`, email: `${managerA}@test.local`, role: 'manager', status: 'active', sessionVersion: 0, locationId: locA1, pin: `${PREFIX}a` } })
  await db.employee.create({ data: { id: managerA2, name: `${PREFIX}mA2`, email: `${managerA2}@test.local`, role: 'manager', status: 'active', sessionVersion: 0, locationId: locA2, pin: `${PREFIX}a2` } })
  await db.employee.create({ data: { id: managerB, name: `${PREFIX}mB`, email: `${managerB}@test.local`, role: 'manager', status: 'active', sessionVersion: 0, locationId: locB1, pin: `${PREFIX}b` } })

  const menuA = nid(), catA = nid()
  await db.menu.create({ data: { id: menuA, name: 'PI49 meni A', locationId: locA1 } })
  await db.category.create({ data: { id: catA, name: 'PI49 kat A', menuId: menuA } })
  miA = nid()
  await db.menuItem.create({ data: { id: miA, name: 'PI49 artikel A', price: 10, categoryId: catA, vatRate: 22 } })
  const menuB = nid(), catB = nid()
  await db.menu.create({ data: { id: menuB, name: 'PI49 meni B', locationId: locB1 } })
  await db.category.create({ data: { id: catB, name: 'PI49 kat B', menuId: menuB } })
  miB = nid()
  await db.menuItem.create({ data: { id: miB, name: 'PI49 artikel B', price: 10, categoryId: catB, vatRate: 22 } })
})

afterAll(async () => {
  await cleanupFixtures()
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #49 — strežniška politika dokazovanja kartičnega plačila
// ════════════════════════════════════════════════════════════════════════════
describe('#49 payments-policy — profili dokazovanja', () => {
  it('klasifikacija: SIM- predpona = simulator; VSA druga koda = manual_attestation; klient NIKOLI ne doseže verified_provider', () => {
    expect(approvalAttestationProfile('SIM-ABC123')).toBe('simulator')
    expect(approvalAttestationProfile('sim-lower')).toBe('simulator')
    expect(approvalAttestationProfile('abc')).toBe('manual_attestation')
    expect(approvalAttestationProfile('123456')).toBe('manual_attestation')
    expect(approvalAttestationProfile('')).toBe('manual_attestation')
    // klient ne more konstruirati kode, ki bi se klasificirala kot verified_provider
    for (const code of ['verified', 'PROVIDER-OK', 'pi_123', 'X'.repeat(40)]) {
      expect(approvalAttestationProfile(code)).not.toBe('verified_provider')
    }
  })

  it('politika: simulator izven simulacijskega okolja → zavrnitev; manual privzeto dovoljen, z env=false zavrnjen', () => {
    expect(paymentPolicyError('simulator', false)).not.toBeNull()
    expect(paymentPolicyError('simulator', true)).toBeNull()
    expect(paymentPolicyError('manual_attestation', false)).toBeNull()
    expect(paymentPolicyError('manual_attestation', true)).toBeNull()
    // politika ne odloča o ponudniško preverjenem profilu (rezerviran za strežniško integracijo)
    expect(paymentPolicyError('verified_provider', false)).toBeNull()
  })
})

describe('#49 furs POST — politika v plačilnem jedru (ročni zapis v auditu)', () => {
  it('simulacija: ročna koda abc → 201; Payment.authorizationCode zapisan; audit nosi profil manual_attestation (NIKOLI verified_provider)', async () => {
    const token = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const orderId = await mkOrder(locA1, miA)
    const r = await pay(token, { orderId, type: 'card', terminal: { approvalCode: 'abc' } })
    expect(r.code).toBe(201)
    const pay1 = await db.payment.findFirst({ where: { authorizationCode: 'abc', Check: { orderId } }, include: { Check: true } })
    expect(pay1).not.toBeNull()
    expect(pay1?.Check.orderId).toBe(orderId)
    const audit = await db.auditLog.findFirst({ where: { action: 'INVOICE_ISSUE', entityId: (r.body.invoice as Record<string, unknown>).id as string } })
    expect(audit).not.toBeNull()
    const details = String(audit?.details)
    expect(details).toContain('"profile":"manual_attestation"')
    expect(details).toContain('"attestation"')
    expect(details).not.toContain('verified_provider')
    expect(audit?.userId).toBe(managerA) // akter ročne zabeležbe
  })
})

describe('#49 furs POST — produkcija (FURS_ENVIRONMENT=production)', () => {
  const PREV_ENV = process.env.FURS_ENVIRONMENT
  const PREV_ALLOW = process.env.FURS_ALLOW_SIMULATION
  const PREV_MANUAL = process.env.PAYMENTS_ALLOW_MANUAL_ATTESTATION

  beforeAll(() => {
    process.env.FURS_ENVIRONMENT = 'production'
    delete process.env.FURS_ALLOW_SIMULATION // klientova zastavica ne sme vplivati
  })
  afterAll(() => {
    if (PREV_ENV === undefined) delete process.env.FURS_ENVIRONMENT
    else process.env.FURS_ENVIRONMENT = PREV_ENV
    if (PREV_ALLOW === undefined) delete process.env.FURS_ALLOW_SIMULATION
    else process.env.FURS_ALLOW_SIMULATION = PREV_ALLOW
    if (PREV_MANUAL === undefined) delete process.env.PAYMENTS_ALLOW_MANUAL_ATTESTATION
    else process.env.PAYMENTS_ALLOW_MANUAL_ATTESTATION = PREV_MANUAL
  })

  it('SIM- koda v produkciji → 402; naročilo ostane unpaid; BREZ plačilnih vrstic', async () => {
    const token = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const orderId = await mkOrder(locA1, miA)
    const before = await db.payment.count({ where: { authorizationCode: { startsWith: 'SIM-' } } })
    const r = await pay(token, { orderId, type: 'card', terminal: { approvalCode: 'SIM-777' } })
    expect(r.code).toBe(402)
    expect(String(r.body.error)).toMatch(/simulator/i)
    expect(await db.order.findUnique({ where: { id: orderId } }).then((o) => o?.paymentStatus)).toBe('unpaid')
    expect(await db.payment.count({ where: { authorizationCode: { startsWith: 'SIM-' } } })).toBe(before)
  })

  it('SIM- koda v produkciji tudi na DELIH plačila (split) → 402', async () => {
    const token = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const orderId = await mkOrder(locA1, miA)
    const r = await pay(token, {
      orderId,
      parts: [
        { type: 'cash', amount: 5 },
        { type: 'card', amount: 5, terminal: { approvalCode: 'SIM-888' } },
      ],
    })
    expect(r.code).toBe(402)
    expect(await db.order.findUnique({ where: { id: orderId } }).then((o) => o?.paymentStatus)).toBe('unpaid')
  })

  it('ročna koda v produkciji → privzeto DOVOLJENA (obstoječ POS postopek; eksplicitna izključitev prek env)', async () => {
    delete process.env.PAYMENTS_ALLOW_MANUAL_ATTESTATION
    const token = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const orderId = await mkOrder(locA1, miA)
    const r = await pay(token, { orderId, type: 'card', terminal: { approvalCode: 'MANUAL-012' } })
    expect(r.code).toBe(201)
    expect(await db.order.findUnique({ where: { id: orderId } }).then((o) => o?.paymentStatus)).toBe('paid')
  })

  it('PAYMENTS_ALLOW_MANUAL_ATTESTATION=false → ročna koda zavrnjena (402); CASH plačilo NEREGRESIRANO (201)', async () => {
    process.env.PAYMENTS_ALLOW_MANUAL_ATTESTATION = 'false'
    const token = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const ordCard = await mkOrder(locA1, miA)
    const rc = await pay(token, { orderId: ordCard, type: 'card', terminal: { approvalCode: 'MANUAL-456' } })
    expect(rc.code).toBe(402)
    expect(String(rc.body.error)).toMatch(/manual|ročn/i)
    expect(await db.order.findUnique({ where: { id: ordCard } }).then((o) => o?.paymentStatus)).toBe('unpaid')
    // gotnina ni kartično plačilo — politika je ne dotika
    const ordCash = await mkOrder(locA1, miA)
    const rx = await pay(token, { orderId: ordCash, type: 'cash' })
    expect(rx.code).toBe(201)
    delete process.env.PAYMENTS_ALLOW_MANUAL_ATTESTATION
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #50 — idempotenčni ključ vezan na isto naročilo
// ════════════════════════════════════════════════════════════════════════════
describe('#50 furs POST — idempotenca vezana na Order', () => {
  it('isto naročilo + isti ključ → replay ISTEGA računa (replayed=true); Brez duplikatov', async () => {
    const token = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const orderId = await mkOrder(locA1, miA)
    const K = `pi50-replay-${RUN}`
    const first = await pay(token, { orderId, type: 'cash', clientOperationId: K })
    expect(first.code).toBe(201)
    const invNo = (first.body.invoice as Record<string, unknown>).invoiceNumber as string
    const receiptsBefore = await db.receipt.count({ where: { orderId } })
    const paymentsBefore = await db.payment.count({ where: { idempotencyKey: { startsWith: `${K}#` } } })

    const replay = await pay(token, { orderId, type: 'cash', clientOperationId: K })
    expect(replay.code).toBe(200)
    expect(replay.body.replayed).toBe(true)
    expect((replay.body.invoice as Record<string, unknown>).invoiceNumber).toBe(invNo)
    expect(await db.receipt.count({ where: { orderId } })).toBe(receiptsBefore)
    expect(await db.payment.count({ where: { idempotencyKey: { startsWith: `${K}#` } } })).toBe(paymentsBefore)
  })

  it('DRUGO naročilo (ista org) z istim ključem → 409; BREZ tujega računa v odgovoru; naročilo B ostane unpaid', async () => {
    const token = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const orderA = await mkOrder(locA1, miA)
    const K = `pi50-cross-${RUN}`
    const first = await pay(token, { orderId: orderA, type: 'cash', clientOperationId: K })
    expect(first.code).toBe(201)
    const invNo = String((first.body.invoice as Record<string, unknown>).invoiceNumber)

    const orderB = await mkOrder(locA1, miA)
    const receiptsBefore = await db.receipt.count({})
    const r = await pay(token, { orderId: orderB, type: 'cash', clientOperationId: K })
    expect(r.code).toBe(409)
    expect(String(r.body.error)).toMatch(/drugo naročilo/i)
    // odgovor ne sme vsebovati tujega računa (številka/plačilo)
    const raw = JSON.stringify(r.body)
    expect(raw).not.toContain(invNo)
    expect(raw).not.toContain('invoice')
    // naročilo B NI plačano (prej: replay bi vrnil PAID laž)
    expect(await db.order.findUnique({ where: { id: orderB } }).then((o) => o?.paymentStatus)).toBe('unpaid')
    expect(await db.receipt.count({})).toBe(receiptsBefore)
  })

  it('ključ TUJEGA tenanta (orgB plača, orgA uporabi isti ključ) → 409; BREZ cross-tenant računa', async () => {
    const tokA = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const tokB = tok(managerB, `${PREFIX}mB`, 'MANAGER', locB1)
    const orderA = await mkOrder(locA1, miA)
    const K = `pi50-tenant-${RUN}`
    const first = await pay(tokA, { orderId: orderA, type: 'cash', clientOperationId: K })
    expect(first.code).toBe(201)

    const orderC = await mkOrder(locB1, miB)
    const r = await pay(tokB, { orderId: orderC, type: 'cash', clientOperationId: K })
    expect(r.code).toBe(409)
    expect(JSON.stringify(r.body)).not.toContain('invoice')
    expect(await db.order.findUnique({ where: { id: orderC } }).then((o) => o?.paymentStatus)).toBe('unpaid')
    // račun A obstaja SAMO na naročilu A
    expect(await db.receipt.count({ where: { orderId: orderA } })).toBe(1)
    expect(await db.receipt.count({ where: { orderId: orderC } })).toBe(0)
  })

  it('split plačilo (K#p0/K#p1): isti ključ na drugem naročilu → 409 (priponjeni ključi tudi vezani)', async () => {
    const token = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const orderA = await mkOrder(locA1, miA)
    const K = `pi50-split-${RUN}`
    const first = await pay(token, {
      orderId: orderA, clientOperationId: K,
      parts: [
        { type: 'cash', amount: 5 },
        { type: 'card', amount: 5, terminal: { approvalCode: 'SIM-SPLIT' } },
      ],
    })
    expect(first.code).toBe(201)
    expect(await db.payment.count({ where: { idempotencyKey: { startsWith: `${K}#` } } })).toBeGreaterThanOrEqual(2)

    const orderB = await mkOrder(locA1, miA)
    const r = await pay(token, { orderId: orderB, type: 'cash', clientOperationId: K })
    expect(r.code).toBe(409)
    expect(await db.order.findUnique({ where: { id: orderB } }).then((o) => o?.paymentStatus)).toBe('unpaid')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #51 — izdaja darilne kartice: replay vezan na kontekst operacije
// ════════════════════════════════════════════════════════════════════════════
describe('#51 giftcards POST — idempotentni replay vezan na tenant/lokacijo/payload', () => {
  const K = `pi51-issue-${RUN}`
  const cardBody = { ownerName: 'Ana', initialBalance: 50, clientOperationId: K }

  it('izdaja na A1 s ključem K → 201; retry z ISTIM kontekptom → isti kartica, replayed, BREZ duplikata ledžerja', async () => {
    const tokA = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const first = await status(giftcardsPOST(req('/api/giftcards', tokA, 'POST', cardBody)))
    expect(first.code).toBe(201)
    const card = first.body.card as Record<string, unknown>
    expect(String(card.id)).toMatch(/^gc-/)
    expect(card.balance).toBe(50)
    const cardId = String(card.id)
    expect(await db.giftCardTransaction.count({ where: { giftCardId: cardId, type: 'issue' } })).toBe(1)

    const replay = await status(giftcardsPOST(req('/api/giftcards', tokA, 'POST', cardBody)))
    expect(replay.code).toBe(200)
    expect(replay.body.replayed).toBe(true)
    expect((replay.body.card as Record<string, unknown>).id).toBe(cardId)
    // idempotenca: retry po izgubljenem odgovoru NE podvoji issue vnosa
    expect(await db.giftCardTransaction.count({ where: { giftCardId: cardId, type: 'issue' } })).toBe(1)
    expect(await db.giftCard.count({ where: { id: cardId } })).toBe(1)
  })

  it('uporabnik DRUGE organizacije (B1) z istim K → 409; BREZ podatkov kartice v odgovoru', async () => {
    const tokB = tok(managerB, `${PREFIX}mB`, 'MANAGER', locB1)
    const r = await status(giftcardsPOST(req('/api/giftcards', tokB, 'POST', cardBody)))
    expect(r.code).toBe(409)
    expect(String(r.body.error)).toMatch(/drug[oao] (operacijo|lokacij|organizacij)/i)
    const raw = JSON.stringify(r.body)
    const cardRow = await db.giftCard.findFirst({ where: { id: { startsWith: 'gc-' } }, orderBy: { createdAt: 'desc' } })
    expect(cardRow).not.toBeNull()
    expect(raw).not.toContain(String(cardRow?.cardNumber))
    expect(raw).not.toContain('balance')
    expect(raw).not.toContain('ownerName')
  })

  it('ISTA org, DRUGA lokacija (A2) z istim K → 409 (kontekst izdaje se ne ujema)', async () => {
    const tokA2 = tok(managerA2, `${PREFIX}mA2`, 'MANAGER', locA2)
    const before = await db.giftCard.count({})
    const r = await status(giftcardsPOST(req('/api/giftcards', tokA2, 'POST', cardBody)))
    expect(r.code).toBe(409)
    expect(await db.giftCard.count({})).toBe(before) // NIČ nove kartice
  })

  it('ista lokacija, a DRUGAČEN payload (znesek/lastnik/rok) → 409; obstoječa kartica in ledžer NESPREMENJENI', async () => {
    const tokA = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const cases: Array<Record<string, unknown>> = [
      { ...cardBody, initialBalance: 100 },
      { ...cardBody, ownerName: 'Berta' },
      { ...cardBody, expiresAt: '2035-01-01' },
    ]
    const before = await db.giftCardTransaction.count({ where: { type: 'issue' } })
    for (const body of cases) {
      const r = await status(giftcardsPOST(req('/api/giftcards', tokA, 'POST', body)))
      expect(r.code).toBe(409)
    }
    expect(await db.giftCardTransaction.count({ where: { type: 'issue' } })).toBe(before)
    const cardRow = await db.giftCard.findFirst({ where: { id: { startsWith: 'gc-' } }, orderBy: { createdAt: 'desc' } })
    expect(Number(cardRow?.initialBalance)).toBe(50)
    expect(cardRow?.ownerName).toBe('Ana')
    expect(cardRow?.locationId).toBe(locA1)
    // zavrnitveni odgovor ne pušča kartice v reviziji (audit obstaja SAMO za prvo izdajo)
    expect(await db.auditLog.count({ where: { action: 'GIFT_CARD_ISSUE', entityId: String(cardRow?.id) } })).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #64 — sočasna izplačila različnih distribucij: bazen sledi resnici
// ════════════════════════════════════════════════════════════════════════════
describe('#64 tips payout — atomaren agregatni status bazena', () => {
  it('dve SOČASNI izplačili RAZLIČNIH distribucij → obe 200; vse paid in TipPool.status=PAID (prej: zamrknjen pending)', async () => {
    const mTok = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const { poolId, distIds } = await mkPool(locA1, [managerA, managerA2])
    const results = await Promise.all([
      payout(mTok, { poolId, distributionId: distIds[0] }),
      payout(mTok, { poolId, distributionId: distIds[1] }),
    ])
    expect(results.map((r) => r.code).sort()).toEqual([200, 200])
    const dists = await db.tipDistribution.findMany({ where: { tipPoolId: poolId } })
    expect(dists.every((d) => d.status === 'paid' && d.paidAt !== null)).toBe(true)
    const pool = await db.tipPool.findUnique({ where: { id: poolId } })
    expect(pool?.status).toBe('paid')
    // vsako uspešno izplačilo ima točno EN revizijski vnos; ZADNJI (kanonični) odraža
    // končni status 'paid' — vmesni vnos je resnica TISTEGA trenutka (D2 še pending)
    const audits = await db.auditLog.findMany({ where: { action: 'TIP_PAYOUT', entityId: poolId }, orderBy: { timestamp: 'asc' } })
    expect(audits.length).toBe(2)
    expect(String(audits[audits.length - 1].details)).toContain('"poolStatus":"paid"')
  })

  it('dve SOČASNI zahtevi za ISTO distribucijo → [200, 409]; izplačana ENKRAT, EN audit', async () => {
    const mTok = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const { poolId, distIds } = await mkPool(locA1, [managerA, managerA2])
    const results = await Promise.all([
      payout(mTok, { poolId, distributionId: distIds[0] }),
      payout(mTok, { poolId, distributionId: distIds[0] }),
    ])
    expect(results.map((r) => r.code).sort()).toEqual([200, 409])
    expect(await db.tipDistribution.findUnique({ where: { id: distIds[0] } }).then((d) => d?.status)).toBe('paid')
    expect(await db.auditLog.count({ where: { action: 'TIP_PAYOUT', entityId: poolId } })).toBe(1)
  })

  it('"izplačaj vse" hkrati s posamičnim izplačilom → konvergira: vse paid, bazen PAID (brez 500)', async () => {
    const mTok = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const { poolId, distIds } = await mkPool(locA1, [managerA, managerA2])
    const results = await Promise.all([
      payout(mTok, { poolId }), // vsi pending (iz zastarelega pre-branja)
      payout(mTok, { poolId, distributionId: distIds[1] }),
    ])
    for (const r of results) expect([200, 409]).toContain(r.code)
    const dists = await db.tipDistribution.findMany({ where: { tipPoolId: poolId } })
    expect(dists.every((d) => d.status === 'paid')).toBe(true)
    expect(await db.tipPool.findUnique({ where: { id: poolId } }).then((p) => p?.status)).toBe('paid')
  })

  it('zastareli pending bazen z vsemi plačanimi distribucijami → posamično izplačilo 409 (ni čakajočih)', async () => {
    // simulacija legacy stanja: vse distribucije paid, bazen napačno pending
    const { poolId, distIds } = await mkPool(locA1, [managerA, managerA2])
    await db.tipDistribution.updateMany({ where: { id: { in: distIds } }, data: { status: 'paid', paidAt: new Date() } })
    const mTok = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    // posamično izplačilo že plačane distribucije → 409 (ni čakajočih) — bazen se NE podvoji
    const r = await payout(mTok, { poolId, distributionId: distIds[0] })
    expect(r.code).toBe(409)
  })
})
