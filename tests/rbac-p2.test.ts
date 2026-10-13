import { describe, expect, test, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as tablesPOST } from '../src/app/api/tables/route'
import { DELETE as tableDELETE } from '../src/app/api/tables/[id]/route'
import { PATCH as orderPATCH, DELETE as orderDELETE } from '../src/app/api/orders/[id]/route'
import { PATCH as employeePATCH } from '../src/app/api/employees/[id]/route'
import { GET as loyaltyGET } from '../src/app/api/loyalty/route'
import { TAB_PERM, TAB_PERM_ALL, tabHasPerm } from '../src/lib/tab-permissions'
import { maskPhone } from '../src/lib/pii'
import { CANONICAL_PERMISSIONS } from '../src/lib/permissions'

/**
 * P2 RBAC testi (N1/N2/N7/N8 + loyalty PII) — DB-backed (dev SQLite, db/custom.db).
 * Vsi podatki imajo unikatno predpono `rbac-p2-` (id/epošte/koda lokacije/pins),
 * poženeš jih lahko večkrat; cleanup (afterAll) briše v obratni smeri FK.
 */

const PREFIX = 'rbac-p2-'
const RUN = Date.now().toString(36) // unikatnost med poženi

/** unikaten PIN (4–8 števk) — časovno izhodišče + zaporedna številka */
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

const ctx = { canManage: false, perms: [] as string[] }

let locId = ''
let ownerId = ''
let managerId = ''
let waiterId = ''

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function tokenFor(sub: string, name: string, role: string, loc: string | null): string {
  // sv: 0 = sessionVersion v DB (privzeto 0) — seja ni preklicana
  return createToken({ sub, name, role, loc, sv: 0 })
}

async function seedEmployee(name: string, role: string, pin: string) {
  const fields = employeePinFields(pin, `${PREFIX}${name}@test.local`)
  return db.employee.create({
    data: {
      id: `${PREFIX}${name}-${RUN}`,
      name: `${PREFIX}${name}`,
      email: `${PREFIX}${name}-${RUN}@test.local`,
      role,
      status: 'active',
      sessionVersion: 0,
      locationId: locId,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
}

/** naročilo brez mize (tableId null → PATCH/DELETE ne dotakneta Table) */
async function seedOrder(n: number) {
  return db.order.create({
    data: { id: `${PREFIX}ord-${n}-${RUN}`, locationId: locId, orderNumber: n, status: 'open', paymentStatus: 'unpaid' },
  })
}

afterAll(async () => {
  // obratna smer FK: dogodki/revizija → naročila → mize → zvestoba → zaposleni → lokacija
  await db.eventLog.deleteMany({ where: { OR: [{ entityId: { startsWith: PREFIX } }, { payload: { contains: PREFIX } }] } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.order.deleteMany({ where: { id: { startsWith: `${PREFIX}ord-` } } }).catch(() => null)
  await db.table.deleteMany({ where: { locationId: locId || '__x__' } }).catch(() => null)
  await db.loyaltyAccount.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: `${PREFIX}` } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: locId || '__x__' } }).catch(() => null)
})

// ── Nastavitev skupnih testnih podatkov ──
async function setup() {
  // Task 58: počisti ostanke prejšnjih crashanih tekov (isti predponi)
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: {
      id: `${PREFIX}loc-${RUN}`,
      name: `${PREFIX}Testna lokacija`,
      code: `RBP2-${RUN.toUpperCase()}`,
      premisesId: `rbac-p2-prem-${RUN}`,
    },
  })
  locId = loc.id
  const owner = await seedEmployee('owner', 'owner', pinOf(1))
  const manager = await seedEmployee('manager', 'manager', pinOf(2))
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(3))
  ownerId = owner.id
  managerId = manager.id
  waiterId = waiter.id
  return {
    owner: tokenFor(owner.id, owner.name, 'OWNER', locId),
    manager: tokenFor(manager.id, manager.name, 'MANAGER', locId),
    waiter: tokenFor(waiter.id, waiter.name, 'WAITER', locId),
  }
}

const setupP = setup()

describe('P2 RBAC — N1: mize (OWNER sme, staff ne)', () => {
  test('OWNER ustvari mizo → 201 (prej 403)', async () => {
    const t = await setupP
    const number = 8000 + Math.floor(Math.random() * 999)
    const res = await tablesPOST(req('/api/tables', t.owner, 'POST', { number, seats: 4 }))
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.table.number).toBe(number)
    const row = await db.table.findUnique({ where: { id: data.table.id } })
    expect(row?.locationId).toBe(locId)
    // pospravi takoj (kasneje DELETE test še enkrat preveri pot)
    await db.table.delete({ where: { id: data.table.id } })
  })

  test('MANAGER ustvari mizo → 201 (invarianta ostaja)', async () => {
    const t = await setupP
    const res = await tablesPOST(req('/api/tables', t.manager, 'POST', { number: 8100 + Math.floor(Math.random() * 99) }))
    expect(res.status).toBe(201)
    await db.table.delete({ where: { id: (await res.json()).table.id } })
  })

  test('WAITER ustvari mizo → 403', async () => {
    const t = await setupP
    const res = await tablesPOST(req('/api/tables', t.waiter, 'POST', { number: 8200 + Math.floor(Math.random() * 99) }))
    expect(res.status).toBe(403)
  })

  test('OWNER izbriše mizo → 200 {deleted} (prej 403 — samo ADMIN)', async () => {
    const t = await setupP
    const table = await db.table.create({ data: { id: `${PREFIX}tbl-${RUN}`, number: 8300, locationId: locId } })
    const res = await tableDELETE(req('/api/tables/nonexistent', t.owner, 'DELETE'), { params: Promise.resolve({ id: table.id }) })
    expect(res.status).toBe(200)
    expect((await res.json()).deleted).toBe(true)
    expect(await db.table.findUnique({ where: { id: table.id } })).toBeNull()
  })

  test('WAITER izbriše mizo → 403', async () => {
    const t = await setupP
    const table = await db.table.create({ data: { id: `${PREFIX}tbl2-${RUN}`, number: 8301, locationId: locId } })
    const res = await tableDELETE(req('/api/tables/x', t.waiter, 'DELETE'), { params: Promise.resolve({ id: table.id }) })
    expect(res.status).toBe(403)
    await db.table.delete({ where: { id: table.id } })
  })
})

describe('P2 RBAC — N2: ročni override statusa in storno naročila', () => {
  test('OWNER ročni PAID override → 409, DB NESPREMENJEN (issue #47: ukinjen — plačilo samo prek kanonične poti)', async () => {
    const t = await setupP
    const order = await seedOrder(1)
    const res = await orderPATCH(req(`/api/orders/${order.id}`, t.owner, 'PATCH', { status: 'PAID' }), { params: Promise.resolve({ id: order.id }) })
    // issue #47: ročni PAID brez Payment/Receipt/EOR/razknjižbe je ukinjen —
    // 409 z usmeritvijo na plačilno pot; naročilo ostane točno takšno, kot je bilo
    expect(res.status).toBe(409)
    expect(String((await res.json()).error)).toContain('ni več podprt')
    const row = await db.order.findUnique({ where: { id: order.id } })
    expect(row?.status).toBe('open')
    expect(row?.paymentStatus).toBe('unpaid')
    expect(row?.paidAt).toBeNull()
  })

  test('WAITER ročno PAID override → 403', async () => {
    const t = await setupP
    const order = await seedOrder(2)
    const res = await orderPATCH(req(`/api/orders/${order.id}`, t.waiter, 'PATCH', { status: 'PAID' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(403)
  })

  test('OWNER storno (DELETE) neplačanega naročila → 200 cancelled (prej 403)', async () => {
    const t = await setupP
    const order = await seedOrder(3)
    const res = await orderDELETE(req(`/api/orders/${order.id}`, t.owner, 'DELETE'), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(200)
    expect((await res.json()).cancelled).toBe(true)
    const row = await db.order.findUnique({ where: { id: order.id } })
    expect(row?.status).toBe('cancelled')
    expect(row?.cancelledById).toBe(ownerId)
  })

  test('WAITER storno (DELETE) → 403', async () => {
    const t = await setupP
    const order = await seedOrder(4)
    const res = await orderDELETE(req(`/api/orders/${order.id}`, t.waiter, 'DELETE'), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(403)
  })

  test('WAITER navaden status (SENT) gre še naprej prek kitchen.update (403 brez pravice, ne blokade vloge)', async () => {
    const t = await setupP
    const order = await seedOrder(5)
    const res = await orderPATCH(req(`/api/orders/${order.id}`, t.waiter, 'PATCH', { status: 'SENT' }), { params: Promise.resolve({ id: order.id }) })
    // waiter NIMA kitchen.update → 403 prek requirePermission (ne zaradi override blokade)
    expect(res.status).toBe(403)
  })
})

describe('P2 RBAC — N7: dodeljevanje vlog zaposlenim', () => {
  test('OWNER dodeli ORG_ADMIN vlogo → 200, DB role org_admin + revizija', async () => {
    const t = await setupP
    const target = await seedEmployee('target1', 'waiter', pinOf(4))
    const res = await employeePATCH(req(`/api/employees/${target.id}`, t.owner, 'PATCH', { role: 'ORG_ADMIN' }), { params: Promise.resolve({ id: target.id }) })
    expect(res.status).toBe(200)
    const row = await db.employee.findUnique({ where: { id: target.id } })
    expect(row?.role).toBe('org_admin')
    // občutljiva akcija MORA ostati revizijsko sledena (protekcije ostanejo)
    const audit = await db.auditLog.findFirst({ where: { action: 'EMPLOYEE_SENSITIVE_UPDATE', entityId: target.id } })
    expect(audit).not.toBeNull()
  })

  test('MANAGER dodeli ORG_ADMIN → 403 (enterprise samo centralnim aktrom)', async () => {
    const t = await setupP
    const target = await seedEmployee('target2', 'waiter', pinOf(5))
    const res = await employeePATCH(req(`/api/employees/${target.id}`, t.manager, 'PATCH', { role: 'ORG_ADMIN' }), { params: Promise.resolve({ id: target.id }) })
    expect(res.status).toBe(403)
    const row = await db.employee.findUnique({ where: { id: target.id } })
    expect(row?.role).toBe('waiter')
  })

  test('MANAGER → ADMIN eskalacija ostane blokirana → 403', async () => {
    const t = await setupP
    const target = await seedEmployee('target3', 'waiter', pinOf(6))
    const res = await employeePATCH(req(`/api/employees/${target.id}`, t.manager, 'PATCH', { role: 'ADMIN' }), { params: Promise.resolve({ id: target.id }) })
    expect(res.status).toBe(403)
    const row = await db.employee.findUnique({ where: { id: target.id } })
    expect(row?.role).toBe('waiter')
  })

  test('MANAGER ne sme urejati ADMIN računa → 403 (protekcija ostane)', async () => {
    const t = await setupP
    const admin = await seedEmployee('admin', 'admin', pinOf(7))
    const res = await employeePATCH(req(`/api/employees/${admin.id}`, t.manager, 'PATCH', { role: 'WAITER' }), { params: Promise.resolve({ id: admin.id }) })
    expect(res.status).toBe(403)
  })

  test('WAITER sploh ne ureja zaposlenih → 403', async () => {
    const t = await setupP
    const target = await seedEmployee('target4', 'waiter', pinOf(8))
    const res = await employeePATCH(req(`/api/employees/${target.id}`, t.waiter, 'PATCH', { role: 'MANAGER' }), { params: Promise.resolve({ id: target.id }) })
    expect(res.status).toBe(403)
  })
})

describe('P2 RBAC — N8: UI dovoljenja zavihkov (fail-closed)', () => {
  test('undefined / prazen / neznan id zavihka → false (prej true)', () => {
    expect(tabHasPerm(undefined, { canManage: false, perms: ['employees.manage'] })).toBe(false)
    expect(tabHasPerm(null, { canManage: false, perms: ['employees.manage'] })).toBe(false)
    expect(tabHasPerm('', { canManage: false, perms: ['employees.manage'] })).toBe(false)
    expect(tabHasPerm('neznan-zavihek', { canManage: false, perms: ['employees.manage'] })).toBe(false)
  })

  test('zavihek Zaposleni brez employees.manage → false; s pravico → true; canManage → true', () => {
    expect(tabHasPerm('zaposleni', { canManage: false, perms: ['orders.create'] })).toBe(false)
    expect(tabHasPerm('zaposleni', { canManage: false, perms: ['employees.manage'] })).toBe(true)
    expect(tabHasPerm('zaposleni', { canManage: true, perms: [] })).toBe(true)
    expect(tabHasPerm('nastavitve', { canManage: false, perms: ['employees.manage'] })).toBe(false)
    expect(tabHasPerm('nastavitve', { canManage: false, perms: ['settings.manage'] })).toBe(true)
  })

  test('zavihki za vse (pregled/delovnicas/odpiralnicas) → true tudi z ozkimi pravicami', () => {
    for (const id of ['pregled', 'delovnicas', 'odpiralnicas']) {
      expect(TAB_PERM[id]).toBe(TAB_PERM_ALL)
      expect(tabHasPerm(id, { canManage: false, perms: ['kitchen.update'] })).toBe(true)
    }
  })

  test('override dovoljenj pravilno preklopi vidnost zavihka', () => {
    // natakar z override dovoljenjem reports.view vidi tudi Račune
    expect(tabHasPerm('racuni', { canManage: false, perms: ['orders.create'] })).toBe(false)
    expect(tabHasPerm('racuni', { canManage: false, perms: ['orders.create', 'reports.view'] })).toBe(true)
  })

  test('vsak vnos TAB_PERM je veljavno kanonično dovoljenje, OR-seznam veljavnih, ALI "*" (OPS-4)', () => {
    const valid = [...CANONICAL_PERMISSIONS, TAB_PERM_ALL]
    for (const [, perm] of Object.entries(TAB_PERM)) {
      if (Array.isArray(perm)) {
        expect(perm.length).toBeGreaterThan(0)
        for (const p of perm) expect(valid).toContain(p)
      } else {
        expect(valid).toContain(perm)
      }
    }
  })

  test('vsak zavihek iz TabsList v page.tsx ima izrecen vnos (regresija N8)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'app', 'dashboard', 'page.tsx'), 'utf8')
    const ids = [...src.matchAll(/\['([a-z]+)', t\('tabs\.[a-z]+'\)/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThanOrEqual(23)
    for (const id of ids) {
      expect(TAB_PERM[id]).toBeDefined()
    }
  })
})

describe('P2 PII — loyalty: maskiranje telefonov', () => {
  test('maskPhone: osnovni primeri', () => {
    expect(maskPhone('+386 401 234 567')).toBe('+386 *** 567')
    expect(maskPhone('041 234 567')).toBe('*** 567')
    expect(maskPhone(null)).toBeNull()
    expect(maskPhone('')).toBeNull()
    expect(maskPhone('123')).toBe('***')
  })

  test('GET /api/loyalty: MANAGER vidi maskiran telefon (poln št. NI v odgovoru)', async () => {
    const t = await setupP
    await db.loyaltyAccount.create({
      data: { id: `${PREFIX}loy-${RUN}`, customerName: `${PREFIX}Gost`, customerPhone: '+386 401 234 567', locationId: locId },
    })
    const res = await loyaltyGET(req('/api/loyalty', t.manager))
    expect(res.status).toBe(200)
    const data = await res.json()
    const mine = (data.accounts as Array<{ id: string; phone: string | null }>).find((a) => a.id === `${PREFIX}loy-${RUN}`)
    expect(mine).toBeDefined()
    expect(mine?.phone).toBe('+386 *** 567')
    // celoten odgovor ne sme vsebovati polne številke v nobeni obliki
    const raw = JSON.stringify(data)
    expect(raw).not.toContain('401 234 567')
    expect(raw).not.toContain('401234567')
  })

  test('GET /api/loyalty: WAITER prav tako vidi maskirano', async () => {
    const t = await setupP
    await db.loyaltyAccount.create({
      data: { id: `${PREFIX}loy2-${RUN}`, customerName: `${PREFIX}Gost 2`, customerPhone: '041 987 654', locationId: locId },
    })
    const res = await loyaltyGET(req('/api/loyalty', t.waiter))
    expect(res.status).toBe(200)
    const data = await res.json()
    const mine = (data.accounts as Array<{ id: string; phone: string | null }>).find((a) => a.id === `${PREFIX}loy2-${RUN}`)
    expect(mine?.phone).toBe('*** 654')
    expect(JSON.stringify(data)).not.toContain('041 987 654')
  })

  test('?full=1 brez settings.manage → 403 (WAITER)', async () => {
    const t = await setupP
    const res = await loyaltyGET(req('/api/loyalty?full=1', t.waiter))
    expect(res.status).toBe(403)
  })

  test('?full=1 s settings.manage (MANAGER) → nezakriti telefon', async () => {
    const t = await setupP
    await db.loyaltyAccount.create({
      data: { id: `${PREFIX}loy3-${RUN}`, customerName: `${PREFIX}Gost 3`, customerPhone: '+386 31 555 777', locationId: locId },
    })
    const res = await loyaltyGET(req('/api/loyalty?full=1', t.manager))
    expect(res.status).toBe(200)
    const data = await res.json()
    const mine = (data.accounts as Array<{ id: string; phone: string | null }>).find((a) => a.id === `${PREFIX}loy3-${RUN}`)
    expect(mine?.phone).toBe('+386 31 555 777')
  })
})
