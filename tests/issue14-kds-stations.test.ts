/**
 * Issue #14 (P1/P2, v1.112.0) — KDS poimenovane pripravljalne postaje,
 * usmerjanje modifikatorjev in izdajna postaja.
 *
 * Pokritost (spec §Testi):
 *  A. MOTOR (čiste funkcije, kds-station-routing.ts — brez DB): stationViewKey
 *     (bar/kitchen legacy vedri, custom tip → lastni pogled), buildTaskPlan
 *     (primarna+dodatne, opcija na drugi postaji BREZ podvajanja, opcija na
 *     postaji artikla → detail, expo-only postaja brez nepotrebnih korakov,
 *     prep+expo postaja dobe SVOJ korak + izdajo, zaporedna blokada B za A,
 *     opcije nikoli ne blokirajo, privzeta kuhinja, dedup, neaktivne
 *     preskočene), itemStatusFromTasks (rollup), isTaskBlocked,
 *     taskTransitionFrom (avtomat naloge).
 *  B. CRUD /api/prep-stations: POST 201 (manager), duplikat imena 409,
 *     slab tip 400, RBAC (natakar brez settings.manage 403, brez žetona 401),
 *     GET seznam (kitchen.update) z menuItemCount + ?active=true filter,
 *     PATCH urejanje/409, tuja lokacija 403, DELETE z aktivnimi nalogami 409,
 *     DELETE čiste postaje + počisti MenuItemStation/Modifier usmeritve.
 *  C. FIRE → NALOGE: fire ustvari naloge (prep Žar + modifier Solate + expo),
 *     posnetki imen/tipov/sequence, detail opcij + opomba postavke, idempotenca
 *     (ponoven fire ne podvoji; servisna raven: obstoječe (postavka × postaja)
 *     preskoči), finance NEDOTAKNJENE (cena/količina/vsote brez podvajanja),
 *     GET /api/kitchen additive polja (stations/tasks/stationStats + target
 *     PO postaji), lokacija BREZ konfiguracije → 0 nalog (čisti legacy).
 *  D. POSTAJNI TOK (PATCH /api/kitchen {taskId}): zaporedje (expo start čaka
 *     na predhodnico → 409 blockedBy), start → preparing, neveljaven prehod
 *     409, ready z žigi + rollup postavke, replay → 200 already (brez dvojne
 *     spremembe), izdaja samo expo (409 na prep), izdaja pred končano pripravo
 *     409, izdaja po pripravi → done + postavka 'served' + naloge done +
 *     naročilo 'prepared', RBAC (natakar 403), tuja lokacija 403, neznan
 *     taskId 404, slab action 400, brez žetona 401, revizija STATION_TASK_*.
 *  E. LEGACY SOBIVANJE: postavka Z nalogami prek stare poti → 409 (razen
 *     SERVED po zaključku — spravi naloge v done), postavka BREZ nalog →
 *     stara pot nedotaknjena (PREPARING 200).
 *  F. USMERJANJE (rute): menus/[id] prepStationId/stationIds strežniško
 *     preverjeni na lokacijo (tuja postaja 400), duplikati/prazni vnosi 400,
 *     največ 8 dodatnih 400, replace-set semantika (stationIds zamenja nabor),
 *     prepStationId null počisti, POST menus z usmeritvijo 201; modifiers/[id]
 *     prepStationId usmeritev opcije (brez dotika alergenov), tuja postaja 400,
 *     null počisti.
 *  G. DDL + REGISTER + DRIFT: register vnos kds-stations, idempotentna DDL
 *     ruta (bootstrap 200 alreadyApplied, manager 403), isKdsStationsStatement
 *     matcher, classifyDrift (znani stavki niso unexpected).
 *  H. STATISTIKA PO POSTAJI: /api/kitchen/stats perStation (count/avgMin/
 *     target PO postaji — prag zamude po pravem cilju, ne skupno povprečje).
 *
 * Fiksture s predpono i14- (lokaciji A/B, vsaka v svoji organizacijski verigi —
 * D10 potrebuje obe znani verigi za cross-tenant 403). Lokacija B nima NOBENE
 * postaje (čisti legacy). Vsi direktni zapisi imajo id s predpono; naloge iz
 * fire rute imajo nid() id (počisti jih lokacijski prehod fixture-sweep).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  EXPO_SEQUENCE,
  buildTaskPlan,
  stationViewKey,
  itemStatusFromTasks,
  isTaskBlocked,
  taskTransitionFrom,
  type StationRef,
} from '../src/lib/kds-station-routing'
import { createStationTasksForItems } from '../src/lib/station-task-service'
import { GET as stationListGET, POST as stationPOST } from '../src/app/api/prep-stations/route'
import { PATCH as stationIdPATCH, DELETE as stationIdDELETE } from '../src/app/api/prep-stations/[id]/route'
import { GET as kitchenGET, PATCH as kitchenPATCH } from '../src/app/api/kitchen/route'
import { POST as firePOST } from '../src/app/api/orders/[id]/fire/route'
import { GET as statsGET } from '../src/app/api/kitchen/stats/route'
import { POST as menuPOST } from '../src/app/api/menus/route'
import { PATCH as menuIdPATCH } from '../src/app/api/menus/[id]/route'
import { PATCH as modifierIdPATCH } from '../src/app/api/modifiers/[id]/route'
import { POST as migratePOST } from '../src/app/api/admin/migrate-kds-stations/route'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { classifyDrift, isKdsStationsStatement } from '../scripts/drift-check'

const P = 'i14-'
const RUN = Date.now().toString(36)

let locA = ''
let locB = ''
let tokMgrA = ''
let tokChefA = ''
let tokWaiterA = ''
let tokMgrB = ''
let tokChefB = ''
// issue #72 C1: CRUD postaj = settings.manage → MANAGER nima več →
// property_manager (ne-centralen, poln nabor) na obeh lokacijah
let tokPmA = ''
let tokPmB = ''

let stSalad = ''
let stGrill = ''
let stExpo = ''
let stAssemble = ''
let stInactive = ''
let stForeignB = ''

let catAId = ''
let burgerAId = ''
let modPopecnoId = ''
let modAuxId = ''

let orderAId = ''
let item1Id = ''
let orderA2Id = ''
let item2Id = ''
let orderBId = ''
let itemBId = ''

// naloge iz fire-a (idji se poiščejo po DB — nid() random)
let tSaladId = ''
let tGrillId = ''
let tExpoId = ''
let t2GrillId = ''
let testStationId = '' // postaja iz B1 (nid() id — API jo ustvari brez predpone)

let ordSeq = 914000

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(method: string, url: string, token?: string, bodyData?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: bodyData === undefined ? undefined : JSON.stringify(bodyData),
  })
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

async function seedEmp(tag: string, role: string, loc: string, overrides: string[] = []): Promise<string> {
  const id = `${P}emp-${tag}-${RUN}`
  const email = `${P}${tag}-${RUN}@test.local`
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const f = employeePinFields(pin, email)
  await db.employee.create({
    data: { id, name: `${P}${tag}`, email, role, status: 'active', sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup, ...(overrides.length ? { permissionOverrides: JSON.stringify(overrides) } : {}) },
  })
  return id
}

async function newLoc(tag: string): Promise<string> {
  const id = `${P}loc${tag}-${RUN}`
  await db.location.create({ data: { id, code: `${P}L${tag}${RUN}`, name: `${P}Lok ${tag}`, premisesId: `${P}prem${tag}-${RUN}` } })
  return id
}

/** Lokacija v lastni organizacijski verigi (cross-tenant 403 potrebuje obe znani verigi). */
async function bindOrg(tag: string, locId: string): Promise<void> {
  const orgId = `${P}org${tag}-${RUN}`
  await db.organization.create({ data: { id: orgId, name: `${P}Org ${tag}`, slug: `${P}org${tag}-${RUN}` } })
  const brandId = `${P}brand${tag}-${RUN}`
  await db.brand.create({ data: { id: brandId, organizationId: orgId, name: `${P}Brand ${tag}` } })
  const propertyId = `${P}prop${tag}-${RUN}`
  await db.property.create({ data: { id: propertyId, brandId, name: `${P}Prop ${tag}` } })
  await db.location.update({ where: { id: locId }, data: { propertyId } })
}

async function seedStation(tag: string, name: string, type: string, sortOrder: number, avgPrepTime: number, opts: { isExpo?: boolean; isActive?: boolean } = {}): Promise<string> {
  const id = `${P}st-${tag}-${RUN}`
  await db.prepStation.create({
    data: { id, name: `${P}${name}`, type, avgPrepTime, sortOrder, isExpo: opts.isExpo ?? false, isActive: opts.isActive ?? true, locationId: locA },
  })
  return id
}

async function seedOrder(loc: string, suffix: string): Promise<string> {
  const id = `${P}ord-${suffix}-${RUN}`
  await db.order.create({
    data: {
      id, orderNumber: ++ordSeq, locationId: loc, tableId: null,
      status: 'open', paymentStatus: 'unpaid', subtotal: 0, tax: 0, total: 0,
    },
  })
  return id
}

async function seedItem(orderId: string, suffix: string, opts: { qty?: number; price?: number; notes?: string } = {}): Promise<string> {
  const id = `${P}itm-${suffix}-${RUN}`
  await db.orderItem.create({
    data: {
      id, orderId, menuItemId: burgerAId, quantity: opts.qty ?? 1,
      price: opts.price ?? 8.5, vatRate: 22, vatAmount: 0,
      menuItemName: 'Burger i14', status: 'pending', voided: false,
      notes: opts.notes ?? '',
    },
  })
  return id
}

/** Naloge postavke (fire jih ustvari z nid() id — poišče po orderItemId). */
async function tasksOf(orderItemId: string): Promise<{ id: string; stationId: string; kind: string; status: string; sequence: number; stationName: string; detail: string; title: string; quantity: number; stationType: string }[]> {
  return db.stationTask.findMany({
    where: { orderItemId },
    select: { id: true, stationId: true, kind: true, status: true, sequence: true, stationName: true, detail: true, title: true, quantity: true, stationType: true, startedAt: true, readyAt: true, issuedAt: true, readyByName: true, issuedByName: true },
    orderBy: { sequence: 'asc' },
  })
}

beforeAll(async () => {
  locA = await newLoc('A')
  locB = await newLoc('B')
  await bindOrg('A', locA)
  await bindOrg('B', locB)

  const mgrAId = await seedEmp('mgrA', 'manager', locA)
  const chefAId = await seedEmp('chefA', 'kitchen', locA)
  const waiterAId = await seedEmp('waiterA', 'waiter', locA)
  const mgrBId = await seedEmp('mgrB', 'manager', locB)
  const chefBId = await seedEmp('chefB', 'kitchen', locB)
  // ISSUE #75 5.1: property_manager = Razširjena raven; testni namen (ne-centralen
  // settings.manage za prep-stations) izrecen prek centralno podeljenega override-a
  const pmAId = await seedEmp('pmA', 'property_manager', locA, ['settings.manage'])
  const pmBId = await seedEmp('pmB', 'property_manager', locB, ['settings.manage'])
  tokMgrA = tok(mgrAId, `${P}mgrA`, 'MANAGER', locA)
  tokChefA = tok(chefAId, `${P}chefA`, 'KITCHEN', locA)
  tokWaiterA = tok(waiterAId, `${P}waiterA`, 'WAITER', locA)
  tokMgrB = tok(mgrBId, `${P}mgrB`, 'MANAGER', locB)
  tokChefB = tok(chefBId, `${P}chefB`, 'KITCHEN', locB)
  tokPmA = tok(pmAId, `${P}pmA`, 'PROPERTY_MANAGER', locA)
  tokPmB = tok(pmBId, `${P}pmB`, 'PROPERTY_MANAGER', locB)

  // postaje lokacije A: solate (sort 1 — VZPOREDNO bočno delo opcije), žar
  // (sort 2 — primarna burgerja), sestava (DELETE testi), izdaja (sort 50),
  // neaktivna (GET filter test). Tipi 'salad'/'grill' = POIMENOVANE postaje.
  stSalad = await seedStation('salad', 'Solate', 'salad', 1, 6)
  stGrill = await seedStation('grill', 'Žar', 'grill', 2, 12)
  stAssemble = await seedStation('sestav', 'Sestava', 'assemble', 3, 5)
  stExpo = await seedStation('izdaja', 'Izdaja', 'expo', 50, 3, { isExpo: true })
  stInactive = await seedStation('neaktiv', 'Neaktivna', 'fry', 60, 10, { isActive: false })

  // meni veriga A + burger s primarno postajo Žar
  const menuAId = `${P}menu-${RUN}`
  await db.menu.create({ data: { id: menuAId, name: `${P}Meni`, locationId: locA } })
  catAId = `${P}cat-${RUN}`
  await db.category.create({ data: { id: catAId, name: `${P}Jedi`, menuId: menuAId } })
  burgerAId = `${P}mi-burger-${RUN}`
  await db.menuItem.create({ data: { id: burgerAId, name: 'Burger i14', price: 8.5, categoryId: catAId, prepStationId: stGrill } })

  // opcija 'Popečeno' usmerjena na postajo SOLATE (druga postaja od artikla)
  const mgAId = `${P}mg-${RUN}`
  await db.modifierGroup.create({ data: { id: mgAId, name: `${P}Dodatki`, locationId: locA } })
  modPopecnoId = `${P}mod-popecno-${RUN}`
  await db.modifier.create({ data: { id: modPopecnoId, name: 'Popečeno', price: 0.5, modifierGroupId: mgAId, prepStationId: stSalad } })
  modAuxId = `${P}mod-aux-${RUN}`
  await db.modifier.create({ data: { id: modAuxId, name: 'Pomfri', price: 1, modifierGroupId: mgAId, prepStationId: stAssemble } })

  // naročila: A (glavni tok) + A2 (RBAC/tenant testi) + B (čisti legacy)
  orderAId = await seedOrder(locA, 'a1')
  item1Id = await seedItem(orderAId, 'i1', { qty: 2, notes: 'brez čebule' })
  await db.orderItemModifier.create({ data: { id: `${P}oim1-${RUN}`, orderItemId: item1Id, name: 'Popečeno', price: 0.5, modifierGroupId: mgAId } })
  orderA2Id = await seedOrder(locA, 'a2')
  item2Id = await seedItem(orderA2Id, 'i2', { qty: 1 })
  orderBId = await seedOrder(locB, 'b1')
  itemBId = await seedItem(orderBId, 'b1', { qty: 1, price: 4 })

  await db.order.update({ where: { id: orderAId }, data: { subtotal: 18, tax: 3.96, total: 21.96 } })
})

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})

/* ═══════════════ A. ČISTI MOTOR (brez DB) ═══════════════ */

describe('A. motor — stationViewKey', () => {
  it('A1: bar/kitchen ohranita LEGACY vedra; custom tip dobi lastni pogled (id)', () => {
    expect(stationViewKey({ id: 'st1', type: 'bar' })).toBe('BAR')
    expect(stationViewKey({ id: 'st2', type: 'kitchen' })).toBe('KITCHEN')
    expect(stationViewKey({ id: 'st3', type: 'BAR' })).toBe('BAR')
    expect(stationViewKey({ id: 'st4', type: 'Kitchen' })).toBe('KITCHEN')
    expect(stationViewKey({ id: 'st5', type: 'grill' })).toBe('st5')
    expect(stationViewKey({ id: 'st6', type: 'salad' })).toBe('st6')
  })
})

describe('A. motor — buildTaskPlan', () => {
  const grill: StationRef = { id: 'g1', name: 'Žar', type: 'grill', avgPrepTime: 12, sortOrder: 2, isExpo: false, isActive: true }
  const salad: StationRef = { id: 's1', name: 'Solate', type: 'salad', avgPrepTime: 6, sortOrder: 1, isExpo: false, isActive: true }
  const assemble: StationRef = { id: 'a1', name: 'Sestava', type: 'assemble', avgPrepTime: 5, sortOrder: 3, isExpo: false, isActive: true }
  const expo: StationRef = { id: 'e1', name: 'Izdaja', type: 'expo', avgPrepTime: 3, sortOrder: 50, isExpo: true, isActive: true }
  const kitchen: StationRef = { id: 'k1', name: 'Kuhinja', type: 'kitchen', avgPrepTime: 10, sortOrder: 4, isExpo: false, isActive: true }

  it('A2: primarna postaja + izdajna → 2 nalogi (prep pending, expo waiting); posnetki', () => {
    const plan = buildTaskPlan({ stations: [salad, grill, expo], primaryStationId: 'g1', extraStationIds: [], modifierStations: [], title: 'Burger', quantity: 2 })
    expect(plan).toHaveLength(2)
    expect(plan[0]).toMatchObject({ stationId: 'g1', stationName: 'Žar', stationType: 'grill', kind: 'prep', status: 'pending', title: 'Burger', quantity: 2 })
    expect(plan[1]).toMatchObject({ stationId: 'e1', kind: 'expo', status: 'waiting', sequence: EXPO_SEQUENCE })
  })

  it('A3: opcija na DRUGI postaji → naloga kind modifier (brez podvajanja postavke/cene)', () => {
    const plan = buildTaskPlan({ stations: [salad, grill, expo], primaryStationId: 'g1', extraStationIds: [], modifierStations: [{ stationId: 's1', names: ['Popečeno'] }], title: 'Burger', quantity: 2 })
    expect(plan).toHaveLength(3)
    const mod = plan.find((t) => t.kind === 'modifier')
    expect(mod).toMatchObject({ stationId: 's1', detail: 'Popečeno', quantity: 2 })
    // ENA sama pripravljalna naloga na žaru (postavka se NI podvojila)
    expect(plan.filter((t) => t.kind === 'prep')).toHaveLength(1)
  })

  it('A4: opcija na postaji ARTIKLA → detail obstoječe naloge (brez nove vrstice)', () => {
    const plan = buildTaskPlan({ stations: [salad, grill, expo], primaryStationId: 'g1', extraStationIds: [], modifierStations: [{ stationId: 'g1', names: ['Dodatek'] }], title: 'Burger', quantity: 1 })
    expect(plan).toHaveLength(2)
    expect(plan.find((t) => t.kind === 'prep')?.detail).toBe('Dodatek')
    expect(plan.filter((t) => t.kind === 'modifier')).toHaveLength(0)
  })

  it('A5: postaja, ki je SAMO izdajna, ne dobi koraka priprave', () => {
    const plan = buildTaskPlan({ stations: [grill, expo], primaryStationId: 'g1', extraStationIds: [], modifierStations: [], title: 'Burger', quantity: 1 })
    expect(plan.filter((t) => t.stationId === 'e1')).toHaveLength(1)
    expect(plan.find((t) => t.stationId === 'e1')?.kind).toBe('expo')
    expect(plan.find((t) => t.stationId === 'g1')?.kind).toBe('prep')
  })

  it('A6: postaja prep+expo dobe SVOJ pripravljalni korak IN izdajo (2 vrstici, isti stationId)', () => {
    const both: StationRef = { ...grill, isExpo: true }
    const plan = buildTaskPlan({ stations: [both], primaryStationId: 'g1', extraStationIds: [], modifierStations: [], title: 'Burger', quantity: 1 })
    expect(plan).toHaveLength(2)
    expect(plan.filter((t) => t.stationId === 'g1').map((t) => t.kind).sort()).toEqual(['expo', 'prep'])
  })

  it('A7: zaporedna pot — B čaka (waiting), dokler A ni končana; opcije so VZPOREDNE', () => {
    const plan = buildTaskPlan({ stations: [salad, grill, assemble, expo], primaryStationId: 'g1', extraStationIds: ['a1'], modifierStations: [{ stationId: 's1', names: ['Popečeno'] }], title: 'Burger', quantity: 1 })
    const g = plan.find((t) => t.stationId === 'g1')!
    const a = plan.find((t) => t.stationId === 'a1')!
    const s = plan.find((t) => t.kind === 'modifier')!
    const e = plan.find((t) => t.kind === 'expo')!
    // žar (seq 2) NI blokirana z opcijo na solatah (seq 1, kind modifier)
    expect(g.status).toBe('pending')
    // sestava (seq 3 > 2) čaka na žar
    expect(a.status).toBe('waiting')
    // opcija na solatah (seq 1) je vzporedna — ni blokirana
    expect(s.status).toBe('pending')
    // izdaja čaka na vse pripravne korake
    expect(e.status).toBe('waiting')
  })

  it('A8: brez usmeritve → privzeta prva AKTIVNA kuhinja; brez nje → brez nalog', () => {
    const plan = buildTaskPlan({ stations: [salad, grill, kitchen, expo], primaryStationId: null, extraStationIds: [], modifierStations: [], title: 'Jed', quantity: 1 })
    expect(plan.map((t) => t.stationId)).toEqual(['k1', 'e1'])
    expect(plan.map((t) => t.kind)).toEqual(['prep', 'expo'])

    const plan2 = buildTaskPlan({ stations: [salad, grill], primaryStationId: null, extraStationIds: [], modifierStations: [], title: 'Jed', quantity: 1 })
    expect(plan2).toHaveLength(0)
  })

  it('A9: dedup (primarna = dodatna) in NEAKTIVNE postaje so preskočene', () => {
    const plan = buildTaskPlan({ stations: [grill, expo], primaryStationId: 'g1', extraStationIds: ['g1'], modifierStations: [], title: 'Jed', quantity: 1 })
    expect(plan.filter((t) => t.stationId === 'g1' && t.kind === 'prep')).toHaveLength(1)

    const inactiveSalad: StationRef = { ...salad, isActive: false }
    const plan2 = buildTaskPlan({ stations: [inactiveSalad, grill], primaryStationId: 'g1', extraStationIds: ['s1'], modifierStations: [{ stationId: 's1', names: ['X'] }], title: 'Jed', quantity: 1 })
    expect(plan2.map((t) => t.stationId)).toEqual(['g1'])
    expect(plan2.filter((t) => t.kind === 'modifier')).toHaveLength(0)
  })
})

describe('A. motor — rollup + prehodi', () => {
  it('A10: itemStatusFromTasks — served/ready/preparing/fired/null', () => {
    expect(itemStatusFromTasks([])).toBeNull()
    expect(itemStatusFromTasks([{ kind: 'prep', status: 'done' }, { kind: 'expo', status: 'done' }])).toBe('served')
    expect(itemStatusFromTasks([{ kind: 'prep', status: 'ready' }, { kind: 'expo', status: 'ready' }])).toBe('ready')
    expect(itemStatusFromTasks([{ kind: 'prep', status: 'preparing' }, { kind: 'expo', status: 'waiting' }])).toBe('preparing')
    expect(itemStatusFromTasks([{ kind: 'prep', status: 'pending' }, { kind: 'expo', status: 'waiting' }])).toBe('fired')
    expect(itemStatusFromTasks([{ kind: 'prep', status: 'ready' }, { kind: 'expo', status: 'waiting' }])).toBe('fired')
  })

  it('A11: isTaskBlocked — strogo manjši sequence, ne-opcijske, ne-terminalne', () => {
    const task = { sequence: 3, kind: 'prep' }
    expect(isTaskBlocked(task, [{ sequence: 2, kind: 'prep', status: 'ready' }])).toBe(false)
    expect(isTaskBlocked(task, [{ sequence: 2, kind: 'prep', status: 'done' }])).toBe(false)
    expect(isTaskBlocked(task, [{ sequence: 2, kind: 'prep', status: 'pending' }])).toBe(true)
    expect(isTaskBlocked(task, [{ sequence: 2, kind: 'modifier', status: 'pending' }])).toBe(false)
    expect(isTaskBlocked(task, [{ sequence: 3, kind: 'prep', status: 'pending' }])).toBe(false)
    expect(isTaskBlocked(task, [{ sequence: 4, kind: 'prep', status: 'pending' }])).toBe(false)
  })

  it('A12: taskTransitionFrom — dovoljeni prehodi; neznan action → null', () => {
    expect(taskTransitionFrom('start')).toEqual({ allowedFrom: ['pending'], to: 'preparing' })
    expect(taskTransitionFrom('ready')).toEqual({ allowedFrom: ['pending', 'preparing'], to: 'ready' })
    expect(taskTransitionFrom('issue')).toEqual({ allowedFrom: ['pending', 'waiting'], to: 'done' })
    expect(taskTransitionFrom('bogus' as 'start')).toBeNull()
  })
})

/* ═══════════════ B. CRUD /api/prep-stations ═══════════════ */

describe('B. CRUD postaj', () => {
  it('B1: POST (pm — settings.manage) ustvari poimenovano postajo — 201 + audit', async () => {
    const res = await stationPOST(req('POST', '/api/prep-stations', tokPmA, { name: 'i14 Testna', type: 'test', avgPrepTime: 7, sortOrder: 4 }))
    expect(res.status).toBe(201)
    const j = await body(res)
    expect(j.station).toMatchObject({ name: 'i14 Testna', type: 'test', avgPrepTime: 7, sortOrder: 4, isExpo: false, isActive: true })
    testStationId = (j.station as { id: string }).id
    const audit = await db.auditLog.count({ where: { action: 'PREP_STATION_CREATE', locationId: locA } })
    expect(audit).toBeGreaterThanOrEqual(1)
  })

  it('B2: POST duplikat imena na lokaciji → 409', async () => {
    const res = await stationPOST(req('POST', '/api/prep-stations', tokPmA, { name: 'i14 Testna', type: 'test' }))
    expect(res.status).toBe(409)
  })

  it('B3: POST slab tip → 400', async () => {
    const res = await stationPOST(req('POST', '/api/prep-stations', tokPmA, { name: 'i14 Slaba', type: 'UPPER!' }))
    expect(res.status).toBe(400)
  })

  it('B4: RBAC — natakar (brez settings.manage) 403; brez žetona 401', async () => {
    const res403 = await stationPOST(req('POST', '/api/prep-stations', tokWaiterA, { name: 'i14 Prepoved', type: 'test' }))
    expect(res403.status).toBe(403)
    const res401 = await stationPOST(req('POST', '/api/prep-stations'))
    expect(res401.status).toBe(401)
  })

  it('B5: GET seznam (kitchen.update) — menuItemCount + vključi neaktivne; ?active=true jih skrije; natakar 403', async () => {
    const res = await stationListGET(req('GET', '/api/prep-stations', tokChefA))
    expect(res.status).toBe(200)
    const j = await body(res)
    const stations = j.stations as { id: string; menuItemCount: number; isActive: boolean }[]
    const grillRow = stations.find((s) => s.id === stGrill)
    expect(grillRow).toBeDefined()
    expect(grillRow!.menuItemCount).toBe(1) // burger i14 → Žar
    expect(stations.find((s) => s.id === stInactive)).toBeDefined()

    const resActive = await stationListGET(req('GET', '/api/prep-stations?active=true', tokChefA))
    const jActive = await body(resActive)
    expect((jActive.stations as { id: string }[]).find((s) => s.id === stInactive)).toBeUndefined()

    const resWaiter = await stationListGET(req('GET', '/api/prep-stations', tokWaiterA))
    expect(resWaiter.status).toBe(403)
  })

  it('B6: PATCH preimenovanje uredi; duplikat imena (izvzemajoč sebe) 409', async () => {
    const res = await stationIdPATCH(req('PATCH', `/api/prep-stations/${stGrill}`, tokPmA, { name: 'i14-Žar 2', avgPrepTime: 13 }), { params: Promise.resolve({ id: stGrill }) })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.station).toMatchObject({ name: 'i14-Žar 2', avgPrepTime: 13 })
    await db.prepStation.update({ where: { id: stGrill }, data: { name: 'i14-Žar', avgPrepTime: 12 } })

    const dupe = await stationIdPATCH(req('PATCH', `/api/prep-stations/${stGrill}`, tokPmA, { name: 'i14-Solate' }), { params: Promise.resolve({ id: stGrill }) })
    expect(dupe.status).toBe(409)
  })

  it('B7: PATCH tuje lokacije (pm B) → 403 (tenant varovalka)', async () => {
    const res = await stationIdPATCH(req('PATCH', `/api/prep-stations/${stGrill}`, tokPmB, { avgPrepTime: 20 }), { params: Promise.resolve({ id: stGrill }) })
    expect(res.status).toBe(403)
  })
})

/* ═══════════════ C. FIRE → NALOGE ═══════════════ */

describe('C. fire razreši usmerjanje v naloge', () => {
  it('C1: fire ustvari 3 naloge (prep Žar + modifier Solate + Izdaja) s posnetki', async () => {
    const res = await firePOST(req('POST', `/api/orders/${orderAId}/fire`, tokMgrA, {}), { params: Promise.resolve({ id: orderAId }) })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.firedCount).toBe(1)
    expect(j.stationTasks).toBe(3)

    const tasks = await tasksOf(item1Id)
    expect(tasks).toHaveLength(3)
    const salad = tasks.find((t) => t.stationId === stSalad)!
    const grill = tasks.find((t) => t.stationId === stGrill)!
    const expo = tasks.find((t) => t.stationId === stExpo)!
    expect(salad).toMatchObject({ kind: 'modifier', status: 'pending', sequence: 1, stationName: 'i14-Solate', stationType: 'salad' })
    expect(grill).toMatchObject({ kind: 'prep', status: 'pending', sequence: 2, quantity: 2, title: 'Burger i14' })
    expect(expo).toMatchObject({ kind: 'expo', status: 'waiting', sequence: EXPO_SEQUENCE })
    // posnetek imena postaje (preimenovanje kasneje ne spremeni zgodovine)
    expect(grill.stationName).toBe('i14-Žar')
    // opcija → detail naloge; opomba postavke pripisana
    expect(salad.detail).toContain('Popečeno')
    expect(grill.detail).toContain('brez čebule')
    tSaladId = salad.id
    tGrillId = grill.id
    tExpoId = expo.id
  })

  it('C2: finance nedotaknjene — cena/količina/vsote brez podvajanja', async () => {
    const item = await db.orderItem.findUnique({ where: { id: item1Id } })
    expect(Number(item?.price)).toBe(8.5)
    expect(item?.quantity).toBe(2)
    const order = await db.order.findUnique({ where: { id: orderAId } })
    expect(Number(order?.subtotal)).toBe(18)
    expect(Number(order?.total)).toBe(21.96)
    const count = await db.orderItem.count({ where: { orderId: orderAId } })
    expect(count).toBe(1)
  })

  it('C3: idempotenca — ponoven fire ne podvoji nalog; servis preskoči obstoječe (postavka × postaja)', async () => {
    const res = await firePOST(req('POST', `/api/orders/${orderAId}/fire`, tokMgrA, {}), { params: Promise.resolve({ id: orderAId }) })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.alreadyFired).toBe(true)
    expect(await db.stationTask.count({ where: { orderItemId: item1Id } })).toBe(3)

    const row = await db.orderItem.findUnique({ where: { id: item1Id }, select: { id: true, orderId: true, menuItemId: true, menuItemName: true, quantity: true, notes: true } })
    const again = await db.$transaction(async (tx) =>
      createStationTasksForItems(tx, { locationId: locA, orderId: orderAId, items: [{ ...row!, notes: row!.notes ?? '' }], firedAt: new Date() }))
    expect(again).toBe(0)
    expect(await db.stationTask.count({ where: { orderItemId: item1Id } })).toBe(3)
  })

  it('C4: fire drugega naročila (a2, brez opcij) — 2 nalogi za RBAC/tenant teste', async () => {
    const res = await firePOST(req('POST', `/api/orders/${orderA2Id}/fire`, tokMgrA, {}), { params: Promise.resolve({ id: orderA2Id }) })
    expect(res.status).toBe(200)
    expect(await db.stationTask.count({ where: { orderItemId: item2Id } })).toBe(2)
    t2GrillId = (await tasksOf(item2Id)).find((t) => t.stationId === stGrill)!.id
  })

  it('C5: GET /api/kitchen — additive polja: stations/tasks/stationStats s targetom PO postaji', async () => {
    const res = await kitchenGET(req('GET', '/api/kitchen', tokChefA))
    expect(res.status).toBe(200)
    const j = await body(res)
    const stations = j.stations as { id: string; isExpo: boolean; avgPrepTime: number }[]
    expect(stations.map((s) => s.id).sort()).toEqual([stAssemble, stExpo, stGrill, stSalad, testStationId].sort())
    expect(stations.find((s) => s.id === stExpo)?.isExpo).toBe(true)

    const tasks = j.tasks as { id: string; viewKey: string; stationId: string; kind: string; status: string; orderNumber: number | null; quantity: number }[]
    const mine = tasks.filter((t) => t.id === tGrillId || t.id === tSaladId || t.id === tExpoId)
    expect(mine).toHaveLength(3)
    expect(mine.find((t) => t.id === tSaladId)?.viewKey).toBe(stSalad)
    expect(mine.find((t) => t.id === tGrillId)?.viewKey).toBe(stGrill)
    expect(mine.find((t) => t.id === tGrillId)?.quantity).toBe(2)

    const stats = j.stationStats as { stationId: string; pending: number; waiting: number; target: number | null }[]
    expect(stats.find((s) => s.stationId === stGrill)?.pending).toBeGreaterThanOrEqual(1)
    expect(stats.find((s) => s.stationId === stExpo)?.waiting).toBeGreaterThanOrEqual(1)
    expect(stats.find((s) => s.stationId === stGrill)?.target).toBe(12)
    expect(stats.find((s) => s.stationId === stSalad)?.target).toBe(6)
  })

  it('C6: lokacija BREZ postaj → fire brez nalog (čisti legacy tok)', async () => {
    const res = await firePOST(req('POST', `/api/orders/${orderBId}/fire`, tokMgrB, {}), { params: Promise.resolve({ id: orderBId }) })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.firedCount).toBe(1)
    expect(j.stationTasks).toBe(0)
    const item = await db.orderItem.findUnique({ where: { id: itemBId } })
    expect(item?.status).toBe('fired')
    expect(await db.stationTask.count({ where: { orderId: orderBId } })).toBe(0)
  })
})

/* ═══════════════ D. POSTAJNI TOK (PATCH /api/kitchen taskId) ═══════════════ */

describe('D. postajni tok — avtomat naloge', () => {
  it('D1: start čakajoče izdajne naloge (blokirana predhodnica) → 409 + blockedBy', async () => {
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: tExpoId, action: 'start' }))
    expect(res.status).toBe(409)
    const j = await body(res)
    expect((j.error as string)).toContain('Predhodna postaja')
    const blockedBy = j.blockedBy as { stationName: string; status: string }[]
    expect(blockedBy.some((b) => b.stationName === 'i14-Žar' && b.status === 'pending')).toBe(true)
  })

  it('D2: start prve naloge → preparing + startedAt; replay start → 200 already (idempotenca); neveljaven prehod 409', async () => {
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: tGrillId, action: 'start' }))
    expect(res.status).toBe(200)
    const j = await body(res)
    expect((j.task as { status: string }).status).toBe('preparing')
    const row = await db.stationTask.findUnique({ where: { id: tGrillId } })
    expect(row?.startedAt).toBeDefined()

    // ponovni start istega stanja = REPLAY (sočasen dvojni klik → ENA sprememba)
    const again = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: tGrillId, action: 'start' }))
    expect(again.status).toBe(200)
    const jAgain = await body(again)
    expect(jAgain.already).toBe(true)

    // neveljaven prehod: ready na čakajoči (waiting) nalogi → 409
    const invalid = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: tExpoId, action: 'ready' }))
    expect(invalid.status).toBe(409)
  })

  it('D3: vzporedna opcija — ready iz pending na solatah medtem ko žar dela', async () => {
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: tSaladId, action: 'ready' }))
    expect(res.status).toBe(200)
    const row = await db.stationTask.findUnique({ where: { id: tSaladId } })
    expect(row?.status).toBe('ready')
  })

  it('D4: izdaja PREJ končane priprave → 409 (blokirniki vseh postaj); izdaja na NE-izdajni nalogi → 409', async () => {
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: tExpoId, action: 'issue' }))
    expect(res.status).toBe(409)
    const j = await body(res)
    expect((j.error as string)).toContain('Priprava na postajah')

    const nonExpo = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: tGrillId, action: 'issue' }))
    expect(nonExpo.status).toBe(409)
    const j2 = await body(nonExpo)
    expect((j2.error as string)).toContain('izdajni postaji')
  })

  it('D5: ready na žaru → žigi readyAt/readyByName + rollup postavke', async () => {
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: tGrillId, action: 'ready' }))
    expect(res.status).toBe(200)
    const row = await db.stationTask.findUnique({ where: { id: tGrillId } })
    expect(row?.status).toBe('ready')
    expect(row?.readyAt).toBeDefined()
    expect(row?.readyByName).toBe('i14-chefA')
    // izdaja še čaka → postavka še ni served
    const item = await db.orderItem.findUnique({ where: { id: item1Id } })
    expect(item?.status).not.toBe('served')
  })

  it('D6: replay — ready že ready naloge → 200 already, žig NESPREMENJEN', async () => {
    const before = await db.stationTask.findUnique({ where: { id: tGrillId } })
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: tGrillId, action: 'ready' }))
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.already).toBe(true)
    const after = await db.stationTask.findUnique({ where: { id: tGrillId } })
    expect(after?.readyAt?.getTime()).toBe(before?.readyAt?.getTime())
  })

  it('D7: izdaja po končani pripravi → done, postavka served, naloge done, naročilo prepared, revizija', async () => {
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: tExpoId, action: 'issue' }))
    expect(res.status).toBe(200)
    const j = await body(res)
    expect((j.task as { status: string }).status).toBe('done')
    expect(j.itemStatus).toBe('served')

    const tasks = await tasksOf(item1Id)
    expect(tasks.every((t) => t.status === 'done')).toBe(true)
    const expoTask = tasks.find((t) => t.kind === 'expo')!
    expect(expoTask.issuedAt).toBeDefined()
    expect(expoTask.issuedByName).toBe('i14-chefA')

    const item = await db.orderItem.findUnique({ where: { id: item1Id } })
    expect(item?.status).toBe('served')
    const order = await db.order.findUnique({ where: { id: orderAId } })
    expect(order?.status).toBe('prepared')

    const audit = await db.auditLog.count({ where: { action: 'STATION_TASK_ISSUED', locationId: locA } })
    expect(audit).toBeGreaterThanOrEqual(1)
  })

  it('D8: neznan taskId 404; slab action 400; brez žetona 401', async () => {
    const res404 = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: `${P}ne-obstaja-${RUN}`, action: 'start' }))
    expect(res404.status).toBe(404)
    const res400 = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { taskId: t2GrillId, action: 'bogus' }))
    expect(res400.status).toBe(400)
    const res401 = await kitchenPATCH(req('PATCH', '/api/kitchen'))
    expect(res401.status).toBe(401)
  })

  it('D9: RBAC — natakar (brez kitchen.update) → 403', async () => {
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokWaiterA, { taskId: t2GrillId, action: 'start' }))
    expect(res.status).toBe(403)
  })

  it('D10: tuja lokacija — kuhar B ne sme potrditi naloge lokacije A → 403', async () => {
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefB, { taskId: t2GrillId, action: 'start' }))
    expect(res.status).toBe(403)
  })
})

/* ═══════════════ E. LEGACY SOBIVANJE ═══════════════ */

describe('E. legacy sobivanje', () => {
  it('E1: postavka Z nalogami — stara pot zavrne (razen SERVED po zaključku)', async () => {
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { itemId: item2Id, status: 'READY' }))
    expect(res.status).toBe(409)
    const j = await body(res)
    expect((j.error as string)).toContain('postajni tok')

    const served = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { itemId: item2Id, status: 'SERVED' }))
    expect(served.status).toBe(409)
    const j2 = await body(served)
    expect((j2.error as string)).toContain('ni zaključena')
  })

  it('E2: postavka Z nalogami, vse naloge končane → SERVED spravi naloge v done', async () => {
    await db.stationTask.updateMany({ where: { orderItemId: item2Id, status: { not: 'done' } }, data: { status: 'ready' } })
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefA, { itemId: item2Id, status: 'SERVED' }))
    expect(res.status).toBe(200)
    const tasks = await tasksOf(item2Id)
    expect(tasks.every((t) => t.status === 'done')).toBe(true)
    const item = await db.orderItem.findUnique({ where: { id: item2Id } })
    expect(item?.status).toBe('served')
  })

  it('E3: postavka BREZ nalog — stara pot nedotaknjena (PREPARING 200)', async () => {
    const res = await kitchenPATCH(req('PATCH', '/api/kitchen', tokChefB, { itemId: itemBId, status: 'PREPARING' }))
    expect(res.status).toBe(200)
    const item = await db.orderItem.findUnique({ where: { id: itemBId } })
    expect(item?.status).toBe('preparing')
  })

  it('E4: DELETE postaje z AKTIVNIMI nalogami → 409; po zaključku → 200 + počiščene usmeritve', async () => {
    // aktivna naloga na Sestavi
    await db.stationTask.create({
      data: {
        id: `${P}task-asm-${RUN}`, locationId: locA, orderItemId: item1Id, orderId: orderAId,
        stationId: stAssemble, stationName: 'i14-Sestava', stationType: 'assemble', kind: 'prep',
        sequence: 3, status: 'pending', title: 'Burger i14', quantity: 1,
      },
    })
    const blocked = await stationIdDELETE(req('DELETE', `/api/prep-stations/${stAssemble}`, tokPmA), { params: Promise.resolve({ id: stAssemble }) })
    expect(blocked.status).toBe(409)

    await db.stationTask.updateMany({ where: { stationId: stAssemble }, data: { status: 'done' } })
    // usmeritve, ki jih DELETE počisti (M:N + Modifier.prepStationId)
    await db.menuItemStation.create({ data: { id: `${P}mis-1-${RUN}`, menuItemId: burgerAId, stationId: stAssemble, locationId: locA } })
    const res = await stationIdDELETE(req('DELETE', `/api/prep-stations/${stAssemble}`, tokPmA), { params: Promise.resolve({ id: stAssemble }) })
    expect(res.status).toBe(200)
    expect(await db.menuItemStation.count({ where: { stationId: stAssemble } })).toBe(0)
    const modAux = await db.modifier.findUnique({ where: { id: modAuxId } })
    expect(modAux?.prepStationId).toBeNull()
    expect(await db.prepStation.count({ where: { id: stAssemble } })).toBe(0)
  })
})

/* ═══════════════ F. USMERJANJE (menus + modifiers) ═══════════════ */

describe('F. usmerjanje artiklov in opcij', () => {
  it('F1: PATCH menus — tuja postaja (druga lokacija) kot primarna → 400', async () => {
    stForeignB = `${P}st-tuja-${RUN}`
    await db.prepStation.create({ data: { id: stForeignB, name: 'i14 Tuja', type: 'grill', avgPrepTime: 9, sortOrder: 1, locationId: locB } })
    const res = await menuIdPATCH(req('PATCH', `/api/menus/${burgerAId}`, tokMgrA, { prepStationId: stForeignB }), { params: Promise.resolve({ id: burgerAId }) })
    expect(res.status).toBe(400)
    const j = await body(res)
    expect((j.error as string)).toContain('lokaciji')
  })

  it('F2: PATCH menus — stationIds tuja postaja 400; duplikati 400; nad 8 postaj 400', async () => {
    const resForeign = await menuIdPATCH(req('PATCH', `/api/menus/${burgerAId}`, tokMgrA, { stationIds: [stForeignB] }), { params: Promise.resolve({ id: burgerAId }) })
    expect(resForeign.status).toBe(400)

    const resDupe = await menuIdPATCH(req('PATCH', `/api/menus/${burgerAId}`, tokMgrA, { stationIds: [stSalad, stSalad] }), { params: Promise.resolve({ id: burgerAId }) })
    expect(resDupe.status).toBe(400)

    const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => `${P}x${n}-${RUN}`)
    const resMax = await menuIdPATCH(req('PATCH', `/api/menus/${burgerAId}`, tokMgrA, { stationIds: nine }), { params: Promise.resolve({ id: burgerAId }) })
    expect(resMax.status).toBe(400)
    const j = await body(resMax)
    expect((j.error as string)).toContain('8')
  })

  it('F3: PATCH menus — veljavne dodatne postaje (replace-set semantika) + primarna null', async () => {
    const res = await menuIdPATCH(req('PATCH', `/api/menus/${burgerAId}`, tokMgrA, { stationIds: [stSalad] }), { params: Promise.resolve({ id: burgerAId }) })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.stationIds).toEqual([stSalad])
    expect(await db.menuItemStation.count({ where: { menuItemId: burgerAId } })).toBe(1)

    // zamenjava nabora
    const res2 = await menuIdPATCH(req('PATCH', `/api/menus/${burgerAId}`, tokMgrA, { stationIds: [stExpo] }), { params: Promise.resolve({ id: burgerAId }) })
    expect(res2.status).toBe(200)
    expect(await db.menuItemStation.count({ where: { menuItemId: burgerAId, stationId: stExpo } })).toBe(1)
    expect(await db.menuItemStation.count({ where: { menuItemId: burgerAId } })).toBe(1)

    // praznenje + primarna null
    const res3 = await menuIdPATCH(req('PATCH', `/api/menus/${burgerAId}`, tokMgrA, { stationIds: [], prepStationId: null }), { params: Promise.resolve({ id: burgerAId }) })
    expect(res3.status).toBe(200)
    expect(await db.menuItemStation.count({ where: { menuItemId: burgerAId } })).toBe(0)
    const burger = await db.menuItem.findUnique({ where: { id: burgerAId } })
    expect(burger?.prepStationId).toBeNull()
  })

  it('F4: POST menus — artikel z usmeritvijo (primarna + dodatne) 201; tuja postaja 400', async () => {
    const res = await menuPOST(req('POST', '/api/menus', tokMgrA, { categoryId: catAId, name: 'i14 Nova jed', price: 3, prepStationId: stGrill, stationIds: [stSalad] }))
    expect(res.status).toBe(201)
    const j = await body(res)
    expect(j.prepStationId).toBe(stGrill)
    expect(j.stationIds).toEqual([stSalad])
    expect(await db.menuItemStation.count({ where: { menuItemId: (j.item as { id: string }).id } })).toBe(1)

    const resForeign = await menuPOST(req('POST', '/api/menus', tokMgrA, { categoryId: catAId, name: 'i14 Slaba jed', price: 3, prepStationId: stForeignB }))
    expect(resForeign.status).toBe(400)
  })

  it('F5: PATCH modifiers — usmeritev opcije BREZ dotika alergenov; tuja postaja 400; null počisti', async () => {
    const before = await db.modifier.findUnique({ where: { id: modPopecnoId } })
    const res = await modifierIdPATCH(req('PATCH', `/api/modifiers/${modPopecnoId}`, tokMgrA, { prepStationId: stGrill }), { params: Promise.resolve({ id: modPopecnoId }) })
    expect(res.status).toBe(200)
    const after = await db.modifier.findUnique({ where: { id: modPopecnoId } })
    expect(after?.prepStationId).toBe(stGrill)
    expect(after?.allergens).toBe(before?.allergens)

    const resForeign = await modifierIdPATCH(req('PATCH', `/api/modifiers/${modPopecnoId}`, tokMgrA, { prepStationId: stForeignB }), { params: Promise.resolve({ id: modPopecnoId }) })
    expect(resForeign.status).toBe(400)

    const resNull = await modifierIdPATCH(req('PATCH', `/api/modifiers/${modPopecnoId}`, tokMgrA, { prepStationId: null }), { params: Promise.resolve({ id: modPopecnoId }) })
    expect(resNull.status).toBe(200)
    const cleared = await db.modifier.findUnique({ where: { id: modPopecnoId } })
    expect(cleared?.prepStationId).toBeNull()
  })
})

/* ═══════════════ G. DDL + REGISTER + DRIFT ═══════════════ */

describe('G. DDL/register/drift', () => {
  it('G1: register vsebuje kds-stations (id, endpoint, probe)', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'kds-stations')
    expect(m).toBeDefined()
    expect(m?.endpoint).toBe('/api/admin/migrate-kds-stations')
    expect(SCHEMA_MIGRATIONS.length).toBeGreaterThanOrEqual(25)
  })

  it('G2: DDL ruta idempotentna — bootstrap 200; drugi klic alreadyApplied', async () => {
    const adminTok = tok('bootstrap', 'Bootstrap', 'ADMIN', null)
    const first = await migratePOST(req('POST', '/api/admin/migrate-kds-stations', adminTok))
    expect(first.status).toBe(200)
    const j1 = await body(first)
    expect(j1.alreadyApplied === true || (j1.applied as string[] | undefined)?.includes('StationTask')).toBe(true)
    const second = await migratePOST(req('POST', '/api/admin/migrate-kds-stations', adminTok))
    const j2 = await body(second)
    expect(second.status).toBe(200)
    expect(j2.alreadyApplied).toBe(true)
  })

  it('G3: ne-centralna vloga (manager) → 403 na DDL ruti', async () => {
    const denied = await migratePOST(req('POST', '/api/admin/migrate-kds-stations', tokMgrA))
    expect(denied.status).toBe(403)
  })

  it('G4: isKdsStationsStatement — stavki KDS postaj prepoznani; tuji NE', () => {
    expect(isKdsStationsStatement('CREATE TABLE "StationTask" (id TEXT NOT NULL)')).toBe(true)
    expect(isKdsStationsStatement('CREATE UNIQUE INDEX "StationTask_orderItemId_stationId_kind_key" ON "StationTask"("orderItemId", "stationId", "kind")')).toBe(true)
    expect(isKdsStationsStatement('CREATE INDEX "MenuItemStation_locationId_idx" ON "MenuItemStation"("locationId")')).toBe(true)
    expect(isKdsStationsStatement('ALTER TABLE "Modifier" ADD COLUMN "prepStationId" TEXT')).toBe(true)
    expect(isKdsStationsStatement('ALTER TABLE "PrepStation" ADD COLUMN "isExpo" BOOLEAN')).toBe(true)
    expect(isKdsStationsStatement('DROP TABLE "StationTask"')).toBe(false)
    expect(isKdsStationsStatement('CREATE TABLE "MenuSection" (id TEXT)')).toBe(false)
    expect(isKdsStationsStatement('CREATE INDEX "ReservationWidget_x" ON "ReservationWidget"("x")')).toBe(false)
    expect(isKdsStationsStatement('ALTER TABLE "Modifier" ADD COLUMN "price" INTEGER')).toBe(false)
  })

  it('G5: classifyDrift — KDS stavki so znani (ne unexpected); tuji stavk je blokator', () => {
    const sql = [
      'CREATE TABLE "StationTask" (id TEXT NOT NULL)',
      'CREATE TABLE "MenuItemStation" (id TEXT NOT NULL)',
      'CREATE UNIQUE INDEX "StationTask_orderItemId_stationId_kind_key" ON "StationTask"("orderItemId", "stationId", "kind")',
      'ALTER TABLE "Modifier" ADD COLUMN "prepStationId" TEXT',
      'ALTER TABLE "PrepStation" ADD COLUMN "isExpo" BOOLEAN',
    ].join(';\n')
    const out = classifyDrift(sql)
    expect(out.unexpected.length).toBe(0)
    expect(out.known.some((k) => k.id === 'kds-stations')).toBe(true)

    const dirty = classifyDrift(`${sql};\nALTER TABLE "Employee" ADD COLUMN "x" TEXT`)
    expect(dirty.unexpected.length).toBe(1)
    expect(dirty.unexpected[0]).toContain('"Employee"')
  })
})

/* ═══════════════ H. STATISTIKA PO POSTAJI ═══════════════ */

describe('H. statistika po postaji', () => {
  it('H1: /api/kitchen/stats perStation — uspešnost in target PO postaji', async () => {
    const res = await statsGET(req('GET', '/api/kitchen/stats?days=7', tokChefA))
    expect(res.status).toBe(200)
    const j = await body(res)
    const per = j.perStation as { stationId: string; kind: string; count: number; avgMin: number; target: number | null }[]
    const grill = per.find((s) => s.stationId === stGrill)
    expect(grill).toBeDefined()
    expect(grill!.kind).toBe('prep')
    expect(grill!.count).toBeGreaterThanOrEqual(1)
    expect(grill!.target).toBe(12)
    const salad = per.find((s) => s.stationId === stSalad)
    expect(salad?.target).toBe(6)
    const expo = per.find((s) => s.stationId === stExpo)
    expect(expo?.kind).toBe('expo')
  })
})
