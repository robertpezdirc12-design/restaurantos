import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as discountsGET, POST as discountsPOST } from '../src/app/api/discounts/route'
import { PATCH as discountPATCH, DELETE as discountDELETE } from '../src/app/api/discounts/[id]/route'
import { sweepTestFixtures } from './helpers/fixture-sweep'

/**
 * Task 59 — admin upravljanje popustov: regresija za UI vezavo na API
 * (GET/POST/PATCH/DELETE /api/discounts). Backend je bil popoln že pred UI;
 * testi zaklenejo vedenje, na katerega se DiscountsTab zanaša:
 *  - POST validacija (percent ≤ 100, Happy okno zahteva obe uri) + audit DISCOUNT_CREATED
 *  - PATCH delne posodobitve + audit DISCOUNT_UPDATED (before/after) + ciljne kategorije
 *  - DELETE = MEHKO brisanje (isActive false, audit DISCOUNT_DELETED) — FK Check/OrderItem
 *  - dovoljenje apply_discounts (chef → 403) + GET scoping non-central (samo svoja lokacija)
 * DB-backed proti dev SQLite; fiksature s predpono `disc59-`, pre-sweep počisti
 * ostanke crashanih tekov (Task 58 disciplina).
 */

const PREFIX = 'disc59-'
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
    data: { id: `${PREFIX}loc-a-${RUN}`, name: `${PREFIX}Lokacija A`, code: `D59A-${RUN.toUpperCase()}` },
  })
  locA = loc.id
  const loc2 = await db.location.create({
    data: { id: `${PREFIX}loc-b-${RUN}`, name: `${PREFIX}Lokacija B`, code: `D59B-${RUN.toUpperCase()}` },
  })
  locB = loc2.id
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locA } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
  const owner = await seedEmployee('owner', 'owner', pinOf(1), locA)
  const chef = await seedEmployee('chef', 'chef', pinOf(2), locA)
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(3), locA)
  return {
    owner: tokenFor(owner.id, owner.name, 'owner', locA),
    chef: tokenFor(chef.id, chef.name, 'chef', locA),
    waiter: tokenFor(waiter.id, waiter.name, 'waiter', locA),
    catId: cat.id,
  }
}

const setupP = setup()

afterAll(async () => {
  // obratna smer FK: revizija → popusti → meni/kategorija → zaposleni → lokacije
  await db.auditLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  await db.discount.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
})

const isErr = async (p: Promise<Response>, status: number) => {
  const r = await p
  expect(r.status).toBe(status)
  return (await r.json()) as { error?: string }
}

describe('Task 59 — admin popusti (UI ↔ API vezava)', () => {
  test('POST ustvari popust + audit DISCOUNT_CREATED', async () => {
    const { owner } = await setupP
    const r = await discountsPOST(req('/api/discounts', owner, 'POST', {
      name: `${PREFIX}Deset`, type: 'percent', amount: 10, triggerType: 'manual',
    }))
    expect(r.status).toBe(201)
    const d = ((await r.json()) as { discount: { id: string; amount: string; appliesTo: string } }).discount
    expect(d.appliesTo).toBe('check')
    const audit = await db.auditLog.count({ where: { action: 'DISCOUNT_CREATED', entityId: d.id } })
    expect(audit).toBe(1)
  })

  test('POST validacija: percent > 100 in Happy okno z eno uro → 400', async () => {
    const { owner } = await setupP
    await isErr(discountsPOST(req('/api/discounts', owner, 'POST', { name: 'x', type: 'percent', amount: 150 })), 400)
    await isErr(discountsPOST(req('/api/discounts', owner, 'POST', { name: 'x', type: 'fixed', amount: 5, happyFromHour: 16 })), 400)
  })

  test('chef (brez apply_discounts) → 403', async () => {
    const { chef } = await setupP
    await isErr(discountsPOST(req('/api/discounts', chef, 'POST', { name: 'x', type: 'percent', amount: 5 })), 403)
  })

  test('PATCH delna posodobitev + audit DISCOUNT_UPDATED (before/after)', async () => {
    const { owner } = await setupP
    const created = await discountsPOST(req('/api/discounts', owner, 'POST', { name: `${PREFIX}Fix`, type: 'fixed', amount: 5 }))
    const id = ((await created.json()) as { discount: { id: string } }).discount.id
    const r = await discountPATCH(req(`/api/discounts/${id}`, owner, 'PATCH', { amount: 3.5, maxUses: 50 }), { params: Promise.resolve({ id }) })
    expect(r.status).toBe(200)
    const upd = ((await r.json()) as { discount: { amount: string; maxUses: number | null } }).discount
    expect(upd.amount).toBe('3.5')
    expect(upd.maxUses).toBe(50)
    const audits = await db.auditLog.findMany({ where: { action: 'DISCOUNT_UPDATED', entityId: id } })
    expect(audits.length).toBe(1)
    expect(audits[0].details).toContain('"before"')
    expect(audits[0].details).toContain('"after"')
  })

  test('PATCH ciljne kategorije: neobstoječa → 400, obstoječa → appliesTo item', async () => {
    const { owner, catId } = await setupP
    const created = await discountsPOST(req('/api/discounts', owner, 'POST', { name: `${PREFIX}Kat`, type: 'percent', amount: 15 }))
    const id = ((await created.json()) as { discount: { id: string } }).discount.id
    await isErr(discountPATCH(req(`/api/discounts/${id}`, owner, 'PATCH', { targetCategoryIds: `${PREFIX}neobstaja-${RUN}` }), { params: Promise.resolve({ id }) }), 400)
    const okR = await discountPATCH(req(`/api/discounts/${id}`, owner, 'PATCH', { targetCategoryIds: catId }), { params: Promise.resolve({ id }) })
    expect(((await okR.json()) as { discount: { appliesTo: string } }).discount.appliesTo).toBe('item')
  })

  test('DELETE je mehko brisanje: isActive false + audit, GET ga še vrne', async () => {
    const { owner, waiter } = await setupP
    const created = await discountsPOST(req('/api/discounts', owner, 'POST', { name: `${PREFIX}Briši`, type: 'percent', amount: 20 }))
    const id = ((await created.json()) as { discount: { id: string } }).discount.id
    const del = await discountDELETE(req(`/api/discounts/${id}`, owner, 'DELETE'), { params: Promise.resolve({ id }) })
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true)
    const row = await db.discount.findUnique({ where: { id } })
    expect(row?.isActive).toBe(false)
    expect(await db.auditLog.count({ where: { action: 'DISCOUNT_DELETED', entityId: id } })).toBe(1)
    // UI pričakuje: neaktivni popusti ostanejo na seznamu (administracija), waiter (non-central) vidi samo svojo lokacijo
    const list = await discountsGET(req('/api/discounts', waiter))
    const ids = ((await list.json()) as { discounts: { id: string }[] }).discounts.map((x) => x.id)
    expect(ids).toContain(id)
  })

  test('DELETE neobstoječega → 404; GET scoping: non-central vidi samo svojo lokacijo', async () => {
    const { owner, waiter } = await setupP
    await isErr(discountDELETE(req('/api/discounts/ne-obstaja', owner, 'DELETE'), { params: Promise.resolve({ id: 'ne-obstaja' }) }), 404)
    // popust na drugi lokaciji (centralna lahko poda locationId)
    const other = await discountsPOST(req('/api/discounts', owner, 'POST', {
      name: `${PREFIX}Tuj`, type: 'percent', amount: 5, locationId: locB,
    }))
    expect(other.status).toBe(201)
    const list = await discountsGET(req('/api/discounts', waiter))
    const rows = ((await list.json()) as { discounts: { locationId: string }[] }).discounts
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((x) => x.locationId === locA)).toBe(true)
  })
})
