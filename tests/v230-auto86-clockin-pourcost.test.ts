/**
 * v1.230.0 — SAMODEJNI 86 OB IZPRAZNITVI ZALOGE + NIZKA ZALOGA OB PRIJAVI +
 * POUR COST (docs/PRIMERJAVA-VMESNIKOV-2026.md §2/§5 C-seznam → zaprt).
 *
 * Toast Inventory benchmark: (A) knjižnica src/lib/auto-86.ts (direct/recipe
 * način, config + state Integration vrstici, reviziji MENU_ITEM_AUTO_86 /
 * MENU_ITEM_AUTO_RESTORE, samodejna obnovitev, lokacijski varovalki),
 * (B) konfiguracijska ruta /api/auto86 (GET privzete vrednosti, PUT + revizija,
 * validacija, RBAC), (C) clock-in lowStock povzetek (Toast dec 2025 — kanonični
 * strežniški prag reorderPoint ?? minQuantity, brez cen, out artikli prvi),
 * (D) pour-cost čiste funkcije + vgradnja, (E) žičenje v FURS izdajo + 6 poteh
 * priliva + POS toast, (Ž) registri (verzija, worklog, PRD R4b, dokument,
 * i18n števci).
 *
 * Fixture predpona: v230fx- (kaskadni izbris prek Location v afterAll).
 */
import { describe, expect, test, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  applyAuto86ForDeductions,
  restoreAuto86ForInventory,
  parseAuto86Config,
  depletedDeductions,
  AUTO86_CONFIG_MARKER,
  AUTO86_STATE_MARKER,
  DEFAULT_AUTO86_CONFIG,
} from '../src/lib/auto-86'
import { GET as auto86GET, PUT as auto86PUT } from '../src/app/api/auto86/route'
import { POST as timeclockPOST } from '../src/app/api/timeclock/route'
import { isBeverageCategory, pourCostBand } from '../src/components/tabs/analitika-tab'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { APP_VERSION } from '../src/lib/version'

const PREFIX = 'v230fx-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

function req(url: string, token?: string, body?: unknown, method = 'POST'): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function seedEmployee(role: 'admin' | 'waiter', n: number, locId: string) {
  const fields = employeePinFields(`${PIN_BASE}${n}`, `${PREFIX}${role}-${RUN}@test.local`)
  const e = await db.employee.create({
    data: {
      id: `${PREFIX}${role}-${n}-${RUN}`,
      name: `${PREFIX}${role}${n}`,
      email: `${PREFIX}${role}-${n}-${RUN}@test.local`,
      role,
      status: 'active',
      sessionVersion: 0,
      locationId: locId,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
  const UI = { admin: 'ADMIN', waiter: 'WAITER' } as const
  return createToken({ sub: e.id, name: e.name, role: UI[role], loc: locId, sv: 0 })
}

const setupP = (async () => {
  await sweepTestFixtures(db, [PREFIX])
  const locA = await db.location.create({
    data: { id: `${PREFIX}locA-${RUN}`, name: `${PREFIX}Lokacija A`, code: `V230A-${RUN.toUpperCase()}`, premisesId: `${PREFIX}premA-${RUN}` },
  })
  const locB = await db.location.create({
    data: { id: `${PREFIX}locB-${RUN}`, name: `${PREFIX}Lokacija B`, code: `V230B-${RUN.toUpperCase()}`, premisesId: `${PREFIX}premB-${RUN}` },
  })
  const menuA = await db.menu.create({ data: { id: `${PREFIX}menuA-${RUN}`, name: `${PREFIX}Meni A`, locationId: locA.id } })
  const catA = await db.category.create({ data: { id: `${PREFIX}catA-${RUN}`, name: 'Pijače', menuId: menuA.id } })
  const catA2 = await db.category.create({ data: { id: `${PREFIX}catA2-${RUN}`, name: 'Glavne jedi', menuId: menuA.id } })
  const menuB = await db.menu.create({ data: { id: `${PREFIX}menuB-${RUN}`, name: `${PREFIX}Meni B`, locationId: locB.id } })
  const catB = await db.category.create({ data: { id: `${PREFIX}catB-${RUN}`, name: 'Pijače', menuId: menuB.id } })

  // direct-povezani artikel (pakirano pivo): zaloga A ↔ menu artikel A
  const beerInv = await db.inventoryItem.create({
    data: { id: `${PREFIX}inv-beer-${RUN}`, name: `${PREFIX}Pivo 0,5`, unit: 'kos', quantity: 0, minQuantity: 0, costPerUnit: 1.2, locationId: locA.id, menuItemId: null },
  })
  const beerItem = await db.menuItem.create({ data: { id: `${PREFIX}mi-beer-${RUN}`, name: `${PREFIX}Pivo 0,5 L`, price: 3.5, categoryId: catA.id } })
  await db.inventoryItem.update({ where: { id: beerInv.id }, data: { menuItemId: beerItem.id } })

  // tu-lokacijski dvojnik (isti menu artikel NE sme biti 86 — tu meni)
  const foreignItem = await db.menuItem.create({ data: { id: `${PREFIX}mi-foreign-${RUN}`, name: `${PREFIX}Tuj artikel`, price: 4, categoryId: catB.id } })

  // receptni artikel: jed porablja sestavino prek RecipeItem (brez direct povezave)
  const flourInv = await db.inventoryItem.create({
    data: { id: `${PREFIX}inv-flour-${RUN}`, name: `${PREFIX}Moka`, unit: 'kg', quantity: 0, minQuantity: 0, costPerUnit: 1, locationId: locA.id },
  })
  const pastaItem = await db.menuItem.create({ data: { id: `${PREFIX}mi-pasta-${RUN}`, name: `${PREFIX}Špageti`, price: 9, categoryId: catA2.id } })
  await db.recipeItem.create({
    data: { id: `${PREFIX}ri-flour-${RUN}`, menuItemId: pastaItem.id, inventoryItemId: flourInv.id, quantityPerServing: 0.15, unit: 'kg', yieldPercent: 100 },
  })

  return {
    locAId: locA.id,
    locBId: locB.id,
    beerInvId: beerInv.id,
    beerItemId: beerItem.id,
    foreignItemId: foreignItem.id,
    flourInvId: flourInv.id,
    pastaItemId: pastaItem.id,
    adminToken: await seedEmployee('admin', 1, locA.id),
    waiterToken: await seedEmployee('waiter', 2, locA.id),
  }
})()

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.integration.deleteMany({ where: { name: { in: [AUTO86_CONFIG_MARKER, AUTO86_STATE_MARKER] }, id: { startsWith: 'auto86' } } }).catch(() => null)
  await db.integration.deleteMany({ where: { id: { startsWith: 'auto86-config' } } }).catch(() => null)
  await db.integration.deleteMany({ where: { id: { startsWith: 'auto86-state' } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
  await db.inventoryItem.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.recipeItem.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.timeEntry.deleteMany({ where: { employeeId: { contains: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: `${PREFIX}loc` } } }).catch(() => null) // kaskada: Menu → Category → MenuItem
})

/* ─────────────── A — knjižnica auto-86 ─────────────── */

describe('v1.230.0 A — auto-86 knjižnica (čisto + vedenjsko)', () => {
  test('A1: parseAuto86Config — privzeto, kanonizacija, neveljavno', () => {
    expect(parseAuto86Config(null)).toEqual(DEFAULT_AUTO86_CONFIG)
    expect(DEFAULT_AUTO86_CONFIG).toEqual({ enabled: true, mode: 'direct' })
    expect(parseAuto86Config('{"enabled":false,"mode":"recipe"}')).toEqual({ enabled: false, mode: 'recipe' })
    expect(parseAuto86Config('{"enabled":"yes","mode":"hack"}')).toEqual({ enabled: true, mode: 'direct' })
    expect(parseAuto86Config('ne json')).toEqual(DEFAULT_AUTO86_CONFIG)
  })

  test('A2: depletedDeductions — samo izpraznitve (r3 tolerance), brez praznih id', () => {
    const out = depletedDeductions([
      { inventoryItemId: 'a', newQty: 0 },
      { inventoryItemId: 'b', newQty: -0.5 },
      { inventoryItemId: 'c', newQty: 0.0004 }, // r3 → 0 → izpraznjeno
      { inventoryItemId: 'd', newQty: 0.001 },
      { inventoryItemId: '', newQty: -1 },
      { inventoryItemId: 'e', newQty: 5 },
    ])
    expect(out.map((x) => x.inventoryItemId).sort()).toEqual(['a', 'b', 'c'])
  })

  test('A3: DIRECT način — izpraznjena povezana zaloga ugasne menu artikel + revizija + stanje', async () => {
    const s = await setupP
    // vrstica config še ne obstaja → privzeto (direct, vklopljeno)
    await db.integration.deleteMany({ where: { name: AUTO86_CONFIG_MARKER } })
    const out = await applyAuto86ForDeductions(db, [{ inventoryItemId: s.beerInvId, newQty: 0 }], s.locAId, 'test-user')
    expect(out.length).toBe(1)
    expect(out[0].menuItemId).toBe(s.beerItemId)
    expect(out[0].inventoryItemId).toBe(s.beerInvId)
    const mi = await db.menuItem.findUnique({ where: { id: s.beerItemId }, select: { isAvailable: true } })
    expect(mi?.isAvailable).toBe(false)
    const audit = await db.auditLog.findFirst({ where: { action: 'MENU_ITEM_AUTO_86', entityId: s.beerItemId } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(audit!.details || '{}')
    expect(details.from).toBe(true)
    expect(details.to).toBe(false)
    expect(details.mode).toBe('direct')
    expect(details.source).toBe('auto')
    expect(details.inventoryItemId).toBe(s.beerInvId)
    const stateRow = await db.integration.findFirst({ where: { name: AUTO86_STATE_MARKER, type: 'other' } })
    expect(stateRow).not.toBeNull()
    const state = JSON.parse(stateRow!.config || '{}')
    expect(state[s.beerItemId]?.inventoryItemId).toBe(s.beerInvId)
  })

  test('A4: izklopljena konfiguracija — nič se ne zgodi', async () => {
    const s = await setupP
    await db.menuItem.update({ where: { id: s.beerItemId }, data: { isAvailable: true } })
    await db.integration.upsert({
      where: { id: 'auto86-config-test' },
      create: { id: 'auto86-config-test', name: AUTO86_CONFIG_MARKER, type: 'other', provider: 'internal', config: '{"enabled":false,"mode":"direct"}', isActive: true, syncEnabled: false },
      update: { config: '{"enabled":false,"mode":"direct"}' },
    })
    const out = await applyAuto86ForDeductions(db, [{ inventoryItemId: s.beerInvId, newQty: 0 }], s.locAId, 'test-user')
    expect(out).toEqual([])
    const mi = await db.menuItem.findUnique({ where: { id: s.beerItemId }, select: { isAvailable: true } })
    expect(mi?.isAvailable).toBe(true)
  })

  test('A5: RECIPE način — potrošnik po recepturi ugasne SAMO v recipe načinu', async () => {
    const s = await setupP
    await db.integration.update({ where: { id: 'auto86-config-test' }, data: { config: '{"enabled":true,"mode":"direct"}' } })
    // direct: moka nima menuItemId povezave → špageti NE ugasnejo
    let out = await applyAuto86ForDeductions(db, [{ inventoryItemId: s.flourInvId, newQty: 0 }], s.locAId, 'test-user')
    expect(out).toEqual([])
    // recipe: potrošnik po recepturi ugasne
    await db.integration.update({ where: { id: 'auto86-config-test' }, data: { config: '{"enabled":true,"mode":"recipe"}' } })
    out = await applyAuto86ForDeductions(db, [{ inventoryItemId: s.flourInvId, newQty: 0 }], s.locAId, 'test-user')
    expect(out.length).toBe(1)
    expect(out[0].menuItemId).toBe(s.pastaItemId)
    expect(out[0].inventoryItemId).toBe(s.flourInvId)
    const mi = await db.menuItem.findUnique({ where: { id: s.pastaItemId }, select: { isAvailable: true } })
    expect(mi?.isAvailable).toBe(false)
  })

  test('A6: že ugasnen artikel — CAS prepreči dvojni zapis (brez nove revizije)', async () => {
    const s = await setupP
    const before = await db.auditLog.count({ where: { action: 'MENU_ITEM_AUTO_86', entityId: s.pastaItemId } })
    const out = await applyAuto86ForDeductions(db, [{ inventoryItemId: s.flourInvId, newQty: 0 }], s.locAId, 'test-user')
    expect(out).toEqual([]) // isAvailable že false → ni kandidata
    const after = await db.auditLog.count({ where: { action: 'MENU_ITEM_AUTO_86', entityId: s.pastaItemId } })
    expect(after).toBe(before)
  })

  test('A7: lokacijska varovalka — menu artikel DRUGE lokacije se ne dotakne', async () => {
    const s = await setupP
    await db.menuItem.update({ where: { id: s.beerItemId }, data: { isAvailable: true } })
    // odvod na lokaciji B: pivo (lokacija A) ne sme ugasniti artikla na lokaciji B
    const out = await applyAuto86ForDeductions(db, [{ inventoryItemId: s.beerInvId, newQty: 0 }], s.locBId, 'test-user')
    expect(out).toEqual([])
    const foreign = await db.menuItem.findUnique({ where: { id: s.foreignItemId }, select: { isAvailable: true } })
    expect(foreign?.isAvailable).toBe(true)
    const own = await db.menuItem.findUnique({ where: { id: s.beerItemId }, select: { isAvailable: true } })
    expect(own?.isAvailable).toBe(true)
  })

  test('A8: restoreAuto86ForInventory — priliv obnovi SAMO avtomatsko ugasnjene + revizija + čist stanje', async () => {
    const s = await setupP
    // pivo ugasnimo samodejno (direct, vklopljeno) na lokaciji A
    await db.integration.update({ where: { id: 'auto86-config-test' }, data: { config: '{"enabled":true,"mode":"direct"}' } })
    const out = await applyAuto86ForDeductions(db, [{ inventoryItemId: s.beerInvId, newQty: 0 }], s.locAId, 'test-user')
    expect(out.length).toBe(1)
    // zaloga se vrne (npr. GRN)
    await db.inventoryItem.update({ where: { id: s.beerInvId }, data: { quantity: 24 } })
    await restoreAuto86ForInventory([s.beerInvId], 'test-user')
    const mi = await db.menuItem.findUnique({ where: { id: s.beerItemId }, select: { isAvailable: true } })
    expect(mi?.isAvailable).toBe(true)
    const audit = await db.auditLog.findFirst({ where: { action: 'MENU_ITEM_AUTO_RESTORE', entityId: s.beerItemId } })
    expect(audit).not.toBeNull()
    const stateRow = await db.integration.findFirst({ where: { name: AUTO86_STATE_MARKER, type: 'other' } })
    const state = JSON.parse(stateRow?.config || '{}')
    expect(state[s.beerItemId]).toBeUndefined()
  })

  test('A9: restore NE obnovi ročno ugasnjenega artikla (Toast disciplina)', async () => {
    const s = await setupP
    await db.inventoryItem.update({ where: { id: s.beerInvId }, data: { quantity: 10 } })
    await db.menuItem.update({ where: { id: s.beerItemId }, data: { isAvailable: false } }) // ROČNI 86 (brez state zapisa)
    await restoreAuto86ForInventory([s.beerInvId], 'test-user')
    const mi = await db.menuItem.findUnique({ where: { id: s.beerItemId }, select: { isAvailable: true } })
    expect(mi?.isAvailable).toBe(false) // ostane ročno ugasnjen
  })

  test('A10: restore v recipe načinu — druga sestavina še na nič → NE obnovi', async () => {
    const s = await setupP
    // špageti ugasnjeni po recepturi (A5); dodamo še eno izpraznjeno sestavino
    const tomatoInv = await db.inventoryItem.create({
      data: { id: `${PREFIX}inv-tomato-${RUN}`, name: `${PREFIX}Paradajz`, unit: 'kg', quantity: 0, locationId: s.locAId },
    })
    await db.recipeItem.create({
      data: { id: `${PREFIX}ri-tomato-${RUN}`, menuItemId: s.pastaItemId, inventoryItemId: tomatoInv.id, quantityPerServing: 0.1, unit: 'kg', yieldPercent: 100 },
    })
    await db.menuItem.update({ where: { id: s.pastaItemId }, data: { isAvailable: false } })
    // state zapis ročno simuliramo (moka se je vrnila, paradajz je še na 0)
    const stateRow = await db.integration.findFirst({ where: { name: AUTO86_STATE_MARKER, type: 'other' } })
    const state = JSON.parse(stateRow?.config || '{}')
    state[s.pastaItemId] = { inventoryItemId: s.flourInvId, at: new Date().toISOString() }
    await db.integration.update({ where: { id: stateRow!.id }, data: { config: JSON.stringify(state) } })
    await db.inventoryItem.update({ where: { id: s.flourInvId }, data: { quantity: 5 } })
    await restoreAuto86ForInventory([s.flourInvId], 'test-user')
    const mi = await db.menuItem.findUnique({ where: { id: s.pastaItemId }, select: { isAvailable: true } })
    expect(mi?.isAvailable).toBe(false) // paradajz še na 0 → ne obnovi
    // ko se vrne TUDI paradajz → obnovi
    await db.inventoryItem.update({ where: { id: tomatoInv.id }, data: { quantity: 3 } })
    await restoreAuto86ForInventory([tomatoInv.id], 'test-user')
    const mi2 = await db.menuItem.findUnique({ where: { id: s.pastaItemId }, select: { isAvailable: true } })
    expect(mi2?.isAvailable).toBe(true)
  })
})

/* ─────────────── B — konfiguracijska ruta /api/auto86 ─────────────── */

describe('v1.230.0 B — /api/auto86 (GET/PUT)', () => {
  test('B1: GET brez vrstice → privzeta konfiguracija (direct, vklopljeno)', async () => {
    const s = await setupP
    await db.integration.deleteMany({ where: { name: AUTO86_CONFIG_MARKER } })
    const res = await auto86GET(req('/api/auto86', s.adminToken, undefined, 'GET'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.config).toEqual({ enabled: true, mode: 'direct' })
  })

  test('B2: PUT veljavna konfiguracija → vrstica + revizija AUTO86_CONFIG_UPDATED + GET jo vrne', async () => {
    const s = await setupP
    const res = await auto86PUT(req('/api/auto86', s.adminToken, { enabled: true, mode: 'recipe' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.config).toEqual({ enabled: true, mode: 'recipe' })
    const row = await db.integration.findFirst({ where: { name: AUTO86_CONFIG_MARKER, type: 'other' } })
    expect(row).not.toBeNull()
    const audit = await db.auditLog.findFirst({ where: { action: 'AUTO86_CONFIG_UPDATED' } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(audit!.details || '{}')
    expect(details.to).toEqual({ enabled: true, mode: 'recipe' })
    const g = await auto86GET(req('/api/auto86', s.adminToken, undefined, 'GET'))
    const gBody = await g.json()
    expect(gBody.config).toEqual({ enabled: true, mode: 'recipe' })
    // povratek na privzeto za ostale teste
    await auto86PUT(req('/api/auto86', s.adminToken, { enabled: true, mode: 'direct' }))
  })

  test('B3: PUT validacija — neveljaven mode/enabled → 400', async () => {
    const s = await setupP
    const r1 = await auto86PUT(req('/api/auto86', s.adminToken, { enabled: true, mode: 'vse' }))
    expect(r1.status).toBe(400)
    const r2 = await auto86PUT(req('/api/auto86', s.adminToken, { mode: 'direct' }))
    expect(r2.status).toBe(400)
  })

  test('B4: RBAC — natakar brez inventory.manage dobi 403', async () => {
    const s = await setupP
    const res = await auto86GET(req('/api/auto86', s.waiterToken, undefined, 'GET'))
    expect(res.status).toBe(403)
  })
})

/* ─────────────── C — clock-in lowStock (Toast dec 2025) ─────────────── */

describe('v1.230.0 C — clock-in lowStock povzetek', () => {
  test('C1: odgovor vsebuje lowStock (kanonični prag, out prvi, brez zdravih), entry ostane', async () => {
    const s = await setupP
    // trije artikli: razprodan (0), nizek (reorderPoint), zdrav
    await db.inventoryItem.create({ data: { id: `${PREFIX}inv-out-${RUN}`, name: `${PREFIX}Razprodan sok`, unit: 'kos', quantity: 0, minQuantity: 0, reorderPoint: 2, locationId: s.locAId } })
    await db.inventoryItem.create({ data: { id: `${PREFIX}inv-low-${RUN}`, name: `${PREFIX}Nizek sir`, unit: 'kg', quantity: 1, minQuantity: 0, reorderPoint: 5, locationId: s.locAId } })
    await db.inventoryItem.create({ data: { id: `${PREFIX}inv-ok-${RUN}`, name: `${PREFIX}Zdrava moka`, unit: 'kg', quantity: 50, minQuantity: 2, locationId: s.locAId } })
    // waiter še nima aktivne evidence → clock-in gre skozi
    const res = await timeclockPOST(req('/api/timeclock', s.waiterToken, { action: 'clock-in' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.entry).toBeDefined()
    expect(body.lowStock).toBeDefined()
    expect(body.lowStock.count).toBeGreaterThanOrEqual(2)
    expect(body.lowStock.outCount).toBeGreaterThanOrEqual(1)
    expect(body.lowStock.items.length).toBeGreaterThan(0)
    // razprodan je PRVI (nujnost) in nima cene
    expect(body.lowStock.items[0].out).toBe(true)
    for (const it of body.lowStock.items) {
      expect(it).not.toHaveProperty('cost')
      expect(it).not.toHaveProperty('costPerUnit')
    }
    // počistim aktivno evidenco, da ne moti morebitnih ponovitev
    await db.timeEntry.deleteMany({ where: { employeeId: { contains: PREFIX } } })
  })

  test('C2: statika — banner v Delovnem času + kanonični prag uvožen iz lib/low-stock', () => {
    const urniki = readFileSync('src/components/tabs/urniki-tab.tsx', 'utf8')
    expect(urniki).toContain('clockin-lowstock')
    expect(urniki).toContain('tc.lowStockTitle')
    expect(urniki).toContain('setClockInStock')
    const route = readFileSync('src/app/api/timeclock/route.ts', 'utf8')
    expect(route).toContain("from '@/lib/low-stock'")
    expect(route).toContain('lowStockThreshold')
    expect(route).toContain('isBelowLowStock')
  })
})

/* ─────────────── D — pour cost ─────────────── */

describe('v1.230.0 D — pour cost (čiste funkcije + vgradnja)', () => {
  test('D1: isBeverageCategory — hevronika SL/HR imen kategorij', () => {
    expect(isBeverageCategory('Pijače')).toBe(true)
    expect(isBeverageCategory('Vina')).toBe(true)
    expect(isBeverageCategory('Piva')).toBe(true)
    expect(isBeverageCategory('Brezalkoholne pijače')).toBe(true)
    expect(isBeverageCategory('Žgane pijače')).toBe(true)
    expect(isBeverageCategory('Kava in čaj')).toBe(true)
    expect(isBeverageCategory('Glavne jedi')).toBe(false)
    expect(isBeverageCategory('Predjedi')).toBe(false)
    expect(isBeverageCategory('')).toBe(false)
  })

  test('D2: pourCostBand — pasovi benchmarka', () => {
    expect(pourCostBand(15)).toBe('good')
    expect(pourCostBand(20)).toBe('good')
    expect(pourCostBand(20.1)).toBe('ok')
    expect(pourCostBand(28)).toBe('ok')
    expect(pourCostBand(28.1)).toBe('warn')
    expect(pourCostBand(null)).toBe('unknown')
    expect(pourCostBand(Number.NaN)).toBe('unknown')
  })

  test('D3: vgradnja — PourCostCard izvožen, izrisan v inženiringu, i18n ključi obstajajo', () => {
    const barrel = readFileSync('src/components/dashboard-tabs.tsx', 'utf8')
    expect(barrel).toContain('PourCostCard')
    const page = readFileSync('src/app/dashboard/page.tsx', 'utf8')
    expect(page).toContain('<PourCostCard />')
    const card = readFileSync('src/components/tabs/analitika-tab.tsx', 'utf8')
    expect(card).toContain('data-region="pour-cost-card"')
    expect(card).toContain('/api/menu-engineering?days=')
    for (const k of ['pc.title', 'pc.desc', 'pc.kpi', 'pc.revenue', 'pc.cogs', 'pc.empty', 'pc.bandGood', 'pc.bandOk', 'pc.bandWarn', 'pc.beverage', 'pc.note', 'pc.noBeverage']) {
      expect(typeof (sl as Record<string, string>)[k]).toBe('string')
      expect(typeof (hr as Record<string, string>)[k]).toBe('string')
    }
  })
})

/* ─────────────── E — žičenje (FURS izdaja + 6 prilivov + POS toast) ─────────────── */

describe('v1.230.0 E — žičenje v plačilni tok in prilive', () => {
  test('E1: FURS izdaja — auto86 v ISTI transakciji, INVOICE_ISSUE nosi rezultat, odgovor ga vrača', () => {
    const src = readFileSync('src/lib/furs/issue.ts', 'utf8')
    expect(src).toContain("from '@/lib/auto-86'")
    expect(src).toContain('applyAuto86ForDeductions(tx, stock.deducted ? stock.deductions : []')
    // klic je ZA razknjižbo in V transakciji (vrstni red v izvorni kodi)
    const deductIdx = src.indexOf('const stock = await deductStockForOrderTx(tx')
    const autoIdx = src.indexOf('const auto86 = await applyAuto86ForDeductions(tx')
    expect(deductIdx).toBeGreaterThan(-1)
    expect(autoIdx).toBeGreaterThan(deductIdx)
    // revizija INVOICE_ISSUE nosi details.auto86 (oba zapisa — veriga + create)
    expect(src.match(/auto86: auto86\.length > 0/g)?.length).toBeGreaterThanOrEqual(3)
    // odgovor POST /api/furs nosi seznam
    expect(src).toContain('receipt.auto86.map((a) => ({ name: a.name, inventoryItem: a.inventoryItemName }))')
  })

  test('E2: VSEH 6 prilivnih poti žiči restoreAuto86ForInventory (fire-and-forget po commitu)', () => {
    const sites: [string, string][] = [
      ['src/app/api/purchase-orders/[id]/receive/route.ts', 'GRN prevzem'],
      ['src/app/api/receipts/[id]/storno/route.ts', 'storno računa'],
      ['src/app/api/stocktakes/[id]/approve/route.ts', 'potrditev popisa'],
      ['src/app/api/inventory/route.ts', 'ročni prejem/popravek'],
      ['src/app/api/waste/[id]/reverse/route.ts', 'reverzija odpada'],
      ['src/app/api/transfers/[id]/receive/route.ts', 'prevzem prenosa'],
    ]
    for (const [path, label] of sites) {
      const src = readFileSync(path, 'utf8')
      expect(src).toContain("restoreAuto86ForInventory")
      expect(src).toContain('void restoreAuto86ForInventory')
    }
    // vsaka pot pošilja SAMO pozitivne prilive
    const inv = readFileSync('src/app/api/inventory/route.ts', 'utf8')
    expect(inv).toContain('result.variance > 0')
    const st = readFileSync('src/app/api/stocktakes/[id]/approve/route.ts', 'utf8')
    expect(st).toContain('counted > previousQty && counted > 0')
    const storno = readFileSync('src/app/api/receipts/[id]/storno/route.ts', 'utf8')
    expect(storno).toContain('it.qty > 0')
  })

  test('E3: POS toast ob plačilu, ki je spraznilo zalogo', () => {
    const page = readFileSync('src/app/dashboard/page.tsx', 'utf8')
    expect(page).toContain("auto86?: { name: string; inventoryItem: string }[]")
    expect(page).toContain("t('sale.auto86Toast')")
    expect(sl['sale.auto86Toast']).toBeTruthy()
    expect(hr['sale.auto86Toast']).toBeTruthy()
  })

  test('E4: konfiguracijska kartica v zalogah (Auto86Card, samo canManage)', () => {
    const zaloga = readFileSync('src/components/tabs/zaloga-tab.tsx', 'utf8')
    expect(zaloga).toContain('export function Auto86Card')
    expect(zaloga).toContain("data-region=\"auto86-card\"")
    expect(zaloga).toContain("{canManage && <Auto86Card />}")
    expect(zaloga).toContain("'/api/auto86'")
  })
})

/* ─────────────── Ž — verzija + registri (doc-truth) ─────────────── */

describe('v1.230.0 Ž — verzija + registri', () => {
  test('Ž1: verzija je dvignjena na 1.238.0 (version.ts + compose oznaka)', () => {
    expect(APP_VERSION).toBe('1.253.0')
    expect(readFileSync('src/lib/version.ts', 'utf8')).toContain("'1.253.0'")
    expect(readFileSync('deploy/docker-compose.yml', 'utf8')).toContain('restaurantos:1.253.0')
  })

  test('Ž2: dokument PRIMERJAVA nosi v1.230.0 val (C-seznam zaprt)', () => {
    const doc = readFileSync('docs/PRIMERJAVA-VMESNIKOV-2026.md', 'utf8')
    expect(doc).toContain('Val v1.230.0')
    expect(doc).toContain('Samodejni 86 ob izpraznitvi zaloge')
    expect(doc).toContain('Nizka zaloga ob prijavi')
    expect(doc).toContain('Taksacija pijače')
    // zavestna sprememba pina (v1.231.0): dokument je ŽIV sledilnik — v1.230 je
    // zaloge dvignil na 21/22, v1.231 (inventura s čitalnikom) pa na 22/22;
    // števec sledi najnovejši resnici dokumenta, zgodovina vala ostaja zgoraj.
    expect(doc).toContain('22/22')
  })

  test('Ž3: PRD §8 R4b vrstica + worklog vrh (doc-truth)', () => {
    const prd = readFileSync('docs/PRD-LOKALNA-BAZA.md', 'utf8')
    expect(prd).toContain('BENCHMARK-VAL v1.230.0')
    const wl = readFileSync('worklog.md', 'utf8')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.253.0')
    expect(wl.indexOf('Task ID: v1.230.0')).toBeLessThan(wl.indexOf('Task ID: v1.229.0'))
  })

  test('Ž4: i18n števci + novi ključi SL/HR (3853/3853)', () => {
    expect(Object.keys(sl).length).toBe(4053)
    expect(Object.keys(hr).length).toBe(4053)
    for (const k of ['tc.lowStockTitle', 'tc.lowStockOut', 'tc.lowStockMore', 'inv.auto86Title', 'inv.auto86Desc', 'inv.auto86On', 'inv.auto86Off', 'inv.auto86Mode', 'inv.auto86ModeDirect', 'inv.auto86ModeRecipe', 'inv.auto86RecipeHint', 'inv.auto86Saved']) {
      expect(typeof (sl as Record<string, string>)[k]).toBe('string')
      expect(typeof (hr as Record<string, string>)[k]).toBe('string')
    }
    // RESTAURANTOS-AUDIT števec usklajen
    const audit = readFileSync('docs/RESTAURANTOS-AUDIT.md', 'utf8')
    expect(audit).toContain('4053 ključev SL in 4053 HR')
    expect(audit).toContain('POSODOBITEV (v1.230.0')
  })
})
