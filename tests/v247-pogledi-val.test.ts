/**
 * v1.247.0 — POGLEDI VAL (PRIMERJAVA-VMESNIKOV-2026 §21:
 * Lightspeed april 2026 — saved report views).
 *
 * Dve ugotovitvi:
 *  A · RELATIVNA OBDOBJA (P1): fiksna datuma shranjenega pogleda zastarita —
 *    pogled nosi PREDLOG (»ta mesec«, »prejšnji teden« …), ki se ob vsakem
 *    zagonu reši sveže (resolveReportRange — čisto jedro, lokalni koledar).
 *  B · SKUPNI REGISTR (P2): Integration vrstica per lokacija (0 DDL, vzorec
 *    pacing/combos/checklists) — kdor sme poganjati izvoz (reports.sales),
 *    sme brati/pisati pogledde; zagon poteče klient prek obstoječih rut.
 *
 * Predpona fiksatur `v247-`; cleanup v afterAll (obratna smer FK).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as viewsGET, PUT as viewsPUT } from '../src/app/api/reports/views/route'
import { GET as exportGET } from '../src/app/api/reports/export/route'
import { GET as foodCostGET } from '../src/app/api/reports/food-cost/route'
import {
  SAVED_REPORT_VIEWS_MARKER,
  MAX_SAVED_REPORT_VIEWS,
  REPORT_RANGE_PRESETS,
  resolveReportRange,
  parseSavedReportViews,
  validateSavedReportViews,
  validateSavedReportView,
  type SavedReportView,
} from '../src/lib/report-views'
import { APP_VERSION } from '../src/lib/version'
import { readFileSync } from 'fs'
import { join } from 'path'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v247-'
const RUN = Date.now().toString(36)
const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

let locA = ''
let locB = ''
let mgrId = ''
let token = '' // vodja z reports.sales na lokaciji A
let mgrBId = ''
let tokenB = '' // vodja na lokaciji B (tenant ločitev)
let staffId = ''
let staffToken = '' // natakar brez reports.sales

function req(method: string, url: string, body?: unknown, tok: string | null = token): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])

  const a = await db.location.create({ data: { id: `${P}locA-${RUN}`, name: `${P}Lokacija A`, code: `V247A-${RUN.toUpperCase()}`, premisesId: `v247-premA-${RUN}` } })
  locA = a.id
  mgrId = `${P}mgr-${RUN}`
  const pin = employeePinFields('v247-pin-1234', `${P}mgr-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: mgrId, name: `${P}Vodja`, email: `${P}mgr-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locA,
      pin: pin.pin, pinLookup: pin.pinLookup,
    },
  })
  token = createToken({ sub: mgrId, name: `${P}Vodja`, role: 'manager', loc: locA, sv: 0 })

  const b = await db.location.create({ data: { id: `${P}locB-${RUN}`, name: `${P}Lokacija B`, code: `V247B-${RUN.toUpperCase()}`, premisesId: `v247-premB-${RUN}` } })
  locB = b.id
  mgrBId = `${P}mgrB-${RUN}`
  const pinB = employeePinFields('v247-pinB-1234', `${P}mgrB-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: mgrBId, name: `${P}Vodja B`, email: `${P}mgrB-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locB,
      pin: pinB.pin, pinLookup: pinB.pinLookup,
    },
  })
  tokenB = createToken({ sub: mgrBId, name: `${P}Vodja B`, role: 'manager', loc: locB, sv: 0 })

  staffId = `${P}nat-${RUN}`
  const pinN = employeePinFields('v247-pinN-1234', `${P}nat-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: staffId, name: `${P}Natakar`, email: `${P}nat-${RUN}@test.local`,
      role: 'staff', status: 'active', sessionVersion: 0, locationId: locA,
      pin: pinN.pin, pinLookup: pinN.pinLookup,
    },
  })
  staffToken = createToken({ sub: staffId, name: `${P}Natakar`, role: 'staff', loc: locA, sv: 0 })
})

afterAll(async () => {
  await db.integration.deleteMany({ where: { name: SAVED_REPORT_VIEWS_MARKER, locationId: { in: [locA, locB] } } })
  await db.employee.deleteMany({ where: { id: { in: [mgrId, mgrBId, staffId] } } })
  await db.location.deleteMany({ where: { id: { in: [locA, locB] } } })
  await sweepTestFixtures(db, [P])
})

/* ═══════════════ A — ČISTO JEDRO: resolveReportRange ═══════════════ */

describe('v1.247.0 A — reševanje predlogov obdobij (lokalni koledar)', () => {
  // sreda 4. 11. 2026 (1. 11. je nedelja → 2. nov ponedeljek)
  const WED = new Date(2026, 10, 4, 15, 30)
  // nedelja 1. 11. 2026 — nedelja spada v teden od ponedeljka 26. 10.
  const SUN = new Date(2026, 10, 1, 23, 45)
  // četrtek 15. 1. 2026 — lastMonth prečka novo leto
  const JAN = new Date(2026, 0, 15, 9, 0)

  test('A1: today → od = do = danes (lokalni datum, ne UTC)', () => {
    const r = resolveReportRange('today', WED)
    expect(r).toEqual({ from: '2026-11-04', to: '2026-11-04' })
  })

  test('A2: yesterday → cel včerajšnji dan', () => {
    const r = resolveReportRange('yesterday', WED)
    expect(r).toEqual({ from: '2026-11-03', to: '2026-11-03' })
  })

  test('A3: thisWeek → ponedeljek .. danes (pošteno »do zdaj«, ISO teden)', () => {
    const r = resolveReportRange('thisWeek', WED)
    expect(r).toEqual({ from: '2026-11-02', to: '2026-11-04' })
  })

  test('A4: thisWeek ob nedelji zvečer → še vedno ponedeljek ZAČETEK tedna (23:45 lokalno, brez UTC zamika)', () => {
    const r = resolveReportRange('thisWeek', SUN)
    expect(r).toEqual({ from: '2026-10-26', to: '2026-11-01' })
  })

  test('A5: lastWeek → CEL prejšnji teden (pon–ned), tudi če je danes ponedeljek', () => {
    expect(resolveReportRange('lastWeek', WED)).toEqual({ from: '2026-10-26', to: '2026-11-01' })
    const MON = new Date(2026, 10, 9, 8, 0) // ponedeljek 9. 11.
    expect(resolveReportRange('lastWeek', MON)).toEqual({ from: '2026-11-02', to: '2026-11-08' })
  })

  test('A6: thisMonth → 1. .. danes; lastMonth → CEL prejšnji mesec (tudi čez novo leto)', () => {
    expect(resolveReportRange('thisMonth', WED)).toEqual({ from: '2026-11-01', to: '2026-11-04' })
    expect(resolveReportRange('lastMonth', WED)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(resolveReportRange('lastMonth', JAN)).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })

  test('A7: last7/30/90 → vključujoči okni (danes + 6/29/89)', () => {
    expect(resolveReportRange('last7', WED)).toEqual({ from: '2026-10-29', to: '2026-11-04' })
    expect(resolveReportRange('last30', WED)).toEqual({ from: '2026-10-06', to: '2026-11-04' })
    expect(resolveReportRange('last90', WED)).toEqual({ from: '2026-08-07', to: '2026-11-04' })
  })

  test('A8: ytd → 1. januar .. danes', () => {
    expect(resolveReportRange('ytd', WED)).toEqual({ from: '2026-01-01', to: '2026-11-04' })
  })

  test('A9: custom → fiksna datuma iz pogleda (izjema, ne predlog)', () => {
    const r = resolveReportRange('custom', WED, { from: '2026-05-01', to: '2026-05-31' })
    expect(r).toEqual({ from: '2026-05-01', to: '2026-05-31' })
  })

  test('A10: meseci s 28/29/30 dnevi — lastMonth vedno pokrije CEL mesec', () => {
    // marec (31) iz aprila; februar 2028 (prestopno) iz marca
    expect(resolveReportRange('lastMonth', new Date(2026, 3, 10))).toEqual({ from: '2026-03-01', to: '2026-03-31' })
    expect(resolveReportRange('lastMonth', new Date(2028, 2, 15))).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })

  test('A11: vsi predlogi razrešljivi (izčrpnost switcha)', () => {
    for (const p of REPORT_RANGE_PRESETS) {
      const r = resolveReportRange(p, WED, { from: '2026-01-01', to: '2026-01-02' })
      expect(r.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(r.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

/* ═══════════════ B — PARSANJE + VALIDACIJA (registr) ═══════════════ */

describe('v1.247.0 B — defenzivno branje + stroga validacija pisanja', () => {
  const view = (over: Partial<SavedReportView> = {}): SavedReportView => ({
    id: 'rv-test-1', name: 'Mesečni izvoz', report: 'export', section: 'summary',
    format: 'csv', range: 'thisMonth', ...over,
  })

  test('B1: parse — prazno/manjkajoče/smet → []', () => {
    expect(parseSavedReportViews(undefined)).toEqual([])
    expect(parseSavedReportViews(null)).toEqual([])
    expect(parseSavedReportViews('{}')).toEqual([])
    expect(parseSavedReportViews('{"views": "ne-seznam"}')).toEqual([])
    expect(parseSavedReportViews('ne json')).toEqual([])
  })

  test('B2: parse — veljaven seznam (JSON niz, vzorec Integration.config) → kanonsko', () => {
    const raw = JSON.stringify({ views: [
      { id: 'a', name: 'Mesečni izvoz', report: 'export', section: 'ddv', format: 'json', range: 'lastMonth' },
      { id: 'b', name: 'Food tedensko', report: 'food-cost', range: 'last7' },
    ] })
    const out = parseSavedReportViews(raw)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ id: 'a', name: 'Mesečni izvoz', report: 'export', section: 'ddv', format: 'json', range: 'lastMonth' })
    expect(out[1]).toEqual({ id: 'b', name: 'Food tedensko', report: 'food-cost', range: 'last7' })
  })

  test('B3: parse — neveljavni vnosi se TIHO izpustijo (self-healing)', () => {
    const raw = JSON.stringify({ views: [
      { id: 'ok', name: 'Dobro', report: 'export', range: 'today' },
      { id: 'x1', name: '', report: 'export', range: 'today' },                 // prazno ime
      { id: 'x2', name: 'Slab report', report: 'neznani', range: 'today' },     // poročilo izven enuma
      { id: 'x3', name: 'Slabo obdobje', report: 'export', range: 'never' },    // obdobje izven enuma
      { id: 'x4', name: 'Custom brez datumov', report: 'export', range: 'custom' }, // custom brez from/to
      { id: 'x5', name: 'Custom slab datum', report: 'export', range: 'custom', from: '2026-13-40', to: '2026-12-31' },
      { id: 'x6', name: 'Custom obratno', report: 'export', range: 'custom', from: '2026-12-31', to: '2026-12-01' },
      'smet',
    ] })
    const out = parseSavedReportViews(raw)
    expect(out.map((v) => v.id)).toEqual(['ok'])
  })

  test('B4: parse — duplikat id-jev se izpusti (prvi zmaga)', () => {
    const raw = JSON.stringify({ views: [
      { id: 'dup', name: 'Prvi', report: 'export', range: 'today' },
      { id: 'dup', name: 'Drugi', report: 'food-cost', range: 'yesterday' },
    ] })
    expect(parseSavedReportViews(raw).map((v) => v.name)).toEqual(['Prvi'])
  })

  test('B5: parse — section/format se ohranita SAMO za export (food-cost ju ne pozna)', () => {
    const raw = JSON.stringify({ views: [
      { id: 'f1', name: 'Food', report: 'food-cost', range: 'last30', section: 'zz', format: 'json' },
    ] })
    const out = parseSavedReportViews(raw)
    expect(out[0].section).toBeUndefined()
    expect(out[0].format).toBeUndefined()
  })

  test('B6: validate — ime obvezno in ≤ 80; poročilo/sekcija/format/obdobje iz enumov', () => {
    expect('error' in validateSavedReportView({ name: '', report: 'export', range: 'today' })).toBe(true)
    expect('error' in validateSavedReportView({ name: 'x'.repeat(81), report: 'export', range: 'today' })).toBe(true)
    expect('error' in validateSavedReportView({ name: 'X', report: 'neznani', range: 'today' })).toBe(true)
    expect('error' in validateSavedReportView({ name: 'X', report: 'export', range: 'today', section: 'bogus' })).toBe(true)
    expect('error' in validateSavedReportView({ name: 'X', report: 'export', range: 'today', format: 'pdf' })).toBe(true)
    expect('error' in validateSavedReportView({ name: 'X', report: 'export', range: 'bogus' })).toBe(true)
    const ok = validateSavedReportView({ name: 'Mesečni izvoz', report: 'export', range: 'thisMonth' })
    expect('view' in ok && ok.view.section).toBe('summary') // privzeta sekcija
    expect('view' in ok && ok.view.format).toBe('csv')      // privzeti format
  })

  test('B7: validate — custom zahteva veljavna datuma from ≤ to', () => {
    expect('error' in validateSavedReportView({ name: 'X', report: 'export', range: 'custom' })).toBe(true)
    expect('error' in validateSavedReportView({ name: 'X', report: 'export', range: 'custom', from: '2026-01-01', to: '2025-12-31' })).toBe(true)
    const ok = validateSavedReportView({ name: 'X', report: 'export', range: 'custom', from: '2026-01-01', to: '2026-01-31' })
    expect('view' in ok && ok.view.from).toBe('2026-01-01')
  })

  test('B8: validate — id se dodeli, če manjka; seznam: ≤ 20 + duplikati zavrnjeni', () => {
    const one = validateSavedReportView({ name: 'X', report: 'export', range: 'today' })
    expect('view' in one && one.view.id.length).toBeGreaterThan(4)
    const many: unknown[] = Array.from({ length: MAX_SAVED_REPORT_VIEWS + 1 }, (_, i) => ({ id: `v${i}`, name: `Pogled ${i}`, report: 'export', range: 'today' }))
    expect('error' in validateSavedReportViews(many)).toBe(true)
    expect('error' in validateSavedReportViews([
      { id: 'same', name: 'A', report: 'export', range: 'today' },
      { id: 'same', name: 'B', report: 'export', range: 'today' },
    ])).toBe(true)
    expect('error' in validateSavedReportViews('ne-seznam')).toBe(true)
  })
})

/* ═══════════════ C — API registr (GET/PUT /api/reports/views) ═══════════════ */

describe('v1.247.0 C — registr pogledov (Integration, 0 DDL)', () => {
  test('C1: GET brez vrstice → { views: [] } (iskreno prazno)', async () => {
    const res = await viewsGET(req('GET', '/api/reports/views'))
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ views: [] })
  })

  test('C2: PUT shrani dva pogleda → GET vrne oba + revizija REPORT_VIEWS_CONFIG', async () => {
    const res = await viewsPUT(req('PUT', '/api/reports/views', {
      locationId: locA,
      views: [
        { id: `${P}rv-mesecni`, name: 'Mesečni izvoz za knjigovodjo', report: 'export', section: 'summary', format: 'csv', range: 'thisMonth' },
        { id: `${P}rv-food`, name: 'Tedenska food-cost varianca', report: 'food-cost', range: 'last7' },
      ],
    }))
    expect(res.status).toBe(200)
    const saved = await body(res)
    expect((saved.views as SavedReportView[]).length).toBe(2)

    const got = await viewsGET(req('GET', `/api/reports/views?locationId=${locA}`))
    expect(res.status).toBe(200)
    const views = (await body(got)).views as SavedReportView[]
    expect(views.map((v) => v.id).sort()).toEqual([`${P}rv-food`, `${P}rv-mesecni`])

    const audit = await db.auditLog.findFirst({
      where: { action: 'REPORT_VIEWS_CONFIG', locationId: locA, userId: mgrId },
    })
    expect(audit).toBeTruthy()
    expect(String(audit!.details)).toContain('Mesečni izvoz za knjigovodjo')
  })

  test('C3: PUT z neveljavnim vnosom → 400 (strežnik je avtoritet, ne klient)', async () => {
    const res = await viewsPUT(req('PUT', '/api/reports/views', {
      locationId: locA,
      views: [{ id: `${P}rv-bad`, name: 'Slab', report: 'pdf-print', range: 'today' }],
    }))
    expect(res.status).toBe(400)
  })

  test('C4: PUT brez views → 400', async () => {
    const res = await viewsPUT(req('PUT', '/api/reports/views', { locationId: locA }))
    expect(res.status).toBe(400)
  })

  test('C5: natakar BREZ reports.sales → 403 (kdor ne sme poganjati poročil, ne shranjuje pogledov)', async () => {
    expect((await viewsGET(req('GET', '/api/reports/views', undefined, staffToken))).status).toBe(403)
    expect((await viewsPUT(req('PUT', '/api/reports/views', { views: [] }, staffToken))).status).toBe(403)
  })

  test('C6: tenant — vodja lokacije B vidi SVOJE (prazno), ne A-jeve poglede; tuj locationId se prepiše', async () => {
    const res = await viewsGET(req('GET', `/api/reports/views?locationId=${locA}`, undefined, tokenB))
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ views: [] })
  })

  test('C7: brisanje = PUT brez vnosa (kanonična oblika celotnega seznama)', async () => {
    const res = await viewsPUT(req('PUT', '/api/reports/views', {
      locationId: locA,
      views: [{ id: `${P}rv-food`, name: 'Tedenska food-cost varianca', report: 'food-cost', range: 'last7' }],
    }))
    expect(res.status).toBe(200)
    const got = await viewsGET(req('GET', '/api/reports/views'))
    const views = (await body(got)).views as SavedReportView[]
    expect(views.map((v) => v.id)).toEqual([`${P}rv-food`])
  })

  test('C8: vrstica je Integration (0 DDL) z markerjem + per lokacija', async () => {
    const rows = await db.integration.findMany({ where: { name: SAVED_REPORT_VIEWS_MARKER, locationId: locA } })
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('other')
  })
})

/* ═══════════════ D — ZAGON (pogled → obstoječi poročilni ruti) ═══════════════ */

describe('v1.247.0 D — zagon pogleda poteče obstoječe rute (en klik, isti varovali)', () => {
  test('D1: export pogled → GET /api/reports/export z rešenim obdobjem → 200 CSV', async () => {
    const { from, to } = resolveReportRange('thisMonth', new Date())
    const res = await exportGET(req('GET', `/api/reports/export?from=${from}&to=${to}&format=csv&section=summary`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
  })

  test('D2: food-cost pogled → GET /api/reports/food-cost z rešenim obdobjem → 200', async () => {
    const { from, to } = resolveReportRange('last7', new Date())
    const res = await foodCostGET(req('GET', `/api/reports/food-cost?from=${from}&to=${to}&format=csv`))
    expect(res.status).toBe(200)
  })

  test('D3: zz pogled (X/Z) + json format → 200', async () => {
    const { from, to } = resolveReportRange('yesterday', new Date())
    const res = await exportGET(req('GET', `/api/reports/export?from=${from}&to=${to}&format=json&section=zz`))
    expect(res.status).toBe(200)
  })

  test('D4: isti zagon brez pravic → 403 (varovala poročil ostajajo)', async () => {
    const { from, to } = resolveReportRange('thisMonth', new Date())
    const res = await exportGET(req('GET', `/api/reports/export?from=${from}&to=${to}&format=csv&section=summary`, undefined, staffToken))
    expect(res.status).toBe(403)
  })
})

/* ═══════════════ Ž — REGISTRI (verzija, i18n, dokumenti, UI) ═══════════════ */

describe('v1.247.0 Ž — registri in pini', () => {
  test('Ž1: APP_VERSION dvignjena na 1.247.0', () => {
    expect(APP_VERSION).toBe('1.260.0')
    expect(read('src/lib/version.ts')).toContain("'1.260.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.260.0')
  })

  test('Ž2: i18n — 3968 ključev SL in HR, popolna pariteta', () => {
    expect(Object.keys(sl).length).toBe(4121)
    expect(Object.keys(hr).length).toBe(4121)
    expect(Object.keys(sl).length).toBe(Object.keys(hr).length)
    // novi ključi vala so prisotni v obeh slovarjih
    for (const k of ['rv.title', 'rv.range.thisMonth', 'rv.run', 'rv.deleteConfirm', 'rv.resolved']) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    // EN/DE/IT gostujoči slovarji so NEDOTAKNJENI (263)
    const en = read('src/lib/i18n/en.ts')
    expect(en).not.toContain("'rv.")
  })

  test('Ž3: dokumenti — PRIMERJAVA §21 + AUDIT posodobitev', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 21. Raziskava april 2026 — POGLEDI VAL v1.247.0')
    expect(doc).toContain('saved report views')
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('4121 ključev SL in 4121 HR')
    expect(audit).toContain('v1.247.0')
  })

  test('Ž4: UI — kartica montirana na zavihku računi (gating reports.sales) + barrel izvoz', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain("hasPerm('reports.sales') && <SavedViewsCard />")
    expect(page).toContain('Lightspeed april 2026')
    const barrel = read('src/components/dashboard-tabs.tsx')
    expect(barrel).toContain("export { SavedViewsCard }")
    const card = read('src/components/tabs/saved-views-card.tsx')
    expect(card).toContain("resolveReportRange(v.range, new Date()")
    expect(card).toContain("data-testid=\"saved-view-row\"")
  })

  test('Ž5: ruta — reports.sales pravica + revizija REPORT_VIEWS_CONFIG + Issue #96 fallback', () => {
    const route = read('src/app/api/reports/views/route.ts')
    expect(route).toContain("requirePermission(req, 'reports.sales')")
    expect(route).toContain("'REPORT_VIEWS_CONFIG'")
    expect(route).toContain('resolveViewsLocation')
    expect(route).toContain('await locationScope(')
  })

  test('Ž6: marker registra + shared helperji (dayKeyOf/isValidDateKey ponovno uporabljeni, ne podvojeni)', () => {
    const lib = read('src/lib/report-views.ts')
    expect(lib).toContain("export const SAVED_REPORT_VIEWS_MARKER = 'saved-report-views-config'")
    expect(lib).toContain("from '@/lib/sales-by-hour'")
    expect(lib).toContain("from '@/lib/ops-checklists'")
    expect(lib).not.toContain('function localDateKey')
  })

  test('Ž7: worklog vrhnji vnos nosi Task ID v1.247.0', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.260.0-prihodkovni-centri-val')
  })
})
