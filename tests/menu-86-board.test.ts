/**
 * P0-3 (v1.83.0) — TRZNA-VRZELI-2026 §4 P0-3: regresijski testi ozkega
 * 86-endpointa PATCH /api/menus/[id]/availability (OPS-4 v1.67.0, commit 4e7b6e6).
 *
 * Zakaj zdaj: endpoint je od OPS-4 (gumb na KDS listkah) obstajal BREZ testnega
 * pokrova (edini dotik = RBAC matrika v permissions-core.test.ts). V1.83.0
 * 86-plošča na KDS + waiter dialogi (86 + nadomestki) so od njega odvisni —
 * zato zaklenemo celotno pot:
 *   401 (brez žetona) · 403 (cleaner brez menu.availability) · 403 (waiter s
 *   tuje lokacije — tenant guard) · 400 (ni boolean) · 404 (neznan artikel) ·
 *   toggle OFF/ON z revizijsko verigo MENU_ITEM_AVAILABILITY (from → to) ·
 *   idempotenca (unchanged: true, brez novega revizijskega zapisa).
 *
 * Fixture predpona: p086fx- (kaskadni izbris prek Location v afterAll).
 */
import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { PATCH } from '../src/app/api/menus/[id]/availability/route'
import { resolvePermissions } from '../src/lib/permissions'

const PREFIX = 'p086fx-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

function req(url: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'PATCH',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  })
}

async function seedEmployee(role: 'admin' | 'chef' | 'cleaner' | 'waiter', n: number, locId: string) {
  const fields = employeePinFields(`${PIN_BASE}${n}`, `${PREFIX}${role}-${RUN}@test.local`)
  const e = await db.employee.create({
    data: {
      id: `${PREFIX}${role}-${RUN}`,
      name: `${PREFIX}${role}`,
      email: `${PREFIX}${role}-${RUN}@test.local`,
      role,
      status: 'active',
      sessionVersion: 0,
      locationId: locId,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
  const UI = { admin: 'ADMIN', chef: 'CHEF', cleaner: 'CLEANER', waiter: 'WAITER' } as const
  return createToken({ sub: e.id, name: e.name, role: UI[role], loc: locId, sv: 0 })
}

const setupP = (async () => {
  await sweepTestFixtures(db, [PREFIX])
  const locA = await db.location.create({
    data: { id: `${PREFIX}locA-${RUN}`, name: `${PREFIX}Lokacija A`, code: `P086A-${RUN.toUpperCase()}`, premisesId: `${PREFIX}premA-${RUN}` },
  })
  const locB = await db.location.create({
    data: { id: `${PREFIX}locB-${RUN}`, name: `${PREFIX}Lokacija B`, code: `P086B-${RUN.toUpperCase()}`, premisesId: `${PREFIX}premB-${RUN}` },
  })
  const menuA = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locA.id } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menuA.id } })
  const itemA = await db.menuItem.create({ data: { id: `${PREFIX}mi-a-${RUN}`, name: `${PREFIX}Jed A`, price: 10, categoryId: cat.id } })
  const itemB = await db.menuItem.create({ data: { id: `${PREFIX}mi-b-${RUN}`, name: `${PREFIX}Jed B`, price: 12, categoryId: cat.id } })
  const itemC = await db.menuItem.create({ data: { id: `${PREFIX}mi-c-${RUN}`, name: `${PREFIX}Jed C`, price: 8, categoryId: cat.id } })
  return {
    itemAId: itemA.id,
    itemBId: itemB.id,
    itemCId: itemC.id,
    adminToken: await seedEmployee('admin', 1, locA.id),
    chefToken: await seedEmployee('chef', 2, locA.id),
    cleanerToken: await seedEmployee('cleaner', 3, locA.id),
    waiterBToken: await seedEmployee('waiter', 4, locB.id),
  }
})()

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: `${PREFIX}loc` } } }).catch(() => null) // kaskada: Menu → Category → MenuItem
})

const auditCount = (id: string) =>
  db.auditLog.count({ where: { action: 'MENU_ITEM_AVAILABILITY', entityId: id } })

describe('P0-3 v1.83.0 — 86 endpoint: odvisnosti (unit)', () => {
  test('kuhinja/šank/natakar lahko 86 (menu.availability v vlogi), cleaner NE', () => {
    expect(resolvePermissions('chef', []).includes('menu.availability')).toBe(true)
    expect(resolvePermissions('bar', []).includes('menu.availability')).toBe(true)
    expect(resolvePermissions('waiter', []).includes('menu.availability')).toBe(true)
    expect(resolvePermissions('cleaner', []).includes('menu.availability')).toBe(false)
  })
})

describe('P0-3 v1.83.0 — 86 endpoint: zavrnitve (integracija)', () => {
  test('401 brez žetona', async () => {
    const { itemAId } = await setupP
    const res = await PATCH(req(`/api/menus/${itemAId}/availability`), { params: Promise.resolve({ id: itemAId }) })
    expect(res.status).toBe(401)
  })

  test('403 cleaner (manjka menu.availability)', async () => {
    const { cleanerToken, itemAId } = await setupP
    const res = await PATCH(req(`/api/menus/${itemAId}/availability`, cleanerToken, { available: false }), { params: Promise.resolve({ id: itemAId }) })
    expect(res.status).toBe(403)
  })

  test('403 waiter iz tuje lokacije (tenant guard)', async () => {
    const { waiterBToken, itemAId } = await setupP
    const res = await PATCH(req(`/api/menus/${itemAId}/availability`, waiterBToken, { available: false }), { params: Promise.resolve({ id: itemAId }) })
    expect(res.status).toBe(403)
  })

  test('400 ko "available" ni boolean', async () => {
    const { adminToken, itemAId } = await setupP
    const res = await PATCH(req(`/api/menus/${itemAId}/availability`, adminToken, { available: 'ja' }), { params: Promise.resolve({ id: itemAId }) })
    expect(res.status).toBe(400)
  })

  test('404 neznan artikel', async () => {
    const { adminToken } = await setupP
    const res = await PATCH(req(`/api/menus/${PREFIX}neobstaja/availability`, adminToken, { available: false }), { params: Promise.resolve({ id: `${PREFIX}neobstaja` }) })
    expect(res.status).toBe(404)
  })
})

describe('P0-3 v1.83.0 — 86 endpoint: toggle + revizijska veriga', () => {
  test('ADMIN 86 (OFF): 200, DB false, audit from → to', async () => {
    const { adminToken, itemAId } = await setupP
    const before = await auditCount(itemAId)
    const res = await PATCH(req(`/api/menus/${itemAId}/availability`, adminToken, { available: false }), { params: Promise.resolve({ id: itemAId }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ id: itemAId, available: false, unchanged: false })
    const dbItem = await db.menuItem.findUnique({ where: { id: itemAId }, select: { isAvailable: true } })
    expect(dbItem?.isAvailable).toBe(false)
    expect(await auditCount(itemAId)).toBe(before + 1)
    const entry = await db.auditLog.findFirst({ where: { action: 'MENU_ITEM_AVAILABILITY', entityId: itemAId }, orderBy: { timestamp: 'desc' } })
    const details = JSON.parse(entry?.details ?? '{}')
    expect(details).toMatchObject({ name: `${PREFIX}Jed A`, from: true, to: false })
  })

  test('idempotentna ponovitev: unchanged:true, brez novega zapisa', async () => {
    const { adminToken, itemAId } = await setupP
    const before = await auditCount(itemAId)
    const res = await PATCH(req(`/api/menus/${itemAId}/availability`, adminToken, { available: false }), { params: Promise.resolve({ id: itemAId }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ unchanged: true })
    expect(await auditCount(itemAId)).toBe(before)
  })

  test('CHEF obnovi (ON): 200, DB true, nov zapis (kuhinja ima menu.availability)', async () => {
    const { chefToken, itemAId } = await setupP
    const before = await auditCount(itemAId)
    const res = await PATCH(req(`/api/menus/${itemAId}/availability`, chefToken, { available: true }), { params: Promise.resolve({ id: itemAId }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ id: itemAId, available: true, unchanged: false })
    const dbItem = await db.menuItem.findUnique({ where: { id: itemAId }, select: { isAvailable: true } })
    expect(dbItem?.isAvailable).toBe(true)
    expect(await auditCount(itemAId)).toBe(before + 1)
  })

  test('nadomestki (B, C) ostanejo na voljo — vir za 86 ploščo', async () => {
    const { itemBId, itemCId } = await setupP
    const items = await db.menuItem.findMany({ where: { id: { in: [itemBId, itemCId] } }, select: { isAvailable: true } })
    expect(items.length).toBe(2)
    expect(items.every((i) => i.isAvailable)).toBe(true)
  })
})
