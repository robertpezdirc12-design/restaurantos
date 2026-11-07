import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as tipsGET, POST as tipsPOST } from '../src/app/api/tips/route'
import { APP_VERSION } from '../src/lib/version'

/**
 * UPORABNIŠKI QA VAL #7 — NEPREKRITE ZAVIHKI (v1.228.0).
 *
 * Val je nastal iz E2E pregleda zavihkov, ki v valovih #1–#6 niso bili izrecno
 * odprti kot lastnik: Napitnine, Prenosi, Dostava, Mnenja, Odnosi z gosti,
 * Integracije, Obračun, Darilne kartice, Analiza menija (agent-browser, živi
 * dev :3000, SQLite demo baza).
 *
 * NAJDBA #1 (P1 — ZAVIHEK NAPITNINE SE ZRUŠI): odprtje zavihka Napitnine je
 * padlo v ErrorBoundary »Ups — prišlo je do napake« (Next.js issues overlay).
 * Vzrok (izmerjeno v logu): TypeError: d.hoursWorked.toFixed is not a function
 * v backoffice-tab.tsx — GET /api/tips je vracal TipDistribution vrstice
 * NARAVNO iz Prisme, kjer so hoursWorked/points/amount Decimal stolpci, ki se
 * v JSON serializirajo kot NIZI (»8.5«); UI tip je obljubljal number in klical
 * .toFixed(2) — niz nima toFixed. POPRAVEK (dvojno):
 *   - STREŽNIK src/app/api/tips/route.ts: bazen se preslika v številke pred
 *     odgovorom (hoursWorked/points/amount + totalTips/cashTips/cardTips) —
 *     ista disciplina kot že obstoječa `history` preslikava;
 *   - UI backoffice-tab.tsx: Number() toleranca + fmtNumSI.
 *
 * NAJDBA #2 (P3 — mešani decimalni ločili v isti vrstici): ure v tabeli
 * distribucij so se izrisale s PIKO (toFixed: »0.08 h«) neposredno ob znesku
 * z VEJICO (fmtEUR sl-SI: »0,50 €«). POPRAVEK: fmtNumSI (sl-SI vejica,
 * issue #71 audit-12 disciplina »ena funkcija = ena oblika«) → »0,08 h«.
 *
 * E2E DOKAZ (demo profil, lastnik Franc): Napitnine po popravku izrišejo
 * kartice bazena (gotovina 0,50 € / kartice 0,00 € / plačila 1), tabelo
 * distribucij »Marko Natakar | 0,08 h | 0,50 € | čaka | Označi izplačano«,
 * zgodovino bazenov »0/1 izplačano« — 0 ErrorBoundary; vsi ostali zavihki
 * vala (Prenosi, Dostava, Mnenja, Odnosi, Integracije, Obračun, Darilne,
 * Analiza menija) se izrišejo brez napak; v logu 0 novih neujetih izjem.
 *
 * Tu je zapečaten popravek (vedenjsko: GET vrne številke tudi za obstoječi
 * bazen iz Decimal stolpcev) + statika UI + verzija.
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const PREFIX = 'v225-'
const RUN = Date.now().toString(36)

let locId = ''
let adminId = ''
let adminToken = ''
let empId = ''

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

async function cleanup() {
  await sweepTestFixtures(db, [PREFIX])
}

beforeAll(async () => {
  await cleanup()
  locId = `${PREFIX}loc-${RUN}`
  await db.location.create({
    data: {
      id: locId, name: `${PREFIX}Lokacija`, code: `V225${RUN.toUpperCase().slice(-6)}`,
      premisesId: `BLGV225${RUN.toUpperCase().slice(-5)}`, country: 'SI',
      registerNumber: 'BLG-225', fursEnvironment: 'simulation', currency: 'EUR', timezone: 'Europe/Ljubljana',
    },
  })
  adminId = `${PREFIX}admin-${RUN}`
  const pin = employeePinFields(`7${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locId, ...pin },
  })
  adminToken = createToken({ sub: adminId, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locId, sv: 0 })
  empId = `${PREFIX}emp-${RUN}`
  const empPin = employeePinFields(`8${RUN.slice(-5)}`, `${PREFIX}emp-${RUN}@test.local`)
  await db.employee.create({
    data: { id: empId, name: `${PREFIX}Zaposleni`, email: `${PREFIX}emp-${RUN}@test.local`, role: 'waiter', status: 'active', sessionVersion: 0, locationId: locId, ...empPin },
  })
})

afterAll(async () => {
  await cleanup()
})

const DAY = '2026-11-01'

/* ── Č1 · #1 — odgovor GET /api/tips ima PRAVE številke, ne nizov ───────── */

describe('v225 Č1 · Napitnine — Decimal serializacija ne more več zrušiti UI', () => {
  test('GET: bazen iz DB (Decimal stolpci) vrne hoursWorked/points/amount kot number', async () => {
    // plačilo z napitnino + ure v dnevu → POST zaključi bazen → GET prebere IZ DB
    const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locId } })
    const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
    const mi = await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: `${PREFIX}Artikel`, price: 10, categoryId: cat.id } })
    const orderId = `${PREFIX}o-${RUN}`
    await db.order.create({
      data: { id: orderId, orderNumber: 974500, locationId: locId, status: 'open', paymentStatus: 'unpaid', type: 'dine-in', subtotal: 8.20, tax: 1.80, total: 10, employeeId: adminId },
    })
    await db.orderItem.create({
      data: { id: `${PREFIX}it-${RUN}`, orderId, menuItemId: mi.id, menuItemName: `${PREFIX}Artikel`, quantity: 1, price: 10, vatRate: 22, vatAmount: 1.80, status: 'served' },
    })
    const check = await db.check.create({ data: { id: `${PREFIX}chk-${RUN}`, orderId, checkNumber: 1, subtotal: 10, total: 10, paymentStatus: 'paid' } })
    await db.payment.create({
      data: { id: `${PREFIX}pay-${RUN}`, checkId: check.id, type: 'cash', amount: 10, tipAmount: 3, status: 'completed', employeeId: empId, createdAt: new Date(`${DAY}T12:00:00Z`) },
    })
    // 90 minut ure v istem dnevu (osnova za delitev po urah)
    await db.timeEntry.create({
      data: { id: `${PREFIX}te-${RUN}`, employeeId: empId, clockIn: new Date(`${DAY}T10:00:00Z`), clockOut: new Date(`${DAY}T11:30:00Z`), breakMinutes: 0 },
    })

    const closed = await tipsPOST(req('/api/tips', adminToken, 'POST', { date: DAY, locationId: locId, method: 'hours' }))
    expect(closed.status).toBe(201)

    const res = await tipsGET(req(`/api/tips?date=${DAY}&locationId=${locId}&method=hours`, adminToken))
    expect(res.status).toBe(200)
    const j = (await res.json()) as {
      pool: { totalTips: unknown; cashTips: unknown; cardTips: unknown; TipDistribution: { hoursWorked: unknown; points: unknown; amount: unknown }[] } | null
    }
    expect(j.pool).not.toBeNull()
    // JEDRO POPRAVKA: vse vrednosti so PRAVI number (ne nizi iz Decimal serializacije)
    expect(typeof j.pool!.totalTips).toBe('number')
    expect(typeof j.pool!.cashTips).toBe('number')
    expect(typeof j.pool!.cardTips).toBe('number')
    expect(j.pool!.TipDistribution.length).toBe(1)
    for (const d of j.pool!.TipDistribution) {
      expect(typeof d.hoursWorked).toBe('number')
      expect(typeof d.points).toBe('number')
      expect(typeof d.amount).toBe('number')
    }
    // vrednosti ostanejo pravilne: 3,00 € napitnine, 1,5 h osnove
    expect(j.pool!.totalTips).toBe(3)
    expect(j.pool!.TipDistribution[0].hoursWorked).toBe(1.5)
    expect(j.pool!.TipDistribution[0].amount).toBe(3)
    // .toFixed(2) — točen izraz, ki je prej padel — zdaj obstaja na vrednostih iz API-ja
    expect((j.pool!.TipDistribution[0].hoursWorked as number).toFixed(2)).toBe('1.50')
  })

  test('statika: strežnik preslika bazen v številke PRED odgovorom (num preslikava)', () => {
    const src = read('src/app/api/tips/route.ts')
    expect(src).toContain('hoursWorked: num(d.hoursWorked)')
    expect(src).toContain('amount: num(d.amount)')
    expect(src).toContain('totalTips: num(pool.totalTips)')
    // odgovor nosi normaliziran bazen, ne surove Prisma vrstice
    expect(src).toContain('pool: poolNormalized')
  })

  test('statika: UI ne kliče več toFixed na podatku iz API-ja (obrambna Number toleranca)', () => {
    const src = read('src/components/tabs/backoffice-tab.tsx')
    // hroščati vzorec mora biti ODSOTEN (toFixed na more-bitnem nizu)
    expect(src).not.toContain('d.hoursWorked.toFixed')
    expect(src).not.toContain('d.points.toFixed')
  })
})

/* ── Č2 · #2 — enoten decimalni ločilec (sl-SI vejica) ──────────────────── */

describe('v225 Č2 · ure v distribucijah nosijo sl-SI vejico kot sosednji zneski', () => {
  test('fmtNumSI z unit » h« nadomesti toFixed piko', () => {
    const src = read('src/components/tabs/backoffice-tab.tsx')
    expect(src).toContain("fmtNumSI(Number(d.hoursWorked), { max: 2, unit: ' h' })")
  })

  test('točke v isti celici gredo čez Number() toleranco (ne raw Primerja niza)', () => {
    const src = read('src/components/tabs/backoffice-tab.tsx')
    expect(src).toContain('Number(d.points) > 0')
    // QA-val v1.268.0: predloga payment.pointsOf je zdaj »{n} {w}« — klic teče
    // prek tN (množinska oblika po števniku), Number() toleranca OHRANJENA.
    expect(src).toContain("tN('payment.pointsOf', 'tocka', Number(d.points))")
  })
})

/* ── verzija ───────────────────────────────────────────────────────────── */

describe('v225 Č · verzija + dokumentacija', () => {
  test('verzija je dvignjena na 1.238.0 (version.ts)', () => {
    expect(APP_VERSION).toBe('1.273.0')
    expect(read('src/lib/version.ts')).toContain("'1.273.0'")
  })

  test('compose oznaka slike sledi verziji (selfhost pogodba)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('image: restaurantos:1.273.0')
  })

  test('PRD nosi zapis QA-vala v1.227.0 (doc-truth)', () => {
    expect(read('docs/PRD-LOKALNA-BAZA.md')).toContain('QA-val v1.227.0')
  })

  test('worklog vnos na vrhu (Task ID: v1.228.0)', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.273.0-diakritike-izvoz-api')
    expect(wl.indexOf('Task ID: v1.227.0')).toBeLessThan(wl.indexOf('Task ID: v1.224.0'))
  })
})
