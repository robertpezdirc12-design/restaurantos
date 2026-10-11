import { describe, expect, test, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as expensesGET, POST as expensesPOST } from '../src/app/api/expenses/route'
import { PATCH as expensesPATCH } from '../src/app/api/expenses/[id]/route'
import { resetExpenseCategoriesProbe } from '../src/lib/expenses-categories'
import { sweepTestFixtures } from './helpers/fixture-sweep'

/**
 * Task 67 — kategorije stroškov, runtime-gated (v1.65.0).
 *
 * Zadnja koda/UI naloga audit §7 (vrstica 122 — koda/UI kategorij). ARHITEKTURA:
 *  - main schema.prisma polja category NIMA (Task 66 varnostna odločitev — sicer bi
 *    tipizirani client SELECT-al neobstoječ stolpec na Neonu do uporabnikovega DDL
 *    klika → P2022 zastrupitev VSEH poizvedb na AccountsPayable);
 *  - dev zrcalo (schema.sqlite.prisma) polje IMA → dev probe = true;
 *  - branje/pisanje kategorije gre prek RAW SQL z vezanimi parametri, gated z
 *    memoizirano probo (60 s TTL) — produkcija se po uporabnikovem DDL kliku
 *    (Enterprise → konzola → stroski-kategorije) samozdravi brez redeploya;
 *  - probe false → rute se obnašajo točno kot prej ('OSTALO' fallback), pisanje
 *    kategorije → 503 (haccp vzorec); UI polja skrije (categoriesEnabled flag).
 *
 * LEKCIJA Task 66 (uporabljena tu): tipizirani Prisma client ima stale read-view
 * za tabele/stolpce, ki jih ne pozna njegova shema — zato kategorija NIKOLI ne gre
 * skozi tipizirane poizvedbe, izključno raw SQL (vozani parametri, dialekt-agnostično).
 *
 * Testi (predpona `sk67-` v TEST_PREFIXES):
 *  1. dev probe true: POST s kategorijo → 201 + raw stolpec + GET enrichment +
 *     categoriesEnabled/categories + audit EXPENSE_CREATE s kategorijo
 *  2. validacija: >60 znakov → 400; trim okoliških presledkov
 *  3. PATCH: sprememba + brisanje ('') + samo-kategorija PATCH (ne 400 'Ni sprememb')
 *     + brez sprememb → 400 + audit EXPENSE_UPDATED before/after s kategorijo
 *  4. probe false (override): 503 na pisanje kategorije, legacy 'OSTALO' fallback,
 *     ostale PATCH polja delujejo; po resetu spet dev resnica (true)
 *  5. avtorizacija: waiter POST s kategorijo → 403 (settings.manage)
 *  6. STATIČNA varnostna invarianta: main schema BREZ polja, zrcalna shema Z poljem
 */

const PREFIX = 'sk67-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

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
    data: { id: `${PREFIX}loc-a-${RUN}`, name: `${PREFIX}Lokacija A`, code: `S67A-${RUN.toUpperCase()}` },
  })
  const owner = await seedEmployee('owner', 'owner', pinOf(1), loc.id)
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(2), loc.id)
  return {
    owner: tokenFor(owner.id, owner.name, 'owner', loc.id),
    waiter: tokenFor(waiter.id, waiter.name, 'waiter', loc.id),
  }
}

const setupP = setup()

interface ExpT { id: string; category: string; description: string }
interface GetResp { expenses: ExpT[]; categoriesEnabled: boolean; categories?: string[] }

/** Raw resnica o kategoriji (obide Prisma read-view — LEKCIJA Task 66). */
async function rawCategory(id: string): Promise<string | undefined> {
  const rows = await db.$queryRawUnsafe<{ category: string }[]>(
    'SELECT "category" FROM "AccountsPayable" WHERE "id" = ?',
    id,
  )
  return rows[0]?.category
}

afterAll(async () => {
  resetExpenseCategoriesProbe() // probe nazaj na dev resnico (re-probe)
  // obratna smer FK: revizija → stroški → zaposleni → lokacije (id = nid() →
  // predpona živi v description/notes/apNumber — ista lekcija kot Task 61)
  await db.auditLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  await db.accountsPayable.deleteMany({
    where: { OR: [{ invoiceNumber: { startsWith: PREFIX } }, { notes: { startsWith: PREFIX } }, { apNumber: { startsWith: PREFIX } }] },
  }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
})

describe('sk67: dev probe true — vnos + enrichment + audit', () => {
  test('POST s kategorijo → 201, raw stolpec zapisan, GET enrichment + categoriesEnabled', async () => {
    const { owner } = await setupP
    const r = await expensesPOST(req('/api/expenses', owner, 'POST', {
      description: `${PREFIX}Hrana zaloge`, amount: 33.5, category: 'Hrana',
    }))
    expect(r.status).toBe(201)
    const created = ((await r.json()) as { expense: ExpT }).expense
    expect(created.category).toBe('Hrana')
    // raw resnica: stolpec res zapisan (transakcija create + raw UPDATE)
    expect(await rawCategory(created.id)).toBe('Hrana')

    const g = await expensesGET(req('/api/expenses', owner))
    expect(g.status).toBe(200)
    const j = (await g.json()) as GetResp
    expect(j.categoriesEnabled).toBe(true)
    const row = j.expenses.find((e) => e.id === created.id)
    expect(row?.category).toBe('Hrana')
    expect(j.categories).toContain('Hrana')
    // audit s kategorijo
    const audit = await db.auditLog.findFirst({ where: { action: 'EXPENSE_CREATE', entityId: created.id } })
    expect(audit?.details).toContain('"category":"Hrana"')
  })

  test('validacija: >60 znakov → 400; trim okoliških presledkov', async () => {
    const { owner } = await setupP
    const long = await expensesPOST(req('/api/expenses', owner, 'POST', {
      description: `${PREFIX}predolgo`, amount: 5, category: 'x'.repeat(61),
    }))
    expect(long.status).toBe(400)

    const r = await expensesPOST(req('/api/expenses', owner, 'POST', {
      description: `${PREFIX}trim test`, amount: 7, category: '  Vino  ',
    }))
    expect(r.status).toBe(201)
    const created = ((await r.json()) as { expense: ExpT }).expense
    expect(created.category).toBe('Vino')
    expect(await rawCategory(created.id)).toBe('Vino')
  })
})

describe('sk67: PATCH — sprememba, brisanje, samo-kategorija, audit', () => {
  test('PATCH kategorija → 200 + odziv + GET + audit EXPENSE_UPDATED (before/after)', async () => {
    const { owner } = await setupP
    const c = await expensesPOST(req('/api/expenses', owner, 'POST', {
      description: `${PREFIX}patch cilj`, amount: 20, category: 'Hrana',
    }))
    const id = ((await c.json()) as { expense: { id: string } }).expense.id

    const r = await expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { category: 'Pijača' }), { params: Promise.resolve({ id }) })
    expect(r.status).toBe(200)
    const e = ((await r.json()) as { expense: ExpT }).expense
    expect(e.category).toBe('Pijača')
    expect(await rawCategory(id)).toBe('Pijača')

    const g = (await (await expensesGET(req('/api/expenses', owner))).json()) as GetResp
    expect(g.expenses.find((x) => x.id === id)?.category).toBe('Pijača')

    const audit = await db.auditLog.findFirst({ where: { action: 'EXPENSE_UPDATED', entityId: id } })
    expect(audit?.details).toContain('"before"')
    expect(audit?.details).toContain('"category":"Hrana"') // before
    expect(audit?.details).toContain('"category":"Pijača"') // after
  })

  test('samo-kategorija PATCH → 200 (ne 400 "Ni sprememb"); isti podatkek → 400; brisanje (\'\') → 200', async () => {
    const { owner } = await setupP
    const c = await expensesPOST(req('/api/expenses', owner, 'POST', {
      description: `${PREFIX}samo kat`, amount: 11, category: 'Embalaža',
    }))
    const id = ((await c.json()) as { expense: { id: string } }).expense.id

    // isti podatkek → prava "Ni sprememb."
    const same = await expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { category: 'Embalaža' }), { params: Promise.resolve({ id }) })
    expect(same.status).toBe(400)

    // brisanje kategorije ('')
    const clear = await expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { category: '' }), { params: Promise.resolve({ id }) })
    expect(clear.status).toBe(200)
    expect(((await clear.json()) as { expense: ExpT }).expense.category).toBe('')
    expect(await rawCategory(id)).toBe('')

    // PATCH BREZ kategorije ne sme padeti ("Ni sprememb" 400) — opis se spremeni
    const d = await expensesPATCH(req(`/api/expenses/${id}`, owner, 'PATCH', { description: `${PREFIX}samo kat — urejeno` }), { params: Promise.resolve({ id }) })
    expect(d.status).toBe(200)
    // odziv ohrani realno kategorijo ('' — prej izbrisana), ne legacy 'OSTALO'
    expect(((await d.json()) as { expense: ExpT }).expense.category).toBe('')
  })
})

describe('sk67: probe false (DDL pending) — graceful degradacija', () => {
  test('POST s kategorijo → 503; brez → 201 legacy; GET fallback; PATCH varovanje; ostala polja delujejo', async () => {
    const { owner } = await setupP
    resetExpenseCategoriesProbe(false) // vsili pending (try/finally po resetu)
    try {
      // pisanje kategorije → 503 (haccp vzorec)
      const r503 = await expensesPOST(req('/api/expenses', owner, 'POST', {
        description: `${PREFIX}pending 503`, amount: 9, category: 'Hrana',
      }))
      expect(r503.status).toBe(503)

      // brez kategorije → 201, legacy 'OSTALO' (nazajkompatibilno)
      const r = await expensesPOST(req('/api/expenses', owner, 'POST', { description: `${PREFIX}legacy`, amount: 8 }))
      expect(r.status).toBe(201)
      const legacy = ((await r.json()) as { expense: ExpT }).expense
      expect(legacy.category).toBe('OSTALO')

      // GET: categoriesEnabled false + 'OSTALO' fallback (kljub dejanskemu stolpcu na dev)
      const g = (await (await expensesGET(req('/api/expenses', owner))).json()) as GetResp
      expect(g.categoriesEnabled).toBe(false)
      expect(g.categories).toBeUndefined()
      const row = g.expenses.find((x) => x.id === legacy.id)
      expect(row?.category).toBe('OSTALO')

      // PATCH s kategorijo → 503; PATCH ostalih polj → 200 (funkcionalnost ne zastane)
      const p503 = await expensesPATCH(req(`/api/expenses/${legacy.id}`, owner, 'PATCH', { category: 'X' }), { params: Promise.resolve({ id: legacy.id }) })
      expect(p503.status).toBe(503)
      const pOk = await expensesPATCH(req(`/api/expenses/${legacy.id}`, owner, 'PATCH', { description: `${PREFIX}legacy — urejeno` }), { params: Promise.resolve({ id: legacy.id }) })
      expect(pOk.status).toBe(200)
      expect(((await pOk.json()) as { expense: ExpT }).expense.category).toBe('OSTALO')
    } finally {
      resetExpenseCategoriesProbe() // nazaj na dev resnico
    }
    // po resetu spet true (dev zrcalo ima stolpec)
    const g2 = (await (await expensesGET(req('/api/expenses', owner))).json()) as GetResp
    expect(g2.categoriesEnabled).toBe(true)
  })
})

describe('sk67: avtorizacija + statična varnostna invarianta', () => {
  test('waiter POST s kategorijo → 403 (settings.manage)', async () => {
    const { waiter } = await setupP
    const r = await expensesPOST(req('/api/expenses', waiter, 'POST', {
      description: `${PREFIX}waiter`, amount: 5, category: 'Hrana',
    }))
    expect(r.status).toBe(403)
  })

  test('main schema BREZ category (P2022 zaščita produkcije), zrcalna shema Z njo', () => {
    const main = readFileSync('prisma/schema.prisma', 'utf8')
    const mainStart = main.indexOf('model AccountsPayable {')
    expect(mainStart).toBeGreaterThan(-1)
    const mainEnd = main.indexOf('\n}', mainStart)
    const mainBlock = main.slice(mainStart, mainEnd)
    // nobeno polje v modelu se ne sme imenovati category (komentarji o HTML dovolimo prek regexa na polje)
    expect(mainBlock.match(/^\s*category\s+/m)).toBeNull()

    const mirror = readFileSync('prisma/schema.sqlite.prisma', 'utf8')
    const mStart = mirror.indexOf('model AccountsPayable {')
    expect(mStart).toBeGreaterThan(-1)
    const mEnd = mirror.indexOf('\n}', mStart)
    const mirrorBlock = mirror.slice(mStart, mEnd)
    expect(mirrorBlock.match(/^\s*category\s+String\s+@default\(""\)/m)).not.toBeNull()
  })
})
