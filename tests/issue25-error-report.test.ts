/**
 * Issue #25 (P1) — POST /api/monitoring/errors: validacija + sanitizacija
 * diagnostičnega poročila PRED zapisom v audit (brez slepega kopiranja
 * klientovega objekta in brez surovega odmeva nazaj).
 *
 * Pokrito:
 *  1. Združljivost: POST s samim veljavnim message → 201 { accepted, reportId,
 *     status } — BREZ log/data/details v odgovoru (surov odmev odstranjen);
 *  2. AuditLog vrstica: SAMO kanonični DTO v details, userId akterja,
 *     locationId akterja, chainHash/previousHash zapisani, veriga veljavna;
 *  3. Validacija: mankajoči/ne-niz/prazen/predolg message, nepoznana polja,
 *     array/invalid JSON telo, ugnezden context, ne-niz context vrednost,
 *     preveč context ključev, predolga context vrednost → 400;
 *  4. Sanitizacija: bearer/JWT/ghp_/sk_live_/api_key/password/sessionId/PAN/
 *     e-pošta/stack-frame v message IN context → odstranjeni iz audit zapisa
 *     IN iz odgovora; prisotne [REDACTED*] zamenjave;
 *  5. Ločitev pravic: waiter (brez settings.manage) lahko ODDA (201) ne more
 *     BRATI (403); manager z settings.manage bere, a SAMO svojo lokacijo
 *     (cross-tenant poročilo locB ni vidno mgrA — obratno mgrB ga vidi);
 *  6. GET oblika ostaja dashboard-združljiva (mapAudit polja).
 *
 * Fiksture s predpono i25-; audit vrstice počistimo ročno po userId/locationId
 * predponi (auditLog nima FK, ID_SWEEP ne zajame entityId=nid()).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET, POST } from '../src/app/api/monitoring/errors/route'
import { verifyAuditChain } from '../src/lib/audit-chain'
import { redactSensitiveText, validateErrorReport } from '../src/lib/error-report'

const P = 'i25-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let locB = ''
let waiterAId = ''
let mgrAId = ''
let mgrBId = ''
let empNoLocId = ''
let tokWaiterA = ''
let tokMgrA = ''
let tokMgrB = ''
let tokNoLoc = ''
let testStart = new Date()

function req(method: string, url: string, token: string | null, body?: unknown): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers,
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

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

// vse skrivnosti, ki jih pošljemo v (veljavnem) message — PO popravku ne smejo
// obstati NIKJER (audit zapis ali odgovor)
const SECRET_BEARER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const SECRET_GHP = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'
const SECRET_SK = 'sk_live_ABCDEFGHIJKLMNOPQRSTUV'
const SECRET_PASSWORD = 'hunter2supersecret'
const SECRET_SESSION = 'abc123sessionvalue987'
const SECRET_PAN = '4111111111111111'
const SECRET_EMAIL_LOCAL = 'janez.kovac'

const SECRET_MESSAGE = [
  'Plačilo je spodletelo: strežnik je vrnil 500.',
  `Poskusili smo Authorization: Bearer ${SECRET_BEARER} brez uspeha.`,
  `Žeton strežnika: ${SECRET_GHP}.`,
  `Stripe: ${SECRET_SK}.`,
  `Podatki: password: ${SECRET_PASSWORD}.`,
  `Session: sessionId=${SECRET_SESSION}.`,
  `Kartica gostota ${SECRET_PAN} zavrnjena.`,
  `Kontakt gosta: ${SECRET_EMAIL_LOCAL}@example.si.`,
  'Stack:\n    at mapStateToProps (webpack:///app/dashboard/page.tsx:403:17)\n    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:1:2)',
].join(' ')

beforeAll(async () => {
  testStart = new Date()
  // ročno čiščenje ostankov prejšnjih (crashanih) tekov — auditLog ni FK-vezan
  await db.auditLog.deleteMany({
    where: { OR: [{ userId: { startsWith: P } }, { locationId: { startsWith: P } }, { id: { startsWith: P } }] },
  })
  await sweepTestFixtures(db, [P])

  locA = `${P}locA-${RUN}`
  locB = `${P}locB-${RUN}`
  await db.location.create({ data: { id: locA, name: `${P}Lokacija A`, code: `I25A${RUN}` } })
  await db.location.create({ data: { id: locB, name: `${P}Lokacija B`, code: `I25B${RUN}` } })

  waiterAId = await seedEmployee('waiterA', 'waiter', locA, 1)
  mgrAId = await seedEmployee('mgrA', 'manager', locA, 2)
  mgrBId = await seedEmployee('mgrB', 'manager', locB, 3)
  // ISSUE #72 C1/C2: /api/monitoring/errors zahteva settings.manage — managerja ga
  // nita več po vlogi; test 10 preverja LOKACIJSKO izolacijo, zato dobita oba admina
  // ODobreni override (guardResource ju še vedno veže na lastno lokacijo)
  await db.employee.update({ where: { id: mgrAId }, data: { permissionOverrides: JSON.stringify(['settings.manage']) } })
  await db.employee.update({ where: { id: mgrBId }, data: { permissionOverrides: JSON.stringify(['settings.manage']) } })
  empNoLocId = await seedEmployee('noLoc', 'waiter', null, 4)

  tokWaiterA = createToken({ sub: waiterAId, name: 'waiterA', role: 'waiter', loc: locA, sv: 0 })
  tokMgrA = createToken({ sub: mgrAId, name: 'mgrA', role: 'manager', loc: locA, sv: 0 })
  tokMgrB = createToken({ sub: mgrBId, name: 'mgrB', role: 'manager', loc: locB, sv: 0 })
  tokNoLoc = createToken({ sub: empNoLocId, name: 'noLoc', role: 'waiter', loc: null, sv: 0 })
})

afterAll(async () => {
  await db.auditLog.deleteMany({
    where: { OR: [{ userId: { startsWith: P } }, { locationId: { startsWith: P } }, { id: { startsWith: P } }] },
  })
  await sweepTestFixtures(db, [P])
})

// ── čisti unit testi pomočnikov ──
describe('issue #25 — redactSensitiveText (unit)', () => {
  it('zamenja bearer/glavo žetona', () => {
    const r = redactSensitiveText(`Authorization: Bearer ${SECRET_BEARER}`)
    expect(r.text).not.toContain(SECRET_BEARER)
    expect(r.text).toContain('[REDACTED]')
  })
  it('zamenja basic auth', () => {
    const r = redactSensitiveText('Authorization: Basic dXNlcjpwYXNzd29yZA==')
    // authHeader odstrani b64 skrivnost; labeledSecret nato maskira ostanek
    // "Basic" (label authorization) — varnostna smer, obeh markerja sta OK
    expect(r.text).toBe('Authorization: [REDACTED] [REDACTED]')
    expect(r.text).not.toContain('dXNlcjpwYXNzd29yZA')
  })
  it('zamenja JWT trojček zunaj glave', () => {
    const r = redactSensitiveText(`jwt=${SECRET_BEARER} je potekel`)
    expect(r.text).not.toContain(SECRET_BEARER)
  })
  it('zamenja poverilnico v query-stringu', () => {
    const r = redactSensitiveText('https://api.x.com/v1?token=supersecret123&limit=10')
    expect(r.text).not.toContain('supersecret123')
    expect(r.text).toContain('token=[REDACTED]')
    expect(r.text).toContain('limit=10')
  })
  it('zamenja poznane žetonske prefikse', () => {
    for (const t of [SECRET_GHP, SECRET_SK, 'glpat-AbCdEfGh1234567890', 'vcp_1vCC6XHNAfCwzFBas8TW8']) {
      const r = redactSensitiveText(`uporabljali ${t} do zdaj`)
      expect(r.text).not.toContain(t)
      expect(r.text).toContain('[REDACTED_TOKEN]')
    }
  })
  it('zamenja označene skrivnosti (password/token/api key/cvv/pin)', () => {
    expect(redactSensitiveText('password: mojaGeslo1').text).not.toContain('mojaGeslo1')
    expect(redactSensitiveText('api_key=nekaj123456').text).not.toContain('nekaj123456')
    expect(redactSensitiveText('cvv=999').text).not.toContain('999')
    expect(redactSensitiveText('PIN=123456').text).not.toContain('123456')
  })
  it('NE zamenja nedolžnih besed z oznako v besedi (mapping/pine)', () => {
    const r = redactSensitiveText('mapping=order in pine=tree ostajata')
    expect(r.text).toBe('mapping=order in pine=tree ostajata')
  })
  it('zamenja kartični PAN (z ločili in brez)', () => {
    expect(redactSensitiveText(SECRET_PAN).text).not.toContain(SECRET_PAN)
    expect(redactSensitiveText('4111 1111 1111 1111').text).not.toContain('4111')
  })
  it('maskira e-poštni lokalni del (domena ostane)', () => {
    const r = redactSensitiveText(`info od ${SECRET_EMAIL_LOCAL}@example.si`)
    expect(r.text).not.toContain(`${SECRET_EMAIL_LOCAL}@`)
    expect(r.text).toContain('j***@example.si')
  })
  it('povsem odstrani stack-trace ogrodje', () => {
    const r = redactSensitiveText(`Napaka X\n    at foo (webpack:///x.ts:1:1)\n    at bar (node_modules/y.js:2:2)`)
    expect(r.text).not.toContain('webpack://')
    expect(r.text).toContain('[STACK_FRAME_REDACTED]')
    expect(r.text).toContain('Napaka X')
  })
  it('odstrani nadzorne znake in ANSI (log injection)', () => {
    const r = redactSensitiveText('ab\u0000cd\u001B[31m rdeče')
    expect(r.text).toBe('abcd rdeče')
  })
})

describe('issue #25 — validateErrorReport (unit)', () => {
  it('veljavno samo message → dto brez dodatnih polj', () => {
    const r = validateErrorReport({ message: 'Napaka pri plačilu' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dto.message).toBe('Napaka pri plačilu')
      expect(r.dto.code).toBeUndefined()
      expect(r.dto.context).toBeUndefined()
    }
  })
  it('nepoznano polje → zavrnitev z imenom polja', () => {
    const r = validateErrorReport({ message: 'x', payload: { a: 1 } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('payload')
  })
  it('array/string telo → zavrnitev', () => {
    expect(validateErrorReport(['x']).ok).toBe(false)
    expect(validateErrorReport('x').ok).toBe(false)
  })
  it('message ne-niz / prazen / predolg', () => {
    expect(validateErrorReport({ message: 123 }).ok).toBe(false)
    expect(validateErrorReport({ message: '   ' }).ok).toBe(false)
    expect(validateErrorReport({ message: 'a'.repeat(2001) }).ok).toBe(false)
    expect(validateErrorReport({ message: 'a'.repeat(2000) }).ok).toBe(true)
  })
  it('context: ugnezden objekt / ne-niz vrednost / preveč ključev / predolga vrednost', () => {
    expect(validateErrorReport({ message: 'x', context: { a: { b: 1 } } }).ok).toBe(false)
    expect(validateErrorReport({ message: 'x', context: { a: 1 } }).ok).toBe(false)
    const tooMany: Record<string, string> = {}
    for (let i = 0; i < 9; i++) tooMany[`k${i}`] = 'v'
    expect(validateErrorReport({ message: 'x', context: tooMany }).ok).toBe(false)
    expect(validateErrorReport({ message: 'x', context: { a: 'v'.repeat(201) } }).ok).toBe(false)
    expect(validateErrorReport({ message: 'x', context: { a: 'v'.repeat(200) } }).ok).toBe(true)
  })
  it('vsa dovoljena polja + redakcija teče tudi v context', () => {
    const r = validateErrorReport({
      message: 'Napaka', code: 'POS-500', component: 'dashboard/payments',
      correlationId: 'corr-123', context: { url: 'https://x?token=abcdef123' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dto.code).toBe('POS-500')
      expect(r.dto.context?.url).toContain('token=[REDACTED]')
      expect(r.redactions).toContain('queryCredential')
    }
  })
})

// ── route nivo (DB) ──
describe('issue #25 — POST /api/monitoring/errors (route)', () => {
  it('1. veljaven message → 201 { accepted, reportId, status } BREZ odmeva', async () => {
    const r = await POST(req('POST', '/api/monitoring/errors', tokWaiterA, { message: 'Napaka pri povezavi s tiskalnikom' }))
    expect(r.status).toBe(201)
    const b = await body(r)
    expect(b.accepted).toBe(true)
    expect(b.status).toBe('recorded')
    expect(typeof b.reportId).toBe('string')
    expect((b.reportId as string).length).toBe(25)
    // surov odmev odstranjen
    expect(b.log).toBeUndefined()
    expect(b.data).toBeUndefined()
    expect(b.details).toBeUndefined()
    expect(JSON.stringify(b)).not.toContain('Napaka pri povezavi')
  })

  it('2. audit vrstica: kanonični DTO, akterjev userId + locationId, chain polja', async () => {
    const r = await POST(req('POST', '/api/monitoring/errors', tokWaiterA, { message: 'POS zamrznil pri plačilu' }))
    const b = await body(r)
    const row = await db.auditLog.findUnique({ where: { id: b.reportId as string } })
    expect(row).not.toBeNull()
    expect(row!.action).toBe('ERROR_REPORT')
    expect(row!.entityType).toBe('client')
    expect(row!.entityId).toBe(b.reportId)
    expect(row!.userId).toBe(waiterAId)
    expect(row!.locationId).toBe(locA)
    expect(row!.chainHash).not.toBe('')
    const dto = JSON.parse(row!.details) as Record<string, unknown>
    expect(dto.message).toBe('POS zamrznil pri plačilu')
    // SAMO dovoljena polja — nobenih odvečnih ključev
    expect(Object.keys(dto).sort()).toEqual(['message'])
  })

  it('3. skrivnosti v message/context → SANITIZIRANO v audit IN odgovoru', async () => {
    const r = await POST(req('POST', '/api/monitoring/errors', tokWaiterA, {
      message: SECRET_MESSAGE,
      code: 'PAY-500',
      component: 'payments',
      correlationId: 'corr-i25',
      context: { url: `https://api.x.com/v1?token=topsecretvalue123`, user: `${SECRET_EMAIL_LOCAL}@example.si` },
    }))
    expect(r.status).toBe(201)
    const b = await body(r)
    const row = await db.auditLog.findUnique({ where: { id: b.reportId as string } })
    const auditJson = row!.details
    const responseJson = JSON.stringify(b)

    const forbidden = [
      SECRET_BEARER, SECRET_GHP, SECRET_SK, SECRET_PASSWORD, SECRET_SESSION,
      SECRET_PAN, `${SECRET_EMAIL_LOCAL}@`, 'topsecretvalue123',
      'webpack://', 'react-dom.development.js',
    ]
    for (const secret of forbidden) {
      expect(auditJson).not.toContain(secret)
      expect(responseJson).not.toContain(secret)
    }
    expect(auditJson).toContain('[REDACTED')
    expect(auditJson).toContain('j***@example.si')
    expect(auditJson).toContain('[STACK_FRAME_REDACTED]')
    // berljivi del sporočila ostane (diagnostična vrednost)
    expect(auditJson).toContain('Plačilo je spodletelo')
    // DTO ostaja dovoljena oblika
    const dto = JSON.parse(auditJson) as Record<string, unknown>
    expect(Object.keys(dto).sort()).toEqual(['code', 'component', 'context', 'correlationId', 'message'])
  })

  it('4. zavrnitve validacije → 400', async () => {
    const cases: Array<{ name: string; body: unknown }> = [
      { name: 'brez message', body: {} },
      { name: 'message ne-niz', body: { message: 123 } },
      { name: 'message prazen', body: { message: '   ' } },
      { name: 'message predolg', body: { message: 'a'.repeat(5000) } },
      { name: 'nepoznano polje', body: { message: 'x', password: 'geslo' } },
      { name: 'ugnezden context', body: { message: 'x', context: { a: { b: 1 } } } },
      { name: 'context ne-niz vrednost', body: { message: 'x', context: { a: 7 } } },
    ]
    for (const c of cases) {
      const r = await POST(req('POST', '/api/monitoring/errors', tokWaiterA, c.body))
      expect(r.status).toBe(400)
      const b = await body(r)
      expect(typeof b.error).toBe('string')
      expect((b.error as string).length).toBeGreaterThan(0)
    }
  })

  it('5. array telo in neveljaven JSON → 400', async () => {
    const arr = await POST(req('POST', '/api/monitoring/errors', tokWaiterA, ['message']))
    expect(arr.status).toBe(400)
    // neveljaven JSON: ročno zgrajen NextRequest z broken body
    const broken = new NextRequest('http://localhost:3000/api/monitoring/errors', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokWaiterA}`, 'content-type': 'application/json' },
      body: '{"message": broken',
    })
    const r = await POST(broken)
    expect(r.status).toBe(400)
    const b = await body(r)
    expect(b.error).toContain('JSON')
  })

  it('6. neprijavljen POST → 401 (oddaja še vedno zahteva prijavo)', async () => {
    const r = await POST(req('POST', '/api/monitoring/errors', null, { message: 'x' }))
    expect(r.status).toBe(401)
  })

  it('7. uporabnik brez lokacije lahko odda; vrstica dobi locationId null (akter)', async () => {
    const r = await POST(req('POST', '/api/monitoring/errors', tokNoLoc, { message: 'Napaka brez lokacije' }))
    expect(r.status).toBe(201)
    const b = await body(r)
    const row = await db.auditLog.findUnique({ where: { id: b.reportId as string } })
    expect(row!.userId).toBe(empNoLocId)
    expect(row!.locationId).toBeNull()
  })

  it('8. audit veriga ostaja veljavna po novih vrsticah (hash + povezave)', async () => {
    const written = await db.auditLog.count({ where: { userId: { startsWith: P } } })
    expect(written).toBeGreaterThanOrEqual(4)
    const v = await verifyAuditChain(db, { model: 'auditLog', limit: 5000, after: testStart })
    expect(v.ok).toBe(true)
    expect(v.checked).toBeGreaterThanOrEqual(written)
  })
})

describe('issue #25 — GET /api/monitoring/errors (scope, nedotaknjen + čistejši podatki)', () => {
  it('9. waiter brez settings.manage → 403 (oddaja ≠ branje)', async () => {
    const r = await GET(req('GET', '/api/monitoring/errors', tokWaiterA))
    expect(r.status).toBe(403)
  })

  it('10. manager vidi SAMO svojo lokacijo — cross-tenant poročilo ni vidno', async () => {
    // poročilo na locB (marker) — ne sme biti vidno mgrA, mgrB pa ga vidi
    const marker = `I25-CROSSMARKER-${RUN}`
    const rb = await POST(req('POST', '/api/monitoring/errors', tokMgrB, { message: marker }))
    expect(rb.status).toBe(201)

    const ra = await GET(req('GET', '/api/monitoring/errors', tokMgrA))
    expect(ra.status).toBe(200)
    const ba = await body(ra)
    expect(Array.isArray(ba.errors)).toBe(true)
    const errors = ba.errors as Array<Record<string, unknown>>
    expect(errors.length).toBeGreaterThan(0)
    for (const e of errors) {
      expect(e.action).toContain('ERROR')
      // dashboard združljiva oblika (mapAudit)
      expect(typeof e.id).toBe('string')
      expect(typeof e.createdAt).toBe('string')
    }
    expect(JSON.stringify(ba)).not.toContain(marker)
    // poročila, ki jih mgrA vidi, so bila pisana NA locA (ni odmeva tuje lokacije)
    const idsA = errors.map((e) => e.id as string)
    if (idsA.length > 0) {
      const rows = await db.auditLog.findMany({ where: { id: { in: idsA } }, select: { locationId: true } })
      for (const row of rows) expect(row.locationId).toBe(locA)
    }

    const rbn = await GET(req('GET', '/api/monitoring/errors', tokMgrB))
    expect(rbn.status).toBe(200)
    const bbn = await body(rbn)
    expect(JSON.stringify(bbn)).toContain(marker)
  })
})
