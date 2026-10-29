import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  EINVOICE_ALERT_STATUSES,
  EINVOICE_OUTSTANDING_STATUSES,
  countEInvoiceStatuses,
  eInvoiceOutboxSummary,
  glBalanceState,
  expenseSummary,
  expensePeriodRange,
} from '../src/lib/accounting-portal'
import { EINVOICE_STATUSES } from '../src/lib/einvoice-lifecycle'
import { GET as expensesGET } from '../src/app/api/expenses/route'

/**
 * P2-13 (v1.189.0) — KNJIGOVODSKI PORTAL (read-only agregacija).
 *
 * Tržna vrzel P2-13 (docs/TRZNA-VRZELI-2026.md §4 #13): GL/CSV izvozi že
 * obstajajo, manjkal je PRIKAZ. Knjigovodja (vloga accounting) mora prej
 * skakati med zavihki; eSlog odprema je sploh v nabavi (inventory.manage)
 * in je je ne vidi, čeprav ima einvoices.issue + API zahteva reports.sales.
 *
 * Merila:
 *  Č1 čisti sloj (src/lib/accounting-portal.ts, PURE, brez IO):
 *     zaprt seznam statusov s 0 privzetki, neznani statusi prezrti,
 *     neposlano (draft/validated/queued) + opozorila (failed/needs_review/
 *     rejected), GL balansa z zaokroževalnim radijem (|diff| ≤ 0.02),
 *     povzetek stroškov, meja obdobja (isti format kot /api/einvoices).
 *  Č2 backend GET /api/expenses z opcijskim obdobjem (brez DDL, brez nove
 *     rute): 401 brez žetona, 403 brez reports.sales (waiter), 400 ko manjka
 *     EN od parametrov ali je datum neveljaven; z obdobjem vrne
 *     periodTotal/periodPaid/periodCount nad CELO periodo (agregat, ne okno
 *     100) in OBSEG po lokaciji (tuja lokacija ni šteta); brez parametrov je
 *     odgovor nespremenjen (brez periodTotal, zadnji 100 zapisov).
 *  Č3 UI read-only invarianta (statika): komponenta NE vsebuje nobene
 *     mutacije (POST/PATCH/DELETE), bere natanko 4 obstoječe GET vire in
 *     računa prek čistega sloja.
 *  Č4 ožičenje: kartica je v zavihku racuni (ACCOUNTING tam pristane —
 *     tab-permissions), dovoljenje taba je reports.sales, portal ključi
 *     so v OBAH slovarjih (pariteta).
 *
 * ID-ji s predpono `v189ap-` (sweep beforeAll + afterAll).
 */

const PREFIX = 'v189ap-'
const RUN = Date.now().toString(36)

let locA = ''
let locB = ''
let mgrAToken = ''
let mgrBToken = ''
let waiterToken = ''

function req(url: string, token: string | null): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

let apSeq = 0
async function seedAp(locationId: string, invoiceDate: Date, total: number, paid: number): Promise<void> {
  apSeq += 1
  await db.accountsPayable.create({
    data: {
      id: `${PREFIX}ap${apSeq}-${RUN}`,
      apNumber: `AP-V189-${RUN.toUpperCase()}-${apSeq}`,
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
}

// dobavitelj je skupen (Supplier ni lokacijski) — id nastavljen v beforeAll
let SUPPLIER_ID = ''

async function isErr(p: Promise<Response>, status: number): Promise<void> {
  const res = await p
  expect(res.status).toBe(status)
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])

  locA = (await db.location.create({
    data: { id: `${PREFIX}locA-${RUN}`, name: `${PREFIX}Lokacija A`, code: `V189A-${RUN.toUpperCase()}` },
  })).id
  locB = (await db.location.create({
    data: { id: `${PREFIX}locB-${RUN}`, name: `${PREFIX}Lokacija B`, code: `V189B-${RUN.toUpperCase()}` },
  })).id

  SUPPLIER_ID = (await db.supplier.create({
    data: { id: `${PREFIX}dob-${RUN}`, name: `${PREFIX}Dobavitelj`, code: `V189D-${RUN.toUpperCase()}` },
  })).id

  // Obdobje: 2026-01-10 .. 2026-01-20 (fiksen, determinističen)
  //  locA: 3 v periodi (100/40, 50/50, 25.5/0) + 1 izven (9/9)
  //  locB: 1 v periodi (777/0) — NE sme se šteti v obsegu adminA
  await seedAp(locA, new Date('2026-01-05T12:00:00'), 9, 9)   // izven periode
  await seedAp(locA, new Date('2026-01-12T12:00:00'), 100, 40)
  await seedAp(locA, new Date('2026-01-15T12:00:00'), 50, 50)
  await seedAp(locA, new Date('2026-01-18T12:00:00'), 25.5, 0)
  await seedAp(locB, new Date('2026-01-14T12:00:00'), 777, 0)

  // P2-13: za obseg uporabimo LOKACIJSKO vlogo (MANAGER — locationScope vrne
  // user.loc; ADMIN je CENTRALNA vloga in na lokaciji brez Property/org pomeni
  // break-glass prazen obseg {} — vidi vse, kar je dokumentiran break-glass
  // pattern, ne obnašanje, ki ga portal obsega). MANAGER ima ENHANCED_PERMISSIONS
  // (reports.sales vključen) — isti vir kot accounting za branje.
  const mkMgr = async (n: string, loc: string, pin: string) => {
    const email = `${PREFIX}${n}-${RUN}@test.local`
    const fields = employeePinFields(pin, email)
    return db.employee.create({
      data: {
        id: `${PREFIX}${n}-${RUN}`, name: `${PREFIX}Vodja ${n}`, email,
        role: 'MANAGER', status: 'active', sessionVersion: 0, locationId: loc, ...fields,
      },
    })
  }
  const mgrA = await mkMgr('mgrA', locA, `7${RUN.slice(-5)}`)
  const mgrB = await mkMgr('mgrB', locB, `6${RUN.slice(-5)}`)
  const wFields = employeePinFields(`5${RUN.slice(-5)}`, `${PREFIX}waiter-${RUN}@test.local`)
  const waiter = await db.employee.create({
    data: {
      id: `${PREFIX}waiter-${RUN}`, name: `${PREFIX}Natakar`, email: `${PREFIX}waiter-${RUN}@test.local`,
      role: 'WAITER', status: 'active', sessionVersion: 0, locationId: locA, ...wFields,
    },
  })

  mgrAToken = createToken({ sub: mgrA.id, name: mgrA.name, role: 'MANAGER', loc: locA, sv: 0 })
  mgrBToken = createToken({ sub: mgrB.id, name: mgrB.name, role: 'MANAGER', loc: locB, sv: 0 })
  waiterToken = createToken({ sub: waiter.id, name: waiter.name, role: 'WAITER', loc: locA, sv: 0 })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

/* ───────────────────────── Č1 — čisti sloj ───────────────────────── */

describe('Č1 — čisti sloj accounting-portal (pure, brez IO)', () => {
  test('zaprt seznam 9 statusov — vsak dobi vnos, manjkajoči = 0', () => {
    expect(EINVOICE_STATUSES).toEqual(['draft', 'validated', 'queued', 'sent', 'delivered', 'accepted', 'rejected', 'failed', 'needs_review'])
    const counts = countEInvoiceStatuses([{ status: 'sent' }, { status: 'sent' }, { status: 'failed' }])
    expect(Object.keys(counts).length).toBe(9)
    expect(counts.sent).toBe(2)
    expect(counts.failed).toBe(1)
    expect(counts.draft).toBe(0)
    expect(counts.needs_review).toBe(0)
  })

  test('neznani statusi se prezrejo (fail-safe, ne crash)', () => {
    const counts = countEInvoiceStatuses([{ status: 'sent' }, { status: 'NEZNAN_STATUS' }])
    expect(counts.sent).toBe(1)
    expect(Object.keys(counts).length).toBe(9) // neznani ne doda ključa
  })

  test('povzetek odpreme: neposlano = draft+validated+queued, opozorila = failed+needs_review+rejected', () => {
    expect(EINVOICE_OUTSTANDING_STATUSES).toEqual(['draft', 'validated', 'queued'])
    expect(EINVOICE_ALERT_STATUSES).toEqual(['failed', 'needs_review', 'rejected'])
    const s = eInvoiceOutboxSummary([
      { status: 'draft' }, { status: 'validated' }, { status: 'queued' }, { status: 'queued' },
      { status: 'sent' }, { status: 'delivered' }, { status: 'accepted' },
      { status: 'failed' }, { status: 'needs_review' }, { status: 'rejected' },
    ])
    expect(s.total).toBe(10)
    expect(s.outstandingCount).toBe(4)
    expect(s.alertCount).toBe(3)
    expect(s.byStatus.queued).toBe(2)
    const empty = eInvoiceOutboxSummary([])
    expect(empty.total).toBe(0)
    expect(empty.outstandingCount).toBe(0)
    expect(empty.alertCount).toBe(0)
  })

  test('GL balansa: uravnovešena do 0.02 (zaokroževalni radij jedra), napaka vidna', () => {
    expect(glBalanceState({ debits: 100, credits: 100 })).toEqual({ balanced: true, diff: 0 })
    expect(glBalanceState({ debits: 100.01, credits: 100 })).toEqual({ balanced: true, diff: 0.01 })
    expect(glBalanceState({ debits: 100.02, credits: 100 })).toEqual({ balanced: true, diff: 0.02 })
    const bad = glBalanceState({ debits: 120.5, credits: 100 })
    expect(bad.balanced).toBe(false)
    expect(bad.diff).toBe(20.5)
  })

  test('povzetek stroškov: total, nesplačano, števec', () => {
    const s = expenseSummary([
      { amount: 100, paidAmount: 40 },
      { amount: 50.5, paidAmount: 50.5 },
      { amount: 25.5, paidAmount: 0 },
    ])
    expect(s.total).toBe(176)
    expect(s.outstanding).toBe(85.5)
    expect(s.count).toBe(3)
  })

  test('meja obdobja: isti format kot /api/einvoices (T00:00:00 / T23:59:59.999), zavrača neveljavne', () => {
    const r = expensePeriodRange('2026-01-10', '2026-01-20')
    expect(r).not.toBeNull()
    expect(r!.gte.toISOString()).toBe(new Date('2026-01-10T00:00:00').toISOString())
    expect(r!.lte.toISOString()).toBe(new Date('2026-01-20T23:59:59.999').toISOString())
    expect(expensePeriodRange('2026-1-10', '2026-01-20')).toBeNull()   // brez odvodnih ničel
    expect(expensePeriodRange('2026-01-10', 'ni-datum')).toBeNull()
    expect(expensePeriodRange('ne-pravilen', '2026-01-20')).toBeNull()
  })
})

/* ───────────────────────── Č2 — backend GET /api/expenses ───────────────────────── */

describe('Č2 — GET /api/expenses z opcijskim obdobjem (P2-13)', () => {
  const Q = 'from=2026-01-10&to=2026-01-20'

  test('401 brez žetona', async () => {
    await isErr(expensesGET(req(`/api/expenses?${Q}`, null)), 401)
  })

  test('403 brez reports.sales (waiter)', async () => {
    await isErr(expensesGET(req(`/api/expenses?${Q}`, waiterToken)), 403)
  })

  test('400: samo EN parameter ali neveljaven datum', async () => {
    await isErr(expensesGET(req('/api/expenses?from=2026-01-10', mgrAToken)), 400)
    await isErr(expensesGET(req('/api/expenses?to=2026-01-20', mgrAToken)), 400)
    await isErr(expensesGET(req('/api/expenses?from=1.1.2026&to=2026-01-20', mgrAToken)), 400)
  })

  test('z obdobjem: agregat nad celotno periodo + obseg po lokaciji (tuja lokacija ni šteta)', async () => {
    const res = await expensesGET(req(`/api/expenses?${Q}`, mgrAToken))
    expect(res.status).toBe(200)
    const d = (await res.json()) as { expenses: unknown[]; periodTotal: number; periodPaid: number; periodCount: number }
    // samo locA v periodi (3) — locB (777) je izven obsega, tudi izven-perioda (9) ne šteje
    expect(d.periodCount).toBe(3)
    expect(d.periodTotal).toBe(175.5)
    expect(d.periodPaid).toBe(90)
    expect(d.expenses.length).toBe(3)
  })

  test('vodja lokacije B vidi SAMO svojo vrstico v istem obdobju', async () => {
    const res = await expensesGET(req(`/api/expenses?${Q}`, mgrBToken))
    expect(res.status).toBe(200)
    const d = (await res.json()) as { expenses: unknown[]; periodCount: number; periodTotal: number }
    expect(d.periodCount).toBe(1)
    expect(d.periodTotal).toBe(777)
    expect(d.expenses.length).toBe(1)
  })

  test('brez parametrov: odgovor NESPREMENJEN (brez periodTotal, okno zadnjih 100 vključuje izven-periodo)', async () => {
    const res = await expensesGET(req('/api/expenses', mgrAToken))
    expect(res.status).toBe(200)
    const d = (await res.json()) as Record<string, unknown> & { expenses: unknown[] }
    expect('periodTotal' in d).toBe(false)
    expect('periodCount' in d).toBe(false)
    // obseg locA: 4 fiksaturje (3 v periodi + 1 izven) — vsi v oknu zadnjih 100
    expect(d.expenses.length).toBe(4)
  })
})

/* ───────────────────────── Č3 — UI read-only invarianta ───────────────────────── */

describe('Č3 — komponenta je READ-ONLY (statika)', () => {
  const src = readFileSync('src/components/tabs/accounting-portal-card.tsx', 'utf8')

  test('brez mutacij: noben POST/PATCH/DELETE klic', () => {
    expect(src).not.toMatch(/method:\s*['"]POST['"]/)
    expect(src).not.toMatch(/method:\s*['"]PATCH['"]/)
    expect(src).not.toMatch(/method:\s*['"]DELETE['"]/)
    expect(src).not.toMatch(/\.post\(/)
  })

  test('bere natanko 4 obstoječe GET vire (brez novih rut)', () => {
    expect(src).toContain('/api/reports/export?')
    expect(src).toContain('section=zz')
    expect(src).toContain('/api/reports/gl?')
    expect(src).toContain('/api/einvoices?')
    expect(src).toContain('/api/expenses?')
  })

  test('izračuni prek čistega sloja (ne lastna duplikata logike)', () => {
    expect(src).toContain("from '@/lib/accounting-portal'")
    expect(src).toContain('eInvoiceOutboxSummary')
    expect(src).toContain('glBalanceState')
  })
})

/* ───────────────────────── Č4 — ožičenje + i18n ───────────────────────── */

describe('Č4 — ožičenje dashboarda + i18n pariteta', () => {
  test('kartica je renderirana v zavihku racuni (ACCOUNTING tam pristane)', () => {
    const page = readFileSync('src/app/dashboard/page.tsx', 'utf8')
    expect(page).toContain('<AccountingPortalCard />')
    // prvi zavihek po vlogi: accounting + reports.sales → racuni
    expect(page).toContain('value="racuni"')
  })

  test('TAB_PERM.racuni = reports.sales in landingTab(ACCOUNTING) → racuni', async () => {
    const { TAB_PERM, landingTab } = await import('../src/lib/tab-permissions')
    expect(TAB_PERM.racuni).toBe('reports.sales')
    expect(landingTab('ACCOUNTING', ['reports.sales']).tab).toBe('racuni')
    // brez reports.sales pade na pregled (fail-closed)
    expect(landingTab('ACCOUNTING', []).tab).toBe('pregled')
  })

  test('23 portal.* ključev v OBAH slovarjih (SL/HR pariteta)', async () => {
    const { sl } = await import('../src/lib/i18n/sl')
    const { hr } = await import('../src/lib/i18n/hr')
    const slPortal = Object.keys(sl).filter((k) => k.startsWith('portal.'))
    const hrPortal = Object.keys(hr).filter((k) => k.startsWith('portal.'))
    expect(slPortal.length).toBe(23)
    expect(hrPortal.length).toBe(23)
    for (const k of slPortal) {
      expect(hr[k]).toBeDefined() // ploski ključi s piko — NE toHaveProperty (gnezdenje)
      expect(String(sl[k]).length).toBeGreaterThan(0)
      expect(String(hr[k]).length).toBeGreaterThan(0)
    }
  })
})
