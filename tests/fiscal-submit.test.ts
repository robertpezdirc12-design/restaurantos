/**
 * audit 2026-10 #3 (v1.144.0) — SKUPNA fiskalna oddaja dokumenta.
 *
 * Pred v1.144.0 je bil SOAP blok (ZOI→EOR / ZKI→JIR) dvakrat KOPIRAN v
 * src/lib/furs/issue.ts, zato:
 *   - FISKALNI STORNO ga nikoli ni poklical → negativni račun je bil v produkciji
 *     samo lokalno kodiran (`fiscalStatus:'pending'`) in PRI FURS-u/Porezni NI
 *     OBSTAJOČ (davčna napaka, ne kozmetika);
 *   - padel klic pri IZDAJI je pustil 'pending' brez kakršnekoli poti nazaj —
 *     edini obnovitveni korak je bil ročni SOAP po runbooku.
 *
 * Zdaj obe poti (in obnova) uporabljata src/lib/furs/submit.ts. Test dokazuje
 * OBSERVOBLJIVE posledice na TLS mock ponudniku (isti vzorec kot GAP-3 v
 * tests/issue3-pos-readiness.test.ts — samopodpisan P12 + Bun.serve TLS):
 *   1. produkcija: izdaja ob plačilu ODDA InvoiceRequest (SubsequentSubmit=false)
 *      in EOR/JIR se zapišeta;
 *   2. produkcija: STORNO ODDA NEGATIVNI dokument (InvoiceAmount / IznosUkupno < 0);
 *   3. obnova: padel klic → 'pending' (fail-safe, plačilo velja) →
 *      POST /api/furs/[id]/resubmit → SubsequentSubmit=true / NakDost=true + EOR;
 *   4. zapore: že verified, brez ZOI/ZKI, simulacija, brez certifikata, tuja
 *      lokacija, manjkajoče dovoljenje (403/404/409/503/502);
 *   5. revizija: FISCAL_SUBMIT_FAILED (subsequentSubmit) in FISCAL_RESUBMIT.
 *
 * Fiks tur predpona: fsub- (čiščenje s sweepTestFixtures v beforeAll IN afterAll).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import forge from 'node-forge'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { num, r2 } from '@/lib/map'
import { vatFromGross } from '@/lib/billing'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { loadCertMaterial } from '@/lib/furs/client'
import { isoLocal } from '@/lib/fiscal-time'
import { submitFiscalDocument } from '@/lib/furs/submit'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { POST as stornoPOST } from '../src/app/api/receipts/[id]/storno/route'
import { POST as resubmitPOST } from '../src/app/api/furs/[id]/resubmit/route'

const P = 'fsub-'
const RUN = String(Date.now())
const SI_PATH = '/v1/cash_registers'
const HR_PATH = '/FiskalizacijaService'

// ── TLS mock ponudnika (odinuk za FURS in CIS — razloči se po poti) ──

/** 'ok' → uspešen InvoiceResponse/RacunOdgovor; 'fail' → HTTP 400 (SOAP zavrnjen). */
let mode: 'ok' | 'fail' = 'ok'
interface Captured { path: string; body: string }
const captured: Captured[] = []
/** Kode, ki jih je ponudnik vrnil (EOR/JIR po vrstnem redu) — za dokaz zapisanega. */
const served: string[] = []

const siEnvelope = (eor: string) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
  `<InvoiceResponse xmlns="http://furs.eu/efiskalizacija-1"><fu:eor>${eor}</fu:eor><fu:zoi>odz</fu:zoi>` +
  '</InvoiceResponse></soap:Body></soap:Envelope>'

const hrEnvelope = (jir: string) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
  `<tns:RacunOdgovor xmlns:tns="http://porezna.fiskalizacija2.xsd"><tns:Jir>${jir}</tns:Jir></tns:RacunOdgovor>` +
  '</soap:Body></soap:Envelope>'

/** Samopodpisan P12 (isti vzorec kot tests/issue3-pos-readiness.test.ts). */
function makeSelfSignedP12(cn: string, password: string): string {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '04'
  cert.validity.notBefore = new Date(Date.now() - 3600_000)
  cert.validity.notAfter = new Date(Date.now() + 90 * 86_400_000)
  cert.setSubject([{ name: 'commonName', value: cn }])
  cert.setIssuer([{ name: 'commonName', value: cn }])
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, password)).getBytes(), 'binary').toString('base64')
}

const PASSWORD = 'fsub-geslo'
const P12 = makeSelfSignedP12('RestaurantOS-fsub', PASSWORD)
const CERT_MAT = loadCertMaterial(P12, PASSWORD)

const MOCK = Bun.serve({
  port: 0,
  tls: { cert: CERT_MAT.certPem, key: CERT_MAT.keyPem },
  fetch: (req) =>
    req.text().then((body) => {
      const path = new URL(req.url).pathname
      captured.push({ path, body })
      if (mode === 'fail') return new Response('zavrnjeno', { status: 400 })
      const code = path === HR_PATH ? randomUUID() : randomUUID().toUpperCase()
      served.push(code)
      return new Response(path === HR_PATH ? hrEnvelope(code) : siEnvelope(code), {
        headers: { 'content-type': 'text/xml; charset=utf-8' },
      })
    }),
})

// ── fiksture ──
let locSI = ''
let locHR = ''
let mgrSI = ''
let admSI = ''
let mgrHR = ''
let admHR = ''
let chefSI = ''
let tokMgrSI = ''
let tokAdmSI = ''
let tokMgrHR = ''
let tokAdmHR = ''
let tokChef = ''
let orderSeq = 917000

const ENV_KEYS = [
  'FURS_ENVIRONMENT', 'FURS_ALLOW_SIMULATION', 'FURS_PRODUCTION_TEST_MODE',
  'FURS_ENDPOINT_URL', 'FURS_CERT_P12_B64', 'FURS_CERT_PASSWORD', 'FURS_CA_PEM',
  'FURS_HR_ENVIRONMENT', 'FURS_HR_ENDPOINT_URL', 'FURS_HR_CERT_P12_B64',
  'FURS_HR_CERT_PASSWORD', 'FURS_HR_CA_PEM',
] as const
const PREV: Record<string, string | undefined> = {}

/**
 * Check in Payment nimata locationId (sweep ju ne pobere po lokaciji), Counter pa
 * ima id `receipt:<locId>` (ne predpono) → oboje ročno, nato sweepTestFixtures.
 */
async function clean(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const ids = (await db.order.findMany({ where: { id: { startsWith: P } }, select: { id: true } })).map((o) => o.id)
    if (ids.length) {
      const checks = await db.check.findMany({ where: { orderId: { in: ids } }, select: { id: true } })
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } })
      await db.check.deleteMany({ where: { orderId: { in: ids } } })
    }
    const locs = await db.location.findMany({ where: { id: { startsWith: P } }, select: { id: true } })
    for (const l of locs) await db.counter.deleteMany({ where: { name: `receipt:${l.id}` } })
    const res = await sweepTestFixtures(db, [P])
    if (!res.errors.length && !res.remainingLocations) return
    if (attempt >= 2) {
      throw new Error(`fsub čiščenje fiksur ni uspelo: preostale lokacije=${res.remainingLocations}, napake=${res.errors.join(' | ')}`)
    }
  }
}

interface Spec { name: string; price: number; vatRate: number; qty: number }

/** Naročilo z davčno osnovo, IZVLEČENO iz končne cene (isto kot produkcijski izračun). */
async function seedOrder(locId: string, tag: string, specs: Spec[], discount = 0): Promise<string> {
  const orderId = `${P}ord-${tag}-${RUN}`
  const menuId = `${P}menu-${tag}-${RUN}`
  const catId = `${P}cat-${tag}-${RUN}`
  const tax = specs.reduce((s, it) => s + vatFromGross(it.price * it.qty, it.vatRate), 0)
  const subtotal = r2(specs.reduce((s, it) => s + it.price * it.qty, 0) - tax)
  await db.menu.create({ data: { id: menuId, name: `${P}Meni ${tag}`, locationId: locId } })
  await db.category.create({ data: { id: catId, name: `${P}Kategorija`, menuId } })
  const items = []
  for (const [i, it] of specs.entries()) {
    const miId = `${P}mi-${tag}-${i}-${RUN}`
    await db.menuItem.create({ data: { id: miId, name: it.name, price: it.price, categoryId: catId, vatRate: it.vatRate } })
    items.push({ miId, it })
  }
  await db.order.create({
    data: {
      id: orderId, orderNumber: orderSeq++, locationId: locId, status: 'open', paymentStatus: 'unpaid',
      subtotal, tax, total: r2(subtotal + tax - discount), discount,
    },
  })
  for (const [i, { miId, it }] of items.entries()) {
    await db.orderItem.create({
      data: {
        id: `${P}itm-${tag}-${i}-${RUN}`, orderId, menuItemId: miId, quantity: it.qty, price: it.price,
        vatRate: it.vatRate, vatAmount: vatFromGross(it.price * it.qty, it.vatRate), menuItemName: it.name,
        status: 'served',
      },
    })
  }
  return orderId
}

function api(path: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const pay = (token: string, orderId: string, extra: Record<string, unknown> = {}) =>
  fursPOST(api('/api/furs', token, { orderId, type: 'cash', ...extra }))

const storno = (token: string, receiptId: string, reason = 'testni storno razlog') =>
  stornoPOST(api('/api/receipts/x/storno', token, { reason }), { params: Promise.resolve({ id: receiptId }) })

const resubmit = (token: string, receiptId: string) =>
  resubmitPOST(api(`/api/furs/${receiptId}/resubmit`, token), { params: Promise.resolve({ id: receiptId }) })

const siBodies = (): string[] => captured.filter((c) => c.path === SI_PATH).map((c) => c.body)
const hrBodies = (): string[] => captured.filter((c) => c.path === HR_PATH).map((c) => c.body)

/** Fire-and-forget audit (writeAudit v catch/submit) — polling z timeoutom, ZADNJA vrstica. */
async function waitForAudit(action: string, entityId: string, ms = 5000): Promise<Record<string, unknown> | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const row = await db.auditLog.findFirst({
      where: { action, entityId },
      select: { details: true },
      orderBy: { timestamp: 'desc' },
    })
    if (row) return JSON.parse(row.details) as Record<string, unknown>
    await new Promise((r) => setTimeout(r, 40))
  }
  return null
}

const receiptOf = (orderId: string, stornoOf?: string | null) =>
  db.receipt.findFirst({
    where: stornoOf ? { orderId, isStorno: true } : { orderId, isStorno: false },
    orderBy: { createdAt: 'desc' },
  })

beforeAll(async () => {
  await clean()
  for (const k of ENV_KEYS) PREV[k] = process.env[k]
  // Produkcijski profil + certifikat + zanesljiv mock: SOAP se VESI in odgovori.
  process.env.FURS_ENVIRONMENT = 'production'
  delete process.env.FURS_ALLOW_SIMULATION
  delete process.env.FURS_PRODUCTION_TEST_MODE
  process.env.FURS_ENDPOINT_URL = `https://127.0.0.1:${MOCK.port}${SI_PATH}`
  process.env.FURS_CERT_P12_B64 = P12
  process.env.FURS_CERT_PASSWORD = PASSWORD
  // FURS je mTLS: brez pinane CA verige Node zavrne samopodpisan cert ponudnika
  // (`self signed certificate`) → uspešna pot oddaje ne bi bila testna (v1.144.0
  // dodaja FURS_CA_PEM, simetrično FURS_HR_CA_PEM).
  process.env.FURS_CA_PEM = CERT_MAT.certPem
  delete process.env.FURS_HR_ENVIRONMENT // CIS sledi globalnemu (production)
  process.env.FURS_HR_ENDPOINT_URL = `https://127.0.0.1:${MOCK.port}${HR_PATH}`
  process.env.FURS_HR_CERT_P12_B64 = P12
  process.env.FURS_HR_CERT_PASSWORD = PASSWORD
  process.env.FURS_HR_CA_PEM = CERT_MAT.certPem // 1-way TLS: verifikacija proti mock certu

  locSI = `${P}loc-si-${RUN}`
  await db.location.create({
    data: {
      id: locSI, name: `${P}Lokacija SI`, code: `FSUBSI${RUN}`, premisesId: 'BLGFSUBSI',
      taxId: 'SI12345678', registerNumber: 'BLG-001SI', country: 'SI',
      timezone: 'Europe/Ljubljana', fursEnvironment: 'production',
    },
  })
  locHR = `${P}loc-hr-${RUN}`
  await db.location.create({
    data: {
      id: locHR, name: `${P}Lokacija HR`, code: `FSUBHR${RUN}`, premisesId: 'FSUBHR01',
      taxId: '12345678901', registerNumber: '1', country: 'HR',
      timezone: 'Europe/Zagreb', fursEnvironment: 'production',
    },
  })
  const emp = async (id: string, name: string, role: string, loc: string) => {
    await db.employee.create({
      data: { id, name, email: `${id}@test.local`, role, status: 'active', sessionVersion: 0, locationId: loc, pin: `${id}-pin`, pinLookup: `${id}-pl` },
    })
    return id
  }
  mgrSI = await emp(`${P}mgr-si-${RUN}`, `${P}Manager SI`, 'manager', locSI)
  admSI = await emp(`${P}adm-si-${RUN}`, `${P}Admin SI`, 'admin', locSI)
  chefSI = await emp(`${P}chef-si-${RUN}`, `${P}Kuhar SI`, 'chef', locSI)
  mgrHR = await emp(`${P}mgr-hr-${RUN}`, `${P}Manager HR`, 'manager', locHR)
  admHR = await emp(`${P}adm-hr-${RUN}`, `${P}Admin HR`, 'admin', locHR)
  tokMgrSI = createToken({ sub: mgrSI, name: `${P}Manager SI`, role: 'MANAGER', loc: locSI, sv: 0 })
  tokAdmSI = createToken({ sub: admSI, name: `${P}Admin SI`, role: 'ADMIN', loc: locSI, sv: 0 })
  tokChef = createToken({ sub: chefSI, name: `${P}Kuhar SI`, role: 'KITCHEN', loc: locSI, sv: 0 })
  tokMgrHR = createToken({ sub: mgrHR, name: `${P}Manager HR`, role: 'MANAGER', loc: locHR, sv: 0 })
  tokAdmHR = createToken({ sub: admHR, name: `${P}Admin HR`, role: 'ADMIN', loc: locHR, sv: 0 })
})

afterAll(async () => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  MOCK.stop(true)
  await clean()
})

// ═══ 1. izdaja v produkciji ODDA dokument ═══

describe('izdaja ob plačilu — produkcija odda InvoiceRequest (audit #3)', () => {
  it('SI: SubsequentSubmit=false, znesek in DDV osnova PO popustu → EOR z zapisom na računu', async () => {
    const order = await seedOrder(locSI, 'si-pay', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 12 }], 20)
    mode = 'ok'
    const res = await pay(tokMgrSI, order, { amount: 100, clientOperationId: `${P}pay-${RUN}` })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.fiscalStatus).toBe('verified')

    const n = siBodies().length
    expect(n).toBe(1)
    const xml = siBodies()[0]
    expect(xml).toContain('<fu:SubsequentSubmit>false</fu:SubsequentSubmit>')
    expect(xml).toContain('<fu:InvoiceAmount>100.00</fu:InvoiceAmount>')
    expect(xml).toContain('<fu:PaymentAmount>100.00</fu:PaymentAmount>')
    // №1 (v1.143.0): osnova je PO popustu — 100/1,22 = 81,97 + DDV 18,03
    expect(xml).toContain('<fu:TaxableAmount>81.97</fu:TaxableAmount>')
    expect(xml).toContain('<fu:TaxAmount>18.03</fu:TaxAmount>')
    // №2 (v1.143.0): IssueDateTime je lokalni čas (brez UTC 'Z' priponke)
    expect(/<fu:IssueDateTime>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}<\/fu:IssueDateTime>/.test(xml)).toBe(true)
    expect(xml).not.toContain('Z</fu:IssueDateTime>')

    const rec = await receiptOf(order)
    expect(rec).not.toBeNull()
    expect(rec!.eor).toBe(served[n - 1])
    expect(rec!.fiscalStatus).toBe('verified')
    expect(rec!.fiscalVerified).toBe(true)
    expect(rec!.zoi.length).toBeGreaterThan(0)
    // dokument je oddan z ISTIM zaščitnim kodom, kot je zapisan na računu
    expect(xml).toContain(`<fu:ProtectedID>${rec!.zoi}</fu:ProtectedID>`)
  })

  it('HR: RacunZahtjev z NakDost=false in IznosUkupno → JIR + cisStatus verified', async () => {
    const order = await seedOrder(locHR, 'hr-pay', [{ name: `${P}Jelo 25`, price: 20, vatRate: 25, qty: 2 }])
    const res = await pay(tokMgrHR, order, { clientOperationId: `${P}hrpay-${RUN}` })
    expect(res.status).toBe(201)
    expect((await res.json()).fiscalStatus).toBe('verified')

    expect(hrBodies()).toHaveLength(1)
    const xml = hrBodies()[0]
    expect(xml).toContain('<tns:NakDost>false</tns:NakDost>')
    expect(xml).toContain('<tns:IznosUkupno>40.00</tns:IznosUkupno>')
    expect(xml).toContain('<tns:USustPdv>true</tns:USustPdv>')

    const rec = await receiptOf(order)
    expect(rec!.cisJir).toBe(served[served.length - 1])
    expect(rec!.cisStatus).toBe('verified')
    expect(rec!.fiscalStatus).toBe('verified')
    expect(rec!.cisZki.length).toBeGreaterThan(0)
    expect(xml).toContain(`<tns:ZastKod>${rec!.cisZki}</tns:ZastKod>`)
  })
})

// ═══ 2. storno ODDA negativni dokument (BISTVO №3) ═══

describe('fiskalni storno — negativni dokument je oddan pri fisku (audit #3)', () => {
  it('SI: drugi InvoiceRequest ima NEGATIVEN InvoiceAmount/PaymentAmount in svoj ZOI → EOR', async () => {
    const order = await seedOrder(locSI, 'si-storno', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 12 }], 20)
    mode = 'ok'
    const resPay = await pay(tokMgrSI, order, { amount: 100, clientOperationId: `${P}sts-p-${RUN}` })
    expect(resPay.status).toBe(201)
    const original = (await resPay.json()).invoice
    const before = siBodies().length

    const resS = await storno(tokAdmSI, original.id)
    expect(resS.status).toBe(201)
    const sBody = await resS.json()
    // BISTVO POPRAVKA: storno NI več 'pending' — dokument je prijavljen
    expect(sBody.storno.fiscalVerified).toBe(true)
    expect(sBody.storno.fiscalStatus).toBe('verified')
    expect(sBody.storno.fursEnvironment).toBe('production')

    expect(siBodies().length).toBe(before + 1)
    const xml = siBodies()[siBodies().length - 1]
    expect(xml).toContain('<fu:InvoiceAmount>-100.00</fu:InvoiceAmount>')
    expect(xml).toContain('<fu:PaymentAmount>-100.00</fu:PaymentAmount>')
    expect(xml).toContain('<fu:TaxableAmount>-81.97</fu:TaxableAmount>')
    expect(xml).toContain('<fu:TaxAmount>-18.03</fu:TaxAmount>')
    // storno je NOV dokument, NE naknadna oddaja
    expect(xml).toContain('<fu:SubsequentSubmit>false</fu:SubsequentSubmit>')

    const rec = await receiptOf(order, original.id)
    expect(rec).not.toBeNull()
    expect(rec!.isStorno).toBe(true)
    expect(num(rec!.total)).toBe(-100)
    expect(rec!.eor).toBe(served[served.length - 1])
    expect(rec!.eor).not.toBe(original.eor) // EOR je pri ponudniku, ne lažno zrcaljen
    expect(rec!.fiscalStatus).toBe('verified')
    expect(rec!.zoi.length).toBeGreaterThan(0)
    expect(xml).toContain(`<fu:ProtectedID>${rec!.zoi}</fu:ProtectedID>`)
  })

  it('HR: negativni RacunZahtjev oddan → JIR na storno računu', async () => {
    const order = await seedOrder(locHR, 'hr-storno', [{ name: `${P}Jelo 25`, price: 20, vatRate: 25, qty: 2 }])
    const resPay = await pay(tokMgrHR, order, { clientOperationId: `${P}hsts-p-${RUN}` })
    const original = (await resPay.json()).invoice
    const before = hrBodies().length

    const resS = await storno(tokAdmHR, original.id)
    expect(resS.status).toBe(201)
    expect((await resS.json()).storno.fiscalStatus).toBe('verified')

    expect(hrBodies().length).toBe(before + 1)
    const xml = hrBodies()[hrBodies().length - 1]
    expect(xml).toContain('<tns:IznosUkupno>-40.00</tns:IznosUkupno>')
    expect(xml).toContain('<tns:NakDost>false</tns:NakDost>')
    expect(xml).toContain('<tns:Porez><tns:Stopa>25.00</tns:Stopa><tns:Osnovica>-32.00</tns:Osnovica><tns:Iznos>-8.00</tns:Iznos></tns:Porez>')

    const rec = await receiptOf(order, original.id)
    expect(num(rec!.total)).toBe(-40)
    expect(rec!.cisJir).toBe(served[served.length - 1])
    expect(rec!.cisStatus).toBe('verified')
    expect(rec!.fiscalStatus).toBe('verified')
  })

  it('zavarovanje fail-safe pri stornu: zavrnjen SOAP → storno OSTANE pending (negativni dokument ni izgubljen)', async () => {
    const order = await seedOrder(locSI, 'si-storno-pend', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 1 }])
    const resPay = await pay(tokMgrSI, order, { clientOperationId: `${P}sp-p-${RUN}` })
    const original = (await resPay.json()).invoice
    mode = 'fail'
    const resS = await storno(tokAdmSI, original.id)
    mode = 'ok'
    expect(resS.status).toBe(201)
    const sBody = await resS.json()
    expect(sBody.storno.fiscalStatus).toBe('pending')
    expect(sBody.storno.fiscalVerified).toBe(false)

    const rec = await receiptOf(order, original.id)
    expect(rec!.fiscalStatus).toBe('pending')
    expect(rec!.eor).toBe('') // EOR se NE lažira
    expect(rec!.zoi.length).toBeGreaterThan(0) // kode obstajajo → obnova je mogoča
    const audit = await waitForAudit('FISCAL_SUBMIT_FAILED', rec!.id)
    expect(audit).not.toBeNull()
    expect(audit!.provider).toBe('FURS')
    expect(audit!.subsequentSubmit).toBe(false)
    expect(String(audit!.error).length).toBeLessThanOrEqual(200)

    // in obnova deluje prav za STORNO dokument (negativen znesek ostane negativen)
    const res = await resubmit(tokAdmSI, rec!.id)
    expect(res.status).toBe(200)
    const xml = siBodies()[siBodies().length - 1]
    expect(xml).toContain('<fu:SubsequentSubmit>true</fu:SubsequentSubmit>')
    expect(xml).toContain('<fu:InvoiceAmount>-10.00</fu:InvoiceAmount>')
  })
})

// ═══ 3. obnova pending računa (SubsequentSubmit / NakDost) ═══

describe('POST /api/furs/[id]/resubmit — naknadna oddaja pending dokumenta', () => {
  it('SI: padel SOAP → pending; obnova odda SubsequentSubmit=true in zapiše EOR + FISCAL_RESUBMIT', async () => {
    const order = await seedOrder(locSI, 'si-recover', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 3 }])
    mode = 'fail'
    const res = await pay(tokMgrSI, order, { clientOperationId: `${P}rec-${RUN}` })
    mode = 'ok'
    expect(res.status).toBe(201)
    expect((await res.json()).fiscalStatus).toBe('pending')

    const rec = await receiptOf(order)
    expect(rec!.fiscalStatus).toBe('pending')
    expect(rec!.eor).toBe('')
    const failed = await waitForAudit('FISCAL_SUBMIT_FAILED', rec!.id)
    expect(failed).not.toBeNull()
    expect(failed!.orderId).toBe(order)

    const requestsBefore = siBodies().length
    const r = await resubmit(tokMgrSI, rec!.id)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.fiscal.provider).toBe('FURS')
    expect(body.fiscal.subsequentSubmit).toBe(true)
    expect(body.receipt.fiscalStatus).toBe('verified')
    expect(body.receipt.eor).toBe(served[served.length - 1])

    expect(siBodies().length).toBe(requestsBefore + 1)
    const xml = siBodies()[siBodies().length - 1]
    expect(xml).toContain('<fu:SubsequentSubmit>true</fu:SubsequentSubmit>')
    // ISTI dokument: isti ZOI, isti znesek (30 = 3 × 10), ne nov dokument
    expect(xml).toContain(`<fu:ProtectedID>${rec!.zoi}</fu:ProtectedID>`)
    expect(xml).toContain('<fu:InvoiceAmount>30.00</fu:InvoiceAmount>')

    const audit = await db.auditLog.findFirst({ where: { action: 'FISCAL_RESUBMIT', entityId: rec!.id } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(String(audit!.details)) as Record<string, unknown>
    expect(details.provider).toBe('FURS')
    expect(details.code).toBe(served[served.length - 1])
    expect(details.receiptNumber).toBe(rec!.receiptNumber)
    expect(details.subsequentSubmit).toBe(true)
    expect(details.fursEnvironment).toBe('production')

    const row = await db.receipt.findUnique({ where: { id: rec!.id } })
    expect(row!.fiscalStatus).toBe('verified')
    expect(row!.fiscalVerified).toBe(true)
    expect(row!.verificationDate).not.toBeNull()
  })

  it('HR: obnova odda NakDost=true in zapiše JIR', async () => {
    const order = await seedOrder(locHR, 'hr-recover', [{ name: `${P}Jelo 25`, price: 20, vatRate: 25, qty: 1 }])
    mode = 'fail'
    await pay(tokMgrHR, order, { clientOperationId: `${P}hrrec-${RUN}` })
    mode = 'ok'
    const rec = await receiptOf(order)
    expect(rec!.fiscalStatus).toBe('pending')

    const r = await resubmit(tokMgrHR, rec!.id)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.fiscal.provider).toBe('CIS')
    const xml = hrBodies()[hrBodies().length - 1]
    expect(xml).toContain('<tns:NakDost>true</tns:NakDost>')
    expect(xml).toContain(`<tns:ZastKod>${rec!.cisZki}</tns:ZastKod>`)

    const row = await db.receipt.findUnique({ where: { id: rec!.id } })
    expect(row!.cisJir).toBe(body.fiscal.code)
    expect(row!.cisStatus).toBe('verified')
    expect(row!.fiscalStatus).toBe('verified')
  })

  it('obnova PONOVI isti dokument: IssueDateTime izhaja iz printedAt, ne iz trenutka klica', async () => {
    const order = await seedOrder(locSI, 'si-reissue', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 1 }])
    mode = 'ok'
    const resPay = await pay(tokMgrSI, order, { clientOperationId: `${P}rie-${RUN}` })
    const id = (await resPay.json()).invoice.id
    const issuedXml = siBodies()[siBodies().length - 1].match(/<fu:IssueDateTime>([^<]+)<\/fu:IssueDateTime>/)?.[1] ?? ''
    expect(issuedXml).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)

    // zakasnela oddaja: dokument je bil izdan VČERAJ (ZOI je podpisan nad tem datumom)
    const printedAt = new Date(Date.now() - 86_400_000)
    await db.receipt.update({ where: { id }, data: { fiscalStatus: 'pending', eor: '', printedAt } })
    const r = await resubmit(tokMgrSI, id)
    expect(r.status).toBe(200)

    const resent = siBodies()[siBodies().length - 1].match(/<fu:IssueDateTime>([^<]+)<\/fu:IssueDateTime>/)?.[1] ?? ''
    // ZDAŠNJI trenutek klica ne sme pisati v dokument — sicer FURS zavrne prijavo
    // (zaščitna koda ne ujema IssueDateTime) in račun ostane neprijavljen
    expect(resent).toBe(isoLocal(printedAt, 'Europe/Ljubljana'))
    expect(resent).not.toBe(issuedXml)
    expect(resent.slice(0, 10)).not.toBe(issuedXml.slice(0, 10))
  })

  it('že fiskaliziran račun → 409 in ponovni SOAP se NE zgodi', async () => {
    const order = await seedOrder(locSI, 'si-twice', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 1 }])
    const id = (await (await pay(tokMgrSI, order, { clientOperationId: `${P}twice-${RUN}` })).json()).invoice.id
    const before = siBodies().length
    const r = await resubmit(tokMgrSI, id)
    expect(r.status).toBe(409)
    expect(String((await r.json()).error)).toContain('je že fiskaliziran')
    expect(siBodies().length).toBe(before)
  })

  it('račun BREZ ZOI/ZKI → 409 (novega zaščitnega koda ne ustvarjamo) in nič se ne odda', async () => {
    const order = await seedOrder(locSI, 'si-nozoi', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 1 }])
    // certifikat ob izdaji ni bil nameščen → prazne kode + 'pending' (runbook korak 2)
    const missing = [process.env.FURS_CERT_P12_B64, process.env.FURS_HR_CERT_P12_B64]
    delete process.env.FURS_CERT_P12_B64
    delete process.env.FURS_HR_CERT_P12_B64
    const resPay = await pay(tokMgrSI, order, { clientOperationId: `${P}nozoi-${RUN}` })
    missing.forEach((v, i) => {
      if (v) process.env[i === 0 ? 'FURS_CERT_P12_B64' : 'FURS_HR_CERT_P12_B64'] = v
    })
    expect(resPay.status).toBe(201)
    const rec = await receiptOf(order)
    expect(rec!.zoi).toBe('')
    expect(rec!.fiscalStatus).toBe('pending')

    const before = siBodies().length
    const r = await resubmit(tokMgrSI, rec!.id)
    expect(r.status).toBe(409)
    expect(String((await r.json()).error)).toContain('manjka ZOI')
    expect(siBodies().length).toBe(before)
    const row = await db.receipt.findUnique({ where: { id: rec!.id } })
    expect(row!.fiscalStatus).toBe('pending')
  })

  it('testna simulacija okolja → 409 in SOAP se NE pokliče', async () => {
    const order = await seedOrder(locSI, 'si-sim', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 1 }])
    const id = (await (await pay(tokMgrSI, order, { clientOperationId: `${P}sim-${RUN}` })).json()).invoice.id
    await db.receipt.update({ where: { id }, data: { fiscalStatus: 'pending', eor: '' } })
    const prev = process.env.FURS_ENVIRONMENT
    process.env.FURS_ENVIRONMENT = 'test'
    const before = siBodies().length
    const r = await resubmit(tokMgrSI, id)
    process.env.FURS_ENVIRONMENT = prev
    expect(r.status).toBe(409)
    expect(String((await r.json()).error)).toContain('simulacija')
    expect(siBodies().length).toBe(before)
  })

  it('brez nameščenega certifikata → 503, račun OSTANE pending', async () => {
    const order = await seedOrder(locSI, 'si-nocert', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 1 }])
    const id = (await (await pay(tokMgrSI, order, { clientOperationId: `${P}nc-${RUN}` })).json()).invoice.id
    await db.receipt.update({ where: { id }, data: { fiscalStatus: 'pending', eor: '' } })
    const prev = process.env.FURS_CERT_P12_B64
    delete process.env.FURS_CERT_P12_B64
    const r = await resubmit(tokMgrSI, id)
    process.env.FURS_CERT_P12_B64 = prev
    expect(r.status).toBe(503)
    expect(String((await r.json()).error)).toContain('Certifikat')
    const row = await db.receipt.findUnique({ where: { id } })
    expect(row!.fiscalStatus).toBe('pending')
  })

  it('padel ponudnik med obnovo → 502 in pending ostane (nikoli delno verified)', async () => {
    const order = await seedOrder(locSI, 'si-fail2', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 1 }])
    const id = (await (await pay(tokMgrSI, order, { clientOperationId: `${P}f2-${RUN}` })).json()).invoice.id
    await db.receipt.update({ where: { id }, data: { fiscalStatus: 'pending', eor: '' } })
    mode = 'fail'
    const r = await resubmit(tokMgrSI, id)
    mode = 'ok'
    expect(r.status).toBe(502)
    expect(String((await r.json()).error)).toContain("ostane 'pending'")
    const row = await db.receipt.findUnique({ where: { id } })
    expect(row!.fiscalStatus).toBe('pending')
    expect(row!.eor).toBe('')
    const audit = await waitForAudit('FISCAL_SUBMIT_FAILED', id)
    expect(audit).not.toBeNull()
    expect(audit!.subsequentSubmit).toBe(true)
  })

  it('robi robovi: brez orders.pay → 403, tuja lokacija → 403, neobstoječ račun → 404', async () => {
    const order = await seedOrder(locSI, 'si-authz', [{ name: `${P}Jed 22`, price: 10, vatRate: 22, qty: 1 }])
    const id = (await (await pay(tokMgrSI, order, { clientOperationId: `${P}az-${RUN}` })).json()).invoice.id
    await db.receipt.update({ where: { id }, data: { fiscalStatus: 'pending', eor: '' } })
    expect((await resubmit(tokChef, id)).status).toBe(403) // kuhar nima orders.pay
    expect((await resubmit(tokMgrHR, id)).status).toBe(403) // manager TUJE lokacije
    expect((await resubmit(tokMgrSI, `${P}rac-ne-obstaja`)).status).toBe(404)
  })
})

// ═══ 4. skupni modul: nobene lažne potrditve ═══

describe('submitFiscalDocument — meje skupnega modula', () => {
  it('simulacija → provider none (reason simulation), DB zapis NE poseže', async () => {
    const rec = await submitFiscalDocument({
      receipt: { id: `${P}rac-sim`, receiptNumber: '2026-1-1-BLGFSUBSI', zoi: 'Z', eor: '', cisZki: '', cisJir: '', paymentMethod: 'cash', orderId: null },
      location: { id: locSI, country: 'SI', taxId: 'SI12345678', premisesId: 'BLGFSUBSI', registerNumber: 'BLG-001SI', timezone: 'Europe/Ljubljana' },
      total: 10,
      vatMap: { '22.00': { base: 8.2, vat: 1.8 } },
      issuedAt: new Date(),
      userId: mgrSI,
      simulation: true,
    })
    expect(rec).toEqual({ provider: 'none', ok: false, reason: 'simulation' })
  })

  it('brez certifikata → provider none (reason no-certificate) tako za SI kot HR', async () => {
    const loc = (country: string) => ({
      id: country === 'SI' ? locSI : locHR, country, taxId: country === 'SI' ? 'SI12345678' : '12345678901',
      premisesId: country === 'SI' ? 'BLGFSUBSI' : 'FSUBHR01', registerNumber: country === 'SI' ? 'BLG-001SI' : '1',
      timezone: 'Europe/Ljubljana',
    })
    const base = {
      receipt: { id: `${P}rac-nocert`, receiptNumber: '2026-1-1-BLGFSUBSI', zoi: 'Z', eor: '', cisZki: 'K', cisJir: '', paymentMethod: 'cash', orderId: null },
      total: 10, vatMap: { '22.00': { base: 8.2, vat: 1.8 } }, issuedAt: new Date(), userId: mgrSI, simulation: false,
    }
    const si = [process.env.FURS_CERT_P12_B64, process.env.FURS_CERT_PASSWORD]
    const hr = [process.env.FURS_HR_CERT_P12_B64, process.env.FURS_HR_CERT_PASSWORD]
    delete process.env.FURS_CERT_P12_B64
    delete process.env.FURS_HR_CERT_P12_B64
    expect(await submitFiscalDocument({ ...base, location: loc('SI') })).toEqual({ provider: 'none', ok: false, reason: 'no-certificate' })
    expect(await submitFiscalDocument({ ...base, location: loc('HR') })).toEqual({ provider: 'none', ok: false, reason: 'no-certificate' })
    if (si[0]) process.env.FURS_CERT_P12_B64 = si[0]
    if (si[1]) process.env.FURS_CERT_PASSWORD = si[1]
    if (hr[0]) process.env.FURS_HR_CERT_P12_B64 = hr[0]
    if (hr[1]) process.env.FURS_HR_CERT_PASSWORD = hr[1]
  })

  it('izdaja in storno uporabljata ISTO pot ( regresija: koda se ne sme vrniti v issue.ts)', () => {
    const issue = readFileSync(join(import.meta.dir, '../src/lib/furs/issue.ts'), 'utf8')
    const stornoRoute = readFileSync(join(import.meta.dir, '../src/app/api/receipts/[id]/storno/route.ts'), 'utf8')
    // noben od obeh več NE klika neposredno ponudnika — to stori submit.ts
    expect(issue).not.toContain('fursInvoice(')
    expect(issue).not.toContain('cisInvoice(')
    expect(stornoRoute).not.toContain('fursInvoice(')
    expect(stornoRoute).not.toContain('cisInvoice(')
    expect(issue).toContain('submitFiscalDocument')
    expect(stornoRoute).toContain('submitFiscalDocument')
    // ena sama implementacija podpisa + oddaje
    const submit = readFileSync(join(import.meta.dir, '../src/lib/furs/submit.ts'), 'utf8')
    expect(submit).toContain('fursInvoice(')
    expect(submit).toContain('cisInvoice(')
    expect(submit).toContain("action: 'FISCAL_SUBMIT_FAILED'")
    expect(readFileSync(join(import.meta.dir, '../src/app/api/furs/[id]/resubmit/route.ts'), 'utf8')).toContain("action: 'FISCAL_RESUBMIT'")
  })

  it('.env.example in kode se ujemata pri fiskalnih envih (v1.144.0)', () => {
    // Dokaz (ta revizija): .env.example je oglašal FURS_CERT_P / FURS_HR_CERT_P,
    // kode pa bereta FURS_CERT_P12_B64 / FURS_HR_CERT_P12_B64. Lastnik, ki env
    // kopira iz vzorca, dobi certifikat, ki ga aplikacija NE vidi — tiha
    // produkcijska napaka ('pending' v nedogled, brez jasnega razloga).
    const root = join(import.meta.dir, '..')
    const inCode = new Set<string>()
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) {
          for (const m of readFileSync(p, 'utf8').matchAll(/process\.env\.(FURS[A-Z0-9_]+)/g)) inCode.add(m[1])
        }
      }
    }
    walk(join(root, 'src'))
    const documented = new Set(
      readFileSync(join(root, '.env.example'), 'utf8')
        .split('\n')
        .map((l) => l.match(/^([A-Z0-9_]+)=/)?.[1])
        .filter((k): k is string => Boolean(k) && k.startsWith('FURS')),
    )
    expect([...inCode].filter((k) => !documented.has(k))).toEqual([])
    expect([...documented].filter((k) => !inCode.has(k))).toEqual([])
    expect(inCode.has('FURS_CA_PEM')).toBe(true)
  })
})
