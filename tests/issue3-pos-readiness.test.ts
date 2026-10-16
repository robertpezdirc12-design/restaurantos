/**
 * Issue #3 (P1 Konkurenčna pripravljenost POS) — P0/P1 popravki (v1.120.0):
 *
 *  GAP-1 (P0) offline dead-letter:
 *   - markOpAttempt ×10 → op OSTANE v vrsti s status 'dead' (prej: TIHA izguba);
 *   - prehod v dead-letter sproži reportDeadOp → POST /api/sync/drop (mock fetch);
 *   - flushQueue dead operacij NE pošlje (samo žive) + FlushResult.dead števec;
 *   - resetDeadOp rekvira (attempts=0, status queued), clearDeadOps/getDeadOps;
 *   - nazajkompatibilnost: op BREZ status polja se obnaša kot 'queued';
 *   - ruta: veljavno telo → 201 + AuditLog SYNC_OP_DROPPED (chainHash zapisan);
 *     slab kind / attempts izven obsega / manjkajoči id → 400; brez žetona → 401.
 *  GAP-2 (P0) print poštenost: parsePrintAck sprejme 'sent', zavrne neznan status;
 *   source-pin: devices/print.ts agent pot (printLines + printLabelDocument)
 *   pošilja ackStatus 'sent', print.ts PRINT_STATUSES vsebuje 'sent'.
 *  GAP-3 (P0) fiskalni audit: mock TLS strežnik zavrne EOR/JIR → račun ostane
 *   'pending' + AuditLog FISCAL_SUBMIT_FAILED (provider FURS in CIS).
 *  GAP-7 (P2) monitoring filter: GET /api/monitoring/errors vključi PRINT_FAILED.
 *  GAP-8 (P2) Stripe verify varovalka: source-pin 502 + i18n preslikava/ključi.
 *
 * Fiksture s predpono `i3-`. localStorage/fetch mock sta SAMO znotraj tega teka
 * (afterAll povrnete globalne). Env (FURS_*) se shrani in povrne.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import forge from 'node-forge'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { nid } from '../src/lib/map'
import { loadCertMaterial } from '../src/lib/furs/client'
import {
  enqueueOp, getQueue, markOpAttempt, getDeadOps, resetDeadOp, clearDeadOps,
  flushQueue, reportDeadOp, type QueuedOp,
} from '../src/lib/offline-queue'
import { parsePrintAck, PRINT_STATUSES } from '../src/lib/print'
import { POST as dropPOST } from '../src/app/api/sync/drop/route'
import { GET as errorsGET } from '../src/app/api/monitoring/errors/route'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { guestApiErrorKey } from '../src/components/guest-i18n'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { en } from '../src/lib/i18n/en'

const P = 'i3-'
const RUN = Date.now().toString(36)
const PIN = `${String(Date.now()).slice(-6)}7`

// ── localStorage mock (offline-queue.ts je 'use client' — brez brskalnika) ──
const lsBacking = new Map<string, string>()
const localStorageMock: Storage = {
  getItem: (k) => (lsBacking.has(String(k)) ? (lsBacking.get(String(k)) as string) : null),
  setItem: (k, v) => { lsBacking.set(String(k), String(v)) },
  removeItem: (k) => { lsBacking.delete(String(k)) },
  clear: () => { lsBacking.clear() },
  key: (i) => [...lsBacking.keys()][i] ?? null,
  get length() { return lsBacking.size },
}
const g = globalThis as unknown as Record<string, unknown>
let prevWindow: unknown
let prevLocalStorage: unknown
let prevFetch: unknown

// ── fetch mock (beleži klice; privzeto 200 s praznimi rezultati) ──
interface RecordedCall { url: string; init: RequestInit }
let fetchCalls: RecordedCall[] = []
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  fetchCalls = []
  g.fetch = (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} })
    return Promise.resolve(handler(String(url), init))
  }
}

function req(url: string, token: string | null, method = 'GET', body?: unknown): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// ── DB fiksture (manager za drop/monitoring/furs) ──
let locSI = ''
let locHR = ''
let mgrId = ''
let mgrToken = ''
let mgrHRToken = ''

let orderSeqCounter = 991000
async function seedOrder(locId: string, suffix: string): Promise<string> {
  const orderId = `${P}ord-${suffix}-${RUN}`
  const menuId = `${P}menu-${suffix}-${RUN}`
  const catId = `${P}cat-${suffix}-${RUN}`
  const miId = `${P}mi-${suffix}-${RUN}`
  await db.menu.create({ data: { id: menuId, name: `${P}Meni ${suffix}`, locationId: locId } })
  await db.category.create({ data: { id: catId, name: `${P}Kategorija`, menuId } })
  await db.menuItem.create({ data: { id: miId, name: `${P}Jed`, price: 5, categoryId: catId, vatRate: 22 } })
  await db.order.create({
    data: { id: orderId, orderNumber: ++orderSeqCounter, locationId: locId, tableId: null, status: 'open', paymentStatus: 'unpaid', subtotal: 5, tax: 0.9, total: 5.9 },
  })
  await db.orderItem.create({
    data: { id: `${P}itm-${suffix}-${RUN}`, orderId, menuItemId: miId, quantity: 1, price: 5, vatRate: 22, vatAmount: 0.9, menuItemName: `${P}Jed`, status: 'pending', voided: false },
  })
  return orderId
}

/** Fire-and-forget AuditLog zapis (writeAudit v catch bloku) — polling z timeoutom. */
async function waitForAudit(action: string, entityId: string, ms = 4000): Promise<{ details: string; chainHash: string } | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const row = await db.auditLog.findFirst({ where: { action, entityId }, select: { details: true, chainHash: true } })
    if (row) return row
    await new Promise((r) => setTimeout(r, 40))
  }
  return null
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  prevWindow = g.window
  prevLocalStorage = g.localStorage
  prevFetch = g.fetch
  g.window = { localStorage: localStorageMock }
  g.localStorage = localStorageMock

  locSI = (await db.location.create({
    data: { id: `${P}loc-si-${RUN}`, name: `${P}Lokacija SI`, code: `I3SI-${RUN.toUpperCase()}`, premisesId: `${P}SI-${RUN}`, taxId: 'SI12345678', registerNumber: 'BLG-I3-01', country: 'SI', fursEnvironment: 'production' },
  })).id
  locHR = (await db.location.create({
    data: { id: `${P}loc-hr-${RUN}`, name: `${P}Lokacija HR`, code: `I3HR-${RUN.toUpperCase()}`, premisesId: `${P}HR-${RUN}`, taxId: '12345678901', registerNumber: '1', country: 'HR', fursEnvironment: 'production' },
  })).id
  const fields = employeePinFields(PIN, `${P}mgr-${RUN}@test.local`)
  mgrId = `${P}mgr-${RUN}`
  await db.employee.create({
    data: {
      id: mgrId, name: `${P}Manager`, email: `${P}mgr-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locSI,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
  mgrToken = createToken({ sub: mgrId, name: `${P}Manager`, role: 'manager', loc: locSI, sv: 0 })
  // issue #4 §1: plačilo tujega naročila je ZAVRJENO — HR tok potrebuje lastnega
  // managerja na HR lokaciji (guardResource na orderPre.locationId)
  const fieldsHR = employeePinFields(`${PIN.slice(0, -1)}8`, `${P}mgrhr-${RUN}@test.local`)
  const mgrHRId = `${P}mgrhr-${RUN}`
  await db.employee.create({
    data: {
      id: mgrHRId, name: `${P}ManagerHR`, email: `${P}mgrhr-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locHR,
      pin: fieldsHR.pin, pinLookup: fieldsHR.pinLookup,
    },
  })
  mgrHRToken = createToken({ sub: mgrHRId, name: `${P}ManagerHR`, role: 'manager', loc: locHR, sv: 0 })
})

afterAll(async () => {
  // globalni mock povrnitev (isti proces teče tudi druge datoteke!)
  if (prevWindow === undefined) delete g.window
  else g.window = prevWindow
  if (prevLocalStorage === undefined) delete g.localStorage
  else g.localStorage = prevLocalStorage
  g.fetch = prevFetch

  // ročno: dokazi furs teka (nid() id-ji — po entityId/details predponi)
  const locIds = [locSI, locHR]
  for (const locId of locIds) {
    if (!locId) continue
    const orders = await db.order.findMany({ where: { locationId: locId }, select: { id: true } })
    for (const oid of orders.map((o) => o.id)) {
      const receipts = await db.receipt.findMany({ where: { orderId: oid }, select: { id: true } })
      const receiptIds = receipts.map((r) => r.id)
      const checks = await db.check.findMany({ where: { orderId: oid }, select: { id: true } })
      await db.payment.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
      await db.eventLog.deleteMany({ where: { OR: [{ entityId: { in: [...receiptIds, oid] } }, { payload: { contains: P } }] } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...receiptIds, oid] } }, { details: { contains: P } }] } }).catch(() => null)
      await db.check.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.receipt.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.orderItem.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.order.deleteMany({ where: { id: oid } }).catch(() => null)
    }
    const menus = await db.menu.findMany({ where: { locationId: locId }, select: { id: true } })
    const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
    const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
    await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } }).catch(() => null)
    await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } }).catch(() => null)
    await db.counter.deleteMany({ where: { name: `receipt:${locId}` } }).catch(() => null)
  }
  // audit/dokazi iz drop/monitoring testov (entityId/details s predpono) + osebje/lokacije
  await sweepTestFixtures(db, [P])
  await db.auditLog.deleteMany({ where: { details: { contains: P } } }).catch(() => null)
})

// ═══ GAP-1 — offline vrsta dead-letter (enote, localStorage mock) ═══

describe('GAP-1 offline vrsta — dead-letter (issue #3 §A)', () => {
  beforeEach(() => { lsBacking.clear() })

  it('markOpAttempt ×10 → status dead, op OSTANE v vrsti (ne izgubi)', () => {
    const op = enqueueOp('order.create', { tableId: 'i3-t1' }, 'i3-op-dead')
    expect(op.attempts).toBe(0)
    for (let i = 1; i <= 10; i++) markOpAttempt('i3-op-dead', `napaka ${i}`)
    const q = getQueue()
    const dead = q.find((o) => o.clientOperationId === 'i3-op-dead')
    expect(dead).toBeDefined() // PREJ: filter jo TIHO izvrgel — tu je jedro popravka
    expect(dead!.status).toBe('dead')
    expect(dead!.attempts).toBe(10)
    expect(dead!.lastError).toBe('napaka 10')
    expect(getDeadOps()).toHaveLength(1)
    expect(getDeadOps()[0]!.clientOperationId).toBe('i3-op-dead')
  })

  it('prehod v dead-letter sproži reportDeadOp → fetch /api/sync/drop (BREZ vsebine payload)', () => {
    mockFetch(() => new Response('{}', { status: 201 }))
    localStorageMock.setItem('ro_token', 'i3-zeton-test')
    try {
      enqueueOp('order.addItems', { orderId: 'x', items: [{ secret: 'i3-ne-poslji' }] }, 'i3-op-report')
      for (let i = 0; i < 10; i++) markOpAttempt('i3-op-report', 'socket closed')
      const drop = fetchCalls.find((c) => c.url === '/api/sync/drop')
      expect(drop).toBeDefined()
      expect((drop!.init.headers as Record<string, string>).Authorization).toBe('Bearer i3-zeton-test')
      const sent = JSON.parse(String(drop!.init.body)) as Record<string, unknown>
      expect(sent.clientOperationId).toBe('i3-op-report')
      expect(sent.kind).toBe('order.addItems')
      expect(sent.attempts).toBe(10)
      expect(sent.lastError).toBe('socket closed')
      // skrivnostna vsebina payload se NE pošlja (secret-free poročilo)
      expect(JSON.stringify(sent)).not.toContain('i3-ne-poslji')
    } finally {
      g.fetch = prevFetch
    }
  })

  it('reportDeadOp brez žetona → brez Authorization glave (tih, ne meče)', () => {
    mockFetch(() => new Response('{}', { status: 201 }))
    try {
      reportDeadOp({
        clientOperationId: 'i3-op-notok', kind: 'kitchen.status', payload: {},
        createdAt: new Date().toISOString(), attempts: 10, status: 'dead', lastError: 'x',
      })
      const drop = fetchCalls.find((c) => c.url === '/api/sync/drop')
      expect(drop).toBeDefined()
      expect((drop!.init.headers as Record<string, string>).Authorization).toBeUndefined()
    } finally {
      g.fetch = prevFetch
    }
  })

  it('flushQueue dead operacij NE pošlje (samo žive) + FlushResult.dead', async () => {
    // NAZAJKOMPATIBILEN vnos iz starejše localStorage (brez status polja) PRVI —
    // enqueueOp dodaja na konec obstoječe vrste (ne prepiše je)
    const legacy: QueuedOp = {
      clientOperationId: 'i3-op-legacy', kind: 'kitchen.status', payload: {},
      createdAt: new Date().toISOString(), attempts: 3, lastError: 'stara napaka',
      // namerno BREZ status — undefined = 'queued' (nazajkompatibilnost)
    }
    localStorageMock.setItem('ro_offline_queue', JSON.stringify([legacy]))
    localStorageMock.setItem('ro_token', 'i3-tok-flush')
    enqueueOp('order.create', { tableId: 'i3-t2' }, 'i3-op-alive')
    // + mrtev op (enqueue + 10 poskusov)
    enqueueOp('order.create', { tableId: 'i3-t3' }, 'i3-op-dead-flush')
    for (let i = 0; i < 10; i++) markOpAttempt('i3-op-dead-flush', 'zavrnjeno')

    mockFetch((url) => {
      if (url === '/api/sync') {
        return new Response(JSON.stringify({ results: [{ clientOperationId: 'i3-op-alive', ok: true }] }), { status: 200 })
      }
      return new Response('{}', { status: 201 })
    })
    try {
      const res = await flushQueue()
      expect(res.flushed).toBe(1)
      expect(res.dead).toBe(1)
      // živa odstranjena; nazajkompatibilen op (4. poskus < 10) ostane; dead ostane
      const ids = getQueue().map((o) => o.clientOperationId).sort()
      expect(ids).toEqual(['i3-op-dead-flush', 'i3-op-legacy'])
      // poslana serija vsebuje SAMO žive — dead NI v poslanih ops
      const sync = fetchCalls.find((c) => c.url === '/api/sync')
      expect(sync).toBeDefined()
      const body = JSON.parse(String(sync!.init.body)) as { ops: { clientOperationId: string }[] }
      expect(body.ops.map((o) => o.clientOperationId)).not.toContain('i3-op-dead-flush')
      expect(body.ops.map((o) => o.clientOperationId)).toContain('i3-op-alive')
    } finally {
      g.fetch = prevFetch
    }
  })

  it('resetDeadOp rekvira (attempts=0, queued, lastError počiščen); clearDeadOps odstrani', () => {
    enqueueOp('kitchen.status', { itemId: 'x', status: 'READY' }, 'i3-op-retry')
    for (let i = 0; i < 10; i++) markOpAttempt('i3-op-retry', 'timeout')
    expect(resetDeadOp('i3-op-retry')).toBe(true)
    const op = getQueue().find((o) => o.clientOperationId === 'i3-op-retry')!
    expect(op.status).toBe('queued')
    expect(op.attempts).toBe(0)
    expect(op.lastError).toBeUndefined()
    expect(getDeadOps()).toHaveLength(0)
    // reset neveljavne/žive → false (ne rekvira tuje)
    expect(resetDeadOp('i3-ne-obstaja')).toBe(false)
    // še en dead + clear
    enqueueOp('order.create', {}, 'i3-op-dead2')
    for (let i = 0; i < 10; i++) markOpAttempt('i3-op-dead2', 'x')
    expect(getDeadOps()).toHaveLength(1)
    expect(clearDeadOps()).toBe(1)
    expect(getQueue().map((o) => o.clientOperationId)).not.toContain('i3-op-dead2')
    expect(clearDeadOps()).toBe(0)
  })
})

// ═══ GAP-1 — POST /api/sync/drop (ruta, DB) ═══

describe('GAP-1 POST /api/sync/drop (ruta — AuditLog SYNC_OP_DROPPED)', () => {
  const validBody = {
    clientOperationId: `${P}drop-${RUN}`,
    kind: 'order.create',
    attempts: 10,
    lastError: 'ECONNREFUSED napaka',
  }

  it('veljavno telo → 201 + AuditLog vrstica s chainHash', async () => {
    const r = await dropPOST(req('/api/sync/drop', mgrToken, 'POST', validBody))
    expect(r.status).toBe(201)
    const row = await db.auditLog.findFirst({ where: { action: 'SYNC_OP_DROPPED', entityId: validBody.clientOperationId } })
    expect(row).not.toBeNull()
    expect(row!.userId).toBe(mgrId)
    expect(row!.entityType).toBe('DeviceSyncOperation')
    expect(row!.locationId).toBe(locSI)
    const details = JSON.parse(row!.details) as Record<string, unknown>
    expect(details.kind).toBe('order.create')
    expect(details.attempts).toBe(10)
    expect(details.lastError).toBe('ECONNREFUSED napaka')
    expect((row!.chainHash || '').length).toBeGreaterThan(0) // audit veriga zapisana
  })

  it('validacija: slab kind / attempts izven obsega / manjkajoči clientOperationId → 400', async () => {
    expect((await dropPOST(req('/api/sync/drop', mgrToken, 'POST', { ...validBody, kind: 'payment.charge' }))).status).toBe(400)
    expect((await dropPOST(req('/api/sync/drop', mgrToken, 'POST', { ...validBody, attempts: 0 }))).status).toBe(400)
    expect((await dropPOST(req('/api/sync/drop', mgrToken, 'POST', { ...validBody, attempts: 51 }))).status).toBe(400)
    expect((await dropPOST(req('/api/sync/drop', mgrToken, 'POST', { ...validBody, clientOperationId: '' }))).status).toBe(400)
    expect((await dropPOST(req('/api/sync/drop', mgrToken, 'POST', null))).status).toBe(400)
  })

  it('brez žetona → 401 (requireAuth, NE requirePermission — poroča vsak prijavljeni)', async () => {
    const r = await dropPOST(req('/api/sync/drop', null, 'POST', validBody))
    expect(r.status).toBe(401)
  })
})

// ═══ GAP-2 — print poštenost ('sent') ═══

describe('GAP-2 print statusi (issue #3 §C)', () => {
  it("parsePrintAck sprejme 'sent' (agent dostava do vtičnice)", () => {
    const r = parsePrintAck({ kind: 'receipt', refId: 'r1', target: 'agent', status: 'sent', device: '192.168.1.50:9100', attempts: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.status).toBe('sent')
      expect(r.data.error).toBe('') // error samo pri failed
    }
  })

  it("PRINT_STATUSES vsebuje 'sent'; neznan status ostaja zavrnjen (fail-closed)", () => {
    expect(PRINT_STATUSES).toContain('sent')
    expect((PRINT_STATUSES as readonly string[]).includes('delivered')).toBe(false)
    expect(parsePrintAck({ target: 'agent', status: 'delivered' }).ok).toBe(false)
    expect(parsePrintAck({ target: 'agent', status: 'printed' }).ok).toBe(true) // stari statusi nespremenjeni
  })

  it("source-pin: devices/print.ts agent pot pošilja 'sent' (printLines + printLabelDocument), print.ts dokumentira semantiko", () => {
    const src = readFileSync(join(import.meta.dir, '../src/lib/devices/print.ts'), 'utf8')
    // OBE agent poti (printLines + printLabelDocument) nastavita ackStatus 'sent'
    expect(src.split("ackStatus: 'sent'").length - 1).toBeGreaterThanOrEqual(2)
    // preslikava v ACK: agent 'sent', browser ostane 'printed'
    expect(src).toContain('res.ackStatus ?? \'printed\'')
    const core = readFileSync(join(import.meta.dir, '../src/lib/print.ts'), 'utf8')
    expect(core).toContain("['printed', 'failed', 'simulated', 'sent']")
    expect(core).toContain("'sent'")
  })
})

// ═══ GAP-3 — fiskalizacijska napaka → audit (FURS + CIS) ═══

describe('GAP-3 fiskalna zavrnitev → FISCAL_SUBMIT_FAILED (issue #3 §B)', () => {
  // samopodpisan P12 (isti vzorec kot tests/furs-client.test.ts — brez zunanjih orodij)
  function makeSelfSignedP12(cn: string): string {
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = '03'
    cert.validity.notBefore = new Date(Date.now() - 3600_000)
    cert.validity.notAfter = new Date(Date.now() + 90 * 86_400_000)
    cert.setSubject([{ name: 'commonName', value: cn }])
    cert.setIssuer([{ name: 'commonName', value: cn }])
    cert.setExtensions([
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] },
    ])
    cert.sign(keys.privateKey, forge.md.sha256.create())
    return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, 'i3-geslo')).getBytes(), 'binary').toString('base64')
  }
  const P12 = makeSelfSignedP12('RestaurantOS-i3')
  const CERT_MAT = loadCertMaterial(P12, 'i3-geslo')

  // mock TLS strežnik: vsak SOAP klic zavrne z 400 → fursInvoice/cisInvoice mečeta
  const SERVER = Bun.serve({
    port: 0,
    tls: { cert: CERT_MAT.certPem, key: CERT_MAT.keyPem },
    fetch: () => new Response('slab zahtevek', { status: 400 }),
  })

  const PREV: Record<string, string | undefined> = {}
  let orderSI = ''
  let orderHR = ''

  beforeAll(async () => {
    for (const k of ['FURS_ENVIRONMENT', 'FURS_ENDPOINT_URL', 'FURS_CERT_P12_B64', 'FURS_CERT_PASSWORD',
      'FURS_HR_ENDPOINT_URL', 'FURS_HR_CERT_P12_B64', 'FURS_HR_CERT_PASSWORD', 'FURS_HR_CA_PEM']) {
      PREV[k] = process.env[k]
    }
    // produkcija + certifikat + (ne)zanesljiv endpoint: fursProd/hrProd sta dejavna,
    // SOAP klic pa pade → catch blok → FISCAL_SUBMIT_FAILED audit, račun ostane pending.
    process.env.FURS_ENVIRONMENT = 'production'
    process.env.FURS_CERT_P12_B64 = P12
    process.env.FURS_CERT_PASSWORD = 'i3-geslo'
    process.env.FURS_ENDPOINT_URL = `https://127.0.0.1:${SERVER.port}/v1/cash_registers`
    process.env.FURS_HR_CERT_P12_B64 = P12
    process.env.FURS_HR_CERT_PASSWORD = 'i3-geslo'
    process.env.FURS_HR_ENDPOINT_URL = `https://127.0.0.1:${SERVER.port}/FiskalizacijaService`
    // CIS je 1-way TLS + CA iz env → handshake uspe, odgovor 400 → cisInvoice throw
    process.env.FURS_HR_CA_PEM = CERT_MAT.certPem
    orderSI = await seedOrder(locSI, 'si')
    orderHR = await seedOrder(locHR, 'hr')
  })

  afterAll(() => {
    for (const [k, v] of Object.entries(PREV)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    SERVER.stop(true)
  })

  it('FURS EOR zavrnjen → račun OSTANE pending + AuditLog FISCAL_SUBMIT_FAILED (provider FURS)', async () => {
    const r = await fursPOST(req('/api/furs', mgrToken, 'POST', { orderId: orderSI, type: 'cash' }))
    expect(r.status).toBe(201)
    const body = (await r.json()) as { fiscalStatus?: string; invoice?: { id?: string } }
    expect(body.fiscalStatus).toBe('pending') // NE uvajamo 'error' — pending je resnica

    const receipt = await db.receipt.findFirst({ where: { orderId: orderSI, isStorno: false }, orderBy: { createdAt: 'desc' } })
    expect(receipt).not.toBeNull()
    expect(receipt!.fiscalStatus).toBe('pending')
    expect(receipt!.eor).toBe('') // EOR NI lažiran
    expect(receipt!.fiscalVerified).toBe(false)

    const audit = await waitForAudit('FISCAL_SUBMIT_FAILED', receipt!.id)
    expect(audit).not.toBeNull()
    const details = JSON.parse(audit!.details) as Record<string, unknown>
    expect(details.provider).toBe('FURS')
    expect(String(details.receiptNumber)).toContain(P) // sledljivost (premises i3-)
    expect(details.orderId).toBe(orderSI)
    expect(String(details.error || '').length).toBeGreaterThan(0)
    expect(String(details.error).length).toBeLessThanOrEqual(200)
  })

  it('CIS JIR zavrnjen → račun OSTANE pending + AuditLog FISCAL_SUBMIT_FAILED (provider CIS)', async () => {
    const r = await fursPOST(req('/api/furs', mgrHRToken, 'POST', { orderId: orderHR, type: 'cash' }))
    expect(r.status).toBe(201)
    const body = (await r.json()) as { fiscalStatus?: string }
    expect(body.fiscalStatus).toBe('pending')

    const receipt = await db.receipt.findFirst({ where: { orderId: orderHR, isStorno: false }, orderBy: { createdAt: 'desc' } })
    expect(receipt).not.toBeNull()
    expect(receipt!.fiscalStatus).toBe('pending')
    expect(receipt!.cisStatus).toBe('pending')

    const audit = await waitForAudit('FISCAL_SUBMIT_FAILED', receipt!.id)
    expect(audit).not.toBeNull()
    const details = JSON.parse(audit!.details) as Record<string, unknown>
    expect(details.provider).toBe('CIS')
    expect(details.orderId).toBe(orderHR)
  })
})

// ═══ GAP-7 — monitoring/errors filter ═══

describe('GAP-7 GET /api/monitoring/errors (issue #3 §G/H)', () => {
  it('vključuje PRINT_FAILED vrstice (prej filter contains ERROR ni ujel operativnih napak)', async () => {
    await db.auditLog.create({
      data: {
        id: nid(), userId: mgrId, action: 'PRINT_FAILED', entityType: 'PrintJob',
        entityId: `${P}printjob-${RUN}`, details: JSON.stringify({ kind: 'receipt', error: 'Tiskalnik ni odziven.' }),
        locationId: locSI,
      },
    })
    const r = await errorsGET(req('/api/monitoring/errors', mgrToken))
    expect(r.status).toBe(200)
    const body = (await r.json()) as { errors: { action: string; entityId: string | null }[] }
    expect(body.errors.some((e) => e.action === 'PRINT_FAILED' && e.entityId === `${P}printjob-${RUN}`)).toBe(true)
  })
})

// ═══ GAP-8 — Stripe verify varovalka (source-pin + i18n) ═══

describe('GAP-8 Stripe verify varovalka (issue #3 §B, source-pin)', () => {
  it('pay ruta: try/catch okoli stripeSessionStatus → 502 s POŠTENIM sporočilom', () => {
    const src = readFileSync(join(import.meta.dir, '../src/app/api/public/pay/[token]/route.ts'), 'utf8')
    expect(src).toContain('Preverjanje plačila trenutno ni dosegljivo. Poskusite znova.')
    expect(src).toMatch(/502\)/)
    expect(src).toContain('stripeSessionStatus(provider.secretKey, verifySession)')
  })

  it('i18n: sporočilo ima preslikavo + ključ v VSEH treh slovarjih (gost vidi prevod)', () => {
    const msg = 'Preverjanje plačila trenutno ni dosegljivo. Poskusite znova.'
    expect(guestApiErrorKey(msg)).toBe('pay.errorVerifyUnavailable')
    expect(sl['pay.errorVerifyUnavailable']).toBeTruthy()
    expect(hr['pay.errorVerifyUnavailable']).toBeTruthy()
    expect(en['pay.errorVerifyUnavailable']).toBeTruthy()
    expect(sl['header.netDead']).toBeTruthy()
    expect(hr['header.netDead']).toBeTruthy()
    expect(sl['sync.deadTitle']).toBeTruthy()
    expect(hr['sync.deadRetry']).toBeTruthy()
  })
})

// ═══ UI WIRING — dashboard badge/dialog + tablica/handheld flush (issue #3 §A, source-pin) ═══

describe('UI wiring: dead-letter badge + intervencija (issue #3 §A)', () => {
  it('dashboard: rdeča intervencijska odznak (netDead) + dialog z retry/zavzi/izvozom', () => {
    const src = readFileSync(join(import.meta.dir, '../src/app/dashboard/page.tsx'), 'utf8')
    // odznak zamenja navadni sync gumb, ko so prisotne dead operacije
    expect(src).toContain("deadOps.length > 0 ? (")
    expect(src).toContain("t('header.netDead', { n: deadOps.length })")
    expect(src).toContain('setDeadOpen(true)')
    // dialog: retry (resetDeadOp), zavzi (clearDeadOps), izvoz diagnostike brez payload
    expect(src).toContain('resetDeadOp(clientOperationId)')
    expect(src).toContain('clearDeadOps()')
    expect(src).toContain("a.download = `offline-diag-")
    // izvoz NE vsebuje payload vsebine (samo identiteta + napaka)
    const exportBlock = src.slice(src.indexOf('exportDead = useCallback'), src.indexOf('Odjava NE SME'))
    expect(exportBlock).not.toContain('o.payload')
  })

  it('tablica in handheld: flush ob online dogodku IN ob mountu (GAP-4/5)', () => {
    const tablica = readFileSync(join(import.meta.dir, '../src/app/tablica/page.tsx'), 'utf8')
    expect(tablica).toContain('flushQueue')
    expect(tablica).toMatch(/addEventListener\('online'/)
    const handheld = readFileSync(join(import.meta.dir, '../src/app/handheld/page.tsx'), 'utf8')
    expect(handheld).toContain('flushQueue')
    // mount flush (startup recovery) — klic v glavnem useEffect brez pogoja online
    expect(handheld).toMatch(/\/\/ Issue #3 §D \(P1\): flush tudi ob ZAGONU[\s\S]{0,400}void flushQueue\(\)/)
  })

  it('i18n: vsi dead ključi v SL + HR (dialog besedila)', () => {
    expect(sl['sync.deadHint']).toBeTruthy()
    expect(hr['sync.deadHint']).toBeTruthy()
    expect(sl['sync.deadKind.order.create']).toBeTruthy()
    expect(hr['sync.deadKind.kitchen.status']).toBeTruthy()
    expect(sl['sync.deadLast']).toBeTruthy()
    expect(hr['sync.deadAttempts']).toBeTruthy()
    expect(sl['sync.deadDone']).toBeTruthy()
    expect(hr['sync.deadDone']).toBeTruthy()
  })
})
