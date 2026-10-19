/**
 * Issue #22 (v1.148.0) — stanje gotovine v izmeni je bilo zapisano NEPREVERJENO:
 * `num()` iz neštevila naredi 0, negativen in poljubno velik znesek pa gresta
 * naprej. Posledica v produkciji: izmena je lahko pokazala poljubno razliko,
 * za katero ni nobenega reviziranega premika, `startingCash` pa se doslej ni
 * primerjala z ničemer (predaja predala med izmenama nima sledi).
 *
 * Pokrito:
 *  - C — meje začetnega stanja (parseDrawerCash prek POST /api/shifts: odpiranje)
 *  - S — meje končnega stanja (zaključek; ob zavrnitvi izmena OSTANE odprta)
 *  - H — CASH_HANDOVER_UNAUDITED (začetno stanje se ne ujema s končnim stanjem
 *    predhodne zaprte izmene na ISTI lokaciji)
 *  - P — pini vira (oba konca izmene sta validirana, enaka meja kot pri premikih)
 *
 * Vzorec: direktni uvoz route handlerjev (i60/i16) — NextRequest z createToken,
 * politika prek writeCashPolicy (singleton vrstica RestaurantSettings), probe
 * prisotnosti vsiljen (dev/Ci db ima tabelo in zrcalni stolpca).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as shiftsPOST } from '../src/app/api/shifts/route'
import {
  cashPolicyAvailable,
  resetCashMovementsProbe,
  resetCashPolicyProbe,
  resetZReportCashColumnsProbe,
  writeCashPolicy,
  CASH_MOVEMENT_MAX,
} from '../src/lib/cash-movements'

const P = 'a22-'
const RUN = String(Date.now()).slice(-8)
let settingsExistedBefore = false

let locA = '', locB = '', locC = '', locD = '', locE = '', mgr = ''

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(token: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/shifts', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function call(token: string, body?: unknown): Promise<{ code: number; d: Record<string, unknown> }> {
  const res = await shiftsPOST(req(token, body))
  return { code: res.status, d: (await res.json()) as Record<string, unknown> }
}

async function seedEmployee(id: string, role: string, loc: string, seq: number): Promise<string> {
  const email = `${id}@test.local`
  const f = employeePinFields(`${String(Date.now()).slice(-6)}${seq}`, email)
  await db.employee.create({
    data: {
      id, name: `${P}${role}`, email, role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

/** odprta izmena s konroliranim začetnim stanjem (ni odvisna od UI sanitizacije) */
async function openShift(employeeId: string, loc: string, startingCash: number, openedAt: Date): Promise<string> {
  const id = `${P}sh-${RUN}-${Math.random().toString(36).slice(2, 8)}`
  await db.cashRegisterShift.create({
    data: { id, employeeId, employeeName: `${P}mgr`, status: 'open', openedAt, startingCash, locationId: loc },
  })
  return id
}

/** zaprta izmena v PREDAJI (kontrahirano končno/pričakovano stanje) */
async function closedShift(employeeId: string, loc: string, opts: { closing: number; expected: number; at: Date }): Promise<string> {
  const id = `${P}pv-${RUN}-${Math.random().toString(36).slice(2, 8)}`
  await db.cashRegisterShift.create({
    data: {
      id, employeeId, employeeName: `${P}mgr`, status: 'closed', openedAt: new Date(opts.at.getTime() - 3_600_000),
      closedAt: opts.at, startingCash: 0, closingCash: opts.closing, expectedCash: opts.expected,
      locationId: loc,
    },
  })
  return id
}

/**
 * Zaključena izmena dobi closedAt = ZDAJ (route ga vzame iz ure), kar bi
 * primerjavo predaje naredilo nedeterministično glede na nahranjene
 * predhodnike. Vsak API zaključek v blokih H/ZATO zabijemo na fiksni čas.
 */
async function stampClosed(id: string, at: Date, over: { closing?: number; expected?: number } = {}): Promise<void> {
  await db.cashRegisterShift.update({
    where: { id },
    data: {
      closedAt: at,
      ...(over.closing === undefined ? {} : { closingCash: over.closing }),
      ...(over.expected === undefined ? {} : { expectedCash: over.expected }),
    },
  })
}

const handover = (shiftId: string) =>
  db.auditLog.findFirst({ where: { action: 'CASH_HANDOVER_UNAUDITED', entityId: shiftId }, orderBy: { timestamp: 'desc' } })

const shiftsOf = (employeeId: string) => db.cashRegisterShift.count({ where: { employeeId } })

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  resetCashMovementsProbe(true)
  resetCashPolicyProbe(true)
  resetZReportCashColumnsProbe(true)
  expect(await cashPolicyAvailable()).toBe(true)

  locA = `${P}locA-${RUN}`; locB = `${P}locB-${RUN}`; locC = `${P}locC-${RUN}`
  locD = `${P}locD-${RUN}`; locE = `${P}locE-${RUN}`
  const org = `${P}org-${RUN}`, brand = `${P}brand-${RUN}`, prop = `${P}prop-${RUN}`
  await db.organization.create({ data: { id: org, name: `${P}Org`, slug: `${P}-${RUN}` } })
  await db.brand.create({ data: { id: brand, organizationId: org, name: `${P}Brand` } })
  await db.property.create({ data: { id: prop, brandId: brand, name: `${P}Prop` } })
  let n = 0
  for (const loc of [locA, locB, locC, locD, locE]) {
    n += 1
    await db.location.create({ data: { id: loc, name: `${P}Lok${n}`, code: `A22${n}${RUN}`, propertyId: prop, timezone: 'Europe/Ljubljana', currency: 'EUR' } })
  }
  mgr = await seedEmployee(`${P}mgr-${RUN}`, 'manager', locA, 1)

  settingsExistedBefore = !!(await db.restaurantSettings.findFirst())
  if (!settingsExistedBefore) await db.restaurantSettings.create({ data: { id: `${P}settings-${RUN}` } })
  await writeCashPolicy({ cashVarianceThresholdCents: 0, cashBlindCount: false })
})

afterAll(async () => {
  await writeCashPolicy({ cashVarianceThresholdCents: 0, cashBlindCount: false }).catch(() => null)
  if (!settingsExistedBefore) await db.restaurantSettings.deleteMany({}).catch(() => null)
  resetCashMovementsProbe()
  resetCashPolicyProbe()
  resetZReportCashColumnsProbe()
  await sweepTestFixtures(db, [P])
})

/* ───────── C. začetno stanje predala (odpiranje izmene) ───────── */

describe('C. odpiranje izmene — meje začetnega stanja (najdba #22)', () => {
  const T = () => tok(mgr, `${P}mgr`, 'MANAGER', locA)

  it('C1 negativen znesek → 400; izmena NI odprta', async () => {
    await db.cashRegisterShift.deleteMany({ where: { employeeId: mgr } })
    const before = await shiftsOf(mgr)
    const r = await call(T(), { openingCash: -5 })
    expect(r.code).toBe(400)
    expect(String(r.d.error)).toMatch(/negativna/i)
    expect(await shiftsOf(mgr)).toBe(before)
  })

  it('C2 nad mejo premikov (100.000 EUR) → 400; meja je ISTA kot pri ročnih premikih', async () => {
    const before = await shiftsOf(mgr)
    const r = await call(T(), { openingCash: CASH_MOVEMENT_MAX + 0.01 })
    expect(r.code).toBe(400)
    expect(String(r.d.error)).toMatch(/presega mejo/i)
    expect(await shiftsOf(mgr)).toBe(before)
  })

  it('C3 neštevilske vrednosti in tuji tipi → 400 in NE tiho 0 (prej: num() je spral v 0)', async () => {
    const before = await shiftsOf(mgr)
    for (const bad of ['abc', {}, [], '1e999', 'petdeset', true, '25.5.5']) {
      const r = await call(T(), { openingCash: bad })
      expect(r.code).toBe(400)
      expect(String(r.d.error)).toMatch(/veljavno število/i)
    }
    expect(await shiftsOf(mgr)).toBe(before)
  })

  it('C4 meja je vključujoča: 100.000 EUR je še veljaven fond (201)', async () => {
    await db.cashRegisterShift.deleteMany({ where: { employeeId: mgr } })
    const r = await call(T(), { openingCash: CASH_MOVEMENT_MAX })
    expect(r.code).toBe(201)
    const s = await db.cashRegisterShift.findFirst({ where: { employeeId: mgr, status: 'open' }, orderBy: { openedAt: 'desc' } })
    expect(Number(s?.startingCash)).toBe(CASH_MOVEMENT_MAX)
  })

  it('C5 prazen izpuščen vnos ostane 0 (dosedanji UI obrazec se NE sesuje)', async () => {
    await db.cashRegisterShift.deleteMany({ where: { employeeId: mgr } })
    const a = await call(T(), {})
    expect(a.code).toBe(201)
    expect(Number((a.d.shift as { openingCash?: number }).openingCash)).toBe(0)
    await db.cashRegisterShift.deleteMany({ where: { employeeId: mgr } })
    const b = await call(T(), { openingCash: '' })
    expect(b.code).toBe(201)
    expect(Number((b.d.shift as { openingCash?: number }).openingCash)).toBe(0)
  })

  it('C6 decimalna vejica in niz ostaneta podprta vnosa (25,50 → 25.50)', async () => {
    await db.cashRegisterShift.deleteMany({ where: { employeeId: mgr } })
    const r = await call(T(), { openingCash: '25,50' })
    expect(r.code).toBe(201)
    const s = await db.cashRegisterShift.findFirst({ where: { employeeId: mgr, status: 'open' }, orderBy: { openedAt: 'desc' } })
    expect(Number(s?.startingCash)).toBe(25.5)
  })

  it('C7 audit SHIFT_OPEN zapiše ISTI znesek kot izmena (sled ne razhaja od stanja)', async () => {
    await db.cashRegisterShift.deleteMany({ where: { employeeId: mgr } })
    const r = await call(T(), { openingCash: '17,80' })
    expect(r.code).toBe(201)
    const shiftId = String((r.d.shift as { id?: string }).id)
    const audit = await db.auditLog.findFirst({ where: { action: 'SHIFT_OPEN', entityId: shiftId }, orderBy: { timestamp: 'desc' } })
    expect(audit).not.toBeNull()
    expect(JSON.parse(String(audit?.details)).startingCash).toBe(17.8)
  })
})

/* ───────── S. končno stanje predala (zaključek izmene) ───────── */

describe('S. zaključek izmene — meje končnega stanja (najdba #22)', () => {
  const T = () => tok(mgr, `${P}mgr`, 'MANAGER', locB)

  it('S1 negativen končni znesek → 400; izmena OSTANE odprta, brez Z-poročila', async () => {
    await db.cashRegisterShift.deleteMany({ where: { employeeId: mgr } })
    const shiftId = await openShift(mgr, locB, 50, new Date('2019-01-01T08:00:00Z'))
    const r = await call(T(), { action: 'stop', closingCash: -1 })
    expect(r.code).toBe(400)
    expect(String(r.d.error)).toMatch(/negativna/i)
    const s = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(s?.status).toBe('open')
    expect(s?.closedAt).toBeNull()
    expect(await db.zReport.count({ where: { openedAt: new Date('2019-01-01T08:00:00Z') } })).toBe(0)
  })

  it('S2 neštevilski končni znesek → 400 (ne tiho 0, kar bi prikazalo izmišljeno manjkajočo gotovino)', async () => {
    const shiftId = await openShift(mgr, locB, 50, new Date('2019-02-01T08:00:00Z'))
    const r = await call(T(), { action: 'stop', closingCash: 'vse je ok' })
    expect(r.code).toBe(400)
    expect(String(r.d.error)).toMatch(/veljavno število/i)
    expect((await db.cashRegisterShift.findUnique({ where: { id: shiftId } }))?.status).toBe('open')
  })

  it('S3 končni znesek nad mejo → 400; velikega odvoda ne vpisujemo v števanje predala', async () => {
    const shiftId = await openShift(mgr, locB, 50, new Date('2019-03-01T08:00:00Z'))
    const r = await call(T(), { action: 'stop', closingCash: CASH_MOVEMENT_MAX + 1 })
    expect(r.code).toBe(400)
    expect(String(r.d.error)).toMatch(/presega mejo/i)
    expect((await db.cashRegisterShift.findUnique({ where: { id: shiftId } }))?.status).toBe('open')
  })

  it('S4 velaven končni znesek zaključi normalno (200, Z-poročilo, zaprta izmena)', async () => {
    const shiftId = await openShift(mgr, locB, 50, new Date('2019-04-01T08:00:00Z'))
    const r = await call(T(), { action: 'stop', closingCash: 50 })
    expect(r.code).toBe(200)
    const s = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(s?.status).toBe('closed')
    expect(Number(s?.closingCash)).toBe(50)
    expect(r.d.zReport).toBeTruthy()
  })

  it('S5 izpuščen končni vnos ostane 0 (dosedanje vedenje se NE spremeni)', async () => {
    const shiftId = await openShift(mgr, locB, 30, new Date('2019-05-01T08:00:00Z'))
    const r = await call(T(), { action: 'stop' })
    expect(r.code).toBe(200)
    expect(Number((await db.cashRegisterShift.findUnique({ where: { id: shiftId } }))?.closingCash)).toBe(0)
  })
})

/* ───────── H. predaja predala med izmenama ───────── */

describe('H. CASH_HANDOVER_UNAUDITED — začetno stanje proti končnemu predhodne izmene', () => {
  const T = (loc: string) => tok(mgr, `${P}mgr`, 'MANAGER', loc)
  const at = (d: string) => new Date(`${d}T10:00:00.000Z`)
  let h2Id = ''

  it('H1 brez predhodne zaprte izmene na lokaciji → zaključek 200, BREZ zapisa', async () => {
    const shiftId = await openShift(mgr, locC, 50, new Date('2019-06-01T08:00:00Z'))
    const r = await call(T(locC), { action: 'stop', closingCash: 50 })
    expect(r.code).toBe(200)
    expect(await handover(shiftId)).toBeNull()
    await stampClosed(shiftId, at('2019-06-01'))
  })

  it('H2 ujemajoča se predaja (50,00 → 50,00) → BREZ zapisa (nobenega suma ni)', async () => {
    h2Id = await openShift(mgr, locC, 50, new Date('2019-06-02T08:00:00Z'))
    expect((await call(T(locC), { action: 'stop', closingCash: 50 })).code).toBe(200)
    expect(await handover(h2Id)).toBeNull()
    // H2 je FIZIČNO štela 50, knjige pa 48 → nadaljnji primer mora kazati OBE merili
    await stampClosed(h2Id, at('2019-06-02'), { expected: 48 })
  })

  it('H3 nestrinjanje nad pragom → zapis z obeh merilih (fizično in knjigovodsko)', async () => {
    const shiftId = await openShift(mgr, locC, 70, new Date('2019-06-03T08:00:00Z'))
    const r = await call(T(locC), { action: 'stop', closingCash: 70 })
    expect(r.code).toBe(200) // zapis NE prekine že uspešnega zaključka
    expect(r.d.zReport).toBeTruthy()
    const audit = await handover(shiftId)
    expect(audit).not.toBeNull()
    expect(audit?.entityType).toBe('CashRegisterShift')
    expect(audit?.locationId).toBe(locC)
    expect(audit?.userId).toBe(mgr)
    const d = JSON.parse(String(audit?.details)) as Record<string, number | string | null>
    expect(d.previousShiftId).toBe(h2Id)
    expect(d.openingCash).toBe(70)
    expect(d.previousClosingCash).toBe(50)
    expect(d.previousExpectedCash).toBe(48)
    expect(d.closingGapEur).toBe(20)
    expect(d.expectedGapEur).toBe(22)
    expect(d.thresholdCents).toBe(0)
    expect(String(d.previousClosedAt)).toBe('2019-06-02T10:00:00.000Z')
    await stampClosed(shiftId, at('2019-06-03'))
  })

  it('H4 razlika pod pragom politike → BREZ zapisa; nad pragom → zapis', async () => {
    await writeCashPolicy({ cashVarianceThresholdCents: 200 }) // 2 EUR
    try {
      const underId = await openShift(mgr, locC, 71.5, new Date('2019-06-04T08:00:00Z'))
      expect((await call(T(locC), { action: 'stop', closingCash: 71.5 })).code).toBe(200)
      expect(await handover(underId)).toBeNull() // H3 je zaprla s 70 → razlika 1,50 = 150 centov
      await stampClosed(underId, at('2019-06-04'))

      const overId = await openShift(mgr, locC, 77, new Date('2019-06-05T08:00:00Z'))
      expect((await call(T(locC), { action: 'stop', closingCash: 77 })).code).toBe(200)
      const audit = await handover(overId)
      expect(audit).not.toBeNull()
      const d = JSON.parse(String(audit?.details)) as Record<string, number>
      expect(d.thresholdCents).toBe(200)
      expect(d.closingGapEur).toBe(5.5)
      await stampClosed(overId, at('2019-06-05'))
    } finally {
      await writeCashPolicy({ cashVarianceThresholdCents: 0 })
    }
  })

  it('H5 primerjava je PO LOKACIJI: tuja predhodna izmena ne sme ustvariti suma', async () => {
    // velika tuja predaja na locD; naša izmena je na locE (tam predhodne ni) →
    // če bi poizvedba preskočila lokacijo, bi prav tako dobila sum
    await closedShift(mgr, locD, { closing: 900, expected: 900, at: new Date('2019-07-01T07:00:00Z') })
    const shiftId = await openShift(mgr, locE, 0, new Date('2019-07-02T08:00:00Z'))
    expect((await call(T(locE), { action: 'stop', closingCash: 0 })).code).toBe(200)
    expect(await handover(shiftId)).toBeNull()
    // nasprotni dokaz: ISTA numerika na locD sum MORI zapisati
    const foreignId = await openShift(mgr, locD, 400, new Date('2019-07-03T08:00:00Z'))
    expect((await call(T(locD), { action: 'stop', closingCash: 400 })).code).toBe(200)
    const audit = await handover(foreignId)
    expect(audit).not.toBeNull()
    const d = JSON.parse(String(audit?.details)) as Record<string, number>
    expect(d.previousClosingCash).toBe(900)
    expect(d.closingGapEur).toBe(-500)
    expect(audit?.locationId).toBe(locD)
  })

  it('H6 predaja se primerja z ZADNJO zaprto izmeno na lokaciji (closedAt desc)', async () => {
    await closedShift(mgr, locC, { closing: 10, expected: 10, at: new Date('2019-08-01T07:00:00Z') })
    const newest = await closedShift(mgr, locC, { closing: 20, expected: 20, at: new Date('2019-08-02T07:00:00Z') })
    const okId = await openShift(mgr, locC, 20, new Date('2019-08-03T08:00:00Z'))
    expect((await call(T(locC), { action: 'stop', closingCash: 20 })).code).toBe(200)
    expect(await handover(okId)).toBeNull() // ujema se z 20, ne s staro 10
    await stampClosed(okId, at('2019-08-03'))
    // in obratno: odprtje s 15 se ne ujema z zadnjo (20) → zapis o zadnji
    const badId = await openShift(mgr, locC, 15, new Date('2019-08-04T08:00:00Z'))
    expect((await call(T(locC), { action: 'stop', closingCash: 15 })).code).toBe(200)
    const audit = await handover(badId)
    expect(audit).not.toBeNull()
    const d = JSON.parse(String(audit?.details)) as Record<string, number | string>
    expect(d.previousShiftId).toBe(okId)
    expect(d.previousClosingCash).toBe(20)
    expect(d.closingGapEur).toBe(-5)
    expect(newest).toBeTruthy() // zadnja ni več nahranjena, ampak API-zaprta
  })
})

/* ───────── P. pini vira ───────── */

describe('P. pini vira (najdba #22)', () => {
  const src = () => Bun.file(`${import.meta.dir}/../src/app/api/shifts/route.ts`).text()

  it('P1 oba konca izmene sta validirana z isto funkcijo in isto mejo', async () => {
    const s = await src()
    expect(s).toContain('parseDrawerCash(body.closingCash')
    expect(s).toContain('parseDrawerCash(body?.openingCash')
    expect(s).toContain('CASH_MOVEMENT_MAX')
    // surovi prevodi brez preverbe so izkoreninjeni
    expect(s).not.toMatch(/closingCash:\s*num\(body/)
    expect(s).not.toMatch(/startingCash:\s*num\(body/)
  })

  it('P2 negativen vnos se ne more pripeti v nobeni veji (zgolj meja 0 ≤ x ≤ MAX)', async () => {
    const s = await src()
    expect(s).toContain('if (n < 0) return { ok: false')
    expect(s).toContain('if (n > CASH_MOVEMENT_MAX) return { ok: false')
  })

  it('P3 handover zapis je fail-soft in PO transakciji (ne more prekiniti zaključka)', async () => {
    const s = await src()
    const auditAt = s.indexOf("action: 'CASH_HANDOVER_UNAUDITED'")
    const txEnd = s.indexOf('// OPS-8 val 2 (v1.72.0): push to management on shift close')
    expect(auditAt).toBeGreaterThan(-1)
    expect(auditAt).toBeLessThan(txEnd)
    expect(s.lastIndexOf('try {', auditAt)).toBeGreaterThan(auditAt - 1200)
    expect(s.slice(auditAt, auditAt + 1200)).toContain('never block the shift close response')
  })
})
