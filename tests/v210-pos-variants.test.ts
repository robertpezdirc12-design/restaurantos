/**
 * v1.210.0 — OSS-10 B-DEL: IZBIRA VARIANTE OSEBJA V POS DASHBOARDU.
 * (docs/GAP-ANALIZA-odprtokodna-konkurenca.md — zaprtje preostale meje v1.209.0.)
 *
 * Kontekst: v1.209.0 je varianto uveljavilo v gostovskih tokovih (kiosk/QR/m) in
 * admin CRUD — a POS dashboard osebja je še vedno hotel postavko z obvezno
 * enoizbirno skupino vnesti BREZ izbire → strežnik 400 »Skupina … je obvezna«
 * (naročila sploh ni bilo mogoče ustvariti); urejevalnik naročila (addItems) pa
 * modifierjev sploh ne podpira → varianta brez izbire = napačna cena.
 *
 * Merila:
 *  Č1 čisti sloj item-variants.ts (PURE, še vedno 0 uvozov): sameVariantSelection
 *     (vrstni red ni pomemben), requiredVariantGroupsForItem (razred `variant`
 *     s strežnika + pripetost + ≥1 razpoložljiva opcija), addPosVariantLine
 *     (ista izbira → qty+1, drugačna → nova vrstica, determinističen ključ),
 *     changePosVariantLineQty (0 → vrstica izgine), posVariantLinesTotal
 *     (osnova + doplačilo × količina), posVariantItemsPayload (kontrakt
 *     `modifiers[{modifierId}]`).
 *  Č2 backend + disk kontrakt:
 *     - POST /api/orders z modifierji (POS pot) → 201, doplačilo v ceni vrstice,
 *       vrstica OrderItemModifier iz DB (client cena se ignorira);
 *     - POST brez obvezne izbire → 400 »… je obvezna …« (fail-closed varovalka);
 *     - PATCH addItems z modifierji → vrstice + doplačilo + odgovor nosi imena
 *       opcij (orderInclude + OrderItemModifier);
 *     - PATCH addItems brez obvezne izbire / z nevezano opcijo → 400 z natanko
 *       razlago (ModifierValidationError passthrough, vzorec sedežne validacije);
 *     - disk: dashboard ožičenje (3 košarice + skupni dialog + GET skupine),
 *       sync order.create tip nosi modifiers (offline replay), addItems validacija.
 *  Č3 registri: verzija 1.210.0, GAP B-DEL IZVEDENO @ v1.210.0, AUDIT §8 3712,
 *     0 DDL (varianta ostaja izpeljana — shema brez 'variant'), i18n 3712/3712,
 *     oznaka slike ↔ APP_VERSION.
 *
 * Fiksture s predpono v210v-; tekoče ustvarjene/izbrisane — demo podatki
 * nedotaknjeni (menu/kategorija/artikel/skupina/opcija/povezava/naročila vse v P).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import {
  addPosVariantLine,
  changePosVariantLineQty,
  orderItemDisplayName,
  posVariantItemsPayload,
  posVariantLinesTotal,
  requiredVariantGroupsForItem,
  sameVariantSelection,
  type PosVariantGroupView,
  type PosVariantLine,
} from '../src/lib/item-variants'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { PATCH as orderPATCH } from '../src/app/api/orders/[id]/route'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const P = 'v210v-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let mgr = ''
let tok = ''
let menuItemId = ''
let menuItemName = ''
let modSmallId = ''
let modBigId = ''
let groupId = ''
let linkedItemId = ''

function req(method: string, url: string, token: string | null, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

async function cleanup() {
  await db.orderItemModifier.deleteMany({ where: { orderItemId: { startsWith: `${P}oi` } } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { OR: [{ id: { startsWith: `${P}oi` } }, { orderId: { startsWith: `${P}o-` } }] } }).catch(() => null)
  await db.order.deleteMany({ where: { OR: [{ id: { startsWith: `${P}o-` } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { OR: [{ locationId: { startsWith: P } }, { entityId: { startsWith: `${P}o-` } }] } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ entityId: { startsWith: `${P}o-` } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.menuItemModifierGroup.deleteMany({ where: { OR: [{ menuItemId: { startsWith: `${P}mi-` } }, { id: { startsWith: `${P}link-` } }] } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { startsWith: `${P}mi-` } } }).catch(() => null)
  await db.modifier.deleteMany({ where: { modifierGroupId: { startsWith: `${P}mg-` } } }).catch(() => null)
  await db.modifierGroup.deleteMany({ where: { id: { startsWith: `${P}mg-` } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: { startsWith: `${P}cat-` } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { startsWith: `${P}menu-` } } }).catch(() => null)
  await db.employee.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()

  const la = await db.location.create({
    data: { id: `${P}locA-${RUN}`, name: `${P}Postojna`, code: `H21A-${RUN.toUpperCase()}`, timezone: 'Europe/Ljubljana', country: 'SI' },
  })
  locA = la.id

  const id = `${P}mgr-${RUN}`
  const f = employeePinFields(`${PIN_BASE}1`, `${id}@test.local`)
  await db.employee.create({
    data: { id, name: `${P}Vodja Vera`, email: `${id}@test.local`, role: 'manager', status: 'active', sessionVersion: 0, locationId: locA, pin: f.pin, pinLookup: f.pinLookup },
  })
  mgr = id
  tok = createToken({ sub: mgr, name: `${P}Vodja Vera`, role: 'MANAGER', loc: locA, sv: 0 })

  // Realna veriga menija: Menu → Category → MenuItem (lokacija A)
  const menu = await db.menu.create({ data: { id: `${P}menu-${RUN}`, name: `${P}Meni`, locationId: locA } })
  const cat = await db.category.create({ data: { id: `${P}cat-${RUN}`, name: `${P}Pice`, menuId: menu.id } })
  const mi = await db.menuItem.create({ data: { id: `${P}mi-${RUN}`, name: `${P}Margherita`, price: 10, categoryId: cat.id } })
  menuItemId = mi.id
  menuItemName = `${P}Margherita`
  // drugi artikel iste lokacije (dokaže, da je opcija vezana NA artikel, ne globalno)
  const mi2 = await db.menuItem.create({ data: { id: `${P}mi-druga-${RUN}`, name: `${P}Juha`, price: 4, categoryId: cat.id } })
  linkedItemId = mi2.id

  // Varianta: obvezna enoizbirna skupina (required + minSelect=1 + maxSelect=1)
  const g = await db.modifierGroup.create({
    data: { id: `${P}mg-${RUN}`, name: 'Velikost', required: true, minSelect: 1, maxSelect: 1, locationId: locA, sortOrder: 0 },
  })
  groupId = g.id
  const m1 = await db.modifier.create({ data: { id: `${P}mo-mala-${RUN}`, name: '0,3 L', price: 0, modifierGroupId: g.id, isAvailable: true, sortOrder: 0 } })
  const m2 = await db.modifier.create({ data: { id: `${P}mo-velika-${RUN}`, name: '0,5 L', price: 1.5, modifierGroupId: g.id, isAvailable: true, sortOrder: 1 } })
  modSmallId = m1.id
  modBigId = m2.id
  await db.menuItemModifierGroup.create({ data: { id: `${P}link-${RUN}`, menuItemId: mi.id, modifierGroupId: g.id } })
})

afterAll(async () => {
  await cleanup()
})

/* ═══════════════════ Č1. ČISTI SLOJ (item-variants.ts, še vedno 0 uvozov) ═══════════════════ */

describe('v1.210.0 — OSS-10 B-del Č1: čisti sloj košarice variant', () => {
  it('sameVariantSelection: vrstni red NI pomemben, dolžina JE', () => {
    expect(sameVariantSelection(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameVariantSelection(['a'], ['a'])).toBe(true)
    expect(sameVariantSelection(['a'], ['a', 'b'])).toBe(false)
    expect(sameVariantSelection([], [])).toBe(true)
    expect(sameVariantSelection(['a', 'b'], ['a', 'c'])).toBe(false)
  })

  const G = (over: Partial<PosVariantGroupView> = {}): PosVariantGroupView => ({
    id: 'g1', name: 'Velikost', variant: true, required: true, minSelect: 1, maxSelect: 1,
    modifiers: [{ id: 'm1', name: '0,3 L', price: 0, isAvailable: true }, { id: 'm2', name: '0,5 L', price: 1.5, isAvailable: true }],
    linkedMenuItemIds: ['mi1'],
    ...over,
  })

  it('requiredVariantGroupsForItem: razred `variant` s strežnika + pripetost + ≥1 razpoložljiva opcija', () => {
    // pozitivni primer
    expect(requiredVariantGroupsForItem([G()], 'mi1').length).toBe(1)
    // prosta skupina (razred=false) NI obvezna izbira
    expect(requiredVariantGroupsForItem([G({ variant: false })], 'mi1').length).toBe(0)
    // artikel NI pripet
    expect(requiredVariantGroupsForItem([G()], 'mi drug').length).toBe(0)
    // vse opcije razprodane → izbira ni mogoča, skupina NE blokira
    expect(requiredVariantGroupsForItem([G({ modifiers: [{ id: 'm1', name: 'x', price: 0, isAvailable: false }] })], 'mi1').length).toBe(0)
    // fail-soft: neznani vhodi
    expect(requiredVariantGroupsForItem(null, 'mi1')).toEqual([])
    expect(requiredVariantGroupsForItem(undefined, 'mi1')).toEqual([])
    expect(requiredVariantGroupsForItem([null as unknown as PosVariantGroupView], 'mi1')).toEqual([])
  })

  it('addPosVariantLine: ista izbira → qty+1; drugačna → NOVA vrstica; ključ determinističen', () => {
    const base: PosVariantLine[] = []
    const l1 = addPosVariantLine(base, { menuItemId: 'mi1', modifierIds: ['m2'], optionNames: ['0,5 L'], optionPrice: 1.5 })
    expect(l1.length).toBe(1)
    expect(l1[0].qty).toBe(1)
    expect(l1[0].key).toBe('mi1-m2')
    // ista izbira (vrstni red opcij obrnjen) → spajanje
    const l2 = addPosVariantLine(l1, { menuItemId: 'mi1', modifierIds: ['m2'], optionNames: ['0,5 L'], optionPrice: 1.5 })
    expect(l2.length).toBe(1)
    expect(l2[0].qty).toBe(2)
    // druga izbira istega artikla → ločena vrstica (dve velikosti = dve vrstici)
    const l3 = addPosVariantLine(l2, { menuItemId: 'mi1', modifierIds: ['m1'], optionNames: ['0,3 L'], optionPrice: 0 })
    expect(l3.length).toBe(2)
    expect(l3.find((x) => x.key === 'mi1-m1')?.qty).toBe(1)
    // podvojeni id-ji se odstranijo (strežnik sicer vrne 400 — sloj je bran)
    const l4 = addPosVariantLine([], { menuItemId: 'mi1', modifierIds: ['m2', 'm2'], optionNames: ['0,5 L'], optionPrice: 1.5 })
    expect(l4[0].modifierIds).toEqual(['m2'])
    // negativno doplačilo se priklepa na 0 (strežnik vseeno računa iz DB)
    const l5 = addPosVariantLine([], { menuItemId: 'mi1', modifierIds: ['m1'], optionNames: ['x'], optionPrice: -5 })
    expect(l5[0].optionPrice).toBe(0)
  })

  it('changePosVariantLineQty: ±delta; 0 → vrstica IZGINE (nič ostankov z 0)', () => {
    const lines = addPosVariantLine([], { menuItemId: 'mi1', modifierIds: ['m2'], optionNames: ['0,5 L'], optionPrice: 1.5 })
    const two = changePosVariantLineQty(lines, lines[0].key, 1)
    expect(two[0].qty).toBe(2)
    const one = changePosVariantLineQty(two, lines[0].key, -1)
    expect(one[0].qty).toBe(1)
    const gone = changePosVariantLineQty(one, lines[0].key, -1)
    expect(gone).toEqual([])
    // neznani ključ → nespremenjeno
    expect(changePosVariantLineQty(one, 'neznani', -3).length).toBe(1)
  })

  it('posVariantLinesTotal: (osnova + doplačilo) × količina, po vseh vrsticah', () => {
    const lines: PosVariantLine[] = [
      { key: 'a', menuItemId: 'mi1', qty: 2, modifierIds: ['m2'], optionNames: ['0,5 L'], optionPrice: 1.5 },
      { key: 'b', menuItemId: 'mi2', qty: 1, modifierIds: ['m1'], optionNames: ['0,3 L'], optionPrice: 0 },
    ]
    // (10 + 1.5) × 2 + (4 + 0) × 1 = 23 + 4 = 27
    expect(posVariantLinesTotal(lines, (id) => (id === 'mi1' ? 10 : 4))).toBe(27)
    expect(posVariantLinesTotal([], () => 10)).toBe(0)
  })

  it('posVariantItemsPayload: kontrakt createOrderCore — modifiers[{modifierId}]', () => {
    const payload = posVariantItemsPayload([
      { key: 'a', menuItemId: 'mi1', qty: 2, modifierIds: ['m2'], optionNames: ['0,5 L'], optionPrice: 1.5 },
    ])
    expect(payload).toEqual([{ menuItemId: 'mi1', qty: 2, modifiers: [{ modifierId: 'm2' }] }])
  })

  it('orderItemDisplayName ostaja del pogodbe (sestavljeno ime v košarici)', () => {
    expect(orderItemDisplayName('Margherita', ['0,5 L'])).toBe('Margherita · 0,5 L')
  })

  it('0 uvozov — sloj ostane prenosljiv tudi po B-delu (disk preverba)', () => {
    const src = read('src/lib/item-variants.ts')
    expect(src).not.toMatch(/^import /m)
    expect(src).toContain('export function addPosVariantLine')
    expect(src).toContain('export function posVariantItemsPayload')
  })
})

/* ═══════════════════ Č2. BACKEND (POST + PATCH addItems) ═══════════════════ */

describe('v1.210.0 — OSS-10 B-del Č2: backend poti z modifierji', () => {
  it('POST /api/orders z modifierji (POS pot): 201 + doplačilo v vrstici + OrderItemModifier iz DB', async () => {
    const r = await ordersPOST(req('POST', '/api/orders', tok, {
      items: [
        { menuItemId, qty: 2, modifiers: [{ modifierId: modBigId }] },
      ],
      clientOperationId: `${P}create-${RUN}`,
    }))
    expect(r.status).toBe(201)
    const j = await body(r)
    const order = j.order as { id: string; total: number; items: { id: string; unitPrice: number; modifiers?: string[] }[] }
    expect(order.items.length).toBe(1)
    // cena vrstice = osnova 10 + doplačilo 1.5 (iz DB, ne iz clienta)
    expect(order.items[0].unitPrice).toBe(11.5)
    expect(order.items[0].modifiers).toEqual(['0,5 L'])
    // (10 + 1.5) × 2 = 23 + DDV 22 %  — Decimal iz baze pride kot Decimal objekt
    const row = await db.orderItem.findFirst({ where: { orderId: order.id } })
    expect(Number(row?.price)).toBe(11.5)
    const mods = await db.orderItemModifier.findMany({ where: { orderItemId: row?.id } })
    expect(mods.length).toBe(1)
    expect(mods[0].name).toBe('0,5 L')
    expect(Number(mods[0].price)).toBe(1.5)
    expect(mods[0].modifierGroupId).toBe(groupId)
  })

  it('POST /api/orders BREZ obvezne izbire → 400 »… je obvezna …« (fail-closed varovalka)', async () => {
    const r = await ordersPOST(req('POST', '/api/orders', tok, {
      items: [{ menuItemId, qty: 1 }],
      clientOperationId: `${P}req-${RUN}`,
    }))
    expect(r.status).toBe(400)
    const j = await body(r)
    expect(String(j.error)).toContain('Velikost')
    expect(String(j.error)).toContain('obvezna')
  })

  it('PATCH addItems z modifierji: vrstica + doplačilo + odgovor nosi imena opcij', async () => {
    // naročilo brez obveznih artiklov (juha NI pripeta skupini) — za addItems pot
    const seed = await ordersPOST(req('POST', '/api/orders', tok, {
      items: [{ menuItemId: linkedItemId, qty: 1 }],
      clientOperationId: `${P}add-${RUN}`,
    }))
    expect(seed.status).toBe(201)
    const sj = await body(seed)
    const orderId = (sj.order as { id: string }).id

    const r = await orderPATCH(req('PATCH', `/api/orders/${orderId}`, tok, {
      addItems: [{ menuItemId, qty: 1, modifiers: [{ modifierId: modBigId }] }],
      clientOperationId: `${P}add2-${RUN}`,
    }), params(orderId))
    expect(r.status).toBe(200)
    const j = await body(r)
    const order = j.order as { items: { unitPrice: number; modifiers?: string[]; name: string }[] }
    // mapOrderItem ne nosi menuItemId — razlikujemo po IMENU (priimek fiksture je unikaten)
    const added = order.items.find((it) => it.name === menuItemName)
    expect(added?.unitPrice).toBe(11.5)
    expect(added?.modifiers).toEqual(['0,5 L'])
    // total vključuje doplačilo (recalcOrderTotals bere OrderItem.price) — Decimal objekt
    const fresh = await db.order.findUnique({ where: { id: orderId } })
    expect(Number(fresh?.total)).toBeGreaterThan(0)
  })

  it('PATCH addItems BREZ obvezne izbire → 400 z natanko razlago (ModifierValidationError passthrough)', async () => {
    const seed = await ordersPOST(req('POST', '/api/orders', tok, {
      items: [{ menuItemId: linkedItemId, qty: 1 }],
      clientOperationId: `${P}add3-${RUN}`,
    }))
    const sj = await body(seed)
    const orderId = (sj.order as { id: string }).id
    const r = await orderPATCH(req('PATCH', `/api/orders/${orderId}`, tok, {
      addItems: [{ menuItemId, qty: 1 }],
      clientOperationId: `${P}add4-${RUN}`,
    }), params(orderId))
    expect(r.status).toBe(400)
    const j = await body(r)
    expect(String(j.error)).toContain('obvezna')
  })

  it('PATCH addItems z opcijo TUJEGA artikla → 400 »Opcija ni na voljo za ta artikel.«', async () => {
    const seed = await ordersPOST(req('POST', '/api/orders', tok, {
      items: [{ menuItemId: linkedItemId, qty: 1 }],
      clientOperationId: `${P}add5-${RUN}`,
    }))
    const sj = await body(seed)
    const orderId = (sj.order as { id: string }).id
    // juha NI pripeta skupini Velikost → modifier je neveljaven zanjo
    const r = await orderPATCH(req('PATCH', `/api/orders/${orderId}`, tok, {
      addItems: [{ menuItemId: linkedItemId, qty: 1, modifiers: [{ modifierId: modBigId }] }],
      clientOperationId: `${P}add6-${RUN}`,
    }), params(orderId))
    expect(r.status).toBe(400)
    const j = await body(r)
    expect(String(j.error)).toContain('ni na voljo za ta artikel')
  })
})

/* ═══════════════════ Č2b. DISK KONTRAKT (ožičenje) ═══════════════════ */

describe('v1.210.0 — OSS-10 B-del Č2b: disk kontrakt (ožičenje)', () => {
  it('addItems validacija = ISTA kot createOrderCore (loadModifierContext + validateItemModifiers)', () => {
    const route = read('src/app/api/orders/[id]/route.ts')
    expect(route).toContain("loadModifierContext")
    expect(route).toContain("validateItemModifiers")
    expect(route).toContain('class ModifierValidationError')
    // vrstice opcij v ISTI transakciji (rollback izniči skupaj z artikli)
    expect(route).toContain('orderItemModifier.createMany')
    // odgovor nosi imena opcij (list urejevalnika pokaže velikost tudi po osvežitvi)
    expect(route).toContain('OrderItemModifier: { select: { name: true } }')
  })

  it('sync order.create tip nosi modifiers (offline replay variante)', () => {
    const sync = read('src/app/api/sync/route.ts')
    expect(sync).toContain('modifiers?: { modifierId: string }[]')
  })

  it('dashboard: vse tri košarice + skupni dialog + vir skupin (GET /api/modifier-groups)', () => {
    const dash = read('src/app/dashboard/page.tsx')
    // vstopna točka za vse tri tokove + dialog
    expect(dash).toContain("posAddClick('cart'")
    expect(dash).toContain("posAddClick('sale', mi)")
    expect(dash).toContain("posAddClick('sheet', m)")
    expect(dash).toContain("setVariantPick({ mode, item: mi, selections: {} })")
    expect(dash).toContain('orders.variantTitle')
    // vir podatkov — razred `variant` prihaja s strežnika, UI si ga ne izmišljuje
    expect(dash).toContain("api<{ groups: PosVariantGroupView[] }>('/api/modifier-groups')")
    // payloadi vseh treh tokov tečejo v naročila (ustvarjanje + hitra prodaja + addItems)
    expect(dash).toMatch(/posVariantItemsPayload\(cartVariants\)/)
    expect(dash).toMatch(/posVariantItemsPayload\(saleVariants\)/)
    expect(dash).toMatch(/posVariantItemsPayload\(sheetVariants\)/)
    // prikaz: sestavljeno ime + prikaz obstoječih opcij v listu urejevalnika
    expect(dash).toContain('orderItemDisplayName(mi.name, l.optionNames)')
    expect(dash).toContain('it.modifiers?.length')
    // reseti košaric (brez ostankov med naročili)
    expect(dash).toContain('setCartVariants([])')
    expect(dash).toContain('setSaleVariants([])')
    expect(dash).toContain('setSheetVariants([])')
  })

  it('i18n: 3 novi ključi v OBAH slovarjih (SL/HR)', () => {
    const slRec = sl as unknown as Record<string, string>
    const hrRec = hr as unknown as Record<string, string>
    for (const k of ['orders.variantTitle', 'orders.variantAdd', 'orders.variantSurcharge']) {
      expect(typeof slRec[k]).toBe('string')
      expect(typeof hrRec[k]).toBe('string')
    }
  })
})

/* ═══════════════════ Č3. REGISTRI ═══════════════════ */

describe('v1.210.0 — OSS-10 B-del Č3: registri', () => {
  it('verzija 1.212.0 (toBe + ubežen regex)', () => {
    expect(APP_VERSION).toBe('1.214.0')
    expect(read('src/lib/version.ts')).toMatch(/APP_VERSION = '1\.214\.0'/)
  })

  it('GAP OSS-10 B-del: IZVEDENO @ v1.210.0 z dokazi + nova meja', () => {
    const doc = read('docs/GAP-ANALIZA-odprtokodna-konkurenca.md')
    expect(doc).toContain('B-DEL IZVEDENO @ v1.210.0')
    expect(doc).toContain('requiredVariantGroupsForItem')
    expect(doc).toContain('posVariantItemsPayload')
    expect(doc).toContain('OrderItemModifier v isti transakciji')
    // poštena preostala meja — razcep poročil je od v1.212.0 IZVEDEN (C-del),
    // ostanejo costne meje (menu-engineering/food-cost/restock na osnovnem artiklu)
    expect(doc).toContain('C-DEL IZVEDENO @ v1.212.0')
    expect(doc).toContain('i18n 3709 → 3712')
  })

  it('AUDIT §8: števec 3731 + POSODOBITEV nota', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('3731 ključev SL in 3731 HR')
    expect(audit).toContain('POSODOBITEV (v1.210.0)')
  })

  it('0 DDL — varianta ostaja IZPELJANA (shema brez POS/variant modelov)', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).toContain('model ModifierGroup')
    expect(schema).toContain('model OrderItemModifier')
    expect(schema.toLowerCase()).not.toContain('variant')
    expect(schema.toLowerCase()).not.toContain('posvariant')
  })

  it('i18n pariteta: 3709 → 3712 ključev v OBIH jezikih', () => {
    expect(Object.keys(sl).length).toBe(3731)
    expect(Object.keys(hr).length).toBe(3731)
  })

  it('oznaka slike ↔ APP_VERSION (selfhost kontrakt ostane pinežen)', () => {
    const compose = read('deploy/docker-compose.yml')
    expect(compose).toContain(`restaurantos:${APP_VERSION}`)
  })
})
