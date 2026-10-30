/**
 * OSS-4 (v1.204.0) — HOLD/DRAFT NAROČILA
 * (docs/GAP-ANALIZA-odprtokodna-konkurenca.md — kandidat OSS-4, izvor OrderRestro
 * "Hold/draft naročila — zadrži nedokončano naročilo brez zaključka").
 *
 * Merila:
 *  Č1 čisti sloj order-hold.ts (PURE, 0 DB): canHoldOrder (samo open + unpaid +
 *     firedAt null; vrstni red preverb: obstoj → status → požgane postavke →
 *     plačila), canResumeOrder (samo iz 'hold'), sanitizeHoldReason (trim,
 *     kontrolni znaki ven, zloženi presledki, ≤ 200, ne-niz → '').
 *  Č2 backend:
 *     - 401 brez žetona (hold + resume); 404 neznani id; 403 za vlogo brez
 *       orders.create (KITCHEN) in za tujo lokacijo (guardResource);
 *     - hold srečna pot: 200 + status 'hold' v bazi + revizija ORDER_HOLD
 *       (s razlogom in brez) + dogodek; ponovljen hold → 409 (ni več open);
 *     - hold zavrača: požgano (firedAt), delno plačano ('partial'), 'sent',
 *       'cancelled', 'paid' → 409 (fail-closed pred kuhinjo in denarjem);
 *     - resume: 200 → status 'open' + revizija ORDER_RESUMED; resume ne-zadržanega
 *       → 409; 404 neznani id;
 *     - zadržano naročilo je fail-closed na VSEH mutacijskih poteh (bele liste
 *       ORDER_MUTABLE_STATUS / ORDER_ACTIVE_DB / ORDER_PAYABLE_STATUS ne poznajo
 *       'hold'): fire 409, tečaji 409, PATCH preklic 409;
 *     - R7 GARANCIJA (interakcija z offline vrsto): sync order.addItems nad
 *       zadržanim naročilom → results[0].ok=false, EN DeviceSyncOperation 'failed'
 *       (replay ne podvoji — retryCount raste); PO nadaljevanju ista operacija
 *       uspe in postavke so dodane (vrsta se opomore — R2/R7 garancija ohranjena);
 *     - GET /api/orders?status=hold vrne zadržano; privzeti GET NE;
 *     - GET /api/tables: miza z zadržanim naročilom je OCCUPIED (Issue #70
 *       kanonična izpeljava) + heldOrderId nastavljen + activeOrder null.
 *  Č3 registri: orderStatusToUI('hold')='HOLD' + orderStatusToDB('HOLD')='hold',
 *     dashboard statika (HOLD barva + oznaka + gumbi + filter + dialog + fetch),
 *     i18n pariteta novih ključev (po 10 v SL/HR), GAP-ANALIZA OSS-4 IZVEDENO,
 *     shema NESPREMENJENA (Order.status ostaja String — 0 DDL), verzija 1.204.0.
 *
 * Fiksture s predpono v204h-; tekoče ustvarjene/izbrisane — po teku testa so
 * Order/OrderItem/Table/DeviceSyncOperation/audit v vhodnem stanju (demo podatki
 * 230 artiklov nedotaknjeni).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import { canHoldOrder, canResumeOrder, sanitizeHoldReason } from '../src/lib/order-hold'
import { orderStatusToUI, orderStatusToDB } from '../src/lib/map'
import { POST as holdPOST } from '../src/app/api/orders/[id]/hold/route'
import { POST as resumePOST } from '../src/app/api/orders/[id]/resume/route'
import { POST as firePOST } from '../src/app/api/orders/[id]/fire/route'
import { PATCH as orderPATCH } from '../src/app/api/orders/[id]/route'
import { POST as coursesPOST } from '../src/app/api/orders/[id]/courses/route'
import { POST as syncPOST } from '../src/app/api/sync/route'
import { GET as ordersGET } from '../src/app/api/orders/route'
import { GET as tablesGET } from '../src/app/api/tables/route'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v204h-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let locB = ''
let mgr = ''
let kitchen = ''
let waiterB = ''
let tok = ''
let kitchenToken = ''
let waiterBToken = ''
let menuItemId = ''
let tableId = ''

let ordSeq = 1000
/** Direktno sejanje naročila (statusi kontrolirano — vzorec race-fixes seedOrder). */
async function seedOrder(suffix: string, opts: { status?: string; paymentStatus?: string; firedAt?: Date | null; tableId?: string | null } = {}) {
  ordSeq += 1
  return db.order.create({
    data: {
      id: `${P}o${suffix}-${RUN}`,
      orderNumber: ordSeq,
      locationId: locA,
      tableId: opts.tableId ?? null,
      status: opts.status ?? 'open',
      paymentStatus: opts.paymentStatus ?? 'unpaid',
      firedAt: opts.firedAt ?? null,
      subtotal: 10,
      tax: 2.2,
      total: 12.2,
    },
  })
}

async function seedItem(orderId: string, suffix: string) {
  return db.orderItem.create({
    data: {
      id: `${P}itm${suffix}-${RUN}`,
      orderId,
      menuItemId,
      quantity: 1,
      price: 10,
      vatRate: 22,
      vatAmount: 2.2,
      menuItemName: `${P}Jed`,
      status: 'pending',
    },
  })
}

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
  await db.deviceSyncOperation.deleteMany({ where: { OR: [{ deviceId: { startsWith: `${P}dev` } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ entityId: { startsWith: `${P}o` } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { OR: [{ id: { startsWith: `${P}itm` } }, { orderId: { startsWith: `${P}o` } }] } }).catch(() => null)
  await db.order.deleteMany({ where: { OR: [{ id: { startsWith: `${P}o` } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.table.deleteMany({ where: { locationId: { startsWith: P } } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { startsWith: `${P}mi-` } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: { startsWith: `${P}cat-` } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { startsWith: `${P}menu-` } } }).catch(() => null)
  await db.auditLog
    .deleteMany({
      where: {
        OR: [
          { locationId: { startsWith: P } },
          { entityId: { startsWith: `${P}o` } },
          { action: { in: ['ORDER_HOLD', 'ORDER_RESUMED', 'ORDER_FIRED'] } },
        ],
      },
    })
    .catch(() => null)
  await db.employee.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()

  const la = await db.location.create({
    data: { id: `${P}locA-${RUN}`, name: `${P}Ljubljana`, code: `H20A-${RUN.toUpperCase()}`, timezone: 'Europe/Ljubljana', country: 'SI' },
  })
  locA = la.id
  const lb = await db.location.create({
    data: { id: `${P}locB-${RUN}`, name: `${P}Maribor`, code: `H20B-${RUN.toUpperCase()}`, timezone: 'Europe/Ljubljana', country: 'SI' },
  })
  locB = lb.id

  const seed = async (key: string, name: string, role: string, loc: string, seq: number): Promise<string> => {
    const id = `${P}${key}-${RUN}`
    const f = employeePinFields(`${PIN_BASE}${seq}`, `${id}@test.local`)
    await db.employee.create({
      data: { id, name, email: `${id}@test.local`, role, status: 'active', sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup },
    })
    return id
  }
  mgr = await seed('mgr', `${P}Vodja Vida`, 'manager', locA, 1)
  kitchen = await seed('kit', `${P}Kuhar Klemen`, 'kitchen', locA, 2)
  waiterB = await seed('waitB', `${P}Natakar Nino`, 'waiter', locB, 3)
  tok = createToken({ sub: mgr, name: `${P}Vodja Vida`, role: 'MANAGER', loc: locA, sv: 0 })
  kitchenToken = createToken({ sub: kitchen, name: `${P}Kuhar Klemen`, role: 'KITCHEN', loc: locA, sv: 0 })
  waiterBToken = createToken({ sub: waiterB, name: `${P}Natakar Nino`, role: 'WAITER', loc: locB, sv: 0 })

  // Realna veriga menija za sync addItems (Menu → Category → MenuItem, lokacija A)
  const menu = await db.menu.create({ data: { id: `${P}menu-${RUN}`, name: `${P}Meni`, locationId: locA } })
  const cat = await db.category.create({ data: { id: `${P}cat-${RUN}`, name: `${P}Kategorija`, menuId: menu.id } })
  const mi = await db.menuItem.create({ data: { id: `${P}mi-${RUN}`, name: `${P}Jed`, price: 10, categoryId: cat.id } })
  menuItemId = mi.id

  const tb = await db.table.create({ data: { id: `${P}tbl-${RUN}`, number: 9400 + (Date.now() % 500), locationId: locA, status: 'occupied' } })
  tableId = tb.id
})

afterAll(async () => {
  await cleanup()
})

/* ═══════════════════ Č1. ČISTI SLOJ (order-hold.ts) ═══════════════════ */

describe('Č1 čisti sloj hold (pure)', () => {
  it('canHoldOrder: odprto + neplačano + brez poslanih postavk → ok', () => {
    expect(canHoldOrder({ status: 'open', paymentStatus: 'unpaid', firedAt: null })).toEqual({ ok: true })
  })

  it('canHoldOrder: vrstni red preverb — neobstoječe → status → požgane → plačila', () => {
    expect(canHoldOrder(null).ok).toBe(false)
    expect((canHoldOrder(null) as { error: string }).error).toBe('Naročilo ne obstaja.')
    // status NI 'open' → napaka o statusu (ne o kuhinji/plačilih)
    const sent = canHoldOrder({ status: 'sent', paymentStatus: 'unpaid', firedAt: null })
    expect(sent.ok).toBe(false)
    expect((sent as { error: string }).error).toContain('Samo odprta')
    expect((sent as { error: string }).error).toContain('sent')
    // požgane postavke (firedAt nastavljen) — kuhinja že dela
    const fired = canHoldOrder({ status: 'open', paymentStatus: 'unpaid', firedAt: new Date() })
    expect(fired.ok).toBe(false)
    expect((fired as { error: string }).error).toContain('kuhinja že pripravlja')
    // delna plačila so izključena
    const partial = canHoldOrder({ status: 'open', paymentStatus: 'partial', firedAt: null })
    expect(partial.ok).toBe(false)
    expect((partial as { error: string }).error).toContain('plačili')
    // kombinacija: požgano + delno plačano → zmaga kuhinja (preverb pred plačili)
    const both = canHoldOrder({ status: 'open', paymentStatus: 'partial', firedAt: new Date() })
    expect((both as { error: string }).error).toContain('kuhinja že pripravlja')
  })

  it('canHoldOrder: terminalna stanja so zavrnjena', () => {
    for (const s of ['prepared', 'paid', 'cancelled', 'storno', 'hold']) {
      expect(canHoldOrder({ status: s, paymentStatus: 'unpaid', firedAt: null }).ok).toBe(false)
    }
  })

  it('canResumeOrder: samo iz hold', () => {
    expect(canResumeOrder({ status: 'hold' })).toEqual({ ok: true })
    expect(canResumeOrder({ status: 'open' }).ok).toBe(false)
    expect((canResumeOrder({ status: 'open' }) as { error: string }).error).toBe('Naročilo ni zadržano.')
    expect(canResumeOrder(null).ok).toBe(false)
  })

  it('sanitizeHoldReason: trim, kontrolni znaki, zloženi presledki, dolžina, ne-niz', () => {
    expect(sanitizeHoldReason('  gost čaka  ')).toBe('gost čaka')
    expect(sanitizeHoldReason('a\nb\tc')).toBe('a b c')
    expect(sanitizeHoldReason('x\u0000y\u007fz')).toBe('x y z')
    expect(sanitizeHoldReason('a'.repeat(300))).toHaveLength(200)
    expect(sanitizeHoldReason(42)).toBe('')
    expect(sanitizeHoldReason(undefined)).toBe('')
    expect(sanitizeHoldReason('   ')).toBe('')
  })
})

/* ═══════════════════ Č2. BACKEND ═══════════════════ */

describe('Č2 hold/resume rute — vrata in garda', () => {
  it('401 brez žetona (hold + resume)', async () => {
    const o = await seedOrder('noauth')
    expect((await holdPOST(req('POST', `/api/orders/${o.id}/hold`, null, {}), params(o.id))).status).toBe(401)
    expect((await resumePOST(req('POST', `/api/orders/${o.id}/resume`, null), params(o.id))).status).toBe(401)
  })

  it('404 neznani id; 403 brez orders.create (KITCHEN) in tuja lokacija', async () => {
    expect((await holdPOST(req('POST', '/api/orders/ne-obstaja/hold', tok, {}), params('ne-obstaja'))).status).toBe(404)
    expect((await resumePOST(req('POST', '/api/orders/ne-obstaja/resume', tok), params('ne-obstaja'))).status).toBe(404)

    const o = await seedOrder('guards')
    await seedItem(o.id, 'g')
    // kuhinja nima orders.create
    const k = await holdPOST(req('POST', `/api/orders/${o.id}/hold`, kitchenToken, {}), params(o.id))
    expect(k.status).toBe(403)
    // natakar tuj lokacije (locB) → guardResource 403
    const wb = await holdPOST(req('POST', `/api/orders/${o.id}/hold`, waiterBToken, {}), params(o.id))
    expect(wb.status).toBe(403)
    // naročilo ostane netaknjeno
    expect((await db.order.findUnique({ where: { id: o.id } }))?.status).toBe('open')
  })

  it('hold srečna pot: 200 + status hold + revizija ORDER_HOLD (z razlogom)', async () => {
    const o = await seedOrder('hold-ok', { tableId })
    await seedItem(o.id, 'h1')
    const res = await holdPOST(req('POST', `/api/orders/${o.id}/hold`, tok, { reason: `gost čaka ${P}` }), params(o.id))
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.held).toBe(true)
    expect(((j.order as { status: string }).status)).toBe('HOLD') // mapOrder preslika v UI oznako

    const row = await db.order.findUnique({ where: { id: o.id } })
    expect(row?.status).toBe('hold')

    const audits = await db.auditLog.findMany({ where: { action: 'ORDER_HOLD', entityId: o.id } })
    expect(audits).toHaveLength(1)
    const details = JSON.parse(audits[0].details || '{}') as Record<string, unknown>
    expect(details.reason).toBe(`gost čaka ${P}`)
    expect(details.by).toBe(`${P}Vodja Vida`)

    // miza z zadržanim ostaja zasedena (Issue #70 izpeljava prek tables GET)
    const tRes = await tablesGET(req('GET', '/api/tables', tok))
    expect(tRes.status).toBe(200)
    const tj = await body(tRes)
    const tRow = (tj.tables as { id: string; status: string; activeOrder: unknown; heldOrderId: string | null }[]).find((x) => x.id === tableId)
    expect(tRow?.status).toBe('OCCUPIED')
    expect(tRow?.heldOrderId).toBe(o.id)
    expect(tRow?.activeOrder).toBeNull()
  })

  it('ponovljen hold → 409 (ni več open); hold požganega/partial/sent/cancelled → 409', async () => {
    const held = await seedOrder('held', { status: 'hold' })
    const again = await holdPOST(req('POST', `/api/orders/${held.id}/hold`, tok, {}), params(held.id))
    expect(again.status).toBe(409)

    const fired = await seedOrder('fired', { firedAt: new Date() })
    expect((await holdPOST(req('POST', `/api/orders/${fired.id}/hold`, tok, {}), params(fired.id))).status).toBe(409)

    const partial = await seedOrder('partial', { paymentStatus: 'partial' })
    expect((await holdPOST(req('POST', `/api/orders/${partial.id}/hold`, tok, {}), params(partial.id))).status).toBe(409)

    const sent = await seedOrder('sent', { status: 'sent' })
    expect((await holdPOST(req('POST', `/api/orders/${sent.id}/hold`, tok, {}), params(sent.id))).status).toBe(409)

    const cancelled = await seedOrder('cancelled', { status: 'cancelled' })
    expect((await holdPOST(req('POST', `/api/orders/${cancelled.id}/hold`, tok, {}), params(cancelled.id))).status).toBe(409)
  })

  it('resume: 200 → open + revizija ORDER_RESUMED; resume ne-zadržanega → 409', async () => {
    const o = await seedOrder('resume')
    await seedItem(o.id, 'r1')
    expect((await holdPOST(req('POST', `/api/orders/${o.id}/hold`, tok, {}), params(o.id))).status).toBe(200)

    const res = await resumePOST(req('POST', `/api/orders/${o.id}/resume`, tok), params(o.id))
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.resumed).toBe(true)
    expect((await db.order.findUnique({ where: { id: o.id } }))?.status).toBe('open')

    const audits = await db.auditLog.findMany({ where: { action: 'ORDER_RESUMED', entityId: o.id } })
    expect(audits).toHaveLength(1)

    // nadaljevano naročilo je spet polno mutabilno (PATCH addItems uspe)
    const patch = await orderPATCH(req('PATCH', `/api/orders/${o.id}`, tok, { addItems: [{ menuItemId, qty: 1 }] }), params(o.id))
    expect(patch.status).toBe(200)

    // drugi resume → 409 (ni več hold)
    expect((await resumePOST(req('POST', `/api/orders/${o.id}/resume`, tok), params(o.id))).status).toBe(409)
  })

  it('zadržano je fail-closed: fire 409, tečaji 409, PATCH preklic 409', async () => {
    const o = await seedOrder('closed', { tableId })
    await seedItem(o.id, 'c1')
    expect((await holdPOST(req('POST', `/api/orders/${o.id}/hold`, tok, {}), params(o.id))).status).toBe(200)

    // fire (entry gard — 'hold' ni mutabilen)
    expect((await firePOST(req('POST', `/api/orders/${o.id}/fire`, tok, {}), params(o.id))).status).toBe(409)
    // tečaji (OSS-4 garda)
    const crs = await coursesPOST(req('POST', `/api/orders/${o.id}/courses`, tok, { name: `${P}T1`, itemIds: [] }), params(o.id))
    expect(crs.status).toBe(409)
    // PATCH s statusom cancelled (claimMutableOrder → 409; UI vrednosti UPPERCASE,
    // preklic pa potrebuje tudi razlog — validateExceptionReason ≥ 3 znaki)
    const pc = await orderPATCH(req('PATCH', `/api/orders/${o.id}`, tok, { status: 'CANCELLED', reason: 'v204 testni preklic' }), params(o.id))
    expect(pc.status).toBe(409)
    // fire na OPEN naročilu ŠE VEDNO deluje (ni regresije obstoječe poti)
    const open = await seedOrder('fire-ok')
    await seedItem(open.id, 'f1')
    const fr = await firePOST(req('POST', `/api/orders/${open.id}/fire`, tok, {}), params(open.id))
    expect(fr.status).toBe(200)
    const fj = await body(fr)
    expect(fj.firedCount).toBe(1)
  })

  it('R7 GARANCIJA: sync addItems nad zadržanim → failed; po nadaljevanju ista operacija uspe', async () => {
    const o = await seedOrder('r7')
    await seedItem(o.id, 's1')
    expect((await holdPOST(req('POST', `/api/orders/${o.id}/hold`, tok, {}), params(o.id))).status).toBe(200)

    const deviceId = `${P}dev-${RUN}`
    const coid = `${P}coid-r7-${RUN}`
    const syncBody = {
      deviceId,
      ops: [{ kind: 'order.addItems', clientOperationId: coid, payload: { orderId: o.id, addItems: [{ menuItemId, qty: 2 }] } }],
    }
    const res1 = await syncPOST(req('POST', '/api/sync', tok, syncBody))
    expect(res1.status).toBe(200)
    const j1 = await body(res1)
    expect((j1.results as { ok: boolean }[])[0].ok).toBe(false)

    const rows1 = await db.deviceSyncOperation.findMany({ where: { deviceId, clientOperationId: coid } })
    expect(rows1).toHaveLength(1)
    expect(rows1[0].status).toBe('failed')
    expect(rows1[0].clientRetryCount).toBe(1)
    // postavka NI dodana
    expect(await db.orderItem.count({ where: { orderId: o.id } })).toBe(1)

    // replay brez nadaljevanja → še vedno EN zapis (retryCount raste, ne podvoji)
    await syncPOST(req('POST', '/api/sync', tok, syncBody))
    const rows2 = await db.deviceSyncOperation.findMany({ where: { deviceId, clientOperationId: coid } })
    expect(rows2).toHaveLength(1)
    expect(rows2[0].clientRetryCount).toBe(2)

    // nadaljevanje → ista operacija (isti clientOperationId) sedaj USPE
    expect((await resumePOST(req('POST', `/api/orders/${o.id}/resume`, tok), params(o.id))).status).toBe(200)
    const res3 = await syncPOST(req('POST', '/api/sync', tok, syncBody))
    expect(res3.status).toBe(200)
    const j3 = await body(res3)
    expect((j3.results as { ok: boolean }[])[0].ok).toBe(true)

    const rows3 = await db.deviceSyncOperation.findMany({ where: { deviceId, clientOperationId: coid } })
    expect(rows3).toHaveLength(1) // ista vrstica — replay ne podvoji
    expect(rows3[0].status).toBe('applied')
    expect(await db.orderItem.count({ where: { orderId: o.id } })).toBe(2) // +1 postavka (qty 2 → vrstica 1)
    const after = await db.order.findUnique({ where: { id: o.id } })
    expect(Number(after?.total)).toBeGreaterThan(12.2) // totals recalc
  })

  it('GET /api/orders?status=hold vrne zadržano; privzeti GET je NE vrne', async () => {
    const o = await seedOrder('list')
    await seedItem(o.id, 'l1')
    expect((await holdPOST(req('POST', `/api/orders/${o.id}/hold`, tok, {}), params(o.id))).status).toBe(200)

    const heldRes = await ordersGET(req('GET', '/api/orders?status=hold', tok))
    expect(heldRes.status).toBe(200)
    const heldJ = await body(heldRes)
    expect((heldJ.orders as { id: string }[]).some((x) => x.id === o.id)).toBe(true)
    expect((heldJ.orders as { status: string }[]).every((x) => x.status === 'HOLD')).toBe(true)

    const actRes = await ordersGET(req('GET', '/api/orders', tok))
    const actJ = await body(actRes)
    expect((actJ.orders as { id: string }[]).some((x) => x.id === o.id)).toBe(false)
  })
})

/* ═══════════════════ Č3. REGISTRI ═══════════════════ */

describe('Č3 registri (map, UI statika, i18n, GAP, shema, verzija)', () => {
  it('map.ts: hold preslikava v OBEH smeri; aktivna bela lista ostaja brez hold', async () => {
    expect(orderStatusToUI('hold')).toBe('HOLD')
    expect(orderStatusToDB('HOLD')).toBe('hold')
    // KDS/kitchen bela lista NE sme vsebovati 'hold' (zadržano ni kuhinjski tok)
    const mapSrc = readFileSync('src/lib/map.ts', 'utf8')
    expect(mapSrc).toContain("export const ORDER_ACTIVE_DB = ['open', 'sent', 'prepared']")
  })

  it('dashboard statika: HOLD barva, oznaka, gumbi Nadaljuj/Zadrži, filter, dialog, fetch', () => {
    const src = readFileSync('src/app/dashboard/page.tsx', 'utf8')
    expect(src).toContain("HOLD: 'bg-stone-600 text-white'")
    expect(src).toContain("HOLD: 'Zadržano'")
    expect(src).toContain("orderFilter === f ? 'default' : 'outline'")
    expect(src).toContain("useState<'ALL' | 'OPEN' | 'SENT' | 'PREPARED' | 'HOLD'>('ALL')")
    expect(src).toContain("'/api/orders?status=hold'")
    expect(src).toContain('t(\'order.resumeBtn\')')
    expect(src).toContain('t(\'order.holdBtn\')')
    expect(src).toContain('holdOrderConfirm')
    expect(src).toContain('resumeOrder')
    expect(src).toContain('aria-describedby={undefined}')
    // Uredi/Plačaj skrita za zadržano
    expect(src).toContain("o.status !== 'PAID' && o.status !== 'HOLD'")
  })

  it('i18n: novih 10 ključev v OBEH slovarjih, popolna pariteta', () => {
    const keys = [
      'order.holdBtn', 'order.holdTitle', 'order.holdHint', 'order.holdReason', 'order.holdReasonPh',
      'order.holdConfirm', 'order.holdDone', 'order.resumeBtn', 'order.resumeDone', 'status.HOLD',
    ]
    for (const k of keys) {
      expect(typeof (sl as Record<string, string>)[k]).toBe('string')
      expect(typeof (hr as Record<string, string>)[k]).toBe('string')
    }
    expect(Object.keys(sl).length).toBe(Object.keys(hr).length)
    // v1.205.0: +2 ključa (crm.guests.whatsapp, crm.new.testPlaceholderPhone) — 3691 → 3693
    expect(Object.keys(sl).length).toBe(3693)
  })

  it('GAP-ANALIZA: OSS-4 označen kot IZVEDENO', () => {
    const doc = readFileSync('docs/GAP-ANALIZA-odprtokodna-konkurenca.md', 'utf8')
    expect(doc).toContain('IZVEDENO @ v1.204.0')
    // v1.205.0: §3 sklep razširjen z OSS-7 — OSS-4 ostaja v izpeljani listi IZVEDENIH
    expect(doc).toContain('OSS-4 hold naročila\n   (v1.204.0)')
    expect(doc).toContain('OSS-7 kampanje — A-del vključno z WhatsApp kanalom (v1.205.0')
  })

  it('shema NESPREMENJENA: Order.status ostaja String (0 DDL)', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8')
    expect(schema).toMatch(/model Order \{[\s\S]*?status\s+String\s+@default\("pending"\)/)
    // status 'hold' živi izključno v čistem sloju + rutah, NIKOLI kot enum v shemi
    expect(schema).not.toContain("'hold'")
  })

  it('route-hold statika: CAS + revizija + dogodki', () => {
    const hold = readFileSync('src/app/api/orders/[id]/hold/route.ts', 'utf8')
    expect(hold).toContain('claimMutableOrder')
    expect(hold).toContain("'ORDER_HOLD'")
    expect(hold).toContain('sanitizeHoldReason')
    expect(hold).toContain('publishEvent')
    const resume = readFileSync('src/app/api/orders/[id]/resume/route.ts', 'utf8')
    expect(resume).toContain("status: 'hold', paymentStatus: 'unpaid'")
    expect(resume).toContain("'ORDER_RESUMED'")
    // fire: CAS prevzem firedAt + hold gard
    const fire = readFileSync('src/app/api/orders/[id]/fire/route.ts', 'utf8')
    expect(fire).toContain("order.status === 'hold'")
    expect(fire).toContain('HoldRaceError')
    expect(fire).toContain('ORDER_MUTABLE_STATUS')
    const courses = readFileSync('src/app/api/orders/[id]/courses/route.ts', 'utf8')
    expect(courses).toContain("order.status === 'hold'")
  })

  it('verzija 1.208.0', () => {
    expect(APP_VERSION).toBe('1.208.0')
  })
})
