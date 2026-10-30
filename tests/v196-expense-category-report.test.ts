import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import { resetExpenseCategoriesProbe } from '../src/lib/expenses-categories'
import { expenseCategoryBreakdown } from '../src/lib/accounting-portal'
import { GET as expensesGET } from '../src/app/api/expenses/route'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * N-27-2 (v1.196.0) — KATEGORIJE STROŠKOV: poročilo + filter v knjigovodskem
 * portalu (docs/TRZNA-VRZELI-2027.md §2A).
 *
 * Stanje pred valom: CRUD kategorij je runtime-gated že od v1.64/1.65 (Task
 * 66/67 — DDL konzola + probe + raw pisanje; main schema polja namenoma ne
 * pozna, Faza C' čaka lastnikov DDL klik na produkciji); UI Stroškov že ima
 * vnos/filtriranje/urejanje. Manjkalo je točno to, kar N-27-2 obseg imenuje:
 *  - POROČILO po kategorijah (čisti sloj expenseCategoryBreakdown),
 *  - FILTER v knjigovodskem portalu (GET /api/expenses?category= + KPI zožitev).
 *
 * Merila:
 *  Č1 čisti sloj (PURE, brez IO): skupanje po kategoriji, '' → 'OSTALO' (isti
 *     legacy fallback kot GET vrstica), r2 zneski, sort total desc + ime asc,
 *     outstanding = total − paid, prazen vnos → prazen izvid.
 *  Č2 backend GET /api/expenses:
 *     - 401 brez žetona, 403 brez reports.sales (waiter);
 *     - z obdobjem: categoryBreakdown nad CELO periodo (obseg prek tipizirane
 *       poizvedbe — tuja lokacija NI šteta, P0), periodTotal ostane celoten
 *       (v1.189.0 pini ostanejo);
 *     - ?category=Hrana: seznam in agregat ZOŽENA na kategorijo (tuja
 *       lokacija izključena), breakdown ostane nad celotno periodo;
 *     - ?category= brez obdobja: filtriran seznam, brez agregatov/breakdown;
 *     - neznana kategorija: prazen seznam, count 0 (ne napaka);
 *     - prazen ?category= = stara pot (nespremenjen odgovor);
 *     - probe false + ?category → 503 (eksplicitna zahteva po funkciji, ki
 *       čaka DDL — ne tiho ignoriranje).
 *  Č3 UI statika: read-only invarianta ostane (brez mutacij), izbira
 *     kategorije + razčlenitev črpa iz API odgovora (brez lokalnega duplikata).
 *  Č4 i18n pariteta novih ključev + verzija pin.
 *
 * ID-ji s predpono `v196ec-` (sweep beforeAll + afterAll). Kategorija se
 * seeda prek tagged-template raw (stolpec ni v tipizirani shemi — Task 66
 * vzorec; tagged template parametrizira na obeh dialektih).
 */

const PREFIX = 'v196ec-'
const RUN = Date.now().toString(36)

let locA = ''
let locB = ''
let mgrAToken = ''
let waiterToken = ''

function req(url: string, token: string | null): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

let apSeq = 0
async function seedAp(locationId: string, invoiceDate: Date, total: number, paid: number, category: string): Promise<void> {
  apSeq += 1
  const id = `${PREFIX}ap${apSeq}-${RUN}`
  await db.accountsPayable.create({
    data: {
      id,
      apNumber: `AP-V196-${RUN.toUpperCase()}-${apSeq}`,
      supplierId: SUPPLIER_ID,
      invoiceNumber: `${PREFIX}Strosek ${apSeq}`,
      invoiceDate,
      dueDate: new Date(invoiceDate.getTime() + 30 * 24 * 3600 * 1000),
      subtotal: total,
      totalAmount: total,
      paidAmount: paid,
      locationId,
    },
  })
  if (category) {
    await db.$executeRaw`UPDATE "AccountsPayable" SET "category" = ${category} WHERE "id" = ${id}`
  }
}

// dobavitelj je skupen (Supplier ni lokacijski) — id nastavljen v beforeAll
let SUPPLIER_ID = ''

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])

  locA = (await db.location.create({
    data: { id: `${PREFIX}locA-${RUN}`, name: `${PREFIX}Lokacija A`, code: `V196A-${RUN.toUpperCase()}` },
  })).id
  locB = (await db.location.create({
    data: { id: `${PREFIX}locB-${RUN}`, name: `${PREFIX}Lokacija B`, code: `V196B-${RUN.toUpperCase()}` },
  })).id

  SUPPLIER_ID = (await db.supplier.create({
    data: { id: `${PREFIX}dob-${RUN}`, name: `${PREFIX}Dobavitelj`, code: `V196D-${RUN.toUpperCase()}` },
  })).id

  // Obdobje: 2026-01-10 .. 2026-01-20 (fiksen, determinističen)
  //  locA: 3 v periodi — Hrana 100/40, Pijača 50/50, brez kategorije 25.5/0
  //        + 1 izven periode (Orodje 9/9)
  //  locB: 1 v periodi (Hrana 777/0) — NE sme se šteti v obsegu managerja A
  await seedAp(locA, new Date('2026-01-05T12:00:00'), 9, 9, 'Orodje')   // izven periode
  await seedAp(locA, new Date('2026-01-12T12:00:00'), 100, 40, 'Hrana')
  await seedAp(locA, new Date('2026-01-15T12:00:00'), 50, 50, 'Pijača')
  await seedAp(locA, new Date('2026-01-18T12:00:00'), 25.5, 0, '')
  await seedAp(locB, new Date('2026-01-14T12:00:00'), 777, 0, 'Hrana')

  const email = `${PREFIX}mgrA-${RUN}@test.local`
  const fields = employeePinFields(`7${RUN.slice(-5)}`, email)
  const mgrA = await db.employee.create({
    data: {
      id: `${PREFIX}mgrA-${RUN}`, name: `${PREFIX}Vodja A`, email,
      role: 'MANAGER', status: 'active', sessionVersion: 0, locationId: locA, ...fields,
    },
  })
  const wFields = employeePinFields(`5${RUN.slice(-5)}`, `${PREFIX}waiter-${RUN}@test.local`)
  const waiter = await db.employee.create({
    data: {
      id: `${PREFIX}waiter-${RUN}`, name: `${PREFIX}Natakar`, email: `${PREFIX}waiter-${RUN}@test.local`,
      role: 'WAITER', status: 'active', sessionVersion: 0, locationId: locA, ...wFields,
    },
  })

  mgrAToken = createToken({ sub: mgrA.id, name: mgrA.name, role: 'MANAGER', loc: locA, sv: 0 })
  waiterToken = createToken({ sub: waiter.id, name: waiter.name, role: 'WAITER', loc: locA, sv: 0 })
})

afterAll(async () => {
  resetExpenseCategoriesProbe() // probe nazaj na dev resnico (če je test vsilil false)
  await sweepTestFixtures(db, [PREFIX])
})

/* ───────────────────────── Č1 — čisti sloj ───────────────────────── */

describe('N-27-2 — čisti sloj expenseCategoryBreakdown (pure, brez IO)', () => {
  test('prazen vnos → prazen izvid', () => {
    expect(expenseCategoryBreakdown([])).toEqual([])
  })

  test('skupanje po kategoriji: count/total/paid/outstanding + r2 na 2 decimalki', () => {
    const rows = expenseCategoryBreakdown([
      { category: 'Hrana', amount: 60.1, paidAmount: 10 },
      { category: 'Hrana', amount: 40.2, paidAmount: 30 },
      { category: 'Pijača', amount: 50, paidAmount: 50 },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ category: 'Hrana', count: 2, total: 100.3, paid: 40, outstanding: 60.3 })
    expect(rows[1]).toEqual({ category: 'Pijača', count: 1, total: 50, paid: 50, outstanding: 0 })
  })

  test("prazna/nevidna kategorija se skupi pod 'OSTALO' (isti legacy fallback kot GET vrstica)", () => {
    const rows = expenseCategoryBreakdown([
      { category: '', amount: 25.5, paidAmount: 0 },
      { category: '   ', amount: 4.5, paidAmount: 0 },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe('OSTALO')
    expect(rows[0].count).toBe(2)
    expect(rows[0].total).toBe(30)
  })

  test('sort: total padajoče, izenačeno po imenu (sl locale)', () => {
    const rows = expenseCategoryBreakdown([
      { category: 'Ambalaža', amount: 100, paidAmount: 0 },
      { category: 'Hrana', amount: 100, paidAmount: 0 },
      { category: 'Pijača', amount: 200, paidAmount: 0 },
    ])
    expect(rows.map((r) => r.category)).toEqual(['Pijača', 'Ambalaža', 'Hrana'])
  })
})

/* ───────────────────────── Č2 — backend GET /api/expenses ───────────────────────── */

const Q = 'from=2026-01-10&to=2026-01-20'

interface BdRow { category: string; count: number; total: number; paid: number; outstanding: number }
interface ExpOut {
  expenses: { id: string; category: string; amount: number }[]
  periodTotal?: number
  periodPaid?: number
  periodCount?: number
  categoriesEnabled: boolean
  categoryBreakdown?: BdRow[]
}

describe('N-27-2 — GET /api/expenses: kategorije', () => {
  test('401 brez žetona', async () => {
    const res = await expensesGET(req(`/api/expenses?${Q}`, null))
    expect(res.status).toBe(401)
  })

  test('403 brez reports.sales (waiter)', async () => {
    const res = await expensesGET(req(`/api/expenses?${Q}&category=Hrana`, waiterToken))
    expect(res.status).toBe(403)
  })

  test('z obdobjem brez kategorije: categoryBreakdown nad celotno periodo (tuja lokacija NI šteta), periodTotal ostane celoten', async () => {
    const res = await expensesGET(req(`/api/expenses?${Q}`, mgrAToken))
    expect(res.status).toBe(200)
    const d = (await res.json()) as ExpOut
    // v1.189.0 pini ostanejo (obseg locA: 3 v periodi)
    expect(d.periodCount).toBe(3)
    expect(d.periodTotal).toBe(175.5)
    expect(d.periodPaid).toBe(90)
    expect(d.expenses).toHaveLength(3)
    // N-27-2: breakdown — locB Hrana (777) IZKLJUČENA iz obsega (P0 disciplina)
    expect(d.categoryBreakdown).toBeDefined()
    expect(d.categoryBreakdown!.map((c) => c.category)).toEqual(['Hrana', 'Pijača', 'OSTALO'])
    expect(d.categoryBreakdown![0]).toEqual({ category: 'Hrana', count: 1, total: 100, paid: 40, outstanding: 60 })
    expect(d.categoryBreakdown![1]).toEqual({ category: 'Pijača', count: 1, total: 50, paid: 50, outstanding: 0 })
    expect(d.categoryBreakdown![2]).toEqual({ category: 'OSTALO', count: 1, total: 25.5, paid: 0, outstanding: 25.5 })
  })

  test('?category=Hrana: seznam in agregat ZOŽENA na kategorijo (tuja lokacija izključena), breakdown ostane nad celotno periodo', async () => {
    const res = await expensesGET(req(`/api/expenses?${Q}&category=Hrana`, mgrAToken))
    expect(res.status).toBe(200)
    const d = (await res.json()) as ExpOut
    // locB Hrana (777) NE sme priti ne v seznam ne v agregat
    expect(d.expenses).toHaveLength(1)
    expect(d.expenses[0].category).toBe('Hrana')
    expect(d.expenses[0].amount).toBe(100)
    expect(d.periodCount).toBe(1)
    expect(d.periodTotal).toBe(100)
    expect(d.periodPaid).toBe(40)
    // navigacija: breakdown ostane nad CELO periodo (vse 3 kategorije)
    expect(d.categoryBreakdown).toHaveLength(3)
  })

  test('?category= brez obdobja: filtriran seznam (tudi izven periode), brez agregatov/breakdown', async () => {
    const res = await expensesGET(req('/api/expenses?category=Orodje', mgrAToken))
    expect(res.status).toBe(200)
    const d = (await res.json()) as ExpOut
    expect(d.expenses).toHaveLength(1)
    expect(d.expenses[0].category).toBe('Orodje')
    expect('periodTotal' in d).toBe(false)
    expect('categoryBreakdown' in d).toBe(false)
  })

  test('neznana kategorija: prazen seznam + count 0 (ne napaka)', async () => {
    const res = await expensesGET(req(`/api/expenses?${Q}&category=Neznana`, mgrAToken))
    expect(res.status).toBe(200)
    const d = (await res.json()) as ExpOut
    expect(d.expenses).toHaveLength(0)
    expect(d.periodCount).toBe(0)
    expect(d.periodTotal).toBe(0)
  })

  test('prazen ?category= = stara pot (nespremenjen odgovor z breakdown)', async () => {
    const res = await expensesGET(req(`/api/expenses?${Q}&category=`, mgrAToken))
    expect(res.status).toBe(200)
    const d = (await res.json()) as ExpOut
    expect(d.expenses).toHaveLength(3)
    expect(d.periodCount).toBe(3)
    expect(d.categoryBreakdown).toHaveLength(3)
  })

  test('probe false + ?category → 503 (eksplicitna zahteva po funkciji, ki čaka DDL)', async () => {
    resetExpenseCategoriesProbe(false)
    try {
      const res = await expensesGET(req(`/api/expenses?${Q}&category=Hrana`, mgrAToken))
      expect(res.status).toBe(503)
      const j = (await res.json()) as { error: string }
      expect(j.error).toContain('stroski-kategorije')
    } finally {
      resetExpenseCategoriesProbe()
    }
    // po resetu dev resnica spet dela
    const okRes = await expensesGET(req(`/api/expenses?${Q}&category=Hrana`, mgrAToken))
    expect(okRes.status).toBe(200)
  })
})

/* ───────────────────────── Č3 — UI statika (read-only ostaja) ───────────────────────── */

describe('N-27-2 — portal karta: izbira kategorije + razčlenitev (statika)', () => {
  const src = readFileSync('src/components/tabs/accounting-portal-card.tsx', 'utf8')

  test('read-only invarianta ostane (brez mutacij — filter je GET refetch)', () => {
    expect(src).not.toMatch(/method:\s*['"]POST['"]/)
    expect(src).not.toMatch(/method:\s*['"]PATCH['"]/)
    expect(src).not.toMatch(/method:\s*['"]DELETE['"]/)
    expect(src).not.toMatch(/\.post\(/)
  })

  test('filter kategorije gre v obstoječi GET vir (?category=) — brez nove rute', () => {
    expect(src).toContain('/api/expenses?from=')
    expect(src).toContain('encodeURIComponent(cat)')
  })

  test('razčlenitev čpa iz API odgovora (brez lokalnega duplikata agregacije) + dostopnost', () => {
    expect(src).toContain('categoryBreakdown')
    expect(src).not.toContain('expenseCategoryBreakdown') // agregacija živi v API/lib, UI samo prikaže
    expect(src).toContain("SelectItem value=\"all\"")
    expect(src).toContain('aria-pressed')
    expect(src).toContain('aria-label')
  })
})

/* ───────────────────────── Č4 — i18n + verzija ───────────────────────── */

describe('N-27-2 — i18n pariteta + verzija', () => {
  test('novi ključi v OBAH slovarjih (SL/HR)', () => {
    for (const key of ['portal.expByCat', 'portal.expFiltered']) {
      expect(typeof sl[key as keyof typeof sl]).toBe('string')
      expect(typeof hr[key as keyof typeof hr]).toBe('string')
      expect((sl[key as keyof typeof sl] as string).length).toBeGreaterThan(0)
      expect((hr[key as keyof typeof hr] as string).length).toBeGreaterThan(0)
    }
  })

  test('verzija 1.198.0', () => {
    expect(APP_VERSION).toBe('1.198.0')
  })
})
