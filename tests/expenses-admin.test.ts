import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { num } from '../src/lib/map'
import { GET as expensesGET, POST as expensesPOST } from '../src/app/api/expenses/route'
import { PATCH as expensesPATCH, DELETE as expensesDELETE } from '../src/app/api/expenses/[id]/route'
import { sweepTestFixtures } from './helpers/fixture-sweep'

/**
 * Task 61 — admin stroški (revizija §7 vrstica 122: PARTIAL → DONE).
 * Prej: samo GET+POST (seznam+vnos) — brez urejanja, plačila in preklica.
 * Testi zaklenejo vedenje, na katerega se (obogatena) ExpensesTab zanaša:
 *  - PATCH: opis/znesek/zapadlost + audit EXPENSE_UPDATED (before/after),
 *    status open↔paid (paidAmount/paidAt sinhronizirana), knjigovodska zaklen
 *    zneska na plačanem (409), preklicanega ni mogoče urejati (409)
 *  - DELETE: MEHKO — status 'void' (idempotentno, EN audit vnos), ne hard delete
 *    (AccountsPayableLine FK Cascade bi izgubil vrstice računa)
 *  - dovoljenje settings.manage (chef → 403) + guardResource lokacijski sloj
 *    (strošek na tuji lokaciji → 403) + GET reports.view z obogatenim mappingom
 * DB-backed proti dev SQLite; fiksature s predpono `exp61-`, pre-sweep počisti
 * ostanke crashanih tekov (Task 58 disciplina).
 */

const PREFIX = 'exp61-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

let locA = ''
let locB = ''

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function tokenFor(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

async function seedEmployee(name: string, role: string, pin: string, locationId: string) {
  const fields = employeePinFields(pin, `${PREFIX}${name}-${RUN}@test.local`)
  return db.employee.create({
    data: {
      id: `${PREFIX}emp-${name}-${RUN}`,
      name: `${PREFIX}${name}`,
      email: `${PREFIX}${name}-${RUN}@test.local`,
      role,
      status: 'active',
      sessionVersion: 0,
      locationId,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
}

async function setup() {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-a-${RUN}`, name: `${PREFIX}Lokacija A`, code: `E61A-${RUN.toUpperCase()}` },
  })
  locA = loc.id
  const loc2 = await db.location.create({
    data: { id: `${PREFIX}loc-b-${RUN}`, name: `${PREFIX}Lokacija B`, code: `E61B-${RUN.toUpperCase()}` },
  })
  locB = loc2.id
  const owner = await seedEmployee('owner', 'owner', pinOf(1), locA)
  const chef = await seedEmployee('chef', 'chef', pinOf(2), locA)
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(3), locA)
  return {
    owner: tokenFor(owner.id, owner.name, 'owner', locA),
    chef: tokenFor(chef.id, chef.name, 'chef', locA),
    waiter: tokenFor(waiter.id, waiter.name, 'waiter', locA),
  }
}

/** Prefiksovan dobavitelj za tuje lokacijske fiksature (FK za AccountsPayable). */
async function seedSupplier() {
  return db.supplier.create({
    data: { id: `${PREFIX}dob-${RUN}`, name: `${PREFIX}Dobavitelj`, code: `E61D-${RUN.toUpperCase()}` },
  })
}

const setupP = setup()

/** POST skozi pravo ruto (ustvari AP + audit EXPENSE_CREATE). */
async function createExpense(token: string, description: string, amount: number) {
  const r = await expensesPOST(req('/api/expenses', token, 'POST', { description, amount }))
  expect(r.status).toBe(201)
  return ((await r.json()) as { expense: { id: string } }).expense.id
}

afterAll(async () => {
  // obratna smer FK: revizija/dogodki → stroški (vrstice Cascade) → dobavitelj (samo prefiksiran —
  // globalni 'Razno' ostane, ker je zakonit privzeti dobavitelj produkcijske rute) → zaposleni → lokacije
  await db.auditLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  // Task 61 LEKCIJA: POST ruta generira id z nid() — predpona živi v invoiceNumber/
  // notes/apNumber, ne v id (id-predponski pogoj ne ujame ničesar → 56 sirot v dev bazi)
  await db.accountsPayable.deleteMany({
    where: { OR: [{ id: { startsWith: PREFIX } }, { invoiceNumber: { startsWith: PREFIX } }, { notes: { startsWith: PREFIX } }, { apNumber: { startsWith: PREFIX } }] },
  }).catch(() => null)
  await db.supplier.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
})

const isErr = async (p: Promise<Response>, status: number) => {
  const r = await p
  expect(r.status).toBe(status)
  return (await r.json()) as { error?: string }
}

describe('Task 61 — admin stroški (PATCH/DELETE + plačilo + preklic)', () => {
  test('PATCH opis + znesek + zapadlost → 200 + audit EXPENSE_UPDATED (before/after)', async () => {
    const { owner } = await setupP
    const id = await createExpense(owner, `${PREFIX}Pijača zaloge`, 42.5)
    const due = new Date(); due.setDate(due.getDate() + 14)
    const r = await expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', {
      description: `${PREFIX}Pijača — urejeno`, amount: 55.25, dueDate: due.toISOString(),
    }), { params: Promise.resolve({ id }) })
    expect(r.status).toBe(200)
    const e = ((await r.json()) as { expense: { description: string; amount: number; dueDate: string; status: string } }).expense
    expect(e.description).toBe(`${PREFIX}Pijača — urejeno`)
    expect(e.amount).toBe(55.25)
    expect(e.status).toBe('open')
    expect(new Date(e.dueDate).getDate()).toBe(due.getDate())
    const row = await db.accountsPayable.findUnique({ where: { id } })
    expect(row?.invoiceNumber).toBe(`${PREFIX}Pijača — urejeno`)
    expect(row?.notes).toBe(`${PREFIX}Pijača — urejeno`)
    const audits = await db.auditLog.findMany({ where: { action: 'EXPENSE_UPDATED', entityId: id } })
    expect(audits.length).toBe(1)
    expect(audits[0].details).toContain('"before"')
    expect(audits[0].details).toContain('"after"')
    expect(audits[0].details).toContain('42.5')
  })

  test('PATCH validacija: znesek ≤ 0 / slab datum / slab status → 400; prazen body → 400', async () => {
    const { owner } = await setupP
    const id = await createExpense(owner, `${PREFIX}Validacija`, 10)
    await isErr(expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { amount: 0 }), { params: Promise.resolve({ id }) }), 400)
    await isErr(expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { amount: -5 }), { params: Promise.resolve({ id }) }), 400)
    await isErr(expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { dueDate: 'ne-delavec' }), { params: Promise.resolve({ id }) }), 400)
    await isErr(expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { status: 'void' }), { params: Promise.resolve({ id }) }), 400)
    await isErr(expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', {}), { params: Promise.resolve({ id }) }), 400)
  })

  test('PATCH neobstoječega → 404', async () => {
    const { owner } = await setupP
    await isErr(expensesPATCH(req(`/api/expenses/${PREFIX}ne-obstaja-${RUN}`, owner, 'PATCH', { amount: 5 }), { params: Promise.resolve({ id: `${PREFIX}ne-obstaja-${RUN}` }) }), 404)
  })

  test('status paid: paidAmount = znesek + paidAt; plačanega zneska ni mogoče urejati (409)', async () => {
    const { owner } = await setupP
    const id = await createExpense(owner, `${PREFIX}Najemnina`, 300)
    const paid = await expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { status: 'paid' }), { params: Promise.resolve({ id }) })
    expect(paid.status).toBe(200)
    const e = ((await paid.json()) as { expense: { status: string; paidAmount: number; paidAt: string } }).expense
    expect(e.status).toBe('paid')
    expect(e.paidAmount).toBe(300)
    expect(e.paidAt).toBeTruthy()
    // knjigovodska zaklen: znesek plačanega povpraševanja se ne sme spremeniti
    await isErr(expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { amount: 999 }), { params: Promise.resolve({ id }) }), 409)
    const row = await db.accountsPayable.findUnique({ where: { id } })
    expect(row?.status).toBe('paid')
    expect(num(row?.totalAmount)).toBe(300)
  })

  test('status open (ponovno odpri): paidAmount 0 + paidAt null, znesek spet urejljiv', async () => {
    const { owner } = await setupP
    const id = await createExpense(owner, `${PREFIX}Komunalnine`, 88)
    await expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { status: 'paid' }), { params: Promise.resolve({ id }) })
    const reopened = await expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { status: 'open' }), { params: Promise.resolve({ id }) })
    expect(reopened.status).toBe(200)
    const e = ((await reopened.json()) as { expense: { status: string; paidAmount: number } }).expense
    expect(e.status).toBe('open')
    expect(e.paidAmount).toBe(0)
    const row = await db.accountsPayable.findUnique({ where: { id } })
    expect(row?.paidAt).toBeNull()
    // po odprtju je znesek spet urejljiv
    const okR = await expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { amount: 92.4 }), { params: Promise.resolve({ id }) })
    expect(okR.status).toBe(200)
    expect(((await okR.json()) as { expense: { amount: number } }).expense.amount).toBe(92.4)
  })

  test('DELETE je mehko brisanje: status void + EN audit; PATCH na preklicanega → 409', async () => {
    const { owner } = await setupP
    const id = await createExpense(owner, `${PREFIX}Za preklic`, 25)
    const del = await expensesDELETE(req(`/api/expenses/${id}`, owner, 'DELETE'), { params: Promise.resolve({ id }) })
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true)
    const row = await db.accountsPayable.findUnique({ where: { id } })
    expect(row?.status).toBe('void') // vrstica OSTANE (revizijska pot, ne hard delete)
    expect(await db.auditLog.count({ where: { action: 'EXPENSE_DELETED', entityId: id } })).toBe(1)
    await isErr(expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { amount: 9 }), { params: Promise.resolve({ id }) }), 409)
  })

  test('DELETE idempotenten: drugi klic → ok, brez duplikata revizije', async () => {
    const { owner } = await setupP
    const id = await createExpense(owner, `${PREFIX}Dvojni klic`, 15)
    await expensesDELETE(req(`/api/expenses/${id}`, owner, 'DELETE'), { params: Promise.resolve({ id }) })
    const again = await expensesDELETE(req(`/api/expenses/${id}`, owner, 'DELETE'), { params: Promise.resolve({ id }) })
    expect(again.status).toBe(200)
    expect(((await again.json()) as { deleted: boolean }).deleted).toBe(true)
    expect(await db.auditLog.count({ where: { action: 'EXPENSE_DELETED', entityId: id } })).toBe(1)
  })

  test('DELETE neobstoječega → 404', async () => {
    const { owner } = await setupP
    await isErr(expensesDELETE(req(`/api/expenses/${PREFIX}manjka-${RUN}`, owner, 'DELETE'), { params: Promise.resolve({ id: `${PREFIX}manjka-${RUN}` }) }), 404)
  })

  test('guardResource: strošek na tuji lokaciji → 403 (staff fail-closed)', async () => {
    const { owner } = await setupP
    const supplier = await seedSupplier()
    const foreign = await db.accountsPayable.create({
      data: {
        id: `${PREFIX}ap-tuj-${RUN}`,
        apNumber: `AP-E61T-${RUN.toUpperCase()}`,
        supplierId: supplier.id,
        invoiceNumber: `${PREFIX}Tuj strošek`,
        dueDate: new Date(),
        subtotal: 60,
        totalAmount: 60,
        locationId: locB, // owner je na locA — non-central → 403
      },
    })
    await isErr(expensesPATCH(req(`/api/expenses/${foreign.id}`, owner, 'PATCH', { amount: 61 }), { params: Promise.resolve({ id: foreign.id }) }), 403)
    await isErr(expensesDELETE(req(`/api/expenses/${foreign.id}`, owner, 'DELETE'), { params: Promise.resolve({ id: foreign.id }) }), 403)
    const row = await db.accountsPayable.findUnique({ where: { id: foreign.id } })
    expect(row?.status).toBe('open') // nedotaknjen
    expect(num(row?.totalAmount)).toBe(60)
  })

  test('chef (brez settings.manage) → 403 na PATCH in DELETE', async () => {
    const { owner, chef } = await setupP
    const id = await createExpense(owner, `${PREFIX}Kuhinjski pripomočki`, 35)
    await isErr(expensesPATCH(req(`/api/expenses/${id}`, chef, 'PATCH', { amount: 36 }), { params: Promise.resolve({ id }) }), 403)
    await isErr(expensesDELETE(req(`/api/expenses/${id}`, chef, 'DELETE'), { params: Promise.resolve({ id }) }), 403)
  })

  test('GET obogaten: status/apNumber/dueDate/supplierName (ExpensesTab mapping)', async () => {
    const { owner, waiter } = await setupP
    const id = await createExpense(owner, `${PREFIX}Mapping preverba`, 12.34)
    const list = await expensesGET(req('/api/expenses', owner))
    const rows = ((await list.json()) as { expenses: Array<{ id: string; apNumber?: string; status?: string; dueDate?: string | null; supplierName?: string | null }> }).expenses
    const mine = rows.find((r) => r.id === id)
    expect(mine).toBeTruthy()
    expect(mine?.status).toBe('open')
    expect(String(mine?.apNumber)).toMatch(/^AP-/)
    expect(mine?.dueDate).toBeTruthy()
    expect(mine?.supplierName).toBe('Razno') // POST brez dobavitelja → privzeti 'Razno'
    // waiter NIMA reports.view (N5: finance niso za natakarja) → 403 fail-closed
    await isErr(expensesGET(req('/api/expenses', waiter)), 403)
  })
})
