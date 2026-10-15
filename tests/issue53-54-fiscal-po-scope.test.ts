/**
 * Issue #53 (P0/P1) — produkcija fail-closed zavrne fiskalno simulacijo, če
 * okolje ni izrecno nastavljeno (src/lib/fiscal-profile.ts):
 *  - produkcija (NODE_ENV=production) BREZ FURS_ENVIRONMENT in brez
 *    Location.fursEnvironment → 503 FISCAL_CONFIG_MISSING PRED ustvarjanjem
 *    Payment/Receipt/Check/StockTransaction (prej: privzeta 'simulation' z
 *    lažnim fiscalStatus='verified');
 *  - produkcija + env 'simulation' ali FURS_ALLOW_SIMULATION=true → 503
 *    FISCAL_SIMULATION_IN_PRODUCTION (razen FURS_PRODUCTION_TEST_MODE=true);
 *  - typo ('prod') → 503 FISCAL_CONFIG_INVALID v vseh runtimeih;
 *  - 'test' ostaja dovoljen izrecni profil v produkciji (simulirane kode kot
 *    doslej — §18), odgovor in revizija pa okolje označita IZRECNO
 *    (fursEnvironment: 'test' — ne več generično 'simulation');
 *  - storno (replikacija režima /api/furs) ista fail-closed vrata.
 * Issue #54 (P0/P1) — nabavno naročilo/prevzem tenant/lokacijski obseg:
 *  - POST /api/purchase-orders: requireUserLocation + assertOrgScope + obstoj
 *    lokacije; non-central s TUJIM locationId → 403 brez PO/SupplierItem;
 *    artikel DUGE lokacije → 403 (null = legacy → dovoljen);
 *  - receive: guardResource(user, po.locationId) PRED replayom (ključ ni
 *    poverilnica); body.locationId ne more prestaviti GRN (403); legacy PO brez
 *    lokacije = centralna izrecna pot; sveža PO preverba + obseg artikla
 *    ZNOTRAJ transakcije (409/400 + rollback celote);
 *  - GET/PATCH [id]: inventory.manage + guardResource (usklajeno s seznamom).
 *
 * Vzorec: pi49 (env-mutacija v describe + reverse-FK čiščenje) + i60
 * (org/brand/property/lokacije/osebje). Fiksature s predpono `i53-`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken } from '../src/lib/auth'
import { resolveFiscalProfile, FiscalConfigError } from '../src/lib/fiscal-profile'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { POST as poPOST } from '../src/app/api/purchase-orders/route'
import { POST as receivePOST } from '../src/app/api/purchase-orders/[id]/receive/route'
import { GET as poGET, PATCH as poPATCH } from '../src/app/api/purchase-orders/[id]/route'
import { POST as stornoPOST } from '../src/app/api/receipts/[id]/storno/route'
import { nid } from '../src/lib/map'

const PREFIX = 'i53-'
const RUN = Date.now().toString(36)

let orgA = '', propA = '', brandA = ''
let orgB = '', propB = '', brandB = ''
let locA1 = '', locA2 = '', locB1 = '', locNoEnv = ''
let managerA = '', adminA = '', managerB = ''
let supA = '', supB = ''
let invA1 = '', invA2 = '', invB1 = '', invLegacy = ''
let miA = '', miN = ''

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

/**
 * Reverse-FK čiščenje (idempotentno — beforeAll IN afterAll, vzorec pi49):
 * furs POST ustvari Payment/Check/Receipt z nid() id-ji BREZ predpone — Payment
 * (Restrict na Check) blokira brisanje; revizije/dogodki PO/GRN lokacijsko.
 * Nato generični sweep odstrani preostalo drevo (+ novo: nabavni modeli po
 * locationId — fixture-sweep v1.95.0).
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
  // revizije nabavne poti (PO/GRN entityId = nid, lokacijsko polje) + dogodki
  // zaloge (StockChanged entityId = prefixed artikel)
  await db.auditLog.deleteMany({ where: { locationId: { startsWith: PREFIX } } })
  await db.eventLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } })
  // v1.99.0 higiena: LEGACY PO prek APIja (nid id, locationId null) ni dosegljiv
  // generičnemu sweep-u — Restrict FK na Supplier blokira brisanje dobavitelja
  // in zastrupi skupno DB za ponovni tek (P2002 na Supplier.name). Izrecno
  // počisti nabavne vrstice vezane na TESTNE dobavitelje (GRN nad PO kaskadira).
  await db.accountsPayable.deleteMany({ where: { supplierId: { startsWith: PREFIX } } })
  await db.goodsReceipt.deleteMany({ where: { supplierId: { startsWith: PREFIX } } })
  await db.purchaseOrder.deleteMany({ where: { supplierId: { startsWith: PREFIX } } })
  await sweepTestFixtures(db, [PREFIX])
}

/* ── naročilo z eno postavko 10 € + 22 % DDV (pi49 vzorec) ── */
let orderSeq = 996000
async function mkOrder(loc: string, menuItemId: string): Promise<string> {
  const orderId = `${PREFIX}ord-${++orderSeq}-${RUN}`
  const unitPrice = 10
  const vatRate = 22
  const vat = Math.round(unitPrice * vatRate + Number.EPSILON) / 100
  await db.order.create({
    data: {
      id: orderId, orderNumber: orderSeq, locationId: loc,
      status: 'open', paymentStatus: 'unpaid', type: 'dine-in',
      subtotal: unitPrice, tax: vat, total: unitPrice + vat, employeeId: managerA,
    },
  })
  await db.orderItem.create({
    data: { id: nid(), orderId, menuItemId, quantity: 1, price: unitPrice, vatRate, vatAmount: vat, menuItemName: 'I53 test', status: 'served' },
  })
  return orderId
}

/* ── plačano naročilo + izdan račun (za storno 503 test) ── */
let rcSeq = 0
async function mkPaidReceipt(loc: string): Promise<string> {
  const orderId = `${PREFIX}ord-s-${++orderSeq}-${RUN}`
  await db.order.create({
    data: {
      id: orderId, orderNumber: orderSeq, locationId: loc,
      status: 'paid', paymentStatus: 'paid', type: 'dine-in',
      subtotal: 10, tax: 2.2, total: 12.2, employeeId: managerA,
    },
  })
  const receiptId = `${PREFIX}rc-${++rcSeq}-${RUN}`
  await db.receipt.create({
    data: {
      id: receiptId, receiptNumber: `I53S-${RUN}-${rcSeq}`, orderId,
      businessName: 'I53 test', businessAddress: 'I53 addr', businessId: 'I53', taxId: 'SI-I53',
      subtotal: 10, vatBreakdown: '{}', totalVat: 0, total: 10, paymentMethod: 'cash',
      locationId: loc,
    },
  })
  return receiptId
}

/* ── PO direktno (kontroliran status/lokacija/artikel — brez POST validacij) ── */
let poSeq = 0, grnSeq = 0
async function mkPoDirect(opts: { loc: string | null; supplierId: string; itemId: string | null; qty?: number; status?: string }): Promise<{ id: string; itemId: string }> {
  const id = nid()
  const itemId = nid()
  await db.purchaseOrder.create({
    data: {
      id, poNumber: `PO-I53-${RUN}-${++poSeq}`, supplierId: opts.supplierId,
      status: (opts.status ?? 'approved') as 'approved',
      subtotal: 10, vatAmount: 2.2, totalAmount: 12.2, locationId: opts.loc,
      PurchaseOrderItem: {
        create: {
          id: itemId, description: 'I53 postavka', quantityOrdered: opts.qty ?? 10,
          unit: 'pcs', unitPrice: 1, vatRate: 22, totalPrice: 12.2, inventoryItemId: opts.itemId,
        },
      },
    },
  })
  return { id, itemId }
}

async function mkGrnDirect(poId: string, loc: string | null, key: string): Promise<string> {
  const id = nid()
  await db.goodsReceipt.create({
    data: {
      id, grnNumber: `GRN-I53-${RUN}-${++grnSeq}`, purchaseOrderId: poId,
      supplierId: supA, status: 'confirmed', locationId: loc, idempotencyKey: key,
    },
  })
  return id
}

const postPo = (token: string, body: Record<string, unknown>) =>
  status(poPOST(req('/api/purchase-orders', token, 'POST', body)))

const recv = (token: string, poId: string, body: Record<string, unknown>) =>
  status(receivePOST(req(`/api/purchase-orders/${poId}/receive`, token, 'POST', body), { params: Promise.resolve({ id: poId }) }))

const getPo = (token: string, poId: string) =>
  status(poGET(req(`/api/purchase-orders/${poId}`, token), { params: Promise.resolve({ id: poId }) }))

const patchPo = (token: string, poId: string, body: Record<string, unknown>) =>
  status(poPATCH(req(`/api/purchase-orders/${poId}`, token, 'PATCH', body), { params: Promise.resolve({ id: poId }) }))

const pay = (token: string, body: Record<string, unknown>) =>
  status(fursPOST(req('/api/furs', token, 'POST', body)))

const storno = (token: string, receiptId: string) =>
  status(stornoPOST(req(`/api/receipts/${receiptId}/storno`, token, 'POST', { reason: 'testni storno razlog' }), { params: Promise.resolve({ id: receiptId }) }))

beforeAll(async () => {
  await cleanupFixtures()
  orgA = `${PREFIX}orgA-${RUN}`; brandA = `${PREFIX}brandA-${RUN}`; propA = `${PREFIX}propA-${RUN}`
  orgB = `${PREFIX}orgB-${RUN}`; brandB = `${PREFIX}brandB-${RUN}`; propB = `${PREFIX}propB-${RUN}`
  locA1 = `${PREFIX}locA1-${RUN}`; locA2 = `${PREFIX}locA2-${RUN}`; locB1 = `${PREFIX}locB1-${RUN}`; locNoEnv = `${PREFIX}locNE-${RUN}`
  await db.organization.create({ data: { id: orgA, name: 'I53 Org A', slug: `${PREFIX}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: 'I53 Org B', slug: `${PREFIX}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: 'I53 BA' } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: 'I53 BB' } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: 'I53 PA' } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: 'I53 PB' } })
  // locA1: fursEnvironment 'test' (izrecni testni profil — produkcija ga dovoli);
  // locNoEnv: PRAZEN fursEnvironment (shema privzame 'test' ob ustvarjanju — prazen
  // niz simulira legacy/nastavljensko vrstico brez veljavnega okolja za 503 test)
  await db.location.create({ data: { id: locA1, name: 'I53 A1', code: `${PREFIX}A1-${RUN}`, propertyId: propA, fursEnvironment: 'test' } })
  await db.location.create({ data: { id: locA2, name: 'I53 A2', code: `${PREFIX}A2-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locB1, name: 'I53 B1', code: `${PREFIX}B1-${RUN}`, propertyId: propB } })
  await db.location.create({ data: { id: locNoEnv, name: 'I53 NE', code: `${PREFIX}NE-${RUN}`, propertyId: propA, fursEnvironment: '' } })

  managerA = nid(); adminA = nid(); managerB = nid()
  await db.employee.create({ data: { id: managerA, name: `${PREFIX}mA`, email: `${managerA}@test.local`, role: 'manager', status: 'active', sessionVersion: 0, locationId: locA1, pin: `${PREFIX}a` } })
  await db.employee.create({ data: { id: adminA, name: `${PREFIX}aA`, email: `${adminA}@test.local`, role: 'admin', status: 'active', sessionVersion: 0, locationId: locA1, pin: `${PREFIX}ad` } })
  await db.employee.create({ data: { id: managerB, name: `${PREFIX}mB`, email: `${managerB}@test.local`, role: 'manager', status: 'active', sessionVersion: 0, locationId: locB1, pin: `${PREFIX}b` } })

  supA = `${PREFIX}supA-${RUN}`; supB = `${PREFIX}supB-${RUN}`
  await db.supplier.create({ data: { id: supA, name: 'I53 dobavitelj A', code: `${PREFIX}SA-${RUN}`, email: 'a@i53.test' } })
  await db.supplier.create({ data: { id: supB, name: 'I53 dobavitelj B', code: `${PREFIX}SB-${RUN}`, email: 'b@i53.test' } })

  invA1 = `${PREFIX}invA1-${RUN}`; invA2 = `${PREFIX}invA2-${RUN}`; invB1 = `${PREFIX}invB1-${RUN}`; invLegacy = `${PREFIX}invLg-${RUN}`
  await db.inventoryItem.create({ data: { id: invA1, name: 'I53 moka A1', unit: 'kg', locationId: locA1 } })
  await db.inventoryItem.create({ data: { id: invA2, name: 'I53 olje A2', unit: 'l', locationId: locA2 } })
  await db.inventoryItem.create({ data: { id: invB1, name: 'I53 sol B1', unit: 'kg', locationId: locB1 } })
  await db.inventoryItem.create({ data: { id: invLegacy, name: 'I53 legacy artikel', unit: 'kg', locationId: null } })

  // meni/artikli za furs naročila (locA1 'test' + locNoEnv brez env)
  const menuA = nid(), catA = nid()
  await db.menu.create({ data: { id: menuA, name: 'I53 meni A', locationId: locA1 } })
  await db.category.create({ data: { id: catA, name: 'I53 kat A', menuId: menuA } })
  miA = nid()
  await db.menuItem.create({ data: { id: miA, name: 'I53 artikel A', price: 10, categoryId: catA, vatRate: 22 } })
  const menuN = nid(), catN = nid()
  await db.menu.create({ data: { id: menuN, name: 'I53 meni N', locationId: locNoEnv } })
  await db.category.create({ data: { id: catN, name: 'I53 kat N', menuId: menuN } })
  miN = nid()
  await db.menuItem.create({ data: { id: miN, name: 'I53 artikel N', price: 10, categoryId: catN, vatRate: 22 } })
})

afterAll(async () => {
  await cleanupFixtures()
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #53 — resolveFiscalProfile: čisto jedro (brez DB)
// ════════════════════════════════════════════════════════════════════════════
describe('#53 resolveFiscalProfile — produkcija fail-closed', () => {
  const errCode = (fn: () => unknown): { code: string; status: number; message: string } => {
    try {
      fn()
      throw new Error('expected FiscalConfigError')
    } catch (e) {
      expect(e).toBeInstanceOf(FiscalConfigError)
      const f = e as FiscalConfigError
      return { code: f.code, status: f.status, message: f.message }
    }
  }

  it('produkcija BREZ obeh env → FISCAL_CONFIG_MISSING (503) — ne več privzeta simulacija', () => {
    const e = errCode(() => resolveFiscalProfile({ nodeEnv: 'production' }))
    expect(e.code).toBe('FISCAL_CONFIG_MISSING')
    expect(e.status).toBe(503)
  })

  it('produkcija + globalni env "simulation" → FISCAL_SIMULATION_IN_PRODUCTION (503)', () => {
    const e = errCode(() => resolveFiscalProfile({ nodeEnv: 'production', globalEnv: 'simulation' }))
    expect(e.code).toBe('FISCAL_SIMULATION_IN_PRODUCTION')
  })

  it('produkcija + lokacijski env "simulation" (brez globalnega) → zavrnjeno (503)', () => {
    const e = errCode(() => resolveFiscalProfile({ nodeEnv: 'production', locationEnv: 'simulation' }))
    expect(e.code).toBe('FISCAL_SIMULATION_IN_PRODUCTION')
  })

  it('produkcija + env "production" + FURS_ALLOW_SIMULATION=true → zavrnjeno (prisiljena simulacija nad PRODUKCIJSKIM okoljem = fail-open vektor)', () => {
    const e = errCode(() => resolveFiscalProfile({ nodeEnv: 'production', globalEnv: 'production', allowSimulation: 'true' }))
    expect(e.code).toBe('FISCAL_SIMULATION_IN_PRODUCTION')
  })

  it('produkcija + izrecni "test" + FURS_ALLOW_SIMULATION=true → DOVOLJEN (redundantna zastavica nad testnim profilom — ne blokira izdaje)', () => {
    const p = resolveFiscalProfile({ nodeEnv: 'production', globalEnv: 'test', allowSimulation: 'true' })
    expect(p.environment).toBe('test')
    expect(p.simulation).toBe(true)
  })

  it('produkcija + "simulation" + FURS_PRODUCTION_TEST_MODE=true → NAMENSKO dovoljen testni način', () => {
    const p = resolveFiscalProfile({ nodeEnv: 'production', globalEnv: 'simulation', productionTestMode: 'true' })
    expect(p.environment).toBe('simulation')
    expect(p.simulation).toBe(true)
    expect(p.productionTestMode).toBe(true)
  })

  it('produkcija + globalni "test" → dovoljen izrecni testni profil (simulacijski kodni tok, §18)', () => {
    const p = resolveFiscalProfile({ nodeEnv: 'production', globalEnv: 'test' })
    expect(p.environment).toBe('test')
    expect(p.simulation).toBe(true)
    expect(p.source).toBe('global')
  })

  it('produkcija + lokacijski "test" (brez globalnega) → dovoljen; source=location', () => {
    const p = resolveFiscalProfile({ nodeEnv: 'production', locationEnv: 'test' })
    expect(p.environment).toBe('test')
    expect(p.simulation).toBe(true)
    expect(p.source).toBe('location')
  })

  it('produkcija + "production" → živi profil (simulation=false)', () => {
    const p = resolveFiscalProfile({ nodeEnv: 'production', globalEnv: 'production' })
    expect(p.simulation).toBe(false)
    expect(p.productionRuntime).toBe(true)
  })

  it('globalni env ima PREDNOST pred lokacijo (kot prej)', () => {
    const p = resolveFiscalProfile({ nodeEnv: 'production', globalEnv: 'production', locationEnv: 'test' })
    expect(p.environment).toBe('production')
    expect(p.simulation).toBe(false)
  })

  it('typo vrednosti → FISCAL_CONFIG_INVALID v VSEH runtimeih (ne tiho v produkcijo)', () => {
    expect(errCode(() => resolveFiscalProfile({ nodeEnv: 'production', globalEnv: 'prod' })).code).toBe('FISCAL_CONFIG_INVALID')
    expect(errCode(() => resolveFiscalProfile({ nodeEnv: 'development', globalEnv: 'prod' })).code).toBe('FISCAL_CONFIG_INVALID')
    expect(errCode(() => resolveFiscalProfile({ locationEnv: 'produc' })).code).toBe('FISCAL_CONFIG_INVALID')
  })

  it('veljavnost je case-insensitive; neveljavne praznine se ignorirajo', () => {
    expect(resolveFiscalProfile({ nodeEnv: 'production', globalEnv: 'PRODUCTION' }).environment).toBe('production')
    expect(resolveFiscalProfile({ nodeEnv: 'production', globalEnv: '  Test  ' }).environment).toBe('test')
    expect(resolveFiscalProfile({ nodeEnv: 'production', globalEnv: '', locationEnv: 'simulation', productionTestMode: 'true' }).environment).toBe('simulation')
  })
})

describe('#53 resolveFiscalProfile — development/test runtime (obstoječe vedenje)', () => {
  it('dev BREZ env → privzeta simulacija (razvojna ergonomija, §18)', () => {
    const p = resolveFiscalProfile({ nodeEnv: 'development' })
    expect(p.environment).toBe('simulation')
    expect(p.simulation).toBe(true)
    expect(p.source).toBe('default')
  })

  it('dev + env "production" + FURS_ALLOW_SIMULATION=true → simulacija vpriličena (dev)', () => {
    const p = resolveFiscalProfile({ nodeEnv: 'development', globalEnv: 'production', allowSimulation: 'true' })
    expect(p.simulation).toBe(true)
  })

  it('dev + env "test" → simulacijski tok z izrecno oznako test', () => {
    const p = resolveFiscalProfile({ nodeEnv: 'test', globalEnv: 'test' })
    expect(p.environment).toBe('test')
    expect(p.simulation).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #53 — furs POST + storno v produkciji (NODE_ENV mutacija, pi49 vzorec)
// ════════════════════════════════════════════════════════════════════════════
describe('#53 furs POST + storno — produkcija (NODE_ENV=production)', () => {
  const PREV_NODE_ENV = process.env.NODE_ENV
  const PREV_FURS_ENV = process.env.FURS_ENVIRONMENT
  const PREV_ALLOW = process.env.FURS_ALLOW_SIMULATION
  const PREV_TEST_MODE = process.env.FURS_PRODUCTION_TEST_MODE

  beforeAll(() => {
    process.env.NODE_ENV = 'production'
    delete process.env.FURS_ENVIRONMENT // lokacija odloča (locA1 'test', locNoEnv brez)
    delete process.env.FURS_ALLOW_SIMULATION
    delete process.env.FURS_PRODUCTION_TEST_MODE
  })
  afterAll(() => {
    if (PREV_NODE_ENV === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = PREV_NODE_ENV
    if (PREV_FURS_ENV === undefined) delete process.env.FURS_ENVIRONMENT
    else process.env.FURS_ENVIRONMENT = PREV_FURS_ENV
    if (PREV_ALLOW === undefined) delete process.env.FURS_ALLOW_SIMULATION
    else process.env.FURS_ALLOW_SIMULATION = PREV_ALLOW
    if (PREV_TEST_MODE === undefined) delete process.env.FURS_PRODUCTION_TEST_MODE
    else process.env.FURS_PRODUCTION_TEST_MODE = PREV_TEST_MODE
  })

  it('lokacija BREZ fursEnvironment → 503, BREZ Payment/Receipt/Check (fail-closed pred zapisom)', async () => {
    const adminTok = tok(adminA, `${PREFIX}aA`, 'ADMIN', locA1)
    const orderId = await mkOrder(locNoEnv, miN)
    const beforeReceipts = await db.receipt.count({ where: { orderId } })
    const r = await pay(adminTok, { orderId, type: 'cash' })
    expect(r.code).toBe(503)
    expect(String(r.body.error)).toMatch(/nastavljeno|okolje/i)
    // NIČ ni bilo ustvarjeno (PREJ: račun s fiscalStatus 'verified' iz privzete simulacije)
    expect(await db.receipt.count({ where: { orderId } })).toBe(beforeReceipts)
    expect(await db.check.count({ where: { orderId } })).toBe(0)
    expect(await db.payment.count({ where: { Check: { orderId } } })).toBe(0)
    expect(await db.order.findUnique({ where: { id: orderId } }).then((o) => o?.paymentStatus)).toBe('unpaid')
  })

  it('lokacija z izrecnim "test" → 201; odgovor in revizija označita okolje "test" (ne "simulation")', async () => {
    const mgrTok = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
    const orderId = await mkOrder(locA1, miA)
    const r = await pay(mgrTok, { orderId, type: 'cash' })
    expect(r.code).toBe(201)
    // Issue #53 §4: izrecna razločitev — test se NE predstavlja kot simulation niti production
    expect(r.body.fursEnvironment).toBe('test')
    expect((r.body.fiscal as Record<string, unknown>).simulated).toBe(true)
    // simulacijski kodni tok (§18): test = simulirane kode + verified ob uspehu
    expect(r.body.fiscalStatus).toBe('verified')
    expect(r.body.fiscalVerified).toBe(true)
    const receiptId = String((r.body.invoice as Record<string, unknown>).id)
    const receipt = await db.receipt.findUnique({ where: { id: receiptId } })
    expect(receipt?.fiscalStatus).toBe('verified')
    const audit = await db.auditLog.findFirst({ where: { action: 'INVOICE_ISSUE', entityId: receiptId } })
    expect(audit).not.toBeNull()
    expect(String(audit?.details)).toContain('"fursEnvironment":"test"')
    expect(String(audit?.details)).toContain('"fursProfileSource":"location"')
  })

  it('FURS_ALLOW_SIMULATION=true nad izrecnim "test" (lokacija) → 201 — zastavica redundančna, izdaja poteka z oznako test', async () => {
    process.env.FURS_ALLOW_SIMULATION = 'true'
    try {
      const mgrTok = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
      const orderId = await mkOrder(locA1, miA)
      const r = await pay(mgrTok, { orderId, type: 'cash' })
      expect(r.code).toBe(201)
      expect(r.body.fursEnvironment).toBe('test')
      expect(r.body.fiscalStatus).toBe('verified')
    } finally {
      delete process.env.FURS_ALLOW_SIMULATION
    }
  })

  it('FURS_ALLOW_SIMULATION=true + globalni env "production" → 503 (zastavica ne sme prisiliti simulacije nad produkcijo)', async () => {
    process.env.FURS_ALLOW_SIMULATION = 'true'
    process.env.FURS_ENVIRONMENT = 'production'
    try {
      const mgrTok = tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
      const orderId = await mkOrder(locA1, miA)
      const r = await pay(mgrTok, { orderId, type: 'cash' })
      expect(r.code).toBe(503)
      expect(String(r.body.error)).toMatch(/FURS_ALLOW_SIMULATION/i)
      expect(await db.receipt.count({ where: { orderId } })).toBe(0)
      expect(await db.order.findUnique({ where: { id: orderId } }).then((o) => o?.paymentStatus)).toBe('unpaid')
    } finally {
      delete process.env.FURS_ALLOW_SIMULATION
      delete process.env.FURS_ENVIRONMENT
    }
  })

  it('storno na lokaciji brez okolja → 503, BREZ storno računa (ista vrata kot izdaja)', async () => {
    const adminTok = tok(adminA, `${PREFIX}aA`, 'ADMIN', locA1)
    const receiptId = await mkPaidReceipt(locNoEnv)
    const r = await storno(adminTok, receiptId)
    expect(r.code).toBe(503)
    expect(String(r.body.error)).toMatch(/nastavljeno|okolje/i)
    expect(await db.receipt.count({ where: { stornoOf: receiptId } })).toBe(0)
    const order = await db.receipt.findUnique({ where: { id: receiptId } }).then((rc) => db.order.findUnique({ where: { id: rc!.orderId } }))
    expect(order?.paymentStatus).toBe('paid')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #54 — POST /api/purchase-orders: obseg lokacije + artiklov
// ════════════════════════════════════════════════════════════════════════════
describe('#54 POST /api/purchase-orders — obseg', () => {
  const mgrATok = () => tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
  const adminATok = () => tok(adminA, `${PREFIX}aA`, 'ADMIN', locA1)

  it('MANAGER A s client locationId=B → 403; BREZ PO in SupplierItem zapisa', async () => {
    const before = await db.purchaseOrder.count({ where: { supplierId: supA } })
    const r = await postPo(mgrATok(), {
      supplierId: supA, locationId: locB1,
      lines: [{ inventoryItemId: invA1, quantity: 1, unitPrice: 1 }],
    })
    expect(r.code).toBe(403)
    expect(String(r.body.error)).toMatch(/lokacij/i)
    expect(await db.purchaseOrder.count({ where: { supplierId: supA } })).toBe(before)
    expect(await db.supplierItem.count({ where: { supplierId: supA } })).toBe(0)
  })

  it('artikel DUGE lokacije (locB1) v naročilu za locA1 → 403 brez PO', async () => {
    const before = await db.purchaseOrder.count({ where: { supplierId: supA } })
    const r = await postPo(mgrATok(), {
      supplierId: supA,
      lines: [{ inventoryItemId: invB1, quantity: 1, unitPrice: 1 }],
    })
    expect(r.code).toBe(403)
    expect(String(r.body.error)).toMatch(/drugi lokaciji/i)
    expect(await db.purchaseOrder.count({ where: { supplierId: supA } })).toBe(before)
  })

  it('artikel ISTE org, DRUGE lokacije (locA2) → 403 (striktni lokacijski obseg artiklov)', async () => {
    const r = await postPo(mgrATok(), {
      supplierId: supA,
      lines: [{ inventoryItemId: invA2, quantity: 1, unitPrice: 1 }],
    })
    expect(r.code).toBe(403)
  })

  it('legacy artikel BREZ lokacije → dovoljen (migracijsko varen nadaljnji tok)', async () => {
    const r = await postPo(mgrATok(), {
      supplierId: supA,
      lines: [{ inventoryItemId: invLegacy, quantity: 1, unitPrice: 1 }],
    })
    expect(r.code).toBe(201)
    expect(await db.purchaseOrder.findFirst({ where: { supplierId: supA }, orderBy: { createdAt: 'desc' } }).then((p) => p?.locationId)).toBe(locA1)
  })

  it('MANAGER A happy path (svoj artikel, svoja lokacija) → 201 + katalog dobavitelja', async () => {
    const r = await postPo(mgrATok(), {
      supplierId: supA,
      lines: [{ inventoryItemId: invA1, quantity: 5, unitPrice: 2 }],
    })
    expect(r.code).toBe(201)
    expect(await db.supplierItem.count({ where: { supplierId: supA, inventoryItemId: invA1 } })).toBe(1)
  })

  it('ADMIN orgA z locationId=locA2 (ista org) → 201; s locationId=locB1 (tuja org) → 403', async () => {
    const rSameOrg = await postPo(adminATok(), {
      supplierId: supA, locationId: locA2,
      lines: [{ inventoryItemId: invA2, quantity: 1, unitPrice: 1 }],
    })
    expect(rSameOrg.code).toBe(201)
    const rForeign = await postPo(adminATok(), {
      supplierId: supA, locationId: locB1,
      lines: [{ description: 'opisna vrstica', quantity: 1, unitPrice: 1 }],
    })
    expect(rForeign.code).toBe(403)
    expect(String(rForeign.body.error)).toMatch(/organizacij/i)
  })

  it('ADMIN z bogus locationId → 404 (ne naročilo z namišljeno lokacijo)', async () => {
    const r = await postPo(adminATok(), {
      supplierId: supA, locationId: `${PREFIX}neobstoji`,
      lines: [{ description: 'x', quantity: 1, unitPrice: 1 }],
    })
    expect(r.code).toBe(404)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #54 — receive: obseg PO, lokacija prevzema, transakcijska varnost
// ════════════════════════════════════════════════════════════════════════════
describe('#54 receive — obseg naročila in lokacije prevzema', () => {
  const mgrATok = () => tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
  const mgrBTok = () => tok(managerB, `${PREFIX}mB`, 'MANAGER', locB1)
  const adminATok = () => tok(adminA, `${PREFIX}aA`, 'ADMIN', locA1)

  it('MANAGER A prevzame PO lokacije B → 403; zaloga/status/GRN/AP nespremenjeni', async () => {
    const { id, itemId } = await mkPoDirect({ loc: locB1, supplierId: supB, itemId: invB1 })
    const qtyBefore = Number((await db.inventoryItem.findUnique({ where: { id: invB1 } }))!.quantity)
    const r = await recv(mgrATok(), id, { lines: [{ purchaseOrderItemId: itemId, quantityAccepted: 5 }] })
    expect(r.code).toBe(403)
    expect(await db.goodsReceipt.count({ where: { purchaseOrderId: id } })).toBe(0)
    expect(await db.purchaseOrder.findUnique({ where: { id } }).then((p) => p?.status)).toBe('approved')
    expect(Number((await db.inventoryItem.findUnique({ where: { id: invB1 } }))!.quantity)).toBe(qtyBefore)
    expect(await db.stockTransaction.count({ where: { inventoryItemId: invB1 } })).toBe(0)
    expect(await db.accountsPayable.count({ where: { purchaseOrderId: id } })).toBe(0)
  })

  it('MANAGER A happy path → 201: GRN na lokaciji PO, zaloga/utežena cena/serija/sled/AP/revizija', async () => {
    const { id, itemId } = await mkPoDirect({ loc: locA1, supplierId: supA, itemId: invA1 })
    const r = await recv(mgrATok(), id, {
      supplierDocNumber: 'I53-FA-1',
      lines: [{ purchaseOrderItemId: itemId, quantityAccepted: 5 }],
    })
    expect(r.code).toBe(201)
    const grn = await db.goodsReceipt.findFirst({ where: { purchaseOrderId: id } })
    expect(grn?.locationId).toBe(locA1)
    const inv = await db.inventoryItem.findUnique({ where: { id: invA1 } })
    expect(Number(inv?.quantity)).toBe(5)
    expect(Number(inv?.costPerUnit)).toBe(1)
    expect(await db.inventoryBatch.count({ where: { locationId: locA1, inventoryItemId: invA1 } })).toBe(1)
    expect(await db.stockTransaction.count({ where: { inventoryItemId: invA1, type: 'purchase' } })).toBe(1)
    expect(await db.purchaseOrder.findUnique({ where: { id } }).then((p) => p?.status)).toBe('partial')
    expect(await db.accountsPayable.count({ where: { purchaseOrderId: id } })).toBe(1)
    expect(await db.auditLog.count({ where: { action: 'GRN_RECEIVE', entityType: 'GoodsReceipt', entityId: grn!.id } })).toBe(1)
  })

  it('body.locationId=B za PO lokacije A → 403 (premik prevzema na drugo lokacijo)', async () => {
    const { id, itemId } = await mkPoDirect({ loc: locA1, supplierId: supA, itemId: invA1 })
    const r = await recv(adminATok(), id, {
      locationId: locA2,
      lines: [{ purchaseOrderItemId: itemId, quantityAccepted: 1 }],
    })
    expect(r.code).toBe(403)
    expect(String(r.body.error)).toMatch(/drugi lokaciji/i)
    expect(await db.goodsReceipt.count({ where: { purchaseOrderId: id } })).toBe(0)
  })

  it('idempotentni replay TUJEGA uporabnika → 403 PRED replayom (ključ ni poverilnica)', async () => {
    const { id, itemId } = await mkPoDirect({ loc: locA1, supplierId: supA, itemId: invA1 })
    const key = `i53-replay-${RUN}`
    const first = await recv(mgrATok(), id, { idempotencyKey: key, lines: [{ purchaseOrderItemId: itemId, quantityAccepted: 2 }] })
    expect(first.code).toBe(201)
    // uporabnik iz DRUGE org z istim ključem na istem PO → guard 403 (brez metapodatkov GRN)
    const r = await recv(mgrBTok(), id, { idempotencyKey: key, lines: [{ purchaseOrderItemId: itemId, quantityAccepted: 2 }] })
    expect(r.code).toBe(403)
    expect(await db.goodsReceipt.count({ where: { purchaseOrderId: id } })).toBe(1)
    // lastnik replaya še vedno deluje (200, isti GRN)
    const again = await recv(mgrATok(), id, { idempotencyKey: key, lines: [{ purchaseOrderItemId: itemId, quantityAccepted: 2 }] })
    expect(again.code).toBe(200)
    expect(again.body.receipt).toBeTruthy()
  })

  it('legacy PO BREZ lokacije: MANAGER → 403 (fail-closed); ADMIN izrecno določi lokacijo → 201', async () => {
    const { id, itemId } = await mkPoDirect({ loc: null, supplierId: supA, itemId: invA1 })
    const rMgr = await recv(mgrATok(), id, { lines: [{ purchaseOrderItemId: itemId, quantityAccepted: 1 }] })
    expect(rMgr.code).toBe(403)
    expect(String(rMgr.body.error)).toMatch(/lokacij/i)
    const rAdm = await recv(adminATok(), id, {
      locationId: locA1,
      lines: [{ purchaseOrderItemId: itemId, quantityAccepted: 1 }],
    })
    expect(rAdm.code).toBe(201)
    const grn = await db.goodsReceipt.findFirst({ where: { purchaseOrderId: id } })
    expect(grn?.locationId).toBe(locA1)
  })

  it('legacy PO s TUJO referenco artikla → 400 + rollback celote (zaloga se NE spremeni)', async () => {
    // PO na locA1, a artikel pripada locB1 — sprejetje bi dvignilo ceno/količino TUJE zaloge
    const { id, itemId } = await mkPoDirect({ loc: locA1, supplierId: supA, itemId: invB1 })
    const qtyBefore = Number((await db.inventoryItem.findUnique({ where: { id: invB1 } }))!.quantity)
    const r = await recv(adminATok(), id, { lines: [{ purchaseOrderItemId: itemId, quantityAccepted: 5 }] })
    expect(r.code).toBe(400)
    expect(String(r.body.error)).toMatch(/drugi lokaciji/i)
    expect(await db.goodsReceipt.count({ where: { purchaseOrderId: id } })).toBe(0)
    expect(Number((await db.inventoryItem.findUnique({ where: { id: invB1 } }))!.quantity)).toBe(qtyBefore)
    expect(await db.purchaseOrder.findUnique({ where: { id } }).then((p) => p?.status)).toBe('approved')
    expect(await db.accountsPayable.count({ where: { purchaseOrderId: id } })).toBe(0)
  })

  it('PO preklican MED branjem in zapisom → 409 (sveža preverba znotraj transakcije)', async () => {
    const { id, itemId } = await mkPoDirect({ loc: locA1, supplierId: supA, itemId: invA1 })
    // simuliraj sočasni preklic: status se spremeni ZUNAJ (PATCH teče vzporedno)
    await db.purchaseOrder.update({ where: { id }, data: { status: 'cancelled' } })
    const r = await recv(mgrATok(), id, { lines: [{ purchaseOrderItemId: itemId, quantityAccepted: 1 }] })
    expect(r.code).toBe(409)
    expect(String(r.body.error)).toMatch(/cancelled|odobrenem/i)
    expect(await db.goodsReceipt.count({ where: { purchaseOrderId: id } })).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #54 — GET/PATCH [id]: isti obseg kot seznam
// ════════════════════════════════════════════════════════════════════════════
describe('#54 GET/PATCH /api/purchase-orders/[id] — obseg', () => {
  const mgrATok = () => tok(managerA, `${PREFIX}mA`, 'MANAGER', locA1)
  const mgrBTok = () => tok(managerB, `${PREFIX}mB`, 'MANAGER', locB1)

  it('MANAGER B GET detail TUJEGA PO → 403 (prej: requireAuth je razkrival vse)', async () => {
    const { id } = await mkPoDirect({ loc: locA1, supplierId: supA, itemId: invA1 })
    const r = await getPo(mgrBTok(), id)
    expect(r.code).toBe(403)
    const own = await getPo(mgrATok(), id)
    expect(own.code).toBe(200)
  })

  it('MANAGER B PATCH (preklic) TUJEGA PO → 403, status nespremenjen; lastnik prekliče → 200', async () => {
    const { id } = await mkPoDirect({ loc: locA1, supplierId: supA, itemId: invA1 })
    const r = await patchPo(mgrBTok(), id, { action: 'cancel' })
    expect(r.code).toBe(403)
    expect(await db.purchaseOrder.findUnique({ where: { id } }).then((p) => p?.status)).toBe('approved')
    const own = await patchPo(mgrATok(), id, { action: 'cancel' })
    expect(own.code).toBe(200)
    expect(await db.purchaseOrder.findUnique({ where: { id } }).then((p) => p?.status)).toBe('cancelled')
  })
})
